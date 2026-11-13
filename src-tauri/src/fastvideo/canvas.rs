//! Replays the lyric drawer's canvas calls (recorded in the page by
//! `canvasRecorder.ts`) into pixels, many frames at once on all cores.
//!
//! Only what `lyricDraw.ts` uses on a transparent frame: paths (lines,
//! curves, arcs, rectangles, rounded ones) filled or stroked, text filled or
//! stroked, solid colours and linear/radial gradients, global alpha, shadows
//! (blurred), save/restore, translate/scale and rectangular clips. Every
//! shape becomes a coverage mask (tiny-skia rasterises it) blended with its
//! paint; text masks and shadow blurs are cached, since the same words are
//! drawn frame after frame.

use super::text::{Fonts, Shaped};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// Time spent (ns) in coverage, blur and blending, for FAST_DEBUG.
pub static PROF: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
fn prof(k: usize, t: std::time::Instant) {
    PROF[k].fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
}
use std::sync::Arc;
use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

// Opcodes, as written by canvasRecorder.ts.
pub mod op {
    pub const FRAME: u8 = 0;
    pub const SAVE: u8 = 1;
    pub const RESTORE: u8 = 2;
    pub const TRANSLATE: u8 = 3;
    pub const SCALE: u8 = 4;
    pub const TRANSFORM: u8 = 5;
    pub const FILL_COLOR: u8 = 6;
    pub const STROKE_COLOR: u8 = 7;
    pub const FILL_LINEAR: u8 = 8;
    pub const STROKE_LINEAR: u8 = 9;
    pub const FILL_RADIAL: u8 = 10;
    pub const STROKE_RADIAL: u8 = 11;
    pub const LINE_WIDTH: u8 = 12;
    pub const LINE_JOIN: u8 = 13;
    pub const LINE_CAP: u8 = 14;
    pub const ALPHA: u8 = 15;
    pub const SHADOW_COLOR: u8 = 16;
    pub const SHADOW_BLUR: u8 = 17;
    pub const FONT: u8 = 18;
    pub const TEXT_ALIGN: u8 = 19;
    pub const TEXT_BASELINE: u8 = 20;
    pub const BEGIN_PATH: u8 = 21;
    pub const MOVE_TO: u8 = 22;
    pub const LINE_TO: u8 = 23;
    pub const BEZIER_TO: u8 = 24;
    pub const QUAD_TO: u8 = 25;
    pub const ARC: u8 = 26;
    pub const RECT: u8 = 27;
    pub const ROUND_RECT: u8 = 28;
    pub const CLOSE_PATH: u8 = 29;
    pub const FILL: u8 = 30;
    pub const STROKE: u8 = 31;
    pub const CLIP: u8 = 32;
    pub const FILL_RECT: u8 = 33;
    pub const STROKE_RECT: u8 = 34;
    pub const CLEAR_RECT: u8 = 35;
    pub const FILL_TEXT: u8 = 36;
    pub const STROKE_TEXT: u8 = 37;
    pub const SHADOW_OFFSET: u8 = 38;
}

/// A recorded chunk: its strings, and each frame's commands.
pub struct Chunk {
    strings: Vec<String>,
    data: Vec<u8>,
    /// (frame index, byte range of its commands in `data`)
    pub frames: Vec<(u32, std::ops::Range<usize>)>,
}

/// Bytes each opcode's arguments take (strings and counts are u32, the rest f32).
fn arg_len(op: u8, data: &[u8], at: usize) -> Result<usize, String> {
    use op::*;
    let f = |n: usize| 4 * n;
    Ok(match op {
        FRAME => 4,
        SAVE | RESTORE | BEGIN_PATH | CLOSE_PATH | FILL | STROKE | CLIP => 0,
        TRANSLATE | SCALE | MOVE_TO | LINE_TO | SHADOW_OFFSET => f(2),
        TRANSFORM => f(6),
        FILL_COLOR | STROKE_COLOR | SHADOW_COLOR => f(4),
        FILL_LINEAR | STROKE_LINEAR | FILL_RADIAL | STROKE_RADIAL => {
            let head = if matches!(op, FILL_LINEAR | STROKE_LINEAR) { 4 } else { 6 };
            let n = u32_at(data, at + f(head))? as usize;
            f(head) + 4 + n * f(5)
        }
        LINE_WIDTH | ALPHA | SHADOW_BLUR => f(1),
        LINE_JOIN | LINE_CAP | TEXT_ALIGN | TEXT_BASELINE => 1,
        FONT => f(2),
        BEZIER_TO | ARC => f(6),
        QUAD_TO | RECT | FILL_RECT | STROKE_RECT | CLEAR_RECT => f(4),
        ROUND_RECT => f(5),
        FILL_TEXT | STROKE_TEXT => 4 + f(2),
        _ => return Err(format!("Lệnh vẽ lạ: {op}")),
    })
}

fn u32_at(d: &[u8], at: usize) -> Result<u32, String> {
    d.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or_else(|| "Lệnh vẽ bị cụt".to_string())
}

fn f32_at(d: &[u8], at: usize) -> f32 {
    f32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

impl Chunk {
    /// `bytes`: u32 count of strings, each u32 length + UTF-8; then commands.
    pub fn parse(bytes: Vec<u8>) -> Result<Chunk, String> {
        let n = u32_at(&bytes, 0)? as usize;
        let mut at = 4;
        let mut strings = Vec::with_capacity(n);
        for _ in 0..n {
            let len = u32_at(&bytes, at)? as usize;
            let s = bytes.get(at + 4..at + 4 + len).ok_or("Chuỗi lệnh vẽ bị cụt")?;
            strings.push(String::from_utf8_lossy(s).into_owned());
            at += 4 + len;
        }
        let data = bytes[at..].to_vec();
        let mut frames: Vec<(u32, std::ops::Range<usize>)> = Vec::new();
        let mut p = 0;
        while p < data.len() {
            let code = data[p];
            let len = arg_len(code, &data, p + 1)?;
            if p + 1 + len > data.len() {
                return Err("Lệnh vẽ bị cụt".into());
            }
            if code == op::FRAME {
                if let Some(last) = frames.last_mut() {
                    last.1.end = p;
                }
                frames.push((u32_at(&data, p + 1)?, p + 5..data.len()));
            }
            p += 1 + len;
        }
        Ok(Chunk { strings, data, frames })
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Rgba([f32; 4]);

#[derive(Clone)]
enum Style {
    Color(Rgba),
    /// x0 y0 x1 y1, stops (offset, colour), in user space with the transform at use.
    Linear([f32; 4], Arc<Vec<(f32, Rgba)>>, Transform),
    /// x0 y0 r0 x1 y1 r1
    Radial([f32; 6], Arc<Vec<(f32, Rgba)>>, Transform),
}

#[derive(Clone)]
struct State {
    transform: Transform,
    fill: Style,
    stroke: Style,
    line_width: f32,
    join: LineJoin,
    cap: LineCap,
    alpha: f32,
    shadow: Rgba,
    blur: f32,
    shadow_offset: (f32, f32),
    font: (f32, f32),
    align: u8,
    baseline: u8,
    /// Device-space clip rectangle (x0, y0, x1, y1).
    clip: [f32; 4],
}

/// A coverage mask placed on the frame (device pixels).
#[derive(Clone)]
pub struct Mask {
    x: i32,
    y: i32,
    w: usize,
    h: usize,
    a: Arc<Vec<u8>>,
}

/// Paint evaluated per pixel, premultiplied 0–255 (with global alpha in).
enum Ink {
    Solid([f32; 4]),
    Gradient { inv: Transform, kind: GradKind, lut: Box<[[f32; 4]; 256]> },
}

enum GradKind {
    Linear { x0: f32, y0: f32, dx: f32, dy: f32, len2: f32 },
    Radial { cx: f32, cy: f32, r0: f32, r1: f32 },
}

impl Ink {
    fn new(style: &Style, alpha: f32) -> Ink {
        let premul = |c: Rgba| {
            let a = c.0[3] * alpha;
            [c.0[0] * a * 255.0, c.0[1] * a * 255.0, c.0[2] * a * 255.0, a * 255.0]
        };
        let lut = |stops: &[(f32, Rgba)]| {
            let mut t = Box::new([[0f32; 4]; 256]);
            for (i, out) in t.iter_mut().enumerate() {
                let u = i as f32 / 255.0;
                let c = match stops.iter().position(|s| s.0 >= u) {
                    None => stops.last().map(|s| s.1).unwrap_or(Rgba([0.0; 4])),
                    Some(0) => stops[0].1,
                    Some(k) => {
                        let (a, b) = (stops[k - 1], stops[k]);
                        let f = if b.0 > a.0 { (u - a.0) / (b.0 - a.0) } else { 1.0 };
                        Rgba(std::array::from_fn(|j| a.1 .0[j] + (b.1 .0[j] - a.1 .0[j]) * f))
                    }
                };
                *out = premul(c);
            }
            t
        };
        match style {
            Style::Color(c) => Ink::Solid(premul(*c)),
            Style::Linear(g, stops, tr) => {
                let (dx, dy) = (g[2] - g[0], g[3] - g[1]);
                Ink::Gradient {
                    inv: tr.invert().unwrap_or_default(),
                    kind: GradKind::Linear { x0: g[0], y0: g[1], dx, dy, len2: (dx * dx + dy * dy).max(1e-6) },
                    lut: lut(stops),
                }
            }
            // Only concentric radial gradients are drawn (all the drawer uses).
            Style::Radial(g, stops, tr) => Ink::Gradient {
                inv: tr.invert().unwrap_or_default(),
                kind: GradKind::Radial { cx: g[3], cy: g[4], r0: g[2], r1: g[5].max(1e-3) },
                lut: lut(stops),
            },
        }
    }

    #[inline]
    fn at(&self, x: f32, y: f32) -> [f32; 4] {
        match self {
            Ink::Solid(c) => *c,
            Ink::Gradient { inv, kind, lut } => {
                let (ux, uy) = (inv.sx * x + inv.kx * y + inv.tx, inv.ky * x + inv.sy * y + inv.ty);
                let t = match kind {
                    GradKind::Linear { x0, y0, dx, dy, len2 } => ((ux - x0) * dx + (uy - y0) * dy) / len2,
                    GradKind::Radial { cx, cy, r0, r1 } => {
                        let d = ((ux - cx).powi(2) + (uy - cy).powi(2)).sqrt();
                        (d - r0) / (r1 - r0)
                    }
                };
                lut[(t.clamp(0.0, 1.0) * 255.0 + 0.5) as usize]
            }
        }
    }

}

/// One draw of a frame: a mask and its paint (and shadow), within a clip
/// (device pixels, the band's rows). `sig` tells it from a different draw.
struct Item {
    mask: Arc<Mask>,
    ink: Ink,
    shadow: Option<(Arc<Mask>, Ink)>,
    clip: [i32; 4],
    sig: u64,
}

impl Item {
    /// The pixels it can touch.
    fn bbox(&self) -> [i32; 4] {
        let m = &self.mask;
        let mut r = [m.x, m.y, m.x + m.w as i32, m.y + m.h as i32];
        if let Some((s, _)) = &self.shadow {
            r = [r[0].min(s.x), r[1].min(s.y), r[2].max(s.x + s.w as i32), r[3].max(s.y + s.h as i32)];
        }
        [r[0].max(self.clip[0]), r[1].max(self.clip[1]), r[2].min(self.clip[2]), r[3].min(self.clip[3])]
    }
}

fn mask_bytes(m: &Mask) -> Vec<u8> {
    [Arc::as_ptr(&m.a) as usize as u64, m.x as u64, m.y as u64, m.w as u64, m.h as u64].iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn style_bytes(s: &Style, alpha: f32) -> Vec<u8> {
    let mut v: Vec<f32> = vec![alpha];
    let tr = |t: &Transform| [t.sx, t.kx, t.ky, t.sy, t.tx, t.ty];
    match s {
        Style::Color(c) => v.extend(c.0),
        Style::Linear(g, stops, t) => {
            v.push(1.0);
            v.extend(g);
            v.extend(tr(t));
            stops.iter().for_each(|(o, c)| {
                v.push(*o);
                v.extend(c.0)
            });
        }
        Style::Radial(g, stops, t) => {
            v.push(2.0);
            v.extend(g);
            v.extend(tr(t));
            stops.iter().for_each(|(o, c)| {
                v.push(*o);
                v.extend(c.0)
            });
        }
    }
    v.iter().flat_map(|f| f.to_bits().to_le_bytes()).collect()
}

const SEED: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a over `bytes`, continuing from `h`.
fn hash(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// What a shadow is the shadow of (to cache it).
enum Src {
    Text(u32, Arc<Shaped>, f32, f32, bool),
    Shape(u64),
}

/// Key of a cached text mask: text, weight, size, scale, stroke width
/// (0 = fill), join, subpixel position (quarters), blur (0 = none).
type TextKey = (u32, u32, u32, u32, u32, u8, u8, u8, u32);

/// One rendering thread's state and caches, drawing frames of `w`×`h`
/// device pixels whose top row is `y0` of the full frame.
pub struct Renderer {
    fonts: Arc<Fonts>,
    w: usize,
    h: usize,
    y0: i32,
    pub frame: Vec<u8>,
    /// What changed since the last frame (x0, y0, x1, y1), to composite again; None: nothing.
    pub changed: Option<[i32; 4]>,
    /// This frame's draws, and the last frame's.
    list: Vec<Item>,
    prev: Vec<Item>,
    shaped: HashMap<(u32, u32), Arc<Shaped>>,
    masks: HashMap<TextKey, Arc<Mask>>,
    /// Shapes and their blurred shadows, by a hash of the path and how it is drawn.
    shapes: HashMap<u64, Arc<Mask>>,
    strings: HashMap<String, u32>,
}

impl Renderer {
    pub fn new(fonts: Arc<Fonts>, w: usize, h: usize, y0: i32) -> Renderer {
        Renderer {
            fonts,
            w,
            h,
            y0,
            frame: vec![0; w * h * 4],
            changed: None,
            list: Vec::new(),
            prev: Vec::new(),
            shaped: HashMap::new(),
            masks: HashMap::new(),
            shapes: HashMap::new(),
            strings: HashMap::new(),
        }
    }

    /// Draw rows `y0..y0 + h` of the frame from now on (shapes cached for
    /// the old rows are dropped; text keeps its cache).
    pub fn set_band(&mut self, h: usize, y0: i32) {
        self.h = h;
        self.y0 = y0;
        self.frame = vec![0; self.w * h * 4];
        self.changed = None;
        self.list.clear();
        self.prev.clear();
        self.shapes.clear();
    }

    fn string_id(&mut self, s: &str) -> u32 {
        let n = self.strings.len() as u32;
        *self.strings.entry(s.to_string()).or_insert(n)
    }

    /// Draw one frame's commands (the frame starts transparent). With
    /// `measure`, nothing is drawn: returns the device rows anything would
    /// cover (top, bottom), for choosing the band.
    pub fn run(&mut self, chunk: &Chunk, range: std::ops::Range<usize>, measure: bool) -> Result<Option<(f32, f32)>, String> {
        if !measure {
            self.list.clear();
        }
        let mut bounds: Option<(f32, f32)> = None;
        let full = [f32::MIN, f32::MIN, f32::MAX, f32::MAX];
        let mut st = State {
            transform: Transform::identity(),
            fill: Style::Color(Rgba([0.0, 0.0, 0.0, 1.0])),
            stroke: Style::Color(Rgba([0.0, 0.0, 0.0, 1.0])),
            line_width: 1.0,
            join: LineJoin::Miter,
            cap: LineCap::Butt,
            alpha: 1.0,
            shadow: Rgba([0.0; 4]),
            blur: 0.0,
            shadow_offset: (0.0, 0.0),
            font: (400.0, 10.0),
            align: 0,
            baseline: 0,
            clip: full,
        };
        let mut stack: Vec<State> = Vec::new();
        let mut path = PathBuilder::new();
        // A hash of the current path's commands (shapes repeat frame after frame).
        let mut ph: u64 = SEED;
        let d = &chunk.data;
        let mut p = range.start;
        let g = |k: usize, p: usize| f32_at(d, p + 1 + 4 * k);
        while p < range.end {
            let code = d[p];
            let len = arg_len(code, d, p + 1)?;
            use op::*;
            if matches!(code, MOVE_TO | LINE_TO | BEZIER_TO | QUAD_TO | ARC | RECT | ROUND_RECT | CLOSE_PATH) {
                ph = hash(ph, &d[p..p + 1 + len]);
            }
            match code {
                SAVE => stack.push(st.clone()),
                RESTORE => {
                    if let Some(s) = stack.pop() {
                        st = s;
                    }
                }
                TRANSLATE => st.transform = st.transform.pre_translate(g(0, p), g(1, p)),
                SCALE => st.transform = st.transform.pre_scale(g(0, p), g(1, p)),
                TRANSFORM => st.transform = Transform::from_row(g(0, p), g(1, p), g(2, p), g(3, p), g(4, p), g(5, p)),
                FILL_COLOR | STROKE_COLOR | SHADOW_COLOR => {
                    let c = Rgba([g(0, p), g(1, p), g(2, p), g(3, p)]);
                    match code {
                        FILL_COLOR => st.fill = Style::Color(c),
                        STROKE_COLOR => st.stroke = Style::Color(c),
                        _ => st.shadow = c,
                    }
                }
                FILL_LINEAR | STROKE_LINEAR | FILL_RADIAL | STROKE_RADIAL => {
                    let linear = matches!(code, FILL_LINEAR | STROKE_LINEAR);
                    let head = if linear { 4 } else { 6 };
                    let n = u32_at(d, p + 1 + 4 * head)? as usize;
                    let base = p + 1 + 4 * head + 4;
                    let mut stops: Vec<(f32, Rgba)> = (0..n)
                        .map(|k| {
                            let q = base + 20 * k;
                            (f32_at(d, q), Rgba([f32_at(d, q + 4), f32_at(d, q + 8), f32_at(d, q + 12), f32_at(d, q + 16)]))
                        })
                        .collect();
                    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
                    let stops = Arc::new(stops);
                    let style = if linear {
                        Style::Linear([g(0, p), g(1, p), g(2, p), g(3, p)], stops, st.transform)
                    } else {
                        Style::Radial([g(0, p), g(1, p), g(2, p), g(3, p), g(4, p), g(5, p)], stops, st.transform)
                    };
                    if matches!(code, FILL_LINEAR | FILL_RADIAL) {
                        st.fill = style;
                    } else {
                        st.stroke = style;
                    }
                }
                LINE_WIDTH => st.line_width = g(0, p),
                LINE_JOIN => st.join = [LineJoin::Miter, LineJoin::Round, LineJoin::Bevel][(d[p + 1] as usize).min(2)],
                LINE_CAP => st.cap = [LineCap::Butt, LineCap::Round, LineCap::Square][(d[p + 1] as usize).min(2)],
                ALPHA => st.alpha = g(0, p).clamp(0.0, 1.0),
                SHADOW_BLUR => st.blur = g(0, p).max(0.0),
                SHADOW_OFFSET => st.shadow_offset = (g(0, p), g(1, p)),
                FONT => st.font = (g(0, p), g(1, p)),
                TEXT_ALIGN => st.align = d[p + 1],
                TEXT_BASELINE => st.baseline = d[p + 1],
                BEGIN_PATH => {
                    path = PathBuilder::new();
                    ph = SEED;
                }
                MOVE_TO => path.move_to(g(0, p), g(1, p)),
                LINE_TO => {
                    if path.is_empty() {
                        path.move_to(g(0, p), g(1, p));
                    } else {
                        path.line_to(g(0, p), g(1, p));
                    }
                }
                BEZIER_TO => path.cubic_to(g(0, p), g(1, p), g(2, p), g(3, p), g(4, p), g(5, p)),
                QUAD_TO => path.quad_to(g(0, p), g(1, p), g(2, p), g(3, p)),
                ARC => arc(&mut path, g(0, p), g(1, p), g(2, p), g(3, p), g(4, p), g(5, p) != 0.0),
                RECT => {
                    let (x, y, w, h) = (g(0, p), g(1, p), g(2, p), g(3, p));
                    path.move_to(x, y);
                    path.line_to(x + w, y);
                    path.line_to(x + w, y + h);
                    path.line_to(x, y + h);
                    path.close();
                }
                ROUND_RECT => round_rect(&mut path, g(0, p), g(1, p), g(2, p), g(3, p), g(4, p)),
                CLOSE_PATH => path.close(),
                CLIP => {
                    // Rectangles only (all the drawer clips to), in device space.
                    if let Some(b) = path.clone().finish().and_then(|pa| pa.transform(st.transform)).map(|pa| pa.bounds()) {
                        let c = &mut st.clip;
                        *c = [c[0].max(b.left()), c[1].max(b.top()), c[2].min(b.right()), c[3].min(b.bottom())];
                    }
                }
                FILL | STROKE | FILL_RECT | STROKE_RECT => {
                    let stroked = matches!(code, STROKE | STROKE_RECT);
                    let shape = if matches!(code, FILL_RECT | STROKE_RECT) { hash(SEED, &d[p..p + 1 + len]) } else { ph };
                    let stroke = stroked.then(|| self.stroke_of(&st));
                    let t = st.transform;
                    let mut key = hash(shape, &[t.sx, t.kx, t.ky, t.sy, t.tx, t.ty].map(f32::to_bits).iter().flat_map(|b| b.to_le_bytes()).collect::<Vec<u8>>());
                    if let Some(s) = &stroke {
                        key = hash(key, &[s.width.to_bits(), s.line_join as u32, s.line_cap as u32 + 7].iter().flat_map(|b| b.to_le_bytes()).collect::<Vec<u8>>());
                    }
                    let mask = match self.shapes.get(&key) {
                        Some(m) => Some(m.clone()),
                        None => {
                            let pa = if matches!(code, FILL_RECT | STROKE_RECT) {
                                tiny_skia::Rect::from_xywh(g(0, p), g(1, p), g(2, p), g(3, p)).map(PathBuilder::from_rect)
                            } else {
                                path.clone().finish()
                            };
                            let m = pa.and_then(|pa| coverage(&pa, t, stroke.as_ref(), self.y0)).map(Arc::new);
                            if let Some(m) = &m {
                                self.remember(key, m.clone());
                            }
                            m
                        }
                    };
                    let style = if stroked { st.stroke.clone() } else { st.fill.clone() };
                    self.paint(mask, &style, &st, measure, &mut bounds, Src::Shape(key));
                }
                CLEAR_RECT => {}
                FILL_TEXT | STROKE_TEXT => {
                    let sid = u32_at(d, p + 1)? as usize;
                    let text = chunk.strings.get(sid).ok_or("Thiếu chuỗi chữ")?;
                    let (x, y) = (f32_at(d, p + 5), f32_at(d, p + 9));
                    let stroke = code == STROKE_TEXT;
                    let style = if stroke { st.stroke.clone() } else { st.fill.clone() };
                    let tid = self.string_id(text);
                    let shaped = self.shape(tid, text, st.font.0);
                    let mask = self.text_mask(tid, &shaped, &st, x, y, stroke, 0.0);
                    self.paint(mask, &style, &st, measure, &mut bounds, Src::Text(tid, shaped.clone(), x, y, stroke));
                }
                _ => {}
            }
            p += 1 + len;
        }
        if !measure {
            self.flush();
        }
        Ok(bounds)
    }

    /// Redraw what changed since the last frame: the rectangle covering the
    /// draws that differ (for a draw whose clip alone moved, only the strip
    /// between its old and new edges), cleared and drawn again with every
    /// draw that reaches into it. Consecutive frames differ by a sliver
    /// (the wipe's edge, a lit dot), so this is most of the speed.
    fn flush(&mut self) {
        let mut rect: Option<[i32; 4]> = None;
        let mut add = |r: [i32; 4]| {
            if r[2] > r[0] && r[3] > r[1] {
                rect = Some(match rect {
                    Some(a) => [a[0].min(r[0]), a[1].min(r[1]), a[2].max(r[2]), a[3].max(r[3])],
                    None => r,
                });
            }
        };
        if cfg!(test) && std::env::var_os("FAST_FULL").is_some() {
            add([0, 0, self.w as i32, self.h as i32]);
        }
        if self.prev.len() != self.list.len() {
            self.prev.iter().chain(&self.list).for_each(|it| add(it.bbox()));
        } else {
            for (a, b) in self.prev.iter().zip(&self.list) {
                if a.sig != b.sig {
                    add(a.bbox());
                    add(b.bbox());
                } else if a.clip != b.clip {
                    // Same draw, clip moved: only between the edges that moved.
                    let (ba, bb) = (a.bbox(), b.bbox());
                    let u = [ba[0].min(bb[0]), ba[1].min(bb[1]), ba[2].max(bb[2]), ba[3].max(bb[3])];
                    for k in 0..4 {
                        if a.clip[k] != b.clip[k] {
                            let (lo, hi) = (a.clip[k].min(b.clip[k]) - 1, a.clip[k].max(b.clip[k]) + 1);
                            let r = if k % 2 == 0 { [lo.max(u[0]), u[1], hi.min(u[2]), u[3]] } else { [u[0], lo.max(u[1]), u[2], hi.min(u[3])] };
                            add(r);
                        }
                    }
                }
            }
        }
        std::mem::swap(&mut self.prev, &mut self.list);
        let Some(r) = rect else {
            self.changed = None;
            return;
        };
        // Whole 2×2 blocks (chroma), within the frame.
        let r = [(r[0].max(0)) & !1, (r[1].max(0)) & !1, (r[2].min(self.w as i32) + 1) & !1, (r[3].min(self.h as i32) + 1) & !1];
        let r = [r[0], r[1], r[2].min(self.w as i32), r[3].min(self.h as i32)];
        if r[2] <= r[0] || r[3] <= r[1] {
            self.changed = None;
            return;
        }
        let w = self.w;
        for y in r[1]..r[3] {
            self.frame[(y as usize * w + r[0] as usize) * 4..(y as usize * w + r[2] as usize) * 4].fill(0);
        }
        let items = std::mem::take(&mut self.prev);
        for it in &items {
            let c = [it.clip[0].max(r[0]), it.clip[1].max(r[1]), it.clip[2].min(r[2]), it.clip[3].min(r[3])];
            if let Some((sh, ink)) = &it.shadow {
                self.blend(sh, ink, c);
            }
            self.blend(&it.mask, &it.ink, c);
        }
        self.prev = items;
        self.changed = Some(r);
    }

    fn remember(&mut self, key: u64, m: Arc<Mask>) {
        if self.shapes.len() > 3000 {
            self.shapes.clear();
        }
        self.shapes.insert(key, m);
    }

    fn stroke_of(&self, st: &State) -> Stroke {
        Stroke { width: st.line_width.max(0.01), line_cap: st.cap, line_join: st.join, ..Default::default() }
    }

    fn shape(&mut self, tid: u32, text: &str, weight: f32) -> Arc<Shaped> {
        let key = (tid, weight.to_bits());
        if let Some(s) = self.shaped.get(&key) {
            return s.clone();
        }
        let s = Arc::new(self.fonts.shape(text, weight));
        self.shaped.insert(key, s.clone());
        s
    }

    /// The device-space mask of a text, cached (by text, font, scale, stroke,
    /// subpixel position and blur), placed for this draw.
    fn text_mask(&mut self, tid: u32, shaped: &Shaped, st: &State, x: f32, y: f32, stroke: bool, blur: f32) -> Option<Arc<Mask>> {
        let size = st.font.1;
        let scale = shaped.scale(size);
        let width = shaped.advance * scale;
        let x = match st.align {
            1 => x - width / 2.0,
            2 => x - width,
            _ => x,
        };
        let y = match st.baseline {
            1 => y + (shaped.ascent + shaped.descent) / 2.0 * scale,
            2 | 4 => y + shaped.ascent * scale,
            3 | 5 => y + shaped.descent * scale,
            _ => y,
        };
        let t = st.transform;
        // Translation and scale only (as drawn); the origin in device pixels.
        let (dx, dy) = (t.sx * x + t.kx * y + t.tx, t.ky * x + t.sy * y + t.ty - self.y0 as f32);
        let (ix, iy) = (dx.floor(), dy.floor());
        let (qx, qy) = (((dx - ix) * 4.0) as u8 & 3, ((dy - iy) * 4.0) as u8 & 3);
        let key: TextKey = (
            tid,
            st.font.0.to_bits(),
            (size * t.sx).to_bits(),
            (t.sy / t.sx.max(1e-6)).to_bits(),
            if stroke { (st.line_width * t.sx).to_bits() } else { 0 },
            st.join as u8,
            qx,
            qy,
            blur.to_bits(),
        );
        let m = match self.masks.get(&key) {
            Some(m) => m.clone(),
            None => {
                // Font units (y down) to device pixels, at the subpixel offset.
                let local = Transform::from_row(scale * t.sx, 0.0, 0.0, scale * t.sy, qx as f32 / 4.0, qy as f32 / 4.0);
                let path = self.fonts.path(shaped, local);
                let stroke = stroke.then(|| Stroke { width: (st.line_width * t.sx).max(0.01), line_join: st.join, line_cap: st.cap, ..Default::default() });
                let mut m = match path.and_then(|pa| coverage(&pa, Transform::identity(), stroke.as_ref(), 0)) {
                    Some(m) => m,
                    None => return None,
                };
                if blur > 0.0 {
                    m = blurred(&m, blur);
                }
                if self.masks.len() > 4000 {
                    self.masks.clear();
                }
                let m = Arc::new(m);
                self.masks.insert(key, m.clone());
                m
            }
        };
        Some(Arc::new(Mask { x: m.x + ix as i32, y: m.y + iy as i32, w: m.w, h: m.h, a: m.a.clone() }))
    }

    /// Blend `mask` with `style` (and its shadow first, if any).
    fn paint(
        &mut self,
        mask: Option<Arc<Mask>>,
        style: &Style,
        st: &State,
        measure: bool,
        bounds: &mut Option<(f32, f32)>,
        src: Src,
    ) {
        let Some(mask) = mask else { return };
        let shadow_on = st.shadow.0[3] > 0.0 && (st.blur > 0.0 || st.shadow_offset != (0.0, 0.0));
        // Canvas shadows: blur sigma is half the shadowBlur (scaled with the drawing? no: device px).
        let shadow = shadow_on.then(|| {
            let sigma = st.blur / 2.0;
            let mut sh = match &src {
                Src::Text(tid, shaped, x, y, stroke) if sigma > 0.0 => {
                    let st2 = st.clone();
                    self.text_mask(*tid, shaped, &st2, *x, *y, *stroke, sigma).map(|m| (*m).clone())
                }
                Src::Shape(key) if sigma > 0.0 => {
                    let k = hash(*key, &sigma.to_bits().to_le_bytes());
                    Some(match self.shapes.get(&k) {
                        Some(m) => (**m).clone(),
                        None => {
                            let m = blurred(&mask, sigma);
                            self.remember(k, Arc::new(m.clone()));
                            m
                        }
                    })
                }
                _ if sigma > 0.0 => Some(blurred(&mask, sigma)),
                _ => Some((*mask).clone()),
            }?;
            sh.x += st.shadow_offset.0.round() as i32;
            sh.y += st.shadow_offset.1.round() as i32;
            Some(sh)
        });
        let clip = [st.clip[0], st.clip[1] - self.y0 as f32, st.clip[2], st.clip[3] - self.y0 as f32];
        let mut note = |m: &Mask| {
            let top = (m.y as f32).max(clip[1]);
            let bottom = ((m.y + m.h as i32) as f32).min(clip[3]);
            if bottom > top {
                let (t, b) = (top + self.y0 as f32, bottom + self.y0 as f32);
                *bounds = Some(match *bounds {
                    Some((a, z)) => (a.min(t), z.max(b)),
                    None => (t, b),
                });
            }
        };
        if let Some(Some(sh)) = &shadow {
            note(sh);
        }
        note(&mask);
        if measure {
            return;
        }
        let ink = Ink::new(style, st.alpha);
        let mut sig = hash(SEED, &style_bytes(style, st.alpha));
        sig = hash(sig, &mask_bytes(&mask));
        let shadow = match shadow {
            Some(Some(sh)) => {
                // The shadow takes the shape's opacity: the paint's alpha at its centre.
                let a = ink.at(sh.x as f32 + sh.w as f32 / 2.0, (sh.y + self.y0) as f32 + sh.h as f32 / 2.0)[3] / 255.0;
                let c = st.shadow.0;
                let sa = c[3] * a;
                sig = hash(sig, &mask_bytes(&sh));
                sig = hash(sig, &[c[0], c[1], c[2], sa].map(f32::to_bits).iter().flat_map(|b| b.to_le_bytes()).collect::<Vec<u8>>());
                Some((Arc::new(sh), Ink::Solid([c[0] * sa * 255.0, c[1] * sa * 255.0, c[2] * sa * 255.0, sa * 255.0])))
            }
            _ => None,
        };
        let big = i32::MAX / 4;
        let clip = [
            clip[0].max(-big as f32).ceil() as i32,
            clip[1].max(-big as f32).ceil() as i32,
            clip[2].min(big as f32).floor() as i32,
            clip[3].min(big as f32).floor() as i32,
        ];
        self.list.push(Item { mask, ink, shadow, clip, sig });
    }

    /// Source-over `ink` through `m` into the frame, within `clip` (frame rows).
    fn blend(&mut self, m: &Mask, ink: &Ink, clip: [i32; 4]) {
        let clock = std::time::Instant::now();
        self.blend_(m, ink, clip);
        prof(2, clock);
    }

    fn blend_(&mut self, m: &Mask, ink: &Ink, clip: [i32; 4]) {
        let x0 = m.x.max(0).max(clip[0]);
        let x1 = (m.x + m.w as i32).min(self.w as i32).min(clip[2]);
        let y0 = m.y.max(0).max(clip[1]);
        let y1 = (m.y + m.h as i32).min(self.h as i32).min(clip[3]);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let gy = self.y0 as f32;
        let w = self.w;
        // Source-over in integers: out = src·cov + dst·(1 − srcα·cov).
        #[inline(always)]
        fn over(px: &mut [u8], c: [u32; 4], cov: u32) {
            let sa = c[3] * cov; // 0..255²
            let inv = 65025 - sa;
            for j in 0..4 {
                let v = c[j] * cov + px[j] as u32 * inv / 255;
                px[j] = ((v + 127) / 255).min(255) as u8;
            }
        }
        match ink {
            Ink::Solid(c) => {
                let c = c.map(|v| (v + 0.5) as u32);
                if c[3] == 0 {
                    return;
                }
                for y in y0..y1 {
                    let mrow = &m.a[(y - m.y) as usize * m.w..];
                    let row = &mut self.frame[y as usize * w * 4..(y as usize + 1) * w * 4];
                    for x in x0..x1 {
                        let cov = mrow[(x - m.x) as usize] as u32;
                        if cov != 0 {
                            over(&mut row[x as usize * 4..x as usize * 4 + 4], c, cov);
                        }
                    }
                }
            }
            Ink::Gradient { inv, kind, lut } => {
                let lut: Vec<[u32; 4]> = lut.iter().map(|c| c.map(|v| (v + 0.5) as u32)).collect();
                for y in y0..y1 {
                    let mrow = &m.a[(y - m.y) as usize * m.w..];
                    let row = &mut self.frame[y as usize * w * 4..(y as usize + 1) * w * 4];
                    let py = y as f32 + 0.5 + gy;
                    // The gradient's parameter along the row: linear in x for a linear gradient.
                    let (ux0, uy0) = (inv.sx * (x0 as f32 + 0.5) + inv.kx * py + inv.tx, inv.ky * (x0 as f32 + 0.5) + inv.sy * py + inv.ty);
                    let (dux, duy) = (inv.sx, inv.ky);
                    for (n, x) in (x0..x1).enumerate() {
                        let cov = mrow[(x - m.x) as usize] as u32;
                        if cov == 0 {
                            continue;
                        }
                        let (ux, uy) = (ux0 + dux * n as f32, uy0 + duy * n as f32);
                        let t = match kind {
                            GradKind::Linear { x0, y0, dx, dy, len2 } => ((ux - x0) * dx + (uy - y0) * dy) / len2,
                            GradKind::Radial { cx, cy, r0, r1 } => (((ux - cx).powi(2) + (uy - cy).powi(2)).sqrt() - r0) / (r1 - r0),
                        };
                        let c = lut[(t.clamp(0.0, 1.0) * 255.0 + 0.5) as usize];
                        if c[3] != 0 {
                            over(&mut row[x as usize * 4..x as usize * 4 + 4], c, cov);
                        }
                    }
                }
            }
        }
    }
}

/// The coverage of `path` (filled, or stroked with `stroke`) under `t`, as a
/// mask in device pixels with rows counted from `y0`.
fn coverage(path: &tiny_skia::Path, t: Transform, stroke: Option<&Stroke>, y0: i32) -> Option<Mask> {
    let clock = std::time::Instant::now();
    let r = coverage_(path, t, stroke, y0);
    prof(0, clock);
    r
}

fn coverage_(path: &tiny_skia::Path, t: Transform, stroke: Option<&Stroke>, y0: i32) -> Option<Mask> {
    let pad = stroke.map(|s| s.width * t.sx.abs().max(t.sy.abs()) + 2.0).unwrap_or(2.0);
    let b = path.clone().transform(t)?.bounds();
    let (x, y) = ((b.left() - pad).floor() as i32, (b.top() - pad).floor() as i32);
    let w = ((b.right() + pad).ceil() as i32 - x).max(1) as usize;
    let h = ((b.bottom() + pad).ceil() as i32 - y).max(1) as usize;
    if w > 8192 || h > 8192 {
        return None;
    }
    let mut pm = Pixmap::new(w as u32, h as u32)?;
    let mut paint = Paint::default();
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;
    let local = t.post_translate(-x as f32, -y as f32);
    match stroke {
        Some(s) => pm.stroke_path(path, &paint, s, local, None),
        None => pm.fill_path(path, &paint, FillRule::Winding, local, None),
    }
    let a: Vec<u8> = pm.data().chunks_exact(4).map(|p| p[3]).collect();
    Some(Mask { x, y: y - y0, w, h, a: Arc::new(a) })
}

/// `m` blurred like a canvas shadow (Gaussian of `sigma` px, as three box blurs).
fn blurred(m: &Mask, sigma: f32) -> Mask {
    let clock = std::time::Instant::now();
    let r = blurred_(m, sigma);
    prof(1, clock);
    r
}

fn blurred_(m: &Mask, sigma: f32) -> Mask {
    // Wide blurs at a lower resolution (a shadow has no detail), then scaled back.
    let f = ((sigma / 2.0).floor() as usize).clamp(1, 4);
    if f > 1 {
        let (sw, sh) = (m.w.div_ceil(f), m.h.div_ceil(f));
        let mut small = vec![0u8; sw * sh];
        for y in 0..sh {
            for x in 0..sw {
                let mut acc = 0u32;
                for yy in y * f..((y + 1) * f).min(m.h) {
                    for xx in x * f..((x + 1) * f).min(m.w) {
                        acc += m.a[yy * m.w + xx] as u32;
                    }
                }
                small[y * sw + x] = (acc / (f * f) as u32) as u8;
            }
        }
        let b = blur_full(&Mask { x: 0, y: 0, w: sw, h: sh, a: Arc::new(small) }, sigma / f as f32);
        // Back to full resolution (bilinear), placed over the original.
        let pad = (-b.x) as usize * f;
        let (w, h) = (m.w + 2 * pad, m.h + 2 * pad);
        let mut a = vec![0u8; w * h];
        for y in 0..h {
            let sy = ((y as f32 + 0.5) / f as f32 - 0.5).max(0.0);
            let (y0, fy) = (sy as usize, sy.fract());
            let y1 = (y0 + 1).min(b.h - 1);
            for x in 0..w {
                let sx = ((x as f32 + 0.5) / f as f32 - 0.5).max(0.0);
                let (x0, fx) = ((sx as usize).min(b.w - 1), sx.fract());
                let x1 = (x0 + 1).min(b.w - 1);
                let y0 = y0.min(b.h - 1);
                let v = |xx: usize, yy: usize| b.a[yy * b.w + xx] as f32;
                let top = v(x0, y0) * (1.0 - fx) + v(x1, y0) * fx;
                let bot = v(x0, y1) * (1.0 - fx) + v(x1, y1) * fx;
                a[y * w + x] = (top * (1.0 - fy) + bot * fy + 0.5) as u8;
            }
        }
        return Mask { x: m.x - pad as i32, y: m.y - pad as i32, w, h, a: Arc::new(a) };
    }
    blur_full(m, sigma)
}

fn blur_full(m: &Mask, sigma: f32) -> Mask {
    let pad = (3.0 * sigma).ceil() as usize;
    let (w, h) = (m.w + 2 * pad, m.h + 2 * pad);
    let mut a = vec![0f32; w * h];
    for y in 0..m.h {
        for x in 0..m.w {
            a[(y + pad) * w + x + pad] = m.a[y * m.w + x] as f32;
        }
    }
    // Box widths for three passes approximating the Gaussian.
    let ideal = (12.0 * sigma * sigma / 3.0 + 1.0).sqrt();
    let mut wl = ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wu = wl + 2;
    let mm = ((12.0 * sigma * sigma - 3.0 * (wl * wl) as f32 - 12.0 * wl as f32 - 9.0) / (-4.0 * wl as f32 - 4.0)).round() as i32;
    let mut tmp = vec![0f32; w * h];
    for pass in 0..3 {
        let r = (if pass < mm { wl } else { wu } - 1).max(0) as usize / 2;
        if r == 0 {
            continue;
        }
        box_blur(&a, &mut tmp, w, h, r, true);
        box_blur(&tmp, &mut a, w, h, r, false);
    }
    Mask { x: m.x - pad as i32, y: m.y - pad as i32, w, h, a: Arc::new(a.iter().map(|v| v.round().clamp(0.0, 255.0) as u8).collect()) }
}

fn box_blur(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize, horizontal: bool) {
    let (n, lines, step, stride) = if horizontal { (w, h, 1, w) } else { (h, w, w, 1) };
    let norm = 1.0 / (2 * r + 1) as f32;
    for l in 0..lines {
        let base = l * stride;
        let mut acc = 0.0;
        for i in 0..=r.min(n - 1) {
            acc += src[base + i * step];
        }
        for i in 0..n {
            dst[base + i * step] = acc * norm;
            if i + r + 1 < n {
                acc += src[base + (i + r + 1) * step];
            }
            if i >= r {
                acc -= src[base + (i - r) * step];
            }
        }
    }
}

/// A canvas `arc` as cubic Béziers (a line to its start if a path is open).
fn arc(p: &mut PathBuilder, cx: f32, cy: f32, r: f32, a0: f32, a1: f32, ccw: bool) {
    use std::f32::consts::TAU;
    let mut sweep = a1 - a0;
    if !ccw && sweep < 0.0 {
        sweep = sweep.rem_euclid(TAU);
        if sweep == 0.0 && a1 != a0 {
            sweep = TAU;
        }
    } else if ccw && sweep > 0.0 {
        sweep = -((-sweep).rem_euclid(TAU));
    }
    if !ccw && (a1 - a0) >= TAU {
        sweep = TAU;
    }
    if ccw && (a0 - a1) >= TAU {
        sweep = -TAU;
    }
    let start = (cx + r * a0.cos(), cy + r * a0.sin());
    if p.is_empty() {
        p.move_to(start.0, start.1);
    } else {
        p.line_to(start.0, start.1);
    }
    let n = (sweep.abs() / (std::f32::consts::FRAC_PI_2)).ceil().max(1.0) as usize;
    let step = sweep / n as f32;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let mut a = a0;
    for _ in 0..n {
        let b = a + step;
        let (ca, sa, cb, sb) = (a.cos(), a.sin(), b.cos(), b.sin());
        p.cubic_to(cx + r * (ca - k * sa), cy + r * (sa + k * ca), cx + r * (cb + k * sb), cy + r * (sb - k * cb), cx + r * cb, cy + r * sb);
        a = b;
    }
}

fn round_rect(p: &mut PathBuilder, x: f32, y: f32, w: f32, h: f32, r: f32) {
    use std::f32::consts::{FRAC_PI_2, PI};
    let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
    let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
    let r = r.max(0.0).min(w / 2.0).min(h / 2.0);
    p.move_to(x + r, y);
    arc(p, x + w - r, y + r, r, -FRAC_PI_2, 0.0, false);
    arc(p, x + w - r, y + h - r, r, 0.0, FRAC_PI_2, false);
    arc(p, x + r, y + h - r, r, FRAC_PI_2, PI, false);
    arc(p, x + r, y + r, r, PI, PI + FRAC_PI_2, false);
    p.close();
}

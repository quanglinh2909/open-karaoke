//! The lyrics' font for rendering exports here: Bricolage Grotesque (the
//! app's display font, OFL), as the page loads it, in three subsets
//! (Latin, Latin Extended, Vietnamese), each a variable font on the weight
//! axis. Text is split into runs by the font holding each character (as the
//! page's unicode-range faces do) and shaped with rustybuzz. Symbols the
//! font lacks (♪ ● ‿ …) come from the system's fallback font, as in the page
//! (fontconfig's sans-serif: DejaVu Sans on most Linux desktops).

use rustybuzz::ttf_parser::{GlyphId, OutlineBuilder, Tag};
use rustybuzz::{Face, UnicodeBuffer, Variation};
use std::sync::OnceLock;
use tiny_skia::{Path, PathBuilder, Transform};

static FACES: [&[u8]; 3] = [
    include_bytes!("../../fonts/bricolage-latin.ttf"),
    include_bytes!("../../fonts/bricolage-latin-ext.ttf"),
    include_bytes!("../../fonts/bricolage-vietnamese.ttf"),
];

/// The system's sans-serif font, regular and bold (loaded once).
fn fallback(bold: bool) -> Option<&'static [u8]> {
    static FONTS: OnceLock<[Option<&'static [u8]>; 2]> = OnceLock::new();
    let fonts = FONTS.get_or_init(|| {
        let load = |pattern: &str| -> Option<&'static [u8]> {
            let out = std::process::Command::new("fc-match").args(["-f", "%{file}", pattern]).output().ok()?;
            let path = String::from_utf8(out.stdout).ok()?;
            let data = std::fs::read(path.trim()).ok()?;
            Face::from_slice(&data, 0)?;
            Some(Box::leak(data.into_boxed_slice()))
        };
        [load("sans-serif"), load("sans-serif:bold")]
    });
    fonts[bold as usize].or(fonts[0])
}

pub struct Fonts;

/// A shaped text: glyphs as (font, glyph, x, y) in em (pen position, y down).
pub struct Shaped {
    glyphs: Vec<(u8, u16, f32, f32)>,
    weight: f32,
    pub advance: f32,
    pub ascent: f32,
    pub descent: f32,
}

impl Shaped {
    /// Em to pixels at `size` px.
    pub fn scale(&self, size: f32) -> f32 {
        size
    }
}

/// Font `i` (0–2 bundled, 3 the fallback) at `weight`.
fn face(i: usize, weight: f32) -> Option<Face<'static>> {
    if i == 3 {
        return Face::from_slice(fallback(weight >= 600.0)?, 0);
    }
    let mut f = Face::from_slice(FACES[i], 0)?;
    f.set_variations(&[Variation { tag: Tag::from_bytes(b"wght"), value: weight.clamp(200.0, 800.0) }]);
    Some(f)
}

impl Default for Fonts {
    fn default() -> Self {
        Self::new()
    }
}

impl Fonts {
    pub fn new() -> Fonts {
        Fonts
    }

    /// `text` at `weight`, shaped run by run in the font holding each character.
    pub fn shape(&self, text: &str, weight: f32) -> Shaped {
        let faces: Vec<Option<Face>> = (0..4).map(|i| face(i, weight)).collect();
        let has = |k: usize, c: char| faces[k].as_ref().and_then(|f| f.glyph_index(c)).is_some();
        let pick = |c: char| -> usize { (0..4).find(|&k| has(k, c)).unwrap_or(0) };
        let mut glyphs = Vec::new();
        let mut pen = 0.0f32;
        let chars: Vec<(usize, char)> = text.char_indices().collect();
        let mut i = 0;
        while i < chars.len() {
            let font = pick(chars[i].1);
            let mut j = i + 1;
            // Combining marks stay with their base when its font has them.
            while j < chars.len() {
                let c = chars[j].1;
                let mark = ('\u{300}'..='\u{36f}').contains(&c);
                if pick(c) == font || (mark && has(font, c)) {
                    j += 1;
                } else {
                    break;
                }
            }
            let (a, b) = (chars[i].0, chars.get(j).map(|c| c.0).unwrap_or(text.len()));
            if let Some(f) = faces[font].as_ref() {
                let em = 1.0 / f.units_per_em() as f32;
                let mut buf = UnicodeBuffer::new();
                buf.push_str(&text[a..b]);
                let out = rustybuzz::shape(f, &[], buf);
                for (info, pos) in out.glyph_infos().iter().zip(out.glyph_positions()) {
                    glyphs.push((font as u8, info.glyph_id as u16, pen + pos.x_offset as f32 * em, -(pos.y_offset as f32) * em));
                    pen += pos.x_advance as f32 * em;
                }
            }
            i = j;
        }
        // Canvas metrics (textBaseline) from the main font's hhea ascent and descent.
        let main = faces[0].as_ref();
        let em = main.map(|f| 1.0 / f.units_per_em() as f32).unwrap_or(0.001);
        Shaped {
            glyphs,
            weight,
            advance: pen,
            ascent: main.map(|f| f.ascender() as f32 * em).unwrap_or(0.9),
            descent: main.map(|f| f.descender() as f32 * em).unwrap_or(-0.25),
        }
    }

    /// The outlines of `s` (em, y down, from the pen origin) under `t`.
    pub fn path(&self, s: &Shaped, t: Transform) -> Option<Path> {
        let mut pb = PathBuilder::new();
        let faces: Vec<Option<Face>> = (0..4).map(|i| face(i, s.weight)).collect();
        for &(font, id, x, y) in &s.glyphs {
            if let Some(f) = faces[font as usize].as_ref() {
                let mut o = Outline { pb: &mut pb, x, y, k: 1.0 / f.units_per_em() as f32 };
                f.outline_glyph(GlyphId(id), &mut o);
            }
        }
        pb.finish()?.transform(t)
    }
}

/// Glyph outlines (font units, y up) into the path (em, y down) at the pen.
struct Outline<'a> {
    pb: &'a mut PathBuilder,
    x: f32,
    y: f32,
    k: f32,
}

impl Outline<'_> {
    fn p(&self, x: f32, y: f32) -> (f32, f32) {
        (self.x + x * self.k, self.y - y * self.k)
    }
}

impl OutlineBuilder for Outline<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.p(x, y);
        self.pb.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.p(x, y);
        self.pb.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let ((x1, y1), (x, y)) = (self.p(x1, y1), self.p(x, y));
        self.pb.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let ((x1, y1), (x2, y2), (x, y)) = (self.p(x1, y1), self.p(x2, y2), self.p(x, y));
        self.pb.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.pb.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_vietnamese_across_subsets() {
        let f = Fonts::new();
        let s = f.shape("Đây sẽ là lý do em", 700.0);
        assert!(s.glyphs.len() >= 18, "{} glyphs", s.glyphs.len());
        assert!(s.glyphs.iter().all(|g| g.1 != 0), "no missing glyphs");
        // Heavier is wider; about half an em a letter.
        assert!(f.shape("Hello", 800.0).advance > f.shape("Hello", 300.0).advance);
        assert!((1.5..4.0).contains(&f.shape("Hello", 700.0).advance));
        assert!(f.path(&s, Transform::from_scale(64.0, 64.0)).is_some());
    }

    #[test]
    fn symbols_come_from_the_fallback_font() {
        let s = Fonts::new().shape("♪♪♪ ● ‿", 700.0);
        if fallback(true).is_some() {
            assert!(s.glyphs.iter().all(|g| g.1 != 0), "a symbol is missing");
            assert!(s.glyphs.iter().any(|g| g.0 == 3), "fallback not used");
        }
    }
}

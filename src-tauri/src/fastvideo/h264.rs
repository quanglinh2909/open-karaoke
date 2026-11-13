//! Stitching H.264 pictures from stripes encoded separately, so a lyric video
//! over a still picture encodes only the stripe the lyrics move in.
//!
//! x264 encodes three videos with the same settings (`stitchable`, CAVLC, one
//! slice per picture, no deblocking, no B-frames): the lyric stripe (`band`)
//! for every frame, and the picture above and below it for one frame. Each
//! picture of the full video is then the band's slice moved down to its rows
//! (`first_mb_in_slice` rewritten), with the regions above and below as
//! slices of their own: on the first frame the picture's intra slices, after
//! that slices of skipped macroblocks only ("as before"), a few bytes each.
//!
//! This is exact (the band decodes bit for bit as on its own) as long as the
//! band's motion vectors never reach outside it: nothing that moves comes
//! within `GUARD` pixels of its top and bottom edges. Slices don't predict
//! across their edges, CAVLC contexts and intra prediction treat other slices
//! as unavailable, and deblocking is off.

/// Static rows kept inside the band above and below anything that moves.
pub const GUARD: u32 = 32;

/// The x264 settings every stripe is encoded with (also for `ffmpeg -x264-params`).
pub const X264_PARAMS: &str =
    "stitchable=1:scenecut=0:bframes=0:ref=1:slices=1:sliced-threads=0:no-deblock=1:cabac=0:8x8dct=0:weightp=0";

/// NAL units of an Annex B stream (without start codes or trailing zeros).
pub fn nals(stream: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= stream.len() {
        if stream[i] == 0 && stream[i + 1] == 0 && stream[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &s) in starts.iter().enumerate() {
        let mut e = starts.get(k + 1).map(|n| n - 3).unwrap_or(stream.len());
        while e > s && stream[e - 1] == 0 {
            e -= 1;
        }
        out.push(&stream[s..e]);
    }
    out
}

/// The NAL unit's payload without emulation-prevention bytes.
fn unescape(d: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(d.len());
    let mut zeros = 0;
    for &b in d {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// Emulation-prevention bytes put back.
fn escape(d: &[u8], out: &mut Vec<u8>) {
    let mut zeros = 0;
    for &b in d {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl Reader<'_> {
    fn bit(&mut self) -> Result<u32, String> {
        let byte = *self.b.get(self.p >> 3).ok_or("H.264: hết dữ liệu")?;
        let v = (byte >> (7 - (self.p & 7))) & 1;
        self.p += 1;
        Ok(v as u32)
    }
    fn u(&mut self, n: u32) -> Result<u32, String> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Ok(v)
    }
    fn ue(&mut self) -> Result<u32, String> {
        let mut z = 0;
        while self.bit()? == 0 {
            z += 1;
            if z > 31 {
                return Err("H.264: mã Exp-Golomb hỏng".into());
            }
        }
        Ok((1u32 << z) - 1 + self.u(z)?)
    }
    fn se(&mut self) -> Result<i32, String> {
        let k = self.ue()?;
        Ok(if k & 1 == 1 { k.div_ceil(2) as i32 } else { -((k / 2) as i32) })
    }
}

#[derive(Default)]
struct Writer {
    out: Vec<u8>,
    cur: u8,
    n: u32,
}

impl Writer {
    fn bit(&mut self, v: u32) {
        self.cur = (self.cur << 1) | (v & 1) as u8;
        self.n += 1;
        if self.n == 8 {
            self.out.push(self.cur);
            self.cur = 0;
            self.n = 0;
        }
    }
    fn u(&mut self, n: u32, v: u32) {
        for i in (0..n).rev() {
            self.bit((v >> i) & 1);
        }
    }
    /// Eight bits at once, at any bit offset.
    #[inline]
    fn byte(&mut self, v: u8) {
        if self.n == 0 {
            self.out.push(v);
        } else {
            let n = self.n;
            self.out.push((self.cur << (8 - n)) | (v >> n));
            self.cur = v & ((1u8 << n) - 1);
        }
    }
    fn ue(&mut self, v: u32) {
        let v = v as u64 + 1;
        let len = 64 - v.leading_zeros();
        for _ in 0..len - 1 {
            self.bit(0);
        }
        for i in (0..len).rev() {
            self.bit(((v >> i) & 1) as u32);
        }
    }
    #[cfg(test)]
    fn se(&mut self, v: i32) {
        self.ue(if v > 0 { (2 * v - 1) as u32 } else { (-2 * v) as u32 });
    }
    /// rbsp_trailing_bits.
    fn trail(&mut self) {
        self.bit(1);
        while self.n != 0 {
            self.bit(0);
        }
    }
    /// A NAL unit with header byte `hdr`, escaped, after a start code.
    fn nal(self, hdr: u8, out: &mut Vec<u8>) {
        debug_assert_eq!(self.n, 0);
        out.extend_from_slice(&[0, 0, 0, 1, hdr]);
        escape(&self.out, out);
    }
}

/// What slice headers need from the sequence and picture parameter sets.
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    profile: u32,
    constraints: u32,
    level: u32,
    high: bool,
    bit_depth: (u32, u32),
    qpprime: u32,
    log2_max_frame_num: u32,
    poc_type: u32,
    log2_max_poc_lsb: u32,
    max_refs: u32,
    gaps: u32,
    width_mbs: u32,
    direct_8x8: u32,
    // PPS
    pps: Vec<u8>,
    bottom_field_pic_order: bool,
    weighted_pred: bool,
    deblocking_control: bool,
    redundant_pic_cnt: bool,
    cabac: bool,
}

/// The parameter sets of an x264 stream (its first SPS and PPS).
pub fn params(stream: &[u8]) -> Result<Params, String> {
    let units = nals(stream);
    let sps = units.iter().find(|n| n.first().map(|h| h & 31) == Some(7)).ok_or("H.264: thiếu SPS")?;
    let pps = units.iter().find(|n| n.first().map(|h| h & 31) == Some(8)).ok_or("H.264: thiếu PPS")?;
    let s = unescape(&sps[1..]);
    let mut r = Reader { b: &s, p: 0 };
    let profile = r.u(8)?;
    let constraints = r.u(8)?;
    let level = r.u(8)?;
    r.ue()?; // sps id
    let high = matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135);
    let (mut bit_depth, mut qpprime) = ((0, 0), 0);
    if high {
        if r.ue()? != 1 {
            return Err("H.264: chỉ hỗ trợ 4:2:0".into());
        }
        bit_depth = (r.ue()?, r.ue()?);
        qpprime = r.u(1)?;
        if r.u(1)? != 0 {
            return Err("H.264: không hỗ trợ ma trận lượng tử riêng".into());
        }
    }
    let log2_max_frame_num = r.ue()? + 4;
    let poc_type = r.ue()?;
    let mut log2_max_poc_lsb = 0;
    match poc_type {
        0 => log2_max_poc_lsb = r.ue()? + 4,
        2 => {}
        _ => return Err("H.264: kiểu POC không hỗ trợ".into()),
    }
    let max_refs = r.ue()?;
    let gaps = r.u(1)?;
    let width_mbs = r.ue()? + 1;
    r.ue()?; // height
    if r.u(1)? != 1 {
        return Err("H.264: chỉ hỗ trợ khung hình liền (progressive)".into());
    }
    let direct_8x8 = r.u(1)?;
    let p = unescape(&pps[1..]);
    let mut r = Reader { b: &p, p: 0 };
    r.ue()?;
    r.ue()?;
    let cabac = r.u(1)? == 1;
    let bottom_field_pic_order = r.u(1)? == 1;
    if r.ue()? != 0 {
        return Err("H.264: không hỗ trợ slice group".into());
    }
    r.ue()?;
    r.ue()?;
    let weighted_pred = r.u(1)? == 1;
    r.u(2)?;
    r.se()?;
    r.se()?;
    r.se()?;
    let deblocking_control = r.u(1)? == 1;
    r.u(1)?;
    let redundant_pic_cnt = r.u(1)? == 1;
    if cabac {
        return Err("H.264: cần CAVLC (cabac=0)".into());
    }
    Ok(Params {
        profile,
        constraints,
        level,
        high,
        bit_depth,
        qpprime,
        log2_max_frame_num,
        poc_type,
        log2_max_poc_lsb,
        max_refs,
        gaps,
        width_mbs,
        direct_8x8,
        pps: pps.to_vec(),
        bottom_field_pic_order,
        weighted_pred,
        deblocking_control,
        redundant_pic_cnt,
        cabac,
    })
}

impl Params {
    /// Whether slices of `other` can go into pictures made with these.
    pub fn compatible(&self, other: &Params) -> bool {
        let mut a = other.clone();
        a.width_mbs = self.width_mbs;
        a.level = self.level;
        a.constraints = self.constraints;
        *self == a
    }

    /// The SPS and PPS of the whole video: `height_mbs` macroblock rows,
    /// cropped to `width`×`height` pixels.
    pub fn headers(&self, height_mbs: u32, width: u32, height: u32, out: &mut Vec<u8>) {
        let mut w = Writer::default();
        // Level 5.1: enough for any of our sizes at 30 fps (the stripes' own may be lower).
        w.u(8, self.profile);
        w.u(8, self.constraints);
        w.u(8, self.level.max(51));
        w.ue(0);
        if self.high {
            w.ue(1);
            w.ue(self.bit_depth.0);
            w.ue(self.bit_depth.1);
            w.u(1, self.qpprime);
            w.u(1, 0);
        }
        w.ue(self.log2_max_frame_num - 4);
        w.ue(self.poc_type);
        if self.poc_type == 0 {
            w.ue(self.log2_max_poc_lsb - 4);
        }
        w.ue(self.max_refs);
        w.u(1, self.gaps);
        w.ue(self.width_mbs - 1);
        w.ue(height_mbs - 1);
        w.u(1, 1); // frame_mbs_only
        w.u(1, self.direct_8x8);
        let (cr, cb) = (self.width_mbs * 16 - width, height_mbs * 16 - height);
        if cr > 0 || cb > 0 {
            w.u(1, 1);
            w.ue(0);
            w.ue(cr / 2);
            w.ue(0);
            w.ue(cb / 2);
        } else {
            w.u(1, 0);
        }
        w.u(1, 0); // no VUI: the container gives the frame rate
        w.trail();
        w.nal(0x67, out);
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&self.pps);
    }
}

/// A coded slice: its header byte, header fields, and where its data starts.
pub struct Slice {
    hdr: u8,
    rbsp: Vec<u8>,
    /// Bit offset of the first field after `first_mb_in_slice`.
    after_first_mb: usize,
    /// Bit offset of `slice_qp_delta`.
    qp_at: usize,
    /// Bit offset of slice_data().
    data_at: usize,
}

/// The coded slices of a stream, in order.
pub fn slices(stream: &[u8], p: &Params) -> Result<Vec<Slice>, String> {
    nals(stream).into_iter().filter(|n| matches!(n.first().map(|h| h & 31), Some(1) | Some(5))).map(|n| parse_slice(n, p)).collect()
}

fn parse_slice(nal: &[u8], p: &Params) -> Result<Slice, String> {
    let hdr = nal[0];
    let (idr, refd) = (hdr & 31 == 5, hdr >> 5 != 0);
    let rbsp = unescape(&nal[1..]);
    let mut r = Reader { b: &rbsp, p: 0 };
    r.ue()?;
    let after_first_mb = r.p;
    let t = r.ue()? % 5;
    r.ue()?; // pps id
    r.u(p.log2_max_frame_num)?;
    if idr {
        r.ue()?;
    }
    if p.poc_type == 0 {
        r.u(p.log2_max_poc_lsb)?;
        if p.bottom_field_pic_order {
            r.se()?;
        }
    }
    if p.redundant_pic_cnt {
        r.ue()?;
    }
    if t == 0 || t == 3 {
        if r.u(1)? == 1 {
            r.ue()?;
        }
    }
    if t != 2 && t != 4 && r.u(1)? == 1 {
        loop {
            let idc = r.ue()?;
            if idc == 3 {
                break;
            }
            r.ue()?;
        }
    }
    if p.weighted_pred && (t == 0 || t == 3) {
        return Err("H.264: không hỗ trợ weighted prediction".into());
    }
    if refd {
        if idr {
            r.u(2)?;
        } else if r.u(1)? == 1 {
            loop {
                let op = r.ue()?;
                if op == 0 {
                    break;
                }
                if matches!(op, 1 | 3) {
                    r.ue()?;
                }
                if op == 2 {
                    r.ue()?;
                }
                if matches!(op, 3 | 6) {
                    r.ue()?;
                }
                if op == 4 {
                    r.ue()?;
                }
            }
        }
    }
    let qp_at = r.p;
    r.se()?;
    if p.deblocking_control {
        let idc = r.ue()?;
        if idc != 1 {
            r.se()?;
            r.se()?;
        }
    }
    let data_at = r.p;
    Ok(Slice { hdr, rbsp, after_first_mb, qp_at, data_at })
}

/// Copy bits `from..to` of `src` into `w`.
fn copy_bits(src: &[u8], from: usize, to: usize, w: &mut Writer) {
    let mut r = Reader { b: src, p: from };
    // Bit by bit to the source's next byte, then whole bytes (shifted into
    // the writer's bit position), then the last bits.
    while r.p < to && r.p & 7 != 0 {
        w.bit(r.bit().unwrap_or(0));
    }
    let whole = (to - r.p) / 8;
    let bytes = &src[r.p / 8..r.p / 8 + whole];
    if w.n == 0 {
        w.out.extend_from_slice(bytes);
    } else {
        w.out.reserve(bytes.len());
        for &b in bytes {
            w.byte(b);
        }
    }
    r.p += whole * 8;
    while r.p < to {
        w.bit(r.bit().unwrap_or(0));
    }
}

/// Bit offset of the rbsp stop bit (the last 1).
fn stop_bit(rbsp: &[u8]) -> usize {
    let mut end = rbsp.len();
    while end > 0 && rbsp[end - 1] == 0 {
        end -= 1;
    }
    if end == 0 {
        return 0;
    }
    let last = rbsp[end - 1];
    end * 8 - 1 - last.trailing_zeros() as usize
}

impl Slice {
    /// This slice starting at macroblock `first_mb`, appended to `out`.
    pub fn moved(&self, first_mb: u32, out: &mut Vec<u8>) {
        let mut w = Writer::default();
        w.ue(first_mb);
        copy_bits(&self.rbsp, self.after_first_mb, stop_bit(&self.rbsp), &mut w);
        w.trail();
        w.nal(self.hdr, out);
    }

    /// A slice of this picture from `first_mb`, `count` macroblocks all
    /// skipped (P only), with this slice's header otherwise.
    pub fn skipped(&self, first_mb: u32, count: u32, out: &mut Vec<u8>) {
        let mut w = Writer::default();
        w.ue(first_mb);
        copy_bits(&self.rbsp, self.after_first_mb, self.data_at, &mut w);
        w.ue(count);
        w.trail();
        w.nal(self.hdr, out);
    }

    /// This (intra) slice's data under the header of `pic`'s slice (an IDR
    /// slice of the same picture: frame_num, idr_pic_id and POC must match),
    /// from macroblock `first_mb`, keeping its own QP.
    pub fn under(&self, pic: &Slice, first_mb: u32, out: &mut Vec<u8>) {
        let mut w = Writer::default();
        w.ue(first_mb);
        copy_bits(&pic.rbsp, pic.after_first_mb, pic.qp_at, &mut w);
        copy_bits(&self.rbsp, self.qp_at, stop_bit(&self.rbsp), &mut w);
        w.trail();
        w.nal(pic.hdr, out);
    }

    pub fn is_idr(&self) -> bool {
        self.hdr & 31 == 5
    }
}

/// One stretch of the video encoded as stripes: the band's pictures and the
/// still picture above and below it (one intra frame each; absent when the
/// band reaches that edge).
pub struct Stripes<'a> {
    pub band: &'a [u8],
    pub top: Option<&'a [u8]>,
    pub bottom: Option<&'a [u8]>,
    /// The band's first and last macroblock rows (exclusive end).
    pub rows: (u32, u32),
}

/// Append the full pictures of `s` to `out` (an Annex B stream, after the
/// headers from `Params::headers`). Every IDR of the band gets the still
/// regions' intra slices, every other picture skipped slices.
pub fn stitch(p: &Params, s: &Stripes, height_mbs: u32, out: &mut Vec<u8>) -> Result<usize, String> {
    let band = slices(s.band, p)?;
    let still = |b: Option<&[u8]>| -> Result<Option<Slice>, String> {
        match b {
            Some(b) => {
                let q = params(b)?;
                if !p.compatible(&q) {
                    return Err("H.264: các dải mã hóa không cùng thiết lập".into());
                }
                let sl = slices(b, &q)?.into_iter().next().ok_or("H.264: dải ảnh nền trống")?;
                Ok(Some(sl))
            }
            None => Ok(None),
        }
    };
    let (top, bottom) = (still(s.top)?, still(s.bottom)?);
    let w = p.width_mbs;
    let (r0, r1) = s.rows;
    for sl in &band {
        if r0 > 0 {
            match (&top, sl.is_idr()) {
                (Some(t), true) => t.under(sl, 0, out),
                (_, false) => sl.skipped(0, r0 * w, out),
                (None, true) => return Err("H.264: thiếu ảnh nền phía trên".into()),
            }
        }
        sl.moved(r0 * w, out);
        if r1 < height_mbs {
            match (&bottom, sl.is_idr()) {
                (Some(b), true) => b.under(sl, r1 * w, out),
                (_, false) => sl.skipped(r1 * w, (height_mbs - r1) * w, out),
                (None, true) => return Err("H.264: thiếu ảnh nền phía dưới".into()),
            }
        }
    }
    Ok(band.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exp_golomb_round_trip() {
        let mut w = Writer::default();
        for v in [0u32, 1, 2, 7, 255, 5280, 65_000] {
            w.ue(v);
        }
        for v in [0i32, 1, -1, 26, -26] {
            w.se(v);
        }
        w.trail();
        let mut r = Reader { b: &w.out, p: 0 };
        for v in [0u32, 1, 2, 7, 255, 5280, 65_000] {
            assert_eq!(r.ue().unwrap(), v);
        }
        for v in [0i32, 1, -1, 26, -26] {
            assert_eq!(r.se().unwrap(), v);
        }
    }

    #[test]
    fn copies_bits_at_any_offset() {
        let src: Vec<u8> = (0..64u32).map(|i| (i * 37 + 11) as u8).collect();
        for (from, to, lead) in [(0, 512, 0), (3, 500, 5), (9, 300, 1), (8, 16, 7)] {
            let mut w = Writer::default();
            w.u(lead, 0b101_1011 & ((1 << lead) - 1));
            copy_bits(&src, from, to, &mut w);
            let mut slow = Writer::default();
            slow.u(lead, 0b101_1011 & ((1 << lead) - 1));
            let mut r = Reader { b: &src, p: from };
            while r.p < to {
                slow.bit(r.bit().unwrap());
            }
            assert_eq!((w.out, w.cur, w.n), (slow.out, slow.cur, slow.n), "{from}..{to} after {lead}");
        }
    }

    #[test]
    fn escaping_round_trip() {
        let raw = [0u8, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 7];
        let mut esc = Vec::new();
        escape(&raw, &mut esc);
        assert!(esc.windows(3).all(|w| !(w[0] == 0 && w[1] == 0 && w[2] <= 2)));
        assert_eq!(unescape(&esc), raw);
    }
}

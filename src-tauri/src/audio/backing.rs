//! Backing harmony made from the separated original vocal, so the karaoke
//! track carries a "bè" (a voice a third or so away, following the song's
//! scale) without a microphone, on stage and in exported videos.
//!
//! The same machinery as the live harmonies on the mic (`chain.rs`): McLeod
//! pitch detection, the detected note snapped to the song's scale, and a
//! diatonic shift resynthesised with TD-PSOLA. It runs offline over the whole
//! vocal, so it can take its time and its latency is simply cut off.

use super::chords::{chord_at, Chord};
use super::fx::{Biquad, DeEsser, Reverb, Shape};
use super::melody::Note;
use super::pitch::PitchDetector;
use super::psola::{Psola, VoiceTarget, MAX_VOICES};
use super::scale;

/// Pitch clarity below this is breath, noise or separation bleed.
const MIN_CLARITY: f32 = 0.85;
/// Inside a melody note a weaker reading still gives a usable period.
const NOTE_CLARITY: f32 = 0.5;
/// Quieter than this (linear, about -42 dBFS) is bleed between phrases.
const MIN_LEVEL: f32 = 0.008;
/// Without melody notes: stay voiced this long after the last clear reading,
/// so a breathy instant doesn't chop the harmony.
const HOLD: f32 = 0.08;
/// Fade a harmony in and out at a note's edges (seconds).
const FADE_IN: f32 = 0.03;
const FADE_OUT: f32 = 0.04;

/// Index of the major and natural minor scales in `scale::SCALES`.
const MAJOR: usize = 1;
const MINOR: usize = 2;

/// The harmony note (MIDI) a voice sings for each of the melody's `notes`:
/// `deg` scale steps away (+2 = a third above) as the plain rule, but where
/// the chord being played is known, the chord's note nearest that, as an
/// arranger would: a third up the scale clashes wherever the chord isn't
/// the scale's own (a melody E in C major over an E major chord: G#, the
/// chord's, not the scale's G). Voice leading: a chord note the voice
/// already holds is kept rather than jumping to an equally good one.
pub fn plan(notes: &[Note], deg: i32, tonic: i32, sc: &[u8], chords: &[Chord]) -> Vec<i32> {
    let mut prev: Option<(i32, f32)> = None;
    notes
        .iter()
        .map(|n| {
            let base = scale::nearest(n.midi, tonic, sc);
            let rule = scale::shift_degrees(base, deg, tonic, sc);
            // The chord under the note's onset (just after it: chords change on the beat).
            let at = n.start + (0.5 * (n.end - n.start)).min(0.15);
            let held = prev.filter(|(_, end)| n.start - end < 0.8).map(|(m, _)| m);
            let harm = match chord_at(chords, at) {
                Some(c) if deg.abs() != 7 => {
                    let want = (rule - base).abs();
                    let dir = deg.signum();
                    // Chord notes on the voice's side, from a minor third up
                    // to a whole tone either side of the rule's interval.
                    let cands: Vec<i32> = ((want - 2).max(3)..=(want + 2)).map(|d| base + dir * d).filter(|m| c.has(*m)).collect();
                    match held.filter(|h| cands.contains(h)) {
                        Some(h) => h,
                        None => cands
                            .iter()
                            .copied()
                            .min_by_key(|m| ((m - rule).abs(), held.map(|h| (m - h).abs()).unwrap_or(0)))
                            .unwrap_or(rule),
                    }
                }
                _ => rule,
            };
            prev = Some((harm, n.end));
            harm
        })
        .collect()
}

/// Index of the note sounding at `t`, if any.
fn note_index(notes: &[Note], t: f32) -> Option<usize> {
    let i = notes.partition_point(|n| n.end < t);
    notes.get(i).filter(|n| n.start <= t).map(|_| i)
}

/// Harmony voices for a stereo vocal (interleaved, `sr` Hz): one voice per
/// entry of `degrees` (scale steps, +2 = a third above, -2 a third below),
/// in the key `tonic` (0 = C) major or minor. Returns interleaved stereo of
/// the same length, the voices panned apart.
///
/// With the singer's `notes` (the melody as segmented notes, seconds in this
/// vocal) each harmony note follows a whole sung note: one interval for the
/// note, sung only inside it, faded at its edges. Snapping every 4 ms reading
/// instead made the harmony flip between intervals on vibrato and chop on
/// breathy instants. Without notes it falls back to that, steadied.
pub fn harmony(vocal: &[f32], sr: u32, tonic: i32, minor: bool, degrees: &[i32], notes: &[Note], chords: &[Chord]) -> Vec<f32> {
    let frames = vocal.len() / 2;
    let voices: Vec<i32> = degrees.iter().copied().filter(|d| *d != 0).take(MAX_VOICES).collect();
    let mut out = vec![0.0f32; frames * 2];
    if voices.is_empty() || frames == 0 {
        return out;
    }
    if !notes.is_empty() {
        return spectral_harmony(vocal, sr, tonic, minor, &voices, notes, chords);
    }
    let fs = sr as f32;
    let sc = scale::scale(if minor { MINOR } else { MAJOR });
    let plans: Vec<Vec<i32>> = voices.iter().map(|d| plan(notes, *d, tonic, sc, chords)).collect();
    let mut detector = PitchDetector::new(fs);
    let mut psola = Psola::new(fs);
    let latency = psola.latency();
    let mut level = 0.0f32;
    let mut v = [0.0f32; MAX_VOICES];
    // One voice sits in the middle; two spread left and right.
    let pans: Vec<f32> = match voices.len() {
        1 => vec![0.0],
        n => (0..n).map(|i| -0.6 + 1.2 * i as f32 / (n - 1) as f32).collect(),
    };
    let gains: Vec<(f32, f32)> = pans.iter().map(|p| ((0.5 - 0.5 * p).sqrt(), (0.5 + 0.5 * p).sqrt())).collect();
    // Fallback state: the held note and how long ago a clear reading came.
    let mut held: Option<i32> = None;
    let mut since_clear = f32::INFINITY;
    let hop = detector.hop() as f32 / fs;

    let silence = |psola: &mut Psola| {
        psola.set_period(None);
        for k in 0..voices.len() {
            psola.set_voice(k, VoiceTarget { active: false, ..Default::default() });
        }
    };

    for i in 0..frames + latency {
        let x = if i < frames { 0.5 * (vocal[2 * i] + vocal[2 * i + 1]) } else { 0.0 };
        level += (x.abs() - level) * 0.002;
        if let Some(est) = detector.push(x) {
            let t = i as f32 / fs;
            if !notes.is_empty() {
                match note_index(notes, t).map(|i| (i, &notes[i])) {
                    Some((ni, n)) if level >= MIN_LEVEL * 0.5 => {
                        let note_hz = 440.0 * 2f32.powf((n.midi - 69.0) / 12.0);
                        // The detector's period when it agrees with the note
                        // (within 2 semitones), else the note's: no octave slips.
                        let near = est.freq > 0.0 && est.clarity >= NOTE_CLARITY && (12.0 * (est.freq / note_hz).log2()).abs() < 2.0;
                        psola.set_period(Some(fs / if near { est.freq } else { note_hz }));
                        let base = scale::nearest(n.midi, tonic, sc);
                        let edge = ((t - n.start) / FADE_IN).min((n.end - t) / FADE_OUT).clamp(0.0, 1.0);
                        for (k, voice) in plans.iter().enumerate() {
                            let harm = voice[ni];
                            let ratio = 2f32.powf((harm - base) as f32 / 12.0);
                            let formant = if harm < base { 0.97 } else { 1.0 };
                            psola.set_voice(k, VoiceTarget { active: edge > 0.0, ratio, formant, gain: edge });
                        }
                    }
                    _ => silence(&mut psola),
                }
            } else {
                let clear = est.freq > 0.0 && est.clarity >= MIN_CLARITY && level >= MIN_LEVEL;
                since_clear = if clear { 0.0 } else { since_clear + hop };
                if since_clear > HOLD {
                    held = None;
                    silence(&mut psola);
                } else if clear {
                    psola.set_period(Some(fs / est.freq));
                    let m = 69.0 + 12.0 * (est.freq / 440.0).log2();
                    let nearest = scale::nearest(m, tonic, sc);
                    // Keep the held note unless the pitch is clearly nearer another.
                    let note = match held {
                        Some(cur) if cur != nearest && (m - cur as f32).abs() < (m - nearest as f32).abs() + 0.35 => cur,
                        _ => nearest,
                    };
                    held = Some(note);
                    for (k, deg) in voices.iter().enumerate() {
                        let harm = scale::shift_degrees(note, *deg, tonic, sc);
                        let ratio = 2f32.powf((harm - note) as f32 / 12.0);
                        let formant = if harm < note { 0.97 } else { 1.0 };
                        psola.set_voice(k, VoiceTarget { active: true, ratio, formant, gain: 1.0 });
                    }
                }
            }
        }
        psola.process(x, &mut v);
        // The resynthesis lags the input by `latency`: write it back in place.
        if let Some(f) = i.checked_sub(latency).filter(|f| *f < frames) {
            for (k, (gl, gr)) in gains.iter().enumerate() {
                out[2 * f] += v[k] * gl;
                out[2 * f + 1] += v[k] * gr;
            }
        }
    }
    out
}

/// Above this frequency (Hz) a harmony isn't transposed: sibilants and breath
/// stay put instead of turning into a metallic hiss.
const TONALITY_LIMIT_HZ: f32 = 8000.0;
/// Samples per block between changes of the transpose factor.
const BLOCK: usize = 256;

/// The note-following harmony through Signalsmith Stretch: a spectral pitch
/// shift that keeps the singer's formants. TD-PSOLA needs exact pitch marks,
/// which reverb and bleed in a separated vocal spoil (cracks, chopping); this
/// doesn't. Each voice is transposed by one interval per sung note, sounds
/// only inside the notes and fades at their edges.
fn spectral_harmony(vocal: &[f32], sr: u32, tonic: i32, minor: bool, voices: &[i32], notes: &[Note], chords: &[Chord]) -> Vec<f32> {
    use signalsmith_stretch::Stretch;
    let frames = vocal.len() / 2;
    let fs = sr as f32;
    let sc = scale::scale(if minor { MINOR } else { MAJOR });
    let mono: Vec<f32> = vocal.chunks_exact(2).map(|c| 0.5 * (c[0] + c[1])).collect();
    // Each note's interval for each voice (semitones), and the fade envelope.
    let interval = |plan: &[i32], i: usize| (plan[i] - scale::nearest(notes[i].midi, tonic, sc)) as f32;
    let mut env = vec![0.0f32; frames];
    for n in notes {
        let (a, b) = ((n.start * fs).max(0.0) as usize, ((n.end * fs) as usize).min(frames));
        for (f, e) in env.iter_mut().enumerate().take(b).skip(a) {
            let t = f as f32 / fs;
            *e = e.max(((t - n.start) / FADE_IN).min((n.end - t) / FADE_OUT).clamp(0.0, 1.0));
        }
    }
    let mut out = vec![0.0f32; frames * 2];
    let n_voices = voices.len();
    for (k, deg) in voices.iter().enumerate() {
        let voice = plan(notes, *deg, tonic, sc, chords);
        let pan = if n_voices == 1 { 0.0 } else { -0.6 + 1.2 * k as f32 / (n_voices - 1) as f32 };
        let (gl, gr) = ((0.5 - 0.5 * pan).sqrt(), (0.5 + 0.5 * pan).sqrt());
        let mut st = Stretch::preset_default(1, sr);
        st.set_formant_factor(1.0, true);
        let latency = st.input_latency() + st.output_latency();
        let total = frames + latency;
        let mut shifted = vec![0.0f32; total];
        let mut input = vec![0.0f32; BLOCK];
        let mut current = f32::NAN;
        let mut i = 0;
        while i < total {
            let n = BLOCK.min(total - i);
            // The interval of the note this block belongs to; between notes
            // keep the last one (it is silent there anyway).
            let t = (i + n / 2) as f32 / fs;
            let semis = note_index(notes, t).map(|i| interval(&voice, i)).unwrap_or(current);
            let semis = if semis.is_nan() { interval(&voice, 0) } else { semis };
            if semis != current {
                st.set_transpose_factor_semitones(semis, Some(TONALITY_LIMIT_HZ / fs));
                current = semis;
            }
            for (j, x) in input[..n].iter_mut().enumerate() {
                *x = mono.get(i + j).copied().unwrap_or(0.0);
            }
            st.process(&input[..n], &mut shifted[i..i + n]);
            i += n;
        }
        for f in 0..frames {
            let y = shifted[f + latency] * env[f];
            out[2 * f] += y * gl;
            out[2 * f + 1] += y * gr;
        }
    }
    out
}

// ------------------------------------------------------- studio polish --

/// The harmony mixed like recorded backing vocals, so it sits behind the
/// lead instead of on top of it: no low end (that's the lead's and the
/// bass's), less presence and air, the "s" sounds tamed (`voice`: the
/// singer's own, shifted), a few milliseconds late, and in a room (a
/// reverb, which also spreads it across the stereo field). Interleaved
/// stereo at `sr`, the same length.
pub fn polish(buf: &[f32], sr: u32, voice: bool) -> Vec<f32> {
    let fs = sr as f32;
    let frames = buf.len() / 2;
    let mut eq = [[Biquad::default(); 3]; 2];
    for ch in eq.iter_mut() {
        ch[0].set(Shape::HighPass, 200.0, 0.707, fs);
        ch[1].set(Shape::Peak(-2.5), 3000.0, 0.9, fs);
        ch[2].set(Shape::HighShelf(-3.0), 7000.0, 0.707, fs);
    }
    let mut deess = [DeEsser::new(fs), DeEsser::new(fs)];
    let mut room = Reverb::new(fs);
    // Behind the lead: 12 ms late (well under an echo).
    let late = (0.012 * fs) as usize;
    let mut out = vec![0.0f32; buf.len()];
    for f in 0..frames {
        let mut x = [buf[2 * f], buf[2 * f + 1]];
        for (ch, v) in x.iter_mut().enumerate() {
            for b in eq[ch].iter_mut() {
                *v = b.run(*v);
            }
            if voice {
                *v = deess[ch].run(*v, 0.7);
            }
        }
        let (wl, wr) = room.run(x[0], x[1], 0.62, 0.5);
        if let Some(o) = out.get_mut(2 * (f + late)..2 * (f + late) + 2) {
            o[0] = 0.85 * x[0] + 0.55 * wl;
            o[1] = 0.85 * x[1] + 0.55 * wr;
        }
    }
    out
}

// ------------------------------------------------------------ choir "ooh" --

/// Samples in one period of a choir voice's wavetable.
const TABLE: usize = 2048;
/// Partials above this are left out (the vowel has little energy there).
const CHOIR_TOP_HZ: f32 = 5000.0;
/// The vowel "u" ("ooh"): formant frequency, bandwidth and level.
const OOH: [(f32, f32, f32); 3] = [(325.0, 80.0, 1.0), (700.0, 110.0, 0.45), (2530.0, 160.0, 0.12)];
/// Ensemble: each harmony voice is three singers, detuned (cents) and panned.
const ENSEMBLE: [(f32, f32); 3] = [(-7.0, -0.35), (0.0, 0.0), (6.0, 0.35)];
const CHOIR_ATTACK: f32 = 0.06;
const CHOIR_RELEASE: f32 = 0.15;
/// Notes closer than this are sung legato: the pitch glides, no new attack.
const LEGATO_GAP: f32 = 0.09;
const GLIDE: f32 = 0.05;
const XFADE: f32 = 0.03;

/// One period of an "ooh" at `f0`: harmonics falling off like a voice,
/// shaped by the vowel's formants, normalised to peak 1.
fn ooh_table(f0: f32) -> Vec<f32> {
    let k_max = ((CHOIR_TOP_HZ / f0).floor() as usize).max(1);
    let amps: Vec<f32> = (1..=k_max)
        .map(|k| {
            let f = k as f32 * f0;
            let vowel: f32 = 0.08 + OOH.iter().map(|(fc, bw, a)| a / (1.0 + ((f - fc) / bw).powi(2))).sum::<f32>();
            vowel / (k as f32).powf(1.2)
        })
        .collect();
    let mut t: Vec<f32> = (0..TABLE)
        .map(|i| {
            let ph = std::f32::consts::TAU * i as f32 / TABLE as f32;
            amps.iter().enumerate().map(|(k, a)| a * ((k + 1) as f32 * ph).sin()).sum()
        })
        .collect();
    let peak = t.iter().fold(0.0f32, |m, x| m.max(x.abs())).max(1e-6);
    t.iter_mut().for_each(|x| *x /= peak);
    t
}

fn hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

/// A clean synthesised choir singing "ooh" in harmony with the melody: for
/// each sung note, one voice per scale step in `degrees` (+2 = a third
/// above), in the key `tonic` major or minor. Nothing of the original vocal
/// goes in, so nothing of its reverb or bleed can crack. `frames` long,
/// interleaved stereo at `sr`. Silent without notes.
pub fn choir(frames: usize, sr: u32, tonic: i32, minor: bool, degrees: &[i32], notes: &[Note], chords: &[Chord]) -> Vec<f32> {
    let fs = sr as f32;
    let sc = scale::scale(if minor { MINOR } else { MAJOR });
    let voices: Vec<i32> = degrees.iter().copied().filter(|d| *d != 0).take(MAX_VOICES).collect();
    let mut out = vec![0.0f32; frames * 2];
    if voices.is_empty() || notes.is_empty() || frames == 0 {
        return out;
    }
    let level = 0.16 / ((voices.len() * ENSEMBLE.len()) as f32).sqrt();
    for deg in voices.iter() {
        // The harmony note for each sung note, and its wavetable.
        let voice = plan(notes, *deg, tonic, sc, chords);
        let parts: Vec<(f32, f32, f32, Vec<f32>)> = notes
            .iter()
            .zip(&voice)
            .map(|(n, harm)| {
                let base = scale::nearest(n.midi, tonic, sc);
                let m = *harm as f32 + (n.midi - base as f32) * 0.3;
                (n.start, n.end, hz(m), ooh_table(hz(m)))
            })
            .collect();
        // A voice's lower harmony sits slightly left, the upper right.
        let side = match (voices.len(), *deg < 0) {
            (1, _) => 0.0,
            (_, true) => -0.25,
            (_, false) => 0.25,
        };
        for (ei, (cents, pan)) in ENSEMBLE.iter().enumerate() {
            let pan = (pan + side).clamp(-1.0, 1.0);
            let (gl, gr) = ((0.5 - 0.5 * pan).sqrt(), (0.5 + 0.5 * pan).sqrt());
            let detune = 2f32.powf(cents / 1200.0);
            let mut phase = 0.0f32;
            // Each singer's vibrato drifts a little apart from the others.
            let vib_rate = 5.0 + 0.35 * ei as f32;
            let mut i = 0;
            while i < parts.len() {
                // A phrase: notes joined legato.
                let mut j = i;
                while j + 1 < parts.len() && parts[j + 1].0 - parts[j].1 < LEGATO_GAP {
                    j += 1;
                }
                let (start, end) = (parts[i].0, parts[j].1);
                let (a, b) = ((start * fs).max(0.0) as usize, (((end + CHOIR_RELEASE) * fs) as usize).min(frames));
                let mut cur = i;
                for f in a..b {
                    let t = f as f32 / fs;
                    while cur < j && t >= parts[cur + 1].0 {
                        cur += 1;
                    }
                    let (n_start, _, f_now, ref table) = parts[cur];
                    // Glide in from the previous note, crossfading its timbre.
                    let since = t - n_start;
                    let (freq, prev) = if cur > i && since < GLIDE.max(XFADE) {
                        let f_prev = parts[cur - 1].2;
                        let g = (since / GLIDE).clamp(0.0, 1.0);
                        (f_prev * (f_now / f_prev).powf(g), Some((&parts[cur - 1].3, (since / XFADE).clamp(0.0, 1.0))))
                    } else {
                        (f_now, None)
                    };
                    let held = t - start;
                    let vib = if held > 0.25 { ((held - 0.25) / 0.4).min(1.0) * 0.18 } else { 0.0 };
                    let vib = 2f32.powf(vib * (std::f32::consts::TAU * vib_rate * t + ei as f32).sin() / 12.0);
                    phase = (phase + freq * detune * vib / fs).fract();
                    let x = phase * TABLE as f32;
                    let (k, frac) = (x as usize % TABLE, x.fract());
                    let read = |tb: &Vec<f32>| tb[k] + (tb[(k + 1) % TABLE] - tb[k]) * frac;
                    let y = match prev {
                        Some((pt, mix)) => read(pt) * (1.0 - mix) + read(table) * mix,
                        None => read(table),
                    };
                    let env = (held / CHOIR_ATTACK).min(1.0).min(((end + CHOIR_RELEASE - t) / CHOIR_RELEASE).min(1.0)).max(0.0);
                    let env = env * env * (3.0 - 2.0 * env); // smoothstep
                    let y = y * env * level;
                    out[2 * f] += y * gl;
                    out[2 * f + 1] += y * gr;
                }
                i = j + 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sung A4 (440 Hz) in C major, a third above is C5 (523 Hz).
    #[test]
    fn a_third_above_follows_the_scale() {
        let sr = 44_100u32;
        let n = sr as usize; // one second
        let tone: Vec<f32> = (0..n)
            .flat_map(|i| {
                let t = i as f32 / sr as f32;
                // A voice-like tone: fundamental plus a few harmonics.
                let s = (1..=5).map(|h| (std::f32::consts::TAU * 440.0 * h as f32 * t).sin() / h as f32).sum::<f32>() * 0.2;
                [s, s]
            })
            .collect();
        let out = harmony(&tone, sr, 0, false, &[2], &[], &[]);
        assert_eq!(out.len(), tone.len());
        // Estimate the output pitch in the steady middle part.
        let mono: Vec<f32> = out.chunks(2).map(|c| c[0] + c[1]).collect();
        let mut det = PitchDetector::new(sr as f32);
        let mut freqs = Vec::new();
        for (i, x) in mono.iter().enumerate() {
            if let Some(e) = det.push(*x) {
                if i > n / 3 && i < 2 * n / 3 && e.freq > 0.0 {
                    freqs.push(e.freq);
                }
            }
        }
        freqs.sort_by(f32::total_cmp);
        let f = freqs[freqs.len() / 2];
        assert!((f - 523.25).abs() < 8.0, "expected about 523 Hz (C5), got {f}");
    }

    #[test]
    fn with_notes_it_sings_only_inside_them() {
        let sr = 44_100u32;
        let n = sr as usize;
        let tone: Vec<f32> = (0..n)
            .flat_map(|i| {
                let t = i as f32 / sr as f32;
                let s = (1..=5).map(|h| (std::f32::consts::TAU * 440.0 * h as f32 * t).sin() / h as f32).sum::<f32>() * 0.2;
                [s, s]
            })
            .collect();
        let notes = [Note { start: 0.3, end: 0.7, midi: 69.0 }];
        let out = harmony(&tone, sr, 0, false, &[2], &notes, &[]);
        let energy = |a: f32, b: f32| -> f32 {
            let (a, b) = ((a * sr as f32) as usize, (b * sr as f32) as usize);
            out[2 * a..2 * b].iter().map(|x| x * x).sum::<f32>() / (b - a) as f32
        };
        // Silent well before and after the note, sounding inside it.
        assert!(energy(0.05, 0.25) < 1e-6, "before: {}", energy(0.05, 0.25));
        assert!(energy(0.78, 0.95) < 1e-6, "after: {}", energy(0.78, 0.95));
        assert!(energy(0.4, 0.6) > 1e-3, "inside: {}", energy(0.4, 0.6));
    }

    #[test]
    fn spectral_third_above_with_notes() {
        let sr = 44_100u32;
        let n = sr as usize;
        let tone: Vec<f32> = (0..n)
            .flat_map(|i| {
                let t = i as f32 / sr as f32;
                let s = (1..=5).map(|h| (std::f32::consts::TAU * 440.0 * h as f32 * t).sin() / h as f32).sum::<f32>() * 0.2;
                [s, s]
            })
            .collect();
        let out = harmony(&tone, sr, 0, false, &[2], &[Note { start: 0.0, end: 1.0, midi: 69.0 }], &[]);
        let mono: Vec<f32> = out.chunks(2).map(|c| c[0] + c[1]).collect();
        let mut det = PitchDetector::new(sr as f32);
        let mut freqs = Vec::new();
        for (i, x) in mono.iter().enumerate() {
            if let Some(e) = det.push(*x) {
                if i > n / 3 && i < 2 * n / 3 && e.freq > 0.0 {
                    freqs.push(e.freq);
                }
            }
        }
        freqs.sort_by(f32::total_cmp);
        let f = freqs[freqs.len() / 2];
        assert!((f - 523.25).abs() < 8.0, "expected about 523 Hz (C5), got {f}");
    }

    #[test]
    fn choir_sings_a_third_above_inside_the_notes() {
        let sr = 44_100u32;
        let n = sr as usize;
        let out = choir(n, sr, 0, false, &[2], &[Note { start: 0.2, end: 0.8, midi: 69.0 }], &[]);
        let mono: Vec<f32> = out.chunks(2).map(|c| c[0] + c[1]).collect();
        let mut det = PitchDetector::new(sr as f32);
        let mut freqs = Vec::new();
        for (i, x) in mono.iter().enumerate() {
            if let Some(e) = det.push(*x) {
                if i > n * 4 / 10 && i < n * 6 / 10 && e.freq > 0.0 {
                    freqs.push(e.freq);
                }
            }
        }
        freqs.sort_by(f32::total_cmp);
        let f = freqs[freqs.len() / 2];
        assert!((f - 523.25).abs() < 10.0, "expected about 523 Hz (C5), got {f}");
        let quiet = |a: usize, b: usize| mono[a..b].iter().all(|x| x.abs() < 1e-6);
        assert!(quiet(0, n / 10) && quiet(n * 97 / 100, n), "silent outside the note");
        assert!(mono.iter().all(|x| x.abs() < 1.0), "no clipping");
    }

    /// C major, melody E: a third above is G (the scale's); over an E major
    /// chord it is G# (the chord's). A held chord note stays.
    #[test]
    fn harmony_follows_the_chord() {
        let sc = scale::scale(MAJOR);
        let e = |start: f32| Note { start, end: start + 0.4, midi: 64.0 };
        assert_eq!(plan(&[e(0.0)], 2, 0, sc, &[]), vec![67]);
        let e_major = [Chord { start: 0.0, end: 2.0, root: 4, minor: false }];
        assert_eq!(plan(&[e(0.0)], 2, 0, sc, &e_major), vec![68]);
        // Over C major, melody E then D: G, then G again (held), not F.
        let c = [Chord { start: 0.0, end: 2.0, root: 0, minor: false }];
        let d = Note { start: 0.5, end: 0.9, midi: 62.0 };
        assert_eq!(plan(&[e(0.0), d], 2, 0, sc, &c), vec![67, 67]);
        // Below: melody G over C major, a third below is E.
        assert_eq!(plan(&[Note { start: 0.0, end: 0.4, midi: 67.0 }], -2, 0, sc, &c), vec![64]);
        // An octave is an octave, whatever the chord.
        assert_eq!(plan(&[e(0.0)], 7, 0, sc, &e_major), vec![76]);
    }

    /// The polish keeps the length, takes out the low end, and leaves a
    /// tail after a sound stops (the room).
    #[test]
    fn polish_cuts_lows_and_adds_a_room() {
        let sr = 44_100u32;
        let n = sr as usize;
        let tone = |f: f32| -> Vec<f32> {
            (0..n).flat_map(|i| {
                let t = i as f32 / sr as f32;
                let s = if t < 0.5 { 0.3 * (std::f32::consts::TAU * f * t).sin() } else { 0.0 };
                [s, s]
            }).collect()
        };
        let rms = |b: &[f32], a: f32, z: f32| {
            let (a, z) = ((a * sr as f32) as usize * 2, (z * sr as f32) as usize * 2);
            (b[a..z].iter().map(|x| x * x).sum::<f32>() / (z - a) as f32).sqrt()
        };
        let low = polish(&tone(60.0), sr, false);
        let mid = polish(&tone(500.0), sr, true);
        assert_eq!(mid.len(), n * 2);
        assert!(rms(&low, 0.2, 0.45) < 0.35 * rms(&mid, 0.2, 0.45), "low {} mid {}", rms(&low, 0.2, 0.45), rms(&mid, 0.2, 0.45));
        assert!(rms(&mid, 0.6, 0.8) > 1e-3, "no tail: {}", rms(&mid, 0.6, 0.8));
        assert!(mid.iter().all(|x| x.abs() < 1.0));
    }

    #[test]
    fn nothing_to_harmonise_is_silence() {
        let out = harmony(&vec![0.0; 44_100 * 2], 44_100, 0, false, &[2], &[], &[]);
        assert!(out.iter().all(|x| x.abs() < 1e-6));
        assert!(harmony(&vec![0.1; 200], 44_100, 0, false, &[], &[], &[]).iter().all(|x| *x == 0.0));
    }
}

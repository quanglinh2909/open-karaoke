export const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** Must stay in the same order as `SCALES` in src-tauri/src/audio/scale.rs. */
export const SCALES: { name: string; steps: number[] }[] = [
  { name: "Nửa cung", steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { name: "Trưởng", steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: "Thứ", steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: "Thứ hòa âm", steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: "Thứ giai điệu", steps: [0, 2, 3, 5, 7, 9, 11] },
  { name: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: "Phrygian", steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: "Lydian", steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: "Ngũ cung trưởng", steps: [0, 2, 4, 7, 9] },
  { name: "Ngũ cung thứ", steps: [0, 3, 5, 7, 10] },
  { name: "Blues", steps: [0, 3, 5, 6, 7, 10] },
];

export const SCALE_MAJOR = 1;
export const SCALE_MINOR = 2;

/** Diatonic harmony intervals understood by the engine (scale degrees, ±7 = octave). */
export const HARMONIES: { label: string; value: number }[] = [
  { label: "Tắt", value: 0 },
  { label: "Quãng 3 trên", value: 2 },
  { label: "Quãng 4 trên", value: 3 },
  { label: "Quãng 5 trên", value: 4 },
  { label: "Quãng 6 trên", value: 5 },
  { label: "Quãng 8 trên", value: 7 },
  { label: "Quãng 3 dưới", value: -2 },
  { label: "Quãng 4 dưới", value: -3 },
  { label: "Quãng 5 dưới", value: -4 },
  { label: "Quãng 6 dưới", value: -5 },
  { label: "Quãng 8 dưới", value: -7 },
];

export const mod12 = (n: number) => ((n % 12) + 12) % 12;

export function noteName(midi: number, withOctave = true): string {
  const n = Math.round(midi);
  return NOTE_NAMES[mod12(n)] + (withOctave ? String(Math.floor(n / 12) - 1) : "");
}

export function keyName(tonic: number, scale: number): string {
  const s = SCALES[scale]?.name ?? "";
  return `${NOTE_NAMES[mod12(tonic)]} ${s.toLowerCase()}`;
}

export function inScale(midi: number, tonic: number, scale: number): boolean {
  return (SCALES[scale]?.steps ?? []).includes(mod12(midi - tonic));
}

export function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

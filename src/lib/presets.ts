export type Params = Record<string, number>;

/** Mirrors the defaults in src-tauri/src/audio/params.rs. */
export const DEFAULT_PARAMS: Params = {
  tune_enabled: 1,
  tune_key: 0,
  tune_scale: 1,
  tune_retune_ms: 40,
  tune_amount: 1,
  tune_humanize: 0.3,
  tune_flex: 0,
  tune_vibrato_depth: 0,
  tune_vibrato_rate: 5.5,
  tune_transpose: 0,
  tune_formant: 0,
  tune_mix: 1,
  tune_sensitivity: 0.8,
  harmony_a: 0,
  harmony_b: 0,
  harmony_level: 0.5,
  harmony_spread: 0.7,
  doubler: 0,
  // Off: a headset mic sings quietly, and a gate there cut soft words out.
  gate_db: -80,
  hpf_hz: 90,
  eq_low_db: 0,
  eq_presence_db: 2,
  eq_air_db: 2,
  deesser: 0.4,
  comp: 0.5,
  delay_mix: 0,
  delay_ms: 320,
  delay_feedback: 0.3,
  reverb_mix: 0.18,
  reverb_size: 0.7,
  reverb_damp: 0.4,
  vocal_gain_db: 0,
  master: 0.9,
  instrumental: 0.85,
  guide: 0,
  backing: 0.35,
  lead: 0.85,
  vocal: 0.9,
  monitor: 1,
  mic: 1,
  record_latency_ms: -1,
  drone: 0,
};

/** Parameters that make up a user's "sound" (saved in My presets). */
export const SOUND_KEYS = Object.keys(DEFAULT_PARAMS).filter(
  (k) => (k.startsWith("tune_") || k.startsWith("harmony_") || k === "doubler" || k.startsWith("gate_") || k.startsWith("hpf_") ||
    k.startsWith("eq_") || k === "deesser" || k === "comp" || k.startsWith("delay_") || k.startsWith("reverb_") || k === "vocal_gain_db") &&
    k !== "tune_key" && k !== "tune_scale",
);

export interface Preset {
  name: string;
  hint: string;
  values: Params;
}

export const TUNE_PRESETS: Preset[] = [
  {
    name: "Tự nhiên",
    hint: "Chỉnh nhẹ, trong trẻo",
    values: { tune_enabled: 1, tune_retune_ms: 90, tune_humanize: 0.6, tune_flex: 25, tune_amount: 0.85, tune_vibrato_depth: 0, harmony_a: 0, harmony_b: 0, doubler: 0, tune_formant: 0 },
  },
  {
    name: "Pop bóng bẩy",
    hint: "Chuẩn radio mà vẫn tự nhiên",
    values: { tune_enabled: 1, tune_retune_ms: 35, tune_humanize: 0.35, tune_flex: 8, tune_amount: 1, tune_vibrato_depth: 0, harmony_a: 0, harmony_b: 0, doubler: 0.25, tune_formant: 0 },
  },
  {
    name: "Autotune mạnh",
    hint: "Kiểu giọng robot kinh điển",
    values: { tune_enabled: 1, tune_retune_ms: 0, tune_humanize: 0, tune_flex: 0, tune_amount: 1, tune_vibrato_depth: 0, harmony_a: 0, harmony_b: 0, doubler: 0, tune_formant: 0 },
  },
  {
    name: "Hợp xướng",
    hint: "Nhiều bè hòa âm theo tông",
    values: { tune_enabled: 1, tune_retune_ms: 25, tune_humanize: 0.3, tune_flex: 0, tune_amount: 1, harmony_a: 2, harmony_b: -3, harmony_level: 0.55, harmony_spread: 0.9, doubler: 0.35, tune_formant: 0 },
  },
  {
    name: "Diva",
    hint: "Mượt, rung giọng dày",
    values: { tune_enabled: 1, tune_retune_ms: 30, tune_humanize: 0.5, tune_flex: 0, tune_amount: 1, tune_vibrato_depth: 35, tune_vibrato_rate: 5.6, harmony_a: 0, harmony_b: 0, doubler: 0.15, tune_formant: 0 },
  },
  {
    name: "Sóc chuột",
    hint: "Lên một quãng tám, giọng nhỏ xíu",
    values: { tune_enabled: 1, tune_retune_ms: 10, tune_transpose: 12, tune_formant: 7, harmony_a: 0, harmony_b: 0, doubler: 0 },
  },
  {
    name: "Quái vật",
    hint: "Trầm và khàn",
    values: { tune_enabled: 1, tune_retune_ms: 10, tune_transpose: -10, tune_formant: -6, harmony_a: 0, harmony_b: 0, doubler: 0.2 },
  },
];

export const FX_PRESETS: Preset[] = [
  {
    name: "Giọng thật",
    hint: "Không hiệu ứng nào: nghe đúng giọng của bạn",
    values: { reverb_mix: 0, delay_mix: 0, comp: 0, deesser: 0, eq_low_db: 0, eq_presence_db: 0, eq_air_db: 0 },
  },
  {
    name: "Mộc",
    hint: "Chỉ giọng của bạn",
    values: { reverb_mix: 0, delay_mix: 0, comp: 0.3, eq_presence_db: 0, eq_air_db: 0, deesser: 0.2 },
  },
  {
    name: "Phòng thu",
    hint: "Giọng chỉn chu như phòng thu",
    values: { reverb_mix: 0.14, reverb_size: 0.55, reverb_damp: 0.5, delay_mix: 0, comp: 0.55, eq_low_db: -1, eq_presence_db: 2.5, eq_air_db: 3, deesser: 0.45 },
  },
  {
    name: "Sân vận động",
    hint: "Hội trường lớn, có tiếng dội",
    values: { reverb_mix: 0.32, reverb_size: 0.92, reverb_damp: 0.3, delay_mix: 0.18, delay_ms: 380, delay_feedback: 0.35, comp: 0.6, eq_presence_db: 3, eq_air_db: 3.5, deesser: 0.5 },
  },
  {
    name: "Vọng club",
    hint: "Tiếng vọng qua lại theo nhịp",
    values: { reverb_mix: 0.16, reverb_size: 0.6, delay_mix: 0.32, delay_ms: 250, delay_feedback: 0.45, comp: 0.6, eq_presence_db: 2, eq_air_db: 2 },
  },
  {
    name: "Radio",
    hint: "Mỏng và gọn",
    values: { reverb_mix: 0.05, delay_mix: 0, comp: 0.9, hpf_hz: 300, eq_low_db: -6, eq_presence_db: 6, eq_air_db: -4, deesser: 0.3 },
  },
];

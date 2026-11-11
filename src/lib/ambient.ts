/*
 * The export's "plain" background, made a little more alive: soft lights in
 * the app's colours drifting slowly, bokeh motes rising, a vignette. Every
 * motion repeats exactly every `AMBIENT_PERIOD` seconds, so on Linux a single
 * period is rendered once (small, it's all soft) and ffmpeg loops it.
 */

/** Seconds after which the background repeats exactly. */
export const AMBIENT_PERIOD = 20;

const TAU = Math.PI * 2;

/** Lights: colour, path (centre, radius of travel, whole turns per period), size. */
const LIGHTS = [
  { c: [255, 61, 127], a: 0.32, cx: 0.3, cy: 0.35, rx: 0.18, ry: 0.12, fx: 1, fy: 2, ph: 0.0, r: 0.55 },
  { c: [138, 70, 255], a: 0.3, cx: 0.72, cy: 0.4, rx: 0.16, ry: 0.15, fx: 2, fy: 1, ph: 1.7, r: 0.6 },
  { c: [40, 130, 255], a: 0.22, cx: 0.55, cy: 0.78, rx: 0.22, ry: 0.08, fx: 1, fy: 1, ph: 3.1, r: 0.5 },
  { c: [255, 120, 60], a: 0.12, cx: 0.2, cy: 0.8, rx: 0.1, ry: 0.1, fx: 1, fy: 3, ph: 4.4, r: 0.4 },
] as const;

/** Bokeh motes, fixed by a seed so every render is the same. */
const MOTES = (() => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: 26 }, () => ({
    x: rnd(),
    y: rnd(),
    // Whole trips up the frame per period, so it loops.
    trips: 1 + Math.floor(rnd() * 2),
    sway: 0.01 + rnd() * 0.025,
    size: 0.004 + rnd() ** 2 * 0.018,
    hue: rnd() < 0.5 ? [255, 160, 205] : rnd() < 0.5 ? [180, 150, 255] : [150, 205, 255],
    twinkle: 1 + Math.floor(rnd() * 3),
    ph: rnd() * TAU,
    a: 0.25 + rnd() * 0.45,
  }));
})();

/** Paint the background at `t` seconds onto the whole of `ctx` (`W`×`H`). */
export function paintAmbient(ctx: OffscreenCanvasRenderingContext2D, W: number, H: number, t: number) {
  const u = (((t % AMBIENT_PERIOD) + AMBIENT_PERIOD) % AMBIENT_PERIOD) / AMBIENT_PERIOD;
  const S = Math.max(W, H);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, "#160d22");
  base.addColorStop(1, "#07060c");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // Lights, added together where they meet.
  ctx.globalCompositeOperation = "lighter";
  for (const l of LIGHTS) {
    const x = (l.cx + l.rx * Math.sin(TAU * l.fx * u + l.ph)) * W;
    const y = (l.cy + l.ry * Math.cos(TAU * l.fy * u + l.ph)) * H;
    const breathe = 1 + 0.12 * Math.sin(TAU * 2 * u + l.ph);
    const r = l.r * S * breathe;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const [cr, cg, cb] = l.c;
    g.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${l.a})`);
    g.addColorStop(0.45, `rgba(${cr}, ${cg}, ${cb}, ${l.a * 0.35})`);
    g.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Motes rising, swaying and twinkling.
  for (const m of MOTES) {
    const y = (((m.y - m.trips * u) % 1) + 1) % 1;
    const x = m.x + m.sway * Math.sin(TAU * 2 * u + m.ph);
    const r = m.size * S;
    const a = m.a * (0.55 + 0.45 * Math.sin(TAU * m.twinkle * u + m.ph));
    const px = x * W;
    const py = y * (H + 4 * r) - 2 * r;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    const [cr, cg, cb] = m.hue;
    g.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${a})`);
    g.addColorStop(0.6, `rgba(${cr}, ${cg}, ${cb}, ${a * 0.45})`);
    g.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
  }

  // Vignette: the corners fall away, the middle (the lyrics) stays calm.
  ctx.globalCompositeOperation = "source-over";
  const v = ctx.createRadialGradient(W / 2, H / 2, S * 0.2, W / 2, H / 2, S * 0.75);
  v.addColorStop(0, "rgba(5, 4, 9, 0.15)");
  v.addColorStop(1, "rgba(5, 4, 9, 0.8)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

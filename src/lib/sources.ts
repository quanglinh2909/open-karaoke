import type { SongMeta, Video } from "./api";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Core title words, ignoring "(feat. …)" / "- Remastered" style decorations. */
function titleWords(title: string): string[] {
  const core = title.replace(/\s[-–—]\s.*$/, "").replace(/[([].*?[)\]]/g, "");
  return norm(core)
    .split(" ")
    .filter((w) => w.length > 1);
}

function hasAny(text: string, words: string[]) {
  return words.some((w) => text.includes(w));
}

// Versions that are not the song as recorded.
const ALTERED = ["slowed", "sped up", "speed up", "nightcore", "8d", "reverb", "remix", "bass boosted", "lofi", "lo fi", "mashup", "1 hour", "loop", "tiktok", "chipmunk"];
const PERFORMED = ["cover", "live", "piano", "guitar", "acoustic", "orchestra", "violin", "cello", "ukulele", "drum", "tutorial", "lesson", "how to", "reaction", "music box", "marimba", "8 bit", "8bit"];

export interface Ranked {
  video: Video;
  score: number;
}

function common(v: Video, song: SongMeta) {
  const t = norm(v.title);
  const songTitle = norm(song.title);
  const words = titleWords(song.title);
  const matched = words.filter((w) => t.includes(w)).length / Math.max(1, words.length);
  let score = matched * 40;
  if (hasAny(t, norm(song.artist).split(" ").filter((w) => w.length > 2))) score += 10;
  for (const w of ALTERED) if (t.includes(w) && !songTitle.includes(w)) score -= 60;
  for (const w of PERFORMED) if (t.includes(w) && !songTitle.includes(w)) score -= 35;
  if (v.duration && song.duration > 0) {
    const d = Math.abs(v.duration - song.duration);
    score -= d < 4 ? 0 : d < 15 ? (d - 4) * 1.5 : d < 40 ? 16 + (d - 15) * 2 : 80;
  }
  if (v.duration && v.duration > 15 * 60) score -= 100;
  return { t, score };
}

export function rankOriginals(videos: Video[], song: SongMeta): Ranked[] {
  return dedupe(videos)
    .map((video) => {
      let { t, score } = common(video, song);
      if (t.includes("official audio")) score += 25;
      else if (t.includes("official")) score += 10;
      if (t.includes("audio")) score += 5;
      // The AI needs the real vocal mix, and lyrics are timed to the original.
      if (hasAny(t, ["instrumental", "karaoke", "backing track", "no vocals", "acapella", "a cappella"])) score -= 80;
      if (t.includes("lyrics") || t.includes("lyric video")) score += 3; // usually the exact album audio
      if (t.includes("music video")) score -= 5; // videos often have intros/outros
      return { video, score };
    })
    .sort((a, b) => b.score - a.score);
}

function dedupe(videos: Video[]): Video[] {
  const seen = new Set<string>();
  return videos.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
}

/** Bracketed extras in video titles: (Official MV), [Lyrics], 【MV】… */
const BRACKETS = /\s*[([【［].*?[)\]】］]\s*/g;
const TAGS = /\b(official\s+(music\s+)?(video|audio|mv)|lyrics?\s*video|lyrics?|m\/?v|audio|karaoke|visualizer|4k|hd)\b/gi;

const clean = (s: string) =>
  s
    .replace(BRACKETS, " ")
    .replace(TAGS, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s|｜\-–—:]+|[\s|｜\-–—:]+$/g, "")
    .trim();

/** Words that describe performers rather than a song title. */
const PERFORMERS = /(?<![\p{L}\p{N}])(cover|ft\.?|feat\.?|x|đổi hit|song ca|với|live)(?![\p{L}\p{N}])|&/iu;

const cleanChannel = (c: string) =>
  c
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*(Official|Channel)$/i, "")
    .trim();

/** Whether a title part names the channel's artist ("SƠN TÙNG M-TP" on "Sơn Tùng M-TP Official"). */
function namesChannel(part: string, channel: string): boolean {
  const a = norm(part).replace(/ /g, "");
  const b = norm(channel).replace(/ /g, "");
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
}

/**
 * A song from a YouTube search result. Titles come as "Artist - Title (…)",
 * "Title | Artist | Official MV" or "Artist | Title | …"; the part that
 * matches the channel name is the artist, and failing a split the channel
 * is. The title and artist are what lyrics are looked up by.
 */
export function songFromVideo(v: Video): SongMeta {
  const channel = cleanChannel(v.channel);
  // "… | FOREST STUDIO": a trailing part that only names the channel says nothing.
  const kept = v.title.split(/\s*[|｜]\s*/);
  while (kept.length > 1 && namesChannel(kept[kept.length - 1], channel)) kept.pop();
  const full = kept.join(" | ");
  let title = full;
  let artist = channel;
  const dash = full.split(/\s+[-–—]\s+/);
  const bar = full.split(/\s*[|｜]\s*/).filter((p) => clean(p));
  const parts = dash.length >= 2 ? [dash[0], dash.slice(1).join(" - ")] : bar.length >= 2 ? bar.slice(0, 2) : null;
  if (parts) {
    // Usual order: "Artist - Title", but "Title | Artist".
    let [who, what] = dash.length >= 2 ? parts : [parts[1], parts[0]];
    if (namesChannel(what, channel) && !namesChannel(who, channel)) [who, what] = [what, who];
    // "Title - A đổi hit với B", "Title - A x B", "Title - A cover": the
    // part describing who sings is the artist.
    else if (PERFORMERS.test(what) && !PERFORMERS.test(who) && !namesChannel(who, channel)) [who, what] = [what, who];
    artist = clean(who) || channel;
    title = what;
  }
  return {
    id: v.id,
    title: clean(title) || full,
    artist,
    album: "",
    duration: v.duration ?? 0,
    artwork: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    year: null,
    explicit: false,
    video: v,
  };
}

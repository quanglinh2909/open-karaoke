import { lyricsText } from "./loader";
import { useStore } from "./store";
import type { LyricStyle, Orientation } from "./videoExport";

/**
 * A request to paste into Gemini (or any image AI) for a karaoke background
 * that fits the open song: its title, artist and lyrics (the AI picks the
 * image from them), the video's shape, and room left where the lyrics go.
 */
export function geminiPrompt(orientation: Orientation, style: LyricStyle): string {
  const song = useStore.getState().song;
  const title = song?.meta.title ?? "";
  const artist = song?.meta.artist ?? "";
  // Each line once (choruses repeat): enough for the mood, shorter to paste.
  const seen = new Set<string>();
  const lyrics = lyricsText()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[♪\s]+$/.test(l) && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()))
    .join("\n");
  const shape = orientation === "portrait" ? "dọc 9:16 (cho điện thoại)" : "ngang 16:9";
  // Where the lyrics will be, as the export lays them out (lyricDraw.ts).
  const where =
    style === "scroll"
      ? "Lời bài hát chạy thành 3–4 dòng chữ lớn ở GIỮA ảnh, căn giữa, chiếm dải từ khoảng 1/3 đến 4/5 chiều cao"
      : style === "classic"
        ? "Lời bài hát là 2 dòng chữ lớn ở PHẦN DƯỚI ảnh (khoảng 1/3 dưới cùng), dòng trên lệch trái, dòng dưới lệch phải"
        : "Lời bài hát là 1–2 dòng chữ ở SÁT ĐÁY ảnh (khoảng 1/5 dưới cùng), căn giữa";
  return [
    `Đây là lời bài hát "${title}"${artist ? ` của ${artist}` : ""}:`,
    "",
    lyrics || "(chưa có lời: hãy dựa vào tên bài và ca sĩ)",
    "",
    `Hãy đọc lời, chọn MỘT hình ảnh thể hiện đúng cảm xúc và câu chuyện của bài, rồi tạo ảnh nền ${shape} cho video karaoke.`,
    "",
    "Ảnh sẽ có chữ đè lên, nên bố cục phải chừa chỗ cho chữ:",
    `- ${where}.`,
    "- Vài giây đầu video, tên bài hát hiện bằng chữ rất lớn ở CHÍNH GIỮA ảnh.",
    "- Chữ màu trắng, viền tối, tô dần màu hồng khi hát.",
    "",
    "Yêu cầu:",
    "- Đặt người hoặc vật chính ở NỬA TRÊN hoặc sát HAI BÊN MÉP ảnh, không đặt ở giữa hay ở vùng có chữ.",
    "- Vùng có chữ phải đơn giản, ít chi tiết, tối vừa phải (bầu trời đêm, mặt đường, mặt nước, bokeh mờ…), không có mảng trắng hoặc hồng sáng, để chữ trắng nổi rõ.",
    "- Phong cách điện ảnh, ánh sáng đẹp, màu sắc hợp tâm trạng bài hát, chiều sâu rõ (hậu cảnh hơi mờ).",
    "- Tuyệt đối không có chữ, không logo, không chữ ký, không khung viền; không có người nhìn rõ mặt.",
    "- Độ phân giải cao, chi tiết rõ nét.",
    "",
    "Trước khi tạo ảnh, ghi ngắn gọn bạn chọn hình ảnh gì, đặt chủ thể ở đâu và vì sao.",
  ].join("\n");
}

/** Put `text` on the clipboard (with a fallback where the async API is missing). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall back below */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Không chép được vào bộ nhớ tạm");
}

// Nelson's Inbox reply as email-safe HTML: escaped, line breaks kept.
export function replyBodyHtml(body: string): string {
  return String(body ?? "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
    .replace(/\r?\n/g, "<br>");
}

const SERVICE: Record<string, string> = {
  music_video: "music video", brand_content: "brand content", photography: "photography", event: "event",
};
// Instant-book sessions (headshots, digitals, birthday, studio) read as a "session"; custom work as a "project"
const SESSIONS = /headshot|digital|birthday|studio/i;
export function studioReplySubject(title: string | null, service: string): string {
  const fromTitle = title?.includes(" — ") ? title.split(" — ").slice(1).join(" — ").trim() : "";
  const what = (fromTitle || SERVICE[service] || "").toLowerCase().replace(/^other$/, "");
  if (!what) return "Nelson at Taylormade · your project";
  return `Nelson at Taylormade · your ${what} ${SESSIONS.test(what) ? "session" : "project"}`;
}


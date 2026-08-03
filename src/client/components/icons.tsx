import type { CSSProperties } from "react";

const PATHS: Record<string, string> = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  split: "M6 3v7.5A2.5 2.5 0 106.5 15H8v6h2V3zm12 0v7.5A2.5 2.5 0 0017.5 15H16v6h-2V3z",
  trash: "M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z",
  duplicate: "M8 8h10v12H8zM6 4h10v2H6v10H4V4z",
  undo: "M12 5V1L7 6l5 5V7a6 6 0 11-6 6H4a8 8 0 108-8z",
  redo: "M12 5V1l5 5-5 5V7a6 6 0 106 6h2a8 8 0 11-8-8z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  minus: "M5 11h14v2H5z",
  lock: "M6 10V8a6 6 0 1112 0v2h1v11H5V10h1zm2 0h8V8a4 4 0 10-8 0v2z",
  unlock: "M6 10V8a6 6 0 0111.7-2H15.5A4 4 0 008 8v2h11v11H5V10h1z",
  volume: "M4 9v6h4l5 5V4L8 9H4zm12.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z",
  mute: "M4 9v6h4l5 5V4L8 9H4zm15 3l2-2-1.4-1.4-2 2-2-2L17.2 12l-2 2 1.4 1.4 2-2 2 2 1.4-1.4z",
  video: "M4 5h11v14H4zm13 4l4-3v11l-4-3z",
  image: "M4 5h16v14H4zm2 10l4-4 3 3 3-4 3 5H6z",
  audio: "M9 3v10.5A3.5 3.5 0 1011 17V7h6V3z",
  text: "M5 5h14v3h-2V7h-4v10h2v2H9v-2h2V7H7v1H5z",
  upload: "M12 3l5 5h-3v6h-4V8H7l5-5zM5 18h14v2H5z",
  save: "M5 3h11l3 3v15H5zM7 5v5h8V5zm2 9h6v5H9z",
  close: "M6 6l12 12M18 6L6 18",
  drag: "M8 6h2v2H8zm0 5h2v2H8zm0 5h2v2H8zm6-10h2v2h-2zm0 5h2v2h-2zm0 5h2v2h-2z",
};

export function Icon({ name, size = 16, style }: { name: string; size?: number; style?: CSSProperties }) {
  const stroked = name === "close";
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={style} focusable="false">
      <path d={PATHS[name] ?? ""} fill={stroked ? "none" : "currentColor"} stroke={stroked ? "currentColor" : "none"} strokeWidth={stroked ? 2 : 0} strokeLinecap="round" />
    </svg>
  );
}

export function kindIcon(kind: string): string {
  if (kind === "video") return "video";
  if (kind === "overlay" || kind === "image") return "image";
  if (kind === "audio") return "audio";
  if (kind === "caption") return "text";
  return "video";
}

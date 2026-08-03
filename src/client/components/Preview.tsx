import { useEffect, useRef, type CSSProperties } from "react";
import type { Clip, TimelineDoc } from "../state/types.js";
import { Icon } from "./icons.js";

/*
 * WYSIWYG preview, synchronized to the timeline playhead. It composites the document live:
 * the master clock is the editor playhead, and each active video/audio element is kept in
 * sync (hard seek when scrubbing/paused, drift-correct when playing). Overlays and captions
 * are positioned by their transforms in composition space, so every edit (trim, move, text,
 * transform) is reflected on the next frame. No placeholder is shown when real media exists.
 */

interface TransportProps {
  playing: boolean;
  volume: number;
  muted: boolean;
  fit: "contain" | "cover";
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onToggleFit: () => void;
}

interface PreviewLayerSpec {
  track: TimelineDoc["tracks"][number];
  clip: Clip;
  active: boolean;
  renderAs: "video" | "image" | "caption" | "audio";
}

/** Project the preview in exact document track order, which is also the final-master stacking
 * order. Video elements remain mounted while inactive for responsive seeking; still images and
 * captions only exist during their clip range. Overlay tracks may contain either image or video
 * media and must choose the matching browser element. */
export function previewLayerSpecs(doc: TimelineDoc, playhead: number, mediaKinds: ReadonlyMap<string, "video" | "audio" | "image" | "other">): PreviewLayerSpec[] {
  const out: PreviewLayerSpec[] = [];
  for (const track of doc.tracks) {
    for (const clip of doc.clips.filter((c) => c.trackId === track.id)) {
      const active = isActive(clip, playhead);
      if (track.kind === "caption") {
        if (active) out.push({ track, clip, active, renderAs: "caption" });
      } else if (track.kind === "audio") {
        out.push({ track, clip, active, renderAs: "audio" });
      } else if (track.kind === "video") {
        out.push({ track, clip, active, renderAs: "video" });
      } else {
        const kind = clip.mediaId ? mediaKinds.get(clip.mediaId) : undefined;
        if (kind === "video") out.push({ track, clip, active, renderAs: "video" });
        else if (active) out.push({ track, clip, active, renderAs: "image" });
      }
    }
  }
  return out;
}

export function Preview({
  doc,
  playhead,
  mediaUrls,
  mediaKinds,
  transport,
}: {
  doc: TimelineDoc;
  playhead: number;
  mediaUrls: Map<string, string>;
  mediaKinds: ReadonlyMap<string, "video" | "audio" | "image" | "other">;
  transport: TransportProps;
}) {
  const compW = doc.width;
  const compH = doc.height;
  const layers = previewLayerSpecs(doc, playhead, mediaKinds);
  const hasAnyMedia = doc.clips.some((c) => c.mediaId);

  const frame = Math.round(playhead * doc.fps);
  const totalFrames = Math.round(doc.duration * doc.fps);

  return (
    <div className="preview">
      <div className="preview-stage">
        <div className="stage-frame" style={{ ["--ar" as string]: compW / compH, background: doc.meta.brand.paper } as CSSProperties}>
          {layers.map(({ track, clip, active, renderAs }) => {
            const url = clip.mediaId ? mediaUrls.get(clip.mediaId) : undefined;
            if (renderAs === "video") {
              // Overlay-video audio is intentionally muted because final timeline audio only
              // includes video and audio tracks. This keeps preview and final mix consistent.
              const layerMuted = transport.muted || track.muted || track.kind === "overlay";
              return <VideoLayer key={clip.id} clip={clip} url={url} active={active} playhead={playhead} playing={transport.playing} muted={layerMuted} masterVolume={transport.volume} fit={transport.fit} compW={compW} compH={compH} />;
            }
            if (renderAs === "image") return <ImageLayer key={clip.id} clip={clip} url={url} active={active} compW={compW} compH={compH} fit={transport.fit} />;
            if (renderAs === "caption") return <CaptionLayer key={clip.id} clip={clip} compW={compW} />;
            return <AudioLayer key={clip.id} clip={clip} url={url} active={active} playhead={playhead} playing={transport.playing} muted={transport.muted || track.muted} masterVolume={transport.volume} />;
          })}

          {!hasAnyMedia && doc.clips.length === 0 ? <div className="preview-empty">Import media, then drop it on the timeline to build your edit.</div> : null}
        </div>
      </div>

      <div className="transport">
        <button className="icon-btn play" aria-label={transport.playing ? "Pause" : "Play"} onClick={transport.onTogglePlay}>
          <Icon name={transport.playing ? "pause" : "play"} size={20} />
        </button>
        <span className="time-readout" aria-live="off">
          {fmtTime(playhead)} <span className="muted">/ {fmtTime(doc.duration)}</span>
        </span>
        <span className="frame-readout muted">
          frame {frame} / {totalFrames}
        </span>
        <input className="scrubber" type="range" min={0} max={doc.duration} step={1 / doc.fps} value={Math.min(playhead, doc.duration)} onChange={(e) => transport.onSeek(parseFloat(e.target.value))} aria-label="Seek" />
        <button className={`icon-btn${transport.muted ? " on" : ""}`} aria-label={transport.muted ? "Unmute" : "Mute"} onClick={transport.onToggleMute}>
          <Icon name={transport.muted ? "mute" : "volume"} size={16} />
        </button>
        <input className="vol" type="range" min={0} max={1} step={0.02} value={transport.volume} onChange={(e) => transport.onVolume(parseFloat(e.target.value))} aria-label="Volume" />
        <button className="btn ghost xs" onClick={transport.onToggleFit} title="Fit mode">
          {transport.fit}
        </button>
      </div>
    </div>
  );
}

function isActive(clip: Clip, t: number): boolean {
  return t >= clip.start - 1e-4 && t < clip.start + clip.duration - 1e-4;
}

function layerStyle(clip: Clip, compW: number, compH: number): CSSProperties {
  const tx = (clip.transform.x / compW) * 100;
  const ty = (clip.transform.y / compH) * 100;
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: `translate(-50%, -50%) translate(${tx}%, ${ty}%) scale(${clip.transform.scale}) rotate(${clip.transform.rotation}deg)`,
    opacity: clip.transform.opacity,
  };
}

function VideoLayer({ clip, url, active, playhead, playing, muted, masterVolume, fit, compW, compH }: { clip: Clip; url?: string; active: boolean; playhead: number; playing: boolean; muted: boolean; masterVolume: number; fit: "contain" | "cover"; compW: number; compH: number }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = muted;
    v.volume = Math.max(0, Math.min(1, masterVolume * clip.volume));
  }, [muted, masterVolume, clip.volume]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active && playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [active, playing]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !active) return;
    const desired = clip.sourceIn + (playhead - clip.start);
    if (desired < 0) return;
    if (!playing) {
      try {
        v.currentTime = desired;
      } catch {
        /* not seekable yet */
      }
    } else if (Math.abs(v.currentTime - desired) > 0.35) {
      try {
        v.currentTime = desired;
      } catch {
        /* ignore */
      }
    }
  }, [playhead, active, playing, clip.sourceIn, clip.start]);

  const base = layerStyle(clip, compW, compH);
  const style: CSSProperties = { ...base, width: "100%", height: "100%", objectFit: fit, display: active ? "block" : "none" };
  return <video ref={ref} src={url} className="pv-layer pv-video" style={style} playsInline preload="auto" />;
}

function ImageLayer({ clip, url, active, compW, compH, fit }: { clip: Clip; url?: string; active: boolean; compW: number; compH: number; fit: "contain" | "cover" }) {
  if (!active || !url) return null;
  const style: CSSProperties = { ...layerStyle(clip, compW, compH), maxWidth: "100%", maxHeight: "100%", objectFit: fit };
  return <img className="pv-layer pv-image" src={url} style={style} alt={clip.name} draggable={false} />;
}

function CaptionLayer({ clip, compW }: { clip: Clip; compW: number }) {
  const s = clip.captionStyle;
  const style: CSSProperties = {
    position: "absolute",
    left: "6%",
    right: "6%",
    bottom: "16%",
    textAlign: s?.align ?? "center",
    color: s?.color ?? "#fff",
    fontSize: `${((s?.fontSize ?? 54) / compW) * 100}cqw`,
    fontWeight: s?.bold ? 800 : 500,
    lineHeight: 1.15,
    textShadow: "0 2px 8px rgba(0,0,0,0.55)",
  };
  const inner: CSSProperties = s?.background ? { background: s.background, padding: "0.2em 0.5em", borderRadius: "0.2em", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } : {};
  return (
    <div className="pv-layer pv-caption" style={style}>
      <span style={inner}>{clip.text}</span>
    </div>
  );
}

function AudioLayer({ clip, url, active, playhead, playing, muted, masterVolume }: { clip: Clip; url?: string; active: boolean; playhead: number; playing: boolean; muted: boolean; masterVolume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.muted = muted;
    a.volume = Math.max(0, Math.min(1, masterVolume * clip.volume));
  }, [muted, masterVolume, clip.volume]);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (active && playing) void a.play().catch(() => undefined);
    else a.pause();
  }, [active, playing]);
  useEffect(() => {
    const a = ref.current;
    if (!a || !active) return;
    const desired = clip.sourceIn + (playhead - clip.start);
    if (desired < 0) return;
    if (!playing) {
      try {
        a.currentTime = desired;
      } catch {
        /* ignore */
      }
    } else if (Math.abs(a.currentTime - desired) > 0.35) {
      try {
        a.currentTime = desired;
      } catch {
        /* ignore */
      }
    }
  }, [playhead, active, playing, clip.sourceIn, clip.start]);
  if (!url) return null;
  return <audio ref={ref} src={url} preload="auto" />;
}

export function fmtTime(s: number): string {
  const sign = s < 0 ? "-" : "";
  const v = Math.abs(s);
  const m = Math.floor(v / 60);
  const sec = Math.floor(v % 60);
  const ms = Math.floor((v - Math.floor(v)) * 1000);
  return `${sign}${m}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

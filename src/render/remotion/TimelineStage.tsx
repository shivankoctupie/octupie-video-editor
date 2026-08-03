import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, staticFile, useVideoConfig } from "remotion";
import type { EditPlan, TimelineClipValue } from "../../schema/editPlan.js";
import { clipTransformCss, timelineRenderLayers } from "../media.js";

/**
 * Final-master stage for the editor timeline. When a plan carries a `timeline`, the deterministic
 * renderer composites the WHOLE document here, not just the first video track: every visible
 * track (video, overlay/image, caption) is painted in stacking order, and each clip is placed by
 * its timeline start and length with its per-clip transform (x/y offset, scale, rotation,
 * opacity) and caption styling. This mirrors the browser WYSIWYG preview so the delivered master
 * matches what the editor showed. Audio (clip volume, muted tracks, trims) is assembled
 * separately by the FFmpeg layer; the visual master is rendered muted, so there is no double
 * audio. Locked tracks still render: `locked` is an edit lock in the editor, not a hide toggle.
 */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

function src(mediaPath: string): string {
  return staticFile(mediaPath.replace(/\\/g, "/"));
}

/** Full-frame, centered layer host that applies the clip's transform in composition space. */
function TransformHost({ clip, compW, compH, children }: { clip: TimelineClipValue; compW: number; compH: number; children: React.ReactNode }): React.ReactElement {
  const t = clipTransformCss(clip.transform, compW, compH);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ position: "absolute", left: "50%", top: "50%", width: "100%", height: "100%", transform: t.transform, opacity: t.opacity }}>{children}</div>
    </AbsoluteFill>
  );
}

/** A real video clip, muted (audio is mixed by FFmpeg), trimmed to its source in-point. */
const VideoClip: React.FC<{ clip: TimelineClipValue; fps: number; compW: number; compH: number }> = ({ clip, fps, compW, compH }) => {
  if (!clip.mediaPath) return null;
  return (
    <TransformHost clip={clip} compW={compW} compH={compH}>
      <OffthreadVideo src={src(clip.mediaPath)} startFrom={Math.round(clip.sourceIn * fps)} muted style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </TransformHost>
  );
};

/** An overlay clip: an image by default, or a muted video when the media is a video file. */
const OverlayClip: React.FC<{ clip: TimelineClipValue; fps: number; compW: number; compH: number }> = ({ clip, fps, compW, compH }) => {
  if (!clip.mediaPath) return null;
  const isImage = IMAGE_EXT.test(clip.mediaPath);
  return (
    <TransformHost clip={clip} compW={compW} compH={compH}>
      {isImage ? (
        <Img src={src(clip.mediaPath)} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <OffthreadVideo src={src(clip.mediaPath)} startFrom={Math.round(clip.sourceIn * fps)} muted style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      )}
    </TransformHost>
  );
};

/** A caption clip, styled by its captionStyle (size, color, background plate, alignment, bold),
 * positioned in the lower safe band exactly as the preview does. */
const CaptionClip: React.FC<{ clip: TimelineClipValue }> = ({ clip }) => {
  const s = clip.captionStyle;
  const align = s?.align ?? "center";
  return (
    <div style={{ position: "absolute", left: "6%", right: "6%", bottom: "16%", textAlign: align, lineHeight: 1.15 }}>
      <span
        style={{
          color: s?.color ?? "#ffffff",
          fontSize: s?.fontSize ?? 54,
          fontWeight: s?.bold ? 800 : 500,
          textShadow: "0 2px 8px rgba(0,0,0,0.55)",
          ...(s?.background ? { background: s.background, padding: "0.2em 0.5em", borderRadius: "0.2em", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } : {}),
        }}
      >
        {clip.text}
      </span>
    </div>
  );
};

function renderClip(kind: string, clip: TimelineClipValue, fps: number, compW: number, compH: number): React.ReactNode {
  if (kind === "video") return <VideoClip clip={clip} fps={fps} compW={compW} compH={compH} />;
  if (kind === "overlay") return <OverlayClip clip={clip} fps={fps} compW={compW} compH={compH} />;
  if (kind === "caption") return <CaptionClip clip={clip} />;
  return null;
}

export const TimelineStage: React.FC<{ plan: EditPlan }> = ({ plan }) => {
  const { width, height, fps } = useVideoConfig();
  const layers = timelineRenderLayers(plan);
  return (
    <AbsoluteFill style={{ backgroundColor: plan.brand.paper }}>
      {layers.map((layer) =>
        layer.clips.map((clip) => (
          <Sequence key={clip.id} from={Math.round(clip.start * fps)} durationInFrames={Math.max(1, Math.round(clip.duration * fps))} name={`${layer.track.kind}:${clip.name || clip.id}`}>
            {renderClip(layer.track.kind, clip, fps, width, height)}
          </Sequence>
        )),
      )}
    </AbsoluteFill>
  );
};

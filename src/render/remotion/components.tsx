import React from "react";
import { Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import type { EditPlan, Scene, CaptionCard } from "../../schema/editPlan.js";
import { sceneMedia } from "../media.js";

/**
 * Original, reusable, frame-driven motion components. No external art, no stock
 * imagery: every visual is procedural (CSS gradients, SVG shapes, typography).
 * Motion is restrained, with a single signature easing and intentional
 * frame-zero content so the first frame is never a blank fade.
 */

const SIGNATURE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function ease(frame: number, inFrame: number, outFrame: number): number {
  return interpolate(frame, [inFrame, outFrame], [0, 1], {
    easing: Easing.bezier(...SIGNATURE),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/** Faint vertical columns, part of the Octupie grid language. Procedural. */
export const ColumnField: React.FC<{ color: string; spacing?: number; opacity?: number }> = ({
  color,
  spacing = 180,
  opacity = 0.06,
}) => {
  const { width, height } = useVideoConfig();
  const count = Math.floor(width / spacing);
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
      {Array.from({ length: count + 1 }, (_, i) => (
        <line
          key={i}
          x1={i * spacing}
          y1={0}
          x2={i * spacing}
          y2={height}
          stroke={color}
          strokeWidth={1}
          opacity={opacity}
        />
      ))}
    </svg>
  );
};

/** Procedural luminous backdrop. Present from frame 0; drifts subtly. */
export const ProceduralBackdrop: React.FC<{ paper: string; accent: string; paper2?: string }> = ({
  paper,
  accent,
  paper2,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const drift = Math.sin(t * 0.6) * 4;
  const glowX = 50 + Math.sin(t * 0.4) * 6;
  const glowY = 42 + Math.cos(t * 0.3) * 5;
  return (
    <div style={{ position: "absolute", inset: 0, background: paper2 ?? paper, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: `${-6 + drift}%`,
          background: `radial-gradient(60% 55% at ${glowX}% ${glowY}%, ${hexAlpha(accent, 0.18)} 0%, ${hexAlpha(accent, 0)} 70%)`,
        }}
      />
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${hexAlpha(paper, 0)} 40%, ${hexAlpha(paper, 0.35)} 100%)` }} />
    </div>
  );
};

/** Real footage or still media resolved from the configured public asset root. */
export const SceneAsset: React.FC<{ plan: EditPlan; scene: Scene }> = ({ plan, scene }) => {
  const media = sceneMedia(plan, scene);
  if (!media) return null;
  const src = staticFile(media.path.replace(/\\/g, "/"));
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: media.fit,
    display: "block",
  };
  if (/\.(png|jpe?g|webp|gif)$/i.test(media.path)) {
    return <Img src={src} style={style} />;
  }
  return (
    <OffthreadVideo
      src={src}
      startFrom={media.startFromFrames}
      muted={media.mute}
      style={style}
    />
  );
};

/** Safe-area inset wrapper. */
export const SafeArea: React.FC<{ inset: number; children: React.ReactNode }> = ({ inset, children }) => (
  <div style={{ position: "absolute", inset, display: "flex", flexDirection: "column", justifyContent: "center" }}>
    {children}
  </div>
);

/** Heading that reveals with a masked rise. Layout is reserved before reveal. */
export const RisingHeading: React.FC<{
  text: string;
  size: number;
  color: string;
  accent: string;
  emphasis?: string;
  font: string;
  delayFrames?: number;
}> = ({ text, size, color, accent, emphasis, font, delayFrames = 0 }) => {
  const frame = useCurrentFrame();
  const p = ease(frame, delayFrames, delayFrames + 14);
  const y = interpolate(p, [0, 1], [28, 0]);
  return (
    <div style={{ overflow: "hidden" }}>
      <h1
        style={{
          margin: 0,
          fontFamily: `${font}, system-ui, sans-serif`,
          fontSize: size,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color,
          transform: `translateY(${y}px)`,
          opacity: p,
          lineHeight: 1.02,
        }}
      >
        {renderEmphasis(text, emphasis, accent)}
      </h1>
    </div>
  );
};

function renderEmphasis(text: string, emphasis: string | undefined, accent: string): React.ReactNode {
  if (!emphasis || !text.includes(emphasis)) return text;
  const parts = text.split(emphasis);
  return (
    <>
      {parts[0]}
      <span style={{ color: accent, fontStyle: "italic" }}>{emphasis}</span>
      {parts.slice(1).join(emphasis)}
    </>
  );
}

/** Caption card with a restrained fade+lift. Static enough to read on onset. */
export const KineticCaption: React.FC<{
  card: CaptionCard;
  fps: number;
  bandY: number;
  size: number;
  color: string;
  emphasis: string;
  font: string;
  canvasWidth: number;
}> = ({ card, fps, bandY, size, color, emphasis, font, canvasWidth }) => {
  const frame = useCurrentFrame();
  const startF = card.start * fps;
  const endF = card.end * fps;
  if (frame < startF || frame > endF + 2) return null;
  const p = ease(frame, startF, startF + 4);
  return (
    <div
      style={{
        position: "absolute",
        top: bandY,
        left: 0,
        width: canvasWidth,
        textAlign: "center",
        transform: `translateY(${interpolate(p, [0, 1], [10, 0])}px)`,
        opacity: p,
      }}
    >
      <span
        style={{
          fontFamily: `${font}, system-ui, sans-serif`,
          fontSize: size,
          fontWeight: 800,
          color,
          textShadow: "0 2px 10px rgba(0,0,0,0.28)",
          padding: "0 24px",
        }}
      >
        {card.text}
      </span>
    </div>
  );
};

/** Logo lockup: procedural mark plus lowercase wordmark. No external asset. */
export const LogoLockup: React.FC<{ name: string; accent: string; ink: string; font: string }> = ({
  name,
  accent,
  ink,
  font,
}) => {
  const frame = useCurrentFrame();
  const p = ease(frame, 0, 16);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, opacity: p, transform: `scale(${interpolate(p, [0, 1], [0.96, 1])})` }}>
      <svg width={64} height={64} viewBox="0 0 64 64" aria-hidden>
        <rect x={6} y={6} width={52} height={52} rx={14} fill="none" stroke={accent} strokeWidth={4} />
        <circle cx={32} cy={32} r={12} fill={accent} />
      </svg>
      <span style={{ fontFamily: `${font}, system-ui, sans-serif`, fontSize: 44, fontWeight: 700, color: ink, letterSpacing: "-0.03em" }}>
        {name.toLowerCase()}
      </span>
    </div>
  );
};

/** Proof card: a procedural claim tile that stands in for a real screenshot. */
export const ProofCard: React.FC<{
  heading: string;
  body?: string;
  paper: string;
  ink: string;
  accent: string;
  font: string;
  width: number;
}> = ({ heading, body, paper, ink, accent, font, width }) => {
  const frame = useCurrentFrame();
  const p = ease(frame, 0, 16);
  const cardW = Math.min(width * 0.82, 900);
  return (
    <div
      style={{
        width: cardW,
        background: paper,
        borderRadius: 18,
        border: `1px solid ${hexAlpha(ink, 0.12)}`,
        boxShadow: `0 7px 0 ${hexAlpha(ink, 0.08)}`,
        padding: 40,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [18, 0])}px)`,
      }}
    >
      <div style={{ width: 46, height: 6, background: accent, borderRadius: 3, marginBottom: 20 }} />
      <div style={{ fontFamily: `${font}, system-ui, sans-serif`, fontSize: 46, fontWeight: 700, color: ink, letterSpacing: "-0.02em" }}>
        {heading}
      </div>
      {body ? (
        <div style={{ fontFamily: `${font}, system-ui, sans-serif`, fontSize: 30, color: hexAlpha(ink, 0.7), marginTop: 14, lineHeight: 1.3 }}>
          {body}
        </div>
      ) : null}
    </div>
  );
};

export function sceneFrames(plan: EditPlan, scene: Scene): { from: number; durationInFrames: number } {
  const from = Math.round(scene.start * plan.fps);
  const to = Math.round(scene.end * plan.fps);
  return { from, durationInFrames: Math.max(1, to - from) };
}

/** Expand a #rrggbb color to rgba with the given alpha. */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const int = parseInt(m[1]!, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

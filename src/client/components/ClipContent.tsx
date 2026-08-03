import type { Clip, TrackKind } from "../state/types";

/*
 * The visual content of a clip inside the timeline: a thumbnail for video/image clips, the
 * caption text for caption clips, and a labelled bar for audio. Rendered by the timeline via
 * getActionRender, so real evidence (a frame, the caption words) shows on the clip itself.
 */
export function ClipContent({ clip, kind, thumb, selected }: { clip: Clip; kind: TrackKind; thumb?: string | null; selected?: boolean }) {
  const label = kind === "caption" ? clip.text || "caption" : clip.name || clip.id;
  return (
    <div className={`clip-inner clip-${kind}${selected ? " sel" : ""}`} title={label}>
      {thumb ? <img className="clip-thumb" src={thumb} alt="" draggable={false} /> : <span className={`clip-swatch clip-swatch-${kind}`} />}
      <span className="clip-label">{label}</span>
    </div>
  );
}

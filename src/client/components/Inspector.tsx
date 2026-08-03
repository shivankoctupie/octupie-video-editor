import { type Dispatch } from "react";
import type { EditorAction, TimelineDoc } from "../state/types";
import { nextClipId } from "../state/factory";
import { Icon } from "./icons";

/*
 * The inspector edits the selected clip. Every change dispatches a reducer action, so the
 * preview and timeline update immediately from the same source of truth.
 */
export function Inspector({ doc, selectedClipId, playhead, dispatch }: { doc: TimelineDoc; selectedClipId: string | null; playhead: number; dispatch: Dispatch<EditorAction> }) {
  const clip = doc.clips.find((c) => c.id === selectedClipId) ?? null;
  if (!clip) {
    return (
      <div className="inspector">
        <h3>Inspector</h3>
        <p className="muted">Select a clip on the timeline to edit its timing, source, text, transform, and audio.</p>
      </div>
    );
  }
  const kind = doc.tracks.find((t) => t.id === clip.trackId)?.kind ?? "video";
  const end = clip.start + clip.duration;
  const canSplit = playhead > clip.start + 0.05 && playhead < end - 0.05;
  const set = (a: EditorAction): void => dispatch(a);

  return (
    <div className="inspector">
      <div className="insp-head">
        <h3>{kind} clip</h3>
        <code className="muted">{clip.id}</code>
      </div>

      <div className="insp-actions">
        <button className="btn ghost xs" disabled={!canSplit} title={canSplit ? "Split at playhead (S)" : "Move the playhead inside the clip"} onClick={() => set({ type: "SPLIT_CLIP", clipId: clip.id, time: playhead, newId: nextClipId() })}>
          <Icon name="split" size={13} /> Split
        </button>
        <button className="btn ghost xs" onClick={() => set({ type: "DUPLICATE_CLIP", clipId: clip.id, newId: nextClipId() })}>
          <Icon name="duplicate" size={13} /> Duplicate
        </button>
        <button className="btn ghost xs" onClick={() => set({ type: "RIPPLE_DELETE_CLIP", clipId: clip.id })} title="Delete and close the gap">
          Ripple
        </button>
        <button className="btn ghost xs danger" onClick={() => set({ type: "DELETE_CLIP", clipId: clip.id })}>
          <Icon name="trash" size={13} /> Delete
        </button>
      </div>

      <Section title="Timing">
        <Num label="Start (s)" value={clip.start} step={0.05} min={0} onCommit={(v) => set({ type: "SET_CLIP_TIMING", clipId: clip.id, start: v })} />
        <Num label="Duration (s)" value={clip.duration} step={0.05} min={0.05} onCommit={(v) => set({ type: "SET_CLIP_TIMING", clipId: clip.id, duration: v })} />
        {clip.mediaId ? <Num label="Source in (s)" value={clip.sourceIn} step={0.05} min={0} onCommit={(v) => set({ type: "SET_CLIP_SOURCE_IN", clipId: clip.id, sourceIn: v })} /> : null}
        {clip.mediaId ? <Read label="Source out (s)" value={(clip.sourceIn + clip.duration).toFixed(2)} /> : null}
      </Section>

      {kind === "caption" || kind === "overlay" ? (
        <Section title="Text">
          <label className="field">
            <textarea rows={2} value={clip.text} onChange={(e) => set({ type: "SET_CLIP_TEXT", clipId: clip.id, text: e.target.value })} />
          </label>
        </Section>
      ) : null}

      {kind !== "audio" ? (
        <Section title="Transform">
          <Num label="X" value={clip.transform.x} step={2} onCommit={(v) => set({ type: "SET_CLIP_TRANSFORM", clipId: clip.id, transform: { x: v } })} />
          <Num label="Y" value={clip.transform.y} step={2} onCommit={(v) => set({ type: "SET_CLIP_TRANSFORM", clipId: clip.id, transform: { y: v } })} />
          <Range label="Scale" value={clip.transform.scale} min={0.1} max={4} step={0.02} onCommit={(v) => set({ type: "SET_CLIP_TRANSFORM", clipId: clip.id, transform: { scale: v } })} />
          <Range label="Rotation" value={clip.transform.rotation} min={-180} max={180} step={1} onCommit={(v) => set({ type: "SET_CLIP_TRANSFORM", clipId: clip.id, transform: { rotation: v } })} />
          <Range label="Opacity" value={clip.transform.opacity} min={0} max={1} step={0.02} onCommit={(v) => set({ type: "SET_CLIP_TRANSFORM", clipId: clip.id, transform: { opacity: v } })} />
        </Section>
      ) : null}

      {kind === "video" || kind === "audio" ? (
        <Section title="Audio">
          <Range label="Volume" value={clip.volume} min={0} max={1} step={0.02} onCommit={(v) => set({ type: "SET_CLIP_VOLUME", clipId: clip.id, volume: v })} />
        </Section>
      ) : null}

      {kind === "caption" ? (
        <Section title="Caption style">
          <Num label="Font size" value={clip.captionStyle?.fontSize ?? 54} step={2} min={8} onCommit={(v) => set({ type: "SET_CAPTION_STYLE", clipId: clip.id, style: { fontSize: v } })} />
          <label className="field row-field">
            <span>Color</span>
            <input type="color" value={clip.captionStyle?.color ?? "#F5F5F5"} onChange={(e) => set({ type: "SET_CAPTION_STYLE", clipId: clip.id, style: { color: e.target.value } })} />
          </label>
          <label className="field row-field">
            <span>Plate</span>
            <input type="color" value={clip.captionStyle?.background || "#000000"} onChange={(e) => set({ type: "SET_CAPTION_STYLE", clipId: clip.id, style: { background: e.target.value } })} />
            <button className="btn ghost xs" onClick={() => set({ type: "SET_CAPTION_STYLE", clipId: clip.id, style: { background: clip.captionStyle?.background ? "" : "#000000" } })}>
              {clip.captionStyle?.background ? "off" : "on"}
            </button>
          </label>
          <label className="field row-field">
            <span>Align</span>
            <select value={clip.captionStyle?.align ?? "center"} onChange={(e) => set({ type: "SET_CAPTION_STYLE", clipId: clip.id, style: { align: e.target.value as "left" | "center" | "right" } })}>
              <option value="left">left</option>
              <option value="center">center</option>
              <option value="right">right</option>
            </select>
          </label>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="insp-section">
      <div className="insp-section-title">{title}</div>
      <div className="insp-grid">{children}</div>
    </div>
  );
}

function Num({ label, value, onCommit, step = 1, min, max }: { label: string; value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <label className="field num-field">
      <span>{label}</span>
      <input type="number" step={step} min={min} max={max} defaultValue={round2(value)} key={round2(value)} onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onCommit(v); }} />
    </label>
  );
}

function Range({ label, value, onCommit, min, max, step }: { label: string; value: number; onCommit: (v: number) => void; min: number; max: number; step: number }) {
  return (
    <label className="field range-field">
      <span>
        {label} <em className="muted">{round2(value)}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onCommit(parseFloat(e.target.value))} />
    </label>
  );
}

function Read({ label, value }: { label: string; value: string }) {
  return (
    <div className="field num-field">
      <span>{label}</span>
      <div className="readonly">{value}</div>
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

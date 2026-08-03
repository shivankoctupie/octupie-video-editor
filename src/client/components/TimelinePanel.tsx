import { useMemo, useRef, type Dispatch, type RefObject } from "react";
import { Timeline, type TimelineState } from "@xzdarcy/react-timeline-editor";
import type { TimelineRow, TimelineEffect } from "@xzdarcy/timeline-engine";
import type { EditorAction, TimelineDoc, TrackKind } from "../state/types";
import { makeTrack, nextTrackId } from "../state/factory";
import { collectSnapTargets, snapClipMove, snapClipTrim } from "../state/snap";
import { ClipContent } from "./ClipContent";
import { Icon, kindIcon } from "./icons";

/*
 * The timeline surface. The @xzdarcy/react-timeline-editor engine owns the ruler, the moving
 * playhead cursor, clip drag, trim handles, snapping (drag lines), and horizontal zoom. This
 * component is a controlled bridge: it derives the engine's rows from the editor document and
 * turns the engine's move/resize/click callbacks back into pure reducer actions. The library
 * never holds edit state of its own; the reducer is the single source of truth.
 *
 * The left track-header column (name, mute, lock, reorder, remove) is ours, scroll-synced to
 * the engine's edit area via onScroll.
 */

export const ROW_HEIGHT = 46;
const RULER_HEIGHT = 32;

const EFFECTS: Record<string, TimelineEffect> = {
  video: { id: "video", name: "Video" },
  overlay: { id: "overlay", name: "Overlay" },
  caption: { id: "caption", name: "Caption" },
  audio: { id: "audio", name: "Audio" },
};

const TRACK_KINDS: TrackKind[] = ["video", "overlay", "caption", "audio"];

function formatTick(s: number): string {
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  return `${s}s`;
}

export function TimelinePanel({
  doc,
  dispatch,
  selectedClipId,
  selectedTrackId,
  zoom,
  playhead,
  projectId,
  thumbs,
  timelineRef,
}: {
  doc: TimelineDoc;
  dispatch: Dispatch<EditorAction>;
  selectedClipId: string | null;
  selectedTrackId: string | null;
  zoom: number;
  playhead: number;
  projectId: string;
  thumbs: Map<string, string>;
  timelineRef: RefObject<TimelineState | null>;
}) {
  const headersRef = useRef<HTMLDivElement>(null);

  const editorData: TimelineRow[] = useMemo(
    () =>
      doc.tracks.map((track) => ({
        id: track.id,
        actions: doc.clips
          .filter((c) => c.trackId === track.id)
          .map((c) => ({
            id: c.id,
            start: c.start,
            end: c.start + c.duration,
            effectId: track.kind,
            selected: c.id === selectedClipId,
            movable: !track.locked,
            flexible: !track.locked,
            minStart: 0,
          })),
      })),
    [doc, selectedClipId],
  );

  return (
    <div className="timeline-panel">
      <div className="tl-headers" ref={headersRef}>
        <div className="tl-headers-spacer" style={{ height: RULER_HEIGHT }}>
          <span className="muted small">Tracks</span>
        </div>
        {doc.tracks.map((track, i) => (
          <div
            key={track.id}
            className={`tl-header${track.id === selectedTrackId ? " sel" : ""}${track.locked ? " locked" : ""}`}
            style={{ height: ROW_HEIGHT }}
            onClick={() => dispatch({ type: "SELECT_TRACK", trackId: track.id })}
          >
            <span className={`tl-kind kind-${track.kind}`}>
              <Icon name={kindIcon(track.kind)} size={14} />
            </span>
            <span className="tl-name">{track.name}</span>
            <span className="tl-header-btns">
              <button className="icon-btn xs" title="Move up" disabled={i === 0} onClick={(e) => (e.stopPropagation(), dispatch({ type: "REORDER_TRACK", trackId: track.id, dir: -1 }))}>
                <Icon name="minus" size={12} style={{ transform: "rotate(90deg)" }} />
              </button>
              <button className="icon-btn xs" title="Move down" disabled={i === doc.tracks.length - 1} onClick={(e) => (e.stopPropagation(), dispatch({ type: "REORDER_TRACK", trackId: track.id, dir: 1 }))}>
                <Icon name="plus" size={12} />
              </button>
              <button className={`icon-btn xs${track.muted ? " on" : ""}`} title={track.muted ? "Unmute" : "Mute"} onClick={(e) => (e.stopPropagation(), dispatch({ type: "TOGGLE_MUTE", trackId: track.id }))}>
                <Icon name={track.muted ? "mute" : "volume"} size={13} />
              </button>
              <button className={`icon-btn xs${track.locked ? " on" : ""}`} title={track.locked ? "Unlock" : "Lock"} onClick={(e) => (e.stopPropagation(), dispatch({ type: "TOGGLE_LOCK", trackId: track.id }))}>
                <Icon name={track.locked ? "lock" : "unlock"} size={13} />
              </button>
              <button className="icon-btn xs danger" title="Remove track" disabled={track.locked} onClick={(e) => (e.stopPropagation(), dispatch({ type: "REMOVE_TRACK", trackId: track.id }))}>
                <Icon name="trash" size={13} />
              </button>
            </span>
          </div>
        ))}
        <div className="tl-add-track">
          {TRACK_KINDS.map((k) => (
            <button key={k} className="btn ghost xs" onClick={() => dispatch({ type: "ADD_TRACK", track: makeTrack(k, nextTrackId()) })}>
              + {k}
            </button>
          ))}
        </div>
      </div>

      <div className="tl-canvas">
        <Timeline
          ref={timelineRef}
          editorData={editorData}
          effects={EFFECTS}
          scale={1}
          scaleSplitCount={10}
          scaleWidth={zoom}
          startLeft={12}
          rowHeight={ROW_HEIGHT}
          autoScroll
          dragLine
          autoReRender
          style={{ width: "100%", height: "100%" }}
          onScroll={(p) => {
            if (headersRef.current) headersRef.current.scrollTop = p.scrollTop;
          }}
          getScaleRender={(s: number) => <span className="tl-scale">{formatTick(s)}</span>}
          getActionRender={(action, row) => {
            const clip = doc.clips.find((c) => c.id === action.id);
            if (!clip) return null;
            const kind = (doc.tracks.find((t) => t.id === row.id)?.kind ?? (action.effectId as TrackKind)) as TrackKind;
            return <ClipContent clip={clip} kind={kind} thumb={clip.mediaId ? thumbs.get(clip.mediaId) : null} selected={action.selected} />;
          }}
          onClickAction={(_e, { action }) => dispatch({ type: "SELECT_CLIP", clipId: action.id })}
          onClickRow={(_e, { row }) => dispatch({ type: "SELECT_TRACK", trackId: row.id })}
          onClickTimeArea={(time) => {
            dispatch({ type: "SET_PLAYHEAD", time });
            return true;
          }}
          onCursorDrag={(time) => dispatch({ type: "SET_PLAYHEAD", time })}
          onActionMoving={({ start }) => start >= 0}
          onActionMoveEnd={({ action, start }) => dispatch({ type: "MOVE_CLIP", clipId: action.id, start })}
          onActionResizeEnd={({ action, start, end }) => dispatch({ type: "TRIM_CLIP", clipId: action.id, start, end })}
        />
      </div>
    </div>
  );
}

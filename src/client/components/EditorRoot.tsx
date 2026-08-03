import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { TimelineState } from "@xzdarcy/react-timeline-editor";
import { api, errorText, type ProjectRow } from "../api";
import { editorReducer, initialEditorState } from "../state/reducer";
import { emptyDoc, makeClip, makeTrack, defaultTracks, nextTrackId, nextClipId } from "../state/factory";
import { fromEditPlan, toEditPlan } from "../state/editPlanMap";
import type { TimelineDoc, TrackKind } from "../state/types";
import { mediaKind, mediaObjectUrl, probeDuration, videoPosterThumb } from "../media";
import { useApp } from "./context";
import { MediaBin } from "./MediaBin";
import { Preview } from "./Preview";
import { Inspector } from "./Inspector";
import { TimelinePanel } from "./TimelinePanel";
import { ManageDrawer } from "./ManageDrawer";
import { useAutosave, type SaveOutcome } from "./useAutosave";
import { Icon } from "./icons";
import { BrandGlyph } from "./Login";

const round = (n: number): number => Math.round(n * 1000) / 1000;

function starterDoc(title: string): TimelineDoc {
  const doc = emptyDoc({ title });
  doc.tracks = defaultTracks({ video: nextTrackId(), overlay: nextTrackId(), caption: nextTrackId(), audio: nextTrackId() });
  return doc;
}

export function EditorRoot({ projects, onSelectProject, onNewProject, onSignOut }: { projects: ProjectRow[]; onSelectProject: (id: string) => void; onNewProject: () => void; onSignOut: () => void }) {
  const app = useApp();
  const [state, dispatch] = useReducer(editorReducer, undefined, initialEditorState);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const [autosave, setAutosave] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);
  const [loadedVersionId, setLoadedVersionId] = useState<string | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(new Map());
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const mediaKinds = useMemo(() => new Map(app.media.map((m) => [m.id, mediaKind(m.mime)] as const)), [app.media]);

  const timelineRef = useRef<TimelineState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const playheadRef = useRef(0);
  playheadRef.current = state.playhead;
  const durationRef = useRef(state.doc.duration);
  durationRef.current = state.doc.duration;

  // ---- load the project's latest plan into the editor on mount ----
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await api<{ version: { id: string }; plan: unknown }>(`/api/projects/${app.projectId}/plan`);
      if (!alive) return;
      if (r.status === 200 && r.json?.plan) {
        dispatch({ type: "LOAD_DOC", doc: fromEditPlan(r.json.plan as never, app.mediaPathToId) });
        setLoadedVersionId(r.json.version.id);
      } else {
        dispatch({ type: "LOAD_DOC", doc: starterDoc(projectName()) });
        setLoadedVersionId(null);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.projectId]);

  // ---- object URLs + thumbnails for media ----
  useEffect(() => {
    let alive = true;
    void (async () => {
      const urls = new Map<string, string>();
      const th = new Map<string, string>();
      for (const m of app.media) {
        try {
          urls.set(m.id, await mediaObjectUrl(app.projectId, m.id));
        } catch {
          /* ignore a single media failure */
        }
        if (mediaKind(m.mime) === "video") {
          const t = await videoPosterThumb(app.projectId, m.id);
          if (t) th.set(m.id, t);
        }
      }
      if (alive) {
        setMediaUrls(urls);
        setThumbs(th);
      }
    })();
    return () => {
      alive = false;
    };
  }, [app.media, app.projectId]);

  // ---- playback clock: the editor playhead is the master; it drives preview + cursor ----
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      const t = Math.min(durationRef.current, playheadRef.current + dt);
      playheadRef.current = t;
      timelineRef.current?.setTime(t);
      dispatch({ type: "SET_PLAYHEAD", time: t });
      if (t >= durationRef.current - 1e-3) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && playheadRef.current >= durationRef.current - 1e-3) {
        playheadRef.current = 0;
        dispatch({ type: "SET_PLAYHEAD", time: 0 });
        timelineRef.current?.setTime(0);
      }
      return !p;
    });
  }, []);

  const seek = useCallback((t: number) => {
    dispatch({ type: "SET_PLAYHEAD", time: t });
    timelineRef.current?.setTime(Math.max(0, t));
  }, []);

  const splitSelected = useCallback(() => {
    const s = stateRef.current;
    if (s.selectedClipId) dispatch({ type: "SPLIT_CLIP", clipId: s.selectedClipId, time: s.playhead, newId: nextClipId() });
  }, []);

  // ---- keyboard shortcuts (ignored while typing) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (mod && k === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "REDO" : "UNDO" });
      } else if (mod && k === "y") {
        e.preventDefault();
        dispatch({ type: "REDO" });
      } else if ((mod && k === "b") || (!mod && k === "s")) {
        e.preventDefault();
        splitSelected();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (stateRef.current.selectedClipId) {
          e.preventDefault();
          dispatch({ type: "DELETE_CLIP", clipId: stateRef.current.selectedClipId });
        }
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        dispatch({ type: "ZOOM_IN" });
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        dispatch({ type: "ZOOM_OUT" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, splitSelected]);

  // ---- save (explicit + autosave) ----
  // The save flow is coordinated by useAutosave so an edit that lands while a save is in flight
  // is never lost, overlapping saves are serialized, and a stale completion can never clear the
  // wrong revision or write into another project. The editor is also remounted per project
  // (keyed by projectId in App), so switching projects cancels any pending save.
  const saveProject = useCallback(
    async (pid: string, docToSave: TimelineDoc): Promise<SaveOutcome> => {
      const plan = toEditPlan(docToSave, app.mediaPath);
      const r = await api<{ version: { id: string; version: number } }>(`/api/projects/${pid}/plan`, { method: "POST", body: { plan } });
      return r.ok && r.json ? { ok: true, version: r.json.version } : { ok: false, message: errorText(r, "Save failed") };
    },
    [app],
  );
  const onSaved = useCallback(
    (savedDoc: TimelineDoc, version: { id: string; version: number }, silent: boolean): void => {
      dispatch({ type: "MARK_SAVED", savedDoc });
      setLoadedVersionId(version.id);
      void app.refreshVersions();
      if (!silent) app.toast(`Saved version ${version.version}`, "ok");
    },
    [app],
  );
  const { saveNow, saving } = useAutosave({
    projectId: app.projectId,
    doc: state.doc,
    dirty: state.dirty,
    enabled: autosave,
    saveProject,
    onSaved,
    onError: (message) => app.toast(message, "bad"),
  });

  // ---- add media / caption to the timeline ----
  const addMediaToTimeline = useCallback(
    async (mediaId: string) => {
      const m = app.mediaById(mediaId);
      if (!m) return;
      const kind = mediaKind(m.mime);
      const targetKind: TrackKind = kind === "video" ? "video" : kind === "audio" ? "audio" : "overlay";
      let track = stateRef.current.doc.tracks.find((tk) => tk.kind === targetKind);
      let trackId: string;
      if (!track) {
        const nt = makeTrack(targetKind, nextTrackId());
        dispatch({ type: "ADD_TRACK", track: nt });
        trackId = nt.id;
      } else {
        trackId = track.id;
      }
      const probeKind = kind === "other" ? "image" : kind;
      const dur = await probeDuration(app.projectId, mediaId, probeKind);
      const clipDur = kind === "image" || kind === "other" ? 4 : dur && dur > 0 ? Math.min(dur, 3600) : 4;
      const start = round(stateRef.current.playhead);
      const clip = makeClip({ id: nextClipId(), trackId, start, duration: round(clipDur), mediaId, sourceDuration: dur ?? null, name: m.filename });
      dispatch({ type: "ADD_CLIP", clip });
      if (start + clipDur > stateRef.current.doc.duration) dispatch({ type: "SET_META", meta: { duration: round(start + clipDur) } });
      dispatch({ type: "SELECT_CLIP", clipId: clip.id });
    },
    [app],
  );

  const addCaption = useCallback(() => {
    const s = stateRef.current;
    let track = s.doc.tracks.find((t) => t.kind === "caption");
    let trackId: string;
    if (!track) {
      const nt = makeTrack("caption", nextTrackId());
      dispatch({ type: "ADD_TRACK", track: nt });
      trackId = nt.id;
    } else {
      trackId = track.id;
    }
    const start = round(s.playhead);
    const clip = makeClip({
      id: nextClipId(),
      trackId,
      start,
      duration: 2,
      text: "New caption",
      name: "caption",
      captionStyle: { fontSize: 54, color: s.doc.meta.brand.ink, background: "#000000", align: "center", bold: true },
    });
    dispatch({ type: "ADD_CLIP", clip });
    dispatch({ type: "SELECT_CLIP", clipId: clip.id });
  }, []);

  async function loadVersionIntoEditor(versionId: string): Promise<void> {
    const r = await api<{ plan: unknown }>(`/api/projects/${app.projectId}/plan?version=${encodeURIComponent(versionId)}`);
    if (r.ok && r.json?.plan) {
      dispatch({ type: "LOAD_DOC", doc: fromEditPlan(r.json.plan as never, app.mediaPathToId) });
      setLoadedVersionId(versionId);
      setManageOpen(false);
      app.toast("Loaded version into editor", "ok");
    } else app.toast(errorText(r, "Could not load version"), "bad");
  }

  function projectName(): string {
    return projects.find((p) => p.id === app.projectId)?.name ?? "Untitled";
  }

  const saveLabel = saving ? "Saving…" : state.dirty ? (autosave ? "Unsaved (autosaving)" : "Unsaved") : loadedVersionId ? "Saved" : "New";

  return (
    <>
      <div className="compact-note">Compact view. The inspector and full timeline are best on a wider screen; review and publishing live in the Manage panel.</div>
      <div className="editor-shell">
        <header className="toolbar">
        <div className="tb-left">
          <span className="brandmark">
            <BrandGlyph size={22} />
          </span>
          <select className="project-select" value={app.projectId} onChange={(e) => onSelectProject(e.target.value)} aria-label="Project">
            {projects.length ? projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>) : <option>No projects</option>}
          </select>
          {app.can("edit") ? (
            <button className="btn ghost sm" onClick={onNewProject}>
              New
            </button>
          ) : null}
        </div>

        <div className="tb-mid">
          <button className="icon-btn" title="Undo (Ctrl/Cmd+Z)" onClick={() => dispatch({ type: "UNDO" })} disabled={!state.past.length}>
            <Icon name="undo" />
          </button>
          <button className="icon-btn" title="Redo (Ctrl/Cmd+Shift+Z)" onClick={() => dispatch({ type: "REDO" })} disabled={!state.future.length}>
            <Icon name="redo" />
          </button>
          <span className="divider" />
          <button className="icon-btn" title="Zoom out (-)" onClick={() => dispatch({ type: "ZOOM_OUT" })}>
            <Icon name="minus" />
          </button>
          <span className="zoom-read muted">{Math.round(state.zoom)}px/s</span>
          <button className="icon-btn" title="Zoom in (+)" onClick={() => dispatch({ type: "ZOOM_IN" })}>
            <Icon name="plus" />
          </button>
          <span className="divider" />
          {app.can("edit") ? (
            <button className="btn ghost sm" onClick={addCaption}>
              <Icon name="text" size={13} /> Text
            </button>
          ) : null}
        </div>

        <div className="tb-right">
          <span className={`save-state ${state.dirty ? "dirty" : "clean"}`}>{saveLabel}</span>
          <label className="check tiny" title="Autosave a draft version">
            <input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} /> auto
          </label>
          <button className="btn accent sm" onClick={() => saveNow(false)} disabled={!app.can("edit") || saving || (!state.dirty && loadedVersionId !== null)} title={!state.dirty && loadedVersionId !== null ? "No unsaved changes" : "Save a new version"}>
            <Icon name="save" size={13} /> Save version
          </button>
          <button className="btn ghost sm" onClick={() => setManageOpen(true)}>
            Manage
          </button>
          <span className="pill role">{app.me.user.role}</span>
          <button className="btn ghost sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div
        className="work"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-ove-media")) e.preventDefault();
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData("application/x-ove-media");
          if (id) {
            e.preventDefault();
            void addMediaToTimeline(id);
          }
        }}
      >
        <MediaBin projectId={app.projectId} media={app.media} thumbs={thumbs} imageUrls={mediaUrls} can={app.can} onUploaded={app.refreshMedia} onAddToTimeline={(id) => void addMediaToTimeline(id)} onOpenTools={() => setManageOpen(true)} />
        <Preview
          doc={state.doc}
          playhead={state.playhead}
          mediaUrls={mediaUrls}
          mediaKinds={mediaKinds}
          transport={{ playing, volume, muted, fit, onTogglePlay: togglePlay, onSeek: seek, onVolume: setVolume, onToggleMute: () => setMuted((m) => !m), onToggleFit: () => setFit((f) => (f === "contain" ? "cover" : "contain")) }}
        />
        <Inspector doc={state.doc} selectedClipId={state.selectedClipId} playhead={state.playhead} dispatch={dispatch} />
      </div>

      <div
        className="timeline-region"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-ove-media")) e.preventDefault();
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData("application/x-ove-media");
          if (id) {
            e.preventDefault();
            void addMediaToTimeline(id);
          }
        }}
      >
        <TimelinePanel doc={state.doc} dispatch={dispatch} selectedClipId={state.selectedClipId} selectedTrackId={state.selectedTrackId} zoom={state.zoom} playhead={state.playhead} projectId={app.projectId} thumbs={thumbs} timelineRef={timelineRef} />
      </div>

        {manageOpen ? <ManageDrawer onClose={() => setManageOpen(false)} onLoadVersion={(id) => void loadVersionIntoEditor(id)} currentVersionId={loadedVersionId} /> : null}
      </div>
    </>
  );
}

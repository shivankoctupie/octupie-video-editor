/*
 * Autosave coordinator. This isolates the save race handling from the editor view so it can be
 * driven and tested as a plain hook:
 *  - a save captures the exact document revision and project it is persisting, so a stale
 *    completion can never clear dirty for a newer edit or write into another project;
 *  - overlapping saves are serialized (never two in flight); a mid-flight edit keeps the state
 *    dirty, so the debounce reschedules and the newer revision is saved next (no lost state);
 *  - a `beforeunload` warning is armed whenever there are unsaved edits.
 *
 * The editor is remounted per project (keyed by projectId), so on a project switch this hook's
 * effects clean up and cancel any pending save rather than firing it against the new project.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineDoc } from "../state/types.js";

export interface SavedVersion {
  id: string;
  version: number;
}

/** Result of persisting a document. On failure the message is surfaced to `onError` verbatim. */
export type SaveOutcome = { ok: true; version: SavedVersion } | { ok: false; message: string };

export interface UseAutosaveOptions {
  projectId: string;
  doc: TimelineDoc;
  dirty: boolean;
  /** Autosave on/off (the toolbar checkbox). Explicit saves via `saveNow` ignore this. */
  enabled: boolean;
  /** Debounce before an autosave fires; default 2500ms. */
  delayMs?: number;
  /** Persist a specific project's doc. The projectId is captured at call time so a switch
   *  mid-flight never redirects the write. */
  saveProject: (projectId: string, doc: TimelineDoc) => Promise<SaveOutcome>;
  /** Commit side effects (MARK_SAVED with the saved revision, version id, refresh, toast).
   *  Called only when the response still belongs to the active project. */
  onSaved: (savedDoc: TimelineDoc, version: SavedVersion, silent: boolean) => void;
  /** Called with the server message when a save for the active project failed. */
  onError: (message: string) => void;
}

export interface AutosaveController {
  /** Trigger a save now (used by the explicit Save button). `silent` suppresses the success toast. */
  saveNow: (silent: boolean) => void;
  /** True while a save request is in flight. */
  saving: boolean;
}

export function useAutosave(opts: UseAutosaveOptions): AutosaveController {
  const { doc, dirty, enabled } = opts;
  const delayMs = opts.delayMs ?? 2500;
  const [saving, setSaving] = useState(false);

  // Live refs so the debounced save reads the latest values without re-creating saveNow (which
  // would reschedule the debounce on every render).
  const docRef = useRef(doc);
  docRef.current = doc;
  const projectIdRef = useRef(opts.projectId);
  projectIdRef.current = opts.projectId;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const savingRef = useRef(false);
  // Set when a debounced or explicit save arrives while another request is in flight. Without
  // this latch, that timer is consumed and a mid-flight edit can remain dirty forever.
  const pendingRef = useRef(false);

  const saveNow = useCallback((silent: boolean): void => {
    // Serialize: never overlap two saves. Remember the blocked request and drain it after the
    // current one settles, using the latest document revision.
    if (savingRef.current) {
      pendingRef.current = true;
      return;
    }
    pendingRef.current = false;
    const pid = projectIdRef.current;
    const savedDoc = docRef.current; // baseline: the exact revision being persisted
    savingRef.current = true;
    setSaving(true);
    void (async () => {
      let outcome: SaveOutcome;
      try {
        outcome = await optsRef.current.saveProject(pid, savedDoc);
      } catch (err) {
        outcome = { ok: false, message: err instanceof Error ? err.message : "Save failed" };
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      // Drop a response that no longer belongs to the active project: never write across a switch.
      if (pid !== projectIdRef.current) return;
      if (outcome.ok) {
        optsRef.current.onSaved(savedDoc, outcome.version, silent);
      } else {
        optsRef.current.onError((outcome as Extract<SaveOutcome, { ok: false }>).message);
      }
      // A debounce may have elapsed while this request was in flight. Drain that saved intent
      // after completion so the latest revision cannot be stranded dirty. queueMicrotask avoids
      // recursively starting work inside the completion stack.
      if (pendingRef.current && optsRef.current.dirty) {
        pendingRef.current = false;
        queueMicrotask(() => saveNow(true));
      }
    })();
  }, []);

  // Debounced autosave. Cleanup cancels a pending save on unmount / dependency change, so a
  // project switch (keyed remount) never lets an old project's timer fire against a new one.
  useEffect(() => {
    if (!dirty || !enabled) return;
    const t = setTimeout(() => saveNow(true), delayMs);
    return () => clearTimeout(t);
  }, [doc, dirty, enabled, delayMs, saveNow]);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return { saveNow, saving };
}

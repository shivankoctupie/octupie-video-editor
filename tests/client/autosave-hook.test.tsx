// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAutosave, type SaveOutcome, type SavedVersion } from "../../src/client/components/useAutosave.js";
import { emptyDoc } from "../../src/client/state/factory.js";
import type { TimelineDoc } from "../../src/client/state/types.js";

/*
 * The autosave coordinator, driven as a real React hook in jsdom. These tests pin the two
 * release-blocking races:
 *  - an edit that lands while a save is in flight must not be lost (the save commits the
 *    revision it captured, and the newer edit is saved on the reschedule);
 *  - switching project (a keyed remount) while a dirty autosave is pending or in flight must
 *    never write into another project.
 */

// React treats act() as the test environment only when this flag is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeDoc(title: string): TimelineDoc {
  return emptyDoc({ title });
}

function Harness(p: {
  projectId: string;
  doc: TimelineDoc;
  dirty: boolean;
  saveProject: (pid: string, doc: TimelineDoc) => Promise<SaveOutcome>;
  onSaved?: (savedDoc: TimelineDoc, v: SavedVersion, silent: boolean) => void;
  onError?: (message: string) => void;
  delayMs?: number;
}) {
  useAutosave({
    projectId: p.projectId,
    doc: p.doc,
    dirty: p.dirty,
    enabled: true,
    delayMs: p.delayMs ?? 10,
    saveProject: p.saveProject,
    onSaved: p.onSaved ?? (() => {}),
    onError: p.onError ?? (() => {}),
  });
  return null;
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const mounted: Root[] = [];
function mount(): Root {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
  });
  mounted.push(root);
  return root;
}
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  document.body.innerHTML = "";
});

describe("useAutosave", () => {
  it("autosaves the dirty doc to the active project after the debounce", async () => {
    const calls: Array<{ pid: string; title: string }> = [];
    const saveProject = vi.fn(async (pid: string, d: TimelineDoc): Promise<SaveOutcome> => {
      calls.push({ pid, title: d.meta.title });
      return { ok: true, version: { id: "v1", version: 1 } };
    });
    const onSaved = vi.fn();
    const root = mount();
    const doc = makeDoc("A-doc");
    await act(async () => {
      root.render(<Harness projectId="A" doc={doc} dirty saveProject={saveProject} onSaved={onSaved} />);
    });
    await act(async () => {
      await tick(30);
    });
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ pid: "A", title: "A-doc" });
    expect(onSaved).toHaveBeenCalledWith(doc, { id: "v1", version: 1 }, true);
  });

  it("does not autosave a clean document", async () => {
    const saveProject = vi.fn(async (): Promise<SaveOutcome> => ({ ok: true, version: { id: "v", version: 1 } }));
    const root = mount();
    await act(async () => {
      root.render(<Harness projectId="A" doc={makeDoc("A")} dirty={false} saveProject={saveProject} delayMs={10} />);
    });
    await act(async () => {
      await tick(30);
    });
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("switching project during a pending dirty autosave creates no cross-project save", async () => {
    const seen: string[] = [];
    const saveProject = vi.fn(async (pid: string): Promise<SaveOutcome> => {
      seen.push(pid);
      return { ok: true, version: { id: "v", version: 1 } };
    });
    const root = mount();
    // Project A is dirty; its autosave is pending (debounce not yet elapsed).
    await act(async () => {
      root.render(<Harness key="A" projectId="A" doc={makeDoc("A")} dirty saveProject={saveProject} delayMs={50} />);
    });
    // Switch to project B (keyed remount) BEFORE A's debounce fires; B starts clean.
    await act(async () => {
      root.render(<Harness key="B" projectId="B" doc={makeDoc("B")} dirty={false} saveProject={saveProject} delayMs={50} />);
    });
    await act(async () => {
      await tick(120);
    });
    expect(saveProject).not.toHaveBeenCalled();
    expect(seen).not.toContain("B");
  });

  it("a save in flight when the project switches never commits to another project", async () => {
    const d = defer<SaveOutcome>();
    const seen: Array<{ pid: string; title: string }> = [];
    const saveProject = vi.fn(async (pid: string, doc: TimelineDoc): Promise<SaveOutcome> => {
      seen.push({ pid, title: doc.meta.title });
      return d.promise;
    });
    const root = mount();
    const docA = makeDoc("A");
    await act(async () => {
      root.render(<Harness key="A" projectId="A" doc={docA} dirty saveProject={saveProject} delayMs={10} />);
    });
    await act(async () => {
      await tick(25); // A's autosave fires -> saveProject("A", docA), then hangs
    });
    expect(seen).toEqual([{ pid: "A", title: "A" }]);
    // Switch to B (remount) while A's save is still pending.
    await act(async () => {
      root.render(<Harness key="B" projectId="B" doc={makeDoc("B")} dirty={false} saveProject={saveProject} delayMs={10} />);
    });
    // A's request finally resolves; it must not turn into a write for B.
    await act(async () => {
      d.resolve({ ok: true, version: { id: "vA", version: 1 } });
      await tick(5);
    });
    expect(seen.filter((s) => s.pid === "B")).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  it("an edit during a delayed save serializes and does not lose the newer edit", async () => {
    const first = defer<SaveOutcome>();
    const outcomes: Array<Promise<SaveOutcome>> = [first.promise, Promise.resolve({ ok: true, version: { id: "v2", version: 2 } })];
    let call = 0;
    const seen: string[] = [];
    const saveProject = vi.fn(async (_pid: string, doc: TimelineDoc): Promise<SaveOutcome> => {
      seen.push(doc.meta.title);
      return outcomes[call++]!;
    });
    const onSaved = vi.fn();
    const root = mount();
    const docV1 = makeDoc("v1");
    await act(async () => {
      root.render(<Harness key="A" projectId="A" doc={docV1} dirty saveProject={saveProject} onSaved={onSaved} delayMs={10} />);
    });
    await act(async () => {
      await tick(25); // first save fires with docV1, then hangs
    });
    expect(seen).toEqual(["v1"]);
    // An edit lands during the in-flight save: a new revision, still dirty.
    const docV2 = makeDoc("v2");
    await act(async () => {
      root.render(<Harness key="A" projectId="A" doc={docV2} dirty saveProject={saveProject} onSaved={onSaved} delayMs={10} />);
    });
    // The newer revision's debounce expires while the first request is still in flight. The
    // serialized coordinator must remember that work instead of dropping the timer.
    await act(async () => {
      await tick(30);
    });
    expect(saveProject).toHaveBeenCalledTimes(1);
    // The first save completes for the OLD revision; it commits exactly what it captured.
    await act(async () => {
      first.resolve({ ok: true, version: { id: "v1id", version: 1 } });
      await tick(5);
    });
    expect(onSaved).toHaveBeenCalledWith(docV1, { id: "v1id", version: 1 }, true);
    // The newer edit is not lost: the reschedule saves docV2 next.
    await act(async () => {
      await tick(30);
    });
    expect(seen).toEqual(["v1", "v2"]);
  });

  it("warns before unload while dirty and stays silent when clean", async () => {
    const saveProject = vi.fn(async (): Promise<SaveOutcome> => ({ ok: true, version: { id: "v", version: 1 } }));
    const root = mount();
    await act(async () => {
      root.render(<Harness key="A" projectId="A" doc={makeDoc("A")} dirty saveProject={saveProject} delayMs={9999} />);
    });
    const evt = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(true);
    // Go clean: no warning.
    await act(async () => {
      root.render(<Harness key="A" projectId="A" doc={makeDoc("A")} dirty={false} saveProject={saveProject} delayMs={9999} />);
    });
    const evt2 = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(evt2);
    });
    expect(evt2.defaultPrevented).toBe(false);
  });
});

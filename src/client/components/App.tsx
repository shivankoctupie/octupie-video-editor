import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText, getToken, setToken, type Me, type MediaRow, type ProjectRow, type VersionRow } from "../api";
import { revokeAllMedia } from "../media";
import { AppContext, type AppContextValue, type StatusInfo, type ToastKind } from "./context";
import { EditorRoot } from "./EditorRoot";
import { Login } from "./Login";
import { Dialog } from "./Dialog";

/*
 * App shell: authentication, project selection, and the shared app context every editor panel
 * reads from. The editor itself (reducer, timeline, preview) is remounted per project via a key
 * so switching projects always starts from a clean, correctly loaded document.
 */
interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

let toastSeq = 0;

export function App() {
  const [booted, setBooted] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [statusInfo, setStatusInfo] = useState<StatusInfo | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState("");
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const refreshStatus = useCallback(async () => {
    const r = await api<StatusInfo>("/api/status");
    if (r.json) setStatusInfo(r.json);
  }, []);
  const loadProjects = useCallback(async () => {
    const r = await api<{ projects: ProjectRow[] }>("/api/projects");
    const list = r.json?.projects ?? [];
    setProjects(list);
    setProjectId((cur) => cur || (list[0]?.id ?? ""));
  }, []);

  const refreshMedia = useCallback(async () => {
    if (!projectId) return;
    const r = await api<{ media: MediaRow[] }>(`/api/projects/${projectId}/media`);
    setMedia(r.json?.media ?? []);
  }, [projectId]);
  const refreshVersions = useCallback(async () => {
    if (!projectId) return;
    const r = await api<{ versions: VersionRow[] }>(`/api/projects/${projectId}/versions`);
    setVersions(r.json?.versions ?? []);
  }, [projectId]);

  useEffect(() => {
    void (async () => {
      if (getToken()) {
        const r = await api<Me>("/api/me");
        if (r.status === 200 && r.json) {
          setMe(r.json);
          await Promise.all([refreshStatus(), loadProjects()]);
          setBooted(true);
          return;
        }
        setToken("");
      }
      setBooted(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (projectId) {
      void refreshMedia();
      void refreshVersions();
    }
  }, [projectId, refreshMedia, refreshVersions]);

  const selectProject = useCallback((id: string) => {
    revokeAllMedia();
    setMedia([]);
    setVersions([]);
    setProjectId(id);
  }, []);

  const signOut = useCallback(() => {
    revokeAllMedia();
    setToken("");
    setMe(null);
    setProjects([]);
    setProjectId("");
    setMedia([]);
    setVersions([]);
  }, []);

  async function createProject(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    const r = await api<{ project: ProjectRow }>("/api/projects", { method: "POST", body: { name } });
    if (r.ok && r.json) {
      setNewOpen(false);
      setNewName("");
      toast("Project created", "ok");
      await loadProjects();
      selectProject(r.json.project.id);
    } else toast(errorText(r, "Could not create project"), "bad");
  }

  const ctx: AppContextValue | null = useMemo(() => {
    if (!me || !projectId) return null;
    return {
      projectId,
      me,
      statusInfo,
      media,
      versions,
      can: (action: string) => me.actions.includes(action),
      mediaById: (id: string) => media.find((m) => m.id === id),
      mediaPath: (id: string) => media.find((m) => m.id === id)?.storageKey ?? null,
      mediaPathToId: (path: string) => media.find((m) => m.storageKey === path)?.id ?? null,
      refreshMedia,
      refreshVersions,
      refreshStatus,
      toast,
    } satisfies AppContextValue;
  }, [me, projectId, statusInfo, media, versions, refreshMedia, refreshVersions, refreshStatus, toast]);

  if (!booted) return <div className="boot">Loading Octupie Video Editor…</div>;
  if (!me) return <Login onSignedIn={(m) => void afterSignIn(m)} />;

  async function afterSignIn(m: Me): Promise<void> {
    setMe(m);
    await Promise.all([refreshStatus(), loadProjects()]);
  }

  return (
    <>
      {ctx ? (
        <AppContext.Provider value={ctx}>
          <EditorRoot key={projectId} projects={projects} onSelectProject={selectProject} onNewProject={() => setNewOpen(true)} onSignOut={signOut} />
        </AppContext.Provider>
      ) : (
        <EmptyState canEdit={me.actions.includes("edit")} onNew={() => setNewOpen(true)} onSignOut={signOut} me={me} />
      )}

      {newOpen ? (
        <Dialog
          title="New project"
          onClose={() => setNewOpen(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button className="btn accent" onClick={() => void createProject()} disabled={!newName.trim()}>
                Create
              </button>
            </>
          }
        >
          <label className="field">
            <span>Project name</span>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createProject()} placeholder="e.g. Founder reel v1" />
          </label>
        </Dialog>
      ) : null}

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}

function EmptyState({ canEdit, onNew, onSignOut, me }: { canEdit: boolean; onNew: () => void; onSignOut: () => void; me: Me }) {
  return (
    <div className="empty-shell">
      <div className="empty-card">
        <h1>No project yet</h1>
        <p className="muted">Signed in as {me.user.username} ({me.user.role}).</p>
        {canEdit ? (
          <button className="btn accent" onClick={onNew}>
            Create your first project
          </button>
        ) : (
          <p className="muted">Your role is read-only. Ask an editor to create a project.</p>
        )}
        <button className="btn ghost" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

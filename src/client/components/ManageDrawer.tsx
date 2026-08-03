import { useEffect, useState } from "react";
import { api, errorText, type VersionRow } from "../api";
import { useApp } from "./context";
import { Icon } from "./icons";

/*
 * Secondary surface. The editor stays the primary window; review, render/QA, publishing,
 * activity, and media generation/import live here in a slide-over so they never crowd the
 * timeline. Every control maps to the existing gated backend routes.
 */
type Tab = "versions" | "publish" | "activity" | "tools";

export function ManageDrawer({ onClose, onLoadVersion, currentVersionId }: { onClose: () => void; onLoadVersion: (id: string) => void; currentVersionId: string | null }) {
  const [tab, setTab] = useState<Tab>("versions");
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Manage">
        <div className="drawer-head">
          <div className="drawer-tabs">
            {(["versions", "publish", "activity", "tools"] as Tab[]).map((t) => (
              <button key={t} className={`tab${tab === t ? " sel" : ""}`} onClick={() => setTab(t)} aria-selected={tab === t}>
                {t === "versions" ? "Versions & review" : t === "tools" ? "Generate & import" : t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">
          {tab === "versions" ? <Versions onLoadVersion={onLoadVersion} currentVersionId={currentVersionId} /> : null}
          {tab === "publish" ? <Publish /> : null}
          {tab === "activity" ? <Activity /> : null}
          {tab === "tools" ? <Tools /> : null}
        </div>
      </aside>
    </div>
  );
}

function Versions({ onLoadVersion, currentVersionId }: { onLoadVersion: (id: string) => void; currentVersionId: string | null }) {
  const app = useApp();
  const [selId, setSelId] = useState<string>(currentVersionId ?? "");
  const [notes, setNotes] = useState("");
  const [jobs, setJobs] = useState<Array<{ id: string; type: string; status: string; attempts: number; failureDetail?: string }>>([]);
  const [qa, setQa] = useState<{ pass: boolean; report: unknown } | null>(null);

  const sel = app.versions.find((v) => v.id === selId) ?? app.versions[app.versions.length - 1] ?? null;

  async function refreshJobs(): Promise<void> {
    const r = await api<{ jobs: typeof jobs }>(`/api/projects/${app.projectId}/jobs`);
    setJobs((r.json?.jobs ?? []).slice().reverse());
  }
  useEffect(() => {
    void refreshJobs();
  }, [app.projectId]);
  useEffect(() => {
    if (!sel) return setQa(null);
    void api<{ qa: { pass: boolean; report: unknown } | null }>(`/api/projects/${app.projectId}/versions/${sel.id}/qa`).then((r) => setQa(r.json?.qa ?? null));
  }, [sel?.id, app.projectId]);

  async function submit(v: VersionRow): Promise<void> {
    const r = await api(`/api/projects/${app.projectId}/versions/${v.id}/submit`, { method: "POST" });
    if (r.ok) {
      app.toast("Submitted for review", "ok");
      await app.refreshVersions();
    } else app.toast(errorText(r, "Submit failed"), "bad");
  }
  async function decide(v: VersionRow, approved: boolean): Promise<void> {
    const r = await api(`/api/projects/${app.projectId}/versions/${v.id}/decision`, { method: "POST", body: { approved, notes: notes || undefined } });
    if (r.ok) {
      app.toast(approved ? "Approved" : "Rejected", approved ? "ok" : "info");
      setNotes("");
      await app.refreshVersions();
    } else app.toast(errorText(r, "Decision failed"), "bad");
  }
  async function enqueue(v: VersionRow): Promise<void> {
    const r = await api(`/api/projects/${app.projectId}/jobs`, { method: "POST", body: { type: "render", idempotencyKey: `render-${v.id}-${v.version}`, payload: { versionId: v.id } } });
    if (r.ok) {
      app.toast("Render enqueued (runs in the worker)", "ok");
      await refreshJobs();
    } else app.toast(errorText(r, "Enqueue failed"), "bad");
  }

  return (
    <div className="cols2">
      <div>
        <h4>Versions</h4>
        <ul className="v-list">
          {app.versions
            .slice()
            .reverse()
            .map((v) => (
              <li key={v.id} className={`v-item${v.id === (sel?.id ?? "") ? " sel" : ""}`} onClick={() => setSelId(v.id)}>
                <b>v{v.version}</b>
                <span className={`badge ${v.status}`}>{v.status}</span>
                <span className="muted xsmall">{v.creator}</span>
              </li>
            ))}
          {app.versions.length === 0 ? <li className="muted small">No versions yet. Save one from the editor.</li> : null}
        </ul>
      </div>
      <div>
        {sel ? (
          <>
            <h4>
              v{sel.version} <span className={`badge ${sel.status}`}>{sel.status}</span>
            </h4>
            <div className="btnrow">
              <button className="btn ghost sm" onClick={() => onLoadVersion(sel.id)} disabled={!app.can("edit")}>
                Load into editor
              </button>
              {sel.status === "draft" ? (
                <button className="btn accent sm" onClick={() => submit(sel)} disabled={!app.can("submit-review")}>
                  Submit for review
                </button>
              ) : null}
              <button className="btn ghost sm" onClick={() => enqueue(sel)} disabled={!app.can("edit")}>
                Enqueue render
              </button>
            </div>
            {sel.status === "in-review" ? (
              <div className="stack">
                <label className="field">
                  <span>Decision notes</span>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
                </label>
                <div className="btnrow">
                  <button className="btn accent sm" disabled={!app.can("decide-review")} onClick={() => decide(sel, true)}>
                    Approve
                  </button>
                  <button className="btn danger sm" disabled={!app.can("decide-review")} onClick={() => decide(sel, false)}>
                    Reject
                  </button>
                </div>
                {!app.can("decide-review") ? <p className="muted xsmall">Only an approver or admin can decide.</p> : null}
              </div>
            ) : null}
            <h4>QA</h4>
            {qa ? (
              <>
                <div className={`notice ${qa.pass ? "ok" : "bad"}`}>{qa.pass ? "QA PASS" : "QA FAIL"}</div>
                <pre className="code">{JSON.stringify(qa.report, null, 2)}</pre>
              </>
            ) : (
              <p className="muted small">No QA report yet. Enqueue a render and run the worker (npm run worker).</p>
            )}
            <h4>Jobs</h4>
            <ul className="v-list">
              {jobs.map((j) => (
                <li key={j.id}>
                  <b>{j.type}</b> <span className="badge">{j.status}</span> <span className="muted xsmall">{j.attempts} attempts{j.failureDetail ? ` · ${j.failureDetail}` : ""}</span>
                </li>
              ))}
              {jobs.length === 0 ? <li className="muted small">No jobs yet.</li> : null}
            </ul>
          </>
        ) : (
          <p className="muted small">Select a version.</p>
        )}
      </div>
    </div>
  );
}

function Publish() {
  const app = useApp();
  const approved = app.versions.filter((v) => v.status === "approved");
  const [versionId, setVersionId] = useState("");
  const [adapterId, setAdapterId] = useState("");
  const [rights, setRights] = useState(false);
  const [out, setOut] = useState<{ status: string; gate?: string; reason: string } | null>(null);
  const adapters = app.statusInfo?.publishing.adapters ?? [];
  const grant = app.statusInfo?.publishing.publishingGrant;

  async function request(): Promise<void> {
    const r = await api<{ status: string; gate?: string; reason: string }>(`/api/projects/${app.projectId}/publish`, {
      method: "POST",
      body: { versionId: versionId || approved[0]?.id, adapterId: adapterId || adapters[0]?.id, idempotencyKey: `pub-${versionId || approved[0]?.id}-${Date.now()}`, rightsConfirmed: rights },
    });
    setOut(r.json ?? { status: String(r.status), reason: "no response" });
    await app.refreshVersions();
  }

  return (
    <div className="stack narrow">
      <div className={`notice ${grant ? "info" : "bad"}`}>
        {grant ? "A publishing grant is held. Publishing still needs an approved version, a publisher/admin role, confirmed rights, and a passed QA gate." : "Publishing is off by default. It needs an operator grant and a configured, enabled adapter. Requests are refused with the exact gate that blocked them."}
      </div>
      <label className="field">
        <span>Approved version</span>
        <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
          {approved.length ? approved.map((v) => <option key={v.id} value={v.id}>{`v${v.version}`}</option>) : <option value="">No approved versions</option>}
        </select>
      </label>
      <label className="field">
        <span>Adapter</span>
        <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)}>
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
              {a.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> Rights confirmed
      </label>
      <button className="btn accent sm" disabled={!app.can("publish") || !approved.length} onClick={request}>
        Request publish
      </button>
      {out ? (
        <div className={`notice ${out.status === "published" ? "ok" : "bad"}`}>
          {out.status.toUpperCase()}
          {out.gate ? ` · gate: ${out.gate}` : ""} · {out.reason}
        </div>
      ) : null}
    </div>
  );
}

function Activity() {
  const app = useApp();
  const s = app.statusInfo;
  const [audit, setAudit] = useState<Array<{ action: string; actor: string; subject?: string; detail?: string; at: string }>>([]);
  useEffect(() => {
    void api<{ audit: typeof audit }>(`/api/audit?limit=80`).then((r) => setAudit(r.json?.audit ?? []));
    void app.refreshStatus();
  }, []);
  return (
    <div className="cols2">
      <div>
        <h4>Capabilities</h4>
        {s ? (
          <dl className="kv">
            <dt>storage</dt>
            <dd>{s.storage.detail}</dd>
            <dt>local image gen</dt>
            <dd>{s.generation.localImage.verified ? "verified" : "off"}</dd>
            <dt>local tts</dt>
            <dd>{s.generation.localTts.verified ? "verified" : "off"}</dd>
            <dt>materialize web</dt>
            <dd>{s.materialization.web.enabled ? "armed" : "off"}</dd>
            <dt>publishing grant</dt>
            <dd>{s.publishing.publishingGrant ? "held" : "none"}</dd>
            <dt>grants</dt>
            <dd>{s.grants.map((g) => g.action).join(", ") || "none"}</dd>
          </dl>
        ) : (
          <p className="muted small">…</p>
        )}
      </div>
      <div>
        <h4>Audit trail</h4>
        <ul className="v-list">
          {audit.map((a, i) => (
            <li key={i}>
              <b>{a.action}</b> <span className="muted xsmall">{a.actor}{a.subject ? ` · ${a.subject}` : ""}{a.detail ? ` · ${a.detail}` : ""}</span>
            </li>
          ))}
          {audit.length === 0 ? <li className="muted small">No audit events yet.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function Tools() {
  const app = useApp();
  const [imgPrompt, setImgPrompt] = useState("");
  const [ttsText, setTtsText] = useState("");
  const [url, setUrl] = useState("");
  const [lic, setLic] = useState("");
  const [src, setSrc] = useState("");
  const [reusable, setReusable] = useState(false);
  const [msg, setMsg] = useState("");
  const webOn = app.statusInfo?.materialization.web.enabled;

  async function gen(kind: "image" | "tts"): Promise<void> {
    setMsg("Generating…");
    const body = kind === "image" ? { prompt: imgPrompt.trim() } : { text: ttsText.trim() };
    const r = await api(`/api/projects/${app.projectId}/generate/${kind}`, { method: "POST", body });
    setMsg(r.ok ? "Generated (labelled synthetic)." : errorText(r, "Failed"));
    if (r.ok) await app.refreshMedia();
  }
  async function importWeb(): Promise<void> {
    setMsg("Fetching…");
    const r = await api(`/api/projects/${app.projectId}/materialize/web`, { method: "POST", body: { url: url.trim(), rights: { license: lic.trim(), attribution: "", reusable, source: src.trim() } } });
    setMsg(r.ok ? "Imported." : errorText(r, "Refused"));
    if (r.ok) await app.refreshMedia();
  }

  return (
    <div className="cols2">
      <div className="stack">
        <h4>Generate (local, labelled)</h4>
        <p className="muted xsmall">Deterministic offline providers. Every asset is marked synthetic with provenance; no external model is called.</p>
        <label className="field">
          <span>Proof-card image (SVG)</span>
          <input value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} placeholder="e.g. Retention up 30 percent" />
        </label>
        <button className="btn ghost sm" disabled={!imgPrompt.trim() || !app.can("edit")} onClick={() => gen("image")}>
          Generate image
        </button>
        <label className="field">
          <span>Synthetic voice (silent test WAV)</span>
          <textarea rows={2} value={ttsText} onChange={(e) => setTtsText(e.target.value)} />
        </label>
        <button className="btn ghost sm" disabled={!ttsText.trim() || !app.can("edit")} onClick={() => gen("tts")}>
          Generate audio
        </button>
      </div>
      <div className="stack">
        <h4>Import (rights-cleared)</h4>
        <div className={`notice ${webOn ? "info" : "bad"}`}>{webOn ? "Materialization is armed: SSRF-guarded, reusable rights required." : "Off. Needs operator network and media-upload grants."}</div>
        <label className="field">
          <span>Web URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://host/asset.png" />
        </label>
        <div className="row">
          <input value={lic} onChange={(e) => setLic(e.target.value)} placeholder="License id (e.g. CC0-1.0)" />
          <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="Rights source URL" />
        </div>
        <label className="check">
          <input type="checkbox" checked={reusable} onChange={(e) => setReusable(e.target.checked)} /> Marked reusable by the rights holder
        </label>
        <button className="btn ghost sm" disabled={!webOn} onClick={importWeb}>
          Import from web
        </button>
      </div>
      {msg ? <div className="muted small">{msg}</div> : null}
    </div>
  );
}

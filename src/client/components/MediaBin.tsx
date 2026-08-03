import { useRef, useState } from "react";
import { apiUpload, errorText, type MediaRow } from "../api";
import { mediaKind } from "../media";
import { Icon, kindIcon } from "./icons";
import { Waveform } from "./Waveform";

/*
 * Left panel: the project's media. Files are uploaded through the existing safe backend
 * (content-addressed, quota-checked, type-sniffed). Each item shows a real thumbnail (video
 * poster / image) or a decoded waveform (audio). Double-click or drag an item onto the
 * timeline to add it as a clip.
 */
export function MediaBin({
  projectId,
  media,
  thumbs,
  imageUrls,
  can,
  onUploaded,
  onAddToTimeline,
  onOpenTools,
}: {
  projectId: string;
  media: MediaRow[];
  thumbs: Map<string, string>;
  imageUrls: Map<string, string>;
  can: (a: string) => boolean;
  onUploaded: () => Promise<void>;
  onAddToTimeline: (mediaId: string) => void;
  onOpenTools: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const editable = can("edit");

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    if (!list.length) return;
    const failed: string[] = [];
    let done = 0;
    for (const f of list) {
      setStatus(`Uploading ${f.name} (${++done}/${list.length})…`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await apiUpload(`/api/projects/${projectId}/media`, f.type || "application/octet-stream", safeName(f.name), bytes);
      if (!r.ok) failed.push(errorText(r, `Rejected ${f.name}`));
    }
    if (fileRef.current) fileRef.current.value = "";
    // Keep any failure visible after the loop; only a fully clean batch clears the status.
    setStatus(failed.length ? failed.join(" · ") : "");
    await onUploaded();
  }

  return (
    <div
      className={`media-bin${dragOver ? " drag" : ""}`}
      onDragOver={(e) => {
        if (editable) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (editable && e.dataTransfer.files.length) {
          e.preventDefault();
          void uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="panel-head">
        <h3>Media</h3>
        <span className="muted small">{media.length}</span>
      </div>

      {editable ? (
        <div className="bin-upload">
          <button className="btn accent sm" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} /> Import files
          </button>
          <input ref={fileRef} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
          <button className="btn ghost sm" onClick={onOpenTools} title="Generate or import rights-cleared media">
            Tools
          </button>
        </div>
      ) : (
        <p className="muted small">Read-only role: you cannot add media.</p>
      )}
      {status ? <div className="muted small">{status}</div> : null}
      {editable ? <p className="muted xsmall">Drop files here, or drag an item onto the timeline. Double-click adds at the playhead.</p> : null}

      <ul className="bin-list">
        {media.map((m) => {
          const kind = mediaKind(m.mime);
          return (
            <li
              key={m.id}
              className="bin-item"
              draggable={editable}
              onDragStart={(e) => e.dataTransfer.setData("application/x-ove-media", m.id)}
              onDoubleClick={() => editable && onAddToTimeline(m.id)}
              title={editable ? "Double-click or drag onto the timeline" : m.filename}
            >
              <div className="bin-thumb">
                {kind === "image" && imageUrls.get(m.id) ? (
                  <img src={imageUrls.get(m.id)} alt="" draggable={false} />
                ) : kind === "video" && thumbs.get(m.id) ? (
                  <img src={thumbs.get(m.id)} alt="" draggable={false} />
                ) : kind === "audio" ? (
                  <Waveform projectId={projectId} mediaId={m.id} width={72} height={40} color="#7aa2ff" />
                ) : (
                  <span className={`bin-glyph kind-${kind}`}>
                    <Icon name={kindIcon(kind === "other" ? "video" : kind)} size={18} />
                  </span>
                )}
              </div>
              <div className="bin-meta">
                <div className="bin-name">{m.filename}</div>
                <div className="muted xsmall">
                  {kind} · {(m.size / 1024).toFixed(0)} KiB · {m.origin}
                </div>
              </div>
              {editable ? (
                <button className="icon-btn xs" title="Add to timeline" onClick={() => onAddToTimeline(m.id)}>
                  <Icon name="plus" size={14} />
                </button>
              ) : null}
            </li>
          );
        })}
        {media.length === 0 ? <li className="muted small pad">No media yet. Import a file to begin.</li> : null}
      </ul>
    </div>
  );
}

export function safeName(name: string): string {
  const base = String(name).replace(/[^A-Za-z0-9._-]/g, "_");
  return base.length ? base : "upload";
}

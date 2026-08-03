/**
 * Safe media upload.
 *
 * An upload streams into a fresh server-controlled temp file, hashing as it goes and
 * enforcing a hard byte cap; if the cap is exceeded the stream is destroyed and the temp
 * file removed, so a runaway upload cannot fill the disk. The content type and filename
 * extension are checked against a media allowlist, and a filename with a path separator,
 * traversal, or character outside a strict safe set is refused. The destination is
 * content-addressed by the storage adapter, so a client filename never influences where
 * bytes land and the source is never overwritten.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

/** Allowlisted upload content types mapped to their canonical extension. */
export const UPLOAD_MIME_EXT: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
};

/** Extensions acceptable for a given mime (a client may send .jpg or .jpeg, etc.). */
const ALLOWED_EXT_FOR_MIME: Readonly<Record<string, readonly string[]>> = {
  "video/mp4": [".mp4", ".m4v"],
  "video/webm": [".webm"],
  "video/quicktime": [".mov", ".qt"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
  "audio/wav": [".wav"],
  "audio/x-wav": [".wav"],
  "audio/mpeg": [".mp3"],
  "audio/mp4": [".m4a", ".mp4"],
  "audio/aac": [".aac"],
};

/** Filename safe set: letters, digits, dot, underscore, hyphen. Rejects separators,
 * whitespace, control characters, and anything else. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export class UploadError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = status;
  }
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** Validate the content type and filename against the media allowlist. Returns the
 * canonical mime and extension. Throws {@link UploadError} on any problem. */
export function resolveUploadType(contentType: string | undefined, filename: string | undefined): { mime: string; ext: string } {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const canonicalExt = UPLOAD_MIME_EXT[mime];
  if (!canonicalExt) {
    throw new UploadError("type-not-allowed", `Content type '${mime || "(none)"}' is not an allowed media type.`);
  }
  const name = (filename ?? "").trim();
  if (name.length === 0 || name.length > 255) {
    throw new UploadError("bad-filename", "A filename between 1 and 255 characters is required.");
  }
  if (name.includes("..") || !SAFE_FILENAME.test(name)) {
    throw new UploadError("bad-filename", `Filename '${name}' contains an illegal character or path segment.`);
  }
  const ext = fileExtension(name);
  const allowed = ALLOWED_EXT_FOR_MIME[mime] ?? [canonicalExt];
  if (!allowed.includes(ext)) {
    throw new UploadError("ext-mismatch", `Filename extension '${ext || "(none)"}' does not match content type '${mime}'.`);
  }
  return { mime, ext: canonicalExt };
}

export interface StreamToTempResult {
  tempPath: string;
  sha256: string;
  size: number;
}

/**
 * Stream `source` into a fresh temp file under `tempDir`, hashing the bytes and enforcing
 * `maxBytes`. On overflow or error the partial file is removed and the promise rejects.
 */
export function streamToTempFile(source: Readable, opts: { tempDir: string; maxBytes: number }): Promise<StreamToTempResult> {
  const tempPath = join(opts.tempDir, `upload-${randomUUID()}.part`);
  const hash = createHash("sha256");
  let size = 0;
  let settled = false;

  return new Promise<StreamToTempResult>((resolve, reject) => {
    const out = createWriteStream(tempPath, { flags: "wx" });
    const cleanup = (): void => {
      try {
        unlinkSync(tempPath);
      } catch {
        /* file may not exist yet; ignore */
      }
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      // On Windows an open file cannot be unlinked, so close the stream first, then
      // remove the partial temp file and only then reject.
      const finish = (): void => {
        cleanup();
        reject(err);
      };
      if (out.destroyed) finish();
      else {
        out.once("close", finish);
        out.destroy();
      }
    };

    out.on("error", fail);
    source.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));

    source.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > opts.maxBytes) {
        fail(new UploadError("too-large", `Upload exceeds the ${opts.maxBytes}-byte cap.`, 413));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        source.pause();
        out.once("drain", () => source.resume());
      }
    });

    source.on("end", () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve({ tempPath, sha256: hash.digest("hex"), size });
      });
    });
  });
}

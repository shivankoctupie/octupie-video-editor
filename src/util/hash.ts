import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Stream a file through SHA-256. Used to bind a QA report to an exact master. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256String(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

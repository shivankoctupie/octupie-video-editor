import { runFfprobe } from "./spawn.js";

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  nb_read_frames?: string;
  duration?: string;
  tags?: Record<string, string>;
}

export interface ProbeFormat {
  duration?: string;
  format_name?: string;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: ProbeFormat;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const res = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);
  if (res.code !== 0) {
    throw new Error(`ffprobe failed on ${filePath}: ${res.stderr.trim()}`);
  }
  const data = JSON.parse(res.stdout) as ProbeResult;
  return { streams: data.streams ?? [], format: data.format ?? {} };
}

export function videoStream(p: ProbeResult): ProbeStream | undefined {
  return p.streams.find((s) => s.codec_type === "video");
}

export function audioStream(p: ProbeResult): ProbeStream | undefined {
  return p.streams.find((s) => s.codec_type === "audio");
}

/** Parse a rational frame-rate string like "30/1" into a number. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return NaN;
  const [num, den] = rate.split("/");
  const n = Number(num);
  const d = Number(den ?? "1");
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return NaN;
  return n / d;
}

/** Count decoded video frames. Decodes the stream, so it catches early EOF. */
export async function countFrames(filePath: string): Promise<number> {
  const res = await runFfprobe([
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
    "-print_format",
    "json",
    filePath,
  ]);
  if (res.code !== 0) {
    throw new Error(`ffprobe frame count failed: ${res.stderr.trim()}`);
  }
  const data = JSON.parse(res.stdout) as { streams?: { nb_read_frames?: string }[] };
  const raw = data.streams?.[0]?.nb_read_frames;
  return raw ? Number(raw) : NaN;
}

/**
 * Local, deterministic, offline text-to-speech provider (id `local-silence`).
 *
 * It produces a valid PCM16 mono WAV of the requested duration at the requested
 * sample rate. By default the samples are silent: this is a TEST-SIGNAL generator
 * only, never a synthetic voice, so its provenance label must state "synthetic
 * test audio (not human speech)". The output is a byte-identical function of the
 * request. This provider is fully offline: it ignores the permission policy and
 * never reaches the network.
 */

import type { GenerateOutput, TtsProvider } from "./contracts.js";
import { parseTtsRequest, type TtsRequest } from "./schemas.js";

/** Fallback clip length when a request does not name a duration. */
export const DEFAULT_DURATION_SEC = 1.0;

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

/** Write ASCII into the view one byte at a time (chunk tags are ASCII-only). */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i += 1) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

/**
 * Build a valid, silent PCM16 mono WAV with correct RIFF/WAVE/fmt /data headers.
 * The data region is left zero-filled, so the clip is silence.
 */
export function buildSilentWav(sampleRate: number, numSamples: number): Uint8Array {
  const dataSize = numSamples * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  writeTag(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeTag(view, 8, "WAVE");

  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeTag(view, 36, "data");
  view.setUint32(40, dataSize, true);
  // Data region stays zero-filled: silence.

  return new Uint8Array(buffer);
}

/** The local, offline silent-WAV test-signal provider. */
export const localTtsProvider: TtsProvider = {
  id: "local-silence",
  async synthesize(req: TtsRequest): Promise<GenerateOutput> {
    const parsed = parseTtsRequest(req);
    if (!parsed.ok || !parsed.data) {
      throw new Error(`Invalid tts request: ${parsed.errors.join("; ")}`);
    }
    const value = parsed.data;
    if (value.format !== "wav") {
      throw new Error(`local-silence produces only 'wav'; requested '${value.format}'.`);
    }
    const durationSec = value.durationSec ?? DEFAULT_DURATION_SEC;
    const numSamples = Math.round(durationSec * value.sampleRate);
    const bytes = buildSilentWav(value.sampleRate, numSamples);
    return { bytes, mime: "audio/wav" };
  },
};

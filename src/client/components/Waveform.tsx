import { useEffect, useRef, useState } from "react";
import { waveformPeaks } from "../media";

/*
 * Real audio waveform: peaks are decoded from the media via the Web Audio API (see
 * media.waveformPeaks, which caches). If decoding is unavailable or fails, a flat baseline is
 * drawn instead so the control degrades gracefully rather than showing a fake shape.
 */
export function Waveform({ projectId, mediaId, width = 160, height = 40, color = "#4C8DFF" }: { projectId: string; mediaId: string; width?: number; height?: number; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let alive = true;
    setPeaks(null);
    void waveformPeaks(projectId, mediaId, Math.max(60, Math.floor(width))).then((p) => {
      if (alive) setPeaks(p);
    });
    return () => {
      alive = false;
    };
  }, [projectId, mediaId, width]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext("2d");
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);
    const mid = height / 2;
    if (peaks && peaks.length) {
      g.fillStyle = color;
      const bw = width / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i]! * (height - 2));
        g.fillRect(i * bw, mid - h / 2, Math.max(0.75, bw - 0.5), h);
      }
    } else {
      g.fillStyle = color;
      g.globalAlpha = 0.4;
      g.fillRect(0, mid - 0.5, width, 1);
      g.globalAlpha = 1;
    }
  }, [peaks, width, height, color]);

  return <canvas ref={ref} className="waveform" style={{ width, height, display: "block" }} aria-hidden="true" />;
}

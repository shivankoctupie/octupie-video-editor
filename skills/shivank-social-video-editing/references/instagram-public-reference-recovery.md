# Recovering public Instagram references for analysis

Use this when a public Reel plays in the browser but ordinary download tooling returns an empty media response. This is a recovery path for private editing analysis, not proof of reuse rights.

## Recovery order

1. Try the normal downloader once, saving metadata when available.
2. Open the original Reel in the browser and confirm the `<video>` element actually reaches a ready state with a real duration.
3. If `currentSrc` is a `blob:` URL, do not try to download the blob outside the page. Inspect `performance.getEntriesByType('resource')` for media resources instead.
4. Filter narrowly for media-looking resources, commonly `.mp4`, `cdninstagram`, or `/o1/v/t2/`. Deduplicate complete URLs after removing byte-range suffixes such as `&bytestart=`.
5. Instagram may expose separate adaptive streams. Expect one or more video-only MP4s at different resolutions plus an audio-only MP4.
6. Return each selected URL as base64 with `btoa(url)` when long signed URLs or ampersands are being mangled by the tool or shell boundary. Decode in a small local script, then download with an HTTP client.
7. Prefer a Python HTTP client for the recovered signed URL when shell quoting is fragile. This avoids unquoted `&` parameters being interpreted by the shell:

```python
import urllib.request

url = open("video.url", encoding="utf-8").read().strip()
request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(request, timeout=120) as response:
    open("video.mp4", "wb").write(response.read())
```

8. Probe every recovered file. Classify by stream type, dimensions, duration, sample rate, and size. Choose the highest-resolution video stream and the matching audio stream.
9. Mux without transcoding when compatible:

```bash
ffmpeg -i video.mp4 -i audio.mp4 \
  -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart reference.mp4
```

Do not add `-shortest` by default. Instagram audio can end a few frames before video, and `-shortest` can silently remove the reference's final visual frames. Use it only when the longer stream is demonstrably unwanted.

10. Verify duration, decoded video-frame count, video dimensions, audio presence, and playback before transcription or visual analysis. Compare the muxed video-frame count with the selected video-only stream.

## Browser-console patterns

Confirm the player state:

```js
Array.from(document.querySelectorAll('video')).map(v => ({
  src: v.currentSrc,
  duration: v.duration,
  readyState: v.readyState,
  paused: v.paused,
}))
```

Find likely media resources without dumping the whole performance log:

```js
performance.getEntriesByType('resource')
  .map(e => e.name)
  .filter(u => u.includes('/o1/v/t2/') || u.includes('.mp4'))
```

If performance entries contain only byte ranges or their signed URLs are redacted, inspect the page HTML for `video_dash_manifest`. Decode the JSON string once, parse each `<BaseURL>`, and classify the resulting adaptive streams. Avoid literal shell metacharacters in transported browser-console expressions by constructing them with `String.fromCharCode(38)`, `String.fromCharCode(60)`, and `String.fromCharCode(62)` when necessary.

Some tool boundaries redact the long `efg` value even when the URL is returned in small chunks. Do not repeatedly retry the same serialization. Reconstruct the BaseURL without the optional `efg` query parameter, preserve the signed `oh`, `oe`, `ccb`, host, and other `_nc_*` parameters, then test the URL immediately with a browser-like user agent and Instagram referer. A successful HTTP 200 and media probe are the acceptance gate. This is a fallback, not an assumption that every signed URL tolerates removing `efg`.

If a literal ampersand causes expression transport problems, construct it inside the page:

```js
url.split(String.fromCharCode(38) + 'bytestart=')[0]
```

## Pitfalls

- A downloader's empty response does not prove the Reel is inaccessible when the browser is already playing it.
- Do not choose a stream by file size alone. Probe codec type and resolution.
- Do not treat a low-resolution alternate as the master when a higher-resolution video resource is present.
- Signed CDN URLs expire. Download immediately after recovery and keep the original local reference unchanged.
- Public accessibility is not reuse permission. Preserve source attribution and flag narration, music, and third-party asset rights before publication.

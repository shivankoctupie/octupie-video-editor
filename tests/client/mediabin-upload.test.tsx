// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ComponentProps, ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaBin } from "../../src/client/components/MediaBin.js";

/*
 * A rejected upload must stay visible after the upload loop finishes. The old code cleared the
 * status unconditionally at the end of the loop, so a failed file (especially one that was not
 * the last in the batch) silently vanished. A clean run still clears the status.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const mounted: Root[] = [];
function render(el: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(el);
  });
  mounted.push(root);
  return container;
}
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/** Accept or reject an upload by filename (via the x-filename header apiUpload sends). */
function stubUpload(shouldReject: (filename: string) => boolean): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      const filename = (init.headers as Record<string, string>)["x-filename"] ?? "";
      if (shouldReject(filename)) {
        return new Response(JSON.stringify({ error: { code: "type-not-allowed", message: `Rejected ${filename}` } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ media: { id: `m-${filename}` } }), { status: 201, headers: { "content-type": "application/json" } });
    }),
  );
}

async function upload(container: HTMLElement, files: File[]): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(30);
  });
}

function statusText(container: HTMLElement): string {
  // The upload status is the only `div.muted.small`; the media count is a span and the
  // read-only notice is a paragraph, so this targets the status line alone.
  return Array.from(container.querySelectorAll("div.muted.small"))
    .map((n) => n.textContent ?? "")
    .join(" ");
}

function props(overrides: Partial<ComponentProps<typeof MediaBin>> = {}): ComponentProps<typeof MediaBin> {
  return {
    projectId: "p1",
    media: [],
    thumbs: new Map(),
    imageUrls: new Map(),
    can: () => true,
    onUploaded: vi.fn(async () => {}),
    onAddToTimeline: () => {},
    onOpenTools: () => {},
    ...overrides,
  };
}

describe("MediaBin upload status", () => {
  it("keeps a rejected upload visible after the loop, even when it is not the last file", async () => {
    stubUpload((name) => name === "bad.png");
    const onUploaded = vi.fn(async () => {});
    const container = render(<MediaBin {...props({ onUploaded })} />);
    await upload(container, [
      new File([new Uint8Array([1, 2, 3])], "bad.png", { type: "image/png" }),
      new File([new Uint8Array([4, 5, 6])], "good.png", { type: "image/png" }),
    ]);
    expect(statusText(container)).toContain("Rejected bad.png");
    expect(onUploaded).toHaveBeenCalledTimes(1); // the batch still completes and refreshes
  });

  it("clears the status after a fully successful batch", async () => {
    stubUpload(() => false);
    const container = render(<MediaBin {...props()} />);
    await upload(container, [new File([new Uint8Array([1])], "good.png", { type: "image/png" })]);
    expect(statusText(container)).not.toContain("Rejected");
    expect(statusText(container).trim()).toBe("");
  });
});

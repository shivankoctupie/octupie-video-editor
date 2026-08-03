import { test, expect, type Page, type Locator } from "@playwright/test";
import { resolve } from "node:path";

/*
 * Real browser proof that the timeline editor works, not just that labels exist. It signs in,
 * creates a project, uploads the real demo MP4, drops it on the timeline, then performs pointer
 * drags for move and trim, keyboard split/undo/zoom, plays the preview, saves a version, and
 * reloads to prove the timeline is reproduced from persistence. Every step asserts that timeline
 * STATE changed (clip count, geometry, playhead), not merely that text is present.
 */

const TOKEN = process.env.E2E_TOKEN || "e2e-admin-token-0123456789abcdef";
const MP4 = resolve(process.cwd(), "output", "founder-reel.mp4");

const ACTION = ".timeline-editor-action";

async function dragBy(page: Page, target: Locator, dx: number, dy = 0): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("no bounding box for drag target");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // interactjs needs incremental movement to register a drag past its start threshold.
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx + (dx * i) / 6, cy + (dy * i) / 6, { steps: 2 });
  await page.mouse.up();
}

test("timeline editor: upload, add, play, split, undo, trim, move, zoom, save, reload", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // ---- sign in ----
  await page.goto("/");
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button:has-text("Sign in")');

  // ---- create a project (robust to a fresh or reused server) ----
  const firstProject = page.locator('button:has-text("Create your first project")');
  const toolbarNew = page.locator('.toolbar button:has-text("New")');
  await expect(firstProject.or(toolbarNew)).toBeVisible();
  if (await firstProject.isVisible()) await firstProject.click();
  else await toolbarNew.click();
  const projectName = "QA reel";
  await page.fill(".modal input", projectName);
  await page.click('.modal button:has-text("Create")');
  await expect(page.locator(".toolbar")).toBeVisible();
  await expect(page.locator(".timeline-panel")).toBeVisible();

  // ---- import the real demo MP4 ----
  await page.setInputFiles('input[type="file"]', MP4);
  await expect(page.locator(".bin-item")).toHaveCount(1, { timeout: 20_000 });

  // ---- drop it on the timeline (double-click adds at the playhead) ----
  await page.locator(".bin-item").dblclick();
  await expect(page.locator(ACTION)).toHaveCount(1, { timeout: 15_000 });

  // ---- the preview shows the real source video ----
  await expect(page.locator(".stage-frame video")).toHaveCount(1);

  // ---- play: the master clock (time readout) advances, then pause ----
  await page.locator(".preview-stage").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await page.waitForTimeout(900);
  await page.keyboard.press("Space");
  const readout = (await page.locator(".time-readout").textContent()) || "";
  expect(readout.startsWith("0:00.000")).toBeFalsy();

  // ---- split at the playhead: one clip becomes two ----
  await page.locator(ACTION).first().click();
  await page.keyboard.press("s");
  await expect(page.locator(ACTION)).toHaveCount(2, { timeout: 10_000 });

  // ---- undo the split ----
  await page.keyboard.press("Control+z");
  await expect(page.locator(ACTION)).toHaveCount(1, { timeout: 10_000 });

  // ---- trim: drag the right handle left, clip gets shorter ----
  const widthBefore = (await page.locator(ACTION).first().boundingBox())!.width;
  await dragBy(page, page.locator(`${ACTION} .timeline-editor-action-right-stretch`).first(), -60);
  await expect
    .poll(async () => (await page.locator(ACTION).first().boundingBox())!.width, { timeout: 10_000 })
    .toBeLessThan(widthBefore - 5);

  // ---- move: drag the clip body right, its left edge shifts ----
  const xBefore = (await page.locator(ACTION).first().boundingBox())!.x;
  await dragBy(page, page.locator(ACTION).first(), 70);
  await expect.poll(async () => (await page.locator(ACTION).first().boundingBox())!.x, { timeout: 10_000 }).toBeGreaterThan(xBefore + 5);

  // ---- inspector edit changes clip geometry ----
  await page.locator(ACTION).first().click();
  const widthPreEdit = (await page.locator(ACTION).first().boundingBox())!.width;
  await page.locator('.inspector label.num-field:has-text("Duration") input').fill("6");
  await expect.poll(async () => (await page.locator(ACTION).first().boundingBox())!.width, { timeout: 8_000 }).toBeGreaterThan(widthPreEdit + 5);

  // ---- duplicate then delete via the inspector: clip count changes both ways ----
  await page.locator('.inspector button:has-text("Duplicate")').click();
  await expect(page.locator(ACTION)).toHaveCount(2, { timeout: 8_000 });
  await page.locator('.inspector button:has-text("Delete")').click();
  await expect(page.locator(ACTION)).toHaveCount(1, { timeout: 8_000 });

  // ---- zoom in: pixels-per-second increases ----
  const zoomBefore = parseInt(((await page.locator(".zoom-read").textContent()) || "0").replace(/\D/g, ""), 10);
  await page.locator(".preview-stage").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("=");
  await expect.poll(async () => parseInt(((await page.locator(".zoom-read").textContent()) || "0").replace(/\D/g, ""), 10), { timeout: 8_000 }).toBeGreaterThan(zoomBefore);

  // ---- save a version, then reload and prove the timeline is reproduced ----
  await page.click('button:has-text("Save version")');
  await expect(page.locator(".save-state")).toHaveText(/Saved/, { timeout: 15_000 });

  await page.reload();
  // Session token persists across reload, so the app boots straight into the editor.
  await expect(page.locator(".timeline-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(ACTION)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(".stage-frame video")).toHaveCount(1);

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

const VIDEO = `${ACTION}:has(.clip-video)`;
const CAPTION = `${ACTION}:has(.clip-caption)`;

async function signInCreateImport(page: Page, projectName: string): Promise<void> {
  await page.goto("/");
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button:has-text("Sign in")');
  const firstProject = page.locator('button:has-text("Create your first project")');
  const toolbarNew = page.locator('.toolbar button:has-text("New")');
  await expect(firstProject.or(toolbarNew)).toBeVisible();
  if (await firstProject.isVisible()) await firstProject.click();
  else await toolbarNew.click();
  await page.fill(".modal input", projectName);
  await page.click('.modal button:has-text("Create")');
  await expect(page.locator(".timeline-panel")).toBeVisible();
  await page.setInputFiles('input[type="file"]', MP4);
  await expect(page.locator(".bin-item")).toHaveCount(1, { timeout: 20_000 });
}

/** Read a persisted numeric field for the currently selected clip from the inspector. */
function numField(page: Page, label: string): Locator {
  return page.locator(`.inspector label.num-field:has-text("${label}") input`);
}

/*
 * Real snapping proof. A move and a trim are performed with actual pointer drags that release a
 * few pixels SHORT of a neighbouring clip's boundary on ANOTHER track. If snapping is real, the
 * committed times land exactly on the boundary; after save + reload the persisted timeline state
 * (inspector Start/Duration) and the on-screen geometry both align to the boundary to the pixel.
 * This asserts persisted state and exact geometry, never a mere CSS guide.
 */
test("timeline editor: pointer move + trim snap to a neighbouring clip boundary (persisted)", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // A unique name keeps reruns deterministic even when Playwright reuses an already-running
  // local QA server that contains projects from an earlier failed run.
  const snapProjectName = `QA snap ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await signInCreateImport(page, snapProjectName);

  // Video clip [0, 4] on the video track (double-click adds at the playhead, which is 0).
  await page.locator(".bin-item").dblclick();
  await expect(page.locator(VIDEO)).toHaveCount(1, { timeout: 15_000 });

  // A caption clip [0, 2] on the caption track: a real boundary on a DIFFERENT track to snap to.
  await page.click('button:has-text("Text")');
  await expect(page.locator(CAPTION)).toHaveCount(1, { timeout: 10_000 });

  // ---- TRIM SNAP: drag the video's right edge left to release ~4px past the caption's end (t=2).
  // The video stays anchored at 0; only its right edge should snap onto the caption boundary.
  {
    const vBox = (await page.locator(VIDEO).boundingBox())!;
    const capBox = (await page.locator(CAPTION).boundingBox())!;
    const captionEndX = capBox.x + capBox.width; // x of t = caption.end (2)
    const dx = captionEndX + 4 - (vBox.x + vBox.width); // land a few px right of the boundary
    await dragBy(page, page.locator(`${VIDEO} .timeline-editor-action-right-stretch`).first(), dx);
    // The right edge snapped to the caption end: video width now equals the caption width (both 2s).
    await expect
      .poll(async () => (await page.locator(VIDEO).boundingBox())!.width, { timeout: 10_000 })
      .toBeLessThan(vBox.width - 5);
  }

  // ---- MOVE SNAP: drag the caption body right to release ~4px short of the video's new end (t=2).
  {
    const vBox = (await page.locator(VIDEO).boundingBox())!;
    const capBox = (await page.locator(CAPTION).boundingBox())!;
    const videoEndX = vBox.x + vBox.width; // x of t = video.end (2 after the trim)
    const dx = videoEndX - 4 - capBox.x; // land a few px short of the boundary
    await dragBy(page, page.locator(CAPTION).first(), dx);
    // The caption's left edge snapped onto the video's right edge (same instant, t=2).
    await expect
      .poll(async () => {
        const v = (await page.locator(VIDEO).boundingBox())!;
        const c = (await page.locator(CAPTION).boundingBox())!;
        return Math.abs(v.x + v.width - c.x);
      }, { timeout: 10_000 })
      .toBeLessThanOrEqual(2);
  }

  // ---- persist, reload, and prove the SAVED state landed exactly on the boundary ----
  await page.click('button:has-text("Save version")');
  await expect(page.locator(".save-state")).toHaveText(/Saved/, { timeout: 15_000 });
  await page.reload();
  await expect(page.locator(".timeline-panel")).toBeVisible({ timeout: 20_000 });
  // The server + DB are shared across tests, so boot selects the first project. Reselect this
  // test's project so the reload proves ITS persisted timeline. The caption is unique to it.
  await page.selectOption(".project-select", { label: snapProjectName });
  await expect(page.locator(CAPTION)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(VIDEO)).toHaveCount(1, { timeout: 20_000 });

  // Persisted timeline state: the video was trimmed to exactly [0, 2].
  await page.locator(VIDEO).click();
  await expect(numField(page, "Start (s)")).toHaveValue("0");
  await expect(numField(page, "Duration (s)")).toHaveValue("2");

  // Persisted timeline state: the caption moved to exactly [2, 4] (start snapped to the video end).
  await page.locator(CAPTION).click();
  await expect(numField(page, "Start (s)")).toHaveValue("2");
  await expect(numField(page, "Duration (s)")).toHaveValue("2");

  // Exact geometry after reload: the video's right edge and the caption's left edge coincide (t=2).
  const v = (await page.locator(VIDEO).boundingBox())!;
  const c = (await page.locator(CAPTION).boundingBox())!;
  expect(Math.abs(v.x + v.width - c.x)).toBeLessThanOrEqual(2);

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

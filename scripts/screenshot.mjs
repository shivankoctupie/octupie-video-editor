/* Design self-audit: drive the editor and capture screenshots at 1280/768/375, reporting
 * horizontal overflow at each width. Requires the e2e server running and a built client. */
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const PORT = process.env.E2E_PORT || 8123;
const TOKEN = process.env.E2E_TOKEN || "e2e-admin-token-0123456789abcdef";
const MP4 = resolve(process.cwd(), "output", "founder-reel.mp4");
const outDir = resolve(process.cwd(), "output", "shots");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.fill('input[type="password"]', TOKEN);
await page.click('button:has-text("Sign in")');
const first = page.locator('button:has-text("Create your first project")');
const nb = page.locator('.toolbar button:has-text("New")');
await first.or(nb).first().waitFor();
if (await first.isVisible()) await first.click();
else await nb.click();
await page.fill(".modal input", "Demo reel");
await page.click('.modal button:has-text("Create")');
await page.locator(".timeline-panel").waitFor();
await page.setInputFiles('input[type="file"]', MP4);
await page.locator(".bin-item").first().waitFor();
await page.locator(".bin-item").first().dblclick();
await page.locator(".timeline-editor-action").first().waitFor();
await page.locator(".timeline-editor-action").first().click();
await page.waitForTimeout(700);

const report = {};
await page.screenshot({ path: resolve(outDir, "editor-1280.png") });
report.o1280 = await overflow();
await page.setViewportSize({ width: 768, height: 900 });
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(outDir, "editor-768.png") });
report.o768 = await overflow();
await page.setViewportSize({ width: 375, height: 780 });
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(outDir, "editor-375.png") });
report.o375 = await overflow();

process.stdout.write("OVERFLOW " + JSON.stringify(report) + "\n");
await browser.close();

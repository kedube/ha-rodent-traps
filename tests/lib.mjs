import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const cardPath = root + "dist/rodent-trap-card.js";
export const fixtureUrl = pathToFileURL(root + "tests/fixture.html").href;
export const demoUrl = pathToFileURL(root + "demo/index.html").href;

/** Installed Google Chrome (or CHROME_PATH); falls back to Playwright's own Chromium if present. */
export async function launch() {
  const opts = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" };
  try {
    return await chromium.launch(opts);
  } catch (e) {
    return chromium.launch();
  }
}

/** A page with console errors and uncaught exceptions collected into page.errors. */
export async function openPage(browser, url, options = {}) {
  const page = await browser.newPage(options);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") page.errors.push("console.error: " + m.text());
  });
  if (url) await page.goto(url);
  return page;
}

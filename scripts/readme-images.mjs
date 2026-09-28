// Regenerates the README images from the demo page:
//   images/card-dark.png  the whole card in a dark theme, most urgent traps first
//   images/snap.gif       one snap-trap tile: the mouse sniffs the cheese, then the trap catches it
//
//   npm run images                   both images
//   npm run images -- png            just the screenshot (or: gif)
//   npm run images -- --out=DIR      write to DIR instead of images/
//
// Needs Google Chrome (set CHROME_PATH to use another Chrome or Chromium) and, for the GIF, ffmpeg
// (on the PATH, or set FFMPEG_PATH). The GIF is recorded one screenshot at a time with the page's
// animations slowed to a fifth of their speed, then encoded with one palette for the whole GIF and ordered
// dithering (smaller than the default, and it doesn't shimmer from frame to frame):
//
//   ffmpeg -framerate 20 -i frames/f%04d.png -loop 0 images/snap.gif \
//     -vf "scale=560:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=5"
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const demoUrl = pathToFileURL(join(root, "demo", "index.html")).href;

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out="));
const outDir = outArg ? resolve(outArg.slice("--out=".length)) : join(root, "images");
const wanted = args.filter((a) => !a.startsWith("--"));
const make = (what) => !wanted.length || wanted.includes(what);

// The GIF, in animation time: it starts on an armed trap, the catch happens at CATCH_AT and it stops at END.
const GIF = { fps: 20, width: 560, rate: 0.2, catchAt: 4.6, end: 8.2 };

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
try {
  mkdirSync(outDir, { recursive: true });
  if (make("png")) await still("dark", "1000", 1.5, join(outDir, "card-dark.png"), "status");
  if (make("gif")) await gif(join(outDir, "snap.gif"));
} finally {
  await browser.close();
}

/** A screenshot of the whole card, with the peeking mice frozen mid-sniff. */
async function still(theme, width, scale, path, sort = "config") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: scale, colorScheme: theme });
  await page.goto(demoUrl);
  await page.selectOption("#width", width);
  await page.selectOption("#sort", sort);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await page.waitForTimeout(3000);
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  await page.locator("rodent-trap-card").screenshot({ path, animations: "allow" });
  await page.close();
  console.log("wrote", path);
}

/** The first tile (Garage) at phone width: frames at GIF.fps of animation time, then ffmpeg. */
async function gif(path) {
  const frames = mkdtempSync(join(tmpdir(), "rodent-trap-frames-"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "light" });
  await page.goto(demoUrl);
  await page.selectOption("#width", "400");
  await page.waitForTimeout(400);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: GIF.rate });
  const box = await page.locator("rodent-trap-card .tile").first().boundingBox();
  const clip = { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 };
  const step = 1000 / GIF.fps / GIF.rate; // real milliseconds per frame
  const t0 = Date.now();
  let clicked = false;
  let i = 0;
  for (;;) {
    const wait = t0 + i * step - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const seconds = ((Date.now() - t0) * GIF.rate) / 1000; // animation time
    if (!clicked && seconds >= GIF.catchAt) {
      clicked = true;
      await page.locator(".trap-ctl", { hasText: "Garage" }).getByRole("button", { name: "Catch!", exact: true }).click();
    }
    if (seconds > GIF.end) break;
    await page.screenshot({ path: join(frames, `f${String(i).padStart(4, "0")}.png`), clip });
    i++;
  }
  await page.close();

  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const filter = `scale=${GIF.width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
  const result = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(GIF.fps), "-i", join(frames, "f%04d.png"), "-vf", filter, "-loop", "0", path], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`ffmpeg failed${result.error ? ` (${result.error.message})` : ""}. The ${i} frames are in ${frames}.`);
    process.exitCode = 1;
    return;
  }
  rmSync(frames, { recursive: true, force: true });
  console.log("wrote", path, `(${i} frames)`);
}

// Runs every *.test.mjs suite in headless Chrome. Exits non-zero on any failure or page error.
import { readdirSync } from "node:fs";
import { launch } from "./lib.mjs";

const only = process.argv.slice(2);
const dir = new URL(".", import.meta.url);
const suites = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && (!only.length || only.some((o) => f.includes(o)))).sort();
const browser = await launch();
let failed = 0;
let passed = 0;
try {
  for (const file of suites) {
    const { default: run } = await import(new URL(file, dir));
    console.log(`\n# ${file}`);
    let result;
    try {
      result = await run(browser);
    } catch (e) {
      console.log(`FAIL ${file} threw: ${e && e.stack ? e.stack : e}`);
      failed++;
      continue;
    }
    for (const line of result.lines) {
      console.log(line);
      if (line.startsWith("FAIL")) failed++;
      else if (line.startsWith("ok")) passed++;
    }
    for (const err of result.errors || []) {
      console.log(`FAIL page error: ${err}`);
      failed++;
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Source rules for the card: it parses as ES2018 so older wall tablets and WebViews can load it, has no
// lookbehind regexes (Safari before 16.4), is plain ASCII and passes node --check. Also runs CI's ASCII guard.
import { parse, tokenizer } from "acorn";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { cardPath, root } from "./lib.mjs";

export default async function run() {
  const lines = [];
  const check = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    lines.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
  };
  const src = readFileSync(cardPath, "utf8");

  const es2018 = (code) => {
    try {
      parse(code, { ecmaVersion: 2018, sourceType: "script" });
      return "ok";
    } catch (e) {
      return e.message;
    }
  };
  check("card parses as ES2018", es2018(src), "ok");
  // The check has teeth: newer syntax is rejected.
  for (const [what, code] of [["??", "a ?? b"], ["?.", "a?.b"], ["class fields", "class A { x = 1 }"], ["numeric separators", "1_000"]]) {
    check(`ES2018 check rejects ${what}`, es2018(code) !== "ok", true);
  }

  const lookbehind = (code) => {
    const found = [];
    for (const t of tokenizer(code, { ecmaVersion: 2018, locations: true })) {
      if (t.type.label === "regexp" && /\(\?<[=!]/.test(t.value.pattern)) found.push(t.loc.start.line);
    }
    return found;
  };
  check("no lookbehind regexes", lookbehind(src), []);
  check("lookbehind check finds one", lookbehind("const a = 1;\nconst r = /(?<!x)y/;"), [2]);

  const nonAscii = src.split("\n").map((l, i) => (/[^\x00-\x7f]/.test(l) ? i + 1 : 0)).filter(Boolean);
  check("card is plain ASCII", nonAscii, []);
  check("node --check passes", spawnSync(process.execPath, ["--check", cardPath]).status, 0);

  // CI's guards, run as CI runs them.
  const syntax = YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).jobs.syntax.steps;
  const runs = syntax.map((s) => s.run || "");
  check("CI checks syntax", runs.includes("node --check dist/rodent-trap-card.js"), true);
  check("CI parses the card as ES2018", runs.includes("npx --yes acorn@8 --ecma2018 --silent dist/rodent-trap-card.js"), true);
  const ascii = syntax.find((s) => /ASCII/.test(s.name || ""));
  check("CI has an ASCII guard", !!ascii, true);
  if (ascii) {
    const dir = mkdtempSync(join(tmpdir(), "rtc-ascii-"));
    try {
      mkdirSync(join(dir, "dist"));
      const guard = (text) => {
        writeFileSync(join(dir, "dist/rodent-trap-card.js"), text);
        const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", ascii.run], { cwd: dir, encoding: "utf8" });
        return { status: r.status, out: r.stdout.trim() };
      };
      check("ASCII guard passes the card", guard(src).status, 0);
      const bad = guard('const a = 1;\nconst b = 2;\nconst c = "café";\n');
      check("ASCII guard fails on a non-ASCII character", bad.status, 1);
      check("ASCII guard names the line", bad.out, "::error file=dist/rodent-trap-card.js,line=3::Non-ASCII character. Write it as a \\u escape.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { lines };
}

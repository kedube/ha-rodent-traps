// Repository checks: what gates a release in CI (and with which token and actions), hacs.json, the README's
// links and images, the issue forms, and the README image script, which runs for real into a scratch folder.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  const read = (p) => readFileSync(join(root, p), "utf8");

  // --- Workflows
  const wfDir = ".github/workflows";
  const workflows = readdirSync(join(root, wfDir)).filter((f) => /\.ya?ml$/.test(f));
  for (const f of workflows) check(`${f}: read-only token by default`, YAML.parse(read(`${wfDir}/${f}`)).permissions, { contents: "read" });
  check("only ci.yml publishes releases", workflows.filter((f) => /gh release/.test(read(`${wfDir}/${f}`))), ["ci.yml"]);
  const ci = YAML.parse(read(`${wfDir}/ci.yml`));
  check("CI: pushes run on main only", ci.on.push, { branches: ["main"] });
  check("CI: runs on pull requests and by hand", ["pull_request", "workflow_dispatch"].filter((k) => !(k in ci.on)), []);
  check("CI: test job runs npm ci and npm test", ci.jobs.test.steps.map((s) => s.run).filter(Boolean), ["npm ci", "npm test"]);
  const release = ci.jobs.release;
  check("release: waits for syntax and tests, not HACS", [...release.needs].sort(), ["syntax", "test"]);
  check("release: main only, on push or by hand", release.if, "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
  check("release: the only job with a write token", Object.keys(ci.jobs).filter((j) => ci.jobs[j].permissions), ["release"]);
  check("release: write token", release.permissions, { contents: "write" });
  check("release: one at a time, never cancelled", release.concurrency, { group: "release", "cancel-in-progress": false });
  const uses = release.steps.filter((s) => s.uses).map((s) => s.uses);
  check("release: actions pinned to a commit", uses.filter((u) => !/@[0-9a-f]{40}$/.test(u)), []);
  check("release: no setup-node", uses.filter((u) => u.includes("setup-node")), []);
  const checkout = release.steps.find((s) => s.uses && s.uses.startsWith("actions/checkout@"));
  check("release: checks out the tested commit, with tags", checkout && checkout.with, { ref: "${{ github.sha }}", "fetch-depth": 0 });
  const bump = release.steps.find((s) => s.id === "bump") || { run: "" };
  check("release: node --check after the version bump", bump.run.indexOf("node --check") > bump.run.indexOf("sed "), true);
  const publish = release.steps.find((s) => /gh release create/.test(s.run || "")) || { run: "" };
  check("release: own notes plus GitHub's", [/-F "\$notes"/.test(publish.run), /--generate-notes/.test(publish.run)], [true, true]);

  // --- hacs.json
  const hacs = JSON.parse(read("hacs.json"));
  const HACS_KEYS = ["name", "content_in_root", "filename", "country", "homeassistant", "hacs", "hide_default_branch", "persistent_directory", "zip_release"];
  check("hacs.json: only keys HACS reads", Object.keys(hacs).filter((k) => !HACS_KEYS.includes(k)), []);
  check("hacs.json: filename is the card", existsSync(join(root, "dist", hacs.filename)), true);

  // --- README
  const readme = read("README.md");
  const prose = readme.replace(/```[\s\S]*?```/g, "");
  const slugs = new Set();
  for (const m of prose.matchAll(/^#{1,6} +(.+)$/gm)) {
    const s = m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, "").replace(/ /g, "-");
    let u = s;
    for (let n = 1; slugs.has(u); n++) u = `${s}-${n}`;
    slugs.add(u);
  }
  const links = [...prose.matchAll(/\]\(([^)\s]+)\)/g), ...prose.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  const local = links.filter((l) => !/^[a-z]+:/i.test(l));
  check("README: relative links point at files", local.filter((l) => !l.startsWith("#") && !existsSync(join(root, l.split("#")[0]))), []);
  check("README: #links point at headings", local.filter((l) => l.startsWith("#") && !slugs.has(l.slice(1))), []);
  const imgSrc = [...prose.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  check("README: hero GIF from main by full URL", imgSrc[0], "https://raw.githubusercontent.com/kedube/ha-rodent-traps/main/images/snap.gif");
  check("README: HTML images use full URLs (HACS doesn't rewrite them)", imgSrc.filter((s) => !s.startsWith("https://")), []);
  check("README: no <picture>", /<picture/i.test(readme), false);
  const raw = [...readme.matchAll(/https:\/\/raw\.githubusercontent\.com\/kedube\/ha-rodent-traps\/main\/([^\s"')]+)/g)].map((m) => m[1]);
  check("README: raw URLs point at files in the repo", raw.filter((p) => !existsSync(join(root, p))), []);
  check("README: every file in images/ is used", readdirSync(join(root, "images")).filter((f) => !readme.includes(`images/${f}`)), []);
  const spdx = (readFileSync(cardPath, "utf8").match(/SPDX-License-Identifier: (\S+)/) || [])[1];
  check("README: license matches the card's SPDX identifier", readme.includes(`[${spdx}](LICENSE)`), true);
  check("README: says which Home Assistant the automations need", /Home Assistant 2024\.10 and later/.test(readme), true);
  check("README: documents npm test and npm run images", ["npm test", "npm run images"].filter((s) => !readme.includes(s)), []);

  // --- Issue forms
  const form = YAML.parse(read(".github/ISSUE_TEMPLATE/bug_report.yml"));
  check("bug report: name, description and body", [typeof form.name, typeof form.description, Array.isArray(form.body)], ["string", "string", true]);
  const TYPES = ["markdown", "input", "textarea", "dropdown", "checkboxes"];
  check("bug report: known field types", form.body.map((f) => f.type).filter((t) => !TYPES.includes(t)), []);
  const fields = form.body.filter((f) => f.type !== "markdown");
  const ids = fields.map((f) => f.id);
  check("bug report: every field has a valid id and a label", fields.filter((f) => !/^[A-Za-z0-9_-]+$/.test(f.id || "") || !(f.attributes && f.attributes.label)).length, 0);
  check("bug report: ids are unique", ids.length === new Set(ids).size, true);
  check("bug report: asks for versions, setup, config and entities", ["card-version", "ha-version", "install", "browser", "integration", "config", "entities"].filter((i) => !ids.includes(i)), []);
  check("bug report: dropdowns have options", fields.filter((f) => f.type === "dropdown" && !(f.attributes.options || []).length).length, 0);
  const cfg = YAML.parse(read(".github/ISSUE_TEMPLATE/config.yml"));
  check("issue chooser: links have name, url and about", cfg.contact_links.every((l) => l.name && l.url && l.about), true);
  const trouble = cfg.contact_links.find((l) => /troubleshooting/i.test(l.name)) || { url: "" };
  check("issue chooser links Troubleshooting", [trouble.url, slugs.has("troubleshooting")], ["https://github.com/kedube/ha-rodent-traps#troubleshooting", true]);

  // --- README image script
  const scriptPath = join(root, "scripts/readme-images.mjs");
  const script = readFileSync(scriptPath, "utf8");
  check("images script: parses", spawnSync(process.execPath, ["--check", scriptPath]).status, 0);
  check("images script: no machine-specific paths", /\/Users\/|\/Applications\/|file:\/\/\//.test(script), false);
  check("images script: paths from import.meta.url, Chrome from CHROME_PATH", [/import\.meta\.url/.test(script), /process\.env\.CHROME_PATH/.test(script)], [true, true]);
  check("images script: npm run images", JSON.parse(read("package.json")).scripts.images, "node scripts/readme-images.mjs");
  const out = mkdtempSync(join(tmpdir(), "rtc-images-"));
  try {
    const r = spawnSync(process.execPath, [scriptPath, "png", `--out=${out}`], { encoding: "utf8", timeout: 90000 });
    const png = join(out, "card-dark.png");
    const bytes = existsSync(png) ? readFileSync(png) : Buffer.alloc(0);
    check("images script: writes the screenshot", [r.status, bytes.subarray(1, 4).toString(), bytes.length > 50000], [0, "PNG", true]);
    check("images script: full-width card at 1.5x", bytes.length > 24 && bytes.readUInt32BE(16) > 1200, true);
    if (r.status !== 0) lines.push(`FAIL images script output: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return { lines };
}

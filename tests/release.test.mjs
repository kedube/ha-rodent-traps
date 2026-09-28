// Replays the release job from .github/workflows/ci.yml, step by step, against scratch Git repositories:
// when it skips, how it numbers versions, what it commits and pushes, the release notes it writes, and what
// happens when main moves on or the push is refused. `gh` is a stub that records the call and tags the target.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { cardPath, root } from "./lib.mjs";

const CHECKOUT = /^actions\/checkout@/;
const GH_STUB = `#!/bin/bash
# Stand-in for the GitHub CLI: records the call, keeps the notes file and tags --target like a real release.
set -e
[ "$1 $2" = "release create" ] || { echo "unexpected gh call: $*" >&2; exit 2; }
[ -n "$GH_TOKEN" ] || { echo "GH_TOKEN not set" >&2; exit 2; }
printf '%s\\n' "$@" > "$STUB_DIR/gh-args"
tag=$3
while [ $# -gt 0 ]; do
  case $1 in
    -F) cp "$2" "$STUB_DIR/gh-notes"; shift ;;
    --target) target=$2; shift ;;
  esac
  shift
done
[ "$STUB_FAIL" != 1 ] || { echo "HTTP 502" >&2; exit 1; }
git tag "$tag" "$target"
git push -q origin "refs/tags/$tag"
`;

export default async function run() {
  const lines = [];
  const check = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    lines.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
  };

  const job = YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).jobs.release;
  const card = readFileSync(cardPath, "utf8");
  const hacs = readFileSync(join(root, "hacs.json"), "utf8");
  const withVersion = (v) => card.replace(/^( *const VERSION = )"[^"]*";/m, `$1"${v}";`);
  const versionOf = (text) => (text.match(/^ *const VERSION = "([^"]*)";/m) || [])[1];

  // Git with no user or system config, so a developer's signing or hook settings can't leak in.
  const base = mkdtempSync(join(tmpdir(), "rtc-release-"));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  env.PATH = [bin, dirname(process.execPath), env.PATH].join(":");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const devGit = (cwd, ...args) => git(cwd, "-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args);

  let count = 0;
  /** A bare origin and a developer clone holding the card at `version`, released as `tags` (the last one at HEAD). */
  function repo({ version = "1.1", tags = ["1.1"] } = {}) {
    const dir = join(base, `repo${++count}`);
    const origin = join(dir, "origin.git");
    const dev = join(dir, "dev");
    mkdirSync(dir);
    git(dir, "init", "-q", "--bare", origin);
    git(dir, "clone", "-q", origin, dev);
    mkdirSync(join(dev, "dist"));
    writeFileSync(join(dev, "dist/rodent-trap-card.js"), withVersion(version));
    writeFileSync(join(dev, "hacs.json"), hacs);
    writeFileSync(join(dev, "README.md"), "# Rodent Trap Card\n");
    devGit(dev, "add", "-A");
    devGit(dev, "commit", "-q", "-m", "Initial");
    for (const t of tags) git(dev, "tag", t);
    git(dev, "push", "-q", "origin", "HEAD:main", "--tags");
    const r = {
      dir,
      origin,
      /** Commit and push as the developer. `files` maps a path to new content or to a function of the old. */
      push(subject, files, body) {
        git(dev, "fetch", "-q", "origin");
        git(dev, "reset", "-q", "--hard", "origin/main");
        for (const [p, c] of Object.entries(files)) {
          const path = join(dev, p);
          writeFileSync(path, typeof c === "function" ? c(readFileSync(path, "utf8")) : c);
        }
        devGit(dev, "commit", "-q", "-a", "-m", subject, ...(body ? ["-m", body] : []));
        git(dev, "push", "-q", "origin", "HEAD:main");
        return git(dev, "rev-parse", "HEAD");
      },
      main: () => git(origin, "rev-parse", "main"),
      tags: () => git(origin, "tag", "--list").split("\n").filter(Boolean).sort(),
      show: (rev, path) => execFileSync("git", ["show", `${rev}:${path}`], { cwd: origin, env, encoding: "utf8" }),
      log: (rev) => git(origin, "log", "-1", "--format=%s|%an|%P", rev),
    };
    return r;
  }
  const cardChange = (n) => ({ "dist/rodent-trap-card.js": (s) => `${s}// change ${n}\n` });

  /** Runs the release job's steps for `sha` the way the runner does, honouring the steps' if: conditions. */
  function release(r, { event = "push", sha = r.main(), after = {}, stubFail = false } = {}) {
    const n = ++count;
    const work = join(r.dir, `run${n}`);
    const temp = join(r.dir, `temp${n}`);
    mkdirSync(temp);
    const outputs = {};
    const res = { ran: [], out: "", failed: null, gh: null, notes: null };
    const expr = (s) =>
      String(s).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (m, e) => {
        if (e === "github.token") return "test-token";
        if (e === "github.sha") return sha;
        const o = e.match(/^steps\.(\w+)\.outputs\.(\w+)$/);
        if (o) return (outputs[o[1]] || {})[o[2]] || "";
        throw new Error(`the test can't evaluate \${{ ${e} }}`);
      });
    const condition = (s) =>
      s.split("&&").every((part) => {
        const m = part.trim().match(/^steps\.(\w+)\.outputs\.(\w+) (==|!=) '([^']*)'$/);
        if (!m) throw new Error(`the test can't evaluate if: ${s}`);
        const v = (outputs[m[1]] || {})[m[2]] || "";
        return m[3] === "==" ? v === m[4] : v !== m[4];
      });
    for (const step of job.steps) {
      const name = step.name || step.uses;
      if (step.if && !condition(step.if)) continue;
      res.ran.push(name);
      if (step.uses) {
        if (!CHECKOUT.test(step.uses)) throw new Error(`the test can't run ${step.uses}`);
        git(r.dir, "clone", "-q", r.origin, work);
        git(work, "checkout", "-q", "--detach", expr(step.with.ref));
      } else {
        const outFile = join(temp, `output-${res.ran.length}`);
        writeFileSync(outFile, "");
        const stepEnv = { ...env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: outFile, RUNNER_TEMP: temp, STUB_DIR: temp, STUB_FAIL: stubFail ? "1" : "" };
        for (const [k, v] of Object.entries(step.env || {})) stepEnv[k] = expr(v);
        const p = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], { cwd: work, env: stepEnv, encoding: "utf8" });
        res.out += p.stdout + p.stderr;
        if (step.id) {
          outputs[step.id] = {};
          for (const line of readFileSync(outFile, "utf8").split("\n")) {
            const eq = line.indexOf("=");
            if (eq > 0) outputs[step.id][line.slice(0, eq)] = line.slice(eq + 1);
          }
        }
        if (p.status !== 0) {
          res.failed = name;
          break;
        }
      }
      if (step.id && after[step.id]) after[step.id]();
    }
    res.outputs = outputs;
    try {
      res.gh = readFileSync(join(temp, "gh-args"), "utf8").trim().split("\n");
      res.notes = readFileSync(join(temp, "gh-notes"), "utf8");
    } catch (e) {
      // gh wasn't called
    }
    return res;
  }

  try {
    // A push that changes only the README publishes nothing.
    {
      const r = repo();
      const pushed = r.push("Fix a README typo", { "README.md": "# Rodent Trap Card\n\nTypo fixed.\n" });
      const res = release(r);
      check("README-only push: skipped", res.outputs.version, { latest: "1.1", skip: "true" });
      check("README-only push: says why", /::notice::Nothing to release/.test(res.out), true);
      check("README-only push: no commit, tag or release", [r.main() === pushed, r.tags(), res.gh], [true, ["1.1"], null]);
    }

    // A card change publishes the next version, with the card commits as the notes.
    {
      const r = repo({ tags: ["1.0", "1.1"] });
      r.push("Show Offline when the node is dead", cardChange(1), "Z-Wave dead nodes were shown as unknown.\n\nCo-authored-by: Helper <helper@example.com>");
      r.push("Fix a README typo", { "README.md": "# Rodent Trap Card\n\nTypo fixed.\n" });
      const pushed = r.push("Keep the tooltip time current", cardChange(2));
      const res = release(r);
      const tip = r.main();
      check("card change: no failed step", res.failed, null);
      check("card change: next version", res.outputs.version, { latest: "1.1", next: "1.2" });
      check("card change: version commit on main", r.log("main"), `Release 1.2|github-actions[bot]|${pushed}`);
      check("card change: VERSION set in the card", versionOf(r.show("main", "dist/rodent-trap-card.js")), "1.2");
      check("card change: only VERSION changed", r.show("main", "dist/rodent-trap-card.js") === withVersion("1.2") + "// change 1\n// change 2\n", true);
      const notesPath = res.gh && res.gh[res.gh.indexOf("-F") + 1];
      check("card change: gh release create", res.gh, ["release", "create", "1.2", "dist/rodent-trap-card.js", "--target", tip, "--title", "1.2", "-F", notesPath, "--generate-notes"]);
      check("card change: tag on the version commit", [r.tags(), git(r.origin, "rev-parse", "1.2^{commit}") === tip], [["1.0", "1.1", "1.2"], true]);
      check("card change: release notes", res.notes, "- Keep the tooltip time current\n\n- Show Offline when the node is dead\n\n  Z-Wave dead nodes were shown as unknown.\n");

      // The next README-only push, made after `git pull --rebase`, has nothing new to ship.
      const after = release(r, { sha: r.push("Reword the README", { "README.md": "# Rodent Trap Card\n\nReworded.\n" }) });
      check("README push after a release: skipped", after.outputs.version, { latest: "1.2", skip: "true" });
    }

    // hacs.json is part of what HACS installs.
    {
      const r = repo();
      r.push("Hide the default branch in HACS", { "hacs.json": (s) => JSON.stringify({ ...JSON.parse(s), hide_default_branch: true }, null, 2) + "\n" });
      const res = release(r);
      check("hacs.json change: publishes 1.2", [res.failed, res.gh && res.gh[2]], [null, "1.2"]);
      check("hacs.json change: notes", res.notes, "- Hide the default branch in HACS\n");
    }

    // A manual run releases even when only the README changed.
    {
      const r = repo();
      r.push("Explain the release notes", { "README.md": "# Rodent Trap Card\n\nNotes.\n" });
      const res = release(r, { event: "workflow_dispatch" });
      check("manual run: publishes 1.2", [res.failed, res.outputs.version.skip, res.gh && res.gh[2]], [null, undefined, "1.2"]);
      check("manual run: says the card is unchanged", res.notes, "Documentation and maintenance only; the card itself is unchanged.\n");
    }

    // 1.9 is followed by 2.0; tags that aren't X.Y are ignored.
    {
      const r = repo({ version: "1.9", tags: ["1.0", "v7.0", "1.9", "1.9.1"] });
      r.push("Fix the station art", cardChange(1));
      const res = release(r);
      check("1.9 rolls over to 2.0", [res.outputs.version.latest, res.outputs.version.next, versionOf(r.show("main", "dist/rodent-trap-card.js"))], ["1.9", "2.0", "2.0"]);
    }

    // First release: the version already in the card, published at the pushed commit.
    {
      const r = repo({ version: "1.0", tags: [] });
      const pushed = r.main();
      const res = release(r);
      check("first release uses the card's VERSION", [res.outputs.version.latest, res.outputs.version.next], ["", "1.0"]);
      check("first release: no version commit needed", [r.main() === pushed, res.gh && res.gh[5] === pushed], [true, true]);
      check("first release: notes list the history", res.notes, "- Initial\n");
    }

    // Someone pushes while the job runs: the bot's push is refused, the job steps aside, the next run ships both.
    {
      const r = repo();
      const first = r.push("Fix the battery icon", cardChange(1));
      let second;
      const res = release(r, { sha: first, after: { version: () => (second = r.push("Update the README", { "README.md": "# Rodent Trap Card\n\nNew.\n" })) } });
      check("main moved: step succeeds without publishing", [res.failed, res.outputs.bump.skip, res.gh], [null, "true", null]);
      check("main moved: explains", /::notice::main moved on/.test(res.out), true);
      check("main moved: main and tags untouched", [r.main() === second, r.tags()], [true, ["1.1"]]);
      const next = release(r, { sha: second });
      check("main moved: the queued run publishes 1.2", [next.failed, next.gh && next.gh[2], r.log("main")], [null, "1.2", `Release 1.2|github-actions[bot]|${second}`]);
      check("main moved: notes include the earlier push", next.notes, "- Fix the battery icon\n");
    }

    // The push is refused while main hasn't moved (branch protection, say): the job fails.
    {
      const r = repo();
      const pushed = r.push("Fix the bait gauge", cardChange(1));
      const hook = join(r.origin, "hooks/pre-receive");
      writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/*) echo "protected branch" >&2; exit 1;; esac; done\n');
      chmodSync(hook, 0o755);
      const res = release(r);
      check("push refused: the job fails", res.failed, "Set the version in the card");
      check("push refused: explains", /::error::Couldn't push the version commit/.test(res.out), true);
      check("push refused: nothing published", [r.main() === pushed, r.tags(), res.gh], [true, ["1.1"], null]);
    }

    // The release call fails after the version commit landed: the next push, even README-only, retries it.
    {
      const r = repo();
      r.push("Fix the ping hold", cardChange(1));
      const failed = release(r, { stubFail: true });
      check("failed release: the publish step fails", [failed.failed, r.tags()], ["Publish the release", ["1.1"]]);
      const pushed = r.push("Update the README", { "README.md": "# Rodent Trap Card\n\nAgain.\n" });
      const retry = release(r, { sha: pushed });
      check("failed release: retried by the next push", [retry.failed, retry.gh && retry.gh[2], retry.gh && retry.gh[5] === pushed], [null, "1.2", true]);
      check("failed release: no second version commit", git(r.origin, "log", "--format=%s", "main").split("\n").filter((s) => s.startsWith("Release")), ["Release 1.2"]);
      check("failed release: notes", retry.notes, "- Fix the ping hold\n");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return { lines };
}

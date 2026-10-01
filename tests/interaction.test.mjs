// Long-press, confirmation, click suppression, update gating and the demo page.
import { demoUrl, fixtureUrl, openPage } from "./lib.mjs";

export default async function run(browser) {
  const lines = [];
  const errors = [];
  const check = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    lines.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
  };

  // --- Fixture: six Goodnature-style devices plus 2000 unrelated entities.
  const page = await openPage(browser, fixtureUrl);
  const r = await page.evaluate(async () => {
    const out = {};
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const st = (state, attributes = {}) => ({ state: String(state), attributes, last_changed: ago(0), last_updated: ago(0) });
    const states = {}, entities = {}, devices = {}, areas = { a: { area_id: "a", name: "Attic" } };
    for (let n = 1; n <= 6; n++) {
      devices["d" + n] = { id: "d" + n, name: "Goodnature Trap " + n, manufacturer: "Goodnature", area_id: "a" };
      for (const [id, s, at] of [
        ["sensor.gn" + n + "_strikes", 3], ["binary_sensor.gn" + n + "_kill_alert", "off"], ["binary_sensor.gn" + n + "_trap_armed", "on"],
        ["sensor.gn" + n + "_battery", 80, { unit_of_measurement: "%", device_class: "battery" }], ["sensor.gn" + n + "_lure_remaining", 170.2, { unit_of_measurement: "d" }],
        ["number.gn" + n + "_lure_life", 180], ["sensor.gn" + n + "_node_status", "asleep"], ["sensor.gn" + n + "_last_seen", ago(60), { device_class: "timestamp" }],
        ["button.gn" + n + "_clear_kill_alert", "unknown"], ["button.gn" + n + "_ping", "unknown"],
      ]) {
        states[id] = st(s, at || {});
        entities[id] = { entity_id: id, device_id: "d" + n };
      }
    }
    for (let i = 0; i < 2000; i++) states["light.l" + i] = st("on");
    const mk = (cfg, h) => { const c = document.createElement("rodent-trap-card"); document.body.appendChild(c); c.setConfig(cfg); c.hass = h; return c; };

    // Numeric YAML names don't crash sorting or tooltips.
    try {
      const c = mk({ sort: "name", traps: [{ name: 2, kill: "binary_sensor.gn1_kill_alert", holds: { kill: { entity: "button.gn1_ping", name: 5 } } }, { name: 1, location: 7 }] }, { states });
      out.numericNames = [...c.shadowRoot.querySelectorAll(".name")].map((e) => e.textContent.trim()).join(",");
      c.remove();
    } catch (e) {
      out.numericNames = "CRASH " + e.message;
    }

    const calls = [];
    const h = { states, entities, devices, areas, callService: async (...a) => { calls.push(a); } };
    const c = mk({ traps: [{ device: "d1" }] }, h);
    const sh = c.shadowRoot;
    const tileHead = () => sh.querySelector(".tile-head");
    const before = tileHead();
    c.hass = { ...h, states: { ...states, "light.l1": st("off") } };
    out.unrelatedKeepsDom = tileHead() === before;
    c.hass = { ...h, states: { ...states, "binary_sensor.gn1_kill_alert": st("on") } };
    out.relatedRepaints = sh.querySelector(".tile-head .chip").textContent.trim();
    const s2 = { ...states, "binary_sensor.gn1_kill_alert": st("on"), "button.gn1_ping": st("unknown", { friendly_name: "Goodnature Trap 1 Wake up" }) };
    c.hass = { ...h, states: s2 };
    out.actionNameTracked = /wake up/i.test(sh.querySelector(".m-link").getAttribute("title") || "");
    c.hass = { ...h, states: s2, devices: { ...devices, d1: { ...devices.d1, manufacturer: "Acme" } } };
    out.styleFollowsRegistry = sh.querySelector("svg.scene").getAttribute("class").includes("art-snap");

    // A long-press survives a repaint caused by a state update mid-press.
    const m = sh.querySelector(".m-link");
    m.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "touch" }));
    await new Promise((res) => setTimeout(res, 200));
    c.hass = { ...h, states: { ...s2, "sensor.gn1_battery": st(79, { unit_of_measurement: "%", device_class: "battery" }) }, devices: { ...devices, d1: { ...devices.d1, manufacturer: "Acme" } } };
    await new Promise((res) => setTimeout(res, 450));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
    out.holdSurvivesRepaint = !!sh.querySelector(".confirm");

    // The click that ends a long-press must not confirm; a fresh tap must.
    const yes = sh.querySelector('[data-confirm="yes"]');
    yes.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    out.ghostClickIgnored = !!sh.querySelector(".confirm") && calls.length === 0;
    const yes2 = sh.querySelector('[data-confirm="yes"]');
    yes2.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "touch" }));
    yes2.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    await new Promise((res) => setTimeout(res, 30));
    out.realTapConfirms = calls.length === 1 && calls[0][0] + "." + calls[0][1];

    out.sharedSheet = sh.adoptedStyleSheets.length >= 1 && document.querySelectorAll("rodent-trap-card").length >= 1;
    c.remove();
    return out;
  });
  check("numeric names sort without crashing", r.numericNames, "1,2");
  check("unrelated state change keeps the DOM", r.unrelatedKeepsDom, true);
  check("related state change repaints", r.relatedRepaints, "Catch detected");
  check("action friendly-name change is tracked", r.actionNameTracked, true);
  check("device registry change updates the style", r.styleFollowsRegistry, true);
  check("long-press survives a repaint", r.holdSurvivesRepaint, true);
  check("click ending a long-press does not confirm", r.ghostClickIgnored, true);
  check("a real tap confirms", r.realTapConfirms, "button.press");
  check("stylesheet adopted", r.sharedSheet, true);

  // The strike count-up stays between the old and new count when frame timestamps lag the page clock.
  // DevTools slow motion, used to record the README GIF, does this, and the GIF showed -7275 strikes.
  const countUp = await page.evaluate(async () => {
    const st = (s) => ({ state: String(s), attributes: {}, last_changed: new Date().toISOString(), last_updated: new Date().toISOString() });
    const c = document.createElement("rodent-trap-card");
    document.body.appendChild(c);
    c.setConfig({ traps: [{ name: "T", strikes: "sensor.s" }] });
    c.hass = { states: { "sensor.s": st(7) } };
    const raf = window.requestAnimationFrame;
    const seen = [];
    window.requestAnimationFrame = (cb) => raf((t) => cb(t - 20000));
    try {
      c.hass = { states: { "sensor.s": st(8) } };
      const el = c.shadowRoot.querySelector(".count[data-count-from]");
      const t0 = performance.now();
      while (el && performance.now() - t0 < 1300) {
        await new Promise((res) => raf(res));
        seen.push(el.textContent.trim());
      }
    } finally {
      window.requestAnimationFrame = raf;
      c.remove();
    }
    return { between: seen.length > 0 && seen.every((v) => v === "7" || v === "8"), last: seen[seen.length - 1], odd: seen.filter((v) => v !== "7" && v !== "8").slice(0, 3) };
  });
  check("strike count-up ignores lagging frame timestamps", countUp, { between: true, last: "8", odd: [] });
  errors.push(...page.errors);

  // --- Demo page: loads cleanly and shows every status.
  const demo = await openPage(browser, demoUrl, { viewport: { width: 1280, height: 900 } });
  await demo.waitForTimeout(600);
  const chips = await demo.evaluate(() =>
    [...document.querySelector("rodent-trap-card").shadowRoot.querySelectorAll(".tile .tile-head .chip")].map((c) => c.textContent.trim())
  );
  check("demo renders eight traps", chips.length, 8);
  for (const want of ["Catch detected", "Needs re-arm", "Offline", "Check trap"]) check(`demo shows "${want}"`, chips.includes(want), true);
  // A restart leaves the Garage trap's sensors unknown: grey "Status unknown", not green "Armed", until they report.
  const garage = await demo.evaluate(async () => {
    const card = document.querySelector("rodent-trap-card");
    const chip = () => {
      const tile = [...card.shadowRoot.querySelectorAll(".tile")].find((t) => t.querySelector(".name").textContent.trim() === "Garage");
      return tile.querySelector(".tile-head .chip").textContent.trim();
    };
    const press = (label) => [...document.querySelectorAll('.trap-ctl[data-trap="Garage"] button')].find((b) => b.textContent === label).click();
    const before = chip();
    press("Restart (unknown)");
    const restarted = chip();
    press("Empty & re-arm");
    return [before, restarted, chip()];
  });
  check("demo: restart shows Status unknown until the sensors report", garage, ["Armed", "Status unknown", "Armed"]);
  errors.push(...demo.errors);

  return { lines, errors };
}

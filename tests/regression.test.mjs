// Failures reproduced during the async, state and editor audit.
import { cardPath, fixtureUrl, openPage } from "./lib.mjs";

export default async function run(browser) {
  const page = await openPage(browser, fixtureUrl);
  const lines = await page.evaluate(async () => {
    const out = [];
    const check = (name, got, want) => out.push(`${JSON.stringify(got) === JSON.stringify(want) ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}`);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const st = (state, attributes = {}) => ({ state: String(state), attributes, last_changed: new Date().toISOString(), last_updated: new Date().toISOString() });
    const mount = (traps, hass) => {
      const c = document.createElement("rodent-trap-card");
      c.setConfig({ traps }); c.hass = hass; document.body.append(c); return c;
    };
    for (const [low, invert, expected] of [[false, false, false], [true, false, true], [false, true, true], [true, true, false]]) {
      const c = mount([{ battery: { entity: "sensor.b", attribute: "low", invert } }], { states: { "sensor.b": st("ok", { low }) } });
      check(`boolean low ${low}, inverted ${invert}`, c._tiles[0].model.battery.low, expected); c.remove();
    }
    {
      const c = mount([{ kill: "binary_sensor.k", co2: { entity: "sensor.shots", max: "number.capacity" } }], { states: { "binary_sensor.k": st("off"), "sensor.shots": st(6), "number.capacity": st(30) } });
      check("known capacity warns at 20 percent", c._tiles[0].model.label, "Low CO₂");
      for (const state of ["unavailable", "unknown"]) {
        c.hass = { states: { ...c.hass.states, "number.capacity": st(state) } };
        check(`invalid capacity ${state} never invents a range`, [c._tiles[0].model.co2.level, c._tiles[0].model.label], [null, "Range unavailable"]);
      }
      c.remove();
    }
    {
      const h = { devices: { d: { id: "d", name: "Trap" } }, entities: { "sensor.opaque": { entity_id: "sensor.opaque", device_id: "d" } }, states: { "sensor.opaque": st("unavailable") } };
      const c = mount([{ device: "d" }], h);
      c.hass = { ...h, states: { "sensor.opaque": st(75, { device_class: "battery", friendly_name: "Trap Battery" }) } };
      check("discovery recovers when state metadata arrives", c._tiles[0].model.battery.level, 75); c.remove();
    }
    {
      const actions = [{ entity: "switch.t", action: "switch.turn_on", name: "On" }, { entity: "switch.t", action: "switch.turn_off", name: "Off" }];
      const e = document.createElement("rodent-trap-card-editor"); e.hass = { states: {} }; e.setConfig({ traps: [{ actions }] }); document.body.append(e); await sleep(10);
      const form = () => e.shadowRoot.querySelectorAll("ha-form")[1];
      form().emit({ ...form().data, name: "Renamed" });
      check("renaming preserves distinct actions on the same entity", e._config.traps[0].actions, actions);
      e.setConfig({ traps: [{ actions }] });
      form().emit({ ...form().data, actions: ["switch.t", "switch.t", "button.new"] });
      check("adding a button preserves each duplicate occurrence", e._config.traps[0].actions, [...actions, "button.new"]);
      e.remove();
      for (const trap of [null, [], 42]) {
        let error = ""; try { e.setConfig({ traps: [trap] }); } catch (err) { error = err.message; }
        check("editor rejects invalid trap before rendering", error, "traps[0] must be a mapping of options.");
      }
    }
    {
      const c = mount([{ strikes: "sensor.n" }], { states: { "sensor.n": st(7) } });
      c.hass = { states: { "sensor.n": st(8) } }; await sleep(100);
      c.hass = { states: { "sensor.n": st(1000) } }; await sleep(1000);
      check("old animation cannot overwrite large new count", c.shadowRoot.querySelector(".count").textContent, "1000");
      c.hass = { states: { "sensor.n": st(1001) } }; await sleep(50);
      c.hass = { states: { "sensor.n": st(0) } }; await sleep(1000);
      check("count reset cancels animation", c.shadowRoot.querySelector(".count").textContent, "0"); c.remove();
    }
    {
      const c = mount([{ kill: "binary_sensor.k" }], { states: { "binary_sensor.k": st("off") } });
      let announced = false;
      const observer = new MutationObserver(() => { if (c._live.textContent === "Repeated alert") announced = true; });
      observer.observe(c._live, { childList: true });
      const timer = setInterval(() => c._say(["Repeated alert"]), 20);
      await sleep(230);
      check("continuous alerts flush before stream stops", announced, true);
      observer.disconnect();
      clearInterval(timer);
      c._say(Array.from({ length: 500 }, (_, i) => `Alert ${i}`));
      check("announcement queue stays bounded", c._saying.length <= 100, true); c.remove();
    }
    {
      const traps = Array.from({ length: 1000 }, (_, i) => ({ name: `Trap ${i}`, kill: "binary_sensor.k", actions: ["button.p"] }));
      let resolve;
      const c = mount(traps, { states: { "binary_sensor.k": st("off") }, callService: () => new Promise(r => { resolve = r; }) });
      check("large card mounts a bounded page", c.shadowRoot.querySelectorAll(".tile").length, 25);
      c._request(0, "act", "0");
      c.shadowRoot.querySelector('[data-page="1"]').click();
      resolve(); await sleep(10);
      check("next page and stale call result are isolated", [c._tiles[0].model.name, !!c.shadowRoot.querySelector(".flash")], ["Trap 25", false]);
      c.hass = { ...c.hass, states: { "binary_sensor.k": st("on") } };
      check("current page uses latest states", c._tiles[0].model.label, "Catch detected");
      c.shadowRoot.querySelector('[data-page="-1"]').click();
      check("returning page uses latest states", [c._tiles[0].model.name, c._tiles[0].model.label], ["Trap 0", "Catch detected"]);
      c.setConfig({ traps: [{ name: "Replacement" }] });
      check("new config resets paging", [c._tiles.length, c._tiles[0].model.name], [1, "Replacement"]); c.remove();
    }
    return out;
  });
  for (const stage of ["helpers", "tile", "editor", "reject"]) {
    const p = await openPage(browser);
    await p.setContent("<!doctype html><body></body>");
    await p.evaluate(stage => {
      const timeout = window.setTimeout;
      window.setTimeout = (fn, ms) => timeout(fn, ms === 5000 ? 50 : ms);
      window.loadCardHelpers = () => stage === "helpers" ? new Promise(() => {}) : stage === "reject" ? Promise.reject(new Error("load failed")) : Promise.resolve({ createCardElement() {} });
      if (stage === "editor") customElements.define("hui-tile-card", class extends HTMLElement { static getConfigElement() { return new Promise(() => {}); } });
    }, stage);
    await p.addScriptTag({ path: cardPath });
    await p.evaluate(() => { const e = document.createElement("rodent-trap-card-editor"); e.setConfig({ traps: [{}] }); document.body.append(e); });
    await p.waitForFunction(() => document.querySelector("rodent-trap-card-editor").shadowRoot.textContent.includes("couldn't load"));
    lines.push(`ok   ${stage} failure reaches editor fallback`);
    await p.evaluate(() => {
      window.loadCardHelpers = async () => { customElements.define("ha-form", class extends HTMLElement {}); return null; };
      document.querySelector("rodent-trap-card-editor").remove();
      const e = document.createElement("rodent-trap-card-editor"); e.setConfig({ traps: [{}] }); document.body.append(e);
    });
    await p.waitForFunction(() => !!document.querySelector("rodent-trap-card-editor").shadowRoot.querySelector("ha-form"));
    lines.push(`ok   ${stage} failure can retry loading`);
    page.errors.push(...p.errors); await p.close();
  }
  return { lines, errors: page.errors };
}

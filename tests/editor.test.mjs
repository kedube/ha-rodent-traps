// Visual editor round-tripping, using the ha-form stand-in from the fixture.
import { fixtureUrl, openPage } from "./lib.mjs";

export default async function run(browser) {
  const page = await openPage(browser, fixtureUrl);
  const lines = await page.evaluate(async () => {
    const out = [];
    const check = (name, got, want) => {
      const g = JSON.stringify(got);
      const w = JSON.stringify(want);
      out.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
    };
    const editor = document.createElement("rodent-trap-card-editor");
    const events = [];
    editor.addEventListener("config-changed", (e) => events.push(e.detail.config));
    editor.hass = {
      states: { "binary_sensor.gn_kill_alert": { state: "off", attributes: {} } },
      entities: { "binary_sensor.gn_kill_alert": { entity_id: "binary_sensor.gn_kill_alert", device_id: "gn" } },
      devices: { gn: { id: "gn", name: "GN" } },
      areas: {},
    };
    editor.setConfig({
      type: "custom:rodent-trap-card",
      stale_after: "12h",
      traps: [{
        device: "gn",
        holds: { catch: "button.a", online: { action: "zwave_js.ping", name: "Ping" } },
        actions: [{ entity: "script.x", name: "X" }, { action: "counter.reset", name: "R" }],
        offline_after: "2d",
      }],
    });
    document.body.appendChild(editor);
    await new Promise((r) => setTimeout(r, 50));
    const forms = () => [...editor.shadowRoot.querySelectorAll("ha-form")];
    const d = forms()[1].data;
    check("form data: style auto", d.style, "auto");
    check("form data: hold alias catch -> kill", d.hold_kill, "button.a");
    check("form data: service-only hold not shown", d.hold_link, undefined);
    check("form data: actions entity ids", d.actions, ["script.x"]);
    check("form data: duration as object", d.offline_after, { days: 2, hours: 0, minutes: 0, seconds: 0 });
    check("helper names the device entity", forms()[1].computeHelper({ name: "kill" }), "From device: binary_sensor.gn_kill_alert");
    check("battery hint says voltages need min and max", /voltage.*min and max/i.test(forms()[1].computeHelper({ name: "battery" })), true);

    forms()[1].emit({ ...d, hold_bait: "button.lure", actions: ["script.x", "button.new"] });
    const t = events.at(-1).traps[0];
    check("edit keeps holds (alias rewritten, service hold kept)", t.holds, { kill: "button.a", bait: "button.lure", online: { action: "zwave_js.ping", name: "Ping" } });
    check("edit keeps action objects and service-only actions", t.actions, [{ entity: "script.x", name: "X" }, "button.new", { action: "counter.reset", name: "R" }]);
    check("untouched duration keeps its YAML spelling", t.offline_after, "2d");
    check("style auto stays unset", t.style, undefined);

    editor.setConfig(events.at(-1));
    forms()[0].emit({ ...forms()[0].data });
    check("untouched card duration keeps its YAML spelling", events.at(-1).stale_after, "12h");
    forms()[1].emit({ ...forms()[1].data, style: "station", offline_after: { days: 3, hours: 0, minutes: 0, seconds: 0 } });
    check("style change written", events.at(-1).traps[0].style, "station");
    check("changed duration written", events.at(-1).traps[0].offline_after, { days: 3, hours: 0, minutes: 0, seconds: 0 });

    // Structural edits: add, move, remove.
    const e2 = document.createElement("rodent-trap-card-editor");
    const ev2 = [];
    e2.addEventListener("config-changed", (e) => ev2.push(e.detail.config));
    e2.hass = { states: {} };
    e2.setConfig({ type: "custom:rodent-trap-card", traps: [{ name: "A", kill: { entity: "binary_sensor.a", invert: true } }, { name: "B" }] });
    document.body.appendChild(e2);
    await new Promise((r) => setTimeout(r, 50));
    const f2 = () => [...e2.shadowRoot.querySelectorAll("ha-form")];
    check("one form per trap plus general", f2().length, 3);
    f2()[1].emit({ ...f2()[1].data, kill: "binary_sensor.z" });
    check("object ref keeps extra keys", ev2.at(-1).traps[0].kill, { entity: "binary_sensor.z", invert: true });
    e2.setConfig(ev2.at(-1));
    e2.shadowRoot.querySelector("button.add").click();
    check("add trap", ev2.at(-1).traps.length, 3);
    e2.shadowRoot.querySelectorAll("button.down")[0].click();
    check("move down", ev2.at(-1).traps.map((x) => x.name || "-"), ["B", "A", "-"]);
    e2.shadowRoot.querySelectorAll("button.del")[2].click();
    check("remove", ev2.at(-1).traps.map((x) => x.name || "-"), ["B", "A"]);

    // Low battery / Low bait: an emptied field stays empty while Home Assistant re-sends the config on each keystroke.
    const e3 = document.createElement("rodent-trap-card-editor");
    const ev3 = [];
    e3.addEventListener("config-changed", (e) => ev3.push(e.detail.config));
    e3.hass = { states: {} };
    e3.setConfig({ type: "custom:rodent-trap-card", bait_low: 30, traps: [{ name: "A" }] });
    document.body.appendChild(e3);
    await new Promise((r) => setTimeout(r, 50));
    const f3 = () => [...e3.shadowRoot.querySelectorAll("ha-form")];
    const lowFields = (schema) => schema.flatMap((x) => x.schema || [x]).filter((x) => /_low$/.test(x.name));
    check("thresholds: defaults are placeholders, not values", [f3()[0].data.battery_low, lowFields(f3()[0].schema).map((x) => x.default)], [undefined, [20, 25]]);
    const type = (patch) => { f3()[0].emit({ ...f3()[0].data, ...patch }); e3.setConfig(ev3.at(-1)); return [ev3.at(-1).battery_low, f3()[0].data.battery_low]; };
    check("thresholds: a cleared field isn't refilled", type({ battery_low: "" }), [undefined, undefined]);
    check("thresholds: typing after clearing gives the typed number", type({ battery_low: 2 }), [2, 2]);
    check("thresholds: a typed default is kept in the YAML", type({ battery_low: 20 }), [20, 20]);
    check("thresholds: the trap field names the card setting", [f3()[1].computeHelper({ name: "bait_low" }), f3()[1].computeHelper({ name: "battery_low" })],
      ["Blank = card setting (30%)", "Blank = card setting (20%)"]);
    return out;
  });
  return { lines, errors: page.errors };
}

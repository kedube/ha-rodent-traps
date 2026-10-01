// State interpretation, device discovery, actions and rendering, run inside the fixture page.
import { fixtureUrl, openPage } from "./lib.mjs";

export default async function run(browser) {
  const page = await openPage(browser, fixtureUrl);
  const lines = await page.evaluate(async () => {
  const out = [];
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const st = (state, attributes = {}, changed = ago(0)) => ({ state: String(state), attributes, last_changed: changed, last_updated: changed });
  const check = (name, got, expect) => {
    const fails = Object.entries(expect).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: expected ${JSON.stringify(v)} got ${JSON.stringify(got[k])}`);
    out.push(`${fails.length ? "FAIL" : "ok  "} ${name}${fails.length ? "  -> " + fails.join("; ") : ""}`);
  };
  function mount(config, hass) {
    const card = document.createElement("rodent-trap-card");
    document.body.appendChild(card);
    card.setConfig(config);
    card.hass = hass;
    return card;
  }
  function read(card, idx = 0) {
    const tile = card.shadowRoot.querySelectorAll(".tile")[idx];
    const got = {
      chip: tile.querySelector(".tile-head .chip").textContent.trim(),
      name: tile.querySelector(".name").textContent.trim(),
      loc: tile.querySelector(".loc")?.textContent.trim(),
      scene: tile.querySelector("svg.scene")?.getAttribute("class").match(/st-(\w+)/)[1],
      art: tile.querySelector("svg.scene")?.getAttribute("class").match(/art-(\w+)/)[1],
      banner: tile.querySelector(".banner .b-title")?.textContent.trim(),
    };
    for (const m of tile.querySelectorAll(".metric")) {
      const k = m.className.match(/m-(\w+)/)[1];
      got[k] = m.querySelector(".m-value").textContent.trim();
      got[k + "_label"] = m.querySelector(".m-label").textContent.trim();
      got[k + "_title"] = m.getAttribute("title");
      got[k + "_hold"] = m.dataset.hold || null;
      got[k + "_cls"] = m.className;
      const bars = m.querySelector(".ic-signal");
      if (bars) got[k + "_bars"] = bars.querySelectorAll("rect:not(.off)").length;
    }
    return got;
  }
  const run = (name, trap, states, expect, extra = {}) => {
    const card = mount({ traps: [trap], ...extra.card }, { states, ...extra.hass });
    check(name, read(card), expect);
    card.remove();
  };

  // 1. Connectivity words
  run("node_status asleep = online (Asleep)", { online: "sensor.ns" }, { "sensor.ns": st("asleep") }, { link: "Asleep", chip: "All good" });
  run("node_status alive = Online", { online: "sensor.ns" }, { "sensor.ns": st("alive") }, { link: "Online" });
  run("node_status awake = Online", { online: "sensor.ns" }, { "sensor.ns": st("awake") }, { link: "Online" });
  run("node_status dead = Offline", { online: "sensor.ns" }, { "sensor.ns": st("dead") }, { link: "Offline", chip: "Offline" });
  run("unreachable = Offline", { online: "sensor.ns" }, { "sensor.ns": st("Unreachable") }, { link: "Offline" });
  run("lost = Offline", { online: "sensor.ns" }, { "sensor.ns": st("lost") }, { link: "Offline" });
  run("unrecognised word = unknown, not online", { online: "sensor.ns", kill: "binary_sensor.k" }, { "sensor.ns": st("initialising"), "binary_sensor.k": st("off") }, { link: "—", chip: "Armed" });

  // 2/3. Armed role and disagreement
  run("armed on = Armed", { armed: "binary_sensor.a" }, { "binary_sensor.a": st("on") }, { trap: "Armed", chip: "Armed" });
  run("armed off = Needs re-arm", { armed: "binary_sensor.a" }, { "binary_sensor.a": st("off") }, { trap: "Re-arm", chip: "Needs re-arm", scene: "sprung" });
  run("armed off + rearm off = Check trap", { armed: "binary_sensor.a", rearm: "binary_sensor.r" }, { "binary_sensor.a": st("off"), "binary_sensor.r": st("off") }, { trap: "Check", chip: "Check trap", scene: "check", banner: "Sensors disagree" });
  run("armed on + rearm on = Check trap", { armed: "binary_sensor.a", rearm: "binary_sensor.r" }, { "binary_sensor.a": st("on"), "binary_sensor.r": st("on") }, { chip: "Check trap" });
  run("armed on + rearm off = Armed", { armed: "binary_sensor.a", rearm: "binary_sensor.r" }, { "binary_sensor.a": st("on"), "binary_sensor.r": st("off") }, { trap: "Armed", chip: "Armed" });
  run("armed off + rearm on = Needs re-arm", { armed: "binary_sensor.a", rearm: "binary_sensor.r" }, { "binary_sensor.a": st("off"), "binary_sensor.r": st("on") }, { chip: "Needs re-arm" });
  run("armed unknown + rearm on = Needs re-arm", { armed: "binary_sensor.a", rearm: "binary_sensor.r" }, { "binary_sensor.a": st("unknown"), "binary_sensor.r": st("on") }, { chip: "Needs re-arm" });

  // 4. max/min from an entity
  const lure = { "sensor.lure": st(178.9, { unit_of_measurement: "d", device_class: "duration" }), "number.life": st(180, { unit_of_measurement: "d" }) };
  run("max from entity: 178.9/180 d not low", { bait: { entity: "sensor.lure", max: "number.life" }, bait_low: 60 }, lure, { bait: "179 d", chip: "All good" });
  run("max from entity follows the entity (360 d)", { bait: { entity: "sensor.lure", max: "number.life" }, bait_low: 60 }, { ...lure, "number.life": st(360) }, { chip: "Low bait" });
  run("missing max entity is reported", { bait: { entity: "sensor.lure", max: "number.nope" } }, lure, { chip: "Entity not found" });

  // 5. low_entity
  run("battery low_entity overrides 80%", { battery: { entity: "sensor.b", low_entity: "binary_sensor.bl" } }, { "sensor.b": st(80, { unit_of_measurement: "%" }), "binary_sensor.bl": st("on") }, { battery: "80%", chip: "Low battery" });
  run("bait low_entity off beats threshold", { bait: { entity: "sensor.bait", low_entity: "binary_sensor.due" } }, { "sensor.bait": st(10, { unit_of_measurement: "%" }), "binary_sensor.due": st("off") }, { chip: "All good" });
  run("low_entity unknown falls back to threshold", { bait: { entity: "sensor.bait", low_entity: "binary_sensor.due" } }, { "sensor.bait": st(10, { unit_of_measurement: "%" }), "binary_sensor.due": st("unknown") }, { chip: "Low bait" });

  // 6. location/name from registry
  const reg = {
    entities: { "binary_sensor.k": { entity_id: "binary_sensor.k", device_id: "d1" }, "binary_sensor.k2": { entity_id: "binary_sensor.k2", device_id: "d1", area_id: "garage" } },
    devices: { d1: { id: "d1", name: "Trap Device", name_by_user: null, area_id: "attic" } },
    areas: { attic: { area_id: "attic", name: "Attic" }, garage: { area_id: "garage", name: "Garage" } },
  };
  run("location + name from device area", { kill: "binary_sensor.k" }, { "binary_sensor.k": st("off") }, { loc: "Attic", name: "Trap Device" }, { hass: reg });
  run("entity area beats device area", { kill: "binary_sensor.k2" }, { "binary_sensor.k2": st("off") }, { loc: "Garage" }, { hass: reg });
  run("explicit location wins; false hides", { kill: "binary_sensor.k", location: false, name: "Mine" }, { "binary_sensor.k": st("off") }, { loc: undefined, name: "Mine" }, { hass: reg });

  // 7. device discovery (Goodnature over Z-Wave)
  const gnStates = {}, gnEnt = {};
  const add = (id, state, attrs = {}, when) => { gnStates[id] = st(state, { friendly_name: "Mousetrap 1 " + (attrs.fn || id), ...attrs }, when); gnEnt[id] = { entity_id: id, device_id: "gn" }; };
  const p = "goodnature_trap_1";
  add(`sensor.${p}_strikes`, 7, { fn: "Strikes" });
  add(`event.${p}_strike`, ago(60 * 72), { fn: "Strike" });
  add(`binary_sensor.${p}_kill_alert`, "off", { fn: "Kill alert" });
  add(`binary_sensor.${p}_trap_armed`, "on", { fn: "Trap armed" });
  add(`binary_sensor.${p}_re_arm_required`, "off", { fn: "Re-arm required" });
  add(`sensor.${p}_battery`, 86, { fn: "Battery", unit_of_measurement: "%", device_class: "battery" });
  add(`binary_sensor.${p}_battery_low`, "off", { fn: "Battery low", device_class: "battery" });
  add(`sensor.${p}_lure_remaining`, 178.9, { fn: "Lure remaining", unit_of_measurement: "d", device_class: "duration" });
  add(`number.${p}_lure_life`, 180, { fn: "Lure life", unit_of_measurement: "d" });
  add(`binary_sensor.${p}_lure_due`, "off", { fn: "Lure due" });
  add(`sensor.${p}_node_status`, "asleep", { fn: "Node status" });
  add(`sensor.${p}_last_seen`, ago(60 * 11), { fn: "Last seen", device_class: "timestamp" });
  add(`button.${p}_clear_kill_alert`, "unknown", { fn: "Clear kill alert" });
  add(`button.${p}_lure_replaced`, "unknown", { fn: "Lure replaced" });
  add(`button.${p}_ping`, "unknown", { fn: "Ping" });
  const gnHass = { entities: gnEnt, devices: { gn: { id: "gn", name: "Goodnature Trap 1", name_by_user: "Mousetrap 1", manufacturer: "Goodnature", area_id: "attic" } }, areas: reg.areas };
  const calls = [];
  gnHass.callService = async (...a) => { calls.push(a); };
  const card = mount({ traps: [{ device: "gn" }] }, { states: gnStates, ...gnHass });
  const g = read(card);
  check("device: name, area, style, roles", g, {
    name: "Mousetrap 1", loc: "Attic", art: "goodnature", chip: "Armed",
    strikes: "7", last_strike: "3 d ago", battery: "86%", bait: "179 d", kill: "Clear", trap: "Armed", link: "Asleep", link_label: "Link", last_seen: "11 h ago", last_seen_label: "Last seen",
    kill_hold: "kill", bait_hold: "bait", link_hold: "link",
  });
  check("device: entity mapping", {
    kill: g.kill_title.includes(`binary_sensor.${p}_kill_alert`), trap: g.trap_title.includes(`binary_sensor.${p}_trap_armed`),
    link: g.link_title.includes(`sensor.${p}_node_status`), bait: g.bait_title.includes(`sensor.${p}_lure_remaining`),
  }, { kill: true, trap: true, link: true, bait: true });

  // device extras: lure_due and battery_low feed the level readings
  card.hass = { states: { ...gnStates, [`binary_sensor.${p}_lure_due`]: st("on"), [`binary_sensor.${p}_battery_low`]: st("on") }, ...gnHass };
  check("device: lure_due + battery_low alerts", read(card), { chip: "Low battery +1", bait_cls: read(card).bait_cls.includes("is-warn") ? read(card).bait_cls : "x" });
  card.hass = { states: { ...gnStates, [`binary_sensor.${p}_re_arm_required`]: st("off"), [`binary_sensor.${p}_trap_armed`]: st("off") }, ...gnHass };
  check("device: armed off + re-arm off = Check trap", read(card), { chip: "Check trap" });
  card.hass = { states: gnStates, ...gnHass };

  // 12. hold actions: long-press Catch -> confirm -> button.press
  const shadow = card.shadowRoot;
  const holdOn = async (sel) => {
    const el = shadow.querySelector(sel);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "touch", clientX: r.x + 5, clientY: r.y + 5 }));
    await new Promise((res) => setTimeout(res, 650));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
  };
  await holdOn(".metric.m-kill");
  const confirmText = shadow.querySelector(".confirm span")?.textContent;
  check("hold opens confirmation", { confirmText, calls: calls.length }, { confirmText: "Clear kill alert?", calls: 0 });
  shadow.querySelector('[data-confirm="yes"]').click();
  await new Promise((res) => setTimeout(res, 50));
  check("confirm runs button.press", { call: JSON.stringify(calls[0]), flash: shadow.querySelector(".flash")?.textContent }, { call: JSON.stringify(["button", "press", {}, { entity_id: `button.${p}_clear_kill_alert` }]), flash: "Clear kill alert: done" });
  await holdOn(".metric.m-bait");
  shadow.querySelector('[data-confirm="no"]').click();
  check("cancel does not run", { calls: calls.length, confirm: !!shadow.querySelector(".confirm") }, { calls: 1, confirm: false });
  // right-click = hold
  const bait = shadow.querySelector(".metric.m-bait");
  bait.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 2, pointerType: "mouse" }));
  bait.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
  check("right-click opens confirmation", { t: shadow.querySelector(".confirm span")?.textContent }, { t: "Lure replaced?" });
  shadow.querySelector('[data-confirm="yes"]').click();
  await new Promise((res) => setTimeout(res, 50));
  check("lure replaced pressed", { e: calls[1] && calls[1][3].entity_id }, { e: `button.${p}_lure_replaced` });
  // short tap still opens more-info
  let moreInfo = null;
  window.addEventListener("hass-more-info", (e) => (moreInfo = e.detail.entityId), { once: true });
  const kill = shadow.querySelector(".metric.m-kill");
  kill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "mouse" }));
  window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse" }));
  kill.click();
  check("tap = more-info", { moreInfo }, { moreInfo: `binary_sensor.${p}_kill_alert` });
  // holds can be disabled or overridden
  card.setConfig({ traps: [{ device: "gn", holds: { kill: false, online: { action: "zwave_js.ping", target: { entity_id: `sensor.${p}_node_status` }, name: "Wake up", confirm: false } } }] });
  card.hass = { states: gnStates, ...gnHass };
  const g2 = read(card);
  check("holds: false removes, alias overrides", { kill_hold: g2.kill_hold, link_hold: g2.link_hold }, { kill_hold: null, link_hold: "link" });
  await holdOn(".metric.m-link");
  check("confirm: false runs immediately", { e: calls[2] && calls[2].slice(0, 2).join(".") }, { e: "zwave_js.ping" });
  card.remove();

  // 13. actions list
  const acalls = [];
  const card2 = mount({ traps: [{ kill: "binary_sensor.k", actions: ["button.reset", { entity: "script.x", name: "Run X", confirm: "Really run X?" }, { action: "counter.reset", target: { entity_id: "counter.c" }, name: "Reset count" }] }] },
    { states: { "binary_sensor.k": st("off"), "button.reset": st("unknown", { friendly_name: "Reset trap" }), "script.x": st("off") }, callService: async (...a) => acalls.push(a) });
  const btns = [...card2.shadowRoot.querySelectorAll(".act")].map((b) => b.textContent.trim());
  check("actions render", { btns: btns.join("|") }, { btns: "Reset trap|Run X|Reset count" });
  card2.shadowRoot.querySelectorAll(".act")[0].click();
  await new Promise((res) => setTimeout(res, 30));
  check("action without confirm runs", { c: acalls[0] && acalls[0].slice(0, 2).join(".") }, { c: "button.press" });
  card2.shadowRoot.querySelectorAll(".act")[1].click();
  check("custom confirm text", { t: card2.shadowRoot.querySelector(".confirm span")?.textContent }, { t: "Really run X?" });
  card2.shadowRoot.querySelector('[data-confirm="yes"]').click();
  await new Promise((res) => setTimeout(res, 30));
  card2.shadowRoot.querySelectorAll(".act")[2].click();
  await new Promise((res) => setTimeout(res, 30));
  check("service action", { c: acalls.map((a) => a.slice(0, 2).join(".")).join(",") }, { c: "button.press,script.turn_on,counter.reset" });
  card2.remove();

  // 8. readable values
  run("duration rounds to whole days", { bait: "sensor.lure" }, { "sensor.lure": st(178.9, { unit_of_measurement: "d" }) }, { bait: "179 d" });
  run("display_unit weeks", { bait: { entity: "sensor.lure", display_unit: "weeks" } }, { "sensor.lure": st(178.9, { unit_of_measurement: "d" }) }, { bait: "26 wk" });
  run("display_unit months", { bait: { entity: "sensor.lure", display_unit: "months" } }, { "sensor.lure": st(178.9, { unit_of_measurement: "d" }) }, { bait: "6 mo" });
  run("sub-unit durations step down", { bait: "sensor.lure" }, { "sensor.lure": st(0.4, { unit_of_measurement: "d" }) }, { bait: "10 h" });
  run("display_precision from registry", { battery: "sensor.v" }, { "sensor.v": st(3.14159, { unit_of_measurement: "V" }) }, { battery: "3.142 V" }, { hass: { entities: { "sensor.v": { entity_id: "sensor.v", display_precision: 3 } } } });
  run("title shows full value", { bait: "sensor.g" }, { "sensor.g": st(1234.5, { unit_of_measurement: "grams" }) }, { bait: "1235 grams", bait_title: "Bait: 1235 grams\nsensor.g" });
  {
    const c = mount({ traps: [{ bait: "sensor.g" }] }, { states: { "sensor.g": st(1234.5, { unit_of_measurement: "grams" }) } });
    const v = c.shadowRoot.querySelector(".m-bait .m-value");
    check("long values fit, not ellipsised", { overflow: v.scrollWidth <= v.clientWidth + 1, cls: c.shadowRoot.querySelector(".m-bait").classList.contains("fit-s") }, { overflow: true, cls: true });
    c.remove();
  }

  // 9. last seen / last strike
  run("stale after threshold", { last_seen: "sensor.ls", kill: "binary_sensor.k" }, { "sensor.ls": st(ago(13 * 60), { device_class: "timestamp" }), "binary_sensor.k": st("off") }, { chip: "Not seen recently", last_seen: "13 h ago", last_seen_label: "Last seen, late" }, { card: { stale_after: "12h" } });
  run("offline after threshold", { last_seen: "sensor.ls", kill: "binary_sensor.k" }, { "sensor.ls": st(ago(49 * 60), { device_class: "timestamp" }), "binary_sensor.k": st("off") }, { chip: "Offline", scene: "offline" }, { card: { stale_after: "12h", offline_after: { days: 2 } } });
  run("per-trap threshold beats card", { last_seen: "sensor.ls", kill: "binary_sensor.k", offline_after: 1 }, { "sensor.ls": st(ago(90), { device_class: "timestamp" }), "binary_sensor.k": st("off") }, { chip: "Offline" }, { card: { offline_after: "2d" } });
  run("recent = fine", { last_seen: "sensor.ls", kill: "binary_sensor.k" }, { "sensor.ls": st(ago(60), { device_class: "timestamp" }), "binary_sensor.k": st("off") }, { chip: "Armed", last_seen: "1 h ago", last_seen_label: "Last seen" }, { card: { stale_after: "12h" } });
  run("event entity as strikes -> last strike", { strikes: "event.s" }, { "event.s": st(ago(3 * 1440), { event_type: "strike" }) }, { last_strike: "3 d ago", strikes: undefined });
  run("event never fired", { last_strike: "event.s" }, { "event.s": st("unknown") }, { last_strike: "—" });

  // 10. strike chip text
  for (const [n, txt] of [[1, "1 strike"], [22, "22 strikes"]]) {
    const c = mount({ traps: [{ strikes: "sensor.s" }] }, { states: { "sensor.s": st(n) } });
    check(`strike chip "${txt}"`, { t: c.shadowRoot.querySelector(".chip.total").textContent.trim() }, { t: txt });
    c.remove();
  }

  // 11. styles
  run("style station", { kill: "binary_sensor.k", style: "station" }, { "binary_sensor.k": st("on") }, { art: "station", scene: "kill" });
  run("card-level style", { kill: "binary_sensor.k" }, { "binary_sensor.k": st("off") }, { art: "goodnature" }, { card: { style: "goodnature" } });

  // regressions
  run("numeric kills_present > 0 = catch", { kill: "sensor.k" }, { "sensor.k": st(2) }, { chip: "Catch detected", kill: "Caught!", scene: "kill" });
  run("rssi numeric = online", { online: "sensor.rssi" }, { "sensor.rssi": st(-71, { unit_of_measurement: "dBm" }) }, { link: "Online" });
  run("input_number bait scaled 1/4", { bait: "input_number.b" }, { "input_number.b": st(1, { min: 0, max: 4 }) }, { bait: "1/4", chip: "Low bait" });
  run("inferred offline (all unavailable)", { kill: "binary_sensor.k", battery: "sensor.b" }, { "binary_sensor.k": st("unavailable"), "sensor.b": st("unavailable") }, { chip: "Offline" });
  for (const [label, cfg] of [["no traps", {}], ["bad ref", { traps: [{ kill: 5 }] }], ["actions not list", { traps: [{ actions: "button.x" }] }]]) {
    try { document.createElement("rodent-trap-card").setConfig(cfg); out.push(`FAIL validation ${label}`); }
    catch (e) { out.push(`ok   validation ${label}: ${e.message}`); }
  }
  // 14. CO2 shots: a canister of 24 unless max says otherwise, and co2_low (20%) is 4 shots of it.
  const shots = (n, attrs = { unit_of_measurement: "shots" }) => ({ "sensor.co2": st(n, attrs) });
  const has = (cls, c) => (cls || "").split(" ").includes(c);
  run("CO2: shots against a 24-shot canister", { co2: "sensor.co2" }, shots(22), { co2: "22 shots", co2_label: "CO₂", chip: "All good" });
  run("CO2: 4 of 24 shots is low", { co2: "sensor.co2" }, shots(4), { chip: "Low CO₂", co2_label: "CO₂ low" });
  run("CO2: 5 of 24 shots is not", { co2: "sensor.co2" }, shots(5), { chip: "All good", co2_label: "CO₂" });
  run("CO2: none left", { co2: "sensor.co2", kill: "binary_sensor.k" }, { ...shots(0), "binary_sensor.k": st("off") }, { chip: "Out of CO₂", co2_label: "Out of CO₂" });
  run("CO2: a count without a unit shows the canister size", { co2: "counter.co2" }, { "counter.co2": st(18) }, { co2: "18/24" });
  run("CO2: max sets another canister size", { co2: { entity: "sensor.co2", max: 30 } }, shots(5), { chip: "Low CO₂" });
  run("CO2: a percentage", { co2: "sensor.co2" }, shots(50, { unit_of_measurement: "%" }), { co2: "50%", chip: "All good" });
  run("CO2: co2_low on the trap", { co2: "sensor.co2", co2_low: 50 }, shots(10), { chip: "Low CO₂" });
  run("CO2: co2_low on the card", { co2: "sensor.co2" }, shots(10), { chip: "Low CO₂" }, { card: { co2_low: 50 } });
  run("CO2: the device's low alert beats the threshold", { co2: { entity: "sensor.co2", low_entity: "binary_sensor.co2_low" } },
    { ...shots(22), "binary_sensor.co2_low": st("on") }, { co2: "22 shots", chip: "Low CO₂" });
  run("CO2: unavailable is a dash", { co2: "sensor.co2", kill: "binary_sensor.k" }, { "sensor.co2": st("unavailable"), "binary_sensor.k": st("off") }, { co2: "—", chip: "Armed" });
  {
    const c = mount({ traps: [{ co2: "sensor.co2", style: "goodnature" }, { co2: "sensor.co2b", style: "goodnature" }] },
      { states: { ...shots(0), "sensor.co2b": st(3, { unit_of_measurement: "shots" }) } });
    const [out, low] = [read(c, 0), read(c, 1)];
    const cans = [...c.shadowRoot.querySelectorAll(".gn-can")].map((x) => x.classList.contains("empty"));
    check("CO2: none left is red, low is amber, and an empty canister is drawn empty", { out: has(out.co2_cls, "is-bad"), low: has(low.co2_cls, "is-warn"), cans: cans.join() },
      { out: true, low: true, cans: "true,false" });
    c.remove();
  }

  // 15. Signal strength: 0-4 bars, one per fifth of -100 to -50 dBm, and never a warning.
  const dbm = (n) => ({ "sensor.rssi": st(n, { unit_of_measurement: "dBm", device_class: "signal_strength" }) });
  for (const [n, bars] of [[-45, 4], [-60, 4], [-61, 3], [-70, 3], [-80, 2], [-81, 1], [-99, 1], [-100, 0], [-110, 0]]) {
    run(`signal ${n} dBm = ${bars} bars`, { signal: "sensor.rssi" }, dbm(n), { signal: `${n} dBm`, signal_bars: bars, signal_label: "Signal" });
  }
  run("signal: a percentage", { signal: "sensor.wifi" }, { "sensor.wifi": st(72, { unit_of_measurement: "%" }) }, { signal: "72%", signal_bars: 3 });
  run("signal: Zigbee LQI", { signal: "sensor.lq" }, { "sensor.lq": st(180, { unit_of_measurement: "lqi" }) }, { signal: "180 LQI", signal_bars: 3 });
  run("signal: a positive number without a unit is LQI", { signal: "sensor.lq" }, { "sensor.lq": st(120) }, { signal: "120", signal_bars: 2 });
  run("signal: a negative number without a unit is dBm", { signal: "sensor.rssi" }, { "sensor.rssi": st(-70) }, { signal: "-70", signal_bars: 3 });
  run("signal: min and max set the span", { signal: { entity: "sensor.rssi", min: -90, max: -70 } }, dbm(-75), { signal_bars: 3 });
  run("signal: an attribute", { signal: { entity: "device_tracker.t", attribute: "rssi" } }, { "device_tracker.t": st("home", { rssi: -66 }) }, { signal: "-66", signal_bars: 3 });
  run("signal: words show as they are", { signal: "sensor.q" }, { "sensor.q": st("good") }, { signal: "Good", signal_bars: 0 });
  run("signal: weak is not a warning", { signal: "sensor.rssi", kill: "binary_sensor.k" }, { ...dbm(-98), "binary_sensor.k": st("off") }, { chip: "Armed", signal_bars: 1 });
  run("signal: unavailable is a dash", { signal: "sensor.rssi", kill: "binary_sensor.k" }, { "sensor.rssi": st("unavailable"), "binary_sensor.k": st("off") },
    { signal: "—", signal_bars: 0, chip: "Armed" });

  // 16. Link and Last seen are separate readings, each with its own state.
  const seen = (min) => ({ "sensor.ls": st(ago(min), { device_class: "timestamp" }) });
  const both = { online: "binary_sensor.o", last_seen: "sensor.ls" };
  run("link and last seen: two readings", both, { "binary_sensor.o": st("on"), ...seen(5) },
    { link: "Online", link_label: "Link", last_seen: "5 min ago", last_seen_label: "Last seen", chip: "All good" });
  {
    const c = mount({ stale_after: "12h", offline_after: "2d", traps: [both, both] }, { states: { "binary_sensor.o": st("on"), ...seen(13 * 60) } });
    const late = read(c, 0);
    c.hass = { states: { "binary_sensor.o": st("on"), ...seen(3 * 1440) } };
    const gone = read(c, 0);
    check("late: Last seen is amber and says so, Link stays Online", { link: late.link, label: late.last_seen_label, warn: has(late.last_seen_cls, "is-warn"), chip: late.chip },
      { link: "Online", label: "Last seen, late", warn: true, chip: "Not seen recently" });
    check("overdue: both are grey, and Link says Offline", { link: gone.link, linkOff: has(gone.link_cls, "is-off"), seenOff: has(gone.last_seen_cls, "is-off"), label: gone.last_seen_label, chip: gone.chip },
      { link: "Offline", linkOff: true, seenOff: true, label: "Last seen, late", chip: "Offline" });
    c.remove();
  }
  const ping = { "button.ping": st("unknown", { friendly_name: "Ping" }), "button.poll": st("unknown", { friendly_name: "Poll" }) };
  run("a Link hold moves to Last seen on a trap without Link", { last_seen: "sensor.ls", holds: { link: "button.ping" } }, { ...seen(5), ...ping },
    { last_seen_hold: "last_seen", link_hold: undefined });
  run("a Last seen hold moves to Link on a trap without Last seen", { online: "binary_sensor.o", holds: { last_seen: "button.ping" } }, { "binary_sensor.o": st("on"), ...ping },
    { link_hold: "link" });
  run("with both readings, each hold stays put", { ...both, holds: { link: "button.ping", last_seen: "button.poll" } }, { "binary_sensor.o": st("on"), ...seen(5), ...ping },
    { link_hold: "link", last_seen_hold: "last_seen" });
  run("CO2 and signal take holds", { co2: "sensor.co2", signal: "sensor.rssi", holds: { co2: "button.ping", signal: "button.poll" } }, { ...shots(20), ...dbm(-60), ...ping },
    { co2_hold: "co2", signal_hold: "signal" });

  // stub config finds trap devices
  const stub =customElements.get("rodent-trap-card").getStubConfig({ states: gnStates, ...gnHass });
  check("stub config uses devices", { t: JSON.stringify(stub.traps) }, { t: '[{"device":"gn"}]' });
  return out;
});
  return { lines, errors: page.errors };
}

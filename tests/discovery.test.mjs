// Device discovery patterns, the card picker's starter config and its entity suggestions, run inside the fixture page.
import { fixtureUrl, openPage } from "./lib.mjs";

export default async function run(browser) {
  const page = await openPage(browser, fixtureUrl);
  const lines = await page.evaluate(async () => {
    const out = [];
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const st = (state, attributes = {}) => ({ state: String(state), attributes, last_changed: ago(0), last_updated: ago(0) });
    const check = (name, got, want) => {
      const g = JSON.stringify(got);
      const w = JSON.stringify(want);
      out.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
    };

    /** A registry with one device per call; entities are added in the order given, which discovery walks in. */
    function registry() {
      const hass = { states: {}, entities: {}, devices: {}, areas: {} };
      hass.device = (id, dev, list) => {
        hass.devices[id] = { id, name: id, manufacturer: "Acme", model: "", ...dev };
        for (const [eid, state, attrs] of list) {
          hass.states[eid] = st(state, attrs || {});
          hass.entities[eid] = { entity_id: eid, device_id: id };
        }
        return hass;
      };
      return hass;
    }
    /** What the editor says the device supplies for each field ("From device: ..."). */
    async function supplied(hass, deviceId) {
      const ed = document.createElement("rodent-trap-card-editor");
      document.body.appendChild(ed);
      ed.hass = hass;
      ed.setConfig({ type: "custom:rodent-trap-card", traps: [{ device: deviceId }] });
      await new Promise((r) => setTimeout(r, 20));
      const form = ed.shadowRoot.querySelectorAll("ha-form")[1];
      const res = {};
      for (const k of ["kill", "armed", "rearm", "strikes", "last_strike", "battery", "bait", "co2", "online", "last_seen", "signal", "hold_kill", "hold_bait", "hold_co2", "hold_link", "hold_last_seen"]) {
        const h = form.computeHelper({ name: k }) || "";
        const m = h.match(/^From device: (\S+)/);
        if (m) res[k] = m[1];
      }
      ed.remove();
      return res;
    }

    // --- Item 13: tighter discovery patterns.
    let h = registry().device("d1", {}, [
      ["sensor.t1_last_strike", ago(90), { device_class: "timestamp", friendly_name: "T1 Last strike" }],
      ["sensor.t1_strikes", 7, { friendly_name: "T1 Strikes" }],
    ]);
    check("a last-strike timestamp sensor is not the strike count", await supplied(h, "d1"), { strikes: "sensor.t1_strikes", last_strike: "sensor.t1_last_strike" });
    h = registry().device("d1", {}, [["sensor.t1_strike_time", ago(90), { device_class: "timestamp" }]]);
    h.states["sensor.t1_strike_time"].attributes.friendly_name = "Strikes";
    check("a timestamp sensor named Strikes is not the strike count", await supplied(h, "d1"), {});
    h = registry().device("d1", {}, [["sensor.t1_catches", 4]]);
    check("catches is the strike count", await supplied(h, "d1"), { strikes: "sensor.t1_catches" });
    h = registry().device("d1", {}, [["sensor.t1_kills", 3]]);
    check("kills is the strike count", await supplied(h, "d1"), { strikes: "sensor.t1_kills" });
    h = registry().device("d1", {}, [["counter.t1_catches_total", 3]]);
    check("catches_total is the strike count", await supplied(h, "d1"), { strikes: "counter.t1_catches_total" });
    h = registry().device("d1", {}, [["sensor.t1_total_kills", 9], ["sensor.t1_kills_present", 1]]);
    check("kills_present stays the catch alert", await supplied(h, "d1"), { kill: "sensor.t1_kills_present", strikes: "sensor.t1_total_kills" });
    h = registry().device("d1", {}, [["sensor.t1_alarm_state", "disarmed"], ["binary_sensor.t1_kill_alert", "off"]]);
    check("alarm_state is not the armed sensor", await supplied(h, "d1"), { kill: "binary_sensor.t1_kill_alert" });
    {
      const c = document.createElement("rodent-trap-card");
      document.body.appendChild(c);
      c.setConfig({ traps: [{ device: "d1" }] });
      c.hass = h;
      check("alarm_state doesn't make a false 'Needs re-arm'", c.shadowRoot.querySelector(".tile-head .chip").textContent.trim(), "Armed");
      c.remove();
    }
    h = registry().device("d1", {}, [["sensor.t1_arm_state", "armed"], ["binary_sensor.t1_re_arm_required", "off"]]);
    check("arm_state and re_arm_required still found", await supplied(h, "d1"), { armed: "sensor.t1_arm_state", rearm: "binary_sensor.t1_re_arm_required" });
    h = registry().device("d1", {}, [["binary_sensor.t1_fire_arm", "off"], ["binary_sensor.t1_needs_rearm", "off"]]);
    check("re-arm matches whole words only", await supplied(h, "d1"), { rearm: "binary_sensor.t1_needs_rearm" });
    h = registry().device("d1", {}, [
      ["button.t1_reset_kill_count", "unknown", { friendly_name: "T1 Reset kill count" }],
      ["button.t1_clear_kill_alert", "unknown", { friendly_name: "T1 Clear kill alert" }],
    ]);
    check("'Reset kill count' is not the catch hold", await supplied(h, "d1"), { hold_kill: "button.t1_clear_kill_alert" });
    h = registry().device("d1", {}, [["button.t1_reset_kill_count", "unknown"]]);
    check("no catch hold from a count reset alone", await supplied(h, "d1"), {});
    for (const id of ["button.t1_clear_alert", "button.t1_kill_alert_clear", "button.t1_reset_catch", "button.t1_reset_kill_alert", "script.t1_clear_catch"]) {
      h = registry().device("d1", {}, [[id, "unknown"]]);
      check(`catch hold: ${id}`, (await supplied(h, "d1")).hold_kill, id);
    }
    for (const id of ["button.t1_lure_replaced", "button.t1_replace_bait", "button.t1_refill", "button.t1_refilled", "input_button.t1_bait_refilled"]) {
      h = registry().device("d1", {}, [[id, "unknown"]]);
      check(`bait hold: ${id}`, (await supplied(h, "d1")).hold_bait, id);
    }
    h = registry().device("d1", {}, [["button.t1_refill_reminder", "unknown"]]);
    check("bait hold must end with the action", (await supplied(h, "d1")).hold_bait, undefined);

    // --- Item 35 (4): a voltage sensor named "battery" is not the battery level.
    h = registry().device("d1", {}, [["sensor.t1_battery", 3.0, { unit_of_measurement: "V", device_class: "voltage" }]]);
    check("voltage 'battery' sensor is not discovered", await supplied(h, "d1"), {});
    h = registry().device("d1", {}, [
      ["sensor.t1_battery", 3.0, { unit_of_measurement: "V", device_class: "voltage" }],
      ["sensor.t1_battery_level", 80, { unit_of_measurement: "%" }],
    ]);
    check("percentage battery picked over a voltage one", await supplied(h, "d1"), { battery: "sensor.t1_battery_level" });

    // --- CO2 shots, signal strength and last seen, as the ESPHome Goodnature gateway names them on an A24 trap.
    const a24 = "goodnature_a24_smart_trap_1";
    const gw = (list) => list.map(([eid, state, attrs]) => [eid.replace("$", a24), state, { friendly_name: `Goodnature A24 Smart Trap 1 ${attrs.fn}`, ...attrs, fn: undefined }]);
    h = registry().device("a24", { name: "Goodnature A24 Smart Trap 1", manufacturer: "Goodnature", model: "Goodnature A24 Smart Trap" }, gw([
      ["sensor.$_strikes", 2, { fn: "Strikes", state_class: "total_increasing" }],
      ["binary_sensor.$_kill_alert", "off", { fn: "Kill Alert", device_class: "occupancy" }],
      ["event.$_strike", ago(11), { fn: "Strike", event_type: "strike" }],
      ["sensor.$_last_strike", ago(11), { fn: "Last Strike", device_class: "timestamp" }],
      ["sensor.$_battery", 86, { fn: "Battery", unit_of_measurement: "%", device_class: "battery" }],
      ["binary_sensor.$_battery_low", "off", { fn: "Battery Low", device_class: "battery" }],
      ["sensor.$_battery_status", "Normal", { fn: "Battery Status" }],
      ["sensor.$_lure_age", 0, { fn: "Lure Age", unit_of_measurement: "d", device_class: "duration" }],
      ["sensor.$_lure_remaining", 180, { fn: "Lure Remaining", unit_of_measurement: "d", device_class: "duration" }],
      ["number.$_lure_life", 180, { fn: "Lure Life", unit_of_measurement: "d", min: 1, max: 730 }],
      ["binary_sensor.$_lure_due", "off", { fn: "Lure Due", device_class: "problem" }],
      ["sensor.$_co2_shots_remaining", 22, { fn: "CO2 Shots Remaining", unit_of_measurement: "shots" }],
      ["binary_sensor.$_co2_low", "off", { fn: "CO2 Low", device_class: "problem" }],
      ["binary_sensor.$_online", "on", { fn: "Online", device_class: "connectivity" }],
      ["sensor.$_signal_strength", -71, { fn: "Signal Strength", unit_of_measurement: "dBm", device_class: "signal_strength" }],
      ["sensor.$_last_seen", ago(5), { fn: "Last Seen", device_class: "timestamp" }],
      ["sensor.$_status", "Waiting for trap", { fn: "Status" }],
      ["button.$_poll_now", "unknown", { fn: "Poll Now" }],
      ["button.$_lure_replaced", "unknown", { fn: "Lure Replaced" }],
      ["button.$_co2_shot_used", "unknown", { fn: "CO2 Shot Used" }],
      ["button.$_co2_canister_replaced", "unknown", { fn: "CO2 Canister Replaced" }],
      ["button.$_clear_kill_alert", "unknown", { fn: "Clear Kill Alert" }],
      ["button.$_test_fire", "unknown", { fn: "Test Fire" }],
    ]));
    check("gateway A24: every reading found", await supplied(h, "a24"), {
      kill: `binary_sensor.${a24}_kill_alert`, strikes: `sensor.${a24}_strikes`, last_strike: `event.${a24}_strike`, battery: `sensor.${a24}_battery`,
      bait: `sensor.${a24}_lure_remaining`, co2: `sensor.${a24}_co2_shots_remaining`, online: `binary_sensor.${a24}_online`, last_seen: `sensor.${a24}_last_seen`,
      signal: `sensor.${a24}_signal_strength`, hold_kill: `button.${a24}_clear_kill_alert`, hold_bait: `button.${a24}_lure_replaced`, hold_co2: `button.${a24}_co2_canister_replaced`,
    });
    {
      const c = document.createElement("rodent-trap-card");
      document.body.appendChild(c);
      c.setConfig({ traps: [{ device: "a24" }] });
      c.hass = h;
      const sh = c.shadowRoot;
      const value = (k) => sh.querySelector(`.m-${k} .m-value`).textContent.trim();
      check("gateway A24: its tile", {
        readings: [...sh.querySelectorAll(".metric")].map((m) => /m-([a-z0-9_]+)/.exec(m.className)[1]),
        values: ["co2", "link", "last_seen", "signal"].map(value), co2Hold: sh.querySelector(".m-co2").dataset.hold, chip: sh.querySelector(".tile-head .chip").textContent.trim(),
      }, {
        readings: ["strikes", "last_strike", "battery", "bait", "co2", "kill", "link", "last_seen", "signal"],
        values: ["22 shots", "Online", "5 min ago", "-71 dBm"], co2Hold: "co2", chip: "Armed",
      });
      h.states[`binary_sensor.${a24}_co2_low`] = st("on", { device_class: "problem" });
      c.hass = { ...h, states: { ...h.states } };
      check("gateway A24: its CO2 Low alert marks the reading low", [sh.querySelector(".tile-head .chip").textContent.trim(), value("co2")], ["Low CO₂", "22 shots"]);
      c.remove();
    }
    // --- The art a device gets from its maker, model and own name.
    {
      const art = (dev, list = [["binary_sensor.t_kill_alert", "off"]]) => {
        const c = document.createElement("rodent-trap-card");
        document.body.appendChild(c);
        c.setConfig({ traps: [{ device: "d" }] });
        c.hass = registry().device("d", dev, list);
        const got = /art-(\w+)/.exec(c.shadowRoot.querySelector("svg.scene").getAttribute("class"))[1];
        c.remove();
        return got;
      };
      const gn = { manufacturer: "Goodnature" };
      check("art: the gateway's A24 and Mouse Trap", [
        art({ ...gn, name: "Goodnature A24 Smart Trap 1", model: "Goodnature A24 Smart Trap" }),
        art({ ...gn, name: "Goodnature Mouse Trap 1", model: "Goodnature Mouse Trap" }),
        art({ ...gn, name: "Goodnature Mouse Trap 2", model: "" }),
      ], ["goodnature", "goodnature_mouse", "goodnature_mouse"]);
      check("art: a Goodnature trap you named Mousetrap stays an A24", art({ ...gn, name: "Goodnature Trap 1", name_by_user: "Mousetrap 1", model: "A24 Chirp" }), "goodnature");
      check("art: a Goodnature mouse trap with a CO2 canister is an A24",
        art({ ...gn, name: "Goodnature Rat & Mouse Trap" }, [["binary_sensor.t_kill_alert", "off"], ["sensor.t_co2_shots_remaining", 20]]), "goodnature");
      check("art: a NEO Coolcam trap, under Tasmota, Tuya or its own name", [
        art({ manufacturer: "Tasmota", model: "NEO Coolcam Mouse Trap", name: "Tasmota" }),
        art({ manufacturer: "Tuya", model: "NAS-MA01W", name: "Mousetrap" }),
        art({ manufacturer: "Tuya", model: "WiFi Mousetrap", name: "Neo Coolcam mouse trap" }),
      ], ["neocam", "neocam", "neocam"]);
      check("art: a NEO Coolcam door sensor on a snap trap stays a snap trap",
        art({ manufacturer: "Shenzhen Neo Electronics Co., Ltd", model: "Door/Window Detector", name: "NEO Coolcam Door Sensor", name_by_user: "Pantry trap" }), "snap");
      check("art: a trap's own style beats its device",
        (() => { const c = document.createElement("rodent-trap-card"); document.body.appendChild(c); c.setConfig({ traps: [{ device: "d", style: "snap" }] });
          c.hass = registry().device("d", { ...gn, name: "Goodnature Mouse Trap 1" }, [["binary_sensor.t_kill_alert", "off"]]);
          const got = /art-(\w+)/.exec(c.shadowRoot.querySelector("svg.scene").getAttribute("class"))[1]; c.remove(); return got; })(), "snap");
    }
    h = registry().device("d1", {}, [["sensor.t1_co2", 812, { unit_of_measurement: "ppm", device_class: "carbon_dioxide" }]]);
    check("a CO2 concentration sensor is not the canister", await supplied(h, "d1"), {});
    h = registry().device("d1", {}, [["sensor.t1_strikes_remaining", 9], ["sensor.t1_strikes", 3]]);
    check("strikes remaining are CO2 shots, not the strike count", await supplied(h, "d1"), { strikes: "sensor.t1_strikes", co2: "sensor.t1_strikes_remaining" });
    h = registry().device("d1", {}, [["sensor.t1_co2_remaining", 20], ["number.t1_co2_capacity", 30], ["button.t1_replace_canister", "unknown"]]);
    check("CO2 remaining, capacity and replace canister", await supplied(h, "d1"), { co2: "sensor.t1_co2_remaining", hold_co2: "button.t1_replace_canister" });
    {
      const c = document.createElement("rodent-trap-card");
      document.body.appendChild(c);
      c.setConfig({ traps: [{ device: "d1" }] });
      c.hass = h;
      check("a CO2 capacity entity sets the canister size", c.shadowRoot.querySelector(".m-co2 .m-value").textContent.trim(), "20/30");
      c.remove();
    }
    h = registry().device("d1", {}, [["sensor.t1_lqi", 200], ["sensor.t1_rssi", -60, { unit_of_measurement: "dBm", device_class: "signal_strength" }]]);
    check("ZHA: RSSI is picked over LQI", await supplied(h, "d1"), { signal: "sensor.t1_rssi" });
    for (const id of ["sensor.t1_linkquality", "sensor.t1_wifi_signal", "sensor.t1_signal_level"]) {
      h = registry().device("d1", {}, [[id, 50]]);
      check(`signal: ${id}`, (await supplied(h, "d1")).signal, id);
    }
    h = registry().device("d1", {}, [["sensor.t1_signal_lost_count", 2]]);
    check("signal must end the name", (await supplied(h, "d1")).signal, undefined);

    // --- Item 4: no made-up trap in the starter config.
    const Card = customElements.get("rodent-trap-card");
    const lights = { states: { "light.kitchen": st("on"), "sensor.outdoor_temperature": st(12) }, entities: {}, devices: { l1: { id: "l1", name: "Kitchen light" } }, areas: {} };
    const stub = Card.getStubConfig(lights);
    check("starter config without traps is one empty trap", stub.traps, [{}]);
    check("starter config without hass is one empty trap", Card.getStubConfig(undefined).traps, [{}]);
    {
      const c = document.createElement("rodent-trap-card");
      document.body.appendChild(c);
      c.setConfig(stub);
      c.hass = lights;
      const sh = c.shadowRoot;
      check("empty trap asks to pick a device", {
        name: sh.querySelector(".name").textContent.trim(),
        chip: sh.querySelector(".tile-head .chip").textContent.trim(),
        loc: !!sh.querySelector(".loc"),
        hint: /pick a device/.test(sh.querySelector(".hint").textContent),
      }, { name: "Trap 1", chip: "Not set up", loc: false, hint: true });
      c.remove();
    }

    // --- Item 38: entity-id starter config and card picker suggestions.
    const ids = (list) => ({ states: Object.fromEntries(list.map(([id, s]) => [id, st(s)])) });
    check("rodent_trap_1_* and rodent_trap_2_* are two traps", Card.getStubConfig(ids([
      ["binary_sensor.rodent_trap_1_kill", "off"], ["sensor.rodent_trap_1_battery", 80],
      ["binary_sensor.rodent_trap_2_kill", "off"], ["sensor.rodent_trap_2_battery", 70],
    ])).traps, [
      { name: "Rodent Trap 1", kill: "binary_sensor.rodent_trap_1_kill", battery: "sensor.rodent_trap_1_battery" },
      { name: "Rodent Trap 2", kill: "binary_sensor.rodent_trap_2_kill", battery: "sensor.rodent_trap_2_battery" },
    ]);
    check("trap named by location, status and node_status", Card.getStubConfig(ids([
      ["sensor.garage_trap_status", "armed"], ["sensor.garage_trap_node_status", "alive"], ["sensor.garage_trap_connection_status", "connected"],
      ["sensor.mousetrap_kitchen_battery_level", 50],
    ])).traps, [
      { name: "Garage Trap", kill: "sensor.garage_trap_status", online: "sensor.garage_trap_node_status" },
      { name: "Mousetrap Kitchen", battery: "sensor.mousetrap_kitchen_battery_level" },
    ]);
    check("entity ids: CO2 shots and signal strength", Card.getStubConfig(ids([
      ["binary_sensor.garden_trap_kill", "off"], ["sensor.garden_trap_co2_shots_remaining", 20], ["sensor.garden_trap_rssi", -70],
      ["sensor.shed_trap_linkquality", 120],
    ])).traps, [
      { name: "Garden Trap", kill: "binary_sensor.garden_trap_kill", co2: "sensor.garden_trap_co2_shots_remaining", signal: "sensor.garden_trap_rssi" },
      { name: "Shed Trap", signal: "sensor.shed_trap_linkquality" },
    ]);
    {
      const list = [];
      for (let n = 1; n <= 6; n++) list.push([`binary_sensor.trap_${n}_kill`, "off"]);
      for (let n = 1; n <= 6; n++) list.push([`sensor.trap_${n}_battery`, 80]);
      const traps = Card.getStubConfig(ids(list)).traps;
      check("at most four traps, each still collecting its entities", traps.map((t) => [t.name, !!t.kill, !!t.battery]),
        [["Trap 1", true, true], ["Trap 2", true, true], ["Trap 3", true, true], ["Trap 4", true, true]]);
    }
    check("devices still come first", Card.getStubConfig(registry().device("gn1", { name: "Goodnature Trap 1" }, [["sensor.gn1_strikes", 3]])).traps, [{ device: "gn1" }]);

    const entry = (window.customCards || []).find((c) => c.type === "rodent-trap-card");
    check("card picker entry has getEntitySuggestion", typeof (entry && entry.getEntitySuggestion), "function");
    const suggest = (hass, id) => entry.getEntitySuggestion(hass, id);
    const pick = registry()
      .device("gn1", { name: "Goodnature Trap 1", manufacturer: "Goodnature" }, [["sensor.gn1_battery", 80, { unit_of_measurement: "%", device_class: "battery" }]])
      .device("acme", { name: "Shed sensor", manufacturer: "Acme" }, [["binary_sensor.acme_kill_alert", "off"], ["sensor.acme_temperature", 11]])
      .device("counter", { name: "Box", manufacturer: "Acme" }, [["sensor.box_total_kills", 5]])
      .device("wx", { name: "Weather station", manufacturer: "WeatherFlow" }, [["sensor.wx_lightning_strike_count", 2]])
      .device("lamp", { name: "Kitchen light", manufacturer: "Signify" }, [["light.kitchen_light", "on"]]);
    pick.states["sensor.loose_trap_battery"] = st(50);
    check("suggested for any entity of a trap-named device", suggest(pick, "sensor.gn1_battery"), { config: { type: "custom:rodent-trap-card", traps: [{ device: "gn1" }] } });
    check("suggested when the device has a catch sensor", suggest(pick, "sensor.acme_temperature"), { config: { type: "custom:rodent-trap-card", traps: [{ device: "acme" }] } });
    check("suggested when the device has a kill count", suggest(pick, "sensor.box_total_kills"), { config: { type: "custom:rodent-trap-card", traps: [{ device: "counter" }] } });
    check("not suggested for a lightning strike count", suggest(pick, "sensor.wx_lightning_strike_count"), null);
    check("not suggested for a light", suggest(pick, "light.kitchen_light"), null);
    check("not suggested for an entity without a device", suggest(pick, "sensor.loose_trap_battery"), null);
    check("not suggested for an unknown entity", suggest(pick, "sensor.nope"), null);
    check("no crash without registries", suggest({ states: {} }, "sensor.x"), null);
    {
      const s = suggest(pick, "binary_sensor.acme_kill_alert");
      const c = document.createElement("rodent-trap-card");
      document.body.appendChild(c);
      c.setConfig(s.config);
      c.hass = pick;
      check("suggested config renders the device", { name: c.shadowRoot.querySelector(".name").textContent.trim(), chip: c.shadowRoot.querySelector(".tile-head .chip").textContent.trim(), label: "label" in s }, { name: "Shed sensor", chip: "Armed", label: false });
      c.remove();
    }
    return out;
  });
  return { lines, errors: page.errors };
}

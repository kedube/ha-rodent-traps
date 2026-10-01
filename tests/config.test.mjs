// Config handling: Home Assistant action syntax, validation of durations, styles, sorts and hold keys, the single-trap
// form in the visual editor, and one bad trap not blanking or freezing the rest of the card. Runs in the fixture page.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { demoUrl, fixtureUrl, openPage, root } from "./lib.mjs";

export default async function run(browser) {
  const page = await openPage(browser, fixtureUrl);
  const lines = await page.evaluate(async () => {
    const out = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const st = (state, attributes = {}, changed = ago(0)) => ({ state: String(state), attributes, last_changed: changed, last_updated: changed });
    const check = (name, got, want) => {
      const g = JSON.stringify(got);
      const w = JSON.stringify(want);
      out.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
    };
    const mount = (config, hass) => {
      const card = document.createElement("rodent-trap-card");
      document.body.appendChild(card);
      card.setConfig(config);
      if (hass) card.hass = hass;
      return card;
    };
    /** The error message setConfig throws, or "ok". */
    const configError = (config) => {
      try {
        document.createElement("rodent-trap-card").setConfig(config);
        return "ok";
      } catch (e) {
        return e.message;
      }
    };
    const chip = (card, idx = 0) => card.shadowRoot.querySelectorAll(".tile")[idx].querySelector(".tile-head .chip").textContent.trim();

    // --- Item 19: durations.
    // A trap last seen `hours` ago, with offline_after set to `value`: Offline or not.
    const offlineAt = (value, hours, trapExtra = {}) => {
      const c = mount({ offline_after: value, traps: [{ kill: "binary_sensor.k", last_seen: "sensor.ls", ...trapExtra }] },
        { states: { "binary_sensor.k": st("off"), "sensor.ls": st(ago(hours * 60), { device_class: "timestamp" }) } });
      const offline = chip(c) === "Offline";
      c.remove();
      return offline;
    };
    const readable = [
      ["36h", 36], ["1d12h", 36], ["1d 12h", 36], ["1 day, 12:00:00", 36], ["1 day 12:00", 36], ["36:00:00", 36], ["1.5d", 36],
      ["36", 36], [36, 36], [{ days: 1, hours: 12 }, 36], ["2 days and 3 hours", 51], ["2 days, 3 hours", 51], ["2 Days", 48],
      ["1h 30m", 1.5], ["1h30m", 1.5], ["90 min", 1.5], ["1:30", 1.5], ["1 week", 168],
    ];
    for (const [value, hours] of readable) {
      check(`duration ${JSON.stringify(value)} = ${hours} h`, [offlineAt(value, hours + 0.25), offlineAt(value, hours - 0.25)], [true, false]);
    }
    for (const value of ["1d12", "12hx", "abc", "1 fortnight", "P2D", "1h and", "1h,,30m", "-5h", -5, true, { day: 2 }, [12]]) {
      check(`duration ${JSON.stringify(value)} is a config error`, configError({ offline_after: value, traps: [{}] }),
        `offline_after: can't read ${JSON.stringify(value)} (use e.g. 12h, 2d, 1d 12h, 36:00:00)`);
    }
    check("trap-level duration error names the trap", configError({ traps: [{}, { stale_after: "2dd" }] }),
      `traps[1].stale_after: can't read "2dd" (use e.g. 12h, 2d, 1d 12h, 36:00:00)`);
    for (const off of [false, null, "", 0, "0", "none", "off", "never", "Never"]) {
      check(`trap offline_after ${JSON.stringify(off)} turns the card's off`, [configError({ offline_after: "2d", traps: [{ offline_after: off }] }), offlineAt("2d", 72, { offline_after: off })], ["ok", false]);
    }

    // --- Item 19: style, sort and hold keys.
    const art = (config, states = { "binary_sensor.k": st("off") }) => {
      const c = mount(config, { states });
      const cls = c.shadowRoot.querySelector("svg.scene").getAttribute("class").match(/art-(\w+)/)[1];
      c.remove();
      return cls;
    };
    check("style is compared in lower case", art({ style: "Goodnature", traps: [{ kill: "binary_sensor.k" }] }), "goodnature");
    check("trap style auto uses the card's", art({ style: "station", traps: [{ kill: "binary_sensor.k", style: "auto" }] }), "station");
    check("trap style in capitals", art({ traps: [{ kill: "binary_sensor.k", style: " Station " }] }), "station");
    check("misspelt card style is an error", configError({ style: "goodnatur", traps: [{}] }), `style: "goodnatur" isn't a style (use snap, goodnature, station or auto).`);
    check("misspelt trap style is an error", configError({ traps: [{ style: "stn" }] }), `traps[0].style: "stn" isn't a style (use snap, goodnature, station or auto).`);
    check("misspelt sort is an error", configError({ sort: "urgency", traps: [{}] }), `sort: "urgency" isn't an order (use config, status or name).`);
    {
      const c = mount({ sort: "Status", traps: [{ name: "Fine", kill: "binary_sensor.ok" }, { name: "Caught", kill: "binary_sensor.k" }] },
        { states: { "binary_sensor.ok": st("off"), "binary_sensor.k": st("on") } });
      check("sort is compared in lower case", [...c.shadowRoot.querySelectorAll(".tile .name")].map((n) => n.textContent), ["Caught", "Fine"]);
      c.remove();
    }
    for (const key of ["catch_alert", "Kill", "constructor", "toString", "hasOwnProperty"]) {
      check(`hold key ${key} is an error`, configError({ traps: [{ holds: { [key]: "button.x" } }] }),
        `traps[0].holds.${key} is not a reading (use kill, trap, strikes, last_strike, battery, bait, co2, link, last_seen or signal).`);
    }
    check("hold key __proto__ is an error", configError(JSON.parse('{"traps":[{"holds":{"__proto__":"button.x"}}]}')),
      "traps[0].holds.__proto__ is not a reading (use kill, trap, strikes, last_strike, battery, bait, co2, link, last_seen or signal).");
    check("hold aliases still work", configError({ traps: [{ holds: { catch: "button.x", online: "button.y", last_seen: false } }] }), "ok");
    {
      const c = mount({ traps: [{ battery: "sensor.b" }] }, { states: { "sensor.b": st(5, { unit_of_measurement: "constructor" }) } });
      check("a unit named constructor is not a duration", c.shadowRoot.querySelector(".m-battery .m-value").textContent, "5 constructor");
      c.remove();
    }

    // --- Item 6: Home Assistant action syntax.
    const calls = [];
    const actHass = {
      states: {
        "binary_sensor.k": st("off"),
        "switch.pump": st("on", { friendly_name: "Pump" }),
        "counter.x": st(5, { friendly_name: "Pantry Trap Strikes" }),
        "button.p": st("unknown", { friendly_name: "Press me" }),
      },
      callService: async (...a) => { calls.push(a); },
    };
    /** Buttons on a one-trap card, and what pressing button `n` (confirming if asked) calls and shows. */
    const press = async (actions, n = 0) => {
      calls.length = 0;
      const c = mount({ traps: [{ kill: "binary_sensor.k", actions }] }, actHass);
      const sh = c.shadowRoot;
      const buttons = [...sh.querySelectorAll(".act")].map((b) => b.textContent.trim());
      let asked = null;
      if (sh.querySelectorAll(".act")[n]) {
        sh.querySelectorAll(".act")[n].click();
        await sleep(10);
        asked = sh.querySelector(".confirm span") ? sh.querySelector(".confirm span").textContent : null;
        if (asked) sh.querySelector('[data-confirm="yes"]').click();
        await sleep(20);
      }
      const flash = sh.querySelector(".flash") ? sh.querySelector(".flash").textContent : null;
      c.remove();
      return { buttons, asked, calls: calls.map((x) => x.slice()), flash };
    };
    check("perform-action runs its service, not a toggle", await press([{ entity: "switch.pump", name: "Turn off", action: "perform-action", perform_action: "switch.turn_off" }]),
      { buttons: ["Turn off"], asked: null, calls: [["switch", "turn_off", {}, { entity_id: "switch.pump" }]], flash: "Turn off: done" });
    check("call-service with service_data", await press([{ entity: "switch.pump", action: "call-service", service: "switch.turn_off", service_data: { x: 1 } }]),
      { buttons: ["Turn off Pump"], asked: null, calls: [["switch", "turn_off", { x: 1 }, { entity_id: "switch.pump" }]], flash: "Turn off Pump: done" });
    check("an unnamed service call is named verb plus target", await press([{ action: "counter.reset", target: { entity_id: "counter.x" } }]),
      { buttons: ["Reset Pantry Trap Strikes"], asked: null, calls: [["counter", "reset", {}, { entity_id: "counter.x" }]], flash: "Reset Pantry Trap Strikes: done" });
    check("confirmation: { text } asks that question", await press([{ action: "perform-action", perform_action: "counter.reset", target: { entity_id: "counter.x" }, confirmation: { text: "Really reset?" } }]),
      { buttons: ["Reset Pantry Trap Strikes"], asked: "Really reset?", calls: [["counter", "reset", {}, { entity_id: "counter.x" }]], flash: "Reset Pantry Trap Strikes: done" });
    check("confirmation: true asks by name", (await press([{ entity: "switch.pump", confirmation: true }])).asked, "Pump?");
    check("toggle toggles the entity", (await press([{ entity: "switch.pump", action: "toggle" }])).calls, [["switch", "toggle", {}, { entity_id: "switch.pump" }]]);
    check("a service without a target", (await press([{ perform_action: "notify.notify", data: { message: "Check the trap" } }])),
      { buttons: ["Notify"], asked: null, calls: [["notify", "notify", { message: "Check the trap" }, null]], flash: "Notify: done" });
    check("target entity lists are passed through", (await press([{ action: "button.press", target: { entity_id: ["button.p", "button.q"] }, name: "Both" }])).calls,
      [["button", "press", {}, { entity_id: ["button.p", "button.q"] }]]);
    check("action none and 'none' add no button", (await press([{ entity: "switch.pump", action: "none" }, "none", false, null, "button.p"])).buttons, ["Press me"]);
    check("a non-string action runs nothing instead of pressing", await press([{ entity: "button.p", action: ["button.press"], name: "P" }]),
      { buttons: ["P"], asked: null, calls: [], flash: "Can't run P: give it an `action:` (for example button.press)." });
    check("an entity in a domain named constructor runs nothing", (await press(["constructor.x"])).calls, []);
    for (const how of ["more-info", "navigate", "url", "assist", "fire-dom-event", "call-servce"]) {
      check(`action ${how} is a config error`, configError({ traps: [{ actions: [{ entity: "switch.pump", action: how }] }] }),
        `traps[0].actions[0].action: ${how} can't run from a trap tile (use a service such as counter.reset, perform-action, toggle or none).`);
    }
    check("a service with too many parts is an error", configError({ traps: [{ holds: { kill: { action: "light.turn_on.extra", entity: "light.x" } } }] }),
      `traps[0].holds.kill.action: "light.turn_on.extra" isn't a service such as counter.reset.`);
    check("a bad perform_action is an error", configError({ traps: [{ actions: [{ action: "perform-action", perform_action: "counter reset" }] }] }),
      `traps[0].actions[0].perform_action: "counter reset" isn't a service such as counter.reset.`);
    check("perform-action without perform_action is an error", configError({ traps: [{ actions: [{ entity: "switch.pump", action: "perform-action" }] }] }),
      "traps[0].actions[0]: action perform-action needs perform_action, for example counter.reset.");
    check("call-service without service is an error", configError({ traps: [{ actions: [{ entity: "switch.pump", action: "call-service" }] }] }),
      "traps[0].actions[0]: action call-service needs service, for example counter.reset.");
    check("toggle without an entity is an error", configError({ traps: [{ actions: [{ action: "toggle" }] }] }), "traps[0].actions[0]: action toggle needs an entity.");

    // Holds: `action: none` removes a device's hold, and HA-style holds run.
    const dev = { states: { "binary_sensor.t_kill_alert": st("off"), "button.t_clear_kill_alert": st("unknown", { friendly_name: "T Clear kill alert" }), "counter.x": st(5, { friendly_name: "Pantry Trap Strikes" }) },
      entities: { "binary_sensor.t_kill_alert": { entity_id: "binary_sensor.t_kill_alert", device_id: "t" }, "button.t_clear_kill_alert": { entity_id: "button.t_clear_kill_alert", device_id: "t" } },
      devices: { t: { id: "t", name: "T" } }, areas: {}, callService: async (...a) => { calls.push(a); } };
    const holdOf = (holds) => {
      const c = mount({ traps: [{ device: "t", holds }] }, dev);
      const m = c.shadowRoot.querySelector(".m-kill");
      const got = m.dataset.hold || null;
      c.remove();
      return got;
    };
    check("device hold is there by default", holdOf(undefined), "kill");
    check("holds kill: { action: none } removes the device hold", holdOf({ kill: { action: "none" } }), null);
    check("holds kill: none removes the device hold", holdOf({ kill: "none" }), null);
    {
      calls.length = 0;
      const c = mount({ traps: [{ device: "t", strikes: "counter.x", holds: { strikes: { action: "perform-action", perform_action: "counter.reset", target: { entity_id: "counter.x" }, confirmation: false } } }] }, dev);
      c.shadowRoot.querySelector(".m-strikes").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
      await sleep(20);
      check("hold with confirmation: false runs straight away", { confirm: !!c.shadowRoot.querySelector(".confirm"), calls: calls.map((x) => x.slice(0, 2).join(".")) }, { confirm: false, calls: ["counter.reset"] });
      check("hold tooltip names the unnamed call", /Hold: Reset Pantry Trap Strikes\ncounter\.x$/.test(c.shadowRoot.querySelector(".m-strikes").getAttribute("title")), true);
      c.remove();
    }

    // --- Item 7: one bad value doesn't blank or freeze the card.
    check("a list as an action's entity is a config error", configError({ traps: [{}, { actions: [{ entity: ["button.p", "button.q"] }] }] }), "traps[1].actions[0].entity must be one entity ID.");
    check("a number as an action's entity is a config error", configError({ traps: [{ actions: [{ entity: 42 }] }] }), "traps[0].actions[0].entity must be one entity ID.");
    check("a list as a hold's entity is a config error", configError({ traps: [{ holds: { kill: { entity: ["button.p", "button.q"], name: "Clear" } } }] }), "traps[0].holds.kill.entity must be one entity ID.");
    check("a number in actions is a config error", configError({ traps: [{ actions: [42] }] }), "traps[0].actions[0] must be an entity ID, a mapping such as { action: counter.reset } or false.");
    check("true as a hold is a config error", configError({ traps: [{ holds: { kill: true } }] }), "traps[0].holds.kill must be an entity ID, a mapping such as { action: counter.reset } or false.");
    check("holds: null is fine", configError({ traps: [{ holds: null }] }), "ok");

    const logged = [];
    const consoleError = console.error;
    console.error = (...a) => logged.push(a.map((x) => (x && x.message) || String(x)).join(" "));
    try {
      for (const [label, fn] of [[2024, "2024"], [["trap switch"], "Trap switch"]]) {
        const c = mount({ traps: [{ kill: "binary_sensor.k", actions: ["button.p"] }] },
          { states: { "binary_sensor.k": st("off"), "button.p": st("unknown", { friendly_name: label }) } });
        check(`friendly_name ${JSON.stringify(label)} names the button`, [c.shadowRoot.querySelector(".act").textContent.trim(), chip(c)], [fn, "Armed"]);
        c.remove();
      }
      {
        const c = mount({ traps: [{ kill: "binary_sensor.k", last_seen: { entity: "sensor.clock", attribute: "ts" } }] },
          { states: { "binary_sensor.k": st("off"), "sensor.clock": st("ok", { ts: (Date.now() - 2 * 3600000) * 1e6 }) } });
        check("a nanosecond epoch attribute reads as a time", [c.shadowRoot.querySelector(".m-last_seen .m-value").textContent.trim(), chip(c)], ["2 h ago", "Armed"]);
        c.remove();
      }
      check("no errors logged for those", logged, []);

      // A state object that throws when read stands in for anything unexpected inside one trap.
      const broken = () => {
        const s = st("off");
        Object.defineProperty(s, "state", { get() { throw new Error("boom"); } });
        return s;
      };
      const base = { "binary_sensor.a": st("off"), "binary_sensor.b": broken() };
      const card = document.createElement("rodent-trap-card");
      document.body.appendChild(card);
      card.setConfig({ sort: "status", traps: [{ name: "A", kill: "binary_sensor.a" }, { name: "B", kill: "binary_sensor.b" }] });
      const tilesOf = (c) => [...c.shadowRoot.querySelectorAll(".tile")].map((t) => `${t.querySelector(".name").textContent}: ${t.querySelector(".tile-head .chip").textContent.trim()}`);
      const summaryOf = (c) => [...c.shadowRoot.querySelectorAll(".summary .chip")].map((x) => x.textContent.trim());
      const tiles = () => tilesOf(card);
      const summary = () => summaryOf(card);
      let threw = null;
      try { card.hass = { states: base }; } catch (e) { threw = e.message; }
      check("first load: a failing trap doesn't stop the others", { threw, tiles: tiles(), summary: summary() }, { threw: null, tiles: ["B: Card error", "A: Armed"], summary: ["1 needs attention"] });
      const b = [...card.shadowRoot.querySelectorAll(".tile")].find((t) => t.querySelector(".name").textContent === "B");
      check("the failing tile says why", b.querySelector(".hint.warn").textContent, "This trap can't be shown: boom. The browser console has the details.");
      // The art is decoration; the chip says Card error in words.
      check("the failing tile's art is hidden and its chip reads its status",
        { hidden: b.querySelector("svg.scene").getAttribute("aria-hidden"), label: b.querySelector("svg.scene").getAttribute("aria-label"), chip: b.querySelector(".tile-head .chip").textContent.trim() },
        { hidden: "true", label: null, chip: "Card error" });
      check("the error is logged once", logged.length === 1 && /trap 2 \(B\).*boom/.test(logged[0]), true);
      card.hass = { states: { ...base, "binary_sensor.a": st("on") } };
      check("a catch elsewhere still shows", { tiles: tiles(), summary: summary() }, { tiles: ["A: Catch detected", "B: Card error"], summary: ["1 catch", "1 needs attention"] });
      check("the same error isn't logged again on every update", logged.length, 1);
      card.hass = { states: { ...base, "binary_sensor.a": st("on"), "binary_sensor.b": st("off") } };
      check("the failing trap recovers when its state does", tiles(), ["A: Catch detected", "B: Armed"]);

      // A render failure is caught too (the backstop in _paint).
      const tile = card._tiles[1];
      tile.model = { ...tile.model, configured: null };
      card._paint(1);
      check("a tile that fails to render shows Card error", tiles(), ["A: Catch detected", "B: Card error"]);
      check("the render failure is logged", logged.length, 2);
      card.hass = { states: { "binary_sensor.a": st("on"), "binary_sensor.b": st("off", {}, ago(1)) } };
      check("and it recovers on the next update", tiles(), ["A: Catch detected", "B: Armed"]);
      card.remove();

      // A render failure during an update: the tile, the summary and the order all show the card error.
      {
        const icon = { toString() { throw new Error("icon boom"); } };
        const c = mount({ sort: "status", traps: [{ name: "A", kill: "binary_sensor.a" }, { name: "B", kill: "binary_sensor.b", actions: [{ entity: "button.p", icon }] }] },
          { states: { "binary_sensor.a": st("off"), "binary_sensor.b": st("off") } });
        check("render failure in an update: tile, order and summary", { tiles: tilesOf(c), summary: summaryOf(c) }, { tiles: ["B: Card error", "A: Armed"], summary: ["1 needs attention"] });
        check("render failure in an update: logged", /trap 2 \(B\).*icon boom/.test(logged[logged.length - 1]), true);
        c.remove();
      }

      // Coming back from a card error isn't a live catch: only a real change plays the snap.
      {
        const c = mount({ traps: [{ name: "A", kill: "binary_sensor.a" }, { name: "B", kill: "binary_sensor.b" }] },
          { states: { "binary_sensor.a": st("off"), "binary_sensor.b": broken() } });
        c.hass = { states: { "binary_sensor.a": st("on"), "binary_sensor.b": st("on") } };
        const snaps = [...c.shadowRoot.querySelectorAll(".tile")].map((t) => t.querySelector("svg.scene").classList.contains("snap-now"));
        check("a live catch snaps; a trap recovering from an error doesn't", { tiles: tilesOf(c), snaps }, { tiles: ["A: Catch detected", "B: Catch detected"], snaps: [true, false] });
        c.remove();
      }

      // The 30 s timer refreshes relative times even if the update throws.
      const setInt = window.setInterval;
      let tick = null;
      window.setInterval = (fn, ms) => { if (ms === 30000) tick = fn; return setInt(fn, ms); };
      const t = document.createElement("rodent-trap-card");
      t.setConfig({ traps: [{ last_seen: "sensor.ls" }] });
      t.hass = { states: { "sensor.ls": st(ago(120), { device_class: "timestamp" }) } };
      document.body.appendChild(t);
      window.setInterval = setInt;
      const since = t.shadowRoot.querySelector(".m-last_seen [data-since]");
      since.textContent = "stale";
      t._update = () => { throw new Error("update failed"); };
      let tickThrew = null;
      try { tick(); } catch (e) { tickThrew = e.message; }
      check("timer: times refresh even when the update throws", { tickThrew, text: since.textContent }, { tickThrew: "update failed", text: "2 h ago" });
      t.remove();
    } finally {
      console.error = consoleError;
    }

    // --- Item 5: the single-trap form in the visual editor.
    const reg = {
      states: { "binary_sensor.solo_kill": st("off", { friendly_name: "Solo kill" }), "sensor.solo_battery": st(80, { unit_of_measurement: "%", device_class: "battery" }), "binary_sensor.gn_kill_alert": st("off") },
      entities: { "binary_sensor.gn_kill_alert": { entity_id: "binary_sensor.gn_kill_alert", device_id: "gn" } },
      devices: { gn: { id: "gn", name: "GN", manufacturer: "Goodnature" } },
      areas: {},
    };
    const solo = { type: "custom:rodent-trap-card", title: "T", stale_after: "12h", style: "station", device: "gn", name: "Solo",
      kill: "binary_sensor.solo_kill", battery: "sensor.solo_battery", holds: { kill: false }, actions: ["button.x"] };
    const ed = document.createElement("rodent-trap-card-editor");
    const events = [];
    ed.addEventListener("config-changed", (e) => events.push(e.detail.config));
    ed.hass = reg;
    ed.setConfig(solo);
    document.body.appendChild(ed);
    await sleep(30);
    const forms = () => [...ed.shadowRoot.querySelectorAll("ha-form")];
    check("editor: the single-trap form shows one trap", forms().length, 2);
    const d = forms()[1].data;
    check("editor: its options are in the trap panel", [d.device, d.name, d.kill, d.battery, d.style, d.actions], ["gn", "Solo", "binary_sensor.solo_kill", "sensor.solo_battery", "station", ["button.x"]]);
    forms()[0].emit({ ...forms()[0].data, title: "Traps" });
    const written = events[events.length - 1];
    check("editor: the first edit moves the trap under traps:", written, {
      type: "custom:rodent-trap-card", title: "Traps", stale_after: "12h", style: "station",
      traps: [{ device: "gn", name: "Solo", style: "station", kill: "binary_sensor.solo_kill", battery: "sensor.solo_battery", holds: { kill: false }, actions: ["button.x"] }],
    });
    {
      const html = (config) => {
        const c = mount(config, reg);
        const t = c.shadowRoot.querySelector(".tile");
        const got = [t.querySelector("svg.scene").getAttribute("class"), t.querySelector(".tile-body").textContent.replace(/\s+/g, " ").trim()];
        c.remove();
        return got;
      };
      const before = html(solo);
      check("the moved config renders the same (style still beats the Goodnature device)", html({ ...written, title: "T" }), before);
      check("the single-trap form uses the station art", /art-station/.test(before[0]), true);
    }
    ed.setConfig({ type: "custom:rodent-trap-card", offline_after: "2d", traps: [{ name: "Quiet", offline_after: "never", stale_after: 0 }] });
    await sleep(10);
    forms()[1].emit({ ...forms()[1].data, name: "Quiet one" });
    check("editor: a trap's threshold turned off stays off after an edit", events[events.length - 1].traps[0], { name: "Quiet one", offline_after: "never", stale_after: 0 });
    ed.setConfig({ type: "custom:rodent-trap-card", style: "Auto", sort: "Status", traps: [{ style: "Goodnature" }] });
    await sleep(10);
    check("editor: style and sort shown in lower case, card auto as the default", [forms()[0].data.style, forms()[0].data.sort, forms()[1].data.style], ["snap", "status", "goodnature"]);
    ed.setConfig(solo);
    await sleep(10);
    ed.shadowRoot.querySelector("button.add").click();
    check("editor: Add trap keeps the single trap first", events[events.length - 1].traps.map((t) => t.name || "-"), ["Solo", "-"]);
    let edError = null;
    try { ed.setConfig({ type: "custom:rodent-trap-card", traps: "x" }); } catch (e) { edError = e.message; }
    check("editor: traps that isn't a list goes back to YAML", edError, "`traps` must be a list.");
    ed.setConfig({ type: "custom:rodent-trap-card", title: "T" });
    await sleep(10);
    check("editor: no trap options = no traps", forms().length, 1);
    ed.setConfig({ type: "custom:rodent-trap-card", traps: null, kill: "binary_sensor.solo_kill" });
    await sleep(10);
    forms()[1].emit({ ...forms()[1].data, name: "Solo" });
    check("editor: traps: null with trap options is the single-trap form", events[events.length - 1], { type: "custom:rodent-trap-card", traps: [{ kill: "binary_sensor.solo_kill", name: "Solo" }] });
    ed.remove();
    check("card: a name alone is a (not set up) single trap", configError({ name: "Solo" }), "ok");
    check("card: single-trap errors name the option as written", configError({ kill: "binary_sensor.k", holds: { bogus: "button.x" } }),
      "holds.bogus is not a reading (use kill, trap, strikes, last_strike, battery, bait, co2, link, last_seen or signal).");
    check("card: still needs a trap", configError({ title: "T" }), "Add at least one trap under `traps:` (see the Rodent Trap Card README).");
    return out;
  });

  // Every card and trap example in the README loads: the checks above mustn't reject what the docs show.
  const examples = [...readFileSync(root + "README.md", "utf8").matchAll(/```yaml\n([\s\S]*?)```/g)].flatMap((m) => {
    const b = YAML.parse(m[1]);
    if (Array.isArray(b)) return b.every((x) => x && typeof x === "object" && !x.alias) ? [{ traps: b }] : [];
    if (!b || typeof b !== "object" || b.lovelace) return [];
    return b.type || b.traps ? [b] : b.actions || b.holds ? [{ traps: [b] }] : [];
  });
  const loaded = await page.evaluate((configs) => configs.map((c) => {
    try {
      document.createElement("rodent-trap-card").setConfig(c);
      return "ok";
    } catch (e) {
      return e.message;
    }
  }), examples);
  const bad = loaded.filter((r) => r !== "ok");
  lines.push(examples.length >= 8 && !bad.length ? `ok   README: all ${examples.length} card and trap examples load` : `FAIL README examples  -> ${examples.length} found, errors: ${JSON.stringify(bad)}`);

  // --- Item 6 in the demo: the Kitchen trap's perform_action button.
  const demo = await openPage(browser, demoUrl, { viewport: { width: 1280, height: 900 } });
  await demo.waitForTimeout(300);
  const kitchen = await demo.evaluate(async () => {
    const card = document.querySelector("rodent-trap-card");
    const tile = () => [...card.shadowRoot.querySelectorAll(".tile")].find((t) => t.querySelector(".name").textContent.trim() === "Kitchen");
    const bait = () => tile().querySelector(".m-bait .m-value").textContent.trim();
    [...document.querySelectorAll('.trap-ctl[data-trap="Kitchen"] button')].find((b) => b.textContent === "Bait −25").click();
    const low = bait();
    [...tile().querySelectorAll(".act")].find((b) => b.textContent.trim() === "Refill bait").click();
    const asked = tile().querySelector(".confirm span").textContent;
    tile().querySelector('[data-confirm="yes"]').click();
    await new Promise((r) => setTimeout(r, 600));
    return [low, asked, bait(), document.getElementById("toast").textContent];
  });
  const want = ["75%", "Mark the bait station as refilled?", "100%", "Called input_number.set_value on input_number.kitchen_trap_bait"];
  lines.push(JSON.stringify(kitchen) === JSON.stringify(want) ? "ok   demo: the perform_action button refills the bait" : `FAIL demo: the perform_action button refills the bait  -> expected ${JSON.stringify(want)} got ${JSON.stringify(kitchen)}`);
  return { lines, errors: [...page.errors, ...demo.errors] };
}

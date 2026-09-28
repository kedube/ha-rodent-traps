// Status, timestamps, level readings, the re-arm banner and device areas, run inside the fixture page.
// The page runs in Los Angeles time so that time-zone mistakes (local vs UTC, browser vs server) show up in CI too,
// whose runners are on UTC.
import { fixtureUrl, openPage } from "./lib.mjs";

export default async function run(browser) {
  const page = await openPage(browser, fixtureUrl, { timezoneId: "America/Los_Angeles" });
  const lines = await page.evaluate(async () => {
    const out = [];
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const st = (state, attributes = {}, changed = ago(0), updated = changed) => ({ state: String(state), attributes, last_changed: changed, last_updated: updated });
    const check = (name, got, expect) => {
      const fails = Object.entries(expect).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v)).map(([k, v]) => `${k}: expected ${JSON.stringify(v)} got ${JSON.stringify(got[k])}`);
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
      const svg = tile.querySelector("svg.scene");
      const banner = tile.querySelector(".banner");
      const got = {
        chip: tile.querySelector(".tile-head .chip").textContent.trim(),
        name: tile.querySelector(".name").textContent.trim(),
        loc: tile.querySelector(".loc") ? tile.querySelector(".loc").textContent.trim() : undefined,
        scene: svg ? svg.getAttribute("class").match(/st-(\w+)/)[1] : undefined,
        // The art is aria-hidden: it can't claim "armed and waiting" for a trap whose arming isn't known.
        aria: svg ? (svg.getAttribute("aria-hidden") === "true" && !svg.hasAttribute("aria-label") ? "hidden" : svg.getAttribute("aria-label")) : undefined,
        banner: banner ? banner.querySelector(".b-title").textContent.replace(/\s+/g, " ").trim() : undefined,
        bannerEntity: banner ? banner.dataset.entity : undefined,
        hint: tile.querySelector(".hint") ? tile.querySelector(".hint").textContent.trim() : undefined,
      };
      for (const m of tile.querySelectorAll(".metric")) {
        const k = m.className.match(/m-(\w+)/)[1];
        got[k] = m.querySelector(".m-value").textContent.trim();
        const since = m.querySelector("[data-since]");
        if (since) got[k + "_since"] = since.dataset.since;
      }
      return got;
    }
    const run = (name, trap, states, expect, extra = {}) => {
      const card = mount({ traps: [trap], ...extra.card }, { states, ...extra.hass });
      check(name, read(card), expect);
      card.remove();
    };
    const summary = (card) => [...card.shadowRoot.querySelectorAll(".summary .chip")].map((c) => c.textContent.trim());

    // --- Item 1: no green "Armed" without a usable trap reading.
    const pct = { unit_of_measurement: "%", device_class: "battery" };
    // README "classic snap trap": a contact sensor plus helpers, which never go unavailable.
    run("snap trap with helpers: contact sensor gone = Offline", {
      rearm: "binary_sensor.contact", battery: "sensor.contact_battery", strikes: "counter.strikes", bait: "input_select.bait",
    }, {
      "binary_sensor.contact": st("unavailable", {}, ago(180)), "sensor.contact_battery": st("unavailable", {}, ago(180)),
      "counter.strikes": st(3), "input_select.bait": st("Full"),
    }, { chip: "Offline", scene: "offline", banner: "Not reporting · 3 h ago" });
    // README Quick start "Garage": device sensors plus an input_number.
    run("quick start trap: device sensors gone = Offline", {
      kill: "binary_sensor.kill", strikes: "sensor.strikes", battery: "sensor.battery", bait: "input_number.bait",
    }, {
      "binary_sensor.kill": st("unavailable"), "sensor.strikes": st("unavailable"), "sensor.battery": st("unavailable"),
      "input_number.bait": st(3, { min: 0, max: 5 }),
    }, { chip: "Offline" });
    run("only helpers configured: never inferred offline", { strikes: "counter.s", bait: "input_number.b" },
      { "counter.s": st(2), "input_number.b": st(4, { min: 0, max: 5 }) }, { chip: "All good", scene: "armed" });
    run("a number entity is a device entity, not a helper", { kill: "binary_sensor.k", bait: "number.b" },
      { "binary_sensor.k": st("unavailable"), "number.b": st("unavailable") }, { chip: "Offline" });
    run("kill unavailable, battery reporting = Status unknown", { kill: "binary_sensor.k", battery: "sensor.b" },
      { "binary_sensor.k": st("unavailable"), "sensor.b": st(80, pct) }, { chip: "Status unknown", scene: "idle", aria: "hidden", battery: "80%" });
    run("kill unknown after a restart = Status unknown", { kill: "binary_sensor.k", battery: "sensor.b", strikes: "counter.s" },
      { "binary_sensor.k": st("unknown"), "sensor.b": st(80, pct), "counter.s": st(4) }, { chip: "Status unknown", scene: "idle" });
    run("unrecognised kill word = Status unknown", { kill: "sensor.k", battery: "sensor.b" },
      { "sensor.k": st("initialising"), "sensor.b": st(80, pct) }, { chip: "Status unknown" });
    run("armed and rearm both unknown = Status unknown", { armed: "binary_sensor.a", rearm: "binary_sensor.r", battery: "sensor.b" },
      { "binary_sensor.a": st("unknown"), "binary_sensor.r": st("unknown"), "sensor.b": st(80, pct) }, { chip: "Status unknown" });
    run("every entity unknown = No data", { kill: "binary_sensor.k", battery: "sensor.b" },
      { "binary_sensor.k": st("unknown"), "sensor.b": st("unknown") }, { chip: "No data", scene: "idle" });
    run("no entities = Not set up", {}, {}, { chip: "Not set up", name: "Trap 1", scene: "idle", aria: "hidden" });
    run("kill off = Armed, lively scene", { kill: "binary_sensor.k" }, { "binary_sensor.k": st("off") },
      { chip: "Armed", scene: "armed", aria: "hidden" });
    run("armed on = Armed", { armed: "binary_sensor.a" }, { "binary_sensor.a": st("on") }, { chip: "Armed", aria: "hidden" });
    run("battery-only trap = All good, not 'armed and waiting'", { battery: "sensor.b" }, { "sensor.b": st(80, pct) },
      { chip: "All good", scene: "armed", aria: "hidden" });
    run("unknown catch + low battery: warning, idle scene", { kill: "binary_sensor.k", battery: "sensor.b" },
      { "binary_sensor.k": st("unknown"), "sensor.b": st(5, pct) }, { chip: "Low battery", scene: "idle", aria: "hidden" });
    run("catch without a re-arm sensor reads its status", { kill: "binary_sensor.k" }, { "binary_sensor.k": st("on") },
      { chip: "Catch detected", scene: "kill", aria: "hidden" });
    {
      const c = mount({ traps: [{ battery: "sensor.b" }, { kill: "binary_sensor.k" }] },
        { states: { "sensor.b": st(80, pct), "binary_sensor.k": st("unknown") } });
      check("summary: an unknown trap is not 'All clear'", { chips: summary(c) }, { chips: ["No alerts"] });
      c.remove();
      const s = mount({ sort: "status", traps: [{ name: "Fine", kill: "binary_sensor.ok" }, { name: "Unsure", kill: "binary_sensor.k" }] },
        { states: { "binary_sensor.ok": st("off"), "binary_sensor.k": st("unknown") } });
      check("sort: status puts Status unknown above Armed", { order: [...s.shadowRoot.querySelectorAll(".tile .name")].map((n) => n.textContent) }, { order: ["Unsure", "Fine"] });
      s.remove();
    }

    // --- Item 18: timestamps and relative times.
    // input_datetime: the state is wall-clock time on the server (here Berlin); the timestamp attribute is the instant.
    const berlin = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
    const twoHoursAgo = Math.floor((Date.now() - 2 * 3600000) / 1000) * 1000;
    const dt = { has_date: true, has_time: true, timestamp: twoHoursAgo / 1000 };
    run("input_datetime uses its timestamp, not the browser's time zone", { last_seen: "input_datetime.seen", kill: "binary_sensor.k" },
      { "input_datetime.seen": st(berlin(twoHoursAgo), dt, ago(600)), "binary_sensor.k": st("off") },
      { link: "2 h ago", chip: "Armed", link_since: new Date(twoHoursAgo).toISOString() },
      { card: { offline_after: "6h" } });
    run("input_datetime far away in server time is still offline by the real age", { last_seen: "input_datetime.seen", kill: "binary_sensor.k" },
      { "input_datetime.seen": st(berlin(Date.now() - 10 * 3600000), { has_date: true, has_time: true, timestamp: (Date.now() - 10 * 3600000) / 1000 }), "binary_sensor.k": st("off") },
      { chip: "Offline" }, { card: { offline_after: "6h" } });
    {
      const d = new Date();
      d.setDate(d.getDate() - 3);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
      run("a bare date is local midnight, not UTC midnight", { last_strike: "input_datetime.day" },
        { "input_datetime.day": st(ymd, { has_date: true, has_time: false, timestamp: 0 }) }, { last_strike_since: localMidnight });
      run("a bare date on a sensor is local midnight too", { last_strike: "sensor.day" }, { "sensor.day": st(ymd, { device_class: "date" }) }, { last_strike_since: localMidnight });
    }
    const epochIso = new Date(1790000000000).toISOString();
    for (const [unit, v] of [["seconds", "1790000000"], ["milliseconds", "1790000000000"], ["microseconds", "1790000000000000"], ["nanoseconds", "1790000000000000000"]]) {
      run(`epoch in ${unit}`, { last_seen: "sensor.ls" }, { "sensor.ls": st(v, {}, ago(5)) }, { link_since: epochIso });
    }
    run("an epoch attribute too large for a date falls back instead of throwing", { last_seen: { entity: "sensor.ls", attribute: "ts" }, kill: "binary_sensor.k" },
      { "sensor.ls": st("ok", { ts: 1e25 }, ago(300), ago(30)), "binary_sensor.k": st("off") }, { link: "30 min ago", chip: "Armed" });
    run("last_seen falls back to last_updated", { last_seen: "sensor.ls" }, { "sensor.ls": st("ok", {}, ago(300), ago(60)) }, { link: "1 h ago" });
    run("last_strike falls back to last_changed", { last_strike: "sensor.s" }, { "sensor.s": st("3", {}, ago(300), ago(60)) }, { last_strike: "5 h ago" });
    for (const [mins, want] of [[0.5, "just now"], [0.9, "1 min ago"], [59.7, "1 h ago"], [89, "1 h ago"], [60 * 23.8, "1 d ago"], [60 * 36, "2 d ago"]]) {
      run(`relative time ${mins} min = "${want}"`, { last_seen: "sensor.ls" }, { "sensor.ls": st(ago(mins), { device_class: "timestamp" }) }, { link: want });
    }

    // --- Item 35: level readings.
    run("max entity reporting 0: value only, not Out of bait", { bait: { entity: "sensor.bait", max: "sensor.cap" } },
      { "sensor.bait": st(5), "sensor.cap": st(0) }, { bait: "5", chip: "All good" });
    run("volt battery without a range: value only, not Low battery", { battery: "sensor.v" },
      { "sensor.v": st(3.0, { unit_of_measurement: "V", device_class: "voltage" }) }, { battery: "3 V", chip: "All good" });
    run("millivolt battery without a range: value only", { battery: "sensor.mv" },
      { "sensor.mv": st(2950, { unit_of_measurement: "mV" }) }, { battery: "2950 mV", chip: "All good" });
    run("voltage device class without a unit: value only", { battery: "sensor.v" },
      { "sensor.v": st(3.1, { device_class: "voltage" }) }, { battery: "3.1", chip: "All good" });
    run("volt battery with min/max: low below the range", { battery: { entity: "sensor.v", min: 2.4, max: 3.2 } },
      { "sensor.v": st(2.5, { unit_of_measurement: "V" }) }, { battery: "2.5 V", chip: "Low battery" });
    run("volt battery with min/max: fine near full", { battery: { entity: "sensor.v", min: 2.4, max: 3.2 } },
      { "sensor.v": st(3.1, { unit_of_measurement: "V" }) }, { chip: "All good" });
    run("explicit min on an input_number without max", { bait: { entity: "input_number.b", min: 1 } },
      { "input_number.b": st(1, { min: 0, max: 5 }) }, { bait: "1/5", chip: "Out of bait" });
    run("explicit max on an input_number keeps the helper's min", { bait: { entity: "input_number.b", max: 9 } },
      { "input_number.b": st(1, { min: 1, max: 5 }) }, { bait: "1/9", chip: "Out of bait" });
    run("input_number range from the helper", { bait: "input_number.b" }, { "input_number.b": st(3, { min: 0, max: 5 }) }, { bait: "3/5", chip: "All good" });
    run("percentage with an empty range shows the plain value", { battery: { entity: "sensor.b", max: 0 } },
      { "sensor.b": st(80, { unit_of_measurement: "%" }) }, { battery: "80%", chip: "All good" });
    run("device low alert still applies without a range", { battery: { entity: "sensor.v", low_entity: "binary_sensor.low" } },
      { "sensor.v": st(2.2, { unit_of_measurement: "V" }), "binary_sensor.low": st("on") }, { battery: "2.2 V", chip: "Low battery" });

    // --- Item 36: the "Trap sprung" banner follows the sensor that decided it.
    run("re-arm unavailable: banner time and target from the armed sensor", { armed: "binary_sensor.a", rearm: "binary_sensor.r" },
      { "binary_sensor.a": st("off", {}, ago(10)), "binary_sensor.r": st("unavailable", {}, ago(3 * 1440)) },
      { chip: "Needs re-arm", banner: "Trap sprung · 10 min ago", bannerEntity: "binary_sensor.a" });
    run("re-arm reporting: banner time and target from the re-arm sensor", { armed: "binary_sensor.a", rearm: "binary_sensor.r" },
      { "binary_sensor.a": st("unavailable", {}, ago(3 * 1440)), "binary_sensor.r": st("on", {}, ago(20)) },
      { chip: "Needs re-arm", banner: "Trap sprung · 20 min ago", bannerEntity: "binary_sensor.r" });
    run("re-arm only", { rearm: "sensor.status" }, { "sensor.status": st("sprung", {}, ago(95)) }, { banner: "Trap sprung · 2 h ago", bannerEntity: "sensor.status" });

    // --- Item 39: a child device without an area of its own uses its parent's.
    const areas = { attic: { area_id: "attic", name: "Attic" }, garage: { area_id: "garage", name: "Garage" } };
    const devices = {
      hub: { id: "hub", name: "Trap hub", manufacturer: "Acme", area_id: "attic", parent_device_id: null },
      t1: { id: "t1", name: "Trap 1", manufacturer: "Acme", area_id: null, parent_device_id: "hub" },
      t2: { id: "t2", name: "Trap 2", manufacturer: "Acme", area_id: "garage", parent_device_id: "hub" },
      old: { id: "old", name: "Old trap", manufacturer: "Acme", area_id: null },
      orphan: { id: "orphan", name: "Orphan trap", manufacturer: "Acme", area_id: null, parent_device_id: "gone" },
    };
    const entities = {}, states = {};
    for (const d of ["t1", "t2", "old", "orphan"]) {
      entities[`binary_sensor.${d}_kill_alert`] = { entity_id: `binary_sensor.${d}_kill_alert`, device_id: d };
      states[`binary_sensor.${d}_kill_alert`] = st("off");
    }
    const reg = { entities, devices, areas };
    run("child device: parent's area", { device: "t1" }, states, { name: "Trap 1", loc: "Attic" }, { hass: reg });
    run("child device with its own area keeps it", { device: "t2" }, states, { loc: "Garage" }, { hass: reg });
    run("device without the parent field: no area", { device: "old" }, states, { loc: undefined }, { hass: reg });
    run("missing parent: no area", { device: "orphan" }, states, { loc: undefined }, { hass: reg });
    run("entity-only trap on a child device: parent's area", { kill: "binary_sensor.t1_kill_alert" }, states, { loc: "Attic" }, { hass: reg });
    {
      const ed = document.createElement("rodent-trap-card-editor");
      document.body.appendChild(ed);
      ed.hass = { states, ...reg };
      ed.setConfig({ type: "custom:rodent-trap-card", traps: [{ device: "t1" }] });
      await new Promise((r) => setTimeout(r, 50));
      const small = ed.shadowRoot.querySelector("summary .label small");
      check("editor summary: child device shows the parent's area", { loc: small ? small.textContent : null }, { loc: "Attic" });
      ed.remove();
    }
    return out;
  });
  return { lines, errors: page.errors };
}

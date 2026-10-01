// Keyboard focus through repaints, the confirmation bar's Escape and timeout, reading labels and tooltips, and the
// structure and announcements screen readers get.
import { demoUrl, fixtureUrl, openPage } from "./lib.mjs";

/** In-page helpers, added to every page this suite opens. */
function helpers() {
  const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
  window.T = {
    iso,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    st: (state, attributes = {}, changed = iso()) => ({ state: String(state), attributes, last_changed: changed, last_updated: iso() }),
    /**
     * A card with its own state table. push(id, state) changes one entity (undefined removes it), push({ id: state })
     * several at once, and either hands the card a new hass. `extra` is spread into every hass (registries, callService).
     */
    live(config, states, extra = {}) {
      const S = { ...states };
      const X = { ...extra };
      const hass = () => ({ states: { ...S }, ...X });
      const c = document.createElement("rodent-trap-card");
      document.body.appendChild(c);
      c.setConfig(config);
      c.hass = hass();
      const put = (id, state, attrs) => {
        if (state === undefined) delete S[id];
        else S[id] = T.st(state, attrs || (S[id] ? S[id].attributes : {}), S[id] && S[id].state === String(state) ? S[id].last_changed : iso());
      };
      c.push = (id, state, attrs) => {
        if (typeof id === "object") for (const [k, v] of Object.entries(id)) put(k, v);
        else put(id, state, attrs);
        c.hass = hass();
      };
      c.extra = (patch) => {
        Object.assign(X, patch);
        c.hass = hass();
      };
      c.q = (s) => c.shadowRoot.querySelector(s);
      c.qa = (s) => [...c.shadowRoot.querySelectorAll(s)];
      // What has keyboard focus inside the card, as a short description.
      c.focused = () => {
        const a = c.shadowRoot.activeElement;
        if (!a) return null;
        if (a.dataset.confirm) return `confirm:${a.dataset.confirm}`;
        if (a.dataset.act) return `act:${a.dataset.act}`;
        const m = /(?:^|\s)m-([a-z0-9_]+)/.exec(a.className);
        if (m && a.classList.contains("metric")) return `reading:${m[1]}`;
        return a.className.split(" ")[0];
      };
      return c;
    },
  };
}

export default async function run(browser) {
  const lines = [];
  const errors = [];
  const check = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    lines.push(g === w ? `ok   ${name}` : `FAIL ${name}  -> expected ${w} got ${g}`);
  };
  const open = async (url, options = {}, before) => {
    const page = await openPage(browser, null, { viewport: { width: 900, height: 1400 }, ...options });
    await page.addInitScript(helpers);
    if (before) await before(page);
    await page.goto(url);
    return page;
  };
  /** Chrome's own accessibility tree: what screen readers get. */
  const axTree = async (page) => {
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    await cdp.detach();
    return nodes
      .filter((n) => !n.ignored)
      .map((n) => {
        const props = Object.fromEntries((n.properties || []).map((p) => [p.name, p.value && p.value.value]));
        return { role: n.role && n.role.value, name: n.name ? n.name.value : "", description: n.description ? n.description.value : "", props };
      });
  };

  // ===========================================================================================================
  // Item 27: keyboard focus survives repaints, and the prompt has Escape and an opener to go back to.
  // ===========================================================================================================
  const page = await open(fixtureUrl);

  const redraw = await page.evaluate(() => {
    const { st } = T;
    const areas = { a: { area_id: "a", name: "Attic" }, b: { area_id: "b", name: "Barn" } };
    const devices = { d: { id: "d", name: "Trap" } };
    const entities = { "binary_sensor.d_kill_alert": { entity_id: "binary_sensor.d_kill_alert", device_id: "d" } };
    const c = T.live({ traps: [{ device: "d", online: "binary_sensor.on", battery: "sensor.b" }] },
      { "binary_sensor.d_kill_alert": st("off"), "binary_sensor.on": st("on"), "sensor.b": st(80, { unit_of_measurement: "%" }) },
      { devices, entities, areas });
    const out = {};
    // A reading whose icon changes (check mark to bell) is redrawn, not updated in place.
    const kill = c.q(".m-kill");
    kill.focus();
    c.push("binary_sensor.d_kill_alert", "on");
    out.reading = { redrawn: c.q(".m-kill") !== kill, focus: c.focused() };
    // The catch banner becomes the offline banner: a different drawing, so a new element.
    const banner = c.q(".banner");
    banner.focus();
    c.push({ "binary_sensor.d_kill_alert": "off", "binary_sensor.on": "off" });
    out.banner = { redrawn: c.q(".banner") !== banner, focus: c.focused(), text: c.q(".banner .b-title").textContent.split("·")[0].trim() };
    // The banner goes: focus falls back to the trap's name, not to the page.
    c.push("binary_sensor.on", "on");
    out.bannerGone = { banner: !!c.q(".banner"), focus: c.focused() };
    // The device gets an area: the head is redrawn with a location line, and the name keeps focus.
    const name = c.q(".name-btn");
    name.focus();
    c.extra({ devices: { d: { ...devices.d, area_id: "b" } } });
    out.head = { redrawn: c.q(".name-btn") !== name, focus: c.focused(), loc: c.q(".loc") && c.q(".loc").textContent };
    // Focus somewhere else on the page is left alone by a repaint.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    c.push("binary_sensor.d_kill_alert", "on");
    out.outside = document.activeElement === outside && c.shadowRoot.activeElement === null;
    outside.remove();
    c.remove();
    return out;
  });
  check("focus: a redrawn reading keeps it", redraw.reading, { redrawn: true, focus: "reading:kill" });
  check("focus: a redrawn banner keeps it", redraw.banner, { redrawn: true, focus: "banner", text: "Not reporting" });
  check("focus: a banner that goes hands it to the trap's name", redraw.bannerGone, { banner: false, focus: "name-btn" });
  check("focus: a redrawn head keeps it on the name", redraw.head, { redrawn: true, focus: "name-btn", loc: "Barn" });
  check("focus: outside the card, a repaint doesn't take it", redraw.outside, true);

  // A status re-sort moves tiles. insertBefore (browsers without moveBefore) takes focus off a moved tile.
  const resort = await page.evaluate(() => {
    const { st } = T;
    const run = (noMoveBefore) => {
      const c = T.live({ sort: "status", traps: [{ name: "A", kill: "binary_sensor.a", battery: "sensor.ab" }, { name: "B", kill: "binary_sensor.b", battery: "sensor.bb" }] },
        { "binary_sensor.a": st("off"), "binary_sensor.b": st("off"), "sensor.ab": st(80, { unit_of_measurement: "%" }), "sensor.bb": st(80, { unit_of_measurement: "%" }) });
      if (noMoveBefore) c._grid.moveBefore = undefined;
      const battery = c.qa(".tile")[1].querySelector(".m-battery");
      battery.focus();
      c.push("sensor.bb", 5);
      const out = { order: c.qa(".tile .name").map((n) => n.textContent), same: c.shadowRoot.activeElement === battery };
      c.remove();
      return out;
    };
    return { insertBefore: run(true), moveBefore: run(false) };
  });
  check("re-sort: focus stays on a moved tile's reading (insertBefore)", resort.insertBefore, { order: ["B", "A"], same: true });
  check("re-sort: and where the browser has moveBefore", resort.moveBefore, { order: ["B", "A"], same: true });

  // A busy button stays focusable (aria-disabled, not disabled) and still isn't sent twice.
  const busy = await page.evaluate(async () => {
    const { st, sleep } = T;
    const calls = [];
    let finish = null;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", actions: [{ entity: "button.go", name: "Go" }] }] },
      { "binary_sensor.k": st("off"), "button.go": st("unknown") },
      { callService: (d, s, data, target) => { calls.push(target.entity_id); return new Promise((r) => (finish = r)); } });
    // The browser takes focus off a disabled control at its next rendering update, hence the frames.
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const go = c.q(".act");
    go.focus();
    go.click();
    await frames();
    const during = { focus: c.focused(), same: c.q(".act") === go, aria: go.getAttribute("aria-disabled"), disabled: go.disabled };
    go.click();
    c._request(0, "act", "0");
    during.calls = calls.length;
    finish();
    await sleep(10);
    await frames();
    const after = { focus: c.focused(), aria: go.getAttribute("aria-disabled"), flash: c.q(".flash").textContent };
    c.remove();
    return { during, after };
  });
  check("busy button: keeps focus while its call runs, and isn't sent twice", busy.during, { focus: "act:0", same: true, aria: "true", disabled: false, calls: 1 });
  check("busy button: released with focus still on it", busy.after, { focus: "act:0", aria: null, flash: "Go: done" });
  errors.push(...page.errors);
  await page.close();

  // --- The prompt, driven by a real keyboard.
  const kb = await open(fixtureUrl);
  await kb.evaluate(() => {
    const { st } = T;
    window.calls = [];
    window.escapes = 0;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.escapes++; });
    window.c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", last_seen: "sensor.seen", battery: "sensor.b", holds: { kill: "button.clear" },
      actions: [{ entity: "button.go", name: "Go", confirm: true }] }] },
      { "binary_sensor.k": st("on"), "sensor.seen": st(T.iso(60000), { device_class: "timestamp" }), "sensor.b": st(80, { unit_of_measurement: "%" }),
        "button.clear": st("unknown", { friendly_name: "Clear" }), "button.go": st("unknown") },
      { callService: async (d, s, data, target) => { window.calls.push(target.entity_id); } });
  });
  const state = () => kb.evaluate(() => ({ prompt: !!c.q(".confirm"), focus: c.focused(), calls: window.calls.slice() }));
  const openHold = async () => {
    await kb.evaluate(() => c.q(".m-kill").focus());
    await kb.keyboard.press("Shift+Enter");
  };

  await openHold();
  // A check-in while the prompt is open: Enter still confirms. It used to drop focus to the page.
  await kb.evaluate(() => c.push("sensor.seen", T.iso()));
  const checkIn = await state();
  await kb.keyboard.press("Enter");
  await kb.waitForTimeout(30);
  check("prompt: a check-in while it's open leaves focus on the confirm button", checkIn, { prompt: true, focus: "confirm:yes", calls: [] });
  check("prompt: Enter then confirms, and focus goes back to the reading", await state(), { prompt: false, focus: "reading:kill", calls: ["button.clear"] });

  await openHold();
  await kb.keyboard.press("Escape");
  check("Escape: closes the prompt and puts focus back on the reading that opened it", await state(), { prompt: false, focus: "reading:kill", calls: ["button.clear"] });
  check("Escape: goes no further than the card", await kb.evaluate(() => window.escapes), 0);

  await openHold();
  await kb.keyboard.press("Shift+Tab");
  const onCancel = (await state()).focus;
  await kb.keyboard.press("Enter");
  check("Cancel: closes the prompt and puts focus back on the reading", [onCancel, await state()], ["confirm:no", { prompt: false, focus: "reading:kill", calls: ["button.clear"] }]);

  await kb.evaluate(() => c.q(".act").focus());
  await kb.keyboard.press("Enter");
  const buttonPrompt = (await state()).focus;
  await kb.keyboard.press("Escape");
  check("Escape: a button's prompt gives focus back to the button", [buttonPrompt, (await state()).focus], ["confirm:yes", "act:0"]);

  // Escape anywhere else isn't the card's to take.
  await kb.evaluate(() => c.q(".m-battery").focus());
  await kb.keyboard.press("Escape");
  check("Escape: outside a prompt it reaches the page as usual", await kb.evaluate(() => window.escapes), 1);

  // After the whole prompt, call and result, nothing is left to go back to.
  await openHold();
  await kb.keyboard.press("Enter");
  await kb.waitForTimeout(30);
  const during = await kb.evaluate(() => c._tiles[0].opener);
  await kb.waitForTimeout(2600);
  check("opener: kept through the call and its result, then cleared", [during, await kb.evaluate(() => [c._tiles[0].opener, !!c.q(".flash")])], [{ kind: "hold", key: "kill" }, [null, false]]);
  errors.push(...kb.errors);
  await kb.close();

  // --- The 10 s timeout, on a fake clock: it waits for a keyboard user in the prompt, but not for a pointer user.
  const clock = await open(fixtureUrl, {}, (p) => p.clock.install());
  await clock.evaluate(() => {
    const { st } = T;
    window.c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", battery: "sensor.b", holds: { kill: "button.clear" } }] },
      { "binary_sensor.k": st("on"), "sensor.b": st(80, { unit_of_measurement: "%" }), "button.clear": st("unknown", { friendly_name: "Clear" }) },
      { callService: async () => {} });
  });
  const promptState = () => clock.evaluate(() => ({ prompt: !!c.q(".confirm"), focus: c.focused() }));
  await clock.evaluate(() => c.q(".m-kill").focus());
  await clock.keyboard.press("Shift+Enter");
  const visible = await clock.evaluate(() => c.shadowRoot.activeElement.matches(":focus-visible"));
  await clock.clock.runFor(10500);
  const kept = await promptState();
  await clock.keyboard.press("Shift+Tab");
  await clock.clock.runFor(10500);
  const keptOnCancel = await promptState();
  // Keyboard focus leaves the prompt: it times out, and focus isn't moved.
  await clock.evaluate(() => c.q(".m-battery").focus());
  await clock.clock.runFor(10500);
  check("timeout: waits while the keyboard is in the prompt", [visible, kept, keptOnCancel], [true, { prompt: true, focus: "confirm:yes" }, { prompt: true, focus: "confirm:no" }]);
  check("timeout: closes once keyboard focus has left it, and leaves focus where it is", await promptState(), { prompt: false, focus: "reading:battery" });

  // A long-press: the confirm button has focus, but not keyboard focus, so the prompt times out as before.
  const box = await clock.evaluate(() => {
    const r = c.q(".m-kill").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await clock.mouse.move(box.x, box.y);
  await clock.mouse.down();
  await clock.clock.runFor(700);
  await clock.mouse.up();
  const pointerOpen = await clock.evaluate(() => ({ prompt: !!c.q(".confirm"), visible: c.shadowRoot.activeElement.matches(":focus-visible") }));
  await clock.clock.runFor(10500);
  check("timeout: a long-press prompt still closes after 10 s", [pointerOpen, (await promptState()).prompt], [{ prompt: true, visible: false }, false]);
  errors.push(...clock.errors);
  await clock.close();

  // ===========================================================================================================
  // Item 14: reading labels, names and tooltips say the state, stay current and don't spell out entity IDs.
  // ===========================================================================================================
  const labels = await open(fixtureUrl);
  const readings = await labels.evaluate(() => {
    const { st, iso } = T;
    const pct = { unit_of_measurement: "%" };
    const read = (trap, states, card = {}) => {
      const c = T.live({ ...card, traps: [trap] }, states);
      const out = {};
      for (const m of c.qa(".metric")) {
        const k = /(?:^|\s)m-([a-z0-9_]+)/.exec(m.className)[1];
        out[k] = { label: m.querySelector(".m-label").textContent, name: m.getAttribute("aria-label"), title: m.getAttribute("title") };
      }
      out.chip = c.q(".tile-head .chip").textContent.trim();
      c.remove();
      return out;
    };
    return {
      plain: read({ kill: "binary_sensor.k", battery: "sensor.b" }, { "binary_sensor.k": st("off"), "sensor.b": st(80, pct) }),
      // A catch takes the chip: the low battery and bait still say so, in words.
      low: read({ kill: "binary_sensor.k", battery: "sensor.b", bait: "sensor.bait" }, { "binary_sensor.k": st("on"), "sensor.b": st(8, pct), "sensor.bait": st(10, pct) }),
      out: read({ bait: "sensor.bait" }, { "sensor.bait": st(0, pct) }),
      // The value already says it: no "Battery low: Low".
      words: read({ battery: "binary_sensor.bl", bait: "input_select.bait" }, { "binary_sensor.bl": st("on"), "input_select.bait": st("empty") }),
      late: read({ kill: "binary_sensor.k", last_seen: "sensor.seen" }, { "binary_sensor.k": st("on"), "sensor.seen": st(iso(13 * 3600e3), { device_class: "timestamp" }) }, { stale_after: "12h" }),
      dash: read({ battery: "sensor.b", bait: "sensor.gone" }, { "sensor.b": st("unknown") }),
    };
  });
  check("labels: a plain reading's name is label and value, without the entity ID", readings.plain.battery, { label: "Battery", name: "Battery: 80%", title: "Battery: 80%\nsensor.b" });
  check("labels: low battery and low bait say so when a catch has the chip",
    [readings.low.chip, readings.low.battery.label, readings.low.battery.name, readings.low.bait.name],
    ["Catch detected", "Battery low", "Battery low: 8%", "Bait low: 10%"]);
  check("labels: no bait says Out of bait", readings.out.bait, { label: "Out of bait", name: "Out of bait: 0%", title: "Out of bait: 0%\nsensor.bait" });
  check("labels: not repeated when the value already says it", [readings.words.battery.name, readings.words.bait.name], ["Battery: Low", "Bait: Empty"]);
  check("labels: a late check-in says so", [readings.late.chip, readings.late.last_seen.label, readings.late.last_seen.name], ["Catch detected", "Last seen, late", "Last seen, late: 13 h ago"]);
  check("labels: a dash is read as words", [readings.dash.battery.name, readings.dash.bait.name], ["Battery: unknown", "Bait: not found"]);

  const holdAttrs = await labels.evaluate(() => {
    const { st } = T;
    const c = T.live({ traps: [{ kill: "binary_sensor.k", battery: "sensor.b", holds: { kill: "button.clear" } }] },
      { "binary_sensor.k": st("off"), "sensor.b": st(80, { unit_of_measurement: "%" }), "button.clear": st("unknown", { friendly_name: "Clear kill alert" }) });
    const attrs = (m) => ({ name: m.getAttribute("aria-label"), title: m.getAttribute("title"), keys: m.getAttribute("aria-keyshortcuts"), description: m.getAttribute("aria-description") });
    const out = { hold: attrs(c.q(".m-kill")), plain: attrs(c.q(".m-battery")) };
    c.remove();
    return out;
  });
  check("hold: tooltip names the action, with the entity ID on its own line", holdAttrs.hold.title, "Catch: Clear · Hold: Clear kill alert\nbinary_sensor.k");
  check("hold: Shift+Enter is announced as its shortcut", [holdAttrs.hold.name, holdAttrs.hold.keys, holdAttrs.hold.description],
    ["Catch: Clear", "Shift+Enter", "Shift+Enter or press and hold: Clear kill alert"]);
  check("hold: readings without one have no shortcut", [holdAttrs.plain.keys, holdAttrs.plain.description], [null, null]);

  // Hours later, with no state change, the tooltip and the name have moved on with the text.
  const times = await labels.evaluate(() => {
    const { st, iso } = T;
    const realNow = Date.now;
    const c = T.live({ traps: [{ kill: "binary_sensor.k", last_seen: "sensor.seen", holds: { link: "button.ping" } }] },
      { "binary_sensor.k": st("off"), "sensor.seen": st(iso(), { device_class: "timestamp" }), "button.ping": st("unknown", { friendly_name: "Ping" }) });
    const link = c.q(".m-last_seen");
    const at = () => ({ text: link.querySelector(".m-value").textContent, name: link.getAttribute("aria-label"), title: link.getAttribute("title"), fit: /fit-(xs|s)\b/.test(link.className) });
    const before = at();
    const seen = [];
    const obs = new MutationObserver((ms) => ms.forEach((m) => seen.push(m.attributeName || m.type)));
    obs.observe(link, { attributes: true, subtree: true, childList: true, characterData: true });
    c._refreshTimes();
    const quiet = seen.length;
    let later;
    try {
      Date.now = () => realNow() + 3 * 3600e3;
      c._tick();
      later = at();
    } finally {
      Date.now = realNow;
    }
    obs.disconnect();
    const out = { before, quiet, later, same: c.q(".m-last_seen") === link, holdKept: link.dataset.hold };
    c.remove();
    return out;
  });
  check("times: nothing is touched when the text is unchanged", times.quiet, 0);
  check("times: text, name, tooltip and size move on together", [times.before, times.later],
    [{ text: "just now", name: "Last seen: just now", title: "Last seen: just now · Hold: Ping\nsensor.seen", fit: true },
     { text: "3 h ago", name: "Last seen: 3 h ago", title: "Last seen: 3 h ago · Hold: Ping\nsensor.seen", fit: false }]);
  check("times: updated in place, with the old Link hold on Last seen", [times.same, times.holdKept], [true, "last_seen"]);

  // A reading named with a digit (co2) keeps focus when the readings around it are redrawn.
  const co2Focus = await labels.evaluate(() => {
    const { st } = T;
    const ent = (id) => ({ entity_id: id, device_id: "d" });
    const c = T.live({ traps: [{ device: "d" }] },
      { "binary_sensor.d_kill_alert": st("off"), "sensor.d_co2_shots_remaining": st(20, { unit_of_measurement: "shots" }), "sensor.d_rssi": st(-60, { unit_of_measurement: "dBm" }) },
      { devices: { d: { id: "d", name: "D" } }, entities: { "binary_sensor.d_kill_alert": ent("binary_sensor.d_kill_alert"), "sensor.d_co2_shots_remaining": ent("sensor.d_co2_shots_remaining") } });
    c.q(".m-co2").focus();
    const before = c.focused();
    c.extra({ entities: { ...c.hass.entities, "sensor.d_rssi": ent("sensor.d_rssi") } });
    const out = { before, after: c.focused(), readings: c.qa(".metric").length };
    c.remove();
    return out;
  });
  check("focus: stays on CO2 when a reading is added beside it", co2Focus, { before: "reading:co2", after: "reading:co2", readings: 3 });
  errors.push(...labels.errors);
  await labels.close();

  // ===========================================================================================================
  // Item 43: headings, a list, a hidden drawing, and a status region that reads out what changes.
  // ===========================================================================================================
  const sr = await open(fixtureUrl);
  await sr.evaluate(() => {
    const { st } = T;
    window.moreInfo = [];
    window.addEventListener("hass-more-info", (e) => window.moreInfo.push(e.detail.entityId));
    window.c = T.live({ title: "Traps", traps: [
      { name: "Garage", location: "Shed", kill: "binary_sensor.g", battery: "sensor.gb", holds: { kill: "button.clear" } },
      { name: "Loft", kill: "binary_sensor.l" },
    ] }, { "binary_sensor.g": st("on"), "sensor.gb": st(80, { unit_of_measurement: "%" }), "binary_sensor.l": st("off"), "button.clear": st("unknown", { friendly_name: "Clear kill alert" }) });
  });
  const dom = await sr.evaluate(() => {
    const tile = c.qa(".tile")[0];
    const head = tile.querySelector(".tile-head");
    const btn = tile.querySelector(".name .name-btn");
    const svg = tile.querySelector("svg.scene");
    return {
      title: [c.q(".title").getAttribute("role"), c.q(".title").getAttribute("aria-level")],
      grid: c.q(".grid").getAttribute("role"),
      tiles: c.qa(".tile").map((t) => t.getAttribute("role")),
      name: [tile.querySelector(".name").getAttribute("role"), tile.querySelector(".name").getAttribute("aria-level")],
      button: { role: btn.getAttribute("role"), tabindex: btn.getAttribute("tabindex"), entity: btn.dataset.entity, text: btn.textContent },
      head: { role: head.getAttribute("role"), tabindex: head.getAttribute("tabindex"), entity: head.dataset.entity },
      scene: { hidden: svg.getAttribute("aria-hidden"), role: svg.getAttribute("role"), label: svg.getAttribute("aria-label") },
      summaryLive: c.q(".summary").hasAttribute("aria-live"),
      live: { role: c.q(".wrap > .sr-only").getAttribute("role"), text: c.q(".sr-only").textContent },
    };
  });
  check("structure: the card title is a level 2 heading", dom.title, ["heading", "2"]);
  check("structure: traps are a list", [dom.grid, dom.tiles], ["list", ["listitem", "listitem"]]);
  check("structure: a trap's name is a level 3 heading holding its button", [dom.name, dom.button], [["heading", "3"], { role: "button", tabindex: "0", entity: "binary_sensor.g", text: "Garage" }]);
  check("structure: the head itself is no longer a button, but a click on it still opens more-info", dom.head, { role: null, tabindex: null, entity: "binary_sensor.g" });
  check("structure: the drawing is hidden from screen readers", dom.scene, { hidden: "true", role: null, label: null });
  check("structure: the summary isn't a live region; the status region is, and says nothing on first paint", [dom.summaryLive, dom.live], [false, { role: "status", text: "" }]);

  const ax = await axTree(sr);
  const find = (role, name) => ax.find((n) => n.role === role && n.name === name);
  const garage = find("button", "Garage");
  const kill = find("button", "Catch: Caught!");
  check("accessibility tree: headings for the card and each trap",
    ax.filter((n) => n.role === "heading").map((n) => `${n.props.level}:${n.name}`), ["2:Traps", "3:Garage", "3:Loft"]);
  check("accessibility tree: one list with a list item per trap", [ax.filter((n) => n.role === "list").length, ax.filter((n) => n.role === "listitem").length], [1, 2]);
  check("accessibility tree: the name button is described by the trap's status", garage && garage.description, "Catch detected");
  check("accessibility tree: a hold reading has its shortcut and description", kill && [kill.props.keyshortcuts, kill.description], ["Shift+Enter", "Shift+Enter or press and hold: Clear kill alert"]);
  check("accessibility tree: no entity ID in any name, and no drawing", [ax.some((n) => /binary_sensor|sensor\./.test(n.name)), ax.some((n) => n.role === "image")], [false, false]);

  // Clicks and keys on the new targets.
  await sr.evaluate(() => c.q(".name-btn").focus());
  await sr.keyboard.press("Enter");
  await sr.keyboard.press(" ");
  await sr.evaluate(() => {
    c.q(".name-btn").click();
    c.q(".tile-head .chip").click();
    c.q(".scene-wrap").click();
  });
  check("more-info: Enter, Space and a click on the name, a click on the chip or the drawing", await sr.evaluate(() => window.moreInfo), Array(5).fill("binary_sensor.g"));
  const ring = await sr.evaluate(async () => {
    const btn = c.q(".name-btn");
    // A real outline, not a box-shadow: forced colours (Windows High Contrast) drop box-shadows.
    const cs = getComputedStyle(btn);
    return { visible: btn.matches(":focus-visible"), ring: cs.outlineStyle === "solid" && cs.outlineWidth === "2px", ellipsis: cs.textOverflow };
  });
  check("focus ring: shown on the name button, which carries the ellipsis", ring, { visible: true, ring: true, ellipsis: "ellipsis" });

  // Announcements.
  const said = await sr.evaluate(async () => {
    const { sleep } = T;
    const out = {};
    const live = () => c.q(".sr-only").textContent;
    const writes = [];
    new MutationObserver(() => writes.push(live())).observe(c.q(".sr-only"), { childList: true, characterData: true, subtree: true });
    const step = async (change) => {
      writes.length = 0;
      c.push(change);
      await sleep(250);
      return writes.slice();
    };
    // Garage's catch is cleared (Armed isn't read out) as Loft catches one.
    out.one = await step({ "binary_sensor.g": "off", "binary_sensor.l": "on" });
    // The same words again: emptied first, so they're still a change screen readers announce.
    await step({ "binary_sensor.l": "off" });
    out.again = await step({ "binary_sensor.l": "on" });
    // Both go offline in one update: one message, in card order.
    out.both = await step({ "binary_sensor.g": "unavailable", "sensor.gb": "unavailable", "binary_sensor.l": "unavailable" });
    // Loft is back with the catch it had: not news. Garage is back with a low battery: a warning shows, unread.
    out.back = await step({ "binary_sensor.l": "on", "binary_sensor.g": "off", "sensor.gb": 5 });
    out.backChips = c.qa(".tile-head .chip").map((x) => x.textContent.trim());
    // Updates in quick succession are read out together.
    writes.length = 0;
    c.push({ "binary_sensor.g": "on" });
    c.push({ "binary_sensor.l": "unavailable" });
    await sleep(250);
    out.quick = writes.slice();
    // A new config starts over: its first paint (Loft offline) isn't news.
    c.setConfig({ traps: [{ name: "Loft", kill: "binary_sensor.l" }] });
    await sleep(250);
    out.rebuilt = [live(), c.q(".tile-head .chip").textContent.trim()];
    return out;
  });
  check("announce: a new catch, and not a cleared one", said.one, ["Loft: Catch detected"]);
  check("announce: the same message twice is emptied, then set again", said.again, ["", "Loft: Catch detected"]);
  check("announce: two traps in one update, one message", said.both, ["", "Garage: Offline. Loft: Offline"]);
  check("announce: back from offline with the same catch, or with a warning, isn't read out", [said.back, said.backChips], [[], ["Low battery", "Catch detected"]]);
  check("announce: updates close together are read out together", said.quick, ["", "Garage: Catch detected. Loft: Offline"]);
  check("announce: a new config's first paint isn't read out", said.rebuilt, ["", "Offline"]);
  errors.push(...sr.errors);
  await sr.close();

  const flows = await open(fixtureUrl);
  const flash = await flows.evaluate(async () => {
    const { st, sleep } = T;
    const out = {};
    const c = T.live({ show_summary: false, traps: [{ name: "T", kill: "binary_sensor.k", actions: [{ entity: "button.go", name: "Go" }, { entity: "button.no", name: "No" }, { entity: "sensor.x", name: "Nothing" }] }] },
      { "binary_sensor.k": st("off"), "button.go": st("unknown"), "button.no": st("unknown"), "sensor.x": st(1) },
      { callService: async (d, s, data, target) => { if (target.entity_id === "button.no") throw { message: "no" }; } });
    const live = () => c.q(".sr-only").textContent;
    out.headless = { wrap: !!c.q(".wrap.headless > .sr-only"), role: c.q(".sr-only").getAttribute("role"), title: !!c.q(".title") };
    c.qa(".act")[0].click();
    await sleep(10);
    out.flashRole = c.q(".flash").getAttribute("role");
    await sleep(250);
    out.ok = live();
    c.qa(".act")[1].click();
    await sleep(250);
    out.failed = { flash: c.q(".flash").textContent, live: live() };
    c.qa(".act")[2].click();
    await sleep(250);
    out.cantRun = live();
    // Taken off the page before it's read out: dropped.
    c.push("binary_sensor.k", "on");
    const host = c.parentNode;
    c.remove();
    await sleep(250);
    out.away = live();
    host.appendChild(c);
    c.remove();
    // A card error is read out once, and coming back from one isn't.
    const broken = () => {
      const s = st("off");
      Object.defineProperty(s, "state", { get() { throw new Error("boom"); } });
      return s;
    };
    const consoleError = console.error;
    console.error = () => {};
    try {
      const e = T.live({ traps: [{ name: "B", kill: "binary_sensor.b" }] }, { "binary_sensor.b": st("off") });
      e.hass = { states: { "binary_sensor.b": broken() } };
      await sleep(250);
      const first = e.q(".sr-only").textContent;
      e.hass = { states: { "binary_sensor.b": broken(), "sensor.other": st(1) } };
      e.hass = { states: { "binary_sensor.b": st("on") } };
      await sleep(250);
      out.error = [first, e.q(".sr-only").textContent, e.q(".tile-head .chip").textContent.trim()];
      e.remove();
    } finally {
      console.error = consoleError;
    }
    // No traps: the region is still there.
    const none = T.live({ traps: [] }, {});
    out.empty = [!!none.q(".empty"), none.q(".sr-only") && none.q(".sr-only").getAttribute("role")];
    none.remove();
    return out;
  });
  check("status region: there without a header", flash.headless, { wrap: true, role: "status", title: false });
  check("flash: not a live region itself", flash.flashRole, null);
  check("flash: a success is read out", flash.ok, "Go: done");
  check("flash: a failure is left to Home Assistant's notification", flash.failed, { flash: "No failed: no", live: "Go: done" });
  check("flash: nothing to run is read out (Home Assistant has nothing to say)", flash.cantRun, "Can't run Nothing: give it an action: (for example button.press).");
  check("announce: a card taken off the page drops what it hadn't said", flash.away, "");
  check("announce: a card error once, and not the recovery", flash.error, ["B: Card error", "B: Card error", "Catch detected"]);
  check("status region: there with no traps", flash.empty, [true, "status"]);
  errors.push(...flows.errors);
  await flows.close();

  // --- Demo: the tip names the keyboard shortcut, and the trap names are headings.
  const demo = await open(demoUrl, { viewport: { width: 1280, height: 900 } });
  await demo.waitForTimeout(400);
  const demoInfo = await demo.evaluate(() => {
    const card = document.querySelector("rodent-trap-card");
    return {
      tip: /Shift\+Enter/.test(document.querySelector(".tip").textContent) && /Escape/.test(document.querySelector(".tip").textContent),
      headings: [...card.shadowRoot.querySelectorAll('.tile .name[role="heading"] .name-btn')].map((b) => b.textContent),
    };
  });
  check("demo: the tip mentions Shift+Enter and Escape", demoInfo.tip, true);
  check("demo: every trap name is a heading", demoInfo.headings, ["Garage", "Basement", "Mousetrap 1", "Mousetrap 2", "Pantry", "Loft", "Kitchen", "Shed"]);
  errors.push(...demo.errors);
  await demo.close();

  return { lines, errors };
}

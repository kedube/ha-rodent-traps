// Repainting and catch effects, the card's life on and off the page, running actions and the confirmation bar.
import { demoUrl, fixtureUrl, openPage } from "./lib.mjs";

/** In-page helpers, added to every page this suite opens. */
function helpers() {
  const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
  window.T = {
    iso,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    st: (state, attributes = {}, changed = iso()) => ({ state: String(state), attributes, last_changed: changed, last_updated: iso() }),
    mount(config, hass, parent = document.body) {
      const c = document.createElement("rodent-trap-card");
      parent.appendChild(c);
      c.setConfig(config);
      c.hass = hass;
      return c;
    },
    /**
     * A card with its own state table. push(id, state) changes one entity (undefined removes it), push({ id: state })
     * several at once, and either hands the card a new hass.
     */
    live(config, states, extra = {}, parent) {
      const S = { ...states };
      const hass = () => ({ states: { ...S }, ...extra });
      const c = T.mount(config, hass(), parent);
      const put = (id, state, attrs) => {
        if (state === undefined) delete S[id];
        else S[id] = T.st(state, attrs || (S[id] ? S[id].attributes : {}), S[id] && S[id].state === String(state) ? S[id].last_changed : iso());
      };
      c.push = (id, state, attrs) => {
        if (typeof id === "object") for (const [k, v] of Object.entries(id)) put(k, v);
        else put(id, state, attrs);
        c.hass = hass();
      };
      c.q = (s) => c.shadowRoot.querySelector(s);
      c.qa = (s) => [...c.shadowRoot.querySelectorAll(s)];
      return c;
    },
    anim: (el, name) => (el ? el.getAnimations({ subtree: true }).find((a) => a.animationName === name) : undefined),
    hold: (el, opts = {}) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "touch", ...opts })),
    release: () => window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" })),
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
  const open = async (url, options = {}) => {
    const page = await openPage(browser, null, { viewport: { width: 900, height: 1400 }, ...options });
    await page.addInitScript(helpers);
    await page.goto(url);
    return page;
  };

  const page = await open(fixtureUrl);

  // --- Repaints: a Z-Wave trap reports a catch as separate updates 300 ms apart. Each used to redraw the whole
  // tile, which cut SNAP!, +1 and the count-up short and restarted the mouse on every check-in.
  const zwave = await page.evaluate(async () => {
    const { sleep, st, iso, anim } = T;
    const c = T.live(
      { traps: [{ name: "T", kill: "binary_sensor.t_kill", strikes: "sensor.t_strikes", last_strike: "event.t_strike", last_seen: "sensor.t_seen",
        battery: "sensor.t_battery", bait: "input_number.t_bait", holds: { bait: "button.t_refill" } }] },
      {
        "binary_sensor.t_kill": st("off"), "sensor.t_strikes": st(7), "event.t_strike": st(iso(3 * 864e5)),
        "sensor.t_seen": st(iso(600000), { device_class: "timestamp" }), "sensor.t_battery": st(80, { unit_of_measurement: "%" }),
        "input_number.t_bait": st(60, { min: 0, max: 100 }), "button.t_refill": st("unknown", { friendly_name: "Refill" }),
      },
      { callService: async () => {} }
    );
    const out = {};
    const scene = c.q("svg.scene");
    const battery = c.q(".m-battery");
    await sleep(250);
    const peek = anim(c.q(".mouse"), "peek");
    c.push("sensor.t_seen", iso());
    out.checkIn = {
      scene: c.q("svg.scene") === scene, battery: c.q(".m-battery") === battery,
      mouseKeepsGoing: anim(c.q(".mouse"), "peek") === peek && peek.currentTime >= 200, lastSeen: c.q(".m-last_seen .m-value").textContent,
    };

    c.push("binary_sensor.t_kill", "on");
    const svg = c.q("svg.scene");
    const word = c.q(".snap-text");
    const pop = anim(word, "pop");
    await sleep(300);
    c.push("sensor.t_strikes", 8);
    const strikes = c.q(".m-strikes");
    const plus = c.q(".plus");
    await sleep(300);
    c.push("event.t_strike", iso());
    await sleep(300);
    c.push("sensor.t_seen", iso());
    await sleep(30);
    out.midway = {
      scene: c.q("svg.scene") === svg, snap: svg.classList.contains("snap-now"), word: c.q(".snap-text") === word,
      popNotRestarted: anim(c.q(".snap-text"), "pop") === pop && pop.currentTime > 800,
      strikes: c.q(".m-strikes") === strikes, plus: c.q(".plus") === plus, plusText: plus.textContent,
      lastStrikeBumps: c.q(".m-last_strike").classList.contains("bump"),
    };
    await sleep(1700);
    out.after = {
      count: c.q(".count").textContent, snap: svg.classList.contains("snap-now"), word: !!c.q(".snap-text"), plus: !!c.q(".plus"),
      bumps: c.qa(".metric.bump").length, scene: c.q("svg.scene") === svg,
    };
    // Past the window, a repaint draws the plain scene: nothing plays again.
    c.push("sensor.t_battery", 70);
    out.later = { scene: c.q("svg.scene") === svg, snap: c.q("svg.scene").classList.contains("snap-now"), word: !!c.q(".snap-text") };
    c.remove();
    return out;
  });
  check("repaint: a check-in keeps the scene, its mouse and the other readings", zwave.checkIn, { scene: true, battery: true, mouseKeepsGoing: true, lastSeen: "just now" });
  check("repaint: Z-Wave pushes 300 ms apart don't cut SNAP!, +1 or the bump short", zwave.midway,
    { scene: true, snap: true, word: true, popNotRestarted: true, strikes: true, plus: true, plusText: "+1", lastStrikeBumps: true });
  check("repaint: the effects finish and clean up", zwave.after, { count: "8", snap: false, word: false, plus: false, bumps: 0, scene: true });
  check("repaint: after the effects, a repaint doesn't play them again", zwave.later, { scene: true, snap: false, word: false });

  // In-place updates: a new level keeps the elements, so the bait and battery transitions run and the mouse goes on.
  const inPlace = await page.evaluate(async () => {
    const { sleep, st, anim } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", battery: "sensor.b", bait: "input_number.bait" }] },
      { "binary_sensor.k": st("off"), "sensor.b": st(80, { unit_of_measurement: "%" }), "input_number.bait": st(80, { min: 0, max: 100 }) });
    await sleep(100);
    const scene = c.q("svg.scene");
    const cheese = c.q(".cheese");
    const charge = c.q(".ic-batt .charge");
    const battery = c.q(".m-battery");
    const peek = anim(c.q(".mouse"), "peek");
    c.push("input_number.bait", 30);
    c.push("sensor.b", 15);
    await sleep(50);
    const transitions = (el) => el.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.transitionProperty);
    const out = {
      scene: c.q("svg.scene") === scene, cheese: c.q(".cheese") === cheese, cheeseMoves: transitions(cheese),
      battery: c.q(".m-battery") === battery, charge: c.q(".ic-batt .charge") === charge, chargeMoves: transitions(charge),
      text: c.q(".m-battery .m-value").textContent, low: battery.classList.contains("is-warn"), mouse: anim(c.q(".mouse"), "peek") === peek,
    };
    c.remove();
    return out;
  });
  check("in place: the cheese and battery charge animate to the new level", inPlace,
    { scene: true, cheese: true, cheeseMoves: ["transform"], battery: true, charge: true, chargeMoves: ["width"], text: "15%", low: true, mouse: true });

  // Readings are patched one by one; a different set of readings rebuilds the list.
  const list = await page.evaluate(async () => {
    const { st } = T;
    const reg = (ids) => Object.fromEntries(ids.map((id) => [id, { entity_id: id, device_id: "d" }]));
    const states = { "binary_sensor.d_kill_alert": st("off"), "sensor.d_battery": st(50, { unit_of_measurement: "%", device_class: "battery" }) };
    const devices = { d: { id: "d", name: "Trap" } };
    const c = T.mount({ traps: [{ device: "d" }] }, { states, devices, entities: reg(["binary_sensor.d_kill_alert"]) });
    const before = c.shadowRoot.querySelectorAll(".metric").length;
    c.hass = { states, devices, entities: reg(["binary_sensor.d_kill_alert", "sensor.d_battery"]) };
    const after = [...c.shadowRoot.querySelectorAll(".metric")].map((m) => m.querySelector(".m-value").textContent);
    c.remove();
    return { before, after };
  });
  check("readings: a new reading rebuilds the list", list, { before: 1, after: ["50%", "Clear"] });

  // A hold survives repaints: the fill stays on the reading, and carries over when the reading is redrawn.
  const hold = await page.evaluate(async () => {
    const { sleep, st, anim } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", battery: "sensor.b", bait: "input_number.bait", holds: { bait: "button.refill" } }] },
      { "binary_sensor.k": st("off"), "sensor.b": st(80, { unit_of_measurement: "%" }), "input_number.bait": st(60, { min: 0, max: 100 }),
        "button.refill": st("unknown", { friendly_name: "Refill" }) });
    const out = {};
    const bait = c.q(".m-bait");
    T.hold(bait);
    const started = performance.now();
    await sleep(120);
    c.push("sensor.b", 79);
    out.otherReading = { same: c.q(".m-bait") === bait, holding: bait.classList.contains("holding") };
    await sleep(80);
    const fill = anim(bait, "hold-fill");
    c.push("input_number.bait", 50);
    out.ownReading = { same: c.q(".m-bait") === bait, holding: bait.classList.contains("holding"), fillKeepsGoing: anim(bait, "hold-fill") === fill };
    await sleep(80);
    // The reading is redrawn from scratch (its entity went away): the new one starts its fill where the old one was.
    c.push("input_number.bait", undefined);
    const next = c.q(".m-bait");
    const moved = anim(next, "hold-fill");
    const progress = moved ? moved.effect.getComputedTiming().progress : null;
    out.redrawn = {
      replaced: next !== bait, holding: next.classList.contains("holding"),
      startsPartWay: progress > 0.3 && Math.abs(progress - (performance.now() - started) / 550) < 0.1,
    };
    await sleep(Math.max(0, 650 - (performance.now() - started)));
    out.asked = c.q(".confirm > span") && c.q(".confirm > span").textContent;
    T.release();
    out.cleared = { holding: c.qa(".holding").length, delay: c.q(".m-bait").style.getPropertyValue("--hold-delay") };
    c.remove();
    return out;
  });
  check("hold: another reading's update leaves the fill alone", hold.otherReading, { same: true, holding: true });
  check("hold: the held reading's own update keeps its fill running", hold.ownReading, { same: true, holding: true, fillKeepsGoing: true });
  check("hold: a redrawn reading picks the fill up part-way", hold.redrawn, { replaced: true, holding: true, startsPartWay: true });
  check("hold: it still asks when the time is up, then tidies up", [hold.asked, hold.cleared], ["Refill?", { holding: 0, delay: "" }]);

  // Painting is synchronous and leaves focused elements in place.
  const focus = await page.evaluate(async () => {
    const { st } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", strikes: "sensor.s", battery: "sensor.b" }] },
      { "binary_sensor.k": st("off"), "sensor.s": st(3), "sensor.b": st(80, { unit_of_measurement: "%" }) });
    const battery = c.q(".m-battery");
    battery.focus();
    c.push("sensor.s", 4);
    const a = c.shadowRoot.activeElement === battery;
    c.push("sensor.b", 60);
    const b = c.shadowRoot.activeElement === battery && battery.textContent.includes("60%");
    c.remove();
    return [a, b];
  });
  check("focus: stays on a reading through updates to it and to others", focus, [true, true]);

  // The online entity's change time only matters for the Offline banner, so a signal-strength change isn't a repaint.
  const online = await page.evaluate(() => {
    const { st } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", online: "sensor.rssi" }] }, { "binary_sensor.k": st("off"), "sensor.rssi": st(-71, { unit_of_measurement: "dBm" }) });
    const sig = c._tiles[0].sig;
    c.push("sensor.rssi", -70);
    const out = { since: c._tiles[0].model.since.online, repainted: c._tiles[0].sig !== sig };
    c.push("sensor.rssi", "unavailable");
    out.banner = c.q(".banner .b-title").textContent.replace(/\s+/g, " ").trim();
    c.remove();
    return out;
  });
  check("online: a signal change while online isn't a change to the tile", { since: online.since, repainted: online.repainted }, { since: null, repainted: false });
  check("online: the Offline banner still says since when", online.banner, "Not reporting · just now");

  // --- Old catch effects don't replay or linger.
  const cleanup = await page.evaluate(async () => {
    const { st, iso } = T;
    const c = T.live({ traps: [{ name: "T", strikes: "sensor.s", last_strike: "event.e" }] }, { "sensor.s": st(7), "event.e": st(iso(864e5)) });
    c.push("sensor.s", 8);
    c.push("event.e", iso());
    const end = (el, animationName) => el.dispatchEvent(new AnimationEvent("animationend", { animationName, bubbles: true }));
    const bumped = () => c.qa(".metric.bump").map((m) => m.className.match(/m-(\w+)/)[1]);
    const out = { start: bumped() };
    end(c.q(".m-last_strike"), "bump");
    out.clockStillSpinning = bumped();
    end(c.q(".m-last_strike .ic-clock path"), "spin");
    end(c.q(".m-strikes"), "bump");
    out.bumpsDone = bumped();
    end(c.q(".plus"), "float-up");
    out.plus = !!c.q(".plus");
    c.remove();
    return out;
  });
  check("cleanup: a finished bump, spin and +1 are removed", cleanup,
    { start: ["strikes", "last_strike"], clockStillSpinning: ["strikes", "last_strike"], bumpsDone: [], plus: false });

  const reattach = await page.evaluate(async () => {
    const { st, sleep, anim } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", strikes: "sensor.s" }] }, { "binary_sensor.k": st("off"), "sensor.s": st(7) });
    c.push("binary_sensor.k", "on");
    c.push("sensor.s", 8);
    await sleep(100);
    // A view switch part-way through the catch: nothing is left to play again when the card comes back.
    const host = c.parentNode;
    c.remove();
    const away = { snap: !!c.q(".snap-now"), word: !!c.q(".snap-text"), plus: !!c.q(".plus"), bumps: c.qa(".bump").length };
    await sleep(60);
    host.appendChild(c);
    await sleep(30);
    const svg = c.q("svg.scene");
    const out = { away, count: c.q(".count").textContent, back: { snap: svg.classList.contains("snap-now"), shake: !!anim(svg, "shake"), bar: !!anim(svg, "snap-kill") } };
    c.remove();
    return out;
  });
  check("re-attach: a catch in progress is finished off, not replayed", reattach,
    { away: { snap: false, word: false, plus: false, bumps: 0 }, count: "8", back: { snap: false, shake: false, bar: false } });

  // A trap coming back from an outage with the catch it already had doesn't snap; a catch during the outage does.
  const live = await page.evaluate(() => {
    const { st } = T;
    const run = (first, ...steps) => {
      const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", rearm: "binary_sensor.r", battery: "sensor.b" }] },
        { "binary_sensor.k": st(first[0]), "binary_sensor.r": st(first[1]), "sensor.b": st(80, { unit_of_measurement: "%" }) });
      for (const [k, r, b] of steps) c.push({ "binary_sensor.k": k, "binary_sensor.r": r, "sensor.b": b });
      const snap = c.q("svg.scene").classList.contains("snap-now");
      c.remove();
      return snap;
    };
    const gone = ["unavailable", "unavailable", "unavailable"];
    return {
      reload: run(["on", "on"], gone, ["on", "on", 80]),
      catchWhileOffline: run(["off", "off"], gone, ["on", "on", 80]),
      sprungThenOfflineThenCatch: run(["off", "on"], gone, ["on", "on", 80]),
      catchAfterRestart: run(["off", "off"], ["unknown", "unknown", 80], ["on", "on", 80]),
      oldCatchAfterRestart: run(["on", "on"], ["unknown", "unknown", 80], ["on", "on", 80]),
      liveCatch: run(["off", "off"], ["on", "on", 80]),
      liveSprung: run(["off", "off"], ["off", "on", 80]),
    };
  });
  check("snap: only a change from a scene without a catch plays it", live, {
    reload: false, catchWhileOffline: true, sprungThenOfflineThenCatch: false, catchAfterRestart: true, oldCatchAfterRestart: false, liveCatch: true, liveSprung: true,
  });

  // The window is bounded and follows the scene. Animations off: nothing ever removes the markup, so only the window does.
  const window_ = await page.evaluate(async () => {
    const { st, sleep } = T;
    const c = T.live({ animations: false, traps: [{ name: "T", rearm: "binary_sensor.r", bait: "input_number.b" }] },
      { "binary_sensor.r": st("off"), "input_number.b": st(80, { min: 0, max: 100 }) });
    c.push("binary_sensor.r", "on");
    const svg = c.q("svg.scene");
    c.push("input_number.b", 60);
    const inside = { same: c.q("svg.scene") === svg, snap: svg.classList.contains("snap-now") };
    await sleep(2500);
    c.push("input_number.b", 40);
    const after = { snap: c.q("svg.scene").classList.contains("snap-now"), word: !!c.q(".snap-text") };
    c.push("binary_sensor.r", "off");
    c.push("binary_sensor.r", "on");
    const again = c.q("svg.scene").classList.contains("snap-now");
    c.push("binary_sensor.r", "off");
    const armed = c.q("svg.scene").classList.contains("snap-now");
    c.remove();
    return { inside, after, again, armed };
  });
  check("snap window: inside it, an update keeps SNAP! in place", window_.inside, { same: true, snap: true });
  check("snap window: after it, an update draws the plain scene", window_.after, { snap: false, word: false });
  check("snap window: a new catch snaps again; a scene without one doesn't", [window_.again, window_.armed], [true, false]);

  // A status re-sort moves a tile without restarting its animations, where the browser can (moveBefore).
  const resort = await page.evaluate(async () => {
    const { st, sleep, anim } = T;
    const c = T.live({ sort: "status", traps: [{ name: "A", kill: "binary_sensor.a" }, { name: "B", kill: "binary_sensor.b", battery: "sensor.bb" }] },
      { "binary_sensor.a": st("off"), "binary_sensor.b": st("off"), "sensor.bb": st(80, { unit_of_measurement: "%" }) });
    await sleep(200);
    const b = c.qa(".tile")[1];
    const peek = anim(b.querySelector(".mouse"), "peek");
    c.push("sensor.bb", 5);
    const out = { order: c.qa(".tile .name").map((n) => n.textContent), keeps: anim(b.querySelector(".mouse"), "peek") === peek, moveBefore: typeof Element.prototype.moveBefore === "function" };
    c.remove();
    return out;
  });
  check("re-sort: B moves first", resort.order, ["B", "A"]);
  check("re-sort: the moved tile's mouse keeps going (moveBefore)", resort.keeps, resort.moveBefore);

  // With animations off, the red +1 isn't left on screen.
  const still = await page.evaluate(async () => {
    const { st } = T;
    const c = T.live({ animations: false, traps: [{ name: "T", strikes: "sensor.s" }] }, { "sensor.s": st(7) });
    c.push("sensor.s", 8);
    const out = { opacity: getComputedStyle(c.q(".plus")).opacity, count: c.q(".count").textContent };
    c.remove();
    return out;
  });
  check("animations off: no +1 and no count-up", still, { opacity: "0", count: "8" });

  // --- Coming back to the page.
  const back = await page.evaluate(async () => {
    const { st, iso, sleep } = T;
    const realNow = Date.now;
    const out = {};
    const c = T.live({ stale_after: "12h", traps: [{ name: "T", kill: "binary_sensor.k", last_seen: "sensor.seen" }] },
      { "binary_sensor.k": st("off"), "sensor.seen": st(iso(12 * 3600e3 - 60e3), { device_class: "timestamp" }) });
    const chip = () => c.q(".tile-head .chip").textContent.trim();
    out.before = chip();
    const host = c.parentNode;
    try {
      c.remove();
      Date.now = () => realNow() + 5 * 60e3;
      host.appendChild(c);
      out.reattached = chip();
      Date.now = realNow;
      c.hass = { ...c.hass };
      c._update(true);
      out.reset = chip();
      Date.now = () => realNow() + 5 * 60e3;
      document.dispatchEvent(new Event("visibilitychange"));
      out.visible = chip();
    } finally {
      Date.now = realNow;
    }
    // Off the page, the card doesn't listen for the tab coming back.
    let ticks = 0;
    c._tick = () => ticks++;
    document.dispatchEvent(new Event("visibilitychange"));
    c.remove();
    document.dispatchEvent(new Event("visibilitychange"));
    out.ticks = ticks;
    await sleep(0);
    return out;
  });
  check("re-attach: staleness is brought up to date straight away", [back.before, back.reattached], ["Armed", "Not seen recently"]);
  check("visible again: so is a tab coming back", [back.reset, back.visible], ["Armed", "Not seen recently"]);
  check("visibility listener removed with the card", back.ticks, 1);

  const away = await page.evaluate(async () => {
    const { st, sleep } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", holds: { kill: "button.clear" }, actions: [{ entity: "button.go", name: "Go" }] }] },
      { "binary_sensor.k": st("off"), "button.clear": st("unknown", { friendly_name: "Clear" }), "button.go": st("unknown") }, { callService: async () => {} });
    const host = c.parentNode;
    c.q(".m-kill").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    const out = { opened: !!c.q(".confirm") };
    c.remove();
    out.prompt = { away: !!c.q(".confirm"), pending: c._tiles[0].ui.pending };
    host.appendChild(c);
    out.prompt.back = !!c.q(".confirm");
    c.q(".act").click();
    await sleep(10);
    out.flashed = !!c.q(".flash");
    c.remove();
    out.flash = { away: !!c.q(".flash"), ui: c._tiles[0].ui.flash };
    host.appendChild(c);
    c.remove();
    return out;
  });
  check("detach: an open prompt and a flash are cleared, not kept for later", away,
    { opened: true, prompt: { away: false, pending: null, back: false }, flashed: true, flash: { away: false, ui: null } });

  const rebuilt = await page.evaluate(async () => {
    const { st, sleep } = T;
    const trap = (name, k) => ({ name, kill: k, holds: { kill: "button.clear" }, actions: [{ entity: "button.go", name: "Go" }] });
    const config = { traps: [trap("A", "binary_sensor.a"), trap("B", "binary_sensor.b")] };
    let finish = null;
    const calls = [];
    const c = T.live(config, { "binary_sensor.a": st("off"), "binary_sensor.b": st("off"), "button.clear": st("unknown"), "button.go": st("unknown") },
      { callService: (...a) => { calls.push(a); return new Promise((r) => (finish = r)); } });
    const out = {};
    // A new config while a reading is held: the hold ends with it, and doesn't ask on another trap.
    T.hold(c.qa(".tile")[0].querySelector(".m-kill"));
    await sleep(150);
    c.setConfig({ traps: config.traps.slice().reverse() });
    await sleep(550);
    T.release();
    out.hold = { prompts: c.qa(".confirm").length, holding: c.qa(".holding").length };
    // A new config while a button's call runs: its result isn't shown on whichever tile is there now.
    c.qa(".act")[0].click();
    out.busy = c.qa(".act")[0].getAttribute("aria-disabled") === "true";
    c.setConfig({ ...config, title: "New" });
    finish();
    await sleep(10);
    out.after = { flash: c.qa(".flash").length, enabled: !c.qa(".act")[0].hasAttribute("aria-disabled") };
    let threw = null;
    try {
      c._setUi(9, { pending: null });
      c._flash(9, "ok", "x", "act:0");
    } catch (e) {
      threw = e.message;
    }
    out.threw = threw;
    c.remove();
    return out;
  });
  check("new config: a hold in progress is dropped", rebuilt.hold, { prompts: 0, holding: 0 });
  check("new config: an old call's result isn't flashed on the new tiles", [rebuilt.busy, rebuilt.after], [true, { flash: 0, enabled: true }]);
  check("new config: a tile that's gone is ignored", rebuilt.threw, null);

  // --- Running actions: error text, one toast (Home Assistant's), a busy state and haptics.
  const failures = await page.evaluate(async () => {
    const { st, sleep } = T;
    const toasts = [];
    const onToast = (e) => toasts.push(e.detail.message);
    window.addEventListener("hass-notification", onToast);
    const texts = [];
    const reasons = [3, { type: "result", success: false, error: { code: 3, message: "Connection lost" } }, { code: "not_found", message: "Service not found." }, "Nope", {}, null, { message: { nested: 1 } }];
    for (const reason of reasons) {
      const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", actions: [{ entity: "button.go", name: "Go" }] }] },
        { "binary_sensor.k": st("off"), "button.go": st("unknown") }, { callService: async () => { throw reason; } });
      c.q(".act").click();
      await sleep(10);
      texts.push(c.q(".flash") ? c.q(".flash").textContent : null);
      c.remove();
    }
    window.removeEventListener("hass-notification", onToast);
    return { texts, toasts };
  });
  check("failure: the tile says why in words", failures.texts, [
    "Go failed: connection lost", "Go failed: Connection lost", "Go failed: Service not found.", "Go failed: Nope",
    "Go failed: unknown error", "Go failed: unknown error", "Go failed: unknown error",
  ]);
  check("failure: no second toast from the card", failures.toasts, []);

  const busy = await page.evaluate(async () => {
    const { st, sleep } = T;
    const calls = [];
    const pending = {};
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", holds: { kill: { entity: "button.clear", confirm: false } },
      actions: [{ entity: "button.a", name: "A" }, { entity: "button.b", name: "B" }] }] },
      { "binary_sensor.k": st("off"), "button.clear": st("unknown"), "button.a": st("unknown"), "button.b": st("unknown") },
      { callService: (d, s, data, target) => { calls.push(target.entity_id); return new Promise((r) => (pending[target.entity_id] = r)); } });
    const rightClick = () => {
      const el = c.q(".m-kill");
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 2, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    };
    const out = {};
    rightClick();
    out.holdBusy = { cls: c.q(".m-kill").classList.contains("busy"), aria: c.q(".m-kill").getAttribute("aria-busy") };
    rightClick();
    T.hold(c.q(".m-kill"));
    out.noFillWhileBusy = c.qa(".holding").length;
    T.release();
    out.holdCalls = calls.length;
    pending["button.clear"]();
    await sleep(10);
    out.holdDone = { busy: c.q(".m-kill").classList.contains("busy"), aria: c.q(".m-kill").getAttribute("aria-busy"), flash: c.q(".flash").textContent };
    const disabled = () => c.qa(".act").map((b) => b.getAttribute("aria-disabled") === "true");
    c.qa(".act")[0].click();
    c.qa(".act")[1].click();
    out.both = disabled();
    c._request(0, "act", "0");
    out.calls = calls.slice();
    pending["button.a"]();
    await sleep(10);
    out.afterA = disabled();
    pending["button.b"]();
    await sleep(10);
    out.afterB = disabled();
    c.remove();
    return out;
  });
  check("busy: a running hold is marked on its reading", busy.holdBusy, { cls: true, aria: "true" });
  check("busy: it can't be held again until it's done", [busy.noFillWhileBusy, busy.holdCalls], [0, 1]);
  check("busy: done clears it", busy.holdDone, { busy: false, aria: null, flash: "Clear: done" });
  check("busy: a second button doesn't re-enable the first", busy.both, [true, true]);
  check("busy: a running button isn't sent again", busy.calls, ["button.clear", "button.a", "button.b"]);
  check("busy: each button is released by its own call", [busy.afterA, busy.afterB], [[false, true], [false, false]]);

  const haptics = await page.evaluate(async () => {
    const { st, sleep } = T;
    const got = [];
    const onHaptic = (e) => got.push(e.detail);
    window.addEventListener("haptic", onHaptic);
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", holds: { kill: "button.clear" },
      actions: [{ entity: "sensor.x", name: "Nothing" }, { entity: "button.fail", name: "Fail" }] }] },
      { "binary_sensor.k": st("off"), "button.clear": st("unknown"), "sensor.x": st(1), "button.fail": st("unknown") },
      { callService: async (d, s, data, target) => { if (target.entity_id === "button.fail") throw { message: "no" }; } });
    c.q(".m-kill").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    const onPrompt = got.slice();
    c.q('[data-confirm="yes"]').click();
    await sleep(10);
    const onRun = got.slice();
    c.qa(".act")[0].click();
    await sleep(10);
    const onCantRun = got.slice();
    c.qa(".act")[1].click();
    await sleep(10);
    window.removeEventListener("haptic", onHaptic);
    c.remove();
    return { onPrompt, onRun, onCantRun, onFail: got };
  });
  check("haptics: warning when a prompt opens", haptics.onPrompt, ["warning"]);
  check("haptics: light when a call starts", haptics.onRun, ["warning", "light"]);
  check("haptics: failure when there's nothing to run", haptics.onCantRun, ["warning", "light", "failure"]);
  check("haptics: a failed call leaves the failure buzz to Home Assistant", haptics.onFail, ["warning", "light", "failure", "light"]);

  // --- The prompt and the result sit under the buttons, and don't move them.
  const layout = await page.evaluate(async () => {
    const { st, sleep } = T;
    const host = document.createElement("div");
    host.style.width = "340px";
    document.body.appendChild(host);
    const calls = [];
    const c = T.live({ show_scene: false, traps: [{ name: "T", kill: "binary_sensor.k", holds: { kill: "button.clear" },
      actions: [{ entity: "button.a", name: "Empty the trap", confirm: "Mark the trap as emptied and re-armed?" }, { entity: "button.b", name: "Ping" }] }] },
      { "binary_sensor.k": st("off"), "button.clear": st("unknown"), "button.a": st("unknown"), "button.b": st("unknown") },
      { callService: async (d, s, data, target) => { calls.push(target.entity_id); } }, host);
    const tops = () => c.qa(".act").map((b) => Math.round(b.getBoundingClientRect().top));
    const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const out = { before: tops() };
    c.qa(".act")[0].click();
    out.prompt = tops();
    out.promptBelow = after(c.q(".actions"), c.q(".confirm"));
    const [no, yes] = [c.q(".c-no"), c.q(".c-yes")].map((b) => b.getBoundingClientRect());
    out.oneRow = Math.round(no.top) === Math.round(yes.top);
    out.tall = [no.height, yes.height, c.q(".act").getBoundingClientRect().height].every((h) => h >= 36);
    c.q(".c-yes").click();
    await sleep(10);
    out.flash = tops();
    out.flashBelow = after(c.q(".actions"), c.q(".flash"));
    c.q(".m-kill").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    out.holdPromptBelow = after(c.q(".metrics"), c.q(".confirm"));
    c.q(".c-no").click();
    // A double-click on a button runs it once, even when the call is over before the second click.
    const click = (detail) => {
      const ping = c.qa(".act")[1];
      ping.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "mouse" }));
      ping.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail }));
    };
    calls.length = 0;
    click(1);
    await sleep(10);
    click(2);
    await sleep(10);
    out.doubleClick = calls.slice();
    click(1);
    await sleep(10);
    out.nextClick = calls.length;
    host.remove();
    return out;
  });
  check("prompt: the buttons don't move when it opens", layout.prompt, layout.before);
  check("prompt: it comes after the buttons, and after the readings for a hold", [layout.promptBelow, layout.holdPromptBelow], [true, true]);
  check("prompt: Cancel and the confirm button share a row on a narrow tile", layout.oneRow, true);
  check("prompt: buttons are at least 36 px tall", layout.tall, true);
  check("result: the buttons don't move when it shows", [layout.flash, layout.flashBelow], [layout.before, true]);
  check("double-click: a button runs once", [layout.doubleClick, layout.nextClick], [["button.b"], 2]);

  errors.push(...page.errors);
  await page.close();

  // --- Keyboard: a held key doesn't answer the prompt it opened.
  const kb = await open(fixtureUrl);
  await kb.evaluate(() => {
    const { st } = T;
    window.calls = [];
    window.c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", holds: { kill: "button.clear" }, actions: [{ entity: "button.go", name: "Go", confirm: true }] }] },
      { "binary_sensor.k": st("off"), "button.clear": st("unknown", { friendly_name: "Clear" }), "button.go": st("unknown") },
      { callService: async (d, s, data, target) => { window.calls.push(target.entity_id); } });
    c.q(".m-kill").focus();
  });
  const kbState = () => kb.evaluate(() => ({ prompt: c.q(".confirm > span") && c.q(".confirm > span").textContent, calls: window.calls.slice(), focus: c.shadowRoot.activeElement && (c.shadowRoot.activeElement.dataset.confirm || c.shadowRoot.activeElement.className) }));
  await kb.keyboard.down("Shift");
  await kb.keyboard.down("Enter");
  await kb.keyboard.down("Enter");
  await kb.keyboard.down("Enter");
  await kb.keyboard.up("Enter");
  await kb.keyboard.up("Shift");
  await kb.waitForTimeout(30);
  check("keyboard: holding Shift+Enter on a reading opens the prompt, and doesn't answer it", await kbState(), { prompt: "Clear?", calls: [], focus: "yes" });
  await kb.keyboard.press("Enter");
  await kb.waitForTimeout(30);
  check("keyboard: a fresh Enter on the prompt still confirms", (await kbState()).calls, ["button.clear"]);
  await kb.evaluate(() => c.q(".act").focus());
  await kb.keyboard.down("Enter");
  await kb.keyboard.down("Enter");
  await kb.keyboard.up("Enter");
  await kb.waitForTimeout(30);
  check("keyboard: holding Enter on a button with confirm doesn't answer its prompt", await kbState(), { prompt: "Go?", calls: ["button.clear"], focus: "yes" });
  errors.push(...kb.errors);
  await kb.close();

  // --- Touch screens get bigger buttons.
  const touch = await open(fixtureUrl, { hasTouch: true });
  const touchHeight = await touch.evaluate(() => {
    const { st } = T;
    const c = T.live({ traps: [{ name: "T", kill: "binary_sensor.k", actions: [{ entity: "button.go", name: "Go", confirm: true }] }] },
      { "binary_sensor.k": st("off"), "button.go": st("unknown") }, { callService: async () => {} });
    c.q(".act").click();
    const out = [c.q(".act"), c.q(".c-no"), c.q(".c-yes")].map((b) => Math.round(b.getBoundingClientRect().height));
    c.remove();
    return out;
  });
  check("touch: buttons are 40 px tall", touchHeight, [40, 40, 40]);
  errors.push(...touch.errors);
  await touch.close();

  // --- Demo: a Z-Wave style strike, four updates 300 ms apart, plays SNAP! and +1 through to the end.
  const demo = await open(demoUrl, { viewport: { width: 1280, height: 900 } });
  await demo.waitForTimeout(500);
  const strike = await demo.evaluate(async () => {
    const card = document.querySelector("rodent-trap-card");
    const tile = () => [...card.shadowRoot.querySelectorAll(".tile")].find((t) => t.querySelector(".name").textContent.trim() === "Mousetrap 1");
    [...document.querySelectorAll('.trap-ctl[data-trap="Mousetrap 1"] button')].find((b) => b.textContent === "Strike (Z-Wave style)").click();
    const svg = tile().querySelector("svg.scene");
    const snapped = svg.classList.contains("snap-now");
    await T.sleep(1000);
    return {
      snapped, same: tile().querySelector("svg.scene") === svg, still: svg.classList.contains("snap-now"),
      chip: tile().querySelector(".tile-head .chip").textContent.trim(), plus: !!tile().querySelector(".plus"),
      strikes: tile().querySelector(".m-strikes .count").textContent, lastStrike: tile().querySelector(".m-last_strike .m-value").textContent,
    };
  });
  check("demo: Strike (Z-Wave style) plays through all four updates", strike,
    { snapped: true, same: true, still: true, chip: "Catch detected", plus: true, strikes: "8", lastStrike: "just now" });
  errors.push(...demo.errors);
  await demo.close();

  // --- Reduced motion: no +1 and no count-up, as the README promises.
  const reduced = await open(fixtureUrl, { reducedMotion: "reduce" });
  const calm = await reduced.evaluate(async () => {
    const { st, sleep } = T;
    const c = T.live({ traps: [{ name: "T", strikes: "sensor.s" }] }, { "sensor.s": st(7) });
    c.push("sensor.s", 8);
    const seen = [c.q(".count").textContent];
    await sleep(120);
    seen.push(c.q(".count").textContent);
    const out = { seen, plus: getComputedStyle(c.q(".plus")).opacity };
    c.remove();
    return out;
  });
  check("reduced motion: the count shows the new total at once, and no +1", calm, { seen: ["8", "8"], plus: "0" });
  errors.push(...reduced.errors);
  await reduced.close();

  return { lines, errors };
}

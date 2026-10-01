// Layout and styles: tile widths and `columns`, card size, the sections view, narrow tiles, the offline greying,
// animation cost, card-mod and the cascade layer, and theme hooks.
import { demoUrl, fixtureUrl, openPage } from "./lib.mjs";

/** In-page helpers, added to every page this suite opens. */
function helpers() {
  const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
  const st = (state, attributes = {}) => ({ state: String(state), attributes, last_changed: iso(), last_updated: iso() });
  window.T = {
    iso,
    st,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    frame: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    /** A block of the given width (and height, if any) to put a card in. */
    box(width, height) {
      const b = document.createElement("div");
      b.style.cssText = `width:${width}px;${height ? `height:${height}px;` : ""}`;
      document.body.appendChild(b);
      return b;
    },
    /** A card in `parent` (or the body), with q/qa helpers and `done()` to take it and its box away. */
    card(config, states, parent) {
      const c = document.createElement("rodent-trap-card");
      (parent || document.body).appendChild(c);
      c.setConfig(config);
      c.hass = { states };
      c.q = (s) => c.shadowRoot.querySelector(s);
      c.qa = (s) => [...c.shadowRoot.querySelectorAll(s)];
      c.done = () => (parent ? parent.remove() : c.remove());
      return c;
    },
    /** `n` simple traps, all armed, and their states. */
    traps(n, extra = {}) {
      const traps = [];
      const states = {};
      for (let i = 0; i < n; i++) {
        traps.push({ name: `Trap ${i + 1}`, kill: `binary_sensor.k${i}`, battery: `sensor.b${i}`, ...extra });
        states[`binary_sensor.k${i}`] = st("off");
        states[`sensor.b${i}`] = st(80, { unit_of_measurement: "%" });
      }
      return { traps, states };
    },
    /** How many tiles share the first row. */
    perRow(c) {
      const tiles = c.qa(".tile");
      const top = Math.round(tiles[0].getBoundingClientRect().top);
      return tiles.filter((t) => Math.round(t.getBoundingClientRect().top) === top).length;
    },
    widths: (c) => c.qa(".tile").map((t) => Math.round(t.getBoundingClientRect().width)),
    /** A computed transform as [a, b, c, d, e, f]. */
    matrix(el) {
      const t = getComputedStyle(el).transform;
      if (!t || t === "none") return [1, 0, 0, 1, 0, 0];
      return t.replace(/^matrix\(|\)$/g, "").split(",").map(Number);
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
  const open = async (url, options = {}, init) => {
    const page = await openPage(browser, null, { viewport: { width: 1300, height: 1400 }, ...options });
    if (init) await page.addInitScript(init);
    await page.addInitScript(helpers);
    await page.goto(url);
    return page;
  };

  const page = await open(fixtureUrl);

  // --- Offline: the grey is a filter on the <svg> itself. On an SVG group, Safari, iOS and Chromium before 89
  // ignored it, and an offline trap kept its yellow cheese and tan wood.
  const offline = await page.evaluate(() => {
    const { st } = T;
    const c = T.card({ traps: [{ name: "Off", kill: "binary_sensor.k", online: "binary_sensor.o", bait: "sensor.bait" }, { name: "On", kill: "binary_sensor.k2" }] },
      { "binary_sensor.k": st("off"), "binary_sensor.o": st("off"), "sensor.bait": st(80, { unit_of_measurement: "%" }), "binary_sensor.k2": st("off") }, T.box(700));
    const [off, on] = c.qa("svg.scene");
    const stage = getComputedStyle(off.querySelector(".stage"));
    window.offCard = c;
    return { offline: off.classList.contains("st-offline"), svg: getComputedStyle(off).filter, stage: [stage.filter, stage.opacity], armed: getComputedStyle(on).filter };
  });
  check("offline: the grey filter is on the <svg>, the drawing is faded", offline, { offline: true, svg: "grayscale(1)", stage: ["none", "0.5"], armed: "none" });
  // And it really is grey: no pixel of the offline drawing has any colour.
  const shot = await page.locator("rodent-trap-card").first().locator("svg.scene").first().screenshot();
  const colour = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let most = 0;
    for (let i = 0; i < d.length; i += 4) most = Math.max(most, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]));
    window.offCard.done();
    return most;
  }, shot.toString("base64"));
  check("offline: the drawing has no colour left", colour <= 8, true);

  // --- Tile widths: one or two traps stretch across a wide card, and `columns` is a maximum.
  const grid = await page.evaluate(async () => {
    const out = {};
    const at = async (width, config, n = 1) => {
      const { traps, states } = T.traps(n);
      const c = T.card({ show_summary: false, traps, ...config }, states, T.box(width));
      await T.frame();
      const body = c.q(".tile-body");
      const res = { perRow: T.perRow(c), widths: T.widths(c), sideBySide: getComputedStyle(body).gridTemplateColumns.split(" ").length === 2 };
      res.cols = c.q(".grid").style.getPropertyValue("--rt-cols");
      c.done();
      return res;
    };
    out.one = await at(1000, {}, 1);
    out.two = await at(1000, {}, 2);
    out.auto4 = await at(1000, {}, 4);
    out.cols3wide = await at(1000, { columns: 3 }, 6);
    out.cols3phone = await at(400, { columns: 3 }, 6);
    out.cols2section = await at(560, { columns: 2 }, 4);
    out.cols4of2 = await at(1000, { columns: 4 }, 2);
    out.round = [(await at(1000, { columns: 2.6 }, 6)).perRow, (await at(1000, { columns: 0.3 }, 6)).perRow];
    // Fractional widths, where the column sum must not round up past the card.
    out.fractional = [(await at(777.5, { columns: 2 }, 4)).perRow, (await at(1000.3, { columns: 3 }, 6)).perRow, (await at(810.6, { columns: 3 }, 6)).perRow];
    // Back to automatic when `columns` goes away.
    const { traps, states } = T.traps(4);
    const c = T.card({ traps, columns: 1 }, states, T.box(1000));
    await T.frame();
    const before = T.perRow(c);
    c.setConfig({ traps });
    c.hass = { states };
    await T.frame();
    out.cleared = [before, T.perRow(c), c.q(".grid").classList.contains("max-cols")];
    c.done();
    return out;
  });
  // A 1000 px card: 1 px borders and 12 px of padding either side leave 974 px for tiles.
  check("width: one trap fills a wide card and goes side by side", [grid.one.widths, grid.one.sideBySide], [[974], true]);
  check("width: two traps share a wide card", grid.two.widths, [481, 481]);
  check("width: automatic still makes columns of about 290 px", grid.auto4.perRow, 3);
  check("columns: 3 on a wide card", grid.cols3wide.perRow, 3);
  check("columns: 3 on a phone is one readable column", [grid.cols3phone.perRow, grid.cols3phone.widths[0]], [1, 374]);
  check("columns: 2 in a section column", grid.cols2section.perRow, 2);
  check("columns: 4 with two traps leaves no empty columns", [grid.cols4of2.perRow, grid.cols4of2.widths, grid.cols4of2.cols], [2, [481, 481], "2"]);
  check("columns: rounded to a whole number, at least 1", grid.round, [3, 1]);
  check("columns: fractional card widths", grid.fractional, [2, 3, 3]);
  check("columns: removing it goes back to automatic", grid.cleared, [1, 3, false]);

  // --- Card size, from the config alone: masonry asks while the card is detached.
  const size = await page.evaluate(() => {
    const mk = (config) => {
      const c = document.createElement("rodent-trap-card");
      if (config) c.setConfig(config);
      return c.getCardSize();
    };
    const t = (n) => T.traps(n).traps;
    return {
      unset: mk(null),
      titled: mk({ title: "T", traps: t(4) }),
      summaryOnly: mk({ traps: t(4) }),
      bare: mk({ title: "", show_summary: false, traps: t(3) }),
      noScene: mk({ show_summary: false, show_scene: false, traps: t(3) }),
      cols: mk({ columns: 2, traps: t(5) }),
      moreColsThanTraps: mk({ columns: 9, traps: t(2) }),
      empty: mk({ traps: [] }),
      grid: document.createElement("rodent-trap-card").getGridOptions(),
    };
  });
  check("card size: 2 for the header, 7 per row of tiles", [size.titled, size.summaryOnly, size.bare], [30, 30, 21]);
  check("card size: 5 per row without the illustrations", size.noScene, 15);
  check("card size: `columns` puts that many tiles in a row", [size.cols, size.moreColsThanTraps], [23, 9]);
  check("card size: no traps, and before a config", [size.empty, size.unset], [4, 9]);
  check("sections: grid options keep at least 2 rows", size.grid, { columns: 12, min_columns: 6, min_rows: 2 });

  // --- Sections view: with a fixed number of rows the card stays inside them and scrolls.
  const rows = await page.evaluate(async () => {
    const { traps, states } = T.traps(3);
    const slot = T.box(400, 300);
    const c = T.card({ title: "T", traps }, states, slot);
    const out = { attr: [] };
    c.layout = "grid";
    out.attr.push(c.hasAttribute("grid-layout"), c.layout);
    await T.frame();
    const card = c.q("ha-card");
    const slotBox = slot.getBoundingClientRect();
    out.grid = {
      host: Math.round(c.getBoundingClientRect().height), card: Math.round(card.getBoundingClientRect().height),
      inside: card.getBoundingClientRect().bottom <= slotBox.bottom + 0.5, scrolls: getComputedStyle(card).overflowY === "auto" && card.scrollHeight > card.clientHeight,
    };
    c.layout = "masonry";
    out.attr.push(c.hasAttribute("grid-layout"));
    await T.frame();
    out.masonrySpills = c.getBoundingClientRect().height > 300;
    c.done();
    return out;
  });
  check("sections: layout grid marks the card", rows.attr, [true, "grid", false]);
  check("sections: fixed rows keep the card inside and scrolling", rows.grid, { host: 300, card: 300, inside: true, scrolls: true });
  check("sections: other layouts keep their natural height", rows.masonrySpills, true);

  // --- The drawing is as tall as its width allows, up to 104 px (140 px side by side), and stays centred.
  const scene = await page.evaluate(async () => {
    const at = async (width, n = 1) => {
      const { traps, states } = T.traps(n);
      const c = T.card({ show_summary: false, traps }, states, T.box(width));
      await T.frame();
      const svg = c.q("svg.scene").getBoundingClientRect();
      const wrap = c.q(".scene-wrap").getBoundingClientRect();
      const floor = c.q("svg.scene .floor").getBoundingClientRect();
      const res = {
        height: Math.round(svg.height), fills: Math.round(svg.width) === Math.round(wrap.width - 16),
        ratio: Math.abs(svg.height - (svg.width * 72) / 244) < 1, centred: Math.abs(floor.left - svg.left - (svg.right - floor.right)) < 1,
      };
      c.done();
      return res;
    };
    return { narrow: await at(284), phone: await at(400), section: await at(560), wide: await at(1000) };
  });
  check("scene: a narrow tile's drawing is only as tall as it needs", [scene.narrow.height, scene.narrow.fills, scene.narrow.ratio], [71, true, true]);
  check("scene: 104 px at most in a stacked tile", [scene.phone.height, scene.section.height], [104, 104]);
  check("scene: centred when the height is capped", scene.section.centred, true);
  check("scene: taller side by side, up to 140 px", [scene.wide.height, scene.wide.ratio], [124, true]);

  // --- Narrow tiles: the name gets its own row, and the readings keep their values whole. Container queries measure
  // the tile inside its 1 px border, so `tile` is its clientWidth: the card is 28 px wider (borders and padding).
  const compact = await page.evaluate(async () => {
    const { st } = T;
    const at = async (tile, extra = {}) => {
      const c = T.card({ show_summary: false, traps: [{ name: "Basement", kill: "binary_sensor.k", battery: "sensor.b", ...extra }] },
        { "binary_sensor.k": st("on"), "sensor.b": st(80, { unit_of_measurement: "%" }) }, T.box(tile + 28));
      await T.frame();
      const r = (s) => c.q(s).getBoundingClientRect();
      const metric = getComputedStyle(c.q(".metric"));
      const res = {
        tile: c.q(".tile").clientWidth, chipBelow: r(".tile-head .chip").top >= r(".name").bottom - 0.5, column: metric.flexDirection === "column",
        iconAbove: r(".m-battery .m-icon").bottom <= r(".m-battery .m-value").top + 0.5, cols: getComputedStyle(c.q(".metrics")).gridTemplateColumns.split(" ").length,
        bannerIcon: getComputedStyle(c.q(".banner > .ic")).display !== "none", metricIcon: getComputedStyle(c.q(".m-icon")).display !== "none",
        nameWhole: c.q(".name-btn").scrollWidth <= c.q(".name-btn").clientWidth,
        chipInside: r(".tile-head .chip").right <= r(".tile").right + 0.5,
      };
      c.done();
      return res;
    };
    const out = {};
    for (const w of [440, 410, 400, 261, 260, 181, 180, 131, 130]) out[w] = await at(w);
    out.longChip = await at(140, { battery: "sensor.nope" });
    return out;
  });
  const pick = (w, keys) => keys.map((k) => compact[w][k]);
  check("narrow: the chip sits beside the name in a normal tile", pick(400, ["tile", "chipBelow", "column"]), [400, false, false]);
  check("narrow: from 260 px the name has its own row and the icon sits above the value",
    [pick(261, ["chipBelow", "column"]), pick(260, ["chipBelow", "column", "iconAbove", "nameWhole"])], [[false, false], [true, true, true, true]]);
  check("narrow: three readings a row from 410 px, two below", [compact[440].cols, compact[410].cols, compact[400].cols, compact[181].cols], [3, 3, 2, 2]);
  check("narrow: one column and no banner icon from 180 px", [pick(181, ["cols", "bannerIcon"]), pick(180, ["cols", "bannerIcon"])], [[2, true], [1, false]]);
  check("narrow: no reading icons from 130 px", [compact[131].metricIcon, compact[130].metricIcon], [true, false]);
  check("narrow: a long status stays inside the tile", [compact.longChip.chipInside, compact[130].chipInside, compact[130].nameWhole], [true, true, true]);

  const bits = await page.evaluate(async () => {
    const { st } = T;
    const c = T.card({ title: "T", traps: [{ name: "A", kill: "binary_sensor.k", strikes: "sensor.s" }] }, { "binary_sensor.k": st("on"), "sensor.s": st(4) }, T.box(500));
    await T.frame();
    const v = getComputedStyle(c.q(".m-value"));
    const out = {
      chip: [c.q(".tile-head .chip .chip-text").textContent, c.q(".tile-head .chip").textContent],
      summary: c.qa(".summary .chip").map((x) => (x.querySelector(".chip-text") || {}).textContent),
      value: [v.overflow, v.textOverflow],
    };
    c.done();
    return out;
  });
  check("chip: the label is in its own span, so it can shorten", bits.chip, ["Catch detected", "Catch detected"]);
  check("chip: summary chips too", bits.summary, ["1 catch", "4 strikes"]);
  check("narrow: a value that can't fit ends in an ellipsis instead of being cut", bits.value, ["hidden", "ellipsis"]);

  // A prompt fits a narrow tile.
  const prompt = await page.evaluate(async () => {
    const { st } = T;
    const c = T.card({ show_summary: false, traps: [{ name: "A", kill: "binary_sensor.k", actions: [{ entity: "button.go", name: "Clear the alert", confirm: true }] }] },
      { "binary_sensor.k": st("off"), "button.go": st("unknown") }, T.box(158));
    c.hass = { states: c.hass.states, callService: async () => {} };
    c.q(".act").click();
    await T.frame();
    const box = c.q(".confirm").getBoundingClientRect();
    const info = c.q(".info").getBoundingClientRect();
    const out = { inside: box.right <= info.right + 0.5 && c.q(".confirm > span").getBoundingClientRect().right <= box.right + 0.5 };
    c.done();
    return out;
  });
  check("narrow: the confirmation fits a 130 px tile", prompt, { inside: true });

  // --- Animation cost: idle animations end, at the pose they're drawn in; only alerts keep going.
  const idle = await page.evaluate(async () => {
    const { st, iso } = T;
    const c = T.card({ title: "T", stale_after: "1h", traps: [
      { name: "S", style: "snap", kill: "binary_sensor.k1", online: "binary_sensor.o1" },
      { name: "G", style: "goodnature", kill: "binary_sensor.k2", last_seen: "sensor.seen2" },
      { name: "B", style: "station", kill: "binary_sensor.k3" },
      { name: "M", style: "goodnature_mouse", kill: "binary_sensor.k4" },
      { name: "N", style: "neocam", kill: "binary_sensor.k5" },
    ] }, { "binary_sensor.k1": st("off"), "binary_sensor.o1": st("on"), "binary_sensor.k2": st("off"), "sensor.seen2": st(iso(60000), { device_class: "timestamp" }), "binary_sensor.k3": st("off"),
      "binary_sensor.k4": st("off"), "binary_sensor.k5": st("off") }, T.box(1000));
    await T.frame();
    const anims = c.shadowRoot.getAnimations();
    const out = {
      infinite: anims.filter((a) => a.effect.getComputedTiming().endTime === Infinity).map((a) => a.animationName),
      names: [...new Set(anims.map((a) => a.animationName))].sort(),
      counts: {},
    };
    for (const a of anims) out.counts[a.animationName] = a.effect.getTiming().iterations;
    // The pose just before each part of the mouse stops, against the pose after: nothing jumps.
    const jumps = [];
    for (const a of anims.filter((x) => x.effect.target.closest && x.effect.target.closest(".mouse"))) {
      const el = a.effect.target;
      const end = a.effect.getComputedTiming().endTime;
      a.currentTime = end - 1;
      const before = T.matrix(el);
      a.finish();
      const after = T.matrix(el);
      const worst = Math.max(...before.map((v, n) => Math.abs(v - after[n]) / (n > 3 ? 1 : 0.02)));
      if (worst > 1) jumps.push(`${a.animationName} ${before} -> ${after}`);
    }
    out.jumps = jumps;
    const svg = c.q(".st-armed").getBoundingClientRect();
    const mouse = c.q(".st-armed .mouse").getBoundingClientRect();
    out.mouseInView = mouse.left >= svg.left && mouse.right <= svg.right + 1;
    c.done();
    return out;
  });
  check("animations: an all-clear card has no endless animation", idle.infinite, []);
  check("animations: its idle animations still play", ["beacon", "blink-eye", "led", "peek", "ping", "sniff", "sway", "twitch", "wiggle"].every((n) => idle.names.includes(n)), true);
  check("animations: the mouse peeks twice, the link pings 3 times, the A24 calls and the Mouse Trap's LED blinks 4 times, the title wiggles once",
    [idle.counts.peek, idle.counts.ping, idle.counts.beacon, idle.counts.led, idle.counts.wiggle], [2, 3, 4, 4, 1]);
  check("animations: the mouse stops where it's drawn, with nothing jumping", [idle.jumps, idle.mouseInView], [[], true]);

  const alerts = await page.evaluate(async () => {
    const { st, iso } = T;
    const c = T.card({ stale_after: "1h", traps: [
      { name: "Caught", kill: "binary_sensor.k", last_seen: "sensor.seen" },
    ] }, { "binary_sensor.k": st("on"), "sensor.seen": st(iso(2 * 3600e3), { device_class: "timestamp" }) }, T.box(500));
    await T.frame();
    const tile = c.q(".tile.s-kill");
    const ring = getComputedStyle(tile, "::after");
    const anims = c.shadowRoot.getAnimations();
    const out = {
      tile: getComputedStyle(tile).animationName, ring: [ring.animationName, ring.boxShadow.includes("inset"), ring.pointerEvents],
      boxShadow: anims.filter((a) => a.effect.getKeyframes().some((k) => "boxShadow" in k)).map((a) => a.animationName),
      ringOpacityOnly: anims.filter((a) => a.effect.pseudoElement === "::after" && a.animationName === "fade-pulse")
        .map((a) => Object.keys(a.effect.getKeyframes()[0]).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))),
      late: getComputedStyle(c.q(".m-last_seen.is-warn .ic-seen")).animationIterationCount,
    };
    c.done();
    return out;
  });
  check("animations: a catch pulses an inner ring by opacity, not an animated box-shadow",
    alerts, { tile: "none", ring: ["fade-pulse", true, "none"], boxShadow: [], ringOpacityOnly: [["opacity"]], late: "infinite" });

  const replay = await page.evaluate(async () => {
    const { st } = T;
    const states = { "binary_sensor.k": st("off") };
    const c = T.card({ traps: [{ name: "T", kill: "binary_sensor.k" }] }, states, T.box(500));
    await T.sleep(400);
    const first = c.q(".mouse").getAnimations().find((a) => a.animationName === "peek");
    const was = first.currentTime;
    c.hass = { states: { "binary_sensor.k": st("on") } };
    c.hass = { states: { "binary_sensor.k": st("off") } };
    const again = c.q(".mouse").getAnimations().find((a) => a.animationName === "peek");
    const out = { was: was >= 300, again: again !== first && again.currentTime < 100 && again.playState === "running" };
    c.done();
    return out;
  });
  check("animations: the mouse plays again when the trap is set again", replay, { was: true, again: true });

  // --- card-mod: its <style> goes into the card's shadow root after the card's own styles, and wins again.
  const cardMod = await page.evaluate(async () => {
    const { st } = T;
    const c = T.card({ title: "One", traps: [{ name: "A", kill: "binary_sensor.k", battery: "sensor.b" }] },
      { "binary_sensor.k": st("on"), "sensor.b": st(80, { unit_of_measurement: "%" }) }, T.box(500));
    const cm = document.createElement("card-mod");
    cm.innerHTML = `<style>
      :host { --rodent-trap-wood-color: rgb(0, 128, 0); --rt-bad: rgb(255, 0, 255); }
      .tile { border-radius: 0px; border-color: rgb(1, 2, 3); }
      .name { color: rgb(255, 0, 0); }
      .m-value { font-size: 20px; }
    </style>`;
    c.shadowRoot.appendChild(cm);
    await T.frame();
    const probe = () => {
      const tile = getComputedStyle(c.q(".tile"));
      return {
        radius: tile.borderTopLeftRadius, border: tile.borderTopColor, name: getComputedStyle(c.q(".name")).color,
        value: getComputedStyle(c.q(".m-value")).fontSize, wood: getComputedStyle(c.q(".scene .wood")).fill, bad: getComputedStyle(c.q(".ic-bell")).fill,
      };
    };
    const card = c.q("ha-card");
    const out = { layer: c.shadowRoot.adoptedStyleSheets[0].cssRules[0].constructor.name, name: c.shadowRoot.adoptedStyleSheets[0].cssRules[0].name, before: probe() };
    c.setConfig({ title: "Two", traps: [{ name: "A", kill: "binary_sensor.k", battery: "sensor.b" }] });
    c.hass = c.hass;
    await T.frame();
    out.after = { cardMod: cm.isConnected && cm.parentNode === c.shadowRoot, sameCard: c.q("ha-card") === card, wraps: c.qa(".wrap").length, title: c.q(".title").textContent.trim(), ...probe() };
    c.done();
    return out;
  });
  const modded = { radius: "0px", border: "rgb(1, 2, 3)", name: "rgb(255, 0, 0)", value: "20px", wood: "rgb(0, 128, 0)", bad: "rgb(255, 0, 255)" };
  check("card-mod: the card's styles are in a layer", [cardMod.layer, cardMod.name], ["CSSLayerBlockRule", "rodent-trap-card"]);
  check("card-mod: its tokens, radius, colours and fonts override the card's", cardMod.before, modded);
  check("card-mod: a new config keeps its styles and the same <ha-card>", cardMod.after, { cardMod: true, sameCard: true, wraps: 1, title: "Two", ...modded });
  errors.push(...page.errors);
  await page.close();

  // Browsers without constructable stylesheets get a <style>: made once, layered, and card-mod still wins.
  const noSheets = await open(fixtureUrl, {}, () => {
    delete CSSStyleSheet.prototype.replaceSync;
  });
  const styleTag = await noSheets.evaluate(async () => {
    const { st } = T;
    const c = T.card({ traps: [{ name: "A", kill: "binary_sensor.k" }] }, { "binary_sensor.k": st("off") }, T.box(500));
    const cm = document.createElement("card-mod");
    cm.innerHTML = "<style>.tile { border-radius: 0px; }</style>";
    c.shadowRoot.appendChild(cm);
    c.setConfig({ title: "Again", traps: [{ name: "A", kill: "binary_sensor.k" }] });
    c.hass = c.hass;
    await T.frame();
    const own = [...c.shadowRoot.children].filter((e) => e.tagName === "STYLE");
    const out = { adopted: c.shadowRoot.adoptedStyleSheets.length, styles: own.length, layered: own[0].textContent.startsWith("@layer rodent-trap-card {"),
      cardMod: cm.isConnected, radius: getComputedStyle(c.q(".tile")).borderTopLeftRadius, chip: getComputedStyle(c.q(".chip")).borderTopLeftRadius };
    c.done();
    return out;
  });
  check("no constructable stylesheets: one layered <style>, and card-mod still wins", styleTag, { adopted: 0, styles: 1, layered: true, cardMod: true, radius: "0px", chip: "12px" });
  errors.push(...noSheets.errors);
  await noSheets.close();

  // Without cascade layers, the styles stay unlayered: wrapped in @layer they would be dropped altogether.
  const noLayers = await open(fixtureUrl, {}, () => {
    delete window.CSSLayerBlockRule;
  });
  const plain = await noLayers.evaluate(async () => {
    const { st } = T;
    const c = T.card({ traps: [{ name: "A", kill: "binary_sensor.k" }] }, { "binary_sensor.k": st("off") }, T.box(500));
    await T.frame();
    const out = { first: c.shadowRoot.adoptedStyleSheets[0].cssRules[0].selectorText, radius: getComputedStyle(c.q(".tile")).borderTopLeftRadius };
    c.done();
    return out;
  });
  check("no cascade layers: the styles apply unlayered", plain, { first: ":host", radius: "14px" });
  errors.push(...noLayers.errors);
  await noLayers.close();

  // --- Theme hooks: every illustration colour has a public variable, and the title follows the card header theme.
  const themed = await open(fixtureUrl);
  const theme = await themed.evaluate(async () => {
    const { st } = T;
    const pairs = {
      "--rt-wood": "--rodent-trap-wood-color", "--rt-wood-edge": "--rodent-trap-wood-edge-color", "--rt-grain": "--rodent-trap-wood-grain-color",
      "--rt-metal": "--rodent-trap-metal-color", "--rt-metal-hi": "--rodent-trap-metal-highlight-color",
      "--rt-cheese": "--rodent-trap-cheese-color", "--rt-cheese-dark": "--rodent-trap-cheese-shade-color",
      "--rt-fur": "--rodent-trap-mouse-fur-color", "--rt-fur-hi": "--rodent-trap-mouse-belly-color", "--rt-pink": "--rodent-trap-mouse-skin-color", "--rt-eye": "--rodent-trap-mouse-eye-color",
      "--rt-gn-body": "--rodent-trap-goodnature-body-color", "--rt-gn-stripe": "--rodent-trap-goodnature-stripe-color",
      "--rt-gn-lure": "--rodent-trap-goodnature-lure-color", "--rt-can-band": "--rodent-trap-goodnature-canister-color",
      "--rt-stn-body": "--rodent-trap-station-body-color", "--rt-stn-lid": "--rodent-trap-station-lid-color",
      "--rt-stn-hole": "--rodent-trap-station-entrance-color", "--rt-stn-block": "--rodent-trap-station-bait-color",
      "--rt-gm-body": "--rodent-trap-goodnature-mouse-body-color", "--rt-gm-hole": "--rodent-trap-goodnature-mouse-entrance-color",
      "--rt-nc-body": "--rodent-trap-neocam-body-color", "--rt-nc-hole": "--rodent-trap-neocam-entrance-color", "--rt-nc-spark": "--rodent-trap-neocam-spark-color",
    };
    const box = T.box(500);
    const c = T.card({ title: "Traps", traps: [{ name: "A", kill: "binary_sensor.k" }] }, { "binary_sensor.k": st("off") }, box);
    await T.frame();
    const out = { defaults: getComputedStyle(c).getPropertyValue("--rt-wood").trim(), title: [] };
    const title = () => { const s = getComputedStyle(c.q(".title")); return [s.fontSize, s.letterSpacing]; };
    out.title.push(title());
    Object.values(pairs).forEach((name, i) => box.style.setProperty(name, `rgb(${i}, 1, 2)`));
    box.style.setProperty("--ha-font-size-2xl", "26px");
    box.style.setProperty("--ha-card-header-font-family", "Georgia");
    await T.frame();
    out.mapped = Object.keys(pairs).filter((token, i) => getComputedStyle(c).getPropertyValue(token).trim() !== `rgb(${i}, 1, 2)`);
    out.wood = getComputedStyle(c.q(".scene .wood")).fill;
    out.title.push(title(), getComputedStyle(c.q(".title")).fontFamily);
    box.style.setProperty("--ha-card-header-font-size", "20px");
    await T.frame();
    out.title.push(title());
    c.done();
    return out;
  });
  check("theme: art colours default as before", theme.defaults, "#d6a064");
  check("theme: every art colour follows its --rodent-trap-* variable", [theme.mapped, theme.wood], [[], "rgb(0, 1, 2)"]);
  check("theme: the title is 24 px like Home Assistant's card headers, and follows the header theme",
    theme.title, [["24px", "-0.288px"], ["26px", "-0.312px"], "Georgia", ["20px", "-0.24px"]]);
  errors.push(...themed.errors);
  await themed.close();

  // --- The editor calls `columns` what it now is.
  const edPage = await open(fixtureUrl);
  const label = await edPage.evaluate(async () => {
    const ed = document.createElement("rodent-trap-card-editor");
    ed.hass = { states: {}, entities: {}, devices: {}, areas: {} };
    ed.setConfig({ type: "custom:rodent-trap-card", traps: [] });
    document.body.appendChild(ed);
    await T.sleep(30);
    const form = ed.shadowRoot.querySelector("ha-form");
    return form.computeLabel({ name: "columns" });
  });
  check("editor: the columns field is Max columns", label, "Max columns (blank = automatic)");
  errors.push(...edPage.errors);
  await edPage.close();

  // --- The demo: every width, from a narrow tile up, keeps names and values whole; the card size is realistic;
  // and the new width and Max columns controls work.
  // 1500 px leaves the demo's card its full 980 px beside the controls.
  const demo = await open(demoUrl, { viewport: { width: 1500, height: 1400 } });
  await demo.waitForTimeout(400);
  const sweep = await demo.evaluate(async () => {
    const card = document.querySelector("rodent-trap-card");
    const host = document.getElementById("host");
    host.style.transition = "none";
    const cut = [];
    for (const w of [150, 175, 185, 200, 230, 260, 290, 320, 360, 400, 440]) {
      host.style.maxWidth = w + 24 + "px";
      await T.frame();
      const sh = card.shadowRoot;
      for (const v of sh.querySelectorAll(".m-value, .name-btn")) if (v.scrollWidth > v.clientWidth + 0.5) cut.push(`${w}: ${v.textContent.trim()}`);
    }
    const ratio = async (w, patch) => {
      host.style.maxWidth = w + "px";
      // `config` is the demo's own card config.
      card.setConfig({ ...config, ...patch });
      card.hass = card.hass;
      await T.frame();
      return card.getCardSize() / (card.getBoundingClientRect().height / 50);
    };
    const ratios = [await ratio(400, {}), await ratio(400, { show_scene: false }), await ratio(500, { traps: config.traps.slice(0, 2) })];
    card.setConfig(config);
    card.hass = card.hass;
    return { cut, ratios };
  });
  check("demo: no trap name or value is cut off, from 150 px tiles up", sweep.cut, []);
  check("demo: the card size is within a quarter of the real height", sweep.ratios.map((r) => r > 0.75 && r < 1.35), [true, true, true]);
  const controls = await demo.evaluate(async () => {
    const card = document.querySelector("rodent-trap-card");
    const host = document.getElementById("host");
    host.style.transition = "none";
    const pick = async (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event("change"));
      await T.frame();
    };
    const perRow = () => T.perRow({ qa: (s) => [...card.shadowRoot.querySelectorAll(s)] });
    await pick("width", "250");
    const narrow = [Math.round(card.shadowRoot.querySelector(".tile").getBoundingClientRect().width), getComputedStyle(card.shadowRoot.querySelector(".metric")).flexDirection];
    await pick("width", "1000");
    await pick("columns", "2");
    const wide = perRow();
    await pick("width", "400");
    const phone = perRow();
    await pick("columns", "");
    await pick("width", "1000");
    return { narrow, wide, phone, auto: perRow() };
  });
  check("demo: Narrow width shows the compact layout, Max columns is a maximum", controls, { narrow: [224, "column"], wide: 2, phone: 1, auto: 3 });
  errors.push(...demo.errors);
  await demo.close();

  return { lines, errors };
}

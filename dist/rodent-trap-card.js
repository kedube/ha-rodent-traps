/*!
 * Rodent Trap Card - a Home Assistant dashboard card for smart rodent traps.
 * https://github.com/kedube/ha-rodent-traps
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(() => {
  "use strict";

  const VERSION = "1.0.0";
  const CARD_TAG = "rodent-trap-card";
  const EDITOR_TAG = "rodent-trap-card-editor";

  // Per-trap entity keys, in display order.
  const METRIC_KEYS = ["strikes", "battery", "bait", "kill", "rearm", "online"];
  const TRAP_KEYS = ["name", "location", ...METRIC_KEYS, "battery_low", "bait_low"];

  const CARD_DEFAULTS = {
    title: "",
    show_summary: true,
    show_scene: true,
    animations: true,
    sort: "config",
    battery_low: 20,
    bait_low: 25,
  };

  // ---------------------------------------------------------------------------
  // State interpretation
  // ---------------------------------------------------------------------------

  const wordSet = (s) => new Set(s.split(" "));
  const BOOL_WORDS = {
    kill: {
      on: wordSet("on true yes detected triggered caught catch kill killed captured occupied full sprung snapped tripped alert alarm problem"),
      off: wordSet("off false no clear clean idle armed empty ready ok set none normal"),
    },
    rearm: {
      on: wordSet("on true yes needs_rearm rearm re-arm re_arm required triggered sprung snapped tripped disarmed unarmed unset reset problem"),
      off: wordSet("off false no armed ready set ok idle normal"),
    },
    online: {
      on: wordSet("on true yes online connected available home ok ready alive up"),
      off: wordSet("off false no offline disconnected not_home away lost down dead"),
    },
  };

  const LEVEL_WORDS = new Map(Object.entries({
    full: 100, fresh: 100, high: 90, plenty: 90, good: 75, ok: 75, normal: 75,
    medium: 50, half: 50, moderate: 50, low: 15, very_low: 5, critical: 5,
    empty: 0, none: 0, depleted: 0, out: 0, gone: 0,
  }));

  const UNKNOWN_STATES = new Set(["unknown", "unavailable", ""]);
  const DASH = "\u2014";

  const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, "_");
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toNum = (v, fallback) => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
  const titleCase = (v) => String(v).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** An entity reference is either "sensor.x" or { entity, attribute?, invert?, active_states?, min?, max?, unit? }. */
  function normalizeRef(ref) {
    if (typeof ref === "string") return ref.trim() ? { entity: ref.trim() } : null;
    if (ref && typeof ref === "object" && typeof ref.entity === "string" && ref.entity.trim()) {
      return { ...ref, entity: ref.entity.trim() };
    }
    return null;
  }

  function readRef(hass, ref) {
    if (!ref) return null;
    const stateObj = hass && hass.states ? hass.states[ref.entity] : undefined;
    if (!stateObj) return { ref, missing: true };
    const raw = ref.attribute ? (stateObj.attributes || {})[ref.attribute] : stateObj.state;
    const dead = stateObj.state === "unavailable";
    const unknown = dead || raw === undefined || raw === null || (typeof raw === "string" && UNKNOWN_STATES.has(raw.trim().toLowerCase()));
    return {
      ref,
      stateObj,
      raw,
      domain: ref.entity.split(".")[0],
      missing: false,
      dead,
      unknown,
      since: stateObj.last_changed || null,
    };
  }

  function interpretBool(r, key) {
    if (!r || r.missing) return null;
    // An unavailable connectivity entity means the trap is offline, whatever its polarity.
    if (key === "online" && r.dead) return false;
    if (r.unknown) return null;
    const { ref, raw } = r;
    let v = null;
    if (ref.active_states !== undefined && ref.active_states !== null) {
      v = [].concat(ref.active_states).map(norm).includes(norm(raw));
    } else if (typeof raw === "boolean") {
      v = raw;
    } else {
      const s = norm(raw);
      const n = typeof raw === "number" ? raw : s !== "" ? Number(s) : NaN;
      if (Number.isFinite(n)) v = key === "online" ? true : n > 0;
      else if (BOOL_WORDS[key].on.has(s)) v = true;
      else if (BOOL_WORDS[key].off.has(s)) v = false;
      // Any other value on a connectivity entity still proves the trap is reporting.
      else if (key === "online") v = true;
    }
    if (v !== null && ref.invert) v = !v;
    return v;
  }

  function interpretLevel(r, threshold) {
    const out = { level: null, text: null, low: null, empty: false };
    if (!r || r.missing || r.unknown) return out;
    const { ref, raw, stateObj, domain } = r;
    const attrs = stateObj.attributes || {};
    const s = norm(raw);
    const n = typeof raw === "number" ? raw : s !== "" ? Number(raw) : NaN;

    if (Number.isFinite(n)) {
      const unit = ref.unit !== undefined ? ref.unit : ref.attribute ? "" : attrs.unit_of_measurement || "";
      let min = toNum(ref.min, 0);
      let max = toNum(ref.max, NaN);
      if (!Number.isFinite(max)) {
        if (!ref.attribute && unit !== "%" && (domain === "input_number" || domain === "number") && Number.isFinite(Number(attrs.max))) {
          min = toNum(attrs.min, 0);
          max = Number(attrs.max);
        } else {
          max = 100;
        }
      }
      out.level = max > min ? clamp(((n - min) / (max - min)) * 100, 0, 100) : 0;
      if (unit && unit !== "%") out.text = `${fmtNum(n)} ${unit}`;
      else if (!unit && max !== 100) out.text = `${fmtNum(n)}/${fmtNum(max)}`;
      else out.text = `${Math.round(out.level)}%`;
    } else if (typeof raw === "boolean" || s === "on" || s === "off") {
      // binary_sensor with device_class battery/problem: on means low.
      let low = raw === true || s === "on";
      if (ref.invert) low = !low;
      out.low = low;
      out.empty = false;
      out.text = low ? "Low" : "OK";
      return out;
    } else if (LEVEL_WORDS.has(s)) {
      out.level = LEVEL_WORDS.get(s);
      out.text = titleCase(raw);
    } else {
      out.text = titleCase(raw);
      return out;
    }
    out.low = out.level <= threshold;
    out.empty = out.level <= 0;
    return out;
  }

  function interpretCount(r) {
    if (!r || r.missing || r.unknown) return null;
    const n = Number(r.raw);
    return Number.isFinite(n) ? n : null;
  }

  const STATUS_RANK = { kill: 0, rearm: 1, offline: 2, warn: 3, unknown: 4, ok: 5 };

  function buildModel(hass, trap, cfg, index) {
    const refs = {};
    const reads = {};
    for (const k of METRIC_KEYS) {
      refs[k] = normalizeRef(trap[k]);
      reads[k] = readRef(hass, refs[k]);
    }
    const configured = METRIC_KEYS.filter((k) => refs[k]);
    const m = {
      index,
      name: trap.name || `Trap ${index + 1}`,
      location: trap.location || "",
      configured,
      entities: Object.fromEntries(configured.map((k) => [k, refs[k].entity])),
      missing: configured.filter((k) => reads[k].missing).map((k) => refs[k].entity),
      strikes: interpretCount(reads.strikes),
      battery: interpretLevel(reads.battery, toNum(trap.battery_low, cfg.battery_low)),
      bait: interpretLevel(reads.bait, toNum(trap.bait_low, cfg.bait_low)),
      kill: interpretBool(reads.kill, "kill"),
      rearm: interpretBool(reads.rearm, "rearm"),
      online: interpretBool(reads.online, "online"),
      since: {
        kill: reads.kill && reads.kill.since,
        rearm: reads.rearm && reads.rearm.since,
        online: reads.online && reads.online.since,
      },
    };

    // Without a connectivity entity, infer "offline" when every entity is unavailable.
    if (!refs.online) {
      const found = configured.map((k) => reads[k]).filter((r) => !r.missing);
      m.online = found.length && found.every((r) => r.dead) ? false : null;
      if (m.online === false) m.since.online = found[0].since;
    }

    const warnings = [];
    if (m.battery.low) warnings.push("Low battery");
    if (m.bait.empty) warnings.push("Out of bait");
    else if (m.bait.low) warnings.push("Low bait");
    if (m.missing.length) warnings.push("Entity not found");
    m.warnings = warnings;

    const noData = configured.every((k) => reads[k].missing || reads[k].unknown);
    if (m.kill === true) m.status = "kill";
    else if (m.rearm === true) m.status = "rearm";
    else if (m.online === false) m.status = "offline";
    else if (warnings.length) m.status = "warn";
    else if (noData) m.status = "unknown";
    else m.status = "ok";

    m.label = {
      kill: "Catch detected",
      rearm: "Needs re-arm",
      offline: "Offline",
      warn: warnings[0] + (warnings.length > 1 ? ` +${warnings.length - 1}` : ""),
      unknown: configured.length ? "No data" : "Not set up",
      ok: refs.kill || refs.rearm ? "Armed" : "All good",
    }[m.status];

    m.scene = { kill: "kill", rearm: "sprung", offline: "offline", unknown: "idle" }[m.status] || "armed";
    m.primary = m.entities.kill || m.entities.rearm || m.entities.online || m.entities[configured[0]] || null;
    return m;
  }

  function relTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  // ---------------------------------------------------------------------------
  // Graphics
  // ---------------------------------------------------------------------------

  const ICONS = {
    mouseHead: `<svg viewBox="0 0 24 24" class="ic ic-mouse" aria-hidden="true"><circle cx="5.5" cy="7" r="4.5" class="fur"/><circle cx="18.5" cy="7" r="4.5" class="fur"/><circle cx="5.5" cy="7" r="2.5" class="pink"/><circle cx="18.5" cy="7" r="2.5" class="pink"/><ellipse cx="12" cy="14.5" rx="7.5" ry="7" class="fur"/><circle cx="9.2" cy="13.2" r="1.1" class="eye"/><circle cx="14.8" cy="13.2" r="1.1" class="eye"/><circle cx="12" cy="17" r="1.4" class="pink"/></svg>`,
    bell: `<svg viewBox="0 0 24 24" class="ic ic-bell" aria-hidden="true"><path d="M12 2.5a1.5 1.5 0 0 1 1.5 1.5v.7A6.5 6.5 0 0 1 18.5 11v4l2 2.5v1H3.5v-1l2-2.5v-4a6.5 6.5 0 0 1 5-6.3V4A1.5 1.5 0 0 1 12 2.5Zm-2.2 17.5h4.4a2.2 2.2 0 0 1-4.4 0Z"/></svg>`,
    check: `<svg viewBox="0 0 24 24" class="ic ic-check" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3" class="tick"/></svg>`,
    rearm: `<svg viewBox="0 0 24 24" class="ic ic-rearm" aria-hidden="true"><path d="M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8Zm-8.5 6.5L7 15H4.8A6 6 0 0 0 18 12h2a8 8 0 0 1-15.4 3H2l1.5-4.5Z"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" class="ic ic-armed" aria-hidden="true"><path d="M12 2.5 19.5 5v6.2c0 4.6-3.1 8.6-7.5 10.3-4.4-1.7-7.5-5.7-7.5-10.3V5L12 2.5Z"/><path d="m8.5 12 2.4 2.4 4.6-4.8" class="tick"/></svg>`,
    wifiOff: `<svg viewBox="0 0 24 24" class="ic ic-wifi-off" aria-hidden="true"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0" class="waves"/><circle cx="12" cy="19" r="1.6"/><path d="M4 3 20 21" class="slash"/></svg>`,
  };

  function batteryIcon(b) {
    const lvl = b.level !== null ? b.level : b.low ? 12 : b.low === false ? 100 : 0;
    const w = Math.max(lvl > 0 ? 1.5 : 0, (19 * lvl) / 100);
    return `<svg viewBox="0 0 28 16" class="ic ic-batt" aria-hidden="true"><rect x="1" y="2" width="23" height="12" rx="3" class="shell"/><rect x="24.6" y="5.5" width="2.6" height="5" rx="1.2" class="nub"/><rect x="3" y="4" width="${w.toFixed(2)}" height="8" rx="1.4" class="charge"/></svg>`;
  }

  function cheeseIcon(b, uid) {
    const lvl = b.level !== null ? b.level : b.low ? 15 : b.low === false ? 100 : 0;
    const x = 2 + 20 * (1 - lvl / 100);
    return `<svg viewBox="0 0 24 20" class="ic ic-cheese" aria-hidden="true"><defs><clipPath id="${uid}-bait"><rect x="${x.toFixed(2)}" y="0" width="24" height="20"/></clipPath></defs><path d="M2 17 L22 17 L22 4 Z" class="ghost"/><g clip-path="url(#${uid}-bait)"><path d="M2 17 L22 17 L22 4 Z" class="wedge"/><circle cx="17.5" cy="12.5" r="1.8" class="hole"/><circle cx="20" cy="8.5" r="1" class="hole"/><circle cx="12" cy="15" r="1" class="hole"/></g></svg>`;
  }

  const MOUSE_BODY = `
      <ellipse class="fur" cx="27" cy="15" rx="15" ry="9"/>
      <ellipse class="belly" cx="26" cy="19.5" rx="11" ry="3.6"/>
      <path class="fur" d="M1.5 16C3 11 8 8 14 8.5c5 .5 7.5 4.5 6.5 8.5-1 3.5-8.5 4-16 2-2.5-.6-3.5-1.8-3-3Z"/>
      <circle class="fur" cx="15" cy="7.5" r="5.2"/>
      <circle class="pink" cx="15" cy="7.5" r="3.1"/>`;

  const MOUSE_ALIVE = `
    <g class="mouse">
      <path class="tail" d="M40 18C50 20 54 9 63 12"/>
      ${MOUSE_BODY}
      <g class="eye"><circle cx="8.5" cy="12.8" r="1.5"/><circle cx="8.9" cy="12.3" r=".45" class="glint"/></g>
      <circle class="pink nose" cx="1.6" cy="16.2" r="1.6"/>
      <path class="whiskers" d="M4 15.6 -4.5 12.5M4 16.8-5 17.4M4 18-3.5 21.5"/>
      <ellipse class="pink foot" cx="11.5" cy="22.6" rx="3" ry="1.5"/>
      <ellipse class="pink foot" cx="33" cy="23" rx="3.2" ry="1.5"/>
    </g>`;

  const MOUSE_CAUGHT = `
    <g class="mouse caught">
      <path class="tail" d="M40 18C48 21 52 27 62 27"/>
      ${MOUSE_BODY}
      <path class="x-eye" d="M6.7 11.2 10.3 14.6M10.3 11.2 6.7 14.6"/>
      <circle class="pink nose" cx="1.6" cy="16.2" r="1.6"/>
      <path class="whiskers" d="M4 15.6 -4.5 14M4 16.8-5 18M4 18-3.5 21"/>
      <ellipse class="pink foot" cx="10" cy="23" rx="3" ry="1.4"/>
      <ellipse class="pink foot" cx="34" cy="23.4" rx="3.2" ry="1.4"/>
    </g>
    <g transform="translate(13 -3) scale(1 .42)">
      <g class="orbit">
        <circle r="13" fill="none"/>
        <path class="star" d="M13 -3.2 14 -.9 16.5 -.6 14.6 1.1 15.2 3.6 13 2.3 10.8 3.6 11.4 1.1 9.5 -.6 12 -.9Z"/>
        <path class="star" d="M-6.5 8 -5.5 10.3 -3 10.6-4.9 12.3-4.3 14.8-6.5 13.5-8.7 14.8-8.1 12.3-10 10.6-7.5 10.3Z"/>
        <path class="star" d="M-6.5 -14.5 -5.5 -12.2 -3 -11.9-4.9 -10.2-4.3 -7.7-6.5 -9-8.7 -7.7-8.1 -10.2-10 -11.9-7.5 -12.2Z"/>
      </g>
    </g>`;

  function sceneSvg(m, uid, snap) {
    const lvl = m.configured.includes("bait") ? (m.bait.level !== null ? m.bait.level : m.bait.low ? 15 : 100) : 100;
    const cheeseScale = lvl <= 0 ? 0 : 0.45 + 0.55 * (lvl / 100);
    const showCheese = m.scene !== "kill";
    const aria = {
      armed: "Trap armed and waiting",
      idle: "Trap with no data",
      kill: "Trap sprung with a catch",
      sprung: "Trap sprung and needs re-arming",
      offline: "Trap offline",
    }[m.scene];

    return `
<svg viewBox="-22 16 244 72" class="scene st-${m.scene}${snap ? " snap-now" : ""}" role="img" aria-label="${aria}">
  <defs>
    <radialGradient id="${uid}-glow">
      <stop offset="0" class="glow-in"/>
      <stop offset="1" class="glow-out"/>
    </radialGradient>
  </defs>
  <ellipse class="glow" cx="84" cy="62" rx="92" ry="34" fill="url(#${uid}-glow)"/>
  <path class="floor" d="M-22 81.5H222"/>
  <g class="stage">
    <ellipse class="shadow" cx="80" cy="82" rx="76" ry="3.6"/>
    <rect class="wood" x="4" y="66" width="148" height="15" rx="3"/>
    <rect class="wood-edge" x="4" y="76.5" width="148" height="4.5" rx="2"/>
    <path class="wood-hi" d="M7 67.6H149"/>
    <path class="grain" d="M14 71H52M62 73.5H104M112 70.5H146M22 74.5H40"/>
    <rect class="plate" x="104" y="62.6" width="38" height="3.6" rx="1.2"/>
    ${showCheese && cheeseScale > 0 ? `
    <g class="cheese" style="transform:scale(${cheeseScale.toFixed(3)})">
      <path class="wedge" d="M108 62.8H138V47Z"/>
      <circle class="hole" cx="131" cy="57.5" r="2.4"/>
      <circle class="hole" cx="135.4" cy="52.6" r="1.3"/>
      <circle class="hole" cx="121" cy="60.4" r="1.3"/>
    </g>` : ""}
    ${showCheese && cheeseScale === 0 ? `
    <g class="crumbs"><circle cx="114" cy="62" r="1"/><circle cx="121" cy="61.6" r=".8"/><circle cx="129" cy="62" r="1.1"/><circle cx="135" cy="61.8" r=".7"/></g>` : ""}
    ${m.scene === "armed" ? `<g transform="translate(153 57)">${MOUSE_ALIVE}</g>` : ""}
    ${m.scene === "kill" ? `<g class="victim"><g transform="translate(106 43) rotate(3)">${MOUSE_CAUGHT}</g></g>` : ""}
    <path class="staple" d="M64 66V60.5a3 3 0 0 1 6 0V66M74 66V60.5a3 3 0 0 1 6 0V66"/>
    ${m.scene === "armed" || m.scene === "idle" || m.scene === "offline" ? `<path class="holddown" d="M12 57.4 104 61.6"/>` : ""}
    <g class="bar"><path d="M72 63H136V57.5"/></g>
    <circle class="spring" cx="72" cy="63" r="4.6"/>
    <circle class="spring-in" cx="72" cy="63" r="1.8"/>
  </g>
  ${m.scene === "sprung" ? `
  <g class="badge badge-rearm" transform="translate(4 32)">
    <circle r="12"/>
    <g class="spin"><path transform="translate(-8 -8) scale(.667)" d="M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8Zm-8.5 6.5L7 15H4.8A6 6 0 0 0 18 12h2a8 8 0 0 1-15.4 3H2l1.5-4.5Z"/></g>
  </g>` : ""}
  ${m.scene === "offline" ? `
  <g class="badge badge-offline" transform="translate(196 32)">
    <circle r="12"/>
    <g transform="translate(-8 -8) scale(.667)"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0" class="waves"/><circle cx="12" cy="19" r="1.6"/><path d="M4 3 20 21" class="slash"/></g>
  </g>` : ""}
  ${snap && (m.scene === "kill" || m.scene === "sprung") ? `
  <g class="snap-text" transform="translate(172 36) rotate(-10)">
    <path class="burst" d="M-26 0-19-6-22-14-12-11-6-19 0-12 8-18 11-9 21-10 17-2 26 2 17 6 20 14 10 12 5 19 0 12-7 18-10 10-20 12-16 4Z"/>
    <text text-anchor="middle" y="4.5">SNAP!</text>
  </g>` : ""}
</svg>`;
  }

  // ---------------------------------------------------------------------------
  // Tile rendering
  // ---------------------------------------------------------------------------

  function metric(key, entity, icon, value, label, cls, extra = "") {
    return `
      <div class="metric m-${key} ${cls}" data-entity="${esc(entity)}" role="button" tabindex="0" title="${esc(entity)}" aria-label="${esc(label)}: ${esc(value)}">
        <div class="m-icon">${icon}</div>
        <div class="m-text"><div class="m-value">${value}${extra}</div><div class="m-label">${esc(label)}</div></div>
      </div>`;
  }

  function renderMetrics(m, uid, flags) {
    const out = [];
    const missing = (k) => m.missing.includes(m.entities[k]);
    for (const k of m.configured) {
      const e = m.entities[k];
      if (missing(k)) {
        out.push(metric(k, e, ICONS.wifiOff, DASH, METRIC_LABELS[k], "is-missing"));
        continue;
      }
      switch (k) {
        case "strikes": {
          const v = m.strikes === null ? DASH : fmtNum(m.strikes);
          const plus = flags.strikesFrom !== null ? `<span class="plus">+${fmtNum(m.strikes - flags.strikesFrom)}</span>` : "";
          const counted = flags.strikesFrom !== null ? ` data-count-from="${flags.strikesFrom}" data-count-to="${m.strikes}"` : "";
          out.push(metric(k, e, ICONS.mouseHead, `<span class="count"${counted}>${v}</span>`, "Strikes", flags.strikesFrom !== null ? "bump" : "", plus));
          break;
        }
        case "battery":
          out.push(metric(k, e, batteryIcon(m.battery), esc(m.battery.text || DASH), "Battery", m.battery.low ? "is-warn" : m.battery.text ? "" : "is-dim"));
          break;
        case "bait":
          out.push(metric(k, e, cheeseIcon(m.bait, uid), esc(m.bait.text || DASH), "Bait", m.bait.empty ? "is-bad" : m.bait.low ? "is-warn" : m.bait.text ? "" : "is-dim"));
          break;
        case "kill":
          out.push(metric(k, e, m.kill === false ? ICONS.check : ICONS.bell, m.kill === null ? DASH : m.kill ? "Caught!" : "Clear", "Catch", m.kill ? "is-bad" : m.kill === false ? "is-good" : "is-dim"));
          break;
        case "rearm":
          out.push(metric(k, e, m.rearm === false ? ICONS.shield : ICONS.rearm, m.rearm === null ? DASH : m.rearm ? "Re-arm" : "Armed", "Trap", m.rearm ? "is-warn" : m.rearm === false ? "is-good" : "is-dim"));
          break;
        case "online": {
          const dot = `<span class="dot ${m.online ? "up" : m.online === false ? "down" : ""}" aria-hidden="true"><span></span></span>`;
          out.push(metric(k, e, dot, m.online === null ? DASH : m.online ? "Online" : "Offline", "Link", m.online === false ? "is-off" : m.online ? "" : "is-dim"));
          break;
        }
      }
    }
    return out.join("");
  }

  const METRIC_LABELS = { strikes: "Strikes", battery: "Battery", bait: "Bait", kill: "Catch", rearm: "Trap", online: "Link" };

  function renderBanner(m) {
    const since = (iso) => (iso ? ` \u00b7 <span class="since" data-since="${esc(iso)}">${relTime(iso)}</span>` : "");
    if (m.kill === true) {
      return `<div class="banner b-kill" data-entity="${esc(m.entities.kill)}" role="button" tabindex="0">
        ${ICONS.bell}<div><div class="b-title">Catch detected${since(m.since.kill)}</div><div class="b-sub">Empty the trap and re-arm it.</div></div></div>`;
    }
    if (m.rearm === true) {
      return `<div class="banner b-rearm" data-entity="${esc(m.entities.rearm)}" role="button" tabindex="0">
        ${ICONS.rearm}<div><div class="b-title">Trap sprung${since(m.since.rearm)}</div><div class="b-sub">Check the trap and set it again.</div></div></div>`;
    }
    if (m.online === false) {
      return `<div class="banner b-offline"${m.entities.online ? ` data-entity="${esc(m.entities.online)}" role="button" tabindex="0"` : ""}>
        ${ICONS.wifiOff}<div><div class="b-title">Not reporting${since(m.since.online)}</div><div class="b-sub">Check power and signal.</div></div></div>`;
    }
    return "";
  }

  function renderTile(m, cfg, flags) {
    const uid = `rt${m.index}`;
    const sceneAttrs = m.primary ? ` data-entity="${esc(m.primary)}"` : "";
    const scene = cfg.show_scene ? `<div class="scene-wrap"${sceneAttrs}>${sceneSvg(m, uid, flags.snap)}</div>` : "";
    const body = m.configured.length
      ? `${renderBanner(m)}<div class="metrics">${renderMetrics(m, uid, flags)}</div>`
      : `<div class="hint">No sensors yet. Edit this card and pick entities for strikes, battery, catch alert, bait, connectivity or re-arm.</div>`;
    const missing = m.missing.length
      ? `<div class="hint warn">Entity not found: ${m.missing.map((e) => `<code>${esc(e)}</code>`).join(", ")}</div>`
      : "";
    const head = m.primary ? ` data-entity="${esc(m.primary)}" role="button" tabindex="0"` : "";
    return `
      <div class="tile-head"${head}>
        <div class="titles">
          <div class="name">${esc(m.name)}</div>
          ${m.location ? `<div class="loc">${esc(m.location)}</div>` : ""}
        </div>
        <span class="chip s-${m.status}"><span class="chip-dot"></span>${esc(m.label)}</span>
      </div>
      <div class="tile-body${cfg.show_scene ? " has-scene" : ""}">
        ${scene}
        <div class="info">${body}${missing}</div>
      </div>`;
  }

  function renderSummary(models) {
    const count = (s) => models.filter((m) => m.status === s).length;
    const chips = [];
    const push = (n, cls, text) => n && chips.push(`<span class="chip s-${cls}"><span class="chip-dot"></span>${n} ${text}</span>`);
    push(count("kill"), "kill", count("kill") === 1 ? "catch" : "catches");
    push(count("rearm"), "rearm", "to re-arm");
    push(count("offline"), "offline", "offline");
    push(count("warn"), "warn", count("warn") === 1 ? "needs attention" : "need attention");
    if (!chips.length && models.length) {
      chips.push(`<span class="chip s-ok"><span class="chip-dot"></span>${models.every((m) => m.status === "ok") ? "All clear" : "No alerts"}</span>`);
    }
    const strikes = models.filter((m) => m.strikes !== null);
    if (strikes.length) {
      const total = strikes.reduce((a, m) => a + m.strikes, 0);
      chips.push(`<span class="chip total" title="Total strikes across all traps">${ICONS.mouseHead}${fmtNum(total)}</span>`);
    }
    return chips.join("");
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const STYLES = `
:host {
  --rt-ok: var(--success-color, #43a047);
  --rt-warn: var(--warning-color, #ffa600);
  --rt-bad: var(--error-color, #db4437);
  --rt-off: var(--disabled-text-color, #9e9e9e);
  --rt-info: var(--info-color, #039be5);
  --rt-text: var(--primary-text-color, #212121);
  --rt-text2: var(--secondary-text-color, #727272);
  --rt-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
  --rt-wood: #d6a064;
  --rt-wood-edge: #a8703a;
  --rt-grain: rgba(110, 62, 18, 0.28);
  --rt-metal: #8c96a1;
  --rt-metal-hi: #c9d0d7;
  --rt-cheese: #f7c948;
  --rt-cheese-dark: #dea41f;
  --rt-fur: #a4abb4;
  --rt-fur-hi: #d3d8de;
  --rt-pink: #f1a2b0;
  --rt-eye: #26282b;
  display: block;
}
ha-card:not(:defined) {
  display: block;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
  box-shadow: var(--ha-card-box-shadow, none);
  color: var(--rt-text);
}
ha-card { overflow: hidden; }
.wrap { padding: 0 0 12px; }
.header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 16px 16px 12px; }
.title { display: flex; align-items: center; gap: 10px; font-size: var(--ha-card-header-font-size, 22px); font-weight: 400; line-height: 1.2; color: var(--ha-card-header-color, var(--rt-text)); min-width: 0; }
.title .ic-mouse { width: 30px; height: 30px; flex: none; animation: wiggle 7s ease-in-out infinite; transform-origin: 50% 90%; }
.summary { display: flex; flex-wrap: wrap; gap: 6px; }
.grid { display: grid; gap: 12px; padding: 0 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr)); }
.header + .grid { padding-top: 0; }
.wrap.headless .grid { padding-top: 12px; }

.chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; white-space: nowrap;
  background: color-mix(in srgb, var(--c, var(--rt-off)) 15%, transparent); color: var(--rt-text); }
.chip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c, var(--rt-off)); flex: none; }
.chip.total { --c: var(--rt-text2); gap: 4px; padding-left: 6px; }
.chip.total .ic { width: 18px; height: 18px; }
.s-ok { --c: var(--rt-ok); }
.s-warn { --c: var(--rt-warn); }
.s-rearm { --c: var(--rt-warn); }
.s-kill { --c: var(--rt-bad); }
.s-offline { --c: var(--rt-off); }
.s-unknown { --c: var(--rt-off); }
.chip.s-kill .chip-dot { position: relative; }
.chip.s-kill .chip-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--c); animation: ping 1.4s ease-out infinite; }

.tile { position: relative; border-radius: 14px; border: 1px solid var(--rt-divider); overflow: hidden; container-type: inline-size;
  background: color-mix(in srgb, var(--rt-text) 2.5%, transparent); transition: border-color .4s, background-color .4s; }
.tile::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--c, transparent); transition: background-color .4s; }
.tile.s-ok::before, .tile.s-unknown::before { background: transparent; }
.tile.s-kill { border-color: color-mix(in srgb, var(--rt-bad) 55%, transparent); background: color-mix(in srgb, var(--rt-bad) 6%, transparent); animation: alarm 2.2s ease-in-out infinite; }
.tile.s-rearm { border-color: color-mix(in srgb, var(--rt-warn) 55%, transparent); }
.tile.s-offline .tile-body { opacity: .82; }

.tile-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 12px 12px 0 16px; cursor: pointer; outline: none; }
.titles { min-width: 0; }
.name { font-size: 16px; font-weight: 500; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loc { font-size: 12.5px; color: var(--rt-text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tile-body { display: grid; grid-template-columns: 1fr; align-items: center; }
.scene-wrap { height: 104px; padding: 0 8px; }
.scene-wrap[data-entity] { cursor: pointer; }
.scene { width: 100%; height: 100%; display: block; overflow: hidden; }
.info { padding: 4px 12px 12px 16px; min-width: 0; }
.tile-body.has-scene .info { padding-top: 0; }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
@container (min-width: 380px) {
  .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container (min-width: 660px) {
  .tile-body.has-scene { grid-template-columns: minmax(280px, 45%) 1fr; }
  .tile-body.has-scene .info { padding: 8px 12px 12px 0; }
  .scene-wrap { height: 140px; }
}

.metric { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 9px; border-radius: 10px; cursor: pointer; outline: none;
  background: color-mix(in srgb, var(--rt-text) 5%, transparent); transition: background-color .3s, transform .15s; }
.metric:hover { background: color-mix(in srgb, var(--rt-text) 9%, transparent); }
.metric:focus-visible, .tile-head:focus-visible, .banner:focus-visible { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }
.metric:active { transform: scale(.97); }
.m-icon { width: 26px; height: 22px; display: grid; place-items: center; flex: none; }
.m-icon .ic { width: 24px; height: 22px; }
.m-text { min-width: 0; }
.m-value { font-size: 15px; font-weight: 600; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.m-label { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--rt-text2); line-height: 1.3; }
.metric.is-warn { background: color-mix(in srgb, var(--rt-warn) 16%, transparent); }
.metric.is-bad { background: color-mix(in srgb, var(--rt-bad) 15%, transparent); }
.metric.is-off { background: color-mix(in srgb, var(--rt-off) 18%, transparent); }
.metric.is-dim .m-value, .metric.is-missing .m-value { color: var(--rt-text2); }
.metric.is-dim .m-icon { filter: grayscale(1); opacity: .45; }
.metric.is-missing { outline: 1px dashed color-mix(in srgb, var(--rt-bad) 60%, transparent); outline-offset: -1px; }
.metric.is-missing .ic { stroke: var(--rt-bad); fill: var(--rt-bad); }
.plus { position: absolute; right: 8px; top: 2px; font-size: 12px; font-weight: 700; color: var(--rt-bad); animation: float-up 1.8s ease-out both; pointer-events: none; }
.metric.bump { animation: bump .6s cubic-bezier(.3, 1.8, .5, 1); }

/* metric icons */
.ic { display: block; }
.ic-mouse .fur { fill: var(--rt-fur); }
.ic-mouse .pink { fill: var(--rt-pink); }
.ic-mouse .eye { fill: var(--rt-eye); }
.ic-batt .shell { fill: none; stroke: var(--rt-text2); stroke-width: 1.6; }
.ic-batt .nub { fill: var(--rt-text2); }
.ic-batt .charge { fill: var(--rt-ok); transition: width .6s ease; }
.is-warn .ic-batt .charge { fill: var(--rt-bad); animation: blink 1.2s steps(2, jump-none) infinite; }
.ic-cheese .ghost { fill: none; stroke: var(--rt-cheese-dark); stroke-width: 1.2; stroke-dasharray: 2 1.6; stroke-linejoin: round; }
.ic-cheese .wedge { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: 1.2; stroke-linejoin: round; }
.ic-cheese .hole { fill: var(--rt-cheese-dark); }
.ic-bell { fill: var(--rt-bad); }
.is-bad .ic-bell { animation: ring 1.6s ease-in-out infinite; transform-origin: 50% 12%; }
.ic-check circle { fill: var(--rt-ok); }
.ic-check .tick, .ic-armed .tick { fill: none; stroke: #fff; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.ic-armed path:first-child { fill: var(--rt-ok); }
.ic-rearm { fill: var(--rt-warn); }
.is-warn .ic-rearm { animation: spin 2.8s linear infinite; }
.ic-wifi-off { fill: var(--rt-off); }
.ic-wifi-off .waves, .ic-wifi-off .slash { fill: none; stroke: var(--rt-off); stroke-width: 2; stroke-linecap: round; }
.dot { position: relative; width: 12px; height: 12px; border-radius: 50%; background: var(--rt-off); }
.dot.up { background: var(--rt-ok); }
.dot.up span { position: absolute; inset: 0; border-radius: 50%; background: var(--rt-ok); animation: ping 2.4s cubic-bezier(0, 0, .2, 1) infinite; }
.dot.down { background: transparent; border: 2px solid var(--rt-off); box-sizing: border-box; }

/* banners */
.banner { display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 8px; border-radius: 10px; cursor: pointer; outline: none; }
.banner .ic { width: 22px; height: 22px; flex: none; }
.b-title { font-size: 13.5px; font-weight: 600; }
.b-sub { font-size: 12px; color: var(--rt-text2); }
.since { font-weight: 400; color: var(--rt-text2); }
.b-kill { background: color-mix(in srgb, var(--rt-bad) 16%, transparent); }
.b-kill .ic-bell { animation: ring 1.6s ease-in-out infinite; transform-origin: 50% 12%; }
.b-rearm { background: color-mix(in srgb, var(--rt-warn) 18%, transparent); }
.b-rearm .ic-rearm { animation: spin 2.8s linear infinite; }
.b-offline { background: color-mix(in srgb, var(--rt-off) 18%, transparent); cursor: default; }
.b-offline[data-entity] { cursor: pointer; }
.hint { font-size: 12.5px; color: var(--rt-text2); padding: 6px 0 2px; }
.hint.warn { color: var(--rt-bad); }
.hint code { font-size: 11.5px; }
.empty { padding: 8px 16px 8px; color: var(--rt-text2); font-size: 14px; }

/* scene */
.scene .glow-in { stop-color: var(--rt-bad); stop-opacity: .38; }
.scene .glow-out { stop-color: var(--rt-bad); stop-opacity: 0; }
.scene .glow { opacity: 0; }
.st-kill .glow { opacity: 1; animation: glow 1.8s ease-in-out infinite; }
.scene .shadow { fill: #000; opacity: .12; }
.scene .floor { stroke: var(--rt-divider); stroke-width: 1; }
.scene .wood { fill: var(--rt-wood); }
.scene .wood-edge { fill: var(--rt-wood-edge); }
.scene .wood-hi { stroke: rgba(255, 255, 255, .35); stroke-width: 1; }
.scene .grain { stroke: var(--rt-grain); stroke-width: .9; stroke-linecap: round; fill: none; }
.scene .plate { fill: var(--rt-metal-hi); stroke: var(--rt-metal); stroke-width: .8; }
.scene .cheese { transform-box: fill-box; transform-origin: 50% 100%; transition: transform .8s cubic-bezier(.3, 1.4, .5, 1); }
.scene .wedge { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: 1; stroke-linejoin: round; }
.scene .hole { fill: var(--rt-cheese-dark); }
.scene .crumbs { fill: var(--rt-cheese-dark); }
.scene .staple, .scene .holddown { fill: none; stroke: var(--rt-metal); stroke-width: 1.6; stroke-linecap: round; }
.scene .holddown { stroke-width: 1.3; }
.scene .bar { transform-box: fill-box; transform-origin: 0% 100%; transform: rotate(-174deg); transition: transform .35s cubic-bezier(.5, 0, .75, 0); }
.scene .bar path { fill: none; stroke: var(--rt-metal); stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }
.st-kill .bar { transform: rotate(-12deg); }
.st-sprung .bar { transform: rotate(0deg); }
.snap-now.st-kill .bar { animation: snap-kill .5s cubic-bezier(.55, 0, .7, .4) both; }
.snap-now.st-sprung .bar { animation: snap-empty .5s cubic-bezier(.55, 0, .7, .4) both; }
.snap-now .stage { animation: shake .5s .28s ease-out both; }
.snap-now .victim { animation: fade-in .12s .27s both; }
.scene .spring { fill: var(--rt-metal-hi); stroke: var(--rt-metal); stroke-width: 1.4; }
.scene .spring-in { fill: var(--rt-metal); }

.scene .mouse .fur { fill: var(--rt-fur); }
.scene .mouse .belly { fill: var(--rt-fur-hi); }
.scene .mouse .pink { fill: var(--rt-pink); }
.scene .mouse .eye { fill: var(--rt-eye); }
.scene .mouse .glint { fill: #fff; }
.scene .mouse .x-eye { stroke: var(--rt-eye); stroke-width: 1.3; stroke-linecap: round; fill: none; }
.scene .mouse .tail { fill: none; stroke: var(--rt-pink); stroke-width: 2; stroke-linecap: round; }
.scene .mouse .whiskers { fill: none; stroke: var(--rt-text2); stroke-width: .55; stroke-linecap: round; opacity: .8; }
.st-armed .mouse { animation: peek 12s ease-in-out infinite; }
.st-armed .mouse .tail { transform-box: fill-box; transform-origin: 0% 70%; animation: sway 1.4s ease-in-out infinite alternate; }
.st-armed .mouse .nose { transform-box: fill-box; transform-origin: 50% 50%; animation: sniff .38s ease-in-out infinite alternate; }
.st-armed .mouse .whiskers { transform-box: fill-box; transform-origin: 100% 40%; animation: twitch .38s ease-in-out infinite alternate; }
.st-armed .mouse .eye { transform-box: fill-box; transform-origin: 50% 50%; animation: blink-eye 4.2s infinite; }
.scene .star { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: .6; }
.scene .orbit { transform-box: fill-box; transform-origin: 50% 50%; animation: spin 2.6s linear infinite; }
.st-offline .stage { filter: grayscale(1); opacity: .5; }
.st-idle .stage { opacity: .7; }
.scene .badge circle { stroke: none; }
.badge-rearm > circle { fill: color-mix(in srgb, var(--rt-warn) 22%, transparent); }
.badge-rearm path { fill: var(--rt-warn); }
.badge-rearm .spin { transform-box: fill-box; transform-origin: 50% 50%; animation: spin 3s linear infinite; }
.badge-offline > circle { fill: color-mix(in srgb, var(--rt-off) 22%, transparent); }
.badge-offline circle:not(:first-child) { fill: var(--rt-off); }
.badge-offline .waves, .badge-offline .slash { fill: none; stroke: var(--rt-off); stroke-width: 2.2; stroke-linecap: round; }
.badge-offline { animation: fade-pulse 2.4s ease-in-out infinite; }
.snap-text { opacity: 0; }
.snap-now .snap-text { animation: pop 1.9s .28s both; }
.snap-text .burst { fill: var(--rt-cheese); stroke: var(--rt-bad); stroke-width: 1.2; stroke-linejoin: round; }
.snap-text text { font: 800 10px/1 system-ui, sans-serif; fill: var(--rt-bad); letter-spacing: .02em; }

/* motion */
@keyframes ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(2.6); opacity: 0; } }
@keyframes alarm { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--rt-bad) 35%, transparent); } 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--rt-bad) 0%, transparent); } }
@keyframes glow { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes ring { 0%, 55%, 100% { transform: rotate(0); } 10% { transform: rotate(16deg); } 20% { transform: rotate(-14deg); } 30% { transform: rotate(10deg); } 40% { transform: rotate(-6deg); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 50% { opacity: .25; } }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes float-up { 0% { opacity: 0; transform: translateY(6px); } 15% { opacity: 1; } 100% { opacity: 0; transform: translateY(-14px); } }
@keyframes wiggle { 0%, 88%, 100% { transform: rotate(0); } 91% { transform: rotate(-9deg); } 94% { transform: rotate(8deg); } 97% { transform: rotate(-4deg); } }
@keyframes peek {
  0%, 6% { transform: translateX(86px); }
  18% { transform: translateX(0); }
  23% { transform: translateX(-3px); }
  28% { transform: translateX(0); }
  33% { transform: translateX(-3px); }
  38% { transform: translateX(0); }
  52% { transform: translateX(-1px); }
  62% { transform: translateX(0); }
  74%, 100% { transform: translateX(86px); }
}
@keyframes sway { from { transform: rotate(-7deg); } to { transform: rotate(9deg); } }
@keyframes sniff { from { transform: scale(1); } to { transform: scale(1.25); } }
@keyframes twitch { from { transform: rotate(-5deg); } to { transform: rotate(5deg); } }
@keyframes blink-eye { 0%, 94%, 100% { transform: scaleY(1); } 97% { transform: scaleY(.1); } }
@keyframes snap-kill { 0% { transform: rotate(-174deg); } 70% { transform: rotate(-4deg); } 85% { transform: rotate(-16deg); } 100% { transform: rotate(-12deg); } }
@keyframes snap-empty { 0% { transform: rotate(-174deg); } 70% { transform: rotate(3deg); } 85% { transform: rotate(-5deg); } 100% { transform: rotate(0deg); } }
@keyframes shake { 0%, 100% { transform: translate(0, 0); } 15% { transform: translate(-3px, 1px); } 30% { transform: translate(3px, -1px); } 45% { transform: translate(-2px, 1px); } 60% { transform: translate(2px, 0); } 80% { transform: translate(-1px, 0); } }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fade-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@keyframes pop { 0% { opacity: 0; transform: translate(172px, 36px) rotate(-10deg) scale(.2); } 12% { opacity: 1; transform: translate(172px, 36px) rotate(-10deg) scale(1.25); } 22% { transform: translate(172px, 36px) rotate(-10deg) scale(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: translate(172px, 36px) rotate(-10deg) scale(1); } }

.paused *, .paused *::before, .paused *::after { animation-play-state: paused !important; }
.no-anim *, .no-anim *::before, .no-anim *::after { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

  // ---------------------------------------------------------------------------
  // Card
  // ---------------------------------------------------------------------------

  function normalizeConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    let traps = config.traps;
    if (traps === undefined || traps === null) {
      // Single-trap shorthand: entity keys directly on the card.
      if (!METRIC_KEYS.some((k) => config[k])) {
        throw new Error("Add at least one trap under `traps:` (see the Rodent Trap Card README).");
      }
      traps = [Object.fromEntries(TRAP_KEYS.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]))];
    }
    if (!Array.isArray(traps)) throw new Error("`traps` must be a list.");
    traps.forEach((t, i) => {
      if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`traps[${i}] must be a mapping of options.`);
      for (const k of METRIC_KEYS) {
        if (t[k] !== undefined && t[k] !== null && t[k] !== "" && !normalizeRef(t[k])) {
          throw new Error(`traps[${i}].${k} must be an entity id or { entity: ... }.`);
        }
      }
    });
    return { ...CARD_DEFAULTS, ...config, traps };
  }

  class RodentTrapCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._tiles = [];
      this._summarySig = null;
      this._order = "";
      this._onClick = this._onClick.bind(this);
      this._onKey = this._onKey.bind(this);
    }

    static getConfigElement() {
      return document.createElement(EDITOR_TAG);
    }

    static getStubConfig(hass) {
      return { type: `custom:${CARD_TAG}`, title: "Rodent Traps", traps: discoverTraps(hass) };
    }

    setConfig(config) {
      this._config = normalizeConfig(config);
      this._build();
      if (this._hass) this._update();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._config) this._update();
    }

    get hass() {
      return this._hass;
    }

    getCardSize() {
      const n = (this._config && this._config.traps.length) || 1;
      return 1 + n * (this._config && this._config.show_scene === false ? 2 : 4);
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6 };
    }

    getLayoutOptions() {
      return { grid_columns: 4, grid_min_columns: 2 };
    }

    connectedCallback() {
      this._timer = setInterval(() => this._refreshTimes(), 30000);
      if ("IntersectionObserver" in window && !this._io) {
        this._io = new IntersectionObserver((entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          if (this._root) this._root.classList.toggle("paused", !visible);
        });
        this._io.observe(this);
      }
    }

    disconnectedCallback() {
      clearInterval(this._timer);
      if (this._io) {
        this._io.disconnect();
        this._io = null;
      }
    }

    _build() {
      const cfg = this._config;
      const showHeader = !!cfg.title || cfg.show_summary;
      this.shadowRoot.innerHTML = `
        <style>${STYLES}</style>
        <ha-card>
          <div class="wrap${cfg.animations === false ? " no-anim" : ""}${showHeader ? "" : " headless"}">
            ${showHeader ? `
            <div class="header">
              <div class="title">${cfg.title ? `${ICONS.mouseHead}<span>${esc(cfg.title)}</span>` : ""}</div>
              ${cfg.show_summary ? `<div class="summary" aria-live="polite"></div>` : ""}
            </div>` : ""}
            <div class="grid"></div>
          </div>
        </ha-card>`;
      this._root = this.shadowRoot.querySelector(".wrap");
      this._grid = this.shadowRoot.querySelector(".grid");
      this._summary = this.shadowRoot.querySelector(".summary");
      const cols = toNum(cfg.columns, 0);
      if (cols > 0) this._grid.style.gridTemplateColumns = `repeat(${Math.round(cols)}, minmax(0, 1fr))`;
      this._grid.addEventListener("click", this._onClick);
      this._grid.addEventListener("keydown", this._onKey);
      this._tiles = cfg.traps.map(() => {
        const el = document.createElement("div");
        el.className = "tile";
        return { el, sig: null, model: null };
      });
      this._summarySig = null;
      this._order = "";
      if (!cfg.traps.length) {
        this._grid.outerHTML = `<div class="empty">No traps configured yet.</div>`;
        this._grid = null;
      }
    }

    _update() {
      const cfg = this._config;
      if (!this._grid) return;
      const models = cfg.traps.map((t, i) => buildModel(this._hass, t, cfg, i));

      models.forEach((m, i) => {
        const tile = this._tiles[i];
        const sig = JSON.stringify(m);
        if (sig === tile.sig) return;
        const prev = tile.model;
        const flags = {
          snap: !!prev && !["kill", "sprung"].includes(prev.scene) && ["kill", "sprung"].includes(m.scene),
          strikesFrom: prev && prev.strikes !== null && m.strikes !== null && m.strikes > prev.strikes ? prev.strikes : null,
        };
        tile.el.className = `tile s-${m.status}`;
        tile.el.innerHTML = renderTile(m, cfg, flags);
        tile.sig = sig;
        tile.model = m;
        if (flags.strikesFrom !== null) this._countUp(tile.el);
      });

      const order = this._sorted(models).map((m) => m.index);
      const orderKey = order.join(",");
      if (orderKey !== this._order) {
        this._order = orderKey;
        const current = Array.from(this._grid.children);
        order.forEach((idx, pos) => {
          const el = this._tiles[idx].el;
          if (current[pos] !== el) this._grid.insertBefore(el, this._grid.children[pos] || null);
        });
      }

      if (this._summary) {
        const html = renderSummary(models);
        if (html !== this._summarySig) {
          this._summary.innerHTML = html;
          this._summarySig = html;
        }
      }
    }

    _sorted(models) {
      const list = models.slice();
      if (this._config.sort === "status") {
        list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.index - b.index);
      } else if (this._config.sort === "name") {
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.index - b.index);
      }
      return list;
    }

    _countUp(tileEl) {
      const el = tileEl.querySelector(".count[data-count-from]");
      if (!el || this._config.animations === false) return;
      const from = Number(el.dataset.countFrom);
      const to = Number(el.dataset.countTo);
      if (!(to > from) || !Number.isInteger(to) || to - from > 500) return;
      const start = performance.now();
      const dur = 900;
      const step = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = String(Math.round(from + (to - from) * eased));
        if (p < 1 && el.isConnected) requestAnimationFrame(step);
      };
      el.textContent = String(from);
      requestAnimationFrame(step);
    }

    _refreshTimes() {
      this.shadowRoot.querySelectorAll("[data-since]").forEach((el) => {
        el.textContent = relTime(el.dataset.since);
      });
    }

    _onClick(ev) {
      const target = ev.composedPath().find((n) => n instanceof HTMLElement && n.dataset && n.dataset.entity);
      if (!target || !target.dataset.entity) return;
      ev.stopPropagation();
      this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: target.dataset.entity } }));
    }

    _onKey(ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      if (!(ev.target instanceof HTMLElement) || !ev.target.dataset.entity) return;
      ev.preventDefault();
      this._onClick(ev);
    }
  }

  /** Build a starter config from entities whose ids mention a trap. */
  function discoverTraps(hass) {
    const roles = [
      ["battery", /batt/],
      ["strikes", /(total_kills|kill_count|kills_total|strikes?|catches|catch_count|count)/],
      ["kill", /(kills?_present|kill|catch|caught|captured|occupied|triggered|alarm|alert)/],
      ["bait", /(bait|cheese|lure)/],
      ["rearm", /(re_?arm|armed|sprung|reset|set_state)/],
      ["online", /(online|connect|wireless|signal|rssi|status|available|link)/],
    ];
    const domains = new Set(["sensor", "binary_sensor", "counter", "input_number", "number", "input_boolean", "input_select", "select", "device_tracker"]);
    const groups = new Map();
    const ids = hass && hass.states ? Object.keys(hass.states) : [];
    for (const id of ids) {
      const [domain, obj = ""] = id.split(".");
      if (!domains.has(domain)) continue;
      const match = obj.match(/^(.*?(?:trap|smart_kill|mousetrap|rodent)[a-z]*(?:_\d+)?)/);
      if (!match) continue;
      const role = roles.find(([, re]) => re.test(obj.slice(match[1].length)) || re.test(obj));
      if (!role) continue;
      const key = match[1];
      if (!groups.has(key)) groups.set(key, { name: titleCase(key) });
      const trap = groups.get(key);
      if (!trap[role[0]]) trap[role[0]] = id;
      if (groups.size >= 6) break;
    }
    const traps = Array.from(groups.values()).slice(0, 4);
    return traps.length ? traps : [{ name: "Garage", location: "Behind the freezer" }];
  }

  // ---------------------------------------------------------------------------
  // Visual editor
  // ---------------------------------------------------------------------------

  const EDITOR_LABELS = {
    title: "Title",
    show_summary: "Show summary chips",
    show_scene: "Show trap illustrations",
    animations: "Animations",
    sort: "Order traps by",
    columns: "Columns (blank = automatic)",
    battery_low: "Low battery at or below (%)",
    bait_low: "Low bait at or below (%)",
    name: "Name",
    location: "Location",
    strikes: "Strikes (count sensor)",
    battery: "Battery",
    kill: "Catch / kill alert",
    bait: "Bait remaining",
    online: "Online / connectivity",
    rearm: "Needs re-arm",
  };

  const EDITOR_HELPERS = {
    strikes: "Total catches or trigger count.",
    battery: "Percentage sensor, or a binary battery sensor (on = low).",
    kill: "Binary sensor (on = caught), or a sensor whose value > 0 / \u201ccaught\u201d.",
    bait: "Percentage, input_number/number with min\u2013max, words like \u201chalf\u201d, or a binary sensor (on = low).",
    online: "Connectivity binary sensor. Leave blank to infer from the other entities' availability.",
    rearm: "Binary sensor (on = needs re-arming) or a status sensor like \u201csprung\u201d/\u201carmed\u201d.",
  };

  const entitySel = (domains) => ({ entity: { filter: { domain: domains } } });

  const GENERAL_SCHEMA = [
    { name: "title", selector: { text: {} } },
    {
      name: "",
      type: "grid",
      schema: [
        {
          name: "sort",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "config", label: "Card order" },
                { value: "status", label: "Most urgent first" },
                { value: "name", label: "Name" },
              ],
            },
          },
        },
        { name: "columns", selector: { number: { min: 1, max: 6, mode: "box" } } },
      ],
    },
    {
      name: "",
      type: "grid",
      schema: [
        { name: "battery_low", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
        { name: "bait_low", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
      ],
    },
    {
      name: "",
      type: "grid",
      schema: [
        { name: "show_summary", selector: { boolean: {} } },
        { name: "show_scene", selector: { boolean: {} } },
        { name: "animations", selector: { boolean: {} } },
      ],
    },
  ];

  const TRAP_SCHEMA = [
    { name: "", type: "grid", schema: [{ name: "name", selector: { text: {} } }, { name: "location", selector: { text: {} } }] },
    { name: "kill", selector: entitySel(["binary_sensor", "sensor", "input_boolean", "switch"]) },
    { name: "rearm", selector: entitySel(["binary_sensor", "sensor", "input_boolean", "switch", "input_select", "select"]) },
    { name: "strikes", selector: entitySel(["sensor", "counter", "input_number", "number"]) },
    { name: "battery", selector: entitySel(["sensor", "binary_sensor"]) },
    { name: "bait", selector: entitySel(["sensor", "binary_sensor", "input_number", "number", "input_select", "select"]) },
    { name: "online", selector: entitySel(["binary_sensor", "sensor", "device_tracker"]) },
    {
      name: "",
      type: "grid",
      schema: [
        { name: "battery_low", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
        { name: "bait_low", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
      ],
    },
  ];

  let haFormPromise = null;
  function loadHaForm() {
    if (customElements.get("ha-form")) return Promise.resolve(true);
    if (!haFormPromise) {
      haFormPromise = (async () => {
        try {
          // Built-in card editors pull in ha-form and its selectors; borrow one to load them.
          const helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
          if (helpers) {
            helpers.createCardElement({ type: "tile", entity: "sun.sun" });
            await customElements.whenDefined("hui-tile-card");
            const Tile = customElements.get("hui-tile-card");
            if (Tile && Tile.getConfigElement) await Tile.getConfigElement();
          }
        } catch (e) {
          /* fall through to the timeout below */
        }
        await Promise.race([customElements.whenDefined("ha-form"), new Promise((r) => setTimeout(r, 5000))]);
        return !!customElements.get("ha-form");
      })();
    }
    return haFormPromise;
  }

  const EDITOR_STYLES = `
    :host { display: block; }
    .section-title { font-weight: 500; margin: 20px 0 8px; display: flex; align-items: center; justify-content: space-between; }
    details { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; margin-bottom: 10px; background: var(--card-background-color, transparent); }
    summary { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 12px; cursor: pointer; list-style: none; user-select: none; }
    summary::-webkit-details-marker { display: none; }
    summary .chev { width: 18px; height: 18px; fill: var(--secondary-text-color); transition: transform .2s; flex: none; }
    details[open] summary .chev { transform: rotate(90deg); }
    summary .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    summary .label small { font-weight: 400; color: var(--secondary-text-color); margin-left: 6px; }
    .body { padding: 0 12px 12px; }
    button { font: inherit; color: var(--primary-text-color); background: none; border: none; border-radius: 50%; width: 32px; height: 32px; display: grid; place-items: center; cursor: pointer; }
    button:hover:not(:disabled) { background: color-mix(in srgb, var(--primary-text-color) 8%, transparent); }
    button:disabled { opacity: .3; cursor: default; }
    button svg { width: 20px; height: 20px; fill: currentColor; }
    button.del { color: var(--error-color, #db4437); }
    button.add { width: auto; height: 36px; border-radius: 18px; padding: 0 16px 0 10px; display: inline-flex; gap: 6px; align-items: center; color: var(--primary-color, #03a9f4);
      border: 1px solid color-mix(in srgb, var(--primary-color, #03a9f4) 50%, transparent); font-weight: 500; }
    .note { color: var(--secondary-text-color); font-size: 13px; margin: 4px 0 10px; }
    .fallback { padding: 12px; color: var(--secondary-text-color); }
  `;

  const SVG_PATHS = {
    chev: "M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6-1.4-1.4Z",
    up: "M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6 1.4 1.4Z",
    down: "M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6 1.4-1.4Z",
    del: "M9 3v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3H9Zm-2 3h10v13H7V6Zm2 2v9h2V8H9Zm4 0v9h2V8h-2Z",
    add: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z",
  };
  const svgIcon = (name) => `<svg viewBox="0 0 24 24"><path d="${SVG_PATHS[name]}"/></svg>`;

  class RodentTrapCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._open = new Set([0]);
      this._forms = [];
      this._structure = null;
      this._ready = false;
    }

    connectedCallback() {
      loadHaForm().then((ok) => {
        this._ready = ok;
        this._failed = !ok;
        this._structure = null;
        this._render();
      });
    }

    set hass(hass) {
      this._hass = hass;
      if (this._general) this._general.hass = hass;
      this._forms.forEach((f) => (f.hass = hass));
    }

    setConfig(config) {
      this._config = { ...config, traps: Array.isArray(config.traps) ? config.traps : [] };
      this._render();
    }

    _render() {
      if (!this._config) return;
      if (!this._ready) {
        const msg = this._failed
          ? "The visual editor couldn't load Home Assistant's form components. Switch to the code editor to configure this card."
          : "Loading editor\u2026";
        this.shadowRoot.innerHTML = `<style>${EDITOR_STYLES}</style><div class="fallback">${msg}</div>`;
        return;
      }
      const traps = this._config.traps;
      const structure = String(traps.length);
      if (structure !== this._structure) {
        this._structure = structure;
        this._build();
      } else {
        this._general.data = this._generalData();
        traps.forEach((t, i) => {
          this._forms[i].data = this._trapData(t);
          this._setSummary(i);
        });
      }
    }

    _generalData() {
      const { traps, type, ...rest } = this._config;
      return { ...CARD_DEFAULTS, ...rest };
    }

    _trapData(trap) {
      const data = {};
      for (const k of TRAP_KEYS) {
        const v = trap[k];
        if (v === undefined || v === null) continue;
        data[k] = METRIC_KEYS.includes(k) && typeof v === "object" ? v.entity : v;
      }
      return data;
    }

    _build() {
      const root = this.shadowRoot;
      root.innerHTML = `<style>${EDITOR_STYLES}</style>`;

      this._general = document.createElement("ha-form");
      this._general.hass = this._hass;
      this._general.schema = GENERAL_SCHEMA;
      this._general.data = this._generalData();
      this._general.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._general.addEventListener("value-changed", (ev) => this._generalChanged(ev));
      root.appendChild(this._general);

      const heading = document.createElement("div");
      heading.className = "section-title";
      heading.textContent = "Traps";
      root.appendChild(heading);

      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Every entity is optional. The card only shows the readings you pick.";
      root.appendChild(note);

      this._forms = [];
      this._summaries = [];
      const traps = this._config.traps;
      traps.forEach((trap, i) => {
        const details = document.createElement("details");
        if (this._open.has(i)) details.open = true;
        details.addEventListener("toggle", () => (details.open ? this._open.add(i) : this._open.delete(i)));

        const summary = document.createElement("summary");
        summary.innerHTML = `${svgIcon("chev").replace("<svg", '<svg class="chev"')}<span class="label"></span>
          <button class="up" title="Move up" ${i === 0 ? "disabled" : ""}>${svgIcon("up")}</button>
          <button class="down" title="Move down" ${i === traps.length - 1 ? "disabled" : ""}>${svgIcon("down")}</button>
          <button class="del" title="Remove trap">${svgIcon("del")}</button>`;
        summary.querySelector(".up").addEventListener("click", (e) => this._move(e, i, -1));
        summary.querySelector(".down").addEventListener("click", (e) => this._move(e, i, 1));
        summary.querySelector(".del").addEventListener("click", (e) => this._remove(e, i));
        details.appendChild(summary);
        this._summaries[i] = summary.querySelector(".label");

        const body = document.createElement("div");
        body.className = "body";
        const form = document.createElement("ha-form");
        form.hass = this._hass;
        form.schema = TRAP_SCHEMA;
        form.data = this._trapData(trap);
        form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
        form.computeHelper = (s) => EDITOR_HELPERS[s.name];
        form.addEventListener("value-changed", (ev) => this._trapChanged(ev, i));
        body.appendChild(form);
        details.appendChild(body);
        this._forms[i] = form;
        root.appendChild(details);
        this._setSummary(i);
      });

      const add = document.createElement("button");
      add.className = "add";
      add.innerHTML = `${svgIcon("add")}<span>Add trap</span>`;
      add.addEventListener("click", () => this._add());
      root.appendChild(add);
    }

    _setSummary(i) {
      const t = this._config.traps[i] || {};
      const label = this._summaries[i];
      if (!label) return;
      label.innerHTML = `${esc(t.name || `Trap ${i + 1}`)}${t.location ? `<small>${esc(t.location)}</small>` : ""}`;
    }

    _generalChanged(ev) {
      ev.stopPropagation();
      const value = ev.detail.value || {};
      const next = { ...this._config };
      for (const key of ["title", "show_summary", "show_scene", "animations", "sort", "columns", "battery_low", "bait_low"]) {
        const v = value[key];
        if (v === undefined || v === null || v === "" || v === CARD_DEFAULTS[key]) delete next[key];
        else next[key] = v;
      }
      this._commit(next);
    }

    _trapChanged(ev, i) {
      ev.stopPropagation();
      const value = ev.detail.value || {};
      const original = this._config.traps[i] || {};
      const trap = { ...original };
      for (const k of TRAP_KEYS) {
        const v = value[k];
        const empty = v === undefined || v === null || v === "";
        if (METRIC_KEYS.includes(k) && original[k] && typeof original[k] === "object") {
          if (empty) delete trap[k];
          else trap[k] = { ...original[k], entity: v };
        } else if (empty) {
          delete trap[k];
        } else {
          trap[k] = v;
        }
      }
      const traps = this._config.traps.slice();
      traps[i] = trap;
      this._commit({ ...this._config, traps });
      this._setSummary(i);
    }

    _move(ev, i, dir) {
      ev.preventDefault();
      ev.stopPropagation();
      const j = i + dir;
      const traps = this._config.traps.slice();
      if (j < 0 || j >= traps.length) return;
      [traps[i], traps[j]] = [traps[j], traps[i]];
      const wasOpen = [this._open.has(i), this._open.has(j)];
      wasOpen[0] ? this._open.add(j) : this._open.delete(j);
      wasOpen[1] ? this._open.add(i) : this._open.delete(i);
      this._commit({ ...this._config, traps }, true);
    }

    _remove(ev, i) {
      ev.preventDefault();
      ev.stopPropagation();
      const traps = this._config.traps.filter((_, idx) => idx !== i);
      this._open = new Set(Array.from(this._open).filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
      this._commit({ ...this._config, traps }, true);
    }

    _add() {
      const traps = this._config.traps.concat([{ name: `Trap ${this._config.traps.length + 1}` }]);
      this._open.add(traps.length - 1);
      this._commit({ ...this._config, traps }, true);
    }

    _commit(config, rebuild = false) {
      this._config = config;
      if (rebuild) {
        this._structure = null;
        this._render();
      }
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, RodentTrapCard);
  if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, RodentTrapCardEditor);

  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: "Rodent Trap Card",
      description: "Status of smart rodent traps: catches, strikes, battery, bait, connectivity and re-arming.",
      preview: true,
      documentationURL: "https://github.com/kedube/ha-rodent-traps",
    });
  }

  console.info(
    `%c RODENT-TRAP-CARD %c v${VERSION} `,
    "color:#fff;background:#a8703a;font-weight:700;border-radius:3px 0 0 3px",
    "color:#a8703a;background:#f7c948;font-weight:700;border-radius:0 3px 3px 0"
  );
})();

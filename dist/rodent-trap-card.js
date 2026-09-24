/*!
 * Rodent Trap Card - a Home Assistant dashboard card for smart rodent traps.
 * https://github.com/kedube/ha-rodent-traps
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(() => {
  "use strict";

  const VERSION = "1.1";
  const CARD_TAG = "rodent-trap-card";
  const EDITOR_TAG = "rodent-trap-card-editor";

  // Entity roles a trap can fill.
  const ROLE_KEYS = ["kill", "armed", "rearm", "strikes", "last_strike", "battery", "bait", "online", "last_seen"];
  const TRAP_KEYS = ["device", "name", "location", "style", ...ROLE_KEYS, "holds", "actions", "battery_low", "bait_low", "stale_after", "offline_after"];
  const TRAP_STYLES = ["snap", "goodnature", "station"];
  // Readings on a tile, in display order. "trap" combines armed + rearm, "link" combines online + last_seen.
  const METRIC_ORDER = ["strikes", "last_strike", "battery", "bait", "kill", "trap", "link"];
  const HOLD_KEYS = { kill: "kill", catch: "kill", trap: "trap", armed: "trap", rearm: "trap", strikes: "strikes", last_strike: "last_strike", battery: "battery", bait: "bait", link: "link", online: "link", last_seen: "link" };
  const HOLD_MS = 550;

  const CARD_DEFAULTS = {
    title: "",
    show_summary: true,
    show_scene: true,
    animations: true,
    sort: "config",
    style: "snap",
    battery_low: 20,
    bait_low: 25,
  };

  // ---------------------------------------------------------------------------
  // Helpers
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
    armed: {
      on: wordSet("on true yes armed set ready active primed"),
      off: wordSet("off false no disarmed unarmed unset sprung snapped triggered tripped fired inactive"),
    },
    online: {
      on: wordSet("on true yes online connected available home ok ready alive up awake asleep sleeping"),
      off: wordSet("off false no offline disconnected not_home away lost down dead unreachable failed"),
    },
    low: {
      on: wordSet("on true yes low due critical replace needed required empty"),
      off: wordSet("off false no ok normal good full fine"),
    },
  };

  const LEVEL_WORDS = new Map(Object.entries({
    full: 100, fresh: 100, high: 90, plenty: 90, good: 75, ok: 75, normal: 75,
    medium: 50, half: 50, moderate: 50, low: 15, very_low: 5, critical: 5,
    empty: 0, none: 0, depleted: 0, out: 0, gone: 0,
  }));

  const UNKNOWN_STATES = new Set(["unknown", "unavailable", ""]);
  const DASH = "\u2014";
  const DOT = "\u00b7";

  const DURATION_SECONDS = {
    ms: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400,
    w: 604800, wk: 604800, week: 604800, weeks: 604800, mo: 2629800, month: 2629800, months: 2629800,
  };
  const DISPLAY_UNITS = [["mo", 2629800], ["wk", 604800], ["d", 86400], ["h", 3600], ["min", 60], ["s", 1]];

  const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, "_");
  const slug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toNum = (v, fallback) => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const titleCase = (v) => String(v).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const isEntityId = (v) => typeof v === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(v.trim());
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** An entity reference is "sensor.x" or { entity, attribute?, invert?, active_states?, min?, max?, unit?, display_unit?, low_entity? }. */
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
    return { ref, stateObj, raw, domain: ref.entity.split(".")[0], missing: false, dead, unknown, since: stateObj.last_changed || null };
  }

  /** A number, or the numeric state of an entity id. */
  function resolveNum(hass, v, fallback) {
    if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
    if (isEntityId(v)) {
      const st = hass && hass.states ? hass.states[v.trim()] : undefined;
      return st ? toNum(st.state, fallback) : fallback;
    }
    return toNum(v, fallback);
  }

  /** Accepts hours as a number, "90m" / "12h" / "2d" / "1w" / "1:30:00", or { days, hours, minutes, seconds }. Returns ms. */
  function parseDuration(v) {
    if (v === null || v === undefined || v === "" || v === false) return null;
    if (typeof v === "number") return v > 0 ? v * 3600000 : null;
    if (typeof v === "object") {
      const secs = toNum(v.days, 0) * 86400 + toNum(v.hours, 0) * 3600 + toNum(v.minutes, 0) * 60 + toNum(v.seconds, 0);
      return secs > 0 ? secs * 1000 : null;
    }
    const s = String(v).trim().toLowerCase();
    let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) return ((+m[1] * 3600) + (+m[2] * 60) + (+(m[3] || 0))) * 1000 || null;
    m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
    if (!m) return null;
    const mult = m[2] ? DURATION_SECONDS[m[2]] || (m[2] === "m" ? 60 : undefined) : 3600;
    return mult ? parseFloat(m[1]) * mult * 1000 || null : null;
  }

  function canonicalUnit(u) {
    const secs = DURATION_SECONDS[String(u || "").trim().toLowerCase()];
    if (secs === undefined) return null;
    const hit = DISPLAY_UNITS.find(([, s]) => s === secs);
    return hit ? hit[0] : "s";
  }

  /** Format a reading. Durations are rounded to whole units; display_unit converts them (e.g. days to weeks). */
  function formatNumber(n, unit, opts = {}) {
    const lower = String(unit || "").trim().toLowerCase();
    const secs = DURATION_SECONDS[lower];
    if (secs !== undefined) {
      const total = n * secs;
      let idx = DISPLAY_UNITS.findIndex(([u]) => u === (canonicalUnit(opts.displayUnit) || canonicalUnit(lower)));
      if (idx < 0) idx = DISPLAY_UNITS.length - 1;
      let val = total / DISPLAY_UNITS[idx][1];
      while (Math.round(Math.abs(val)) < 1 && total !== 0 && idx < DISPLAY_UNITS.length - 1) {
        idx += 1;
        val = total / DISPLAY_UNITS[idx][1];
      }
      return `${Math.round(val)} ${DISPLAY_UNITS[idx][0]}`;
    }
    const fixed = Number.isInteger(opts.precision);
    const p = fixed ? opts.precision : Number.isInteger(n) || Math.abs(n) >= 100 ? 0 : 1;
    let s = n.toFixed(p);
    if (!fixed) s = String(Number(s));
    return unit ? `${s} ${unit}` : s;
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
  // State interpretation
  // ---------------------------------------------------------------------------

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
      // A numeric reading on a connectivity entity (signal strength, say) proves the trap is reporting.
      if (Number.isFinite(n)) v = key === "online" ? true : n > 0;
      else if (BOOL_WORDS[key].on.has(s)) v = true;
      else if (BOOL_WORDS[key].off.has(s)) v = false;
    }
    if (v !== null && ref.invert) v = !v;
    return v;
  }

  function interpretLevel(hass, r, threshold, lowRead) {
    const out = { level: null, text: null, low: null, empty: false, deviceLow: false };
    if (r && !r.missing && !r.unknown) {
      const { ref, raw, stateObj, domain } = r;
      const attrs = stateObj.attributes || {};
      const s = norm(raw);
      const n = typeof raw === "number" ? raw : s !== "" ? Number(raw) : NaN;
      if (Number.isFinite(n)) {
        const unit = ref.unit !== undefined ? ref.unit : ref.attribute ? "" : attrs.unit_of_measurement || "";
        let min = resolveNum(hass, ref.min, 0);
        let max = resolveNum(hass, ref.max, NaN);
        if (!Number.isFinite(max)) {
          if (!ref.attribute && unit !== "%" && (domain === "input_number" || domain === "number") && Number.isFinite(Number(attrs.max))) {
            min = toNum(attrs.min, 0);
            max = Number(attrs.max);
          } else {
            max = 100;
          }
        }
        const reg = !ref.attribute && hass && hass.entities ? hass.entities[ref.entity] : null;
        const fmt = { precision: reg && Number.isInteger(reg.display_precision) ? reg.display_precision : undefined, displayUnit: ref.display_unit };
        out.level = max > min ? clamp(((n - min) / (max - min)) * 100, 0, 100) : 0;
        if (unit && unit !== "%") out.text = formatNumber(n, unit, fmt);
        else if (!unit && max !== 100) out.text = `${formatNumber(n, "", fmt)}/${formatNumber(max, "")}`;
        else out.text = `${Math.round(out.level)}%`;
        out.low = out.level <= threshold;
        out.empty = out.level <= 0;
      } else if (typeof raw === "boolean" || s === "on" || s === "off") {
        // binary_sensor with device_class battery/problem: on means low.
        let low = raw === true || s === "on";
        if (ref.invert) low = !low;
        out.low = low;
        out.text = low ? "Low" : "OK";
      } else if (LEVEL_WORDS.has(s)) {
        out.level = LEVEL_WORDS.get(s);
        out.text = titleCase(raw);
        out.low = out.level <= threshold;
        out.empty = out.level <= 0;
      } else {
        out.text = titleCase(raw);
      }
    }
    // The device's own low alert beats a fixed threshold.
    const deviceLow = interpretBool(lowRead, "low");
    if (deviceLow !== null) {
      out.low = deviceLow;
      out.deviceLow = true;
      if (!out.text) out.text = deviceLow ? "Low" : "OK";
    }
    return out;
  }

  function interpretCount(r) {
    if (!r || r.missing || r.unknown) return null;
    const n = Number(r.raw);
    return Number.isFinite(n) ? n : null;
  }

  /** A timestamp state (sensor/event), else the entity's own change time. */
  function readTime(r, fallback) {
    if (!r || r.missing || r.unknown) return null;
    const raw = typeof r.raw === "string" ? r.raw.trim() : r.raw;
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const t = Date.parse(raw.replace(" ", "T"));
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
    if (typeof raw === "number" || (typeof raw === "string" && /^\d{10,13}(\.\d+)?$/.test(raw))) {
      const n = Number(raw);
      if (n > 1e9) return new Date(n > 1e12 ? n : n * 1000).toISOString();
    }
    const so = r.stateObj;
    return (fallback === "updated" ? so.last_updated || so.last_changed : so.last_changed) || null;
  }

  // ---------------------------------------------------------------------------
  // Device discovery
  // ---------------------------------------------------------------------------

  // Checked in order; each entity takes at most one role and each role one entity.
  const DISCOVERY_RULES = [
    { role: "kill", domains: ["binary_sensor", "sensor"], re: /(kill_alert|kill_detected|kills?_present|catch_(detected|alert)|caught|captured|rodent_detected|kill_status)/ },
    { role: "strikes", domains: ["sensor", "counter"], re: /((^|_)strikes?(_count|_total)?$|total_(kills|strikes|catches)|(kill|strike|catch)_count|kills_total)/ },
    { role: "last_strike", domains: ["event"], re: /(strike|kill|catch|trigger)/ },
    { role: "last_strike", domains: ["sensor"], dc: "timestamp", re: /last_(strike|kill|catch|trigger)/ },
    { role: "armed", domains: ["binary_sensor", "sensor"], re: /((^|_)armed$|(^|_)trap_armed|(^|_)is_armed|arm(ed)?_state)/, not: /(re_?arm|disarm)/ },
    { role: "rearm", domains: ["binary_sensor", "sensor"], re: /(re_?arm(_required|_needed)?$|needs_re_?arm|re_?arm_required)/ },
    { role: "battery_low", domains: ["binary_sensor"], dc: "battery" },
    { role: "battery_low", domains: ["binary_sensor", "sensor"], re: /(battery_low|low_battery)/ },
    { role: "battery", domains: ["sensor"], dc: "battery", not: /(low|voltage)/ },
    { role: "battery", domains: ["sensor"], re: /battery(_level|_percent(age)?)?$/, not: /(low|voltage)/ },
    { role: "bait_low", domains: ["binary_sensor", "sensor"], re: /((lure|bait)_(due|low|empty|replace|replacement)|replace_(lure|bait))/ },
    { role: "bait_max", domains: ["number", "sensor"], re: /(lure|bait)_(life|lifetime|duration|capacity|max)$/ },
    { role: "bait", domains: ["sensor", "number"], re: /((lure|bait)_(remaining|level|left|days_left|life_remaining)|remaining_(lure|bait)|(^|_)(lure|bait)$)/ },
    { role: "online", domains: ["binary_sensor"], dc: "connectivity" },
    { role: "online", domains: ["binary_sensor", "sensor"], re: /(^|_)(online|connectivity|connected|connection(_state|_status)?|availability)$/ },
    { role: "online", domains: ["sensor"], re: /node_status$/ },
    { role: "last_seen", domains: ["sensor"], re: /last_(seen|report(ed)?|heard|contact|activity|communication)/ },
    { hold: "kill", domains: ["button", "input_button", "script"], re: /(clear_(kill|catch|alert)|(kill|catch)_(alert_)?(clear|reset)|reset_(kill|catch))/ },
    { hold: "bait", domains: ["button", "input_button", "script"], re: /((lure|bait)_(replaced|refilled|reset|changed|replace)|replace(d)?_(lure|bait)|refill)/ },
    { hold: "link", domains: ["button"], re: /ping$/ },
  ];

  const EMPTY_DISCOVERY = { roles: {}, holds: {}, style: null };
  let deviceIndex = { reg: null, map: new Map() };
  const discoveryCache = new WeakMap();

  function deviceEntities(hass, deviceId) {
    const reg = hass && hass.entities;
    if (!reg) return [];
    if (deviceIndex.reg !== reg) {
      const map = new Map();
      for (const e of Object.values(reg)) {
        if (!e || !e.device_id) continue;
        if (!map.has(e.device_id)) map.set(e.device_id, []);
        map.get(e.device_id).push(e);
      }
      deviceIndex = { reg, map };
    }
    return deviceIndex.map.get(deviceId) || [];
  }

  function deviceInfo(hass, deviceId) {
    const d = hass && hass.devices ? hass.devices[deviceId] : null;
    const areaId = d && d.area_id;
    return {
      name: (d && (d.name_by_user || d.name)) || "",
      area: (areaId && hass.areas && hass.areas[areaId] && hass.areas[areaId].name) || "",
      maker: d ? `${d.manufacturer || ""} ${d.model || ""}` : "",
    };
  }

  function entityInfo(hass, entityId) {
    const e = entityId && hass && hass.entities ? hass.entities[entityId] : null;
    if (!e) return { name: "", area: "" };
    const dev = e.device_id ? deviceInfo(hass, e.device_id) : { name: "", area: "" };
    const area = e.area_id && hass.areas && hass.areas[e.area_id] ? hass.areas[e.area_id].name : dev.area;
    return { name: dev.name, area };
  }

  /** Entity name without the device's name in front ("Clear kill alert", not "Goodnature Trap 1 Clear kill alert"). */
  function shortName(hass, entityId) {
    const st = hass && hass.states ? hass.states[entityId] : null;
    const full = (st && st.attributes && st.attributes.friendly_name) || titleCase(entityId.split(".")[1] || entityId);
    const dev = entityInfo(hass, entityId).name;
    let s = full;
    if (dev && s.toLowerCase().startsWith(dev.toLowerCase())) s = s.slice(dev.length).trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : full;
  }

  function discoverDevice(hass, deviceId) {
    if (!deviceId || !hass || !hass.entities) return EMPTY_DISCOVERY;
    let cache = discoveryCache.get(hass.entities);
    if (!cache) {
      cache = new Map();
      discoveryCache.set(hass.entities, cache);
    }
    const hit = cache.get(deviceId);
    if (hit && !hit.incomplete && hit.devices === hass.devices) return hit;

    const devName = slug(deviceInfo(hass, deviceId).name);
    let incomplete = false;
    const entries = deviceEntities(hass, deviceId).map((e) => {
      const st = hass.states ? hass.states[e.entity_id] : null;
      if (!st) incomplete = true;
      const fn = slug(st && st.attributes && st.attributes.friendly_name);
      const cands = [e.entity_id.split(".")[1], e.translation_key, e.name, devName && fn.startsWith(devName) ? fn.slice(devName.length) : fn]
        .map(slug)
        .filter(Boolean);
      return { id: e.entity_id, domain: e.entity_id.split(".")[0], dc: st && st.attributes ? st.attributes.device_class : undefined, cands };
    });

    const roles = {};
    const holds = {};
    const used = new Set();
    for (const rule of DISCOVERY_RULES) {
      const bucket = rule.role ? roles : holds;
      const key = rule.role || rule.hold;
      if (bucket[key]) continue;
      const match = entries.find(
        (e) =>
          !used.has(e.id) &&
          rule.domains.includes(e.domain) &&
          (!rule.dc || e.dc === rule.dc) &&
          (!rule.re || e.cands.some((c) => rule.re.test(c))) &&
          !(rule.not && e.cands.some((c) => rule.not.test(c)))
      );
      if (match) {
        bucket[key] = match.id;
        used.add(match.id);
      }
    }
    const maker = deviceInfo(hass, deviceId).maker;
    const style = /goodnature/i.test(maker) ? "goodnature" : /station/i.test(maker) ? "station" : null;
    const result = { roles, holds, style, incomplete, devices: hass.devices, ids: entries.map((e) => e.id) };
    cache.set(deviceId, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const PRESS_SERVICES = {
    button: "press", input_button: "press", script: "turn_on", scene: "turn_on", automation: "trigger",
    switch: "toggle", input_boolean: "toggle", light: "toggle", fan: "toggle",
  };

  function actionCall(a) {
    const svc = a.action || a.perform_action || a.service;
    if (svc && String(svc).includes(".")) {
      const [domain, service] = String(svc).split(".");
      return { domain, service, data: a.data || a.service_data || {}, target: a.target || (a.entity ? { entity_id: a.entity } : undefined) };
    }
    if (a.entity) {
      const domain = a.entity.split(".")[0];
      if (!PRESS_SERVICES[domain]) return null;
      return { domain, service: PRESS_SERVICES[domain], data: {}, target: { entity_id: a.entity } };
    }
    return null;
  }

  function makeAction(hass, spec, confirmDefault) {
    const a = typeof spec === "string" ? { entity: spec.trim() } : spec && typeof spec === "object" ? spec : null;
    if (!a) return null;
    const entity = a.entity || (a.target && typeof a.target.entity_id === "string" ? a.target.entity_id : null);
    const svc = a.action || a.perform_action || a.service;
    const name = String(a.name || (entity ? shortName(hass, entity) : titleCase(String(svc || "Run").split(".").pop())));
    const confirm = a.confirm === undefined ? confirmDefault : a.confirm;
    return { name, icon: a.icon || null, confirm: typeof confirm === "string" ? confirm : !!confirm, call: actionCall(a) };
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------

  /** Merge explicit config with what the trap's device provides. */
  function resolveTrap(hass, trap, cfg, index) {
    const found = trap.device ? discoverDevice(hass, trap.device) : EMPTY_DISCOVERY;
    const refs = {};
    for (const k of ROLE_KEYS) {
      const v = trap[k];
      if (v === false || v === "none") refs[k] = null;
      else refs[k] = normalizeRef(v) || (found.roles[k] ? { entity: found.roles[k] } : null);
    }
    // Device extras (bait capacity, low alerts) attach to the device's own level entities.
    const own = (k) => refs[k] && found.roles[k] === refs[k].entity;
    if (own("bait") && found.roles.bait_max && refs.bait.max === undefined) refs.bait = { ...refs.bait, max: found.roles.bait_max };
    if (own("bait") && found.roles.bait_low && refs.bait.low_entity === undefined) refs.bait = { ...refs.bait, low_entity: found.roles.bait_low };
    if (own("battery") && found.roles.battery_low && refs.battery.low_entity === undefined) refs.battery = { ...refs.battery, low_entity: found.roles.battery_low };
    if (!refs.battery && found.roles.battery_low && trap.battery === undefined) refs.battery = { entity: found.roles.battery_low };
    // An event entity carries the time of the last strike, not a count.
    if (refs.strikes && refs.strikes.entity.startsWith("event.")) {
      if (!refs.last_strike) refs.last_strike = refs.strikes;
      refs.strikes = null;
    }

    const firstEntity = ROLE_KEYS.map((k) => refs[k] && refs[k].entity).find(Boolean);
    const info = trap.device ? deviceInfo(hass, trap.device) : entityInfo(hass, firstEntity);
    const style = TRAP_STYLES.includes(trap.style) ? trap.style : found.style || (TRAP_STYLES.includes(cfg.style) ? cfg.style : "snap");

    const holds = {};
    for (const [k, v] of Object.entries(found.holds)) holds[k] = makeAction(hass, v, true);
    if (trap.holds && typeof trap.holds === "object") {
      for (const [k, v] of Object.entries(trap.holds)) {
        const key = HOLD_KEYS[k];
        if (!key) continue;
        const act = v === false || v === null || v === "none" ? null : makeAction(hass, v, true);
        if (act) holds[key] = act;
        else delete holds[key];
      }
    }
    const specs = (Array.isArray(trap.actions) ? trap.actions : []).concat(Object.values(found.holds), Object.values(trap.holds || {}));
    const actions = (Array.isArray(trap.actions) ? trap.actions : []).map((a) => makeAction(hass, a, false)).filter(Boolean);
    // Entities whose state (or friendly name) this trap's tile depends on.
    const watch = new Set(found.ids || []);
    for (const r of Object.values(refs)) {
      if (!r) continue;
      watch.add(r.entity);
      const low = normalizeRef(r.low_entity);
      if (low) watch.add(low.entity);
      for (const x of [r.min, r.max]) if (isEntityId(x)) watch.add(x.trim());
    }
    for (const a of specs) {
      const id = typeof a === "string" ? a.trim() : a && typeof a === "object" ? a.entity || (a.target && a.target.entity_id) : null;
      if (typeof id === "string") watch.add(id);
    }

    return {
      refs,
      watch: Array.from(watch),
      name: String(trap.name || info.name || `Trap ${index + 1}`),
      location: trap.location === false || trap.location === "" ? "" : String(trap.location || info.area || ""),
      style,
      holds,
      actions,
    };
  }

  const STATUS_RANK = { kill: 0, rearm: 1, offline: 2, check: 3, warn: 4, unknown: 5, ok: 6 };

  function buildModel(hass, trap, cfg, index) {
    const t = resolveTrap(hass, trap, cfg, index);
    const { refs } = t;
    const reads = {};
    for (const k of ROLE_KEYS) reads[k] = readRef(hass, refs[k]);
    const configured = ROLE_KEYS.filter((k) => refs[k]);

    // Every entity the trap depends on, including low alerts and entity-based ranges.
    const deps = [];
    for (const k of configured) {
      const r = refs[k];
      deps.push(r.entity);
      const low = normalizeRef(r.low_entity);
      if (low) deps.push(low.entity);
      for (const x of [r.min, r.max]) if (isEntityId(x)) deps.push(x.trim());
    }
    const missing = Array.from(new Set(deps)).filter((e) => !(hass && hass.states && hass.states[e]));

    const lowRead = (k) => refs[k] && readRef(hass, normalizeRef(refs[k].low_entity));
    const m = {
      index,
      watch: t.watch,
      name: t.name,
      location: t.location,
      style: t.style,
      configured,
      entities: Object.fromEntries(configured.map((k) => [k, refs[k].entity])),
      missing,
      strikes: interpretCount(reads.strikes),
      lastStrike: readTime(reads.last_strike, "changed"),
      lastSeen: readTime(reads.last_seen, "updated"),
      battery: interpretLevel(hass, reads.battery, toNum(trap.battery_low, cfg.battery_low), lowRead("battery")),
      bait: interpretLevel(hass, reads.bait, toNum(trap.bait_low, cfg.bait_low), lowRead("bait")),
      kill: interpretBool(reads.kill, "kill"),
      armed: interpretBool(reads.armed, "armed"),
      rearmReported: interpretBool(reads.rearm, "rearm"),
      asleep: !!(reads.online && !reads.online.unknown && norm(reads.online.raw) === "asleep"),
      since: {
        kill: reads.kill && reads.kill.since,
        rearm: (reads.rearm && reads.rearm.since) || (reads.armed && reads.armed.since),
        online: null,
      },
      holds: t.holds,
      actions: t.actions,
    };

    // Armed and re-arm sensors should agree; when both are configured and they don't, flag it.
    const a = m.armed;
    const r = m.rearmReported;
    m.conflict = a !== null && r !== null && a === r;
    m.rearm = m.conflict ? null : r !== null ? r : a !== null ? !a : null;

    // Connectivity: the online entity, overridden by how long ago the trap was last seen.
    let online = interpretBool(reads.online, "online");
    m.since.online = reads.online && reads.online.since;
    m.stale = false;
    if (m.lastSeen) {
      const age = Date.now() - Date.parse(m.lastSeen);
      const offlineAfter = parseDuration(trap.offline_after !== undefined ? trap.offline_after : cfg.offline_after);
      const staleAfter = parseDuration(trap.stale_after !== undefined ? trap.stale_after : cfg.stale_after);
      if (offlineAfter && age > offlineAfter) online = false;
      else if (staleAfter && age > staleAfter) m.stale = true;
      if (online === false) m.since.online = m.lastSeen;
    }
    if (!refs.online && online === null) {
      // Without a connectivity entity, infer "offline" when every entity is unavailable.
      const found = configured.map((k) => reads[k]).filter((x) => !x.missing);
      if (found.length && found.every((x) => x.dead)) {
        online = false;
        m.since.online = found[0].since;
      }
    }
    m.online = online;

    const warnings = [];
    if (m.battery.low) warnings.push("Low battery");
    if (m.bait.empty) warnings.push("Out of bait");
    else if (m.bait.low) warnings.push("Low bait");
    if (m.stale) warnings.push("Not seen recently");
    if (m.missing.length) warnings.push("Entity not found");
    m.warnings = warnings;

    const noData = configured.every((k) => reads[k].missing || reads[k].unknown);
    if (m.kill === true) m.status = "kill";
    else if (m.rearm === true) m.status = "rearm";
    else if (m.online === false) m.status = "offline";
    else if (m.conflict) m.status = "check";
    else if (warnings.length) m.status = "warn";
    else if (noData) m.status = "unknown";
    else m.status = "ok";

    m.label = {
      kill: "Catch detected",
      rearm: "Needs re-arm",
      offline: "Offline",
      check: "Check trap",
      warn: warnings[0] + (warnings.length > 1 ? ` +${warnings.length - 1}` : ""),
      unknown: configured.length ? "No data" : "Not set up",
      ok: refs.kill || refs.rearm || refs.armed ? "Armed" : "All good",
    }[m.status];

    m.scene = { kill: "kill", rearm: "sprung", offline: "offline", check: "check", unknown: "idle" }[m.status] || "armed";
    m.primary = m.entities.kill || m.entities.armed || m.entities.rearm || m.entities.online || m.entities.last_seen || m.entities[configured[0]] || null;
    return m;
  }

  function metricKeys(m) {
    const has = (k) => m.configured.includes(k);
    return METRIC_ORDER.filter((k) =>
      k === "trap" ? has("armed") || has("rearm") : k === "link" ? has("online") || has("last_seen") : has(k)
    );
  }

  function metricEntities(m, key) {
    const e = m.entities;
    if (key === "trap") return [e.armed, e.rearm].filter(Boolean);
    if (key === "link") return [e.online, e.last_seen].filter(Boolean);
    return [e[key]].filter(Boolean);
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
    question: `<svg viewBox="0 0 24 24" class="ic ic-question" aria-hidden="true"><path d="M12 2.5 19.5 5v6.2c0 4.6-3.1 8.6-7.5 10.3-4.4-1.7-7.5-5.7-7.5-10.3V5L12 2.5Z"/><path d="M9.7 9.3a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.5v.6" class="q"/><circle cx="12" cy="16.6" r="1.1" class="qd"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" class="ic ic-clock" aria-hidden="true"><circle cx="12" cy="12" r="8.8"/><path d="M12 7v5.3l3.4 2.1"/></svg>`,
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
    </g>`;

  const stars = (x, y) => `
    <g transform="translate(${x} ${y}) scale(1 .42)">
      <g class="orbit">
        <circle r="13" fill="none"/>
        <path class="star" d="M13 -3.2 14 -.9 16.5 -.6 14.6 1.1 15.2 3.6 13 2.3 10.8 3.6 11.4 1.1 9.5 -.6 12 -.9Z"/>
        <path class="star" d="M-6.5 8 -5.5 10.3 -3 10.6-4.9 12.3-4.3 14.8-6.5 13.5-8.7 14.8-8.1 12.3-10 10.6-7.5 10.3Z"/>
        <path class="star" d="M-6.5 -14.5 -5.5 -12.2 -3 -11.9-4.9 -10.2-4.3 -7.7-6.5 -9-8.7 -7.7-8.1 -10.2-10 -11.9-7.5 -12.2Z"/>
      </g>
    </g>`;

  /** Bait level 0-100 for drawing; full when bait isn't tracked. */
  function baitLevel(m) {
    if (!m.configured.includes("bait")) return 100;
    if (m.bait.level !== null) return m.bait.level;
    return m.bait.low ? 15 : 100;
  }

  function snapStage(m) {
    const lvl = baitLevel(m);
    const cheeseScale = lvl <= 0 ? 0 : 0.45 + 0.55 * (lvl / 100);
    const showCheese = m.scene !== "kill";
    const set = m.scene !== "kill" && m.scene !== "sprung";
    return `
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
    ${showCheese && cheeseScale === 0 ? `<g class="crumbs"><circle cx="114" cy="62" r="1"/><circle cx="121" cy="61.6" r=".8"/><circle cx="129" cy="62" r="1.1"/><circle cx="135" cy="61.8" r=".7"/></g>` : ""}
    ${m.scene === "armed" ? `<g transform="translate(153 57)">${MOUSE_ALIVE}</g>` : ""}
    ${m.scene === "kill" ? `<g class="victim"><g transform="translate(106 43) rotate(3)">${MOUSE_CAUGHT}${stars(13, -3)}</g></g>` : ""}
    <path class="staple" d="M64 66V60.5a3 3 0 0 1 6 0V66M74 66V60.5a3 3 0 0 1 6 0V66"/>
    ${set ? `<path class="holddown" d="M12 57.4 104 61.6"/>` : ""}
    <g class="bar"><path d="M72 63H136V57.5"/></g>
    <circle class="spring" cx="72" cy="63" r="4.6"/>
    <circle class="spring-in" cx="72" cy="63" r="1.8"/>`;
  }

  function goodnatureStage(m) {
    const lvl = baitLevel(m);
    const lure = (12.4 * lvl) / 100;
    return `
    <ellipse class="shadow" cx="80" cy="82" rx="50" ry="3.2"/>
    <rect class="post" x="38" y="8" width="15" height="74" rx="1.5"/>
    <path class="grain" d="M42.5 14V78M47.5 24V72M50 10V40"/>
    <rect class="gn-bracket" x="51" y="29" width="13" height="4" rx="1"/>
    <rect class="gn-bracket" x="51" y="50" width="13" height="4" rx="1"/>
    <rect class="gn-can" x="67.5" y="16.5" width="15" height="10" rx="3"/>
    <rect class="gn-can-band" x="67.5" y="20" width="15" height="2.6"/>
    <rect class="gn-body" x="62" y="25" width="26" height="36" rx="6"/>
    <rect class="gn-shine" x="65.5" y="29" width="3" height="27" rx="1.5"/>
    <rect class="gn-stripe" x="62" y="36" width="26" height="3"/>
    <circle class="gn-led" cx="82.5" cy="31" r="1.7"/>
    <rect class="gn-window${lvl <= 0 ? " empty" : ""}" x="77" y="42" width="7" height="14" rx="2.5"/>
    ${lure > 0 ? `<rect class="gn-lure" x="77.8" y="${(55.2 - lure).toFixed(2)}" width="5.4" height="${lure.toFixed(2)}" rx="2"/>` : ""}
    <ellipse class="gn-mouth" cx="75" cy="61" rx="11.5" ry="3"/>
    ${m.scene === "armed" ? `<g transform="translate(97 57)">${MOUSE_ALIVE}</g>` : ""}
    ${m.scene === "kill" ? `<g class="victim"><g transform="translate(131 61.5) scale(-.85 .85)">${MOUSE_CAUGHT}${stars(13, -3)}</g></g>
    <g class="puff"><circle cx="70" cy="64" r="3"/><circle cx="79" cy="65" r="2.4"/><circle cx="75" cy="67.5" r="3.4"/></g>` : ""}`;
  }

  function stationStage(m) {
    const lvl = baitLevel(m);
    const blocks = lvl <= 0 ? 0 : Math.max(1, Math.ceil(lvl / 25));
    const blockRects = [0, 1, 2, 3].slice(0, blocks).map((i) => `<rect class="stn-block" x="${48 + i * 14.5}" y="59.5" width="11" height="10" rx="1.6"/>`).join("");
    return `
    <ellipse class="shadow" cx="75" cy="82" rx="72" ry="3.4"/>
    <rect class="stn-body" x="8" y="49" width="134" height="32.5" rx="5"/>
    <path class="stn-rib" d="M34 55V78M116 55V78"/>
    <path class="stn-hole" d="M13 81.5V74a7.5 7.5 0 0 1 15 0v7.5Z"/>
    <path class="stn-hole" d="M122 81.5V74a7.5 7.5 0 0 1 15 0v7.5Z"/>
    <rect class="stn-window${lvl <= 0 ? " empty" : ""}" x="44" y="56" width="62" height="17" rx="3"/>
    ${blockRects}
    <rect class="stn-lid" x="5" y="43" width="140" height="9" rx="4"/>
    <path class="stn-lid-hi" d="M10 45.5H140"/>
    <circle class="stn-lock" cx="75" cy="47.5" r="2.2"/>
    ${m.scene === "armed" ? `<g transform="translate(139 57)">${MOUSE_ALIVE}</g>` : ""}
    ${m.scene === "kill" ? `<g class="victim"><path class="tail-out" d="M133 80C142 81 148 84 160 80.5"/>${stars(129, 36)}</g>` : ""}`;
  }

  const ART = {
    snap: { draw: snapStage, word: "SNAP!", burst: [172, 36] },
    goodnature: { draw: goodnatureStage, word: "POP!", burst: [124, 32] },
    station: { draw: stationStage, word: "ZAP!", burst: [178, 32] },
  };

  function sceneSvg(m, uid, snap) {
    const art = ART[m.style] || ART.snap;
    const aria = {
      armed: "Trap armed and waiting",
      idle: "Trap with no data",
      kill: "Trap with a catch",
      sprung: "Trap sprung and needs re-arming",
      offline: "Trap offline",
      check: "Trap sensors disagree",
    }[m.scene];
    const badge = {
      sprung: `<g class="badge badge-rearm" transform="translate(4 32)"><circle r="12"/><g class="spin"><path transform="translate(-8 -8) scale(.667)" d="M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8Zm-8.5 6.5L7 15H4.8A6 6 0 0 0 18 12h2a8 8 0 0 1-15.4 3H2l1.5-4.5Z"/></g></g>`,
      check: `<g class="badge badge-check" transform="translate(4 32)"><circle r="12"/><text y="5" text-anchor="middle">?</text></g>`,
      offline: `<g class="badge badge-offline" transform="translate(196 32)"><circle r="12"/><g transform="translate(-8 -8) scale(.667)"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0" class="waves"/><circle cx="12" cy="19" r="1.6"/><path d="M4 3 20 21" class="slash"/></g></g>`,
    }[m.scene] || "";
    const burst = snap && (m.scene === "kill" || m.scene === "sprung")
      ? `<g transform="translate(${art.burst[0]} ${art.burst[1]}) rotate(-10)"><g class="snap-text">
          <path class="burst" d="M-26 0-19-6-22-14-12-11-6-19 0-12 8-18 11-9 21-10 17-2 26 2 17 6 20 14 10 12 5 19 0 12-7 18-10 10-20 12-16 4Z"/>
          <text text-anchor="middle" y="3.5">${art.word}</text></g></g>`
      : "";
    return `
<svg viewBox="-22 16 244 72" class="scene art-${m.style} st-${m.scene}${snap ? " snap-now" : ""}" role="img" aria-label="${aria}">
  <defs>
    <radialGradient id="${uid}-glow">
      <stop offset="0" class="glow-in"/>
      <stop offset="1" class="glow-out"/>
    </radialGradient>
  </defs>
  <ellipse class="glow" cx="82" cy="62" rx="92" ry="34" fill="url(#${uid}-glow)"/>
  <path class="floor" d="M-22 81.5H222"/>
  <g class="stage">${art.draw(m)}</g>
  ${badge}
  ${burst}
</svg>`;
  }

  // ---------------------------------------------------------------------------
  // Tile rendering
  // ---------------------------------------------------------------------------

  const METRIC_LABELS = { strikes: "Strikes", last_strike: "Last strike", battery: "Battery", bait: "Bait", kill: "Catch", trap: "Trap", link: "Link" };

  function metric(key, entity, icon, value, text, label, cls, hold) {
    const fit = text.length > 10 ? " fit-xs" : text.length > 7 ? " fit-s" : "";
    const title = `${label}: ${text}${hold ? ` ${DOT} hold to ${hold.name.toLowerCase()}` : ""} (${entity})`;
    return `
      <div class="metric m-${key} ${cls}${hold ? " has-hold" : ""}${fit}" data-entity="${esc(entity)}"${hold ? ` data-hold="${key}"` : ""} role="button" tabindex="0" title="${esc(title)}" aria-label="${esc(title)}">
        <div class="m-icon">${icon}</div>
        <div class="m-text"><div class="m-value">${value}</div><div class="m-label">${esc(label)}</div></div>
      </div>`;
  }

  const timeValue = (iso) => (iso ? `<span data-since="${esc(iso)}">${esc(relTime(iso))}</span>` : DASH);

  function renderMetrics(m, uid, flags) {
    const out = [];
    for (const key of metricKeys(m)) {
      const ents = metricEntities(m, key);
      const entity = ents[0];
      const hold = m.holds[key] || null;
      const label = METRIC_LABELS[key];
      const add = (icon, value, text, cls) => out.push(metric(key, entity, icon, value, text, label, cls, hold));
      if (ents.every((e) => m.missing.includes(e))) {
        add(ICONS.wifiOff, DASH, DASH, "is-missing");
        continue;
      }
      switch (key) {
        case "strikes": {
          const text = m.strikes === null ? DASH : formatNumber(m.strikes, "");
          const grew = flags.strikesFrom !== null;
          const counted = grew ? ` data-count-from="${flags.strikesFrom}" data-count-to="${m.strikes}"` : "";
          const plus = grew ? `<span class="plus">+${formatNumber(m.strikes - flags.strikesFrom, "")}</span>` : "";
          add(ICONS.mouseHead, `<span class="count"${counted}>${text}</span>${plus}`, text, grew ? "bump" : "");
          break;
        }
        case "last_strike":
          add(ICONS.clock, timeValue(m.lastStrike), relTime(m.lastStrike) || DASH, (flags.newStrike ? "bump" : "") + (m.lastStrike ? "" : " is-dim"));
          break;
        case "battery": {
          const text = m.battery.text || DASH;
          add(batteryIcon(m.battery), esc(text), text, m.battery.low ? "is-warn" : m.battery.text ? "" : "is-dim");
          break;
        }
        case "bait": {
          const text = m.bait.text || DASH;
          add(cheeseIcon(m.bait, uid), esc(text), text, m.bait.empty ? "is-bad" : m.bait.low ? "is-warn" : m.bait.text ? "" : "is-dim");
          break;
        }
        case "kill": {
          const text = m.kill === null ? DASH : m.kill ? "Caught!" : "Clear";
          add(m.kill === false ? ICONS.check : ICONS.bell, text, text, m.kill ? "is-bad" : m.kill === false ? "is-good" : "is-dim");
          break;
        }
        case "trap": {
          const text = m.conflict ? "Check" : m.rearm === null ? DASH : m.rearm ? "Re-arm" : "Armed";
          const icon = m.conflict ? ICONS.question : m.rearm === false ? ICONS.shield : ICONS.rearm;
          add(icon, text, text, m.conflict || m.rearm ? "is-warn" : m.rearm === false ? "is-good" : "is-dim");
          break;
        }
        case "link": {
          const up = m.online === false ? "down" : m.stale ? "stale" : m.online || m.lastSeen ? "up" : "";
          const dot = `<span class="dot ${up}" aria-hidden="true"><span></span></span>`;
          const cls = m.online === false ? "is-off" : m.stale ? "is-warn" : "";
          if (m.entities.last_seen) {
            out.push(metric(key, entity, dot, timeValue(m.lastSeen), relTime(m.lastSeen) || DASH, "Last seen", cls + (m.lastSeen ? "" : " is-dim"), hold));
          } else {
            const text = m.online === null ? DASH : m.online ? (m.asleep ? "Asleep" : "Online") : "Offline";
            add(dot, text, text, cls + (m.online === null ? " is-dim" : ""));
          }
          break;
        }
      }
    }
    return out.join("");
  }

  function renderBanner(m) {
    const since = (iso) => (iso ? ` ${DOT} <span class="since" data-since="${esc(iso)}">${esc(relTime(iso))}</span>` : "");
    const attr = (e) => (e ? ` data-entity="${esc(e)}" role="button" tabindex="0"` : "");
    if (m.kill === true) {
      return `<div class="banner b-kill"${attr(m.entities.kill)}>
        ${ICONS.bell}<div><div class="b-title">Catch detected${since(m.since.kill)}</div><div class="b-sub">Empty the trap and re-arm it.</div></div></div>`;
    }
    if (m.rearm === true) {
      return `<div class="banner b-rearm"${attr(m.entities.rearm || m.entities.armed)}>
        ${ICONS.rearm}<div><div class="b-title">Trap sprung${since(m.since.rearm)}</div><div class="b-sub">Check the trap and set it again.</div></div></div>`;
    }
    if (m.online === false) {
      return `<div class="banner b-offline"${attr(m.entities.online || m.entities.last_seen)}>
        ${ICONS.wifiOff}<div><div class="b-title">Not reporting${since(m.since.online)}</div><div class="b-sub">Check power and signal.</div></div></div>`;
    }
    if (m.conflict) {
      const sub = m.armed
        ? "It reports armed, but also asks to be re-armed. Check it in person."
        : "It reports not armed, but no re-arm is requested. Check it in person.";
      return `<div class="banner b-check"${attr(m.entities.armed)}>
        ${ICONS.question}<div><div class="b-title">Sensors disagree</div><div class="b-sub">${sub}</div></div></div>`;
    }
    return "";
  }

  function renderUi(m, ui) {
    if (ui.pending) {
      const act = ui.pending.kind === "hold" ? m.holds[ui.pending.key] : m.actions[Number(ui.pending.key)];
      if (act) {
        const q = typeof act.confirm === "string" ? act.confirm : `${act.name}?`;
        return `<div class="confirm" role="alertdialog" aria-label="${esc(q)}"><span>${esc(q)}</span>
          <button type="button" class="c-no" data-confirm="no">Cancel</button>
          <button type="button" class="c-yes" data-confirm="yes">${esc(act.name)}</button></div>`;
      }
    }
    if (ui.flash) return `<div class="flash ${ui.flash.kind}" role="status">${esc(ui.flash.msg)}</div>`;
    return "";
  }

  function renderActions(m, ui) {
    if (!m.actions.length) return "";
    const buttons = m.actions.map((a, i) => {
      const id = `act:${i}`;
      const state = ui.busy === id ? " busy" : ui.flash && ui.flash.id === id ? ` ${ui.flash.kind}` : "";
      const icon = a.icon ? `<ha-icon icon="${esc(a.icon)}"></ha-icon>` : "";
      return `<button type="button" class="act${state}" data-act="${i}"${ui.busy === id ? " disabled" : ""}>${icon}<span>${esc(a.name)}</span></button>`;
    });
    return `<div class="actions">${buttons.join("")}</div>`;
  }

  function renderTile(m, cfg, flags, ui) {
    const uid = `rt${m.index}`;
    const sceneAttrs = m.primary ? ` data-entity="${esc(m.primary)}"` : "";
    const scene = cfg.show_scene ? `<div class="scene-wrap"${sceneAttrs}>${sceneSvg(m, uid, flags.snap)}</div>` : "";
    const body = m.configured.length
      ? `${renderUi(m, ui)}${renderBanner(m)}<div class="metrics">${renderMetrics(m, uid, flags)}</div>${renderActions(m, ui)}`
      : `${renderUi(m, ui)}<div class="hint">No sensors yet. Edit this card and pick a device or entities for this trap.</div>${renderActions(m, ui)}`;
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
    const count = (...s) => models.filter((m) => s.includes(m.status)).length;
    const chips = [];
    const push = (n, cls, text) => n && chips.push(`<span class="chip s-${cls}"><span class="chip-dot"></span>${text}</span>`);
    push(count("kill"), "kill", plural(count("kill"), "catch", "catches"));
    push(count("rearm"), "rearm", `${count("rearm")} to re-arm`);
    push(count("offline"), "offline", `${count("offline")} offline`);
    push(count("warn", "check"), "warn", `${count("warn", "check")} ${count("warn", "check") === 1 ? "needs" : "need"} attention`);
    if (!chips.length && models.length) {
      chips.push(`<span class="chip s-ok"><span class="chip-dot"></span>${models.every((m) => m.status === "ok") ? "All clear" : "No alerts"}</span>`);
    }
    const counted = models.filter((m) => m.strikes !== null);
    if (counted.length) {
      const total = counted.reduce((a, m) => a + m.strikes, 0);
      chips.push(`<span class="chip total" title="Total strikes across all traps">${ICONS.mouseHead}${plural(Number(formatNumber(total, "")), "strike", "strikes")}</span>`);
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
  --rt-accent: var(--primary-color, #03a9f4);
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
  --rt-gn-body: #2d3833;
  --rt-gn-stripe: #86b640;
  --rt-can-band: #d9463b;
  --rt-stn-body: #3f6150;
  --rt-stn-lid: #4f7763;
  --rt-stn-hole: #16201b;
  --rt-stn-block: #3aa6c8;
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
.wrap.headless .grid { padding-top: 12px; }

.chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; white-space: nowrap;
  background: color-mix(in srgb, var(--c, var(--rt-off)) 15%, transparent); color: var(--rt-text); }
.chip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c, var(--rt-off)); flex: none; }
.chip.total { --c: var(--rt-text2); gap: 4px; padding-left: 6px; }
.chip.total .ic { width: 18px; height: 18px; }
.s-ok { --c: var(--rt-ok); }
.s-warn, .s-check, .s-rearm { --c: var(--rt-warn); }
.s-kill { --c: var(--rt-bad); }
.s-offline, .s-unknown { --c: var(--rt-off); }
.chip.s-kill .chip-dot { position: relative; }
.chip.s-kill .chip-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--c); animation: ping 1.4s ease-out infinite; }

.tile { position: relative; border-radius: 14px; border: 1px solid var(--rt-divider); overflow: hidden; container-type: inline-size;
  background: color-mix(in srgb, var(--rt-text) 2.5%, transparent); transition: border-color .4s, background-color .4s; }
.tile::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--c, transparent); transition: background-color .4s; }
.tile.s-ok::before, .tile.s-unknown::before { background: transparent; }
.tile.s-kill { border-color: color-mix(in srgb, var(--rt-bad) 55%, transparent); background: color-mix(in srgb, var(--rt-bad) 6%, transparent); animation: alarm 2.2s ease-in-out infinite; }
.tile.s-rearm, .tile.s-check { border-color: color-mix(in srgb, var(--rt-warn) 55%, transparent); }
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
.metric { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 9px; border-radius: 10px; cursor: pointer; outline: none; overflow: hidden;
  background: color-mix(in srgb, var(--rt-text) 5%, transparent); transition: background-color .3s, transform .15s;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.metric:hover { background: color-mix(in srgb, var(--rt-text) 9%, transparent); }
.metric:focus-visible, .tile-head:focus-visible, .banner:focus-visible, .act:focus-visible, .confirm button:focus-visible { box-shadow: 0 0 0 2px var(--rt-accent); }
.metric:active { transform: scale(.97); }
.m-icon { width: 26px; height: 22px; display: grid; place-items: center; flex: none; }
.m-icon .ic { width: 24px; height: 22px; }
.m-text { min-width: 0; }
.m-value { font-size: 15px; font-weight: 600; line-height: 1.2; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fit-s .m-value { font-size: 13px; }
.fit-xs .m-value { font-size: 12px; white-space: normal; overflow-wrap: anywhere; line-height: 1.15; }
.m-label { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--rt-text2); line-height: 1.25; }
.metric.is-warn { background: color-mix(in srgb, var(--rt-warn) 16%, transparent); }
.metric.is-bad { background: color-mix(in srgb, var(--rt-bad) 15%, transparent); }
.metric.is-off { background: color-mix(in srgb, var(--rt-off) 18%, transparent); }
.metric.is-dim .m-value, .metric.is-missing .m-value { color: var(--rt-text2); }
.metric.is-dim .m-icon { filter: grayscale(1); opacity: .45; }
.metric.is-missing { outline: 1px dashed color-mix(in srgb, var(--rt-bad) 60%, transparent); outline-offset: -1px; }
.metric.is-missing .ic { stroke: var(--rt-bad); fill: var(--rt-bad); }
.metric.has-hold::after { content: ""; position: absolute; right: 6px; bottom: 6px; width: 6px; height: 6px; border-right: 1.5px solid var(--rt-text2); border-bottom: 1.5px solid var(--rt-text2); opacity: .5; border-bottom-right-radius: 2px; }
.metric.holding::before { content: ""; position: absolute; inset: 0; background: color-mix(in srgb, var(--rt-accent) 26%, transparent); transform-origin: 0 50%; animation: hold-fill ${HOLD_MS}ms linear forwards; pointer-events: none; }
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
.ic-question path:first-child { fill: var(--rt-warn); }
.ic-question .q { fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; }
.ic-question .qd { fill: #fff; }
.ic-clock circle, .ic-clock path { fill: none; stroke: var(--rt-text2); stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.bump .ic-clock path { transform-box: view-box; transform-origin: 12px 12px; animation: spin .8s ease-out; }
.ic-rearm { fill: var(--rt-warn); }
.is-warn .ic-rearm { animation: spin 2.8s linear infinite; }
.ic-wifi-off { fill: var(--rt-off); }
.ic-wifi-off .waves, .ic-wifi-off .slash { fill: none; stroke: var(--rt-off); stroke-width: 2; stroke-linecap: round; }
.dot { position: relative; width: 12px; height: 12px; border-radius: 50%; background: var(--rt-off); }
.dot.up { background: var(--rt-ok); }
.dot.stale { background: var(--rt-warn); }
.dot.up span, .dot.stale span { position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: ping 2.4s cubic-bezier(0, 0, .2, 1) infinite; }
.dot.down { background: transparent; border: 2px solid var(--rt-off); box-sizing: border-box; }

/* banners, confirmation and actions */
.banner { display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 8px; border-radius: 10px; outline: none; }
.banner[data-entity] { cursor: pointer; }
.banner .ic { width: 22px; height: 22px; flex: none; }
.b-title { font-size: 13.5px; font-weight: 600; }
.b-sub { font-size: 12px; color: var(--rt-text2); }
.since { font-weight: 400; color: var(--rt-text2); }
.b-kill { background: color-mix(in srgb, var(--rt-bad) 16%, transparent); }
.b-kill .ic-bell { animation: ring 1.6s ease-in-out infinite; transform-origin: 50% 12%; }
.b-rearm, .b-check { background: color-mix(in srgb, var(--rt-warn) 18%, transparent); }
.b-rearm .ic-rearm { animation: spin 2.8s linear infinite; }
.b-offline { background: color-mix(in srgb, var(--rt-off) 18%, transparent); }
.confirm { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 8px 8px 12px; margin-bottom: 8px; border-radius: 10px;
  background: color-mix(in srgb, var(--rt-accent) 14%, transparent); animation: fade-in .15s ease-out; }
.confirm span { flex: 1; min-width: 120px; font-size: 13.5px; font-weight: 600; }
.confirm button, .act { font: inherit; font-size: 12.5px; font-weight: 500; height: 30px; padding: 0 12px; border-radius: 15px; cursor: pointer; outline: none;
  display: inline-flex; align-items: center; gap: 6px; color: var(--rt-text); background: transparent; border: 1px solid var(--rt-divider); }
.confirm .c-yes { background: var(--rt-accent); border-color: var(--rt-accent); color: var(--text-primary-color, #fff); }
.flash { font-size: 12.5px; font-weight: 500; padding: 7px 10px; margin-bottom: 8px; border-radius: 10px; animation: fade-in .15s ease-out; }
.flash.ok { background: color-mix(in srgb, var(--rt-ok) 16%, transparent); }
.flash.err { background: color-mix(in srgb, var(--rt-bad) 16%, transparent); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.act:hover { border-color: var(--rt-accent); }
.act ha-icon { --mdc-icon-size: 16px; }
.act.busy { opacity: .55; cursor: progress; }
.act.ok { border-color: var(--rt-ok); }
.act.err { border-color: var(--rt-bad); }
.hint { font-size: 12.5px; color: var(--rt-text2); padding: 6px 0 2px; }
.hint.warn { color: var(--rt-bad); }
.hint code { font-size: 11.5px; }
.empty { padding: 8px 16px 8px; color: var(--rt-text2); font-size: 14px; }

/* scene: shared */
.scene { --peek: 86px; }
.scene .glow-in { stop-color: var(--rt-bad); stop-opacity: .38; }
.scene .glow-out { stop-color: var(--rt-bad); stop-opacity: 0; }
.scene .glow { opacity: 0; }
.st-kill .glow { opacity: 1; animation: glow 1.8s ease-in-out infinite; }
.scene .shadow { fill: #000; opacity: .12; }
.scene .floor { stroke: var(--rt-divider); stroke-width: 1; }
.scene .grain { stroke: var(--rt-grain); stroke-width: .9; stroke-linecap: round; fill: none; }
.snap-now .stage { animation: shake .5s .28s ease-out both; }
.snap-now .victim { animation: fade-in .12s .27s both; }
.st-offline .stage { filter: grayscale(1); opacity: .5; }
.st-idle .stage, .st-check .stage { opacity: .75; }
.scene .mouse .fur { fill: var(--rt-fur); }
.scene .mouse .belly { fill: var(--rt-fur-hi); }
.scene .mouse .pink { fill: var(--rt-pink); }
.scene .mouse .eye { fill: var(--rt-eye); }
.scene .mouse .glint { fill: #fff; }
.scene .mouse .x-eye { stroke: var(--rt-eye); stroke-width: 1.3; stroke-linecap: round; fill: none; }
.scene .mouse .tail, .scene .tail-out { fill: none; stroke: var(--rt-pink); stroke-width: 2; stroke-linecap: round; }
.scene .mouse .whiskers { fill: none; stroke: var(--rt-text2); stroke-width: .55; stroke-linecap: round; opacity: .8; }
.st-armed .mouse { animation: peek 12s ease-in-out infinite; }
.st-armed .mouse .tail { transform-box: fill-box; transform-origin: 0% 70%; animation: sway 1.4s ease-in-out infinite alternate; }
.st-armed .mouse .nose { transform-box: fill-box; transform-origin: 50% 50%; animation: sniff .38s ease-in-out infinite alternate; }
.st-armed .mouse .whiskers { transform-box: fill-box; transform-origin: 100% 40%; animation: twitch .38s ease-in-out infinite alternate; }
.st-armed .mouse .eye { transform-box: fill-box; transform-origin: 50% 50%; animation: blink-eye 4.2s infinite; }
.scene .star { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: .6; }
.scene .orbit { transform-box: fill-box; transform-origin: 50% 50%; animation: spin 2.6s linear infinite; }
.badge-rearm > circle, .badge-check > circle { fill: color-mix(in srgb, var(--rt-warn) 22%, transparent); }
.badge-rearm path { fill: var(--rt-warn); }
.badge-rearm .spin { transform-box: fill-box; transform-origin: 50% 50%; animation: spin 3s linear infinite; }
.badge-check text { font: 700 14px/1 system-ui, sans-serif; fill: var(--rt-warn); }
.badge-check { animation: fade-pulse 2.4s ease-in-out infinite; }
.badge-offline > circle { fill: color-mix(in srgb, var(--rt-off) 22%, transparent); }
.badge-offline circle:not(:first-child) { fill: var(--rt-off); }
.badge-offline .waves, .badge-offline .slash { fill: none; stroke: var(--rt-off); stroke-width: 2.2; stroke-linecap: round; }
.badge-offline { animation: fade-pulse 2.4s ease-in-out infinite; }
.snap-text { opacity: 0; transform-box: fill-box; transform-origin: 50% 50%; }
.snap-now .snap-text { animation: pop 1.9s .28s both; }
.snap-text .burst { fill: var(--rt-cheese); stroke: var(--rt-bad); stroke-width: 1.2; stroke-linejoin: round; }
.snap-text text { font: 800 10px/1 system-ui, sans-serif; fill: var(--rt-bad); letter-spacing: .02em; }

/* scene: snap trap */
.scene .wood, .scene .post { fill: var(--rt-wood); }
.scene .wood-edge { fill: var(--rt-wood-edge); }
.scene .wood-hi { stroke: rgba(255, 255, 255, .35); stroke-width: 1; }
.scene .plate { fill: var(--rt-metal-hi); stroke: var(--rt-metal); stroke-width: .8; }
.scene .cheese { transform-box: fill-box; transform-origin: 50% 100%; transition: transform .8s cubic-bezier(.3, 1.4, .5, 1); }
.scene .wedge { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: 1; stroke-linejoin: round; }
.scene .hole { fill: var(--rt-cheese-dark); }
.scene .crumbs { fill: var(--rt-cheese-dark); }
.scene .staple, .scene .holddown { fill: none; stroke: var(--rt-metal); stroke-width: 1.6; stroke-linecap: round; }
.scene .holddown { stroke-width: 1.3; }
.scene .bar { transform-box: fill-box; transform-origin: 0% 100%; transform: rotate(-174deg); }
.scene .bar path { fill: none; stroke: var(--rt-metal); stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }
.st-kill .bar { transform: rotate(-12deg); }
.st-sprung .bar { transform: rotate(0deg); }
.snap-now.st-kill .bar { animation: snap-kill .5s cubic-bezier(.55, 0, .7, .4) both; }
.snap-now.st-sprung .bar { animation: snap-empty .5s cubic-bezier(.55, 0, .7, .4) both; }
.scene .spring { fill: var(--rt-metal-hi); stroke: var(--rt-metal); stroke-width: 1.4; }
.scene .spring-in { fill: var(--rt-metal); }

/* scene: Goodnature-style CO2 trap */
.art-goodnature { --peek: 132px; }
.scene .gn-bracket { fill: var(--rt-metal); }
.scene .gn-can { fill: var(--rt-metal-hi); stroke: var(--rt-metal); stroke-width: .8; }
.scene .gn-can-band { fill: var(--rt-can-band); }
.scene .gn-body { fill: var(--rt-gn-body); stroke: color-mix(in srgb, var(--rt-text) 18%, transparent); stroke-width: .8; }
.scene .gn-shine { fill: rgba(255, 255, 255, .13); }
.scene .gn-stripe { fill: var(--rt-gn-stripe); }
.scene .gn-mouth { fill: #0e1210; }
.scene .gn-window { fill: rgba(255, 255, 255, .1); stroke: rgba(255, 255, 255, .35); stroke-width: .7; }
.scene .gn-window.empty { stroke: var(--rt-bad); }
.scene .gn-lure { fill: #e39b3b; }
.scene .gn-led { fill: #5d6468; }
.st-armed .gn-led { fill: var(--rt-ok); animation: led 2.6s infinite; }
.st-kill .gn-led { fill: var(--rt-bad); animation: led .9s infinite; }
.st-sprung .gn-led, .st-check .gn-led { fill: var(--rt-warn); animation: led 1.6s infinite; }
.scene .puff { fill: var(--rt-metal-hi); opacity: 0; transform-box: fill-box; transform-origin: 50% 50%; }
.snap-now .puff { animation: puff .9s .2s ease-out both; }
.art-goodnature.snap-now .victim { animation: drop .45s .24s cubic-bezier(.5, 0, 1, 1) both; }

/* scene: bait station */
.art-station { --peek: 92px; }
.scene .stn-body { fill: var(--rt-stn-body); }
.scene .stn-lid { fill: var(--rt-stn-lid); }
.scene .stn-lid-hi { stroke: rgba(255, 255, 255, .22); stroke-width: 1; stroke-linecap: round; }
.scene .stn-rib { stroke: rgba(0, 0, 0, .18); stroke-width: 1.4; stroke-linecap: round; }
.scene .stn-hole { fill: var(--rt-stn-hole); }
.scene .stn-lock { fill: var(--rt-metal-hi); stroke: var(--rt-metal); stroke-width: .6; }
.scene .stn-window { fill: rgba(255, 255, 255, .16); stroke: rgba(255, 255, 255, .4); stroke-width: .8; }
.scene .stn-window.empty { stroke: var(--rt-bad); }
.scene .stn-block { fill: var(--rt-stn-block); stroke: rgba(0, 0, 0, .2); stroke-width: .6; }
.art-station.snap-now .stn-window { animation: zap .12s .28s 4 alternate both; }

/* motion */
@keyframes ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(2.6); opacity: 0; } }
@keyframes alarm { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--rt-bad) 35%, transparent); } 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--rt-bad) 0%, transparent); } }
@keyframes glow { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes ring { 0%, 55%, 100% { transform: rotate(0); } 10% { transform: rotate(16deg); } 20% { transform: rotate(-14deg); } 30% { transform: rotate(10deg); } 40% { transform: rotate(-6deg); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 50% { opacity: .25; } }
@keyframes led { 0%, 70%, 100% { opacity: 1; } 80% { opacity: .15; } }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes hold-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes float-up { 0% { opacity: 0; transform: translateY(6px); } 15% { opacity: 1; } 100% { opacity: 0; transform: translateY(-14px); } }
@keyframes wiggle { 0%, 88%, 100% { transform: rotate(0); } 91% { transform: rotate(-9deg); } 94% { transform: rotate(8deg); } 97% { transform: rotate(-4deg); } }
@keyframes peek {
  0%, 6% { transform: translateX(var(--peek)); }
  18% { transform: translateX(0); }
  23% { transform: translateX(-3px); }
  28% { transform: translateX(0); }
  33% { transform: translateX(-3px); }
  38% { transform: translateX(0); }
  52% { transform: translateX(-1px); }
  62% { transform: translateX(0); }
  74%, 100% { transform: translateX(var(--peek)); }
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
@keyframes pop { 0% { opacity: 0; transform: scale(.2); } 12% { opacity: 1; transform: scale(1.25); } 22% { transform: scale(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: scale(1); } }
@keyframes puff { 0% { opacity: .9; transform: scale(.3); } 100% { opacity: 0; transform: translateY(-4px) scale(1.8); } }
@keyframes drop { 0% { opacity: 0; transform: translateY(-16px); } 25% { opacity: 1; } 100% { transform: translateY(0); } }
@keyframes zap { 0% { fill: rgba(255, 255, 255, .16); } 100% { fill: #fff59a; } }

.paused *, .paused *::before, .paused *::after { animation-play-state: paused !important; }
.no-anim *, .no-anim *::before, .no-anim *::after { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

  // Parse the stylesheet once and share it between every card on the page.
  let sharedSheet = null;
  try {
    if ("adoptedStyleSheets" in Document.prototype && "replaceSync" in CSSStyleSheet.prototype) {
      sharedSheet = new CSSStyleSheet();
      sharedSheet.replaceSync(STYLES);
    }
  } catch (e) {
    sharedSheet = null;
  }

  // ---------------------------------------------------------------------------
  // Card
  // ---------------------------------------------------------------------------

  function normalizeConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    let traps = config.traps;
    if (traps === undefined || traps === null) {
      // Single-trap shorthand: trap options directly on the card.
      if (!config.device && !ROLE_KEYS.some((k) => config[k])) {
        throw new Error("Add at least one trap under `traps:` (see the Rodent Trap Card README).");
      }
      traps = [Object.fromEntries(TRAP_KEYS.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]))];
    }
    if (!Array.isArray(traps)) throw new Error("`traps` must be a list.");
    traps.forEach((t, i) => {
      if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`traps[${i}] must be a mapping of options.`);
      for (const k of ROLE_KEYS) {
        const v = t[k];
        if (v !== undefined && v !== null && v !== "" && v !== false && v !== "none" && !normalizeRef(v)) {
          throw new Error(`traps[${i}].${k} must be an entity id, { entity: ... } or false.`);
        }
      }
      if (t.actions !== undefined && !Array.isArray(t.actions)) throw new Error(`traps[${i}].actions must be a list.`);
      if (t.holds !== undefined && (typeof t.holds !== "object" || Array.isArray(t.holds))) throw new Error(`traps[${i}].holds must be a mapping.`);
    });
    return { ...CARD_DEFAULTS, ...config, traps };
  }

  const NO_FLAGS = { snap: false, strikesFrom: null, newStrike: false };
  const EMPTY_UI = { pending: null, busy: null, flash: null };

  class RodentTrapCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._tiles = [];
      this._summarySig = null;
      this._order = "";
      this._onClick = this._onClick.bind(this);
      this._onKey = this._onKey.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onContextMenu = this._onContextMenu.bind(this);
      this._endHold = this._endHold.bind(this);
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
      clearInterval(this._timer);
      // Relative times, staleness and flash messages depend on the clock, not just on state changes.
      this._timer = setInterval(() => {
        if (this._config && this._hass) this._update(true);
        this._refreshTimes();
      }, 30000);
      if ("IntersectionObserver" in window && !this._io) {
        this._io = new IntersectionObserver((entries) => {
          this._hidden = !entries.some((e) => e.isIntersecting);
          if (this._root) this._root.classList.toggle("paused", this._hidden);
        });
        this._io.observe(this);
      }
    }

    disconnectedCallback() {
      clearInterval(this._timer);
      this._endHold();
      this._tiles.forEach((t) => {
        clearTimeout(t.flashTimer);
        clearTimeout(t.pendingTimer);
      });
      if (this._io) {
        this._io.disconnect();
        this._io = null;
      }
    }

    _build() {
      const cfg = this._config;
      const showHeader = !!cfg.title || cfg.show_summary;
      this._tiles.forEach((t) => {
        clearTimeout(t.flashTimer);
        clearTimeout(t.pendingTimer);
      });
      if (sharedSheet) this.shadowRoot.adoptedStyleSheets = [sharedSheet];
      this.shadowRoot.innerHTML = `
        ${sharedSheet ? "" : `<style>${STYLES}</style>`}
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
      if (this._hidden) this._root.classList.add("paused");
      this._grid = this.shadowRoot.querySelector(".grid");
      this._summary = this.shadowRoot.querySelector(".summary");
      const cols = toNum(cfg.columns, 0);
      if (cols > 0) this._grid.style.gridTemplateColumns = `repeat(${Math.round(cols)}, minmax(0, 1fr))`;
      this._grid.addEventListener("click", this._onClick);
      this._grid.addEventListener("keydown", this._onKey);
      this._grid.addEventListener("pointerdown", this._onPointerDown);
      this._grid.addEventListener("pointermove", this._onPointerMove);
      this._grid.addEventListener("contextmenu", this._onContextMenu);
      this._tiles = cfg.traps.map((_, i) => {
        const el = document.createElement("div");
        el.className = "tile";
        el.dataset.index = String(i);
        return { el, sig: null, model: null, ui: { ...EMPTY_UI } };
      });
      this._summarySig = null;
      this._painted = false;
      this._order = "";
      if (!cfg.traps.length) {
        this._grid.outerHTML = `<div class="empty">No traps configured yet.</div>`;
        this._grid = null;
      }
    }

    /** True when none of the trap's entities or the registries changed since its model was built. */
    _unchanged(tile) {
      const hass = this._hass;
      const seen = tile.seen;
      if (!tile.model || !seen || seen.entities !== hass.entities || seen.devices !== hass.devices || seen.areas !== hass.areas) return false;
      const states = hass.states || {};
      return tile.model.watch.every((id, n) => states[id] === seen.refs[n]);
    }

    _update(force = false) {
      const cfg = this._config;
      if (!this._grid) return;
      const hass = this._hass;
      const states = hass.states || {};
      let changed = !this._painted;
      const models = cfg.traps.map((t, i) => {
        const tile = this._tiles[i];
        if (!force && this._unchanged(tile)) return tile.model;
        changed = true;
        const m = buildModel(hass, t, cfg, i);
        tile.seen = { entities: hass.entities, devices: hass.devices, areas: hass.areas, refs: m.watch.map((id) => states[id]) };
        tile.fresh = m;
        return m;
      });
      if (!changed) return;

      models.forEach((m, i) => {
        const tile = this._tiles[i];
        if (tile.fresh !== m) return;
        tile.fresh = null;
        const sig = JSON.stringify([m, tile.ui]);
        if (sig === tile.sig) {
          tile.model = m;
          return;
        }
        const prev = tile.model;
        const flags = {
          snap: !!prev && !["kill", "sprung"].includes(prev.scene) && ["kill", "sprung"].includes(m.scene),
          strikesFrom: prev && prev.strikes !== null && m.strikes !== null && m.strikes > prev.strikes ? prev.strikes : null,
          newStrike: !!(prev && prev.lastStrike && m.lastStrike && Date.parse(m.lastStrike) > Date.parse(prev.lastStrike)),
        };
        tile.model = m;
        this._paint(i, flags);
        if (flags.strikesFrom !== null) this._countUp(tile.el);
      });

      const order = this._sorted(models).map((m) => m.index);
      const orderKey = order.join(",");
      if (orderKey !== this._order) {
        this._order = orderKey;
        order.forEach((idx, pos) => {
          const el = this._tiles[idx].el;
          if (this._grid.children[pos] !== el) this._grid.insertBefore(el, this._grid.children[pos] || null);
        });
      }

      this._painted = true;
      if (this._summary) {
        const html = renderSummary(models);
        if (html !== this._summarySig) {
          this._summary.innerHTML = html;
          this._summarySig = html;
        }
      }
    }

    _paint(i, flags = NO_FLAGS) {
      const tile = this._tiles[i];
      const m = tile.model;
      if (!m) return;
      tile.el.className = `tile s-${m.status}`;
      tile.el.innerHTML = renderTile(m, this._config, flags, tile.ui);
      tile.sig = JSON.stringify([m, tile.ui]);
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
      const step = (now) => {
        const p = Math.min(1, (now - start) / 900);
        el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
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

    // --- actions -------------------------------------------------------------

    _setUi(i, patch) {
      const tile = this._tiles[i];
      tile.ui = { ...tile.ui, ...patch };
      this._paint(i);
    }

    _actionFor(i, kind, key) {
      const m = this._tiles[i] && this._tiles[i].model;
      if (!m) return null;
      return kind === "hold" ? m.holds[key] : m.actions[Number(key)];
    }

    _request(i, kind, key) {
      const act = this._actionFor(i, kind, key);
      if (!act) return;
      if (!act.confirm) {
        this._perform(i, kind, key);
        return;
      }
      const tile = this._tiles[i];
      clearTimeout(tile.pendingTimer);
      this._setUi(i, { pending: { kind, key }, flash: null });
      const yes = tile.el.querySelector('[data-confirm="yes"]');
      if (yes) yes.focus({ preventScroll: true });
      tile.pendingTimer = setTimeout(() => this._setUi(i, { pending: null }), 10000);
    }

    async _perform(i, kind, key) {
      const act = this._actionFor(i, kind, key);
      if (!act) return;
      const tile = this._tiles[i];
      const id = `${kind}:${key}`;
      clearTimeout(tile.pendingTimer);
      if (!act.call) {
        this._flash(i, "err", `Can't run ${act.name}: give it an \`action:\` (for example button.press).`, id);
        return;
      }
      this._setUi(i, { pending: null, busy: id, flash: null });
      try {
        await this._hass.callService(act.call.domain, act.call.service, act.call.data, act.call.target);
        this._flash(i, "ok", `${act.name}: done`, id);
      } catch (e) {
        const msg = `${act.name} failed: ${(e && (e.message || e.error)) || e}`;
        this._flash(i, "err", msg, id);
        this.dispatchEvent(new CustomEvent("hass-notification", { bubbles: true, composed: true, detail: { message: msg } }));
      }
    }

    _flash(i, kind, msg, id) {
      const tile = this._tiles[i];
      clearTimeout(tile.flashTimer);
      this._setUi(i, { busy: null, pending: null, flash: { kind, msg, id } });
      tile.flashTimer = setTimeout(() => this._setUi(i, { flash: null }), kind === "err" ? 6000 : 2500);
    }

    // --- input ---------------------------------------------------------------

    _tileIndex(node) {
      const tile = node && node.closest ? node.closest(".tile") : null;
      return tile ? Number(tile.dataset.index) : -1;
    }

    _onClick(ev) {
      // Swallow the click that ends a long-press (it would open more-info, or hit the new Confirm button).
      // Keyboard clicks have detail 0; a genuine tap always has its own pointerdown after the hold.
      if (ev.detail > 0 && this._holdAt && !(this._lastDown > this._holdAt)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const path = ev.composedPath();
      const find = (attr) => path.find((n) => n instanceof HTMLElement && n.hasAttribute(attr));
      const confirm = find("data-confirm");
      const act = find("data-act");
      const target = find("data-entity");
      const node = confirm || act || target;
      if (!node) return;
      ev.stopPropagation();
      const i = this._tileIndex(node);
      if (confirm) {
        const pending = this._tiles[i] && this._tiles[i].ui.pending;
        if (confirm.dataset.confirm === "yes" && pending) this._perform(i, pending.kind, pending.key);
        else this._setUi(i, { pending: null });
      } else if (act) {
        this._request(i, "act", act.dataset.act);
      } else {
        this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: target.dataset.entity } }));
      }
    }

    _onKey(ev) {
      const el = ev.target;
      if (!(el instanceof HTMLElement) || el.tagName === "BUTTON") return;
      if (el.dataset.hold && ((ev.key === "Enter" && ev.shiftKey) || ev.key === "ContextMenu")) {
        ev.preventDefault();
        this._request(this._tileIndex(el), "hold", el.dataset.hold);
        return;
      }
      if ((ev.key === "Enter" || ev.key === " ") && el.dataset.entity) {
        ev.preventDefault();
        this._onClick(ev);
      }
    }

    _onPointerDown(ev) {
      this._pointerType = ev.pointerType;
      this._lastDown = performance.now();
      this._gestureHeld = false;
      const el = ev.composedPath().find((n) => n instanceof HTMLElement && n.dataset && n.dataset.hold);
      if (!el || ev.button !== 0) return;
      this._endHold();
      const index = this._tileIndex(el);
      const key = el.dataset.hold;
      this._holdEl = el;
      this._holdStart = [ev.clientX, ev.clientY];
      el.classList.add("holding");
      window.addEventListener("pointerup", this._endHold, { once: true });
      window.addEventListener("pointercancel", this._endHold, { once: true });
      this._holdTimer = setTimeout(() => {
        this._gestureHeld = true;
        this._holdAt = performance.now();
        this._endHold();
        this._request(index, "hold", key);
      }, HOLD_MS);
    }

    _onPointerMove(ev) {
      if (!this._holdEl || !this._holdStart) return;
      if (Math.hypot(ev.clientX - this._holdStart[0], ev.clientY - this._holdStart[1]) > 12) this._endHold();
    }

    _endHold() {
      clearTimeout(this._holdTimer);
      if (this._holdEl) this._holdEl.classList.remove("holding");
      this._holdEl = null;
      this._holdStart = null;
      window.removeEventListener("pointerup", this._endHold);
      window.removeEventListener("pointercancel", this._endHold);
    }

    _onContextMenu(ev) {
      const el = ev.composedPath().find((n) => n instanceof HTMLElement && n.dataset && n.dataset.hold);
      if (!el) return;
      ev.preventDefault();
      // A right-click stands in for a hold. On touch, whichever of the long-press menu and the hold timer comes first wins.
      if (this._gestureHeld) return;
      this._gestureHeld = true;
      this._holdAt = performance.now();
      this._endHold();
      this._request(this._tileIndex(el), "hold", el.dataset.hold);
    }
  }

  /** Starter config: devices that look like traps, else entities whose ids mention a trap. */
  function discoverTraps(hass) {
    if (hass && hass.devices && hass.entities) {
      const devices = Object.values(hass.devices).filter((d) =>
        /(trap|goodnature|smart.?kill|rodent|\bmouse\b|\brat\b)/i.test(`${d.name_by_user || ""} ${d.name || ""} ${d.model || ""} ${d.manufacturer || ""}`)
      );
      if (devices.length) return devices.slice(0, 4).map((d) => ({ device: d.id }));
    }
    const roles = [
      ["battery", /batt/],
      ["strikes", /(total_kills|kill_count|kills_total|strikes?|catches|catch_count|count)/],
      ["kill", /(kills?_present|kill|catch|caught|captured|occupied|triggered|alarm|alert)/],
      ["bait", /(bait|cheese|lure)/],
      ["rearm", /(re_?arm|sprung|reset)/],
      ["armed", /armed/],
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
    style: "Illustration",
    battery_low: "Low battery at or below (%)",
    bait_low: "Low bait at or below (%)",
    stale_after: "Mark stale when not seen for",
    offline_after: "Mark offline when not seen for",
    device: "Device",
    name: "Name",
    location: "Location",
    kill: "Catch / kill alert",
    armed: "Armed",
    rearm: "Needs re-arm",
    strikes: "Strikes (count)",
    last_strike: "Last strike",
    battery: "Battery",
    bait: "Bait remaining",
    online: "Online / connectivity",
    last_seen: "Last seen",
    actions: "Buttons on the tile",
    hold_kill: "Hold Catch to run",
    hold_trap: "Hold Trap to run",
    hold_bait: "Hold Bait to run",
    hold_link: "Hold Link / Last seen to run",
  };

  const EDITOR_HELPERS = {
    device: "Fills in any entity you leave blank below by matching the device's entity names and device classes.",
    kill: "Binary sensor (on = caught), or a sensor whose value > 0 or \u201ccaught\u201d.",
    armed: "On = armed. Use this or Needs re-arm (or both, and the card flags any disagreement).",
    rearm: "On = needs re-arming. Status sensors like \u201csprung\u201d work too.",
    strikes: "Total catches or trigger count. An event entity is shown as Last strike.",
    last_strike: "Event entity or timestamp sensor.",
    battery: "Percentage sensor, or a binary battery sensor (on = low).",
    bait: "Percentage, a value with a min\u2013max range, words like \u201chalf\u201d, or a binary sensor (on = low).",
    online: "Connectivity sensor or Z-Wave node status. Leave blank to infer from the other entities.",
    last_seen: "Timestamp sensor. Combine with the stale/offline thresholds.",
    actions: "Buttons, scripts or scenes. Pressing one runs it straight away.",
  };

  const entitySel = (domains, extra = {}) => ({ entity: { filter: { domain: domains }, ...extra } });
  const ACTION_DOMAINS = ["button", "input_button", "script", "scene", "automation", "switch", "input_boolean"];
  const STYLE_OPTIONS = [
    { value: "snap", label: "Snap trap" },
    { value: "goodnature", label: "Goodnature / CO\u2082 trap" },
    { value: "station", label: "Bait station" },
  ];
  const pct = { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } };
  const duration = { duration: { enable_day: true } };

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
    { name: "style", selector: { select: { mode: "dropdown", options: STYLE_OPTIONS } } },
    { name: "", type: "grid", schema: [{ name: "battery_low", selector: pct }, { name: "bait_low", selector: pct }] },
    { name: "", type: "grid", schema: [{ name: "stale_after", selector: duration }, { name: "offline_after", selector: duration }] },
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

  const HOLD_FIELDS = ["kill", "trap", "bait", "link"];

  const TRAP_SCHEMA = [
    { name: "device", selector: { device: {} } },
    { name: "", type: "grid", schema: [{ name: "name", selector: { text: {} } }, { name: "location", selector: { text: {} } }] },
    { name: "style", selector: { select: { mode: "dropdown", options: [{ value: "auto", label: "Card default / detect from device" }, ...STYLE_OPTIONS] } } },
    {
      name: "",
      type: "expandable",
      title: "Entities",
      expanded: true,
      schema: [
        { name: "kill", selector: entitySel(["binary_sensor", "sensor", "input_boolean", "switch"]) },
        { name: "armed", selector: entitySel(["binary_sensor", "sensor", "input_boolean", "switch", "input_select", "select"]) },
        { name: "rearm", selector: entitySel(["binary_sensor", "sensor", "input_boolean", "switch", "input_select", "select"]) },
        { name: "strikes", selector: entitySel(["sensor", "counter", "input_number", "number", "event"]) },
        { name: "last_strike", selector: entitySel(["event", "sensor", "input_datetime"]) },
        { name: "battery", selector: entitySel(["sensor", "binary_sensor"]) },
        { name: "bait", selector: entitySel(["sensor", "binary_sensor", "input_number", "number", "input_select", "select"]) },
        { name: "online", selector: entitySel(["binary_sensor", "sensor", "device_tracker"]) },
        { name: "last_seen", selector: entitySel(["sensor", "input_datetime"]) },
      ],
    },
    {
      name: "",
      type: "expandable",
      title: "Actions",
      schema: [
        { name: "actions", selector: entitySel(ACTION_DOMAINS, { multiple: true }) },
        ...HOLD_FIELDS.map((k) => ({ name: `hold_${k}`, selector: entitySel(ACTION_DOMAINS) })),
      ],
    },
    {
      name: "",
      type: "expandable",
      title: "Thresholds",
      schema: [
        { name: "", type: "grid", schema: [{ name: "battery_low", selector: pct }, { name: "bait_low", selector: pct }] },
        { name: "", type: "grid", schema: [{ name: "stale_after", selector: duration }, { name: "offline_after", selector: duration }] },
      ],
    },
  ];

  const TRAP_FORM_KEYS = ["device", "name", "location", "style", ...ROLE_KEYS, "battery_low", "bait_low", "stale_after", "offline_after"];
  const DURATION_KEYS = ["stale_after", "offline_after"];

  /** The duration selector wants { days, hours, minutes, seconds }; YAML may say "12h" or 12. */
  function durationObject(v) {
    const ms = parseDuration(v);
    if (!ms) return undefined;
    let s = Math.round(ms / 1000);
    const days = Math.floor(s / 86400);
    s -= days * 86400;
    const hours = Math.floor(s / 3600);
    s -= hours * 3600;
    return { days, hours, minutes: Math.floor(s / 60), seconds: s % 60 };
  }

  /** Keep the user's own spelling of a duration unless its value actually changed. */
  function keepDuration(original, v) {
    return original !== undefined && parseDuration(original) === parseDuration(v) ? original : v;
  }

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
    .section-title { font-weight: 500; margin: 20px 0 8px; }
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

  /** trap.holds keyed by canonical reading (kill/trap/bait/link), whatever alias the YAML used. */
  function canonicalHolds(holds) {
    const out = {};
    if (!holds || typeof holds !== "object") return out;
    for (const [k, v] of Object.entries(holds)) if (HOLD_KEYS[k]) out[HOLD_KEYS[k]] = { key: k, value: v };
    return out;
  }

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
      const data = { ...CARD_DEFAULTS, ...rest };
      for (const k of DURATION_KEYS) data[k] = durationObject(data[k]);
      return data;
    }

    _trapData(trap) {
      const data = {};
      for (const k of TRAP_FORM_KEYS) {
        const v = trap[k];
        if (v === undefined || v === null || v === false) continue;
        data[k] = ROLE_KEYS.includes(k) && typeof v === "object" ? v.entity : v;
      }
      if (!data.style) data.style = "auto";
      for (const k of DURATION_KEYS) data[k] = durationObject(data[k]);
      const actions = (Array.isArray(trap.actions) ? trap.actions : []).map((a) => (typeof a === "string" ? a : a && a.entity)).filter(Boolean);
      if (actions.length) data.actions = actions;
      const holds = canonicalHolds(trap.holds);
      for (const k of HOLD_FIELDS) {
        const h = holds[k] && holds[k].value;
        const id = typeof h === "string" ? h : h && typeof h === "object" ? h.entity : null;
        if (id) data[`hold_${k}`] = id;
      }
      return data;
    }

    /** Explains, per field, which entity the chosen device supplies when the field is left blank. */
    _helper(i, name) {
      const trap = this._config.traps[i] || {};
      if (trap.device && ROLE_KEYS.includes(name) && trap[name] === undefined) {
        const found = discoverDevice(this._hass, trap.device);
        const id = found.roles[name] || (name === "battery" && found.roles.battery_low);
        if (id) return `From device: ${id}`;
      }
      if (trap.device && name.startsWith("hold_")) {
        const holds = canonicalHolds(trap.holds);
        const key = name.slice(5);
        const id = discoverDevice(this._hass, trap.device).holds[key];
        if (id && !holds[key]) return `From device: ${id} (asks to confirm)`;
      }
      if (name.startsWith("hold_")) return "Asks for confirmation before running.";
      return EDITOR_HELPERS[name];
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
      note.textContent = "Pick a device to fill in the entities automatically, or choose them yourself. Every entity is optional.";
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
        form.computeHelper = (s) => this._helper(i, s.name);
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
      const dev = t.device ? deviceInfo(this._hass, t.device) : { name: "", area: "" };
      const name = t.name || dev.name || `Trap ${i + 1}`;
      const loc = typeof t.location === "string" && t.location ? t.location : t.location === undefined ? dev.area : "";
      label.innerHTML = `${esc(name)}${loc ? `<small>${esc(loc)}</small>` : ""}`;
    }

    _generalChanged(ev) {
      ev.stopPropagation();
      const value = ev.detail.value || {};
      const next = { ...this._config };
      for (const key of ["title", "show_summary", "show_scene", "animations", "sort", "columns", "style", "battery_low", "bait_low", "stale_after", "offline_after"]) {
        const v = value[key];
        if (v === undefined || v === null || v === "" || v === CARD_DEFAULTS[key] || (DURATION_KEYS.includes(key) && !parseDuration(v))) delete next[key];
        else next[key] = DURATION_KEYS.includes(key) ? keepDuration(this._config[key], v) : v;
      }
      this._commit(next);
    }

    _trapChanged(ev, i) {
      ev.stopPropagation();
      const value = ev.detail.value || {};
      const original = this._config.traps[i] || {};
      const trap = { ...original };
      for (const k of TRAP_FORM_KEYS) {
        const v = value[k];
        const empty = v === undefined || v === null || v === "" || (k === "style" && v === "auto") || (DURATION_KEYS.includes(k) && !parseDuration(v));
        if (empty && original[k] === false) continue;
        if (ROLE_KEYS.includes(k) && original[k] && typeof original[k] === "object") {
          if (empty) delete trap[k];
          else trap[k] = { ...original[k], entity: v };
        } else if (empty) {
          delete trap[k];
        } else {
          trap[k] = DURATION_KEYS.includes(k) ? keepDuration(original[k], v) : v;
        }
      }

      // Buttons: keep object-form entries (names, icons, confirm) for entities still selected, and any service-only entries.
      const picked = Array.isArray(value.actions) ? value.actions : [];
      const objects = (Array.isArray(original.actions) ? original.actions : []).filter((a) => a && typeof a === "object");
      const actions = picked.map((id) => objects.find((o) => o.entity === id) || id).concat(objects.filter((o) => !o.entity));
      if (actions.length) trap.actions = actions;
      else delete trap.actions;

      // Hold actions: written under their canonical key, preserving object form and explicit `false`.
      const holds = { ...(original.holds && typeof original.holds === "object" ? original.holds : {}) };
      const current = canonicalHolds(original.holds);
      for (const k of HOLD_FIELDS) {
        const v = value[`hold_${k}`];
        const prev = current[k];
        if (prev) delete holds[prev.key];
        if (v) holds[k] = prev && prev.value && typeof prev.value === "object" ? { ...prev.value, entity: v } : v;
        else if (prev && (prev.value === false || (prev.value && typeof prev.value === "object" && !prev.value.entity))) holds[prev.key] = prev.value;
      }
      if (Object.keys(holds).length) trap.holds = holds;
      else delete trap.holds;

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
      const traps = this._config.traps.concat([{}]);
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
    `%c RODENT-TRAP-CARD %c ${VERSION} `,
    "color:#fff;background:#a8703a;font-weight:700;border-radius:3px 0 0 3px",
    "color:#a8703a;background:#f7c948;font-weight:700;border-radius:0 3px 3px 0"
  );
})();

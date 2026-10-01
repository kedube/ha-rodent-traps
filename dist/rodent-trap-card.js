/*!
 * Rodent Trap Card - a Home Assistant dashboard card for smart rodent traps.
 * https://github.com/kedube/ha-rodent-traps
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(() => {
  "use strict";

  const VERSION = "1.3";
  const CARD_TAG = "rodent-trap-card";
  const EDITOR_TAG = "rodent-trap-card-editor";

  // Entity roles a trap can fill.
  const ROLE_KEYS = ["kill", "armed", "rearm", "strikes", "last_strike", "battery", "bait", "co2", "online", "last_seen", "signal"];
  const TRAP_KEYS = ["device", "name", "location", "style", ...ROLE_KEYS, "holds", "actions", "battery_low", "bait_low", "co2_low", "stale_after", "offline_after"];
  // Options that only make sense on a trap. In the single-trap form they sit on the card itself, along with `style`.
  const TRAP_ONLY_KEYS = ["device", "name", "location", ...ROLE_KEYS, "holds", "actions"];
  const SHORTHAND_KEYS = TRAP_KEYS.filter((k) => k === "style" || TRAP_ONLY_KEYS.includes(k));
  const TRAP_STYLES = ["snap", "goodnature", "station"];
  const STYLE_WORDS = [...TRAP_STYLES, "auto"];
  const SORT_ORDERS = ["config", "status", "name"];
  const DURATION_KEYS = ["stale_after", "offline_after"];
  // Readings on a tile, in display order. "trap" combines armed + rearm, and "link" shows online.
  const METRIC_ORDER = ["strikes", "last_strike", "battery", "bait", "co2", "kill", "trap", "link", "last_seen", "signal"];
  /** The entity role a reading shows, for every reading but "trap". */
  const roleOf = (key) => (key === "link" ? "online" : key);
  // Lookup tables keyed by user input have no prototype, so "constructor" or "toString" isn't found in them.
  const HOLD_KEYS = {
    __proto__: null, kill: "kill", catch: "kill", trap: "trap", armed: "trap", rearm: "trap", strikes: "strikes", last_strike: "last_strike",
    battery: "battery", bait: "bait", co2: "co2", link: "link", online: "link", last_seen: "last_seen", signal: "signal",
  };
  const HOLD_MS = 550;
  // A Goodnature A24 CO2 canister: the full mark for a shot count that has no capacity of its own.
  const CO2_SHOTS = 24;

  const CARD_DEFAULTS = {
    title: "",
    show_summary: true,
    show_scene: true,
    animations: true,
    sort: "config",
    style: "snap",
    battery_low: 20,
    bait_low: 25,
    co2_low: 20,
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
  // Helper entities live in Home Assistant itself and never go unavailable. `number` is left out: devices have those.
  const HELPER_DOMAINS = /^(counter|input_[a-z_]+|timer|schedule)$/;
  const DASH = "\u2014";
  const DOT = "\u00b7";

  const DURATION_SECONDS = {
    __proto__: null,
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
    String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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

  // One "<number><unit>" part of a written duration ("1d", "12 h", "30min"), then a comma, spaces or "and".
  const DURATION_PART = /(\d+(?:\.\d+)?|\.\d+) *([a-z]+)(?: *, *| +and +| *)/y;
  const DURATION_OBJECT_KEYS = { __proto__: null, days: 86400, hours: 3600, minutes: 60, seconds: 1, milliseconds: 0.001 };

  /**
   * A duration in ms (0 included), or null when it can't be read. Accepts hours as a number, "90m", "12h", "1d 12h",
   * "2 days and 3 hours", "36:00:00", "1 day, 12:00:00" or { days, hours, minutes, seconds }.
   */
  function durationMs(v) {
    if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v * 3600000 : null;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      let secs = 0;
      for (const [k, n] of Object.entries(v)) {
        if (n === null || n === undefined || n === "") continue;
        const x = toNum(n, NaN);
        if (!DURATION_OBJECT_KEYS[k] || !(x >= 0)) return null;
        secs += x * DURATION_OBJECT_KEYS[k];
      }
      return secs * 1000;
    }
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase();
    // A bare number is hours.
    if (/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return parseFloat(s) * 3600000;
    // h:mm[:ss], optionally after "N days," the way Home Assistant and Python write a long duration.
    let m = s.match(/^(?:(\d+) *days?,? *)?(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
    if (m) return (Number(m[1] || 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] || 0)) * 1000;
    // Otherwise the whole string must be numbers with units. "m" is minutes here; months are "mo".
    let secs = 0;
    let at = 0;
    DURATION_PART.lastIndex = 0;
    while (at < s.length && (m = DURATION_PART.exec(s))) {
      const unit = DURATION_SECONDS[m[2]] || (m[2] === "m" ? 60 : 0);
      if (!unit) return null;
      secs += parseFloat(m[1]) * unit;
      at = DURATION_PART.lastIndex;
    }
    return at > 0 && at === s.length ? secs * 1000 : null;
  }

  /** A threshold in ms, or null when it is unset, zero, turned off or unreadable. */
  function parseDuration(v) {
    const ms = durationMs(v);
    return ms > 0 ? ms : null;
  }

  /** A threshold turned off on purpose: on the card, or on one trap to override the card's. */
  const isOff = (v) => v === false || v === null || v === 0 || (typeof v === "string" && ["", "0", "none", "off", "never"].includes(v.trim().toLowerCase()));

  /** A style or sort value as the card compares it: "Goodnature" is "goodnature". */
  const keyword = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

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
    // Round before choosing the unit, so 59.6 minutes reads "1 h ago", not "60 min ago".
    const min = Math.round(s / 60);
    if (min < 60) return `${min} min ago`;
    const h = Math.round(s / 3600);
    if (h < 24) return `${h} h ago`;
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

  /** The display precision Home Assistant has for an entity's state; none for an attribute. */
  function precisionOf(hass, ref) {
    const reg = !ref.attribute && hass && hass.entities ? hass.entities[ref.entity] : null;
    return reg && Number.isInteger(reg.display_precision) ? reg.display_precision : undefined;
  }

  /** `fullAt` is the full mark for a reading that is neither a percentage nor a helper with a range of its own. */
  function interpretLevel(hass, r, threshold, lowRead, fullAt = 100) {
    const out = { level: null, text: null, low: null, empty: false, deviceLow: false };
    if (r && !r.missing && !r.unknown) {
      const { ref, raw, stateObj, domain } = r;
      const attrs = stateObj.attributes || {};
      const s = norm(raw);
      const n = typeof raw === "number" ? raw : s !== "" ? Number(raw) : NaN;
      if (Number.isFinite(n)) {
        const unit = ref.unit !== undefined ? ref.unit : ref.attribute ? "" : attrs.unit_of_measurement || "";
        const given = (v) => v !== undefined && v !== null && v !== "";
        // input_number / number helpers carry their own range; an explicit min or max still wins.
        const helperMax = toNum(attrs.max, NaN);
        const helper = !ref.attribute && unit !== "%" && (domain === "input_number" || domain === "number") && Number.isFinite(helperMax);
        const min = resolveNum(hass, ref.min, helper ? toNum(attrs.min, 0) : 0);
        const max = resolveNum(hass, ref.max, helper ? helperMax : unit === "%" ? 100 : fullAt);
        // A voltage has no percentage until the user says what empty and full are.
        const voltage = /^m?v$/i.test(String(unit).trim()) || (!ref.attribute && attrs.device_class === "voltage");
        const ranged = max > min && !(voltage && !given(ref.min) && !given(ref.max));
        const fmt = { precision: precisionOf(hass, ref), displayUnit: ref.display_unit };
        if (!ranged) {
          // No usable range (a max entity reporting 0, say): show the value, but don't call it low or empty.
          out.text = unit === "%" ? `${formatNumber(n, "", fmt)}%` : formatNumber(n, unit, fmt);
        } else {
          out.level = clamp(((n - min) / (max - min)) * 100, 0, 100);
          if (unit && unit !== "%") out.text = formatNumber(n, unit, fmt);
          else if (!unit && max !== 100) out.text = `${formatNumber(n, "", fmt)}/${formatNumber(max, "")}`;
          else out.text = `${Math.round(out.level)}%`;
          out.low = out.level <= threshold;
          out.empty = out.level <= 0;
        }
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

  /**
   * Signal strength as 0-4 bars, one for every fifth of its span: dBm (or a negative number without a unit) spans
   * -100 to -50, Zigbee LQI (or a positive number without a unit) 0 to 255, and a percentage 0 to 100. `min` and
   * `max` change the span. Anything above the bottom of it is at least one bar: a weak link still works.
   */
  function interpretSignal(hass, r) {
    const out = { bars: null, text: null };
    if (!r || r.missing || r.unknown) return out;
    const { ref, raw, stateObj } = r;
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
      out.text = titleCase(raw);
      return out;
    }
    const attrs = stateObj.attributes || {};
    const unit = String(ref.unit !== undefined ? ref.unit : ref.attribute ? "" : attrs.unit_of_measurement || "").trim();
    const span = /^dbm$/i.test(unit) || (/^(db)?$/i.test(unit) && n < 0) ? [-100, -50] : unit === "%" ? [0, 100] : /^(lqi)?$/i.test(unit) ? [0, 255] : [];
    const min = resolveNum(hass, ref.min, span[0]);
    const max = resolveNum(hass, ref.max, span[1]);
    if (max > min) {
      const level = ((n - min) / (max - min)) * 100;
      out.bars = level > 0 ? clamp(Math.floor(level / 20), 1, 4) : 0;
    }
    const fmt = { precision: precisionOf(hass, ref) };
    out.text = unit === "%" ? `${formatNumber(n, "", fmt)}%` : formatNumber(n, /^lqi$/i.test(unit) ? "LQI" : unit, fmt);
    return out;
  }

  /** An ISO string for a time in ms, or null when it isn't a real date (new Date(1e20) is Invalid Date). */
  function isoTime(ms) {
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  /** Epoch number to ms, scaled by its size: nanoseconds, microseconds, milliseconds or seconds. */
  function epochMs(n) {
    if (!Number.isFinite(n) || n <= 1e9) return NaN;
    return n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n > 1e11 ? n : n * 1000;
  }

  /** A timestamp state (sensor/event/input_datetime or an epoch number), else the entity's own change time. */
  function readTime(r, fallback) {
    if (!r || r.missing || r.unknown) return null;
    const attrs = r.stateObj.attributes || {};
    // input_datetime states are wall-clock times in the server's time zone; its timestamp attribute is the real
    // instant. A date-only helper's timestamp depends on the server process, so the state is read for those below.
    if (r.domain === "input_datetime" && !r.ref.attribute && attrs.has_date && attrs.has_time) {
      const t = isoTime(toNum(attrs.timestamp, NaN) * 1000);
      if (t) return t;
    }
    let raw = typeof r.raw === "string" ? r.raw.trim() : r.raw;
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      // A bare date is local midnight, not UTC midnight (which Date.parse would give).
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += "T00:00:00";
      const t = Date.parse(raw.replace(" ", "T"));
      if (Number.isFinite(t)) return isoTime(t);
    }
    if (typeof raw === "number" || (typeof raw === "string" && /^\d{10,19}(\.\d+)?$/.test(raw))) {
      const t = isoTime(epochMs(Number(raw)));
      if (t) return t;
    }
    const so = r.stateObj;
    return (fallback === "updated" ? so.last_updated || so.last_changed : so.last_changed) || null;
  }

  // ---------------------------------------------------------------------------
  // Device discovery
  // ---------------------------------------------------------------------------

  // Checked in order; each entity takes at most one role and each role one entity. `dc` requires a device class and
  // `notDc` rules one out. Patterns match slugged names ("goodnature_trap_1_kill_alert") and start a word with (^|_),
  // not a lookbehind, which older iOS Safari can't parse: "alarm_state" is not "arm_state".
  const DISCOVERY_RULES = [
    { role: "kill", domains: ["binary_sensor", "sensor"], re: /(kill_alert|kill_detected|kills?_present|catch_(detected|alert)|caught|captured|rodent_detected|kill_status)/ },
    { role: "strikes", domains: ["sensor", "counter"], re: /((^|_)(strikes?|catches|kills)(_count|_total)?$|total_(kills|strikes|catches)|(kill|strike|catch)_count)/, not: /last_strikes?$/, notDc: "timestamp" },
    { role: "last_strike", domains: ["event"], re: /(strike|kill|catch|trigger)/ },
    { role: "last_strike", domains: ["sensor"], dc: "timestamp", re: /last_(strike|kill|catch|trigger)/ },
    { role: "armed", domains: ["binary_sensor", "sensor"], re: /((^|_)armed$|(^|_)trap_armed|(^|_)is_armed|(^|_)arm(ed)?_state)/, not: /((^|_)re_?arm|disarm)/ },
    { role: "rearm", domains: ["binary_sensor", "sensor"], re: /((^|_)re_?arm(_required|_needed)?$|needs_re_?arm|(^|_)re_?arm_required)/ },
    { role: "battery_low", domains: ["binary_sensor"], dc: "battery" },
    { role: "battery_low", domains: ["binary_sensor", "sensor"], re: /(battery_low|low_battery)/ },
    { role: "battery", domains: ["sensor"], dc: "battery", not: /(low|voltage)/ },
    { role: "battery", domains: ["sensor"], re: /battery(_level|_percent(age)?)?$/, not: /(low|voltage)/, notDc: "voltage" },
    { role: "bait_low", domains: ["binary_sensor", "sensor"], re: /((lure|bait)_(due|low|empty|replace|replacement)|replace_(lure|bait))/ },
    { role: "bait_max", domains: ["number", "sensor"], re: /(lure|bait)_(life|lifetime|duration|capacity|max)$/ },
    { role: "bait", domains: ["sensor", "number"], re: /((lure|bait)_(remaining|level|left|days_left|life_remaining)|remaining_(lure|bait)|(^|_)(lure|bait)$)/ },
    // CO2 shots left in a gas-powered trap's canister. Not a CO2 concentration sensor.
    { role: "co2_low", domains: ["binary_sensor", "sensor"], re: /(^|_)((co2|canister|cartridge)_(low|due|empty)|replace_(co2|canister|cartridge))$/ },
    { role: "co2_max", domains: ["number", "sensor"], re: /(^|_)((co2|canister|cartridge)_(capacity|max)|shots_per_(canister|cartridge))$/ },
    { role: "co2", domains: ["sensor", "number"], re: /(^|_)(co2(_shots?)?(_remaining|_left|_level)?|(canister|cartridge|gas)_(shots_)?(remaining|left|level)|(shots?|strikes?)_(remaining|left))$/, notDc: "carbon_dioxide" },
    { role: "online", domains: ["binary_sensor"], dc: "connectivity" },
    { role: "online", domains: ["binary_sensor", "sensor"], re: /(^|_)(online|connectivity|connected|connection(_state|_status)?|availability)$/ },
    { role: "online", domains: ["sensor"], re: /node_status$/ },
    { role: "last_seen", domains: ["sensor"], re: /last_(seen|report(ed)?|heard|contact|activity|communication)/ },
    { role: "signal", domains: ["sensor"], dc: "signal_strength" },
    { role: "signal", domains: ["sensor"], re: /(^|_)(rssi|lqi|link_?quality|((wifi|wireless|radio)_)?signal(_strength|_level|_quality)?)$/ },
    // Hold buttons must end with the action, so "Reset kill count" is not taken for clearing the catch alert.
    { hold: "kill", domains: ["button", "input_button", "script"], re: /(^|_)(clear_(kill|catch|alert)(_alert)?|(kill|catch)_(alert_)?(clear|reset)|reset_(kill|catch)(_alert)?)$/ },
    { hold: "bait", domains: ["button", "input_button", "script"], re: /(^|_)((lure|bait)_(replaced|refilled|reset|changed|replace)|replace(d)?_(lure|bait)|refill(ed)?)$/ },
    // "CO2 Canister Replaced", not "CO2 Shot Used".
    { hold: "co2", domains: ["button", "input_button", "script"], re: /(^|_)((co2|canister|cartridge)(_canister|_cartridge)?_(replaced|changed|reset)|replace(d)?_(co2|canister|cartridge))$/ },
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
    const devs = hass && hass.devices;
    const d = devs ? devs[deviceId] : null;
    // A child device (Home Assistant 2026.9+, e.g. one trap on a hub) without its own area is in its parent's.
    const parent = d && d.parent_device_id ? devs[d.parent_device_id] : null;
    const areaId = d && (d.area_id || (parent && parent.area_id));
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
    // friendly_name can be customised to a number (a year, say), which has no string methods.
    const fn = st && st.attributes ? st.attributes.friendly_name : null;
    const full = fn !== undefined && fn !== null && fn !== "" ? String(fn) : titleCase(entityId.split(".")[1] || entityId);
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
          (!rule.notDc || e.dc !== rule.notDc) &&
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
    __proto__: null,
    button: "press", input_button: "press", script: "turn_on", scene: "turn_on", automation: "trigger",
    switch: "toggle", input_boolean: "toggle", light: "toggle", fan: "toggle",
  };
  // A service name has exactly one dot: "counter.reset", "zwave_js.ping".
  const SERVICE_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;
  // Home Assistant's `action:` words that a trap button can carry out. Others (more-info, navigate, url, assist,
  // fire-dom-event) are config errors: a trap button that quietly pressed its entity instead would do the wrong thing.
  const ACTION_WORDS = ["none", "toggle", "perform-action", "call-service"];

  /** The service an action names, from Home Assistant's perform_action (2024.8+) or service, or the card's `action`. */
  function serviceOf(a) {
    for (const v of [a.perform_action, a.service, a.action]) {
      if (typeof v === "string" && SERVICE_RE.test(v.trim())) return v.trim();
    }
    return null;
  }

  /** The one entity an action is about: its `entity`, else a single target entity. */
  function actionEntity(a) {
    if (typeof a.entity === "string" && a.entity.trim()) return a.entity.trim();
    return a.target && typeof a.target.entity_id === "string" && a.target.entity_id.trim() ? a.target.entity_id.trim() : null;
  }

  function actionCall(a) {
    const svc = serviceOf(a);
    const entity = actionEntity(a);
    if (svc) {
      const [domain, service] = svc.split(".");
      return { domain, service, data: a.data || a.service_data || {}, target: a.target || (entity ? { entity_id: entity } : undefined) };
    }
    // Without a service, an entity is pressed, run or toggled, like Home Assistant's toggle action. Any other
    // action word, or a perform_action or service that isn't a service name, runs nothing rather than guessing.
    const unset = (v) => v === undefined || v === null || v === "";
    const how = typeof a.action === "string" ? a.action.trim() : a.action;
    const plain = (unset(how) || how === "toggle") && unset(a.perform_action) && unset(a.service);
    const domain = entity ? entity.split(".")[0] : "";
    return plain && PRESS_SERVICES[domain] ? { domain, service: PRESS_SERVICES[domain], data: {}, target: { entity_id: entity } } : null;
  }

  /** A tile action from an entity id or an action mapping. Null for `none`, which also turns off a device's hold. */
  function makeAction(hass, spec, confirmDefault) {
    const a = typeof spec === "string" ? { entity: spec.trim() } : spec && typeof spec === "object" && !Array.isArray(spec) ? spec : null;
    if (!a || a.entity === "none" || (typeof a.action === "string" && a.action.trim() === "none")) return null;
    const entity = actionEntity(a);
    const svc = serviceOf(a);
    let name = a.name;
    if (name === undefined || name === null || name === "") {
      // An unnamed call says what it does to what ("Reset Pantry Trap Strikes"), not just which entity it touches.
      const verb = svc ? svc.split(".")[1].replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
      const what = entity ? shortName(hass, entity) : "";
      name = verb && what ? `${verb} ${what}` : verb || what || "Run";
    }
    // Home Assistant spells it `confirmation:`, and { text } there asks its own question.
    const c = a.confirm !== undefined ? a.confirm : a.confirmation !== undefined ? a.confirmation : confirmDefault;
    const confirm = c && typeof c === "object" ? (typeof c.text === "string" && c.text.trim() ? c.text : true) : c;
    return { name: String(name), icon: a.icon || null, confirm: typeof confirm === "string" ? confirm : !!confirm, call: actionCall(a) };
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
    if (own("co2") && found.roles.co2_max && refs.co2.max === undefined) refs.co2 = { ...refs.co2, max: found.roles.co2_max };
    if (own("co2") && found.roles.co2_low && refs.co2.low_entity === undefined) refs.co2 = { ...refs.co2, low_entity: found.roles.co2_low };
    if (own("battery") && found.roles.battery_low && refs.battery.low_entity === undefined) refs.battery = { ...refs.battery, low_entity: found.roles.battery_low };
    if (!refs.battery && found.roles.battery_low && trap.battery === undefined) refs.battery = { entity: found.roles.battery_low };
    // An event entity carries the time of the last strike, not a count.
    if (refs.strikes && refs.strikes.entity.startsWith("event.")) {
      if (!refs.last_strike) refs.last_strike = refs.strikes;
      refs.strikes = null;
    }

    const firstEntity = ROLE_KEYS.map((k) => refs[k] && refs[k].entity).find(Boolean);
    const info = trap.device ? deviceInfo(hass, trap.device) : entityInfo(hass, firstEntity);
    // A trap's own style beats device detection, which beats the card's. "auto" is the same as leaving it out.
    const trapStyle = keyword(trap.style);
    const cardStyle = keyword(cfg.style);
    const style = TRAP_STYLES.includes(trapStyle) ? trapStyle : found.style || (TRAP_STYLES.includes(cardStyle) ? cardStyle : "snap");

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
    // Link and Last seen used to be one reading. A hold on one of them moves to the other when the trap shows only
    // that one, so a device's ping, or a hold written for the old reading, still has a reading to sit on.
    for (const [from, to] of [["link", "last_seen"], ["last_seen", "link"]]) {
      if (holds[from] && !holds[to] && !refs[roleOf(from)] && refs[roleOf(to)]) {
        holds[to] = holds[from];
        delete holds[from];
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
      co2: interpretLevel(hass, reads.co2, toNum(trap.co2_low, cfg.co2_low), lowRead("co2"), CO2_SHOTS),
      signal: interpretSignal(hass, reads.signal),
      kill: interpretBool(reads.kill, "kill"),
      armed: interpretBool(reads.armed, "armed"),
      rearmReported: interpretBool(reads.rearm, "rearm"),
      asleep: !!(reads.online && !reads.online.unknown && norm(reads.online.raw) === "asleep"),
      since: {
        kill: reads.kill && reads.kill.since,
        rearm: null,
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
    // The banner's time and tap target come from the sensor that decided it, not from an unavailable one.
    const rearmBy = r !== null ? "rearm" : "armed";
    m.since.rearm = (reads[rearmBy] && reads[rearmBy].since) || null;
    m.rearmEntity = m.entities[rearmBy] || null;

    // Connectivity: the online entity, overridden by how long ago the trap was last seen.
    let online = interpretBool(reads.online, "online");
    let offlineSince = reads.online && reads.online.since;
    // stale: last seen longer ago than stale_after. overdue: longer ago than offline_after, which makes it offline.
    m.stale = false;
    m.overdue = false;
    if (m.lastSeen) {
      const age = Date.now() - Date.parse(m.lastSeen);
      const offlineAfter = parseDuration(trap.offline_after !== undefined ? trap.offline_after : cfg.offline_after);
      const staleAfter = parseDuration(trap.stale_after !== undefined ? trap.stale_after : cfg.stale_after);
      m.overdue = !!offlineAfter && age > offlineAfter;
      if (m.overdue) online = false;
      else if (staleAfter && age > staleAfter) m.stale = true;
      if (online === false) offlineSince = m.lastSeen;
    }
    if (!refs.online && online === null) {
      // Without a connectivity entity, infer "offline" when every device entity is unavailable. Helpers never go
      // unavailable, so a counter or input_select kept by hand can't show the trap is still there.
      const found = configured.map((k) => reads[k]).filter((x) => !x.missing && !HELPER_DOMAINS.test(x.domain));
      if (found.length && found.every((x) => x.dead)) {
        online = false;
        offlineSince = found[0].since;
      }
    }
    m.online = online;
    // Only the Offline banner shows this. Kept while online, a connectivity sensor's every change (a signal
    // strength, say) would count as a change to the tile.
    m.since.online = online === false ? offlineSince || null : null;

    const warnings = [];
    if (m.battery.low) warnings.push("Low battery");
    if (m.bait.empty) warnings.push("Out of bait");
    else if (m.bait.low) warnings.push("Low bait");
    if (m.co2.empty) warnings.push("Out of CO\u2082");
    else if (m.co2.low) warnings.push("Low CO\u2082");
    if (m.stale) warnings.push("Not seen recently");
    if (m.missing.length) warnings.push("Entity not found");
    m.warnings = warnings;

    const noData = configured.every((k) => reads[k].missing || reads[k].unknown);
    // "Armed" needs a reading that says so: a trap whose catch and arming sensors are all unknown or unrecognised
    // (typical right after a restart) is "Status unknown", not green.
    const hasArming = !!(refs.kill || refs.rearm || refs.armed);
    m.armKnown = m.kill === false || m.rearm === false;
    const trapUnknown = hasArming && m.kill === null && m.rearm === null;
    if (m.kill === true) m.status = "kill";
    else if (m.rearm === true) m.status = "rearm";
    else if (m.online === false) m.status = "offline";
    else if (m.conflict) m.status = "check";
    else if (warnings.length) m.status = "warn";
    else if (noData || trapUnknown) m.status = "unknown";
    else m.status = "ok";

    m.label = {
      kill: "Catch detected",
      rearm: "Needs re-arm",
      offline: "Offline",
      check: "Check trap",
      warn: warnings[0] + (warnings.length > 1 ? ` +${warnings.length - 1}` : ""),
      unknown: !configured.length ? "Not set up" : noData ? "No data" : "Status unknown",
      ok: hasArming && m.armKnown ? "Armed" : "All good",
    }[m.status];

    // No mouse sniffing around a trap whose arming isn't known; traps without arming sensors keep it.
    m.scene = { kill: "kill", rearm: "sprung", offline: "offline", check: "check", unknown: "idle" }[m.status] || (hasArming && !m.armKnown ? "idle" : "armed");
    m.primary = m.entities.kill || m.entities.armed || m.entities.rearm || m.entities.online || m.entities.last_seen || m.entities[configured[0]] || null;
    return m;
  }

  const errorText = (e) => {
    try {
      return String((e && e.message) || e);
    } catch (x) {
      return "unknown error";
    }
  };

  /**
   * Why a service call failed, in words. Home Assistant rejects with { code, message }, or with a result message that
   * wraps it as { error: { code, message } }, and a call made while disconnected rejects with the bare code 3.
   */
  function callError(e) {
    const text = e && (e.message || (e.error && (typeof e.error === "string" ? e.error : e.error.message)));
    if (typeof text === "string" && text.trim()) return text.trim();
    return e === 3 ? "connection lost" : typeof e === "string" && e.trim() ? e.trim() : "unknown error";
  }

  /**
   * Stands in for a trap whose model couldn't be built, so one bad value doesn't blank or freeze the other tiles.
   * It has every field the tile, the summary and the sorting read.
   */
  function errorModel(trap, cfg, index, err) {
    const t = trap && typeof trap === "object" ? trap : {};
    const trapStyle = keyword(t.style);
    const cardStyle = keyword(cfg && cfg.style);
    const level = () => ({ level: null, text: null, low: null, empty: false, deviceLow: false });
    const name = typeof t.name === "string" || typeof t.name === "number" ? String(t.name) : "";
    return {
      index,
      watch: [],
      name: name || `Trap ${index + 1}`,
      location: typeof t.location === "string" ? t.location : "",
      style: TRAP_STYLES.includes(trapStyle) ? trapStyle : TRAP_STYLES.includes(cardStyle) ? cardStyle : "snap",
      configured: [],
      entities: {},
      missing: [],
      strikes: null,
      lastStrike: null,
      lastSeen: null,
      battery: level(),
      bait: level(),
      co2: level(),
      signal: { bars: null, text: null },
      kill: null,
      armed: null,
      rearmReported: null,
      rearm: null,
      conflict: false,
      asleep: false,
      online: null,
      stale: false,
      overdue: false,
      since: { kill: null, rearm: null, online: null },
      rearmEntity: null,
      armKnown: false,
      holds: {},
      actions: [],
      warnings: [],
      status: "check",
      label: "Card error",
      scene: "check",
      primary: null,
      error: errorText(err),
    };
  }

  function metricKeys(m) {
    const has = (k) => m.configured.includes(k);
    return METRIC_ORDER.filter((k) => (k === "trap" ? has("armed") || has("rearm") : has(roleOf(k))));
  }

  function metricEntities(m, key) {
    const e = m.entities;
    if (key === "trap") return [e.armed, e.rearm].filter(Boolean);
    return [e[roleOf(key)]].filter(Boolean);
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
    seen: `<svg viewBox="0 0 24 24" class="ic ic-seen" aria-hidden="true"><path d="M4.5 12A8 8 0 1 1 6.84 17.66"/><path d="M2.2 9.9 4.5 12.4 6.8 9.9"/><path d="M12.5 8v4.5l3.2 1.9"/></svg>`,
    wifiOff: `<svg viewBox="0 0 24 24" class="ic ic-wifi-off" aria-hidden="true"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0" class="waves"/><circle cx="12" cy="19" r="1.6"/><path d="M4 3 20 21" class="slash"/></svg>`,
  };

  function batteryIcon(b) {
    const lvl = b.level !== null ? b.level : b.low ? 12 : b.low === false ? 100 : 0;
    const w = Math.max(lvl > 0 ? 1.5 : 0, (19 * lvl) / 100);
    return `<svg viewBox="0 0 28 16" class="ic ic-batt" aria-hidden="true"><rect x="1" y="2" width="23" height="12" rx="3" class="shell"/><rect x="24.6" y="5.5" width="2.6" height="5" rx="1.2" class="nub"/><rect x="3" y="4" width="${w.toFixed(2)}" height="8" rx="1.4" class="charge"/></svg>`;
  }

  /** A gas canister, filled to the CO2 level. */
  function co2Icon(c) {
    const lvl = c.level !== null ? c.level : c.low ? 12 : c.low === false ? 100 : 0;
    const h = lvl > 0 ? Math.max(1.5, (13.4 * lvl) / 100) : 0;
    return `<svg viewBox="0 0 24 24" class="ic ic-co2" aria-hidden="true"><path d="M9.5 2.6h5M12 2.6V5" class="valve"/><rect x="7.5" y="5" width="9" height="17" rx="3.5" class="shell"/><rect x="9.3" y="${(20.2 - h).toFixed(2)}" width="5.4" height="${h.toFixed(2)}" rx="1.4" class="gas"/></svg>`;
  }

  function signalIcon(s) {
    const bars = [0, 1, 2, 3].map((i) => `<rect x="${3 + i * 5}" y="${17 - i * 4}" width="3.4" height="${4 + i * 4}" rx="1"${i < (s.bars || 0) ? "" : ` class="off"`}/>`);
    return `<svg viewBox="0 0 24 24" class="ic ic-signal" aria-hidden="true">${bars.join("")}</svg>`;
  }

  function cheeseIcon(b, uid) {
    const lvl = b.level !== null ? b.level : b.low ? 15 : b.low === false ? 100 : 0;
    // A little bait left is drawn as a tenth of the wedge at least, which can be seen; only none leaves it empty.
    const x = 2 + 20 * (1 - (lvl > 0 ? Math.max(lvl, 10) : 0) / 100);
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
    const noGas = m.configured.includes("co2") && m.co2.empty;
    return `
    <ellipse class="shadow" cx="80" cy="82" rx="50" ry="3.2"/>
    <rect class="post" x="38" y="8" width="15" height="74" rx="1.5"/>
    <path class="grain" d="M42.5 14V78M47.5 24V72M50 10V40"/>
    <rect class="gn-bracket" x="51" y="29" width="13" height="4" rx="1"/>
    <rect class="gn-bracket" x="51" y="50" width="13" height="4" rx="1"/>
    <rect class="gn-can${noGas ? " empty" : ""}" x="67.5" y="16.5" width="15" height="10" rx="3"/>
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

  // The drawing is decoration: the chip says the status in words, and screen readers read that instead.
  function sceneSvg(m, uid, snap) {
    const art = ART[m.style] || ART.snap;
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
<svg viewBox="-22 16 244 72" class="scene art-${m.style} st-${m.scene}${snap ? " snap-now" : ""}" aria-hidden="true">
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

  const METRIC_LABELS = {
    strikes: "Strikes", last_strike: "Last strike", battery: "Battery", bait: "Bait", co2: "CO\u2082", kill: "Catch", trap: "Trap", link: "Link",
    last_seen: "Last seen", signal: "Signal",
  };
  // A reading whose value already says it's low or out ("Low", "Empty", "Critical") doesn't repeat it in its label.
  const SAYS_LOW = /\b(low|critical|empty|out|none|depleted|gone|due|replace)\b/i;

  /**
   * Long values get a smaller font, so they fit rather than being cut off. For the smaller step an m or a w counts as
   * one and a half letters: "-62 dBm" is wider than "Caught!", the longest value that fits two readings to a narrow tile.
   */
  const fitClass = (text) => (text.length > 10 ? " fit-xs" : text.length + (text.match(/[mw]/gi) || []).length / 2 > 7 ? " fit-s" : "");

  /** A reading's accessible name, "Battery low: 8%". A dash is read out as a word, not as punctuation. */
  const readingName = (label, text, missing) => `${label}: ${text === DASH ? (missing ? "not found" : "unknown") : text}`;

  /** Its tooltip: the name, the hold action, and the entity ID on a line of its own. */
  const readingTitle = (name, hold, entity) => `${name}${hold ? ` ${DOT} Hold: ${hold.name}` : ""}\n${entity}`;

  // One element per reading, with no whitespace around it: the list is patched reading by reading. The label carries
  // the reading's state ("Battery low") when there is one, because a more urgent status can take the tile's chip and
  // the colour alone wouldn't say it. The entity ID is in the tooltip only, so screen readers don't spell it out.
  function metric(key, entity, icon, value, text, label, cls, hold, busy) {
    const name = readingName(label, text, cls.split(" ").includes("is-missing"));
    const holdAttrs = hold
      ? ` data-hold="${key}" aria-keyshortcuts="Shift+Enter" aria-description="${esc(`Shift+Enter or press and hold: ${hold.name}`)}"`
      : "";
    return `<div class="metric m-${key} ${cls}${hold ? " has-hold" : ""}${busy ? " busy" : ""}${fitClass(text)}" data-entity="${esc(entity)}"${holdAttrs}${busy ? ` aria-busy="true"` : ""} role="button" tabindex="0" title="${esc(readingTitle(name, hold, entity))}" aria-label="${esc(name)}">
        <div class="m-icon">${icon}</div>
        <div class="m-text"><div class="m-value">${value}</div><div class="m-label">${esc(label)}</div></div>
      </div>`;
  }

  const timeValue = (iso) => (iso ? `<span data-since="${esc(iso)}">${esc(relTime(iso))}</span>` : DASH);

  /** The tile's readings, as one markup string each. A reading whose hold action is running is marked busy. */
  function renderMetrics(m, uid, flags, ui) {
    const out = [];
    for (const key of metricKeys(m)) {
      const ents = metricEntities(m, key);
      const entity = ents[0];
      const hold = m.holds[key] || null;
      const busy = !!hold && ui.busy.includes(`hold:${key}`);
      // `word` is the reading's state, added to its label unless the value already says it.
      const add = (icon, value, text, cls, word) =>
        out.push(metric(key, entity, icon, value, text, word && !SAYS_LOW.test(text) ? word : METRIC_LABELS[key], cls, hold, busy));
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
          add(batteryIcon(m.battery), esc(text), text, m.battery.low ? "is-warn" : m.battery.text ? "" : "is-dim", m.battery.low && "Battery low");
          break;
        }
        case "bait": {
          const text = m.bait.text || DASH;
          const word = m.bait.empty ? "Out of bait" : m.bait.low && "Bait low";
          add(cheeseIcon(m.bait, uid), esc(text), text, m.bait.empty ? "is-bad" : m.bait.low ? "is-warn" : m.bait.text ? "" : "is-dim", word);
          break;
        }
        case "co2": {
          const text = m.co2.text || DASH;
          const word = m.co2.empty ? "Out of CO\u2082" : m.co2.low && "CO\u2082 low";
          add(co2Icon(m.co2), esc(text), text, m.co2.empty ? "is-bad" : m.co2.low ? "is-warn" : m.co2.text ? "" : "is-dim", word);
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
          const up = m.online === false ? "down" : m.online ? "up" : "";
          const text = m.online === null ? DASH : m.online ? (m.asleep ? "Asleep" : "Online") : "Offline";
          add(`<span class="dot ${up}" aria-hidden="true"><span></span></span>`, text, text, m.online === false ? "is-off" : m.online === null ? "is-dim" : "");
          break;
        }
        case "last_seen": {
          // Late enough to count as offline (offline_after) is grey, like the trap; only late (stale_after) is amber.
          const cls = m.overdue ? "is-off" : m.stale ? "is-warn" : m.lastSeen ? "" : "is-dim";
          add(ICONS.seen, timeValue(m.lastSeen), relTime(m.lastSeen) || DASH, cls, (m.overdue || m.stale) && "Last seen, late");
          break;
        }
        case "signal": {
          const text = m.signal.text || DASH;
          add(signalIcon(m.signal), esc(text), text, m.signal.text ? "" : "is-dim");
          break;
        }
      }
    }
    return out;
  }

  function renderBanner(m) {
    const since = (iso) => (iso ? ` ${DOT} <span class="since" data-since="${esc(iso)}">${esc(relTime(iso))}</span>` : "");
    const attr = (e) => (e ? ` data-entity="${esc(e)}" role="button" tabindex="0"` : "");
    if (m.kill === true) {
      return `<div class="banner b-kill"${attr(m.entities.kill)}>
        ${ICONS.bell}<div><div class="b-title">Catch detected${since(m.since.kill)}</div><div class="b-sub">Empty the trap and re-arm it.</div></div></div>`;
    }
    if (m.rearm === true) {
      return `<div class="banner b-rearm"${attr(m.rearmEntity)}>
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

  // The prompt and the result go under the buttons, so they can't push a button out from under a second tap.
  function renderUi(m, ui) {
    if (ui.pending) {
      const act = ui.pending.kind === "hold" ? m.holds[ui.pending.key] : m.actions[Number(ui.pending.key)];
      if (act) {
        const q = typeof act.confirm === "string" ? act.confirm : `${act.name}?`;
        return `<div class="confirm" role="alertdialog" aria-label="${esc(q)}"><span>${esc(q)}</span>
          <div class="c-btns"><button type="button" class="c-no" data-confirm="no">Cancel</button>
          <button type="button" class="c-yes" data-confirm="yes">${esc(act.name)}</button></div></div>`;
      }
    }
    // Not a live region: the card's own one reads out a success, and Home Assistant's notification a failure.
    if (ui.flash) return `<div class="flash ${ui.flash.kind}">${esc(ui.flash.msg)}</div>`;
    return "";
  }

  function renderActions(m, ui) {
    if (!m.actions.length) return "";
    const buttons = m.actions.map((a, i) => {
      const id = `act:${i}`;
      const busy = ui.busy.includes(id);
      const state = busy ? " busy" : ui.flash && ui.flash.id === id ? ` ${ui.flash.kind}` : "";
      const icon = a.icon ? `<ha-icon icon="${esc(a.icon)}"></ha-icon>` : "";
      // aria-disabled, not disabled: a disabled button drops keyboard focus. _request ignores it while it's busy.
      return `<button type="button" class="act${state}" data-act="${i}"${busy ? ` aria-disabled="true"` : ""}>${icon}<span>${esc(a.name)}</span></button>`;
    });
    return `<div class="actions">${buttons.join("")}</div>`;
  }

  // A tile's fixed frame. Each part is filled separately and only rewritten when its own markup changes, so an update
  // to one reading leaves the scene, the other readings, a running animation and keyboard focus alone.
  const tileFrame = (scene) => `
      <div class="tile-head"></div>
      <div class="tile-body${scene ? " has-scene" : ""}">
        ${scene ? `<div class="scene-wrap"></div>` : ""}
        <div class="info"><div data-part="top"></div><div class="metrics"></div><div data-part="actions"></div><div data-part="ui"></div><div data-part="missing"></div></div>
      </div>`;

  /** A tile's markup, part by part (see tileFrame). `metrics` is a list with one entry per reading. */
  function renderTile(m, cfg, flags, ui) {
    const uid = `rt${m.index}`;
    const configured = !m.error && m.configured.length > 0;
    // Each trap's name is a heading, for jumping from trap to trap, and the button that opens its more-info dialog.
    // The button's description is the status chip, so tabbing to it says how the trap is.
    const opens = m.primary ? ` role="button" tabindex="0" data-entity="${esc(m.primary)}" aria-describedby="${uid}-status"` : "";
    return {
      head: `
        <div class="titles">
          <div class="name" role="heading" aria-level="3"><span class="name-btn"${opens}>${esc(m.name)}</span></div>
          ${m.location ? `<div class="loc">${esc(m.location)}</div>` : ""}
        </div>
        <span class="chip s-${m.status}" id="${uid}-status"><span class="chip-dot"></span><span class="chip-text">${esc(m.label)}</span></span>`,
      scene: cfg.show_scene ? sceneSvg(m, uid, flags.snap) : "",
      top: m.error
        ? `<div class="hint warn">This trap can't be shown: ${esc(m.error.replace(/[.\s]+$/, ""))}. The browser console has the details.</div>`
        : configured
        ? renderBanner(m)
        : `<div class="hint">No sensors yet. Edit this card and pick a device or entities for this trap.</div>`,
      metrics: configured ? renderMetrics(m, uid, flags, ui) : [],
      actions: m.error ? "" : renderActions(m, ui),
      ui: m.error ? "" : renderUi(m, ui),
      missing: m.missing.length
        ? `<div class="hint warn">Entity not found: ${m.missing.map((e) => `<code>${esc(e)}</code>`).join(", ")}</div>`
        : "",
    };
  }

  /** Set or remove an attribute, touching the element only when the value changes. */
  function setAttr(el, name, value) {
    if (value === null || value === undefined) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  const parse = (html) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    return tpl.content;
  };

  /** True when two nodes have the same elements in the same places below them; text and attributes may differ. */
  function sameShape(a, b) {
    if (a.childNodes.length !== b.childNodes.length) return false;
    for (let n = 0; n < a.childNodes.length; n++) {
      const x = a.childNodes[n];
      const y = b.childNodes[n];
      if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName || !sameShape(x, y)) return false;
    }
    return true;
  }

  /** Copy the attributes and text of `b` onto `a`, which has the same shape. */
  function syncNode(a, b) {
    if (a.nodeType === 1) {
      for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name);
      for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    } else if (a.nodeValue !== b.nodeValue) {
      a.nodeValue = b.nodeValue;
    }
    for (let n = 0; n < a.childNodes.length; n++) syncNode(a.childNodes[n], b.childNodes[n]);
  }

  /**
   * Make an element's content match new markup. When only attributes and text differ (a new battery level, a smaller
   * cheese), the elements stay: running animations carry on, and CSS transitions run. Otherwise it's replaced.
   */
  function morph(el, html) {
    const next = parse(html);
    if (sameShape(el, next)) {
      for (let n = 0; n < el.childNodes.length; n++) syncNode(el.childNodes[n], next.childNodes[n]);
    } else {
      el.textContent = "";
      el.appendChild(next);
    }
  }

  /** Update a list's items whose markup changed, leaving the others alone. A different length rebuilds it. */
  function patchList(el, before, items) {
    if (!before || before.length !== items.length || el.children.length !== items.length) {
      morph(el, items.join(""));
      return;
    }
    items.forEach((html, n) => {
      if (html === before[n]) return;
      const cur = el.children[n];
      const next = parse(html).firstElementChild;
      if (cur.nodeName === next.nodeName && sameShape(cur, next)) syncNode(cur, next);
      else cur.replaceWith(next);
    });
  }

  /** Move a child into place. moveBefore (Chrome 133+) keeps its running animations; insertBefore restarts them. */
  function place(parent, el, before) {
    if (el.parentNode === parent && typeof parent.moveBefore === "function") {
      try {
        parent.moveBefore(el, before);
        return;
      } catch (e) {
        /* not connected to the page, for one: fall through */
      }
    }
    parent.insertBefore(el, before);
  }

  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Chrome before 86 and Safari before 15.4 don't know :focus-visible. There the card rings focus only after a key
  // press (the kb-focus class, see STYLES).
  const FOCUS_VISIBLE = !!(window.CSS && CSS.supports && CSS.supports("selector(:focus-visible)"));

  function renderSummary(models) {
    const count = (...s) => models.filter((m) => s.includes(m.status)).length;
    const chips = [];
    const chip = (cls, text) => `<span class="chip ${cls}"><span class="chip-dot"></span><span class="chip-text">${text}</span></span>`;
    const push = (n, cls, text) => n && chips.push(chip(`s-${cls}`, text));
    push(count("kill"), "kill", plural(count("kill"), "catch", "catches"));
    push(count("rearm"), "rearm", `${count("rearm")} to re-arm`);
    push(count("offline"), "offline", `${count("offline")} offline`);
    push(count("warn", "check"), "warn", `${count("warn", "check")} ${count("warn", "check") === 1 ? "needs" : "need"} attention`);
    if (!chips.length && models.length) {
      chips.push(chip("s-ok", models.every((m) => m.status === "ok") ? "All clear" : "No alerts"));
    }
    const counted = models.filter((m) => m.strikes !== null);
    if (counted.length) {
      const total = counted.reduce((a, m) => a + m.strikes, 0);
      chips.push(`<span class="chip total" title="Total strikes across all traps">${ICONS.mouseHead}<span class="chip-text">${plural(Number(formatNumber(total, "")), "strike", "strikes")}</span></span>`);
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
  /* --rt-off is for tints. Home Assistant's disabled grey is too faint for the offline ring, icons and dots
     (under 3:1), so those use the secondary text colour, or --rodent-trap-offline-color. */
  --rt-off-fg: var(--rodent-trap-offline-color, var(--secondary-text-color, #727272));
  --rt-accent: var(--primary-color, #03a9f4);
  --rt-text: var(--primary-text-color, #212121);
  /* --rt-text2, --rt-warn-ink and --rt-cheese-ink are plain colours here, for browsers without color-mix; the
     @supports block after this one mixes them for contrast. --rt-warn-ink is for warning icons and dots, never the
     tints, which use --c. */
  --rt-text2: var(--secondary-text-color, #727272);
  --rt-warn-ink: var(--rt-warn);
  --rt-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
  /* Illustration colours. The --rodent-trap-* names are for themes and card-mod, and the README lists them:
     renaming one breaks the themes that set it. */
  --rt-wood: var(--rodent-trap-wood-color, #d6a064);
  --rt-wood-edge: var(--rodent-trap-wood-edge-color, #a8703a);
  --rt-grain: var(--rodent-trap-wood-grain-color, rgba(110, 62, 18, 0.28));
  --rt-metal: var(--rodent-trap-metal-color, #8c96a1);
  --rt-metal-hi: var(--rodent-trap-metal-highlight-color, #c9d0d7);
  --rt-cheese: var(--rodent-trap-cheese-color, #f7c948);
  --rt-cheese-dark: var(--rodent-trap-cheese-shade-color, #dea41f);
  /* The bait icon's outline and holes. */
  --rt-cheese-ink: var(--rt-cheese-dark);
  --rt-fur: var(--rodent-trap-mouse-fur-color, #a4abb4);
  --rt-fur-hi: var(--rodent-trap-mouse-belly-color, #d3d8de);
  --rt-pink: var(--rodent-trap-mouse-skin-color, #f1a2b0);
  --rt-eye: var(--rodent-trap-mouse-eye-color, #26282b);
  --rt-gn-body: var(--rodent-trap-goodnature-body-color, #2d3833);
  --rt-gn-stripe: var(--rodent-trap-goodnature-stripe-color, #86b640);
  --rt-gn-lure: var(--rodent-trap-goodnature-lure-color, #e39b3b);
  --rt-can-band: var(--rodent-trap-goodnature-canister-color, #d9463b);
  --rt-stn-body: var(--rodent-trap-station-body-color, #3f6150);
  --rt-stn-lid: var(--rodent-trap-station-lid-color, #4f7763);
  --rt-stn-hole: var(--rodent-trap-station-entrance-color, #16201b);
  --rt-stn-block: var(--rodent-trap-station-bait-color, #3aa6c8);
  display: block;
}
/* Secondary text moves 30% toward the primary text colour: Home Assistant's grey is about 4:1 on a tinted reading,
   and under 3:1 on a banner. Amber is under 2:1 on a light card, so warning icons and the bait icon's outline move
   toward the text colour too, which keeps them light in a dark theme. */
@supports (color: color-mix(in srgb, red 50%, blue)) {
  :host {
    --rt-text2: color-mix(in srgb, var(--secondary-text-color, #727272), var(--rt-text) 30%);
    --rt-warn-ink: color-mix(in srgb, var(--rt-warn) 55%, var(--rt-text));
    --rt-cheese-ink: color-mix(in srgb, var(--rt-cheese-dark) 60%, var(--rt-text));
  }
}
ha-card:not(:defined) {
  display: block;
  box-sizing: border-box;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
  box-shadow: var(--ha-card-box-shadow, none);
  color: var(--rt-text);
}
ha-card { overflow: hidden; }
/* In the sections view with a fixed number of rows, the card fills its rows and scrolls, instead of spilling over
   the cards below it. */
:host([grid-layout]) { height: 100%; }
:host([grid-layout]) ha-card { height: 100%; overflow: hidden auto; }
.wrap { padding: 0 0 12px; }
.header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 16px 16px 12px; }
/* The same type as the headers of Home Assistant's own cards. */
.title { display: flex; align-items: center; gap: 10px; font-family: var(--ha-card-header-font-family, inherit); font-size: var(--ha-card-header-font-size, var(--ha-font-size-2xl, 24px));
  font-weight: 400; letter-spacing: -0.012em; line-height: 1.2; color: var(--ha-card-header-color, var(--rt-text)); min-width: 0; }
.title .ic-mouse { width: 30px; height: 30px; flex: none; animation: wiggle 7s ease-in-out 1; transform-origin: 50% 90%; }
.summary { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
/* Tiles are at least 290 px wide, and one or two traps stretch across a wide card (auto-fit drops the empty tracks).
   With \`columns\`, --rt-cols is the most columns to use; tiles still stay at least 250 px wide, so a phone shows fewer.
   --rt-gap is both the gap and part of that sum, so the two can't drift apart. */
.grid { --rt-gap: 12px; display: grid; gap: var(--rt-gap); padding: 0 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); }
.grid.max-cols { grid-template-columns: repeat(auto-fill, minmax(max(min(100%, 250px), calc((100% - (var(--rt-cols) - 1) * var(--rt-gap)) / var(--rt-cols))), 1fr)); }
.wrap.headless .grid { padding-top: 12px; }

.chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; box-sizing: border-box; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; white-space: nowrap;
  background: color-mix(in srgb, var(--c, var(--rt-off)) 15%, transparent); color: var(--rt-text); }
.chip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c, var(--rt-off)); flex: none; }
.chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.chip.total { --c: var(--rt-text2); gap: 4px; padding-left: 6px; }
.chip.total .ic { width: 18px; height: 18px; }
.s-ok { --c: var(--rt-ok); }
.s-warn, .s-check, .s-rearm { --c: var(--rt-warn); }
.s-kill { --c: var(--rt-bad); }
.s-offline, .s-unknown { --c: var(--rt-off); }
/* Dots are drawn in the stronger inks; the tints keep --c. */
.chip.s-warn .chip-dot, .chip.s-check .chip-dot, .chip.s-rearm .chip-dot { background: var(--rt-warn-ink); }
.chip.s-offline .chip-dot, .chip.s-unknown .chip-dot { background: var(--rt-off-fg); }
.chip.s-kill .chip-dot { position: relative; }
.chip.s-kill .chip-dot::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; left: 0; border-radius: 50%; background: var(--c); animation: ping 1.4s ease-out infinite; }

.tile { position: relative; border-radius: 14px; border: 1px solid var(--rt-divider); overflow: hidden; container-type: inline-size;
  background: color-mix(in srgb, var(--rt-text) 2.5%, transparent); transition: border-color .4s, background-color .4s; }
/* Offsets are longhands, not inset, which Chrome before 87 and Safari before 14.1 don't know: there the stripe was 0 px tall. */
.tile::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 4px; background: var(--c, transparent); transition: background-color .4s; }
.tile.s-ok::before, .tile.s-unknown::before { background: transparent; }
.tile.s-offline::before { background: var(--rt-off-fg); }
.tile.s-kill { border-color: color-mix(in srgb, var(--rt-bad) 55%, transparent); background: color-mix(in srgb, var(--rt-bad) 6%, transparent); }
/* A catch can wait hours to be emptied. The ring pulses by opacity alone, which the compositor runs without repainting
   the page; an animated box-shadow repainted it 60 times a second for as long as the catch showed. */
.tile.s-kill::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; left: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--rt-bad) 45%, transparent); animation: fade-pulse 2.2s ease-in-out infinite; }
.tile.s-rearm, .tile.s-check { border-color: color-mix(in srgb, var(--rt-warn) 55%, transparent); }
/* Only the drawing fades: faded text was too faint to read. */
.tile.s-offline .scene-wrap { opacity: .82; }

/* The chip moves under the name before the name gets shorter than about 8 characters. */
.tile-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 6px 10px; padding: 12px 12px 0 16px; }
.tile-head[data-entity] { cursor: pointer; }
.titles { flex: 1 1 8ch; min-width: 0; }
.tile-head .chip { min-width: 0; }
.name { font-size: 16px; font-weight: 500; line-height: 1.3; }
/* The ellipsis is on the button, so its own focus ring isn't clipped. */
.name-btn { display: inline-block; max-width: 100%; vertical-align: top; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; outline: none; }
.loc { font-size: 12.5px; color: var(--rt-text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tile-body { display: grid; grid-template-columns: 1fr; align-items: center; }
/* The drawing is as tall as its width allows, up to 104 px, so a narrow tile isn't mostly empty space above and below
   it. The art stays centred: an aspect-ratio on the wrap would pin it to the left. */
.scene-wrap { height: auto; padding: 0 8px; }
.scene-wrap[data-entity] { cursor: pointer; }
.scene { width: 100%; height: auto; max-height: 104px; display: block; overflow: hidden; }
.info { padding: 4px 12px 12px 16px; min-width: 0; }
.tile-body.has-scene .info { padding-top: 0; }

.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
@container (min-width: 410px) {
  .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container (min-width: 660px) {
  .tile-body.has-scene { grid-template-columns: minmax(280px, 45%) 1fr; }
  .tile-body.has-scene .info { padding: 8px 12px 12px 0; }
  .scene { max-height: 140px; }
}
.metric { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 9px; border-radius: 10px; cursor: pointer; outline: none; overflow: hidden;
  background: color-mix(in srgb, var(--rt-text) 5%, transparent); transition: background-color .3s, transform .15s;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.metric:hover { background: color-mix(in srgb, var(--rt-text) 9%, transparent); }
.metric:active { transform: scale(.97); }
.m-icon { width: 26px; height: 22px; display: grid; place-items: center; flex: none; }
.m-icon .ic { width: 24px; height: 22px; }
.m-text { min-width: 0; }
.m-value { font-size: 15px; font-weight: 600; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.fit-s .m-value { font-size: 13px; }
.fit-xs .m-value { font-size: 12px; white-space: normal; overflow-wrap: anywhere; line-height: 1.15; }
.m-label { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--rt-text2); line-height: 1.25; }
.metric.is-warn { background: color-mix(in srgb, var(--rt-warn) 16%, transparent); }
.metric.is-bad { background: color-mix(in srgb, var(--rt-bad) 15%, transparent); }
.metric.is-off { background: color-mix(in srgb, var(--rt-off) 18%, transparent); }
.metric.is-dim .m-value, .metric.is-missing .m-value { color: var(--rt-text2); }
.metric.is-dim .m-icon { filter: grayscale(1); opacity: .45; }
.metric.is-missing { outline: 1px dashed var(--rt-bad); outline-offset: -1px; }
.metric.is-missing .ic { stroke: var(--rt-bad); fill: var(--rt-bad); }
/* Focus is a real outline, clear of the control, so it shows on the filled Confirm button too, and forced colours
   (Windows High Contrast) repaint it; they drop box-shadows. It comes after .metric.is-missing, whose outline it
   replaces while a missing reading has focus. */
.metric:focus-visible, .name-btn:focus-visible, .banner:focus-visible, .act:focus-visible, .confirm button:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 2px; }
/* Chrome before 86 and Safari before 15.4 drop the rule above, which they can't read. There the card marks key
   presses itself (kb-focus), so a tap doesn't leave a ring behind. */
.kb-focus .metric:focus, .kb-focus .name-btn:focus, .kb-focus .banner:focus, .kb-focus .act:focus, .kb-focus .confirm button:focus { outline: 2px solid var(--rt-accent); outline-offset: 2px; }
/* The corner mark is the only sign on a touch screen that a reading can be held, so it's a solid 2 px corner. */
.metric.has-hold::after { content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border-right: 2px solid var(--rt-text2); border-bottom: 2px solid var(--rt-text2); border-bottom-right-radius: 2px; pointer-events: none; }
.metric.holding::before { content: ""; position: absolute; top: 0; right: 0; bottom: 0; left: 0; background: var(--rt-accent); opacity: .26; transform-origin: 0 50%; animation: hold-fill ${HOLD_MS}ms linear var(--hold-delay, 0s) forwards; pointer-events: none; }
.metric.busy { opacity: .55; cursor: progress; }
.plus { position: absolute; right: 8px; top: 2px; font-size: 12px; font-weight: 700; color: var(--rt-bad); opacity: 0; animation: float-up 1.8s ease-out both; pointer-events: none; }
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
.ic-cheese .ghost { fill: none; stroke: var(--rt-cheese-ink); stroke-width: 1.2; stroke-dasharray: 2 1.6; stroke-linejoin: round; }
.ic-cheese .wedge { fill: var(--rt-cheese); stroke: var(--rt-cheese-ink); stroke-width: 1.2; stroke-linejoin: round; }
.ic-cheese .hole { fill: var(--rt-cheese-ink); }
.ic-bell { fill: var(--rt-bad); }
.is-bad .ic-bell { animation: ring 1.6s ease-in-out infinite; transform-origin: 50% 12%; }
.ic-check circle { fill: var(--rt-ok); }
.ic-check .tick, .ic-armed .tick { fill: none; stroke: #fff; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.ic-armed path:first-child { fill: var(--rt-ok); }
.ic-question path:first-child { fill: var(--rt-warn); }
/* A dark "?": white on amber is under 2:1. */
.ic-question .q { fill: none; stroke: #1a1a1a; stroke-width: 2; stroke-linecap: round; }
.ic-question .qd { fill: #1a1a1a; }
.ic-clock circle, .ic-clock path, .ic-seen path { fill: none; stroke: var(--rt-text2); stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.bump .ic-clock path { transform-box: view-box; transform-origin: 12px 12px; animation: spin .8s ease-out; }
/* A trap that is late checking in keeps pulsing until it does. */
.is-warn .ic-seen { animation: fade-pulse 2.4s ease-in-out infinite; }
.is-warn .ic-seen path { stroke: var(--rt-warn-ink); }
.ic-co2 .shell, .ic-co2 .valve { fill: none; stroke: var(--rt-text2); stroke-width: 1.6; stroke-linecap: round; }
.ic-co2 .gas { fill: var(--rt-ok); transition: height .6s ease, y .6s ease; }
.is-warn .ic-co2 .gas { fill: var(--rt-bad); }
.ic-signal rect { fill: var(--rt-text2); }
.ic-signal .off { opacity: .25; }
.ic-rearm { fill: var(--rt-warn-ink); }
.is-warn .ic-rearm { animation: spin 2.8s linear infinite; }
.ic-wifi-off { fill: var(--rt-off-fg); }
.ic-wifi-off .waves, .ic-wifi-off .slash { fill: none; stroke: var(--rt-off-fg); stroke-width: 2; stroke-linecap: round; }
.dot { position: relative; width: 12px; height: 12px; border-radius: 50%; background: var(--rt-off); }
.dot.up { background: var(--rt-ok); }
/* A trap that comes online pings a few times and settles. */
.dot.up span { position: absolute; top: 0; right: 0; bottom: 0; left: 0; border-radius: 50%; background: inherit; animation: ping 2.4s cubic-bezier(0, 0, .2, 1) 3; }
.dot.down { background: transparent; border: 2px solid var(--rt-off-fg); box-sizing: border-box; }

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
.confirm { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 8px 8px 12px; margin-top: 8px; border-radius: 10px;
  background: color-mix(in srgb, var(--rt-accent) 14%, transparent); animation: fade-in .15s ease-out; }
.confirm > span { flex: 1; min-width: 120px; font-size: 13.5px; font-weight: 600; }
.c-btns { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-left: auto; }
.confirm button, .act { font: inherit; font-size: 12.5px; font-weight: 500; min-height: 36px; padding: 0 12px; border-radius: 999px; cursor: pointer; outline: none;
  display: inline-flex; align-items: center; gap: 6px; color: var(--rt-text); background: transparent; border: 1px solid var(--rt-divider); }
@media (pointer: coarse) {
  .confirm button, .act { min-height: 40px; }
}
.confirm .c-yes { background: var(--rt-accent); border-color: var(--rt-accent); color: var(--text-primary-color, #fff); }
.flash { font-size: 12.5px; font-weight: 500; padding: 7px 10px; margin-top: 8px; border-radius: 10px; animation: fade-in .15s ease-out; }
.flash.ok { background: color-mix(in srgb, var(--rt-ok) 16%, transparent); }
.flash.err { background: color-mix(in srgb, var(--rt-bad) 16%, transparent); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.act:hover { border-color: var(--rt-accent); }
.act ha-icon { --mdc-icon-size: 16px; }
.act.busy { opacity: .55; cursor: progress; }
.act.ok { border-color: var(--rt-ok); }
.act.err { border-color: var(--rt-bad); }
.hint { font-size: 12.5px; color: var(--rt-text2); padding: 6px 0 2px; }
/* Red text is under 4.5:1 on a light card, so the red is a bar beside the text. */
.hint.warn { color: var(--rt-text); border-left: 3px solid var(--rt-bad); padding: 2px 0 2px 8px; margin-top: 6px; }
.hint code { font-size: 11.5px; }
.empty { padding: 8px 16px 8px; color: var(--rt-text2); font-size: 14px; }
/* Read out by screen readers, never seen. */
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }

/* Narrow tiles: a horizontal stack, a grid card, half a section. The name gets its own row, so the status chip can't
   squeeze it away, and readings give their value the full width. These must stay after the rules they change. */
@container (max-width: 260px) {
  .tile-head { padding-left: 12px; }
  .info { padding-left: 12px; padding-right: 10px; }
  .titles { flex-basis: 100%; }
  .metric { flex-direction: column; align-items: flex-start; gap: 2px; padding: 7px 8px; }
  .m-text { align-self: stretch; }
  .confirm > span { min-width: 0; }
}
/* Two readings side by side still fit a 7-letter value ("Caught!") down to here. */
@container (max-width: 180px) {
  .metrics { grid-template-columns: minmax(0, 1fr); }
  .banner > .ic { display: none; }
}
@container (max-width: 130px) {
  .m-icon { display: none; }
}

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
/* The filter is on the <svg> itself: Safari, iOS and Chromium before 89 ignore a filter on an SVG group. */
.scene.st-offline { filter: grayscale(1); }
.st-offline .stage { opacity: .5; }
.st-idle .stage, .st-check .stage { opacity: .75; }
.scene .mouse .fur { fill: var(--rt-fur); }
.scene .mouse .belly { fill: var(--rt-fur-hi); }
.scene .mouse .pink { fill: var(--rt-pink); }
.scene .mouse .eye { fill: var(--rt-eye); }
.scene .mouse .glint { fill: #fff; }
.scene .mouse .x-eye { stroke: var(--rt-eye); stroke-width: 1.3; stroke-linecap: round; fill: none; }
.scene .mouse .tail, .scene .tail-out { fill: none; stroke: var(--rt-pink); stroke-width: 2; stroke-linecap: round; }
.scene .mouse .whiskers { fill: none; stroke: var(--rt-text2); stroke-width: .55; stroke-linecap: round; opacity: .8; }
/* The mouse peeks twice, about 24 s, and then sits still where it's drawn: always-on wall panels shouldn't redraw an
   all-clear card 60 times a second. Its tail, nose, whiskers and eye stop with it, holding their last pose, and all of
   it plays again when the trap is set again. */
.st-armed .mouse { animation: peek 12s ease-in-out 2; }
.st-armed .mouse .tail { transform-box: fill-box; transform-origin: 0% 70%; animation: sway 1.4s ease-in-out 17 alternate forwards; }
.st-armed .mouse .nose { transform-box: fill-box; transform-origin: 50% 50%; animation: sniff .38s ease-in-out 64 alternate; }
.st-armed .mouse .whiskers { transform-box: fill-box; transform-origin: 100% 40%; animation: twitch .38s ease-in-out 64 alternate forwards; }
/* Groups that turn or scale about a point of their own have it in drawing units (view-box): Chrome before 87 put a
   group's fill-box at 0,0, which threw the snap bar off the scene and floated the cheese. Shapes, and groups drawn
   around their own 0,0 (the stars, badges and burst), are fine with fill-box. These numbers are the art's own, so
   they change with it. The eye's centre, in the mouse's coordinates (MOUSE_ALIVE): */
.st-armed .mouse .eye { transform-box: view-box; transform-origin: 8.5px 12.8px; animation: blink-eye 4.2s 6; }
.scene .star { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: .6; }
.scene .orbit { transform-box: fill-box; transform-origin: 50% 50%; animation: spin 2.6s linear infinite; }
/* Tinted discs use fill-opacity rather than color-mix, which older browsers drew as a black disc. */
.badge-rearm > circle, .badge-check > circle { fill: var(--rt-warn); fill-opacity: .22; }
.badge-rearm path { fill: var(--rt-warn-ink); }
.badge-rearm .spin { transform-box: fill-box; transform-origin: 50% 50%; animation: spin 3s linear infinite; }
.badge-check text { font: 700 14px/1 system-ui, sans-serif; fill: var(--rt-warn-ink); }
.badge-check { animation: fade-pulse 2.4s ease-in-out infinite; }
.badge-offline > circle { fill: var(--rt-off); fill-opacity: .22; }
.badge-offline circle:not(:first-child) { fill: var(--rt-off-fg); }
.badge-offline .waves, .badge-offline .slash { fill: none; stroke: var(--rt-off-fg); stroke-width: 2.2; stroke-linecap: round; }
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
/* The middle of the wedge's base (snapStage), so the cheese shrinks onto the plate. */
.scene .cheese { transform-box: view-box; transform-origin: 123px 62.8px; transition: transform .8s cubic-bezier(.3, 1.4, .5, 1); }
.scene .wedge { fill: var(--rt-cheese); stroke: var(--rt-cheese-dark); stroke-width: 1; stroke-linejoin: round; }
.scene .hole { fill: var(--rt-cheese-dark); }
.scene .crumbs { fill: var(--rt-cheese-dark); }
.scene .staple, .scene .holddown { fill: none; stroke: var(--rt-metal); stroke-width: 1.6; stroke-linecap: round; }
.scene .holddown { stroke-width: 1.3; }
/* The spring's centre, where the bar is hinged. */
.scene .bar { transform-box: view-box; transform-origin: 72px 63px; transform: rotate(-174deg); }
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
.scene .gn-can.empty { stroke: var(--rt-bad); }
.scene .gn-can-band { fill: var(--rt-can-band); }
.scene .gn-body { fill: var(--rt-gn-body); stroke: var(--rt-text); stroke-opacity: .18; stroke-width: .8; }
.scene .gn-shine { fill: rgba(255, 255, 255, .13); }
.scene .gn-stripe { fill: var(--rt-gn-stripe); }
.scene .gn-mouth { fill: #0e1210; }
.scene .gn-window { fill: rgba(255, 255, 255, .1); stroke: rgba(255, 255, 255, .35); stroke-width: .7; }
.scene .gn-window.empty { stroke: var(--rt-bad); }
.scene .gn-lure { fill: var(--rt-gn-lure); }
.scene .gn-led { fill: #5d6468; }
.st-armed .gn-led { fill: var(--rt-ok); animation: led 2.6s 4; }
.st-kill .gn-led { fill: var(--rt-bad); animation: led .9s infinite; }
.st-sprung .gn-led, .st-check .gn-led { fill: var(--rt-warn); animation: led 1.6s infinite; }
/* The middle of the three puff circles (goodnatureStage). */
.scene .puff { fill: var(--rt-metal-hi); opacity: 0; transform-box: view-box; transform-origin: 74.2px 65.95px; }
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

/* motion. pop, float-up, bump and spin are also named in _onAnimationEnd, which removes a finished catch effect:
   rename them there too, or the effect replays whenever its tile is put back on the page. */
@keyframes ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(2.6); opacity: 0; } }
@keyframes glow { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes ring { 0%, 55%, 100% { transform: rotate(0); } 10% { transform: rotate(16deg); } 20% { transform: rotate(-14deg); } 30% { transform: rotate(10deg); } 40% { transform: rotate(-6deg); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 50% { opacity: .25; } }
@keyframes led { 0%, 70%, 100% { opacity: 1; } 80% { opacity: .15; } }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes hold-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes float-up { 0% { opacity: 0; transform: translateY(6px); } 15% { opacity: 1; } 100% { opacity: 0; transform: translateY(-14px); } }
@keyframes wiggle { 0%, 88%, 100% { transform: rotate(0); } 91% { transform: rotate(-9deg); } 94% { transform: rotate(8deg); } 97% { transform: rotate(-4deg); } }
/* Starts and ends where the mouse is drawn, so it doesn't jump into view when the animation stops. */
@keyframes peek {
  0%, 100% { transform: translateX(0); }
  5% { transform: translateX(-3px); }
  10% { transform: translateX(0); }
  15% { transform: translateX(-3px); }
  20% { transform: translateX(0); }
  34% { transform: translateX(-1px); }
  44% { transform: translateX(0); }
  56%, 88% { transform: translateX(var(--peek)); }
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

/* Forced colours (Windows High Contrast and the like) repaint text, borders and outlines in a few system colours and
   drop backgrounds and shadows, so tints, dots and the status stripe would all vanish. Here what they show becomes a
   border, or a shape in a system colour: a filled dot for OK, Highlight for a catch, a square for a warning, and grey
   for offline or unknown. A reading that needs attention (a late check-in, say) gets an outline. */
@media (forced-colors: active) {
  .chip, .banner, .confirm, .flash { border: 1px solid CanvasText; }
  .metric.is-warn, .metric.is-bad, .metric.is-off { outline: 1px solid CanvasText; outline-offset: -1px; }
  .chip-dot, .dot, .tile::before, .metric.holding::before, .confirm .c-yes { forced-color-adjust: none; }
  .chip-dot { background: CanvasText; }
  .chip-dot::after { display: none; }
  .chip.s-kill .chip-dot { background: Highlight; }
  .chip.s-warn .chip-dot, .chip.s-check .chip-dot, .chip.s-rearm .chip-dot { background: transparent; border: 2px solid CanvasText; border-radius: 1px; box-sizing: border-box; }
  .chip.s-offline .chip-dot, .chip.s-unknown .chip-dot { background: transparent; border: 2px solid GrayText; box-sizing: border-box; }
  .dot { background: GrayText; }
  .dot.up { background: CanvasText; }
  .dot.down { background: transparent; border-color: GrayText; }
  .tile::before { background: transparent; }
  .tile.s-kill::before { background: Highlight; }
  .tile.s-warn::before, .tile.s-check::before, .tile.s-rearm::before { background: CanvasText; }
  .tile.s-offline::before { background: GrayText; }
  .tile.s-kill::after { box-shadow: none; border: 2px solid Highlight; }
  /* A hold's progress runs along the bottom, so the reading stays readable under it. */
  .metric.holding::before { top: auto; height: 4px; background: Highlight; opacity: 1; }
  .confirm .c-yes { background: ButtonText; border-color: ButtonText; color: ButtonFace; }
  /* After the outlines above, which a focused reading's ring replaces. */
  .metric:focus-visible, .name-btn:focus-visible, .banner:focus-visible, .act:focus-visible, .confirm button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
}

/* Chrome before 84 and Safari before 14.1 have no gaps in flexbox, and no inset either, which is what this tests for
   (flex gaps can't be tested for). Margins stand in for the gaps; gap: 0 keeps Chrome 84 to 86, which has flex gaps
   but not inset, from getting both. Where a row wraps, each item has a margin on its right or below, and its
   container takes the last one back. */
@supports not (inset: 0) {
  .header, .title, .summary, .chip, .tile-head, .metric, .banner, .confirm, .c-btns, .confirm button, .act, .actions { gap: 0; }
  .title > * + *, .banner > * + * { margin-left: 10px; }
  .metric > * + * { margin-left: 8px; }
  .chip > * + *, .act > * + * { margin-left: 6px; }
  .chip.total > * + * { margin-left: 4px; }
  .header { padding-top: 12px; padding-bottom: 8px; }
  .title { margin: 4px 12px 4px 0; }
  .summary { margin: 4px -6px -2px 0; }
  .summary > *, .actions > * { margin: 0 6px 6px 0; }
  .actions { margin-right: -6px; margin-bottom: -6px; }
  .tile-head { margin-bottom: -6px; }
  .tile-head > * { margin-bottom: 6px; }
  .titles { margin-right: 10px; }
  .confirm { padding-top: 4px; padding-bottom: 4px; }
  .confirm > span { margin: 4px 0; }
  .c-btns > * { margin: 4px 0 4px 8px; }
}

/* Browsers without color-mix (Chrome before 111, Safari before 16.2) drop every declaration above that uses it: tints
   vanish, and alert borders turn black or white. These stand in, in Home Assistant's default colours, with neutral
   greys that suit both themes. KEEP THIS BLOCK LAST, and give any new color-mix above a stand-in here: a rule after
   it, or one without a stand-in, breaks those browsers again. */
@supports not (color: color-mix(in srgb, red 50%, blue)) {
  .chip { background: rgba(158, 158, 158, .15); }
  .chip.s-ok { background: rgba(67, 160, 71, .15); }
  .chip.s-warn, .chip.s-check, .chip.s-rearm { background: rgba(255, 166, 0, .15); }
  .chip.s-kill { background: rgba(219, 68, 55, .15); }
  .chip.total { background: rgba(128, 128, 128, .15); }
  .tile { background: rgba(128, 128, 128, .04); }
  .tile.s-kill { border-color: rgba(219, 68, 55, .55); background: rgba(219, 68, 55, .06); }
  .tile.s-kill::after { box-shadow: inset 0 0 0 2px rgba(219, 68, 55, .45); }
  .tile.s-rearm, .tile.s-check { border-color: rgba(255, 166, 0, .55); }
  .metric { background: rgba(128, 128, 128, .1); }
  .metric:hover { background: rgba(128, 128, 128, .18); }
  .metric.is-warn { background: rgba(255, 166, 0, .16); }
  .metric.is-bad { background: rgba(219, 68, 55, .15); }
  .metric.is-off { background: rgba(158, 158, 158, .18); }
  .b-kill { background: rgba(219, 68, 55, .16); }
  .b-rearm, .b-check { background: rgba(255, 166, 0, .18); }
  .b-offline { background: rgba(158, 158, 158, .18); }
  .confirm { background: rgba(3, 169, 244, .14); }
  .flash.ok { background: rgba(67, 160, 71, .16); }
  .flash.err { background: rgba(219, 68, 55, .16); }
}
`;

  // The card's styles sit in a cascade layer, and styles outside any layer beat layered ones whatever their order or
  // specificity. So card-mod, whose <style> goes in after them, overrides a token, a radius or a font again, as it
  // could before 1.1. A browser without layers would drop the whole block, so there it's left unlayered.
  const CARD_CSS = "CSSLayerBlockRule" in window ? `@layer rodent-trap-card {${STYLES}}` : STYLES;

  // Parse the stylesheet once and share it between every card on the page.
  let sharedSheet = null;
  try {
    if ("adoptedStyleSheets" in Document.prototype && "replaceSync" in CSSStyleSheet.prototype) {
      sharedSheet = new CSSStyleSheet();
      sharedSheet.replaceSync(CARD_CSS);
    }
  } catch (e) {
    sharedSheet = null;
  }

  // ---------------------------------------------------------------------------
  // Card
  // ---------------------------------------------------------------------------

  /**
   * The single-trap form, where one trap's options sit on the card itself, as that trap. Null when the card has no
   * trap options. Thresholds stay card options, which a lone trap follows anyway; `style` is copied so that it still
   * beats device detection, as a trap's own style does.
   */
  function shorthandTrap(config) {
    if (!TRAP_ONLY_KEYS.some((k) => config[k] !== undefined)) return null;
    const trap = {};
    for (const k of SHORTHAND_KEYS) if (config[k] !== undefined) trap[k] = config[k];
    return trap;
  }

  const shown = (v) => {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  };
  const orList = (list) => `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;

  function checkWord(v, allowed, where, what) {
    if (v === undefined || v === null || v === "" || allowed.includes(keyword(v))) return;
    throw new Error(`${where}: ${shown(v)} isn't ${what} (use ${orList(allowed)}).`);
  }

  /** A misspelt threshold would silently turn off offline or stale detection, so it's an error instead. */
  function checkDuration(v, where) {
    if (v === undefined || isOff(v) || durationMs(v) !== null) return;
    throw new Error(`${where}: can't read ${shown(v)} (use e.g. 12h, 2d, 1d 12h, 36:00:00)`);
  }

  /** An entry in `actions` or `holds`: an entity id, `none` or false, or a mapping that names at most one entity. */
  function checkAction(v, where) {
    if (v === false || v === null || typeof v === "string") return;
    if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be an entity ID, a mapping such as { action: counter.reset } or false.`);
    // A list or a number here used to stop the whole card from updating. target.entity_id can be a list, as it can
    // in Home Assistant.
    if (v.entity !== undefined && typeof v.entity !== "string") throw new Error(`${where}.entity must be one entity ID.`);
    for (const k of ["perform_action", "service"]) {
      const svc = typeof v[k] === "string" ? v[k].trim() : "";
      if (svc && !SERVICE_RE.test(svc)) throw new Error(`${where}.${k}: ${shown(v[k])} isn't a service such as counter.reset.`);
    }
    const how = typeof v.action === "string" ? v.action.trim() : "";
    if (how.includes(".")) {
      if (!SERVICE_RE.test(how)) throw new Error(`${where}.action: ${shown(v.action)} isn't a service such as counter.reset.`);
    } else if (how && !ACTION_WORDS.includes(how)) {
      throw new Error(`${where}.action: ${how} can't run from a trap tile (use a service such as counter.reset, perform-action, toggle or none).`);
    } else if ((how === "perform-action" || how === "call-service") && !serviceOf(v)) {
      throw new Error(`${where}: action ${how} needs ${how === "perform-action" ? "perform_action" : "service"}, for example counter.reset.`);
    } else if (how === "toggle" && !actionEntity(v)) {
      throw new Error(`${where}: action toggle needs an entity.`);
    }
  }

  function normalizeConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    let traps = config.traps;
    const shorthand = traps === undefined || traps === null;
    if (shorthand) {
      const trap = shorthandTrap(config);
      if (!trap) throw new Error("Add at least one trap under `traps:` (see the Rodent Trap Card README).");
      traps = [trap];
    }
    if (!Array.isArray(traps)) throw new Error("`traps` must be a list.");
    checkWord(config.style, STYLE_WORDS, "style", "a style");
    checkWord(config.sort, SORT_ORDERS, "sort", "an order");
    for (const k of DURATION_KEYS) checkDuration(config[k], k);
    traps.forEach((t, i) => {
      // Messages name the option as the user wrote it: "holds.x" in the single-trap form, else "traps[0].holds.x".
      const at = shorthand ? "" : `traps[${i}].`;
      if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`traps[${i}] must be a mapping of options.`);
      for (const k of ROLE_KEYS) {
        const v = t[k];
        if (v !== undefined && v !== null && v !== "" && v !== false && v !== "none" && !normalizeRef(v)) {
          throw new Error(`${at}${k} must be an entity id, { entity: ... } or false.`);
        }
      }
      checkWord(t.style, STYLE_WORDS, `${at}style`, "a style");
      for (const k of DURATION_KEYS) checkDuration(t[k], `${at}${k}`);
      if (t.actions !== undefined && !Array.isArray(t.actions)) throw new Error(`${at}actions must be a list.`);
      (t.actions || []).forEach((a, n) => checkAction(a, `${at}actions[${n}]`));
      if (t.holds !== undefined && (typeof t.holds !== "object" || Array.isArray(t.holds))) throw new Error(`${at}holds must be a mapping.`);
      for (const [k, v] of Object.entries(t.holds || {})) {
        if (!HOLD_KEYS[k]) throw new Error(`${at}holds.${k} is not a reading (use kill, trap, strikes, last_strike, battery, bait, co2, link, last_seen or signal).`);
        checkAction(v, `${at}holds.${k}`);
      }
    });
    return { ...CARD_DEFAULTS, ...config, traps };
  }

  /** `columns` as the most tiles in a row: a whole number, and no more than there are traps. 0 when it isn't set. */
  function maxColumns(cfg) {
    const cols = toNum(cfg.columns, 0);
    return cols > 0 ? Math.max(1, Math.min(Math.round(cols), cfg.traps.length)) : 0;
  }

  const NO_FLAGS = { snap: false, strikesFrom: null, newStrike: false };
  // `busy` lists the actions whose call is still running, by id ("hold:kill", "act:0").
  const EMPTY_UI = { pending: null, busy: [], flash: null };
  // How long repaints keep drawing a catch's effects. SNAP! is the longest: .28 s delay + 1.9 s.
  const FX_MS = 2400;
  const isCatchScene = (s) => s === "kill" || s === "sprung";
  // Statuses read out as they happen. Warnings and "Status unknown" only show.
  const ALERT_STATUSES = ["kill", "rearm", "offline", "check"];
  // An unanswered prompt closes after this long, unless someone is in it with the keyboard.
  const CONFIRM_MS = 10000;

  /** Where keyboard focus is inside a tile, as a selector that finds the same control once it's been redrawn. */
  function focusSelector(el) {
    if (el.dataset.confirm) return `[data-confirm="${el.dataset.confirm}"]`;
    if (el.dataset.act) return `[data-act="${el.dataset.act}"]`;
    const reading = el.classList.contains("metric") && /(?:^|\s)m-([a-z0-9_]+)/.exec(el.className);
    if (reading) return `.metric.m-${reading[1]}`;
    if (el.classList.contains("banner")) return ".banner";
    return ".name-btn";
  }

  const canFocus = (el) => !!el && (el.tagName === "BUTTON" || el.hasAttribute("tabindex"));

  class RodentTrapCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      // The styles and <ha-card> are made once, and a new config replaces only what's inside the card. card-mod puts
      // its styles in the shadow root beside them, and a setConfig used to wipe them out.
      if (sharedSheet) {
        this.shadowRoot.adoptedStyleSheets = [sharedSheet];
      } else {
        const style = document.createElement("style");
        style.textContent = CARD_CSS;
        this.shadowRoot.appendChild(style);
      }
      this._card = document.createElement("ha-card");
      this.shadowRoot.appendChild(this._card);
      this._tiles = [];
      this._summarySig = null;
      this._order = "";
      this._onClick = this._onClick.bind(this);
      this._onKey = this._onKey.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onContextMenu = this._onContextMenu.bind(this);
      this._onAnimationEnd = this._onAnimationEnd.bind(this);
      this._endHold = this._endHold.bind(this);
      this._onVisible = () => {
        if (document.visibilityState !== "hidden") this._tick();
      };
      // Without :focus-visible, whether the last key or pointer press on the page was a key (see FOCUS_VISIBLE).
      this._keyed = true;
      this._onModality = (ev) => {
        this._keyed = ev.type === "keydown";
        if (this._root) this._root.classList.toggle("kb-focus", this._keyed);
      };
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

    /**
     * Height in the masonry view's units of about 50 px. Masonry asks while the card is still detached, before it has
     * a width or any tiles laid out, so this works from the config alone: a row of tiles is about 7 units with the
     * illustrations and 5 without, and `columns` (when set) puts that many tiles in a row.
     */
    getCardSize() {
      const cfg = this._config;
      if (!cfg) return 9;
      const header = cfg.title || cfg.show_summary ? 2 : 0;
      const n = cfg.traps.length;
      if (!n) return header + 2;
      return header + Math.ceil(n / (maxColumns(cfg) || 1)) * (cfg.show_scene === false ? 5 : 7);
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6, min_rows: 2 };
    }

    /** "grid" in the sections view, where a fixed number of rows sets the card's height (see :host([grid-layout])). */
    set layout(value) {
      this._layout = value;
      this.toggleAttribute("grid-layout", value === "grid");
    }

    get layout() {
      return this._layout;
    }

    getLayoutOptions() {
      return { grid_columns: 4, grid_min_columns: 2 };
    }

    connectedCallback() {
      clearInterval(this._timer);
      // Relative times and staleness depend on the clock, not just on state changes.
      this._timer = setInterval(() => this._tick(), 30000);
      document.addEventListener("visibilitychange", this._onVisible);
      if (!FOCUS_VISIBLE) {
        document.addEventListener("keydown", this._onModality, true);
        document.addEventListener("pointerdown", this._onModality, true);
      }
      if ("IntersectionObserver" in window && !this._io) {
        this._io = new IntersectionObserver((entries) => {
          this._hidden = !entries.some((e) => e.isIntersecting);
          if (this._root) this._root.classList.toggle("paused", this._hidden);
        });
        this._io.observe(this);
      }
      // Back from another view or a hidden tab: catch up now, not at the next 30 s tick, because a trap that stopped
      // reporting in the meantime is exactly what should show.
      this._tick();
    }

    disconnectedCallback() {
      clearInterval(this._timer);
      document.removeEventListener("visibilitychange", this._onVisible);
      document.removeEventListener("keydown", this._onModality, true);
      document.removeEventListener("pointerdown", this._onModality, true);
      this._endHold();
      // Whatever was waiting to be read out is old news by the time the card is back.
      clearTimeout(this._sayTimer);
      this._saying = [];
      this._tiles.forEach((t, i) => {
        clearTimeout(t.flashTimer);
        clearTimeout(t.pendingTimer);
        t.opener = null;
        // Nothing times these out while the card is away, and an old prompt could still be confirmed on return.
        if (t.ui.pending || t.ui.flash) this._setUi(i, { pending: null, flash: null });
        // Re-attaching restarts CSS animations, which would play this catch again as if it were new.
        this._settleFx(t);
      });
      if (this._io) {
        this._io.disconnect();
        this._io = null;
      }
    }

    /** The clock's refresh: staleness, offline and relative times change without any state change. */
    _tick() {
      try {
        if (this._config && this._hass) this._update(true);
      } finally {
        this._refreshTimes();
      }
    }

    _build() {
      const cfg = this._config;
      const showHeader = !!cfg.title || cfg.show_summary;
      // A hold, a prompt or a flash belongs to the old tiles: its trap may now be somewhere else, or gone.
      this._endHold();
      this._tiles.forEach((t) => {
        clearTimeout(t.flashTimer);
        clearTimeout(t.pendingTimer);
      });
      clearTimeout(this._sayTimer);
      this._saying = [];
      // Headings and a list give screen readers a way to jump from trap to trap. The status region is always there,
      // summary or not: a region added at the moment it has something to say is often not read out.
      const wrap = document.createElement("div");
      const keyed = !FOCUS_VISIBLE && this._keyed ? " kb-focus" : "";
      wrap.className = `wrap${cfg.animations === false ? " no-anim" : ""}${showHeader ? "" : " headless"}${this._hidden ? " paused" : ""}${keyed}`;
      wrap.innerHTML = `
            ${showHeader ? `
            <div class="header">
              ${cfg.title ? `<div class="title" role="heading" aria-level="2">${ICONS.mouseHead}<span>${esc(cfg.title)}</span></div>` : `<div class="title"></div>`}
              ${cfg.show_summary ? `<div class="summary"></div>` : ""}
            </div>` : ""}
            <div class="grid" role="list"></div>
            <div class="sr-only" role="status"></div>`;
      // Only the inside of <ha-card> is replaced: what else is in the shadow root (card-mod's styles) stays.
      if (this._root && this._root.parentNode === this._card) this._root.replaceWith(wrap);
      else this._card.appendChild(wrap);
      this._root = wrap;
      this._grid = wrap.querySelector(".grid");
      this._summary = wrap.querySelector(".summary");
      this._live = wrap.querySelector(".sr-only");
      const cols = maxColumns(cfg);
      if (cols) {
        this._grid.classList.add("max-cols");
        this._grid.style.setProperty("--rt-cols", String(cols));
      }
      this._grid.addEventListener("click", this._onClick);
      this._grid.addEventListener("keydown", this._onKey);
      this._grid.addEventListener("pointerdown", this._onPointerDown);
      this._grid.addEventListener("pointermove", this._onPointerMove);
      this._grid.addEventListener("contextmenu", this._onContextMenu);
      this._grid.addEventListener("animationend", this._onAnimationEnd);
      this._tiles = cfg.traps.map((_, i) => {
        const el = document.createElement("div");
        el.className = "tile";
        el.dataset.index = String(i);
        el.setAttribute("role", "listitem");
        el.innerHTML = tileFrame(cfg.show_scene);
        const q = (s) => el.querySelector(s);
        const parts = { head: q(".tile-head"), scene: q(".scene-wrap"), metrics: q(".metrics") };
        for (const k of ["top", "actions", "ui", "missing"]) parts[k] = q(`[data-part="${k}"]`);
        // html: each part's current markup. fx: the running catch effects. live: the last scene that wasn't
        // offline or idle, so a trap coming back from an outage with its old catch doesn't play it again, and
        // liveStatus the same for the status it reads out. opener: the reading or button whose prompt or call is
        // open, which gets keyboard focus back when the prompt closes.
        return { el, parts, html: {}, fx: {}, live: null, liveStatus: null, opener: null, sig: null, model: null, ui: { ...EMPTY_UI } };
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
        let m;
        try {
          m = buildModel(hass, t, cfg, i);
          tile.seen = { entities: hass.entities, devices: hass.devices, areas: hass.areas, refs: m.watch.map((id) => states[id]) };
        } catch (e) {
          m = this._failed(tile, t, i, e);
        }
        tile.fresh = m;
        return m;
      });
      if (!changed) return;

      const news = [];
      models.forEach((m, i) => {
        const tile = this._tiles[i];
        if (tile.fresh !== m) return;
        tile.fresh = null;
        const sig = JSON.stringify([m, tile.ui]);
        if (sig === tile.sig) {
          tile.model = m;
          return;
        }
        // Coming back from a card error isn't a live change, so it doesn't play the catch or count-up. Nor is a trap
        // coming back from offline or unknown with the catch it already had (an integration reload, say): the snap
        // plays only when the scene before the gap wasn't a catch.
        const prev = tile.model && !tile.model.error ? tile.model : null;
        const flags = {
          snap: !!prev && !!tile.live && !isCatchScene(tile.live) && isCatchScene(m.scene),
          strikesFrom: prev && prev.strikes !== null && m.strikes !== null && m.strikes > prev.strikes ? prev.strikes : null,
          newStrike: !!(prev && prev.lastStrike && m.lastStrike && Date.parse(m.lastStrike) > Date.parse(prev.lastStrike)),
        };
        if (!m.error && m.scene !== "offline" && m.scene !== "idle") tile.live = m.scene;
        tile.model = m;
        this._paint(i, flags);
        if (flags.strikesFrom !== null) this._countUp(tile.el);
        const said = this._news(tile, prev);
        if (said) news.push(said);
      });

      // What the tiles now show: a tile that failed to render has swapped its model for a card error.
      const current = this._tiles.map((tile, i) => tile.model || models[i]);
      const order = this._sorted(current).map((m) => m.index);
      const orderKey = order.join(",");
      if (orderKey !== this._order) {
        this._order = orderKey;
        // insertBefore takes keyboard focus off a tile it moves (moveBefore doesn't), so it's put back.
        const focused = this.shadowRoot.activeElement;
        order.forEach((idx, pos) => {
          const el = this._tiles[idx].el;
          if (this._grid.children[pos] !== el) place(this._grid, el, this._grid.children[pos] || null);
        });
        if (focused && focused.isConnected && this.shadowRoot.activeElement !== focused) focused.focus({ preventScroll: true });
      }
      this._say(news);

      this._painted = true;
      if (this._summary) {
        const html = renderSummary(current);
        if (html !== this._summarySig) {
          this._summary.innerHTML = html;
          this._summarySig = html;
        }
      }
    }

    _paint(i, flags = NO_FLAGS) {
      const tile = this._tiles[i];
      let m = tile.model;
      if (!m) return;
      let parts;
      try {
        parts = renderTile(m, this._config, this._effects(tile, m, flags), tile.ui);
        if (!m.error) tile.error = null;
      } catch (e) {
        m = tile.model = this._failed(tile, this._config.traps[i], i, e);
        parts = renderTile(m, this._config, NO_FLAGS, EMPTY_UI);
      }
      // Painting stays synchronous: callers focus what they just drew (the confirm button, say).
      const el = tile.parts;
      const html = tile.html;
      const set = (k) => {
        if (el[k] && html[k] !== parts[k]) {
          morph(el[k], parts[k]);
          html[k] = parts[k];
        }
      };
      // A control that is redrawn rather than updated in place loses keyboard focus, which would drop to the page.
      const focused = this.shadowRoot.activeElement;
      const where = focused && tile.el.contains(focused) ? focusSelector(focused) : null;
      setAttr(tile.el, "class", `tile s-${m.status}`);
      // A click anywhere on the head opens more-info; the keyboard's way in is the name's button.
      setAttr(el.head, "data-entity", m.primary);
      if (el.scene) setAttr(el.scene, "data-entity", m.primary);
      ["head", "scene", "top", "actions", "ui", "missing"].forEach(set);
      patchList(el.metrics, html.metrics, parts.metrics);
      html.metrics = parts.metrics;
      tile.sig = JSON.stringify([m, tile.ui]);
      this._keepHold(i);
      if (where && this.shadowRoot.activeElement !== focused) this._refocus(tile, where);
    }

    /**
     * Put focus back in a tile after a repaint: on the same control redrawn, else on the reading or button that opened
     * the prompt (Cancel, Confirm and the timeout take the prompt away), else on the trap's name.
     */
    _refocus(tile, where) {
      const find = (sel) => {
        const el = tile.el.querySelector(sel);
        return canFocus(el) ? el : null;
      };
      const o = tile.opener;
      const next = find(where) || (o && find(o.kind === "hold" ? `[data-hold="${o.key}"]` : `[data-act="${o.key}"]`)) || find(".name-btn");
      if (next) next.focus({ preventScroll: true });
    }

    /**
     * What to read out about a tile that was just painted: `Name: Catch detected` when it has turned to a catch,
     * a re-arm, offline or check. Not on the first paint, nor coming back from a card error, nor coming back from
     * offline or unknown with the status it had before (an integration reload, say), just as the snap doesn't play.
     */
    _news(tile, prev) {
      const m = tile.model;
      let said = null;
      if (prev && m.status !== prev.status && ALERT_STATUSES.includes(m.status)) {
        const gap = prev.status === "offline" || prev.status === "unknown";
        if (!(gap && m.status === tile.liveStatus)) said = `${m.name}: ${m.label}`;
      }
      if (!m.error && m.status !== "offline" && m.status !== "unknown") tile.liveStatus = m.status;
      return said;
    }

    /**
     * Read messages out through the status region, together. It's emptied first and filled a moment later, so the
     * same words said twice (a trap caught again) are still a change that screen readers announce.
     */
    _say(messages) {
      if (!messages.length || !this._live) return;
      this._saying = (this._saying || []).concat(messages);
      clearTimeout(this._sayTimer);
      this._live.textContent = "";
      this._sayTimer = setTimeout(() => {
        if (this._live) this._live.textContent = this._saying.join(". ");
        this._saying = [];
      }, 150);
    }

    /**
     * The catch effects to draw. A catch starts a short window, and repaints inside it draw the same effects, so the
     * markup doesn't change and SNAP!, +1 and the count-up run to the end. Z-Wave traps report the catch, the count,
     * the event and last seen as separate updates, and each used to restart or cut them off.
     */
    _effects(tile, m, flags) {
      const now = performance.now();
      const fx = tile.fx;
      if (flags.snap) fx.snapUntil = now + FX_MS;
      if (flags.strikesFrom !== null) fx.count = { from: flags.strikesFrom, to: m.strikes, until: now + FX_MS };
      if (flags.newStrike) fx.strike = { at: m.lastStrike, until: now + FX_MS };
      return {
        snap: fx.snapUntil > now && isCatchScene(m.scene),
        strikesFrom: fx.count && fx.count.until > now && fx.count.to === m.strikes ? fx.count.from : null,
        newStrike: !!(fx.strike && fx.strike.until > now && fx.strike.at === m.lastStrike),
      };
    }

    // Keyframe names from STYLES. A finished effect's markup is removed, because putting the tile back on the page
    // (a view switch, a masonry re-layout, a status re-sort) would otherwise play it again as a new catch.
    _onAnimationEnd(ev) {
      const t = ev.target;
      const tile = t instanceof Element ? this._tiles[this._tileIndex(t)] : null;
      if (!tile) return;
      if (ev.animationName === "pop") {
        this._endSnap(tile);
      } else if (ev.animationName === "float-up") {
        if (t.classList.contains("plus")) t.remove();
      } else if (ev.animationName === "bump" || ev.animationName === "spin") {
        const reading = t.closest(".metric.bump");
        // Last strike's clock spins for longer than the reading bumps, so that one waits for the spin.
        if (reading && (ev.animationName === "spin" || !reading.querySelector(".ic-clock"))) reading.classList.remove("bump");
      }
    }

    /** SNAP! is over: strip it from the scene, and stop drawing it. */
    _endSnap(tile) {
      tile.fx.snapUntil = 0;
      const svg = tile.parts.scene && tile.parts.scene.querySelector("svg.snap-now");
      if (!svg) return;
      svg.classList.remove("snap-now");
      const word = svg.querySelector(".snap-text");
      if (word) word.parentNode.remove();
      // Joins the text on either side, so the scene has the plain scene's shape and later updates happen in place.
      svg.normalize();
    }

    /** Finish every catch effect on a tile at once, as the card leaves the page. */
    _settleFx(tile) {
      this._endSnap(tile);
      tile.el.querySelectorAll(".plus").forEach((p) => p.remove());
      tile.el.querySelectorAll(".metric.bump").forEach((r) => r.classList.remove("bump"));
      tile.fx = {};
    }

    /**
     * A repaint rewrote the reading being held: keep its fill going. Updated in place, it only lost the class, and
     * putting it back in the same task doesn't restart the fill. A new element starts its fill where the old one was.
     */
    _keepHold(i) {
      const held = this._holdEl;
      const tile = this._tiles[i];
      if (!held || this._holdIndex !== i || (tile.el.contains(held) && held.classList.contains("holding"))) return;
      const next = tile.el.querySelector(`[data-hold="${this._holdKey}"]`);
      if (!next || next.classList.contains("busy")) {
        this._endHold();
        return;
      }
      if (next !== held) this._holdDelay = `${-Math.round(performance.now() - this._holdSince)}ms`;
      if (this._holdDelay) next.style.setProperty("--hold-delay", this._holdDelay);
      next.classList.add("holding");
      this._holdEl = next;
    }

    /** One trap failed: log it (once per distinct error), show it on its tile and try again on the next update. */
    _failed(tile, trap, i, e) {
      const m = errorModel(trap, this._config, i, e);
      if (tile.error !== m.error) console.error(`Rodent Trap Card: trap ${i + 1} (${m.name})`, e);
      tile.error = m.error;
      tile.seen = null;
      return m;
    }

    _sorted(models) {
      const list = models.slice();
      const sort = keyword(this._config.sort);
      if (sort === "status") {
        list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.index - b.index);
      } else if (sort === "name") {
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.index - b.index);
      }
      return list;
    }

    _countUp(tileEl) {
      const el = tileEl.querySelector(".count[data-count-from]");
      if (!el || this._config.animations === false || reducedMotion()) return;
      const from = Number(el.dataset.countFrom);
      const to = Number(el.dataset.countTo);
      if (!(to > from) || !Number.isInteger(to) || to - from > 500) return;
      const final = el.textContent;
      const start = performance.now();
      // One clock for start and progress: a frame timestamp can be older than `start` (DevTools slow motion, for
      // one), which would count far below `from`.
      const step = () => {
        const p = Math.min(1, Math.max(0, (performance.now() - start) / 900));
        // A tile taken off the page part-way shows the final count, not wherever the count had got to.
        if (p >= 1 || !el.isConnected) {
          el.textContent = final;
          return;
        }
        el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        requestAnimationFrame(step);
      };
      el.textContent = String(from);
      requestAnimationFrame(step);
    }

    /**
     * "just now" becomes "3 h ago" with no state change. The reading's tooltip, accessible name and text size go with
     * it, or a screen reader would still say "just now" hours later.
     */
    _refreshTimes() {
      this.shadowRoot.querySelectorAll("[data-since]").forEach((el) => {
        const text = relTime(el.dataset.since);
        if (el.textContent === text) return;
        el.textContent = text;
        const box = el.closest(".metric");
        const tile = box && this._tiles[this._tileIndex(box)];
        if (!tile || !tile.model) return;
        const hold = box.dataset.hold ? tile.model.holds[box.dataset.hold] || null : null;
        const name = readingName(box.querySelector(".m-label").textContent, text, false);
        box.setAttribute("aria-label", name);
        box.setAttribute("title", readingTitle(name, hold, box.dataset.entity));
        box.classList.remove("fit-s", "fit-xs");
        const fit = fitClass(text).trim();
        if (fit) box.classList.add(fit);
      });
    }

    // --- actions -------------------------------------------------------------

    _setUi(i, patch) {
      const tile = this._tiles[i];
      if (!tile) return;
      tile.ui = { ...tile.ui, ...patch };
      this._paint(i);
    }

    /** Vibration in the Home Assistant apps, as its own cards give: "warning", "light", "failure" and so on. */
    _haptic(type) {
      this.dispatchEvent(new CustomEvent("haptic", { bubbles: true, composed: true, detail: type }));
    }

    _actionFor(i, kind, key) {
      const m = this._tiles[i] && this._tiles[i].model;
      if (!m) return null;
      return kind === "hold" ? m.holds[key] : m.actions[Number(key)];
    }

    _request(i, kind, key) {
      const act = this._actionFor(i, kind, key);
      const tile = this._tiles[i];
      // A call that is still running isn't sent again: holds and buttons may not be safe to repeat. A busy button is
      // only aria-disabled, so that it keeps keyboard focus, and still gets here.
      if (!act || tile.ui.busy.includes(`${kind}:${key}`)) return;
      tile.opener = { kind, key };
      if (!act.confirm) {
        this._perform(i, kind, key);
        return;
      }
      clearTimeout(tile.pendingTimer);
      this._setUi(i, { pending: { kind, key }, flash: null });
      const yes = tile.el.querySelector('[data-confirm="yes"]');
      if (yes) yes.focus({ preventScroll: true });
      this._haptic("warning");
      this._armPending(i);
    }

    /** Close an unanswered prompt after a while, but not while someone is in it with the keyboard. */
    _armPending(i) {
      const tile = this._tiles[i];
      clearTimeout(tile.pendingTimer);
      tile.pendingTimer = setTimeout(() => {
        if (this._tiles[i] !== tile || !tile.ui.pending) return;
        const el = this.shadowRoot.activeElement;
        if (el && tile.el.contains(el) && el.closest(".confirm") && this._focusVisible(el)) this._armPending(i);
        else this._closeConfirm(i);
      }, CONFIRM_MS);
    }

    /** :focus-visible, or where the browser doesn't know it (Chrome before 86, Safari before 15.4), a key pressed last. */
    _focusVisible(el) {
      try {
        return el.matches(":focus-visible");
      } catch (e) {
        return this._lastKey > (this._lastDown || 0);
      }
    }

    /** Cancel, Escape and the timeout: close the prompt, and give focus back to what opened it if focus was in it. */
    _closeConfirm(i) {
      const tile = this._tiles[i];
      if (!tile) return;
      clearTimeout(tile.pendingTimer);
      // _paint moves focus from the prompt's buttons, which are going, to the opener.
      if (tile.ui.pending) this._setUi(i, { pending: null });
      if (!tile.ui.busy.length && !tile.ui.flash) tile.opener = null;
    }

    async _perform(i, kind, key) {
      const act = this._actionFor(i, kind, key);
      const tile = this._tiles[i];
      const id = `${kind}:${key}`;
      if (!act || tile.ui.busy.includes(id)) return;
      clearTimeout(tile.pendingTimer);
      if (!act.call) {
        this._haptic("failure");
        const msg = `Can't run ${act.name}: give it an \`action:\` (for example button.press).`;
        this._flash(i, "err", msg, id);
        // No call, so no notification from Home Assistant: this one is read out here.
        this._say([msg.replace(/`/g, "")]);
        return;
      }
      this._setUi(i, { pending: null, busy: tile.ui.busy.concat(id), flash: null });
      // Home Assistant shows its own notification (and vibrates) when a call fails, so the card only says so on the
      // tile. A card rebuilt meanwhile (a new config) has other tiles, which this result isn't about.
      let kindOf = "ok";
      let msg = `${act.name}: done`;
      try {
        const call = this._hass.callService(act.call.domain, act.call.service, act.call.data, act.call.target);
        this._haptic("light");
        await call;
      } catch (e) {
        kindOf = "err";
        msg = `${act.name} failed: ${callError(e)}`;
      }
      if (this._tiles[i] !== tile) return;
      this._flash(i, kindOf, msg, id);
      // A failure is read out by Home Assistant's own notification.
      if (kindOf === "ok") this._say([msg]);
    }

    _flash(i, kind, msg, id) {
      const tile = this._tiles[i];
      if (!tile) return;
      clearTimeout(tile.flashTimer);
      // Only this call is done: another action on the tile may still be running.
      this._setUi(i, { busy: tile.ui.busy.filter((b) => b !== id), pending: null, flash: { kind, msg, id } });
      tile.flashTimer = setTimeout(() => {
        this._setUi(i, { flash: null });
        // The prompt, call and result are over: nothing is left to hand focus back to the opener.
        if (!tile.ui.pending && !tile.ui.busy.length) tile.opener = null;
      }, kind === "err" ? 6000 : 2500);
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
        else this._closeConfirm(i);
      } else if (act) {
        // The second click of a double-click would run the button again, or answer the prompt it just opened.
        if (ev.detail > 1) return;
        this._request(i, "act", act.dataset.act);
      } else {
        this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: target.dataset.entity } }));
      }
    }

    _onKey(ev) {
      const el = ev.target;
      this._lastKey = performance.now();
      // Escape in the prompt cancels it. It goes no further: Home Assistant would close the dialog the card is in
      // (the card editor's preview, say).
      if (ev.key === "Escape" && el instanceof HTMLElement && el.closest(".confirm")) {
        ev.preventDefault();
        ev.stopPropagation();
        this._closeConfirm(this._tileIndex(el));
        return;
      }
      // A key held down repeats. On a hold, a button or the prompt, the repeats would answer the prompt the first
      // press opened (holding Shift+Enter on Catch would clear the alert without anyone choosing to), so they're
      // ignored and focus stays on the prompt's button.
      const activates = ev.key === "Enter" || ev.key === " " || ev.key === "ContextMenu";
      if (ev.repeat && activates && el instanceof HTMLElement && (el.closest(".confirm, [data-act]") || el.dataset.hold)) {
        ev.preventDefault();
        return;
      }
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
      // A reading whose action is still running can't be held again.
      if (!el || ev.button !== 0 || el.classList.contains("busy")) return;
      this._endHold();
      const index = this._tileIndex(el);
      const key = el.dataset.hold;
      this._holdEl = el;
      this._holdIndex = index;
      this._holdKey = key;
      this._holdSince = performance.now();
      this._holdDelay = null;
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
      if (this._holdEl) {
        this._holdEl.classList.remove("holding");
        this._holdEl.style.removeProperty("--hold-delay");
      }
      this._holdEl = null;
      this._holdDelay = null;
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

  // Device names, models or makers that suggest a rodent trap. \bmouse\b also matches a computer mouse.
  const TRAP_DEVICE_RE = /(trap|goodnature|smart.?kill|rodent|\bmouse\b|\brat\b)/i;
  const isTrapDevice = (d) => !!d && TRAP_DEVICE_RE.test(`${d.name_by_user || ""} ${d.name || ""} ${d.model || ""} ${d.manufacturer || ""}`);

  // Entity id fallback for the starter config: a trap keyword, then a word that says which reading it is. Checked in
  // order: a Z-Wave node_status is connectivity, a plain "status" (sprung, caught, armed) is the trap's own state.
  const TRAP_ID_RE = /(trap|smart_kill|mousetrap|rodent)/;
  const STARTER_ROLES = [
    ["online", /node_status/],
    ["battery", /batt/],
    ["co2", /(co2|shots)/],
    ["signal", /(signal|rssi|lqi|linkquality)/],
    ["strikes", /(total_kills|kill_count|kills_total|strikes?|catches|catch_count|count)/],
    ["kill", /(kills?_present|kill|catch|caught|captured|occupied|triggered|alarm|alert)/],
    ["bait", /(bait|cheese|lure)/],
    ["rearm", /(re_?arm|sprung|reset)/],
    ["armed", /armed/],
    ["online", /(online|connect|wireless|signal|rssi|available|link)/],
    ["kill", /status/],
  ];

  /** Starter config: devices that look like traps, else entities whose ids mention a trap, else one empty trap. */
  function discoverTraps(hass) {
    if (hass && hass.devices && hass.entities) {
      const devices = Object.values(hass.devices).filter(isTrapDevice);
      if (devices.length) return devices.slice(0, 4).map((d) => ({ device: d.id }));
    }
    const domains = new Set(["sensor", "binary_sensor", "counter", "input_number", "number", "input_boolean", "input_select", "select", "device_tracker"]);
    const groups = new Map();
    const ids = hass && hass.states ? Object.keys(hass.states) : [];
    for (const id of ids) {
      const [domain, obj = ""] = id.split(".");
      if (!domains.has(domain)) continue;
      const kw = TRAP_ID_RE.exec(obj);
      if (!kw) continue;
      // Roles are read from what follows the keyword, and the trap is everything before the first role word, so
      // rodent_trap_1_kill and rodent_trap_2_kill are two traps, not one "Rodent".
      const from = kw.index + kw[0].length;
      const rest = obj.slice(from);
      const role = STARTER_ROLES.find(([, re]) => re.test(rest));
      if (!role) continue;
      const cut = Math.min(...STARTER_ROLES.map(([, re]) => {
        const hit = re.exec(rest);
        return hit ? hit.index : rest.length;
      }));
      const key = obj.slice(0, from + cut).replace(/_+$/, "");
      if (!groups.has(key) && groups.size >= 4) continue;
      if (!groups.has(key)) groups.set(key, { name: titleCase(key) });
      const trap = groups.get(key);
      if (!trap[role[0]]) trap[role[0]] = id;
    }
    const traps = Array.from(groups.values());
    // Nothing trap-like: one empty trap, which asks the user to pick a device, rather than made-up demo data that
    // would be saved into their dashboard.
    return traps.length ? traps : [{}];
  }

  /** Card picker (Home Assistant 2026.6+): offer this card when the picked entity belongs to a trap device. */
  function entitySuggestion(hass, entityId) {
    const e = hass && hass.entities ? hass.entities[entityId] : null;
    const d = e && e.device_id && hass.devices ? hass.devices[e.device_id] : null;
    if (!d) return null;
    let trap = isTrapDevice(d);
    if (!trap) {
      const found = discoverDevice(hass, d.id).roles;
      // A weather station's lightning strike count is not a trap.
      trap = !!found.kill || (!!found.strikes && !/lightning/.test(found.strikes));
    }
    return trap ? { config: { type: `custom:${CARD_TAG}`, traps: [{ device: d.id }] } } : null;
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
    columns: "Max columns (blank = automatic)",
    style: "Illustration",
    battery_low: "Low battery at or below (%)",
    bait_low: "Low bait at or below (%)",
    co2_low: "Low CO\u2082 at or below (%)",
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
    co2: "CO\u2082 shots remaining",
    online: "Online / connectivity",
    last_seen: "Last seen",
    signal: "Signal strength",
    actions: "Buttons on the tile",
    hold_kill: "Hold Catch to run",
    hold_trap: "Hold Trap to run",
    hold_bait: "Hold Bait to run",
    hold_co2: "Hold CO\u2082 to run",
    hold_link: "Hold Link to run",
    hold_last_seen: "Hold Last seen to run",
  };

  const EDITOR_HELPERS = {
    device: "Fills in any entity you leave blank below by matching the device's entity names and device classes.",
    kill: "Binary sensor (on = caught), or a sensor whose value > 0 or \u201ccaught\u201d.",
    armed: "On = armed. Use this or Needs re-arm (or both, and the card flags any disagreement).",
    rearm: "On = needs re-arming. Status sensors like \u201csprung\u201d work too.",
    strikes: "Total catches or trigger count. An event entity is shown as Last strike.",
    last_strike: "Event entity, timestamp sensor or date and time helper.",
    battery: "Percentage sensor, or a binary battery sensor (on = low). A voltage shows as a value until you set min and max (empty and full) in YAML.",
    bait: "Percentage, a value with a min\u2013max range, words like \u201chalf\u201d, or a binary sensor (on = low).",
    co2: `Shots left in a gas-powered trap's CO\u2082 canister (out of ${CO2_SHOTS}; set max in YAML for another size), or a percentage.`,
    online: "Connectivity sensor or Z-Wave node status. Leave blank to infer from the other entities.",
    last_seen: "Timestamp sensor or date and time helper. Combine with the stale/offline thresholds.",
    signal: "RSSI in dBm, a percentage or Zigbee LQI, shown as 0\u20134 bars.",
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

  // The thresholds show their default as a placeholder, not as a value: a value the form fills in comes back on every
  // keystroke, so clearing the field to type a new number would give "201".
  const LOW_KEYS = ["battery_low", "bait_low", "co2_low"];
  const LOW_FIELDS = LOW_KEYS.map((name) => ({ name, default: CARD_DEFAULTS[name], selector: pct }));

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
    { name: "", type: "grid", schema: LOW_FIELDS },
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

  const HOLD_FIELDS = ["kill", "trap", "bait", "co2", "link", "last_seen"];

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
        { name: "co2", selector: entitySel(["sensor", "binary_sensor", "counter", "input_number", "number"]) },
        { name: "online", selector: entitySel(["binary_sensor", "sensor", "device_tracker"]) },
        { name: "last_seen", selector: entitySel(["sensor", "input_datetime"]) },
        { name: "signal", selector: entitySel(["sensor"]) },
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
        { name: "", type: "grid", schema: LOW_KEYS.map((name) => ({ name, selector: pct })) },
        { name: "", type: "grid", schema: [{ name: "stale_after", selector: duration }, { name: "offline_after", selector: duration }] },
      ],
    },
  ];

  const TRAP_FORM_KEYS = ["device", "name", "location", "style", ...ROLE_KEYS, ...LOW_KEYS, "stale_after", "offline_after"];

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
    /* Older browsers, as at the end of the card's STYLES: margins for flex gaps, then stand-ins for color-mix. KEEP
       THE COLOR-MIX BLOCK LAST. */
    @supports not (inset: 0) {
      summary, button.add { gap: 0; }
      summary > * + * { margin-left: 8px; }
      button.add > * + * { margin-left: 6px; }
    }
    @supports not (color: color-mix(in srgb, red 50%, blue)) {
      button:hover:not(:disabled) { background: rgba(128, 128, 128, .16); }
      button.add { border: 1px solid rgba(3, 169, 244, .5); }
    }
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
      // Throwing hands the config back to Home Assistant's code editor, which shows the message.
      if (!config || typeof config !== "object") throw new Error("Invalid configuration");
      const traps = config.traps;
      if (traps !== undefined && traps !== null && !Array.isArray(traps)) throw new Error("`traps` must be a list.");
      const next = { ...config };
      if (!Array.isArray(traps)) {
        // The single-trap form becomes one entry under `traps:`, so the first edit doesn't write `traps: []` and
        // empty the card. Card options, `style` among them, stay on the card.
        const trap = shorthandTrap(config);
        for (const k of TRAP_ONLY_KEYS) delete next[k];
        next.traps = trap ? [trap] : [];
      }
      this._config = next;
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
      const shown = { ...CARD_DEFAULTS };
      for (const k of LOW_KEYS) delete shown[k];
      const data = { ...shown, ...rest };
      for (const k of DURATION_KEYS) data[k] = durationObject(data[k]);
      // The dropdowns only know the lower-case values the card also accepts as "Goodnature" or "Status". The card's
      // `style: auto` is its default.
      for (const k of ["style", "sort"]) if (keyword(data[k])) data[k] = keyword(data[k]);
      if (data.style === "auto") data.style = CARD_DEFAULTS.style;
      return data;
    }

    _trapData(trap) {
      const data = {};
      for (const k of TRAP_FORM_KEYS) {
        const v = trap[k];
        if (v === undefined || v === null || v === false) continue;
        data[k] = ROLE_KEYS.includes(k) && typeof v === "object" ? v.entity : v;
      }
      data.style = keyword(data.style) || "auto";
      for (const k of DURATION_KEYS) data[k] = durationObject(data[k]);
      const actions = (Array.isArray(trap.actions) ? trap.actions : []).map((a) => (a && typeof a === "object" ? a.entity : a)).filter((a) => typeof a === "string" && a && a !== "none");
      if (actions.length) data.actions = actions;
      const holds = canonicalHolds(trap.holds);
      for (const k of HOLD_FIELDS) {
        const h = holds[k] && holds[k].value;
        const id = h && typeof h === "object" ? h.entity : h;
        if (typeof id === "string" && id && id !== "none") data[`hold_${k}`] = id;
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
      if (LOW_KEYS.includes(name)) {
        const card = toNum(this._config[name], CARD_DEFAULTS[name]);
        return `Blank = card setting (${card}%)`;
      }
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
      for (const key of ["title", "show_summary", "show_scene", "animations", "sort", "columns", "style", ...LOW_KEYS, "stale_after", "offline_after"]) {
        const v = value[key];
        const isDefault = v === CARD_DEFAULTS[key] && !LOW_KEYS.includes(key);
        if (v === undefined || v === null || v === "" || isDefault || (DURATION_KEYS.includes(key) && !parseDuration(v))) delete next[key];
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
        // An explicit `false`, or a threshold turned off with `none`, `off`, `never` or 0, shows as an empty field.
        // Keep it, or the trap would go back to the device's entity or the card's threshold.
        if (empty && (original[k] === false || (DURATION_KEYS.includes(k) && original[k] !== undefined && isOff(original[k])))) continue;
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

      // Hold actions: written under their canonical key, preserving object form and an explicit `false` or `none`.
      const holds = { ...(original.holds && typeof original.holds === "object" ? original.holds : {}) };
      const current = canonicalHolds(original.holds);
      for (const k of HOLD_FIELDS) {
        const v = value[`hold_${k}`];
        const prev = current[k];
        if (prev) delete holds[prev.key];
        if (v) holds[k] = prev && prev.value && typeof prev.value === "object" ? { ...prev.value, entity: v } : v;
        else if (prev && (prev.value === false || prev.value === null || prev.value === "none" || (prev.value && typeof prev.value === "object" && !prev.value.entity))) holds[prev.key] = prev.value;
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
      description: "Status of smart rodent traps: catches, strikes, battery, bait, CO\u2082, connectivity and re-arming.",
      preview: true,
      documentationURL: "https://github.com/kedube/ha-rodent-traps",
      getEntitySuggestion: entitySuggestion,
    });
  }

  console.info(
    `%c RODENT-TRAP-CARD %c ${VERSION} `,
    "color:#fff;background:#a8703a;font-weight:700;border-radius:3px 0 0 3px",
    "color:#a8703a;background:#f7c948;font-weight:700;border-radius:0 3px 3px 0"
  );
})();

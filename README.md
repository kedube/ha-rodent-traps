# Rodent Trap Card

A Home Assistant dashboard card that shows the state of your smart rodent traps at a glance: catches, strikes, battery, bait, connectivity and whether a trap needs re-arming. Each trap gets an animated illustration. When a trap is armed, a mouse wanders up to sniff the cheese. When a catch comes in, the bar snaps shut.

[![Open your Home Assistant instance and open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=kedube&repository=ha-rodent-traps&category=plugin)

<p align="center">
  <img src="images/snap.gif" alt="A trap tile: a mouse sniffs the cheese, then the bar snaps shut and the tile turns red with a catch alert" width="420">
</p>

![The card in a dark theme with five traps, most urgent first: a catch, a sprung trap, an offline trap, a trap with low battery and bait, and an armed trap](images/card-dark.png)

## Features

- **Any number of traps in one card.** Each trap uses only the entities it has, so a trap with just a battery sensor and a catch sensor sits happily next to one that reports everything.
- **Six readings per trap:** catch (kill) alert, strikes, battery, bait remaining, online state and needs re-arm.
- **Animated trap illustration** for each state:
  - **Armed:** a mouse peeks in and sniffs the cheese.
  - **Catch:** the bar snaps down (with a "SNAP!" when it happens live) and the tile glows red.
  - **Sprung:** the trap shows as sprung with a spinning re-arm badge.
  - **Offline:** the trap is greyed out with a no-signal badge.
- **The cheese shrinks as bait runs low** and is gone when the bait is empty.
- **Summary chips** in the header show catches, traps to re-arm, offline traps, traps that need attention and total strikes.
- **Sorting:** most urgent first, by name, or the order you wrote them.
- **Visual editor.** Add, reorder and remove traps and pick entities without writing YAML.
- **Reads many kinds of state:** binary sensors, counts, percentages, `input_number`/`number` ranges, text statuses like `sprung` or `armed`, and attributes. You can override how any entity is read.
- **Fits in anywhere.** It follows your theme (light and dark), fits the sections and masonry views, and has keyboard-accessible readings. It respects your device's reduced-motion setting and pauses animations when the card is off screen.

## Installation

### HACS (recommended)

The card isn't in the HACS default store yet, so add it as a custom repository:

1. In Home Assistant, open **HACS**.
2. Open the **⋮** menu (top right) and choose **Custom repositories**.
3. Enter `https://github.com/kedube/ha-rodent-traps` as the repository and choose **Dashboard** as the type. Select **Add**.
4. Search HACS for **Rodent Trap Card**, open it and select **Download**.
5. Reload your browser (on the mobile app, restart the app or clear the frontend cache).

The **Open in HACS** button at the top of this page does steps 1 to 3 for you.

HACS registers the dashboard resource for you. If you manage dashboards in YAML mode, add the resource yourself:

```yaml
lovelace:
  resources:
    - url: /hacsfiles/ha-rodent-traps/rodent-trap-card.js
      type: module
```

### Manual

1. Download [`dist/rodent-trap-card.js`](dist/rodent-trap-card.js) and copy it to `<config>/www/rodent-trap-card.js`.
2. Go to **Settings → Dashboards → ⋮ → Resources** and add `/local/rodent-trap-card.js` as a **JavaScript module**. If you don't see **Resources**, turn on **Advanced mode** in your user profile.
3. Reload your browser.

## Quick start

Add a card to a dashboard, search for **Rodent Trap Card** and set up your traps in the visual editor. Or paste YAML like this:

```yaml
type: custom:rodent-trap-card
title: Rodent Traps
sort: status
traps:
  - name: Garage
    location: Behind the freezer
    kill: binary_sensor.garage_trap_kill
    rearm: binary_sensor.garage_trap_needs_rearm
    strikes: sensor.garage_trap_strikes
    battery: sensor.garage_trap_battery
    bait: input_number.garage_trap_bait
    online: binary_sensor.garage_trap_connectivity
  - name: Attic
    location: North eaves
    kill: sensor.attic_trap_kills_present
    strikes: sensor.attic_trap_total_kills
    battery: sensor.attic_trap_battery_level
```

Every entity is optional. The card shows only the readings you configure.

## Configuration

### Card options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | **required** | `custom:rodent-trap-card` |
| `traps` | list | **required** | The traps to show. See [Trap options](#trap-options). |
| `title` | string | none | Card heading. Leave it out for no title. |
| `show_summary` | boolean | `true` | Show the summary chips in the header. |
| `show_scene` | boolean | `true` | Show the trap illustrations. Set to `false` for a compact card. |
| `animations` | boolean | `true` | Set to `false` to turn off all motion. The reduced-motion setting on your device is always respected. |
| `sort` | `config` \| `status` \| `name` | `config` | `status` puts the most urgent traps first: catches, then re-arms, offline, warnings and OK. |
| `columns` | number | automatic | Fixed number of columns. By default, tiles flow into as many columns (about 290 px wide) as fit. |
| `battery_low` | number | `20` | Battery percentage at or below which a trap is flagged. |
| `bait_low` | number | `25` | Bait percentage at or below which a trap is flagged. |

### Trap options

| Option | Type | Description |
| --- | --- | --- |
| `name` | string | Trap name. Defaults to `Trap 1`, `Trap 2`, and so on. |
| `location` | string | Shown under the name. |
| `kill` | entity | Catch or kill alert. |
| `rearm` | entity | Whether the trap has been sprung and needs re-arming. |
| `strikes` | entity | Number of strikes or catches. Added up in the header. |
| `battery` | entity | Battery level (percent) or a low-battery binary sensor. |
| `bait` | entity | Bait remaining. See [How states are read](#how-states-are-read). |
| `online` | entity | Connectivity. If you leave it out, the trap counts as offline when **all** its entities are `unavailable`. |
| `battery_low` | number | Overrides the card's `battery_low` for this trap. |
| `bait_low` | number | Overrides the card's `bait_low` for this trap. |

For a single trap, you can put the trap options directly on the card and skip `traps:`.

### Advanced entity options

Any entity option (`kill`, `rearm`, `strikes`, `battery`, `bait`, `online`) accepts an object instead of an entity ID. Use it when a device reports something the card doesn't understand by default:

```yaml
traps:
  - name: Pantry
    kill:
      entity: sensor.pantry_trap_status
      active_states: [caught, mouse inside]  # these states count as a catch
    rearm:
      entity: binary_sensor.pantry_trap_armed
      invert: true                           # "on" means armed, so flip it
    battery:
      entity: sensor.pantry_trap
      attribute: battery_level               # read an attribute, not the state
    bait:
      entity: sensor.pantry_bait_weight
      max: 30                                # 30 g is a full bait station
```

| Key | Applies to | Description |
| --- | --- | --- |
| `entity` | all | The entity ID (required in object form). |
| `attribute` | all | Read this attribute instead of the entity's state. |
| `invert` | `kill`, `rearm`, `online`, binary `battery`/`bait` | Flip the on/off meaning. |
| `active_states` | `kill`, `rearm`, `online` | List of states that mean "yes". Matching ignores case and treats spaces and underscores the same. |
| `min`, `max` | `battery`, `bait` | Range that maps to 0–100%. Defaults to 0–100, or the helper's own min/max for `input_number` and `number` entities. |
| `unit` | `battery`, `bait` | Unit to display, overriding the entity's `unit_of_measurement`. |

The visual editor keeps these extra keys when you change the entity, so you can mix the editor with YAML.

### How states are read

| Reading | Counts as "yes" | Counts as "no" |
| --- | --- | --- |
| `kill` | `on`, any number above 0 (for example a *kills present* count), `triggered`, `caught`, `detected`, `occupied`, `captured`, `sprung`, `alert` | `off`, `0`, `clear`, `idle`, `armed`, `empty`, `ready` |
| `rearm` | `on`, number above 0, `needs_rearm`, `sprung`, `triggered`, `tripped`, `disarmed`, `reset` | `off`, `0`, `armed`, `ready`, `set`, `idle` |
| `online` | `on`, `online`, `connected`, `home`, or any number (such as a signal-strength sensor) | `off`, `offline`, `disconnected`, `not_home`, or the entity being `unavailable` |

- **`strikes`** is any numeric state.
- **`battery`** is a percentage. A binary sensor counts as a low battery when `on`. Words like `low`, `critical`, `ok` and `full` also work.
- **`bait`** is a percentage, or a value scaled by an `input_number`/`number` range (a 0–5 helper at 3 shows **3/5**). The words `full`, `high`, `half`, `medium`, `low` and `empty` also work, so an `input_select` is a simple way to track bait by hand. A binary sensor means low bait when `on`.
- **`unavailable` or `unknown`** show as **—**.

### Status and colours

Each trap gets one status. The highest one that applies wins:

| Status | Colour | When |
| --- | --- | --- |
| Catch detected | red, pulsing | `kill` is on |
| Needs re-arm | amber | `rearm` is on |
| Offline | grey | `online` is off, or every entity is unavailable |
| Low battery / low bait / entity not found | amber | a reading is at or below its threshold, or an entity ID doesn't exist |
| Armed / All good | green | none of the above |

Colours come from your theme's `--error-color`, `--warning-color`, `--success-color` and `--disabled-text-color`.

### Tapping

- Tapping a trap's name or its illustration opens the more-info dialog for its main entity: `kill`, or `rearm`, `online` or the first configured entity if `kill` isn't set.
- Tapping a reading opens that reading's entity. Readings can also be reached with the keyboard and opened with Enter or Space.

## Examples

### A classic snap trap with a contact sensor

Stick a Zigbee door/window sensor to a snap trap so that it opens when the bar swings. Track strikes with a counter helper and bait with an `input_select` that you update by hand:

```yaml
type: custom:rodent-trap-card
traps:
  - name: Pantry
    rearm: binary_sensor.pantry_trap_contact          # opens when the trap snaps
    battery: sensor.pantry_trap_contact_battery
    strikes: counter.pantry_trap_strikes
    bait: input_select.pantry_trap_bait               # Full / Half / Low / Empty
```

```yaml
# automations.yaml: count every snap
- alias: Pantry trap strike
  triggers:
    - trigger: state
      entity_id: binary_sensor.pantry_trap_contact
      to: "on"
  actions:
    - action: counter.increment
      target:
        entity_id: counter.pantry_trap_strikes
```

### Traps that report kill counts

Many connected traps expose a *kills present* count (catches waiting to be emptied) and a *total kills* count. Use the first for `kill` and the second for `strikes`:

```yaml
- name: Crawlspace
  kill: sensor.crawlspace_trap_kills_present
  strikes: sensor.crawlspace_trap_total_kills
  battery: sensor.crawlspace_trap_battery_level
  online: sensor.crawlspace_trap_wireless_signal    # any numeric reading means online
```

### Get a phone notification on a catch

The card only displays state. Pair it with an automation to get alerts:

```yaml
- alias: Rodent trap catch
  triggers:
    - trigger: state
      entity_id:
        - binary_sensor.garage_trap_kill
        - binary_sensor.basement_trap_kill
      to: "on"
  actions:
    - action: notify.mobile_app_your_phone
      data:
        title: Trap caught something
        message: "{{ trigger.to_state.name }} needs emptying."
```

## Troubleshooting

- **"Custom element doesn't exist: rodent-trap-card".** The resource isn't loaded. Check the resource URL, then reload the browser. On the mobile app, clear the frontend cache under **Settings → Companion app → Debugging**.
- **A reading shows "—".** The entity is `unavailable` or `unknown`, or its state is a word the card doesn't recognise. Add `active_states` (on/off readings) or `min`/`max` (levels) as shown in [Advanced entity options](#advanced-entity-options).
- **"Entity not found".** An entity ID is misspelled or the entity was removed. The tile lists the IDs it couldn't find.
- **The visual editor says it can't load.** Switch to the code editor. Everything is also configurable in YAML.

## Development

The card is a single dependency-free file, [`dist/rodent-trap-card.js`](dist/rodent-trap-card.js), with no build step.

- **Try it without Home Assistant:** open [`demo/index.html`](demo/index.html) in a browser. It runs the real card against simulated entities and has buttons to trigger catches, drain batteries, eat bait and take traps offline.
- **Release:** bump `VERSION` at the top of the card file, commit, then publish a GitHub release tagged `vX.Y.Z`. HACS offers the new version to users.
- **CI:** [`.github/workflows/validate.yml`](.github/workflows/validate.yml) runs the HACS validation action and a syntax check.

## License

[GPL-3.0](LICENSE)

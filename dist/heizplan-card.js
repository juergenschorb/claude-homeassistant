/*
 * Heizplan Card
 * Wochenplan pro Raum mit Komfort/Eco/Frostschutz, Tageseditor und Plänen für Normal/Urlaub.
 * Speichert die Pläne in der Scheduler-Komponente (HACS, nielsfaber/scheduler-component):
 * je Gruppe gleicher Tage ein Zeitplan, der zu jedem Wechselpunkt
 * climate.set_preset_mode am Raumthermostat aufruft.
 */

const CARD_VERSION = "0.3.0";

const DAYS = [
  { key: "mon", short: "Mo", long: "Montag" },
  { key: "tue", short: "Di", long: "Dienstag" },
  { key: "wed", short: "Mi", long: "Mittwoch" },
  { key: "thu", short: "Do", long: "Donnerstag" },
  { key: "fri", short: "Fr", long: "Freitag" },
  { key: "sat", short: "Sa", long: "Samstag" },
  { key: "sun", short: "So", long: "Sonntag" },
];

const DEFAULT_MODES = [
  { key: "comfort", label: "Komfort", color: "#F39C12" },
  { key: "eco", label: "Eco", color: "#3D8BD9" },
  { key: "frost", label: "Frostschutz", color: "#7A8A99" },
];

const STEP = 15; // Minuten-Raster
const DAY_MIN = 1440;

const pad = (n) => String(n).padStart(2, "0");
const fmt = (m) => (m >= DAY_MIN ? "24:00" : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const parseTime = (s) => {
  const [h, m] = String(s).split(":").map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
};
const toSchedTime = (m) => (m >= DAY_MIN ? "00:00" : fmt(m));
const snap = (m) => Math.round(m / STEP) * STEP;

function normalizeDay(entries) {
  // sortieren, bei 0 beginnen, gleiche Nachbarn zusammenfassen
  const list = entries
    .map((e) => ({ start: Math.max(0, Math.min(DAY_MIN - STEP, e.start)), mode: e.mode }))
    .sort((a, b) => a.start - b.start);
  if (!list.length) return [];
  list[0].start = 0;
  const out = [];
  for (const e of list) {
    const last = out[out.length - 1];
    if (last && last.start === e.start) {
      last.mode = e.mode;
      continue;
    }
    if (last && last.mode === e.mode) continue;
    out.push({ ...e });
  }
  return out;
}

function expandWeekdays(weekdays) {
  const res = new Set();
  for (const w of weekdays || []) {
    if (w === "daily") DAYS.forEach((d) => res.add(d.key));
    else if (w === "workday") ["mon", "tue", "wed", "thu", "fri"].forEach((d) => res.add(d));
    else if (w === "weekend") ["sat", "sun"].forEach((d) => res.add(d));
    else res.add(w);
  }
  return [...res];
}

class HeizplanCard extends HTMLElement {
  static getStubConfig(hass) {
    const climate = Object.keys(hass?.states || {}).find((e) => e.startsWith("climate."));
    return { entity: climate || "climate.eg_wohnzimmer" };
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "climate" } } },
        { name: "name", selector: { text: {} } },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "temperature_entity", selector: { entity: { domain: "sensor" } } },
            { name: "window_entity", selector: { entity: { domain: "binary_sensor" } } },
            { name: "valve_entity", selector: { entity: { domain: ["number", "sensor"] } } },
            {
              name: "default_mode",
              selector: {
                select: {
                  options: [
                    { value: "eco", label: "Eco" },
                    { value: "comfort", label: "Komfort" },
                    { value: "frost", label: "Frostschutz" },
                  ],
                },
              },
            },
          ],
        },
        {
          type: "expandable",
          name: "",
          title: "Heizperiode und Heizmodus (optional)",
          schema: [
            { name: "season_entity", selector: { entity: { domain: ["input_boolean", "binary_sensor", "switch"] } } },
            { name: "mode_entity", selector: { entity: { domain: ["input_select", "select"] } } },
            {
              type: "grid",
              name: "",
              schema: [
                { name: "mode_heat", selector: { text: {} } },
                { name: "mode_vacation", selector: { text: {} } },
              ],
            },
          ],
        },
      ],
      computeHelper: (s) =>
        ({
          season_entity: "Plan läuft nur, wenn dieser Schalter an ist",
          mode_entity: "Zentrale Auswahl, z. B. Aus / Heizen / Urlaub",
          mode_heat: "Optionstext für den Normal-Plan, genau wie in der Auswahl",
          mode_vacation: "Optionstext für den Urlaubsplan (leer = kein Urlaubsplan)",
        })[s.name],
      computeLabel: (s) =>
        ({
          entity: "Raumthermostat",
          name: "Name",
          temperature_entity: "Raumtemperatur (optional)",
          window_entity: "Fensterkontakt (optional)",
          valve_entity: "Ventilstellung (optional)",
          default_mode: "Grundmodus für neue Pläne",
          season_entity: "Heizperiode",
          mode_entity: "Heizmodus",
          mode_heat: "Option „Heizen“",
          mode_vacation: "Option „Urlaub“",
        })[s.name],
    };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error("Bitte 'entity' (Raumthermostat) angeben");
    this._config = {
      default_mode: "eco",
      ...config,
    };
    this._modes = (config.modes || DEFAULT_MODES).map((m) => ({
      ...m,
      preset: m.preset || m.key,
    }));
    this._tag = config.tag || `heizplan_${config.entity.replace(/^climate\./, "")}`;
    // Pläne (z. B. Normal / Urlaub), jeweils mit eigenen Bedingungen
    const plans = config.plans && config.plans.length ? config.plans : this._plansFromConfig(config);
    this._plans = plans.map((pl, i) => ({
      ...pl,
      label: pl.label || pl.key,
      tag: pl.tag || (i === 0 ? this._tag : `${this._tag}_${pl.key}`),
      conditions: (pl.conditions || []).map((c) => ({ entity_id: c.entity, value: String(c.state) })),
    }));
    if (!this._plans.some((pl) => pl.key === this._plan)) this._plan = this._plans[0].key;
    this._weeks = null;
    this._schedByPlan = {};
    this._edit = null;
    this._render();
  }

  // Pläne aus Heizperiode / Heizmodus ableiten (GUI-Konfiguration)
  _plansFromConfig(c) {
    const base = c.season_entity ? [{ entity: c.season_entity, state: "on" }] : [];
    const normal = { key: "normal", label: "Normal", conditions: [...base] };
    if (c.mode_entity && c.mode_heat) normal.conditions.push({ entity: c.mode_entity, state: c.mode_heat });
    const plans = [normal];
    if (c.mode_entity && c.mode_vacation) {
      plans.push({
        key: "urlaub",
        label: "Urlaub",
        conditions: [...base, { entity: c.mode_entity, state: c.mode_vacation }],
      });
    }
    return plans;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
    if (!this._edit) this._render();
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    this._tick = setInterval(() => !this._edit && this._render(), 60000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    if (this._unsub) {
      this._unsub.then((u) => u && u()).catch(() => {});
      this._unsub = null;
    }
  }

  // ---------- Daten ----------
  get _week() {
    return this._weeks ? this._weeks[this._plan] || {} : null;
  }

  set _week(v) {
    if (!this._weeks) this._weeks = {};
    this._weeks[this._plan] = v;
  }

  _configWarning() {
    const c = this._config;
    const sel = c.mode_entity && this._hass?.states?.[c.mode_entity];
    if (!sel) return "";
    const opts = sel.attributes?.options || [];
    const bad = [c.mode_heat, c.mode_vacation].filter((o) => o && !opts.includes(o));
    return bad.length
      ? `Option ${bad.map((b) => `„${b}“`).join(", ")} gibt es in ${c.mode_entity} nicht (vorhanden: ${opts.join(", ")}).`
      : "";
  }

  _planObj(key = this._plan) {
    return this._plans.find((pl) => pl.key === key);
  }

  _planActive(pl) {
    const s = this._hass?.states || {};
    return pl.conditions.every((c) => s[c.entity_id]?.state === c.value);
  }

  _mode(key) {
    return this._modes.find((m) => m.key === key) || { key, label: key, color: "#555" };
  }

  _modeByPreset(preset) {
    return this._modes.find((m) => m.preset === preset)?.key || preset;
  }

  async _load() {
    if (!this._hass) return;
    try {
      const all = await this._hass.callWS({ type: "scheduler" });
      const weeks = {};
      for (const pl of this._plans) {
        const scheds = (all || []).filter((s) => (s.tags || []).includes(pl.tag));
        this._schedByPlan[pl.key] = scheds;
        const week = {};
        for (const s of scheds) {
          const entries = (s.timeslots || []).map((t) => ({
            start: parseTime(t.start),
            mode: this._modeByPreset(t.actions?.[0]?.service_data?.preset_mode),
          }));
          for (const d of expandWeekdays(s.weekdays)) week[d] = normalizeDay(entries);
        }
        weeks[pl.key] = week;
      }
      this._weeks = weeks;
      this._error = null;
      if (!this._unsub && this._hass.connection) {
        this._unsub = this._hass.connection
          .subscribeMessage(() => !this._saving && !this._edit && this._load(), { type: "scheduler_updated" })
          .catch(() => null);
      }
    } catch (e) {
      this._error = "Scheduler-Komponente nicht gefunden. Bitte über HACS installieren.";
      this._weeks = {};
    }
    this._render();
  }

  _dayEntries(day) {
    const e = this._week?.[day];
    return e && e.length ? e : [{ start: 0, mode: this._config.default_mode }];
  }

  async _save(newWeek) {
    const hass = this._hass;
    this._saving = true;
    this._render();
    try {
      // gleiche Tage gruppieren
      const groups = new Map();
      for (const d of DAYS) {
        const entries = normalizeDay(newWeek[d.key] || this._dayEntries(d.key));
        const k = JSON.stringify(entries);
        if (!groups.has(k)) groups.set(k, { entries, days: [] });
        groups.get(k).days.push(d.key);
      }
      const roomName = this._name();
      const plan = this._planObj();
      const planName = this._plans.length > 1 ? `${plan.label} ` : "";
      for (const s of this._schedByPlan[plan.key] || []) {
        await hass.callService("scheduler", "remove", { entity_id: s.entity_id });
      }
      let i = 0;
      for (const g of groups.values()) {
        i += 1;
        const timeslots = g.entries.map((e, idx) => ({
          start: fmt(e.start),
          stop: toSchedTime(idx + 1 < g.entries.length ? g.entries[idx + 1].start : DAY_MIN),
          ...(plan.conditions.length
            ? {
                conditions: plan.conditions.map((c) => ({ ...c, match_type: "is" })),
                condition_type: "and",
                track_conditions: true,
              }
            : {}),
          actions: [
            {
              service: "climate.set_preset_mode",
              entity_id: this._config.entity,
              service_data: { preset_mode: this._mode(e.mode).preset },
            },
          ],
        }));
        await hass.callService("scheduler", "add", {
          name: `Heizplan ${roomName} ${planName}${g.days.map((d) => DAYS.find((x) => x.key === d).short).join(" ")}`,
          weekdays: g.days,
          repeat_type: "repeat",
          tags: [plan.tag],
          timeslots,
        });
      }
      this._week = newWeek;
      this._edit = null;
      this._toast = "Gespeichert";
      // aktuellen Modus sofort setzen, damit der Raum nicht bis zum nächsten Wechsel wartet
      const now = new Date();
      const today = DAYS[(now.getDay() + 6) % 7].key;
      const cur = this._currentEntry(today, now.getHours() * 60 + now.getMinutes());
      if (cur && this._planActive(plan)) {
        await hass.callService("climate", "set_preset_mode", {
          entity_id: this._config.entity,
          preset_mode: this._mode(cur.mode).preset,
        });
      }
    } catch (e) {
      this._toast = `Fehler beim Speichern: ${e.message || e}`;
    }
    this._saving = false;
    await this._load();
    setTimeout(() => {
      this._toast = null;
      this._render();
    }, 3000);
  }

  _currentEntry(day, minute) {
    const entries = this._dayEntries(day);
    let cur = entries[0];
    for (const e of entries) if (e.start <= minute) cur = e;
    return cur;
  }

  _name() {
    const st = this._hass?.states?.[this._config.entity];
    return this._config.name || st?.attributes?.friendly_name || this._config.entity;
  }

  // ---------- Darstellung ----------
  _segments(entries) {
    return entries
      .map((e, i) => {
        const end = i + 1 < entries.length ? entries[i + 1].start : DAY_MIN;
        const m = this._mode(e.mode);
        return `<div class="seg" style="left:${(e.start / DAY_MIN) * 100}%;width:${((end - e.start) / DAY_MIN) * 100}%;background:${m.color}" title="${fmt(e.start)}–${fmt(end)} ${m.label}"></div>`;
      })
      .join("");
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const st = hass?.states?.[this._config.entity];
    const a = st?.attributes || {};
    const tempEnt = this._config.temperature_entity && hass?.states?.[this._config.temperature_entity];
    const ist = tempEnt ? parseFloat(tempEnt.state) : a.current_temperature;
    const soll = a.temperature;
    const preset = a.preset_mode;
    const win = this._config.window_entity && hass?.states?.[this._config.window_entity]?.state === "on";
    const valveSt = this._config.valve_entity && hass?.states?.[this._config.valve_entity];
    const valve = valveSt ? Math.round(parseFloat(valveSt.state)) : null;
    const now = new Date();
    const todayIdx = (now.getDay() + 6) % 7;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const presetMode = preset ? this._mode(this._modeByPreset(preset)) : null;

    const rows = DAYS.map((d, i) => {
      const entries = this._dayEntries(d.key);
      const marker = i === todayIdx ? `<div class="now" style="left:${(nowMin / DAY_MIN) * 100}%"></div>` : "";
      return `<div class="row ${i === todayIdx ? "today" : ""}" data-day="${d.key}">
        <div class="dlabel">${d.short}</div>
        <div class="bar">${this._segments(entries)}${marker}</div>
        <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
      </div>`;
    }).join("");

    const activePlan = this._plans.find((pl) => this._planActive(pl));
    const tabs =
      this._plans.length > 1
        ? `<div class="tabs">${this._plans
            .map(
              (pl) =>
                `<button class="tab ${pl.key === this._plan ? "sel" : ""}" data-plan="${pl.key}">${
                  activePlan?.key === pl.key ? '<i class="dot"></i>' : ""
                }${pl.label}</button>`
            )
            .join("")}</div>`
        : "";
    const planInfo =
      this._plans.length > 1 || this._plans[0].conditions.length
        ? activePlan
          ? `<span class="pinfo">Plan aktiv: ${activePlan.label}</span>`
          : `<span class="pinfo off">Kein Plan aktiv (Heizung aus / außerhalb Heizperiode)</span>`
        : "";
    const legend = this._modes
      .map((m) => `<span class="lg"><i style="background:${m.color}"></i>${m.label}</span>`)
      .join("");

    const presetBtns = this._modes
      .map(
        (m) =>
          `<button class="pbtn ${presetMode?.key === m.key ? "active" : ""}" data-preset="${m.preset}" style="--c:${m.color}">${m.label}</button>`
      )
      .join("");

    if (this._edit) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${this._editorHtml()}
        ${this._toast ? `<div class="toast">${this._toast}</div>` : ""}
        ${this._saving ? `<div class="toast">Speichere …</div>` : ""}</ha-card>`;
      this._bindEditor();
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="head">
          <div>
            <div class="title">${this._name()}</div>
            <div class="sub">
              ${presetMode ? `<span class="chip" style="--c:${presetMode.color}">${presetMode.label}</span>` : ""}
              ${soll != null ? `<span>Soll ${Number(soll).toFixed(1)} °C</span>` : ""}
              ${valve != null && !isNaN(valve) ? `<span><ha-icon icon="mdi:valve"></ha-icon>${valve} %</span>` : ""}
              ${planInfo}
              ${win ? `<span class="warn"><ha-icon icon="mdi:window-open-variant"></ha-icon>Fenster offen</span>` : ""}
            </div>
          </div>
          <div class="ist">${ist != null && !isNaN(ist) ? Number(ist).toFixed(1) : "–"}<small>°C</small></div>
        </div>
        <div class="presets">${presetBtns}</div>
        ${this._error ? `<div class="err">${this._error}</div>` : ""}
        ${this._configWarning() ? `<div class="err">${this._configWarning()}</div>` : ""}
        ${tabs}
        <div class="week">
          <div class="scale"><span></span><div>${[0, 6, 12, 18, 24].map((h) => `<b style="left:${(h / 24) * 100}%">${h}</b>`).join("")}</div><span></span></div>
          ${this._week ? rows : `<div class="loading">Lade Zeitpläne …</div>`}
        </div>
        <div class="legend">${legend}</div>
        ${this._toast ? `<div class="toast">${this._toast}</div>` : ""}
        ${this._saving ? `<div class="toast">Speichere …</div>` : ""}
      </ha-card>`;

    this.shadowRoot.querySelectorAll(".row").forEach((r) =>
      r.addEventListener("click", () => this._openEditor(r.dataset.day))
    );
    this.shadowRoot.querySelectorAll(".tab").forEach((b) =>
      b.addEventListener("click", () => {
        this._plan = b.dataset.plan;
        this._render();
      })
    );
    this.shadowRoot.querySelectorAll(".pbtn").forEach((b) =>
      b.addEventListener("click", () =>
        this._hass.callService("climate", "set_preset_mode", {
          entity_id: this._config.entity,
          preset_mode: b.dataset.preset,
        })
      )
    );
  }

  // ---------- Tageseditor ----------
  _openEditor(day) {
    if (!this._week) return;
    this._edit = {
      day,
      entries: this._dayEntries(day).map((e) => ({ ...e })),
      copyTo: new Set([day]),
    };
    this._render();
  }

  _editorHtml() {
    const ed = this._edit;
    const dayName = DAYS.find((d) => d.key === ed.day).long;
    const entries = ed.entries;
    const handles = entries
      .slice(1)
      .map(
        (e, i) =>
          `<div class="handle" data-idx="${i + 1}" style="left:${(e.start / DAY_MIN) * 100}%"><span>${fmt(e.start)}</span></div>`
      )
      .join("");
    const opts = (sel) =>
      this._modes.map((m) => `<option value="${m.key}" ${m.key === sel ? "selected" : ""}>${m.label}</option>`).join("");
    const list = entries
      .map((e, i) => {
        const end = i + 1 < entries.length ? entries[i + 1].start : DAY_MIN;
        return `<div class="entry">
          <i style="background:${this._mode(e.mode).color}"></i>
          ${
            i === 0
              ? `<span class="t0">00:00</span>`
              : `<select class="time" data-idx="${i}">${this._timeOptions(entries[i - 1].start + STEP, end - STEP, e.start)}</select>`
          }
          <span class="dash">–</span><span class="tend">${fmt(end)}</span>
          <select data-idx="${i}">${opts(e.mode)}</select>
          ${i === 0 ? `<span class="del"></span>` : `<button class="icon del" data-idx="${i}" title="Löschen"><ha-icon icon="mdi:delete-outline"></ha-icon></button>`}
        </div>`;
      })
      .join("");
    const days = DAYS.map(
      (d) =>
        `<label class="dchk ${ed.copyTo.has(d.key) ? "on" : ""}"><input type="checkbox" data-day="${d.key}" ${ed.copyTo.has(d.key) ? "checked" : ""}>${d.short}</label>`
    ).join("");
    return `
        <div class="editor">
          <div class="ehead">
            <button class="icon back" title="Zurück"><ha-icon icon="mdi:arrow-left"></ha-icon></button>
            <div class="etitle">${dayName}${this._plans.length > 1 ? ` <span class="eplan">· ${this._planObj().label}</span>` : ""}</div>
          </div>
          <div class="ebar-wrap">
            <div class="ebar">${this._segments(entries)}${handles}</div>
            <div class="escale">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<b style="left:${(h / 24) * 100}%">${h}</b>`).join("")}</div>
          </div>
          <div class="hint">Auf den Balken tippen = neuer Abschnitt · Griffe ziehen = verschieben · Raster 15 min</div>
          <div class="entries">${list}</div>
          <button class="add"><ha-icon icon="mdi:plus"></ha-icon>Zeitraum hinzufügen</button>
          <div class="copy">
            <div class="clabel">Gilt für</div>
            <div class="dchks">${days}</div>
            <div class="quick">
              <button data-q="workday">Mo–Fr</button><button data-q="weekend">Sa–So</button><button data-q="all">Alle</button>
            </div>
          </div>
          <div class="actions">
            <button class="cancel">Abbrechen</button>
            <button class="save">Speichern</button>
          </div>
        </div>`;
  }

  _timeOptions(lo, hi, sel) {
    let html = "";
    for (let m = lo; m <= hi; m += STEP) {
      html += `<option value="${m}" ${m === sel ? "selected" : ""}>${fmt(m)}</option>`;
    }
    return html;
  }

  _rerenderEditor() {
    this._edit.entries = normalizeDay(this._edit.entries);
    this._render();
  }

  _bindEditor() {
    const root = this.shadowRoot;
    const ed = this._edit;
    root.querySelector(".back").addEventListener("click", () => this._closeEditor());
    root.querySelector(".cancel").addEventListener("click", () => this._closeEditor());
    root.querySelector(".save").addEventListener("click", () => {
      const week = { ...this._week };
      const entries = normalizeDay(ed.entries);
      for (const d of ed.copyTo) week[d] = entries.map((e) => ({ ...e }));
      this._save(week);
    });
    root.querySelector(".add").addEventListener("click", () => {
      // neuen Block ans Ende des längsten Abschnitts setzen
      const ents = ed.entries;
      let best = 0;
      let bestLen = -1;
      ents.forEach((e, i) => {
        const end = i + 1 < ents.length ? ents[i + 1].start : DAY_MIN;
        if (end - e.start > bestLen) {
          bestLen = end - e.start;
          best = i;
        }
      });
      const s = ents[best].start;
      const end = best + 1 < ents.length ? ents[best + 1].start : DAY_MIN;
      const mid = snap(s + (end - s) / 3);
      const mid2 = snap(s + ((end - s) * 2) / 3);
      const other = this._modes.find((m) => m.key !== ents[best].mode)?.key || ents[best].mode;
      ents.splice(best + 1, 0, { start: mid, mode: other }, { start: mid2, mode: ents[best].mode });
      ed.entries = ents.filter((e, i, arr) => i === 0 || e.start > arr[i - 1].start || e.start === 0);
      this._rerenderEditor();
    });
    root.querySelectorAll(".entry select:not(.time)").forEach((s) =>
      s.addEventListener("change", () => {
        ed.entries[+s.dataset.idx].mode = s.value;
        this._rerenderEditor();
      })
    );
    root.querySelectorAll(".entry select.time").forEach((sel) =>
      sel.addEventListener("change", () => {
        ed.entries[+sel.dataset.idx].start = +sel.value;
        this._rerenderEditor();
      })
    );
    root.querySelectorAll(".entry .del").forEach((b) =>
      b.addEventListener("click", () => {
        if (!b.dataset.idx) return;
        ed.entries.splice(+b.dataset.idx, 1);
        this._rerenderEditor();
      })
    );
    root.querySelectorAll(".dchk input").forEach((c) =>
      c.addEventListener("change", () => {
        if (c.checked) ed.copyTo.add(c.dataset.day);
        else if (c.dataset.day !== ed.day) ed.copyTo.delete(c.dataset.day);
        this._render();
      })
    );
    root.querySelectorAll(".quick button").forEach((b) =>
      b.addEventListener("click", () => {
        const set = {
          workday: ["mon", "tue", "wed", "thu", "fri"],
          weekend: ["sat", "sun"],
          all: DAYS.map((d) => d.key),
        }[b.dataset.q];
        ed.copyTo = new Set([ed.day, ...set]);
        this._render();
      })
    );
    // Tippen auf den Balken: 2-h-Abschnitt an dieser Stelle einfügen
    const bar = root.querySelector(".ebar");
    bar.addEventListener("click", (ev) => {
      if (ev.target.closest(".handle")) return;
      const rect = bar.getBoundingClientRect();
      const m = Math.floor((((ev.clientX - rect.left) / rect.width) * DAY_MIN) / STEP) * STEP;
      const ents = ed.entries;
      let i = 0;
      ents.forEach((e, k) => {
        if (e.start <= m) i = k;
      });
      const segEnd = i + 1 < ents.length ? ents[i + 1].start : DAY_MIN;
      const start = Math.max(ents[i].start, Math.min(m, segEnd - 2 * STEP));
      const end = Math.min(segEnd, start + 120);
      if (end - start < 2 * STEP) return;
      const cur = ents[i].mode;
      const mode = cur === "comfort" ? "eco" : this._modes.some((x) => x.key === "comfort") ? "comfort" : this._modes[0].key;
      const ins = [{ start, mode }];
      if (end < segEnd) ins.push({ start: end, mode: cur });
      ents.splice(i + 1, 0, ...ins);
      this._rerenderEditor();
    });
    // Ziehen der Griffe
    root.querySelectorAll(".handle").forEach((h) => {
      h.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        h.setPointerCapture(ev.pointerId);
        h.classList.add("drag");
        const i = +h.dataset.idx;
        const rect = bar.getBoundingClientRect();
        const lo = ed.entries[i - 1].start + STEP;
        const hi = (i + 1 < ed.entries.length ? ed.entries[i + 1].start : DAY_MIN) - STEP;
        const move = (e) => {
          const m = snap(((e.clientX - rect.left) / rect.width) * DAY_MIN);
          ed.entries[i].start = Math.max(lo, Math.min(hi, m));
          h.style.left = `${(ed.entries[i].start / DAY_MIN) * 100}%`;
          h.querySelector("span").textContent = fmt(ed.entries[i].start);
          const segs = bar.querySelectorAll(".seg");
          const upd = (k) => {
            const e2 = ed.entries[k];
            const end = k + 1 < ed.entries.length ? ed.entries[k + 1].start : DAY_MIN;
            segs[k].style.left = `${(e2.start / DAY_MIN) * 100}%`;
            segs[k].style.width = `${((end - e2.start) / DAY_MIN) * 100}%`;
          };
          upd(i - 1);
          upd(i);
        };
        const up = () => {
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
          this._rerenderEditor();
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
    });
  }

  _closeEditor() {
    this._edit = null;
    this._render();
  }
}

const STYLE = `
  :host { --bg: #2b2b2b; --bg2: #353535; --fg: #f2f2f2; --fg2: #a8a8a8; --acc: #69C350; --r: 18px; }
  ha-card { display: block; background: var(--bg); color: var(--fg); border-radius: var(--r); padding: 16px; position: relative; overflow: hidden; font-family: var(--paper-font-body1_-_font-family, system-ui, sans-serif); }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .title { font-size: 18px; font-weight: 600; }
  .sub { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; color: var(--fg2); font-size: 13px; align-items: center; }
  .sub span { display: inline-flex; align-items: center; gap: 3px; }
  .sub ha-icon { --mdc-icon-size: 16px; }
  .chip { background: color-mix(in srgb, var(--c) 25%, transparent); color: var(--c); padding: 2px 10px; border-radius: 10px; font-weight: 600; }
  .warn { color: #E5534B; }
  .ist { font-size: 40px; font-weight: 300; line-height: 1; white-space: nowrap; }
  .ist small { font-size: 16px; color: var(--fg2); margin-left: 2px; }
  .presets { display: flex; gap: 8px; margin: 14px 0 6px; }
  .pbtn { flex: 1; background: var(--bg2); color: var(--fg); border: 1px solid transparent; border-radius: 12px; padding: 8px 4px; font-size: 13px; cursor: pointer; }
  .pbtn.active { border-color: var(--c); color: var(--c); background: color-mix(in srgb, var(--c) 15%, var(--bg2)); font-weight: 600; }
  .week { margin-top: 10px; }
  .tabs { display: flex; gap: 6px; margin-top: 12px; background: var(--bg2); border-radius: 12px; padding: 4px; }
  .tab { flex: 1; background: none; border: none; color: var(--fg2); border-radius: 9px; padding: 7px 4px; cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .tab.sel { background: var(--bg); color: var(--fg); font-weight: 600; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--acc); display: inline-block; }
  .pinfo { color: var(--acc); }
  .pinfo.off { color: var(--fg2); }
  .eplan { color: var(--fg2); font-weight: 400; }
  .scale, .row { display: grid; grid-template-columns: 28px 1fr 20px; align-items: center; gap: 8px; }
  .scale > div { position: relative; height: 16px; font-size: 11px; color: var(--fg2); }
  .scale b, .escale b { position: absolute; transform: translateX(-50%); font-weight: 400; }
  .scale b:first-child, .escale b:first-child { transform: none; }
  .scale b:last-child, .escale b:last-child { transform: translateX(-100%); }
  .row { padding: 5px 0; cursor: pointer; border-radius: 10px; }
  .row:hover { background: var(--bg2); }
  .dlabel { font-size: 13px; color: var(--fg2); text-align: center; }
  .row.today .dlabel { color: var(--acc); font-weight: 700; }
  .bar { position: relative; height: 22px; background: var(--bg2); border-radius: 6px; overflow: hidden; }
  .seg { position: absolute; top: 0; bottom: 0; }
  .seg + .seg { box-shadow: inset 1px 0 0 rgba(0,0,0,.35); }
  .now { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #fff; box-shadow: 0 0 4px #000; }
  .chev { --mdc-icon-size: 18px; color: var(--fg2); }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: var(--fg2); }
  .lg i, .entry i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; }
  .err { background: #5a2a2a; color: #ffb3b3; border-radius: 10px; padding: 8px 10px; font-size: 13px; margin-top: 8px; }
  .loading { color: var(--fg2); font-size: 13px; padding: 10px 0; }
  .toast { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); background: #111; color: #fff; padding: 8px 14px; border-radius: 12px; font-size: 13px; z-index: 5; }
  .editor { width: 100%; }
  .ehead { display: flex; align-items: center; gap: 8px; }
  .etitle { font-size: 18px; font-weight: 600; }
  button { font: inherit; }
  .icon { background: none; border: none; color: var(--fg); cursor: pointer; padding: 4px; border-radius: 50%; display: inline-flex; }
  .icon:hover { background: var(--bg2); }
  .ebar-wrap { margin: 28px 6px 4px; }
  .ebar { position: relative; height: 44px; background: var(--bg2); border-radius: 8px; touch-action: none; cursor: copy; }
  .ebar .seg:first-child { border-radius: 8px 0 0 8px; }
  .ebar .seg:last-of-type { border-radius: 0 8px 8px 0; }
  .handle { position: absolute; top: -8px; bottom: -8px; width: 22px; margin-left: -11px; cursor: ew-resize; z-index: 2; display: flex; justify-content: center; touch-action: none; }
  .handle::before { content: ""; width: 4px; height: 100%; background: #fff; border-radius: 2px; box-shadow: 0 0 3px #000; }
  .handle span { display: none; position: absolute; top: -22px; z-index: 3; font-size: 11px; background: #111; padding: 1px 5px; border-radius: 6px; white-space: nowrap; }
  .handle.drag span, .handle:hover span { display: block; }
  .escale { position: relative; height: 16px; font-size: 11px; color: var(--fg2); margin-top: 4px; }
  .hint { font-size: 11px; color: var(--fg2); margin: 4px 6px 10px; }
  .entries { display: flex; flex-direction: column; gap: 6px; }
  .entry { display: grid; grid-template-columns: 14px 84px 10px 46px 1fr 32px; align-items: center; gap: 6px; background: var(--bg2); border-radius: 12px; padding: 6px 8px; font-size: 14px; }
  .entry input, .entry select { background: var(--bg); color: var(--fg); border: 1px solid #4a4a4a; border-radius: 8px; padding: 5px 6px; font: inherit; min-width: 0; }
  .entry select { color-scheme: dark; }
  .t0 { padding-left: 7px; }
  .dash { color: var(--fg2); text-align: center; }
  .tend { color: var(--fg2); }
  .add { margin-top: 10px; width: 100%; background: none; border: 1px dashed #5a5a5a; color: var(--acc); border-radius: 12px; padding: 9px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .add ha-icon { --mdc-icon-size: 18px; }
  .copy { margin-top: 14px; }
  .clabel { font-size: 13px; color: var(--fg2); margin-bottom: 6px; }
  .dchks { display: flex; gap: 6px; flex-wrap: wrap; }
  .dchk { background: var(--bg2); border-radius: 10px; padding: 6px 0; width: 38px; text-align: center; font-size: 13px; cursor: pointer; user-select: none; }
  .dchk input { display: none; }
  .dchk.on { background: var(--acc); color: #111; font-weight: 600; }
  .quick { display: flex; gap: 6px; margin-top: 8px; }
  .quick button { background: none; border: 1px solid #4a4a4a; color: var(--fg2); border-radius: 10px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .actions button { flex: 1; border-radius: 12px; padding: 11px; border: none; cursor: pointer; font-weight: 600; }
  .cancel { background: var(--bg2); color: var(--fg); }
  .save { background: var(--acc); color: #111; }
`;

customElements.define("heizplan-card", HeizplanCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "heizplan-card",
  name: "Heizplan Card",
  description: "Wochenplan pro Raum mit Tageseditor, Normal-/Urlaubsplan (speichert in der Scheduler-Komponente)",
  preview: false,
});
console.info(`%c HEIZPLAN-CARD %c ${CARD_VERSION} `, "background:#69C350;color:#111", "background:#2b2b2b;color:#fff");

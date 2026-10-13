# Heizplan Card

Wochenplan pro Raum für Home Assistant: Komfort, Eco und Frostschutz als farbige Zeitleiste, Tageseditor zum Ziehen, eigene Pläne für Normal und Urlaub. Die Pläne laufen über die [Scheduler-Komponente](https://github.com/nielsfaber/scheduler-component) im Hintergrund weiter, auch wenn kein Dashboard offen ist.

| Wochenansicht | Tageseditor |
| --- | --- |
| ![Wochenansicht](docs/vorschau-woche.png) | ![Tageseditor](docs/vorschau-tageseditor.png) |

## Funktionen

- Wochenansicht Mo–So mit Markierung „jetzt“
- Kopf mit Ist- und Solltemperatur, aktivem Modus, Ventilöffnung und Fensterstatus
- Knöpfe zum sofortigen Umschalten (Komfort / Eco / Frostschutz)
- Tageseditor: auf den Balken tippen fügt einen Abschnitt ein, Griffe ziehen verschiebt (15-min-Raster), Modus pro Abschnitt, auf andere Tage übernehmen (Mo–Fr, Sa–So, Alle)
- Normal- und Urlaubsplan als Reiter; jeder Plan läuft nur, wenn Heizperiode und Heizmodus passen
- Komplett per GUI konfigurierbar

Dazu zwei Blueprints:

- **Heizung – Vorheizen mit Lernfunktion**: heizt so früh vor, dass die Komforttemperatur zum geplanten Zeitpunkt erreicht ist, lernt die Aufheizrate je Raum und berücksichtigt die Außentemperatur
- **Heizung – Aus / außerhalb der Heizperiode**: schaltet die Raumthermostate bei Heizmodus „Aus“ oder außerhalb der Heizperiode aus

## Voraussetzungen

- [Scheduler-Komponente](https://github.com/nielsfaber/scheduler-component) (HACS, Integration)
- Ein Raumthermostat (`climate.…`) mit Presets, z. B. [Versatile Thermostat](https://github.com/jmcollin78/versatile_thermostat) (`comfort`, `eco`, `frost`)

## Installation

> Vorher ein Backup machen.

### Über HACS

1. HACS → ⋮ → **Benutzerdefinierte Repositories**
2. URL `https://github.com/juergenschorb/claude-homeassistant`, Typ **Dashboard** → Hinzufügen
3. „Heizplan Card“ suchen → Herunterladen
4. Browser neu laden (Companion App: App schließen und neu öffnen)

### Manuell

1. `dist/heizplan-card.js` nach `/config/www/heizplan-card.js` kopieren
2. *Einstellungen → Dashboards → ⋮ → Ressourcen → Ressource hinzufügen*: URL `/local/heizplan-card.js?v=0.3.0`, Typ **JavaScript-Modul**
3. Bei neuen Versionen Datei ersetzen und `?v=` hochzählen

## Karte einrichten

Dashboard bearbeiten → *Karte hinzufügen* → **Heizplan Card**. Alles lässt sich im Karten-Editor auswählen:

| Feld | Bedeutung |
| --- | --- |
| Raumthermostat | `climate`-Entität des Raums (Pflicht) |
| Name | Anzeigename, sonst Name des Thermostats |
| Raumtemperatur | eigener Temperatursensor (optional) |
| Fensterkontakt | zeigt „Fenster offen“ (optional) |
| Ventilstellung | `number` oder `sensor` in % (optional) |
| Grundmodus | Modus für Tage ohne Plan (Standard Eco) |
| Heizperiode | Schalter (`input_boolean`, `binary_sensor`, `switch`); Pläne laufen nur, wenn er an ist |
| Heizmodus | zentrale Auswahl (`input_select`/`select`), z. B. Aus / Heizen / Urlaub |
| Option „Heizen“ | Optionstext, bei dem der Normal-Plan läuft |
| Option „Urlaub“ | Optionstext, bei dem der Urlaubsplan läuft (leer = kein Urlaubsplan) |

Stimmt ein Optionstext nicht mit der Auswahl überein, zeigt die Karte einen Hinweis mit den vorhandenen Optionen.

Die Karte **liest** Heizperiode und Heizmodus nur. Umgeschaltet wird zentral, z. B. über einen Kalender oder ein eigenes Dashboard-Element. Die Reiter „Normal“ / „Urlaub“ wählen nur, welcher Plan angezeigt und bearbeitet wird; der grüne Punkt zeigt, welcher gerade gilt.

Beispiel in YAML:

```yaml
type: custom:heizplan-card
entity: climate.wohnzimmer
name: Wohnzimmer
window_entity: binary_sensor.wohnzimmer_fenster
valve_entity: number.wohnzimmer_ventil
season_entity: input_boolean.heizperiode
mode_entity: input_select.heizmodus
mode_heat: Heizen
mode_vacation: Urlaub
```

Erweitert (nur YAML): eigene Modi/Farben mit `modes:` (`key`, `label`, `color`, optional `preset`), eigene Pläne mit `plans:` (`key`, `label`, `conditions: [{entity, state}]`), eigener Tag mit `tag:`.

## Blueprints

[![Blueprint importieren](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fjuergenschorb%2Fclaude-homeassistant%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fheizung_vorheizen.yaml) Vorheizen mit Lernfunktion

[![Blueprint importieren](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fjuergenschorb%2Fclaude-homeassistant%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fheizung_aus.yaml) Aus / außerhalb der Heizperiode

### Vorheizen mit Lernfunktion

- Alle 5 Minuten wird der nächste Komfort-Beginn aus dem Wochenplan gelesen. Benötigte Zeit = (Komforttemperatur − Ist) ÷ Aufheizrate; so viel früher schaltet die Automation auf Komfort (begrenzt auf „Maximale Vorheizzeit“).
- Bei jedem Komfort-Start wird gemessen, wie schnell der Raum warm wird, und die Aufheizrate angepasst (70 % alt + 30 % neu). Messungen mit offenem Fenster zählen nicht.
- Mit Außentemperatur wird die Rate auf 0 °C außen umgerechnet gelernt und beim Vorheizen korrigiert (Standard 2 %/K: bei −10 °C 20 % länger).
- Pro Raum einen Helfer *Zahlenwert* anlegen, z. B. „Aufheizrate Wohnzimmer“, 0.2–5, Schritt 0.05, Einheit `K/h`, Startwert ca. 1.0.
- **Plan-Tag** = `heizplan_` + Name des Thermostats ohne `climate.` (z. B. `heizplan_wohnzimmer`).
- Unter „Nur vorheizen wenn …“ dieselben Bedingungen wie beim Normal-Plan eintragen (Heizperiode an, Heizmodus = Heizen).

### Aus / außerhalb der Heizperiode

Raumthermostate, Heizperiode, Heizmodus und den Optionstext für „Aus“ auswählen. Bei „Aus“ oder Heizperiode aus werden die Thermostate ausgeschaltet, sonst auf Heizen gestellt.

## Wie gespeichert wird

- Pläne liegen in der Scheduler-Komponente mit dem Tag `heizplan_<raum>` (Normal) bzw. `heizplan_<raum>_urlaub`, je Gruppe gleicher Tage ein Zeitplan.
- Jeder Wechselpunkt ruft `climate.set_preset_mode` auf; die Bedingungen (Heizperiode, Heizmodus) hängen an jedem Zeitraum.
- Beim Speichern werden die bisherigen Pläne dieses Raums und Plans ersetzt und der gültige Modus sofort gesetzt.
- Die Pläne erscheinen auch in der Scheduler Card. Zum Bearbeiten pro Raum nur eine der beiden Karten verwenden.

## Stand

Version 0.3.0. Mit Testdaten im Browser geprüft, noch nicht in einer echten Home-Assistant-Instanz.

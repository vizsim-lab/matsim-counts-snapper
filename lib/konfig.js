// Die Konfiguration einer Sitzung als JSON: mit welchem Netz und welchen Daten der Zählkarte
// gearbeitet wurde, alle Einstellungen und die Entscheidungen von Hand. Sie hält fest, wie eine
// counts.xml entstanden ist, und lässt sich wieder einlesen: Dann gelten ihre Einstellungen, und
// die Entscheidungen gehen wie die Zuordnungs-CSV über ihren Anker auf das geladene Netz.
import { tx } from "./sprache.js";

export const KONFIG_FORMAT = "matsim-counts-snapper/konfiguration";
export const KONFIG_VERSION = 1;

const rund = (x, n) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);

/**
 * Eine Entscheidung von Hand: { station, zaehlart, zuordnung (geprüft | ausgelassen | automatisch,
 * letzteres nur mit Kommentar), linkid, kommentar, anker ({ lon, lat, grad } oder null), osm_weg,
 * name, richtung, uebernommen, in_auswahl }. Ohne Anker gilt die Link-ID, wie in der CSV.
 */
export function entscheidung({ station, zaehlart = "dauer", zuordnung, linkid = null, kommentar = null, anker = null, osmWeg = null, name = null, richtung = null, uebernommen = null, inAuswahl = true }) {
  return {
    station,
    zaehlart,
    zuordnung,
    linkid: zuordnung === "ausgelassen" ? null : linkid ?? null,
    kommentar: kommentar || null,
    anker: anker ? { lon: rund(anker.lon, 7), lat: rund(anker.lat, 7), grad: anker.grad != null ? Math.round(anker.grad) : null } : null,
    osm_weg: osmWeg ?? null,
    name: name || null,
    richtung: richtung || null,
    uebernommen: uebernommen ?? null,
    in_auswahl: inAuswahl,
  };
}

/** Das JSON der Konfiguration aus ihren Teilen (alles schon in Klartext, siehe app.js). */
export function baueKonfiguration({ erstellt = new Date().toISOString(), seite = null, netz = null, daten = null, einstellungen, ergebnis = null, quellen = [], entscheidungen = [] }) {
  return {
    format: KONFIG_FORMAT,
    version: KONFIG_VERSION,
    erstellt,
    seite,
    netz,
    daten,
    einstellungen,
    ergebnis,
    quellen,
    entscheidungen,
  };
}

/**
 * Eine eingelesene Konfiguration prüfen. -> { einstellungen, netz, daten, entscheidungen, zeilen }:
 * `zeilen` sind die Entscheidungen der Auswahl im Format der Zuordnungs-CSV (lib/counts.js,
 * leseZuordnungCsv), `weitere` die gespeicherten außerhalb der Auswahl.
 */
export function leseKonfiguration(json) {
  if (!json || typeof json !== "object" || json.format !== KONFIG_FORMAT) throw new Error(tx("Das ist keine Konfiguration des matsim-counts-snapper.", "This is not a matsim-counts-snapper configuration."));
  if (json.version > KONFIG_VERSION) throw new Error(tx(`Die Konfiguration hat Version ${json.version}, diese Seite kennt bis ${KONFIG_VERSION}.`, `The configuration has version ${json.version}; this page knows up to ${KONFIG_VERSION}.`));
  if (!json.einstellungen || typeof json.einstellungen !== "object") throw new Error(tx("In der Konfiguration fehlen die Einstellungen.", "The configuration lacks its settings."));
  const liste = Array.isArray(json.entscheidungen) ? json.entscheidungen.filter((e) => e && typeof e.station === "string" && e.station) : [];
  const zeile = (e) => ({
    station: e.station,
    linkid: e.linkid ?? "",
    using: e.zuordnung !== "ausgelassen",
    kommentar: e.kommentar ?? "",
    zuordnung: String(e.zuordnung ?? "").toLowerCase(),
    anker: e.anker && Number.isFinite(e.anker.lon) && Number.isFinite(e.anker.lat) ? { lon: e.anker.lon, lat: e.anker.lat, grad: Number.isFinite(e.anker.grad) ? e.anker.grad : null } : null,
    weg: e.osm_weg ?? null,
    netz: json.netz?.name ?? null,
  });
  return {
    einstellungen: json.einstellungen,
    netz: json.netz ?? null,
    daten: json.daten ?? null,
    entscheidungen: liste,
    zeilen: liste.filter((e) => e.in_auswahl !== false).map(zeile),
    weitere: liste.filter((e) => e.in_auswahl === false),
  };
}

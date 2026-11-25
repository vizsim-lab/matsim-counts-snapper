// Ausgabe: MATSim-Counts im Format counts_v2.xsd und die Zuordnung als CSV im Format von MATSims
// CountsOptions (--counts-mapping), die auch wieder eingelesen werden kann.
import { tx } from "./sprache.js";

const XML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
// XML 1.0 erlaubt keine Steuerzeichen außer Tab, Zeilenumbruch und Wagenrücklauf
const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"']/g, (c) => XML_ESC[c]);

/** Eine Zahl, wie MATSim sie als double schreibt: mit Dezimalpunkt, auf `stellen` Nachkommastellen gerundet. */
export function zahl(v, stellen = 1) {
  const f = 10 ** stellen;
  const r = Math.round(v * f) / f;
  const s = String(r);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Attribute [name, wert, klasse?]; ohne Klasse: ganze Zahlen Integer, andere Double, sonst String. */
function attributes(liste, einzug) {
  const eintraege = (liste ?? []).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!eintraege.length) return "";
  const zeilen = eintraege.map(([name, v, klasse]) => {
    const cls = klasse ?? (typeof v === "number" ? (Number.isInteger(v) ? "java.lang.Integer" : "java.lang.Double") : "java.lang.String");
    const text = typeof v === "number" && cls === "java.lang.Double" ? zahl(v, 2) : v;
    return `${einzug}\t<attribute name="${xml(name)}" class="${cls}">${xml(text)}</attribute>`;
  });
  return `${einzug}<attributes>\n${zeilen.join("\n")}\n${einzug}</attributes>\n`;
}

/**
 * counts_v2: { name, description, source, year, attributes: [[name, wert]], locations: [{ refId,
 * id, name, description, x, y, attributes, measurements: [{ type, networkMode, interval, values:
 * [[t, wert]] }] }] }. `interval` und `t` in Sekunden; t ist der Beginn des Intervalls.
 */
export function countsXml(c) {
  const kopf = [
    'xmlns="http://www.matsim.org/files/dtd"',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    'xsi:schemaLocation="http://www.matsim.org/files/dtd http://www.matsim.org/files/dtd/counts_v2.xsd"',
  ];
  if (c.source) kopf.push(`source="${xml(c.source)}"`);
  if (c.name) kopf.push(`name="${xml(c.name)}"`);
  if (c.description) kopf.push(`description="${xml(c.description)}"`);
  if (!Number.isInteger(c.year)) throw new Error(tx("counts.xml braucht ein Jahr (year).", "counts.xml needs a year."));
  kopf.push(`year="${c.year}"`);
  const teile = ['<?xml version="1.0" encoding="UTF-8"?>\n', `<counts ${kopf.join(" ")}>\n`, attributes(c.attributes, "\t")];
  for (const l of c.locations) {
    const a = [`refId="${xml(l.refId)}"`];
    if (l.id != null) a.push(`id="${xml(l.id)}"`);
    if (l.name) a.push(`name="${xml(l.name)}"`);
    if (l.description) a.push(`description="${xml(l.description)}"`);
    if (Number.isFinite(l.x) && Number.isFinite(l.y)) a.push(`x="${zahl(l.x, 2)}"`, `y="${zahl(l.y, 2)}"`);
    teile.push(`\n\t<location ${a.join(" ")}>\n`, attributes(l.attributes, "\t\t"));
    for (const m of l.measurements) {
      teile.push(`\t\t<measurements type="${xml(m.type)}" networkMode="${xml(m.networkMode)}" interval="${m.interval}">\n`);
      for (const [t, v] of m.values) teile.push(`\t\t\t<value t="${t}" val="${zahl(v)}"/>\n`);
      teile.push("\t\t</measurements>\n");
    }
    teile.push("\t</location>\n");
  }
  teile.push("\n</counts>\n");
  return teile.join("");
}

// ---------- Zuordnung als CSV ----------
const SPALTEN = ["station", "linkid", "using", "kommentar", "zuordnung", "abstand_m", "richtung", "name", "quelle", "anker_lon", "anker_lat", "anker_grad", "osm_weg", "netz", "zaehlart"];

const feld = (v, d) => {
  const s = v == null ? "" : String(v);
  return s.includes(d) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Zeilen { station, linkid, using (bool), kommentar, zuordnung, abstand_m, richtung, name, quelle,
 * anker_lon, anker_lat, anker_grad, osm_weg, netz, zaehlart } als CSV, getrennt mit „;“. MATSims
 * CountsOptions nimmt die Station aus der ersten Spalte, dazu `linkid` und `using` (y = verwenden);
 * die übrigen Spalten übergeht es. `zuordnung` sagt, wie der Link zustande kam: geprüft,
 * automatisch, ausgelassen oder ohne Link. Der Anker (Punkt auf dem Link in WGS 84, Richtung des
 * Links dort in Grad ab Nord, OSM-Weg mit Minus gegen die Zeichenrichtung) gehört zu keinem Netz:
 * Mit ihm lässt sich die Zuordnung auf ein anderes Netz übertragen (lib/uebertrag.js).
 * `zaehlart`: dauer oder kurzzeit (ein Punkt einer Kurzzeitzählung, Station „Stelle/Zählung/Arm“).
 */
export function zuordnungCsv(zeilen) {
  const d = ";";
  const out = [SPALTEN.join(d)];
  for (const z of zeilen) {
    out.push(SPALTEN.map((s) => feld(s === "using" ? (z.using ? "y" : "") : z[s], d)).join(d));
  }
  return `${out.join("\n")}\n`;
}

/** Felder einer CSV-Zeile; Anführungszeichen dürfen das Trennzeichen enthalten, "" ist ein Anführungszeichen. */
function csvFelder(zeile, d) {
  const out = [];
  let i = 0;
  for (;;) {
    if (zeile[i] === '"') {
      let wert = "";
      let j = i + 1;
      for (;;) {
        const q = zeile.indexOf('"', j);
        if (q < 0) { wert += zeile.slice(j); j = zeile.length; break; }
        if (zeile[q + 1] === '"') { wert += zeile.slice(j, q + 1); j = q + 2; continue; }
        wert += zeile.slice(j, q);
        j = q + 1;
        break;
      }
      out.push(wert);
      const n = zeile.indexOf(d, j);
      if (n < 0) return out;
      i = n + 1;
    } else {
      const n = zeile.indexOf(d, i);
      if (n < 0) { out.push(zeile.slice(i)); return out; }
      out.push(zeile.slice(i, n));
      i = n + 1;
    }
  }
}

/** Zeilen einer CSV, auch mit Anführungszeichen über Zeilenenden hinweg. */
function csvZeilen(text) {
  const zeilen = [];
  let satz = "";
  for (let zeile of text.replace(/^﻿/, "").split("\n")) {
    if (zeile.endsWith("\r")) zeile = zeile.slice(0, -1);
    satz = satz ? `${satz}\n${zeile}` : zeile;
    if ((satz.split('"').length - 1) % 2 === 1) continue;
    if (satz.trim()) zeilen.push(satz);
    satz = "";
  }
  if (satz.trim()) zeilen.push(satz);
  return zeilen;
}

const JA = new Set(["y", "x", "true", "yes", "ja", "1"]);

/**
 * Eine Zuordnungs-CSV lesen, wie CountsOptions sie versteht: Trennzeichen aus der Kopfzeile,
 * `linkid` (auch link_id), die Station in der ersten Spalte (in der zweiten, wenn `linkid` vorne
 * steht), `using` (verwenden bei y, x, true) oder `ignore` (auslassen bei y, x, true).
 * -> [{ station, linkid, using, kommentar, zuordnung (klein geschrieben, null ohne die Spalte),
 *   anker ({ lon, lat, grad } oder null), weg (OSM-Weg oder null), netz (Name oder null) }]
 */
export function leseZuordnungCsv(text) {
  const zeilen = csvZeilen(text);
  if (!zeilen.length) throw new Error(tx("Die CSV ist leer.", "The CSV is empty."));
  const kopfZeile = zeilen[0];
  const d = [";", ",", "\t"].reduce((best, x) => (kopfZeile.split(x).length > kopfZeile.split(best).length ? x : best), ";");
  const kopf = csvFelder(kopfZeile, d).map((h) => h.trim().toLowerCase().replace(/_/g, ""));
  const link = kopf.indexOf("linkid");
  if (link < 0) throw new Error(tx("In der CSV fehlt die Spalte „linkid“.", "The CSV lacks the column “linkid”."));
  const station = link === 0 ? 1 : 0;
  const using = kopf.indexOf("using");
  const ignore = kopf.indexOf("ignore");
  const kommentar = kopf.findIndex((h) => h === "kommentar" || h === "comment");
  const zuordnung = kopf.indexOf("zuordnung");
  const spalte = (name) => kopf.indexOf(name.replace(/_/g, ""));
  const [alon, alat, agrad, weg, netz] = ["anker_lon", "anker_lat", "anker_grad", "osm_weg", "netz"].map(spalte);
  return zeilen.slice(1).map((z) => {
    const f = csvFelder(z, d);
    const ja = (i) => JA.has(String(f[i] ?? "").trim().toLowerCase());
    const text = (i) => (i >= 0 ? String(f[i] ?? "").trim() : "");
    const zahl = (i) => {
      const t = text(i).replace(",", ".");
      return t && Number.isFinite(Number(t)) ? Number(t) : null;
    };
    const lon = zahl(alon);
    const lat = zahl(alat);
    return {
      station: String(f[station] ?? "").trim(),
      linkid: String(f[link] ?? "").trim(),
      using: using > 0 ? ja(using) : ignore > 0 ? !ja(ignore) : true,
      kommentar: kommentar >= 0 ? String(f[kommentar] ?? "").trim() : "",
      zuordnung: zuordnung >= 0 ? String(f[zuordnung] ?? "").trim().toLowerCase() : null,
      anker: lon != null && lat != null ? { lon, lat, grad: zahl(agrad) } : null,
      weg: text(weg) || null,
      netz: text(netz) || null,
    };
  }).filter((z) => z.station);
}

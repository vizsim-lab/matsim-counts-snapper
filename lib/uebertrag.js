// Eine geprüfte Zuordnung auf ein anderes Netz übertragen: von OSM auf ein MATSim-Netz oder von einer
// Netzversion auf die nächste. Übertragen wird der Anker – der Punkt auf dem gewählten Link, der der
// Zählstelle am nächsten liegt, mit der Richtung des Links dort und, wenn bekannt, seinem OSM-Weg. Der
// Anker liegt auf der Fahrbahn; die Rohkoordinate der Zählstelle liegt oft daneben.
//
// Eindeutig ist eine Übertragung, wenn (der Reihe nach)
//   1. der Link mit derselben ID am Anker liegt,
//   2. ein Link desselben OSM-Wegs in derselben Richtung nahe am Anker liegt,
//   3. genau ein Link am Anker liegt: der nächste dicht dran, der zweite deutlich weiter weg.
// Sonst entscheidet, wer prüft; die Suche geht dann vom Anker aus.
import { naechsterPunkt, erlaubt } from "./zuordnung.js";
import { winkelAbstand } from "./richtung.js";
import { tx, zahl } from "./sprache.js";

export const UEBERNAHME = {
  idAbstand: 5, // m: so nah muss der Link mit derselben ID am Anker liegen
  wegAbstand: 25, // m: so nah ein Link desselben OSM-Wegs (Geometrien aus OSM und MATSim weichen ab)
  lageAbstand: 5, // m: so nah der einzige Link am Anker
  lageVorsprung: 5, // m: so viel weiter muss der zweitnächste liegen
  maxWinkel: 45, // Grad zwischen der Richtung am Anker und der des Links
  radius: 30, // m: so weit sucht die Übertragung
};

/** Eine OSM-Weg-ID ohne Richtung: „-123“ und „123“ sind derselbe Weg. */
export const ohneVorzeichen = (w) => String(w ?? "").trim().replace(/^-/, "");

/**
 * Die OSM-Wege eines MATSim-Links: aus dem Attribut `osm:way:id` (pt2matsim) oder `origid`
 * (SUMO, mehrere durch Leerzeichen), sonst aus einer Link-ID im Stil von SUMO („123#0“, „-123#2“),
 * wenn `sumo` sagt, dass das Netz so heißt. -> { weg (mit Vorzeichen, wenn bekannt), wege (ohne) }
 */
export function wegeVonLink(link, sumo) {
  const wege = new Set();
  let weg = null;
  const attr = link.osmWayId ?? null;
  if (attr != null && String(attr).trim()) {
    weg = ohneVorzeichen(attr);
    wege.add(weg);
  }
  if (typeof link.origId === "string") {
    for (const teil of link.origId.split(/\s+/)) {
      const m = /^(-?)(\d+)(?:#\d+)?$/.exec(teil);
      if (m) wege.add(m[2]);
    }
  }
  if (sumo) {
    const m = /^(-?)(\d+)(?:#\d+)?$/.exec(link.id);
    if (m) {
      weg = `${m[1]}${m[2]}`;
      wege.add(m[2]);
    }
  }
  if (weg == null && wege.size) weg = [...wege][0];
  return { weg, wege: [...wege] };
}

/** Ob die IDs eines Netzes nach SUMO aussehen: viele „123#0“. */
export function siehtNachSumoAus(links) {
  let raute = 0;
  for (const l of links) if (/^-?\d+#\d+$/.test(l.id)) raute++;
  return links.length > 0 && raute >= 0.3 * links.length;
}

/**
 * `anker` = { x, y (Meter wie der Index), grad, linkId, weg, modi }. `ids` (Map Link-ID -> Index)
 * für Schritt 1. -> { i, d, abweichung, wie: "id" | "weg" | "lage" } oder { i: null, wie: null, grund }.
 */
export function uebertrage(index, anker, p = UEBERNAHME, ids = null) {
  const pruefe = (i) => {
    const link = index.links[i];
    if (anker.modi?.length && !erlaubt(link, anker.modi)) return null;
    const n = naechsterPunkt(anker.x, anker.y, link.xy);
    const abweichung = anker.grad != null && n.grad != null ? winkelAbstand(anker.grad, n.grad) : null;
    if (abweichung != null && abweichung > p.maxWinkel) return null;
    return { i, d: n.d, abweichung };
  };

  if (anker.linkId && ids) {
    const i = ids.get(anker.linkId);
    if (i !== undefined) {
      const k = pruefe(i);
      if (k && k.d <= p.idAbstand) return { ...k, wie: "id" };
    }
  }

  const nah = [];
  for (const i of index.umkreis(anker.x, anker.y, p.radius)) {
    const k = pruefe(i);
    if (k && k.d <= p.radius) nah.push(k);
  }
  nah.sort((a, b) => a.d - b.d || a.i - b.i);

  const weg = ohneVorzeichen(anker.weg);
  if (weg) {
    const k = nah.find((x) => x.d <= p.wegAbstand && (index.links[x.i].wege ?? []).includes(weg));
    if (k) return { ...k, wie: "weg" };
  }

  const [a, b] = nah;
  if (a && a.d <= p.lageAbstand && (!b || b.d >= a.d + p.lageVorsprung)) return { ...a, wie: "lage" };

  const m = (d) => zahl(Math.round(d * 10) / 10, Number.isInteger(Math.round(d * 10) / 10) ? 0 : 1);
  let grund;
  if (!a) grund = tx(`kein passender Link im Umkreis von ${p.radius} m`, `no matching link within ${p.radius} m`);
  else if (a.d > p.lageAbstand) grund = tx(`der nächste passende Link liegt ${m(a.d)} m vom Anker`, `the nearest matching link is ${m(a.d)} m from the anchor`);
  else grund = tx(`zwei Links dicht am Anker (${m(a.d)} und ${m(b.d)} m)`, `two links close to the anchor (${m(a.d)} and ${m(b.d)} m)`);
  return { i: null, wie: null, grund };
}

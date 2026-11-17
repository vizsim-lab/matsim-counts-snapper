// Zählstellen auf Links legen. Wie MATSims NetworkIndex (CreateCountsFromBAStData): Links im
// Umkreis der Stelle, gefiltert nach Verkehrsmittel und Richtung, der nächste gewinnt, und jeder
// Link wird nur einmal vergeben. Gerechnet wird in Metern im CRS des Netzes.
import { winkelAbstand } from "./richtung.js";

/**
 * Ein Raster über die Links: Zelle -> Indizes der Links, die durch sie laufen. Jedes Segment
 * trägt sich in die Zellen von Punkten ein, die höchstens eine halbe Zelle auseinander liegen;
 * `umkreis` sucht darum eine Zelle weiter, als der Radius verlangt.
 */
export class LinkIndex {
  constructor(links, zelle = 100) {
    this.links = links;
    this.zelle = zelle;
    this.raster = new Map();
    const schritt = zelle / 2;
    for (let i = 0; i < links.length; i++) {
      const xy = links[i].xy;
      const gesehen = new Set();
      const eintragen = (x, y) => {
        const key = `${Math.floor(x / zelle)}:${Math.floor(y / zelle)}`;
        if (gesehen.has(key)) return;
        gesehen.add(key);
        let liste = this.raster.get(key);
        if (!liste) this.raster.set(key, (liste = []));
        liste.push(i);
      };
      for (let k = 0; k + 3 < xy.length; k += 2) {
        const dx = xy[k + 2] - xy[k];
        const dy = xy[k + 3] - xy[k + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / schritt));
        for (let s = 0; s <= n; s++) eintragen(xy[k] + (dx * s) / n, xy[k + 1] + (dy * s) / n);
      }
      if (xy.length === 2) eintragen(xy[0], xy[1]);
    }
  }

  /** Indizes der Links, die in der Nähe von (x, y) liegen können: alle im Radius r und einige mehr. */
  umkreis(x, y, r) {
    const z = this.zelle;
    const out = new Set();
    const w = r + z;
    for (let cx = Math.floor((x - w) / z); cx <= Math.floor((x + w) / z); cx++) {
      for (let cy = Math.floor((y - w) / z); cy <= Math.floor((y + w) / z); cy++) {
        const liste = this.raster.get(`${cx}:${cy}`);
        if (liste) for (const i of liste) out.add(i);
      }
    }
    return out;
  }
}

/**
 * Nächster Punkt einer Polylinie zu (x, y): { d (Abstand), grad (Richtung des Segments dort,
 * im Uhrzeigersinn ab Norden), anteil (0 am Anfang, 1 am Ende des Links) }.
 */
export function naechsterPunkt(x, y, xy) {
  let best = { d: Infinity, grad: null, anteil: 0 };
  let laenge = 0;
  const teile = [];
  for (let k = 0; k + 3 < xy.length; k += 2) {
    const l = Math.hypot(xy[k + 2] - xy[k], xy[k + 3] - xy[k + 1]);
    teile.push(l);
    laenge += l;
  }
  let vorher = 0;
  for (let k = 0, s = 0; k + 3 < xy.length; k += 2, s++) {
    const ax = xy[k];
    const ay = xy[k + 1];
    const dx = xy[k + 2] - ax;
    const dy = xy[k + 3] - ay;
    const ll = dx * dx + dy * dy;
    const t = ll > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / ll)) : 0;
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    // bei gleichem Abstand (Knick) das längere Segment
    if (d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && ll > 0 && best.grad == null)) {
      best = {
        d,
        grad: ll > 0 ? ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 : null,
        anteil: laenge > 0 ? (vorher + t * teile[s]) / laenge : 0,
      };
    }
    vorher += teile[s];
  }
  return best;
}

/** Straßennamen vergleichbar machen: „Clayallee“, „A 115“ ~ „A115“, „Straße“ ~ „Str.“. */
export function nameSchluessel(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/strasse\b|str\./g, "str")
    .replace(/[^a-z0-9äöü]+/g, "");
}

/** Ob der Name eines Links zur Straße einer Stelle passt. */
export function namePasst(stelle, link) {
  const a = nameSchluessel(stelle);
  const b = nameSchluessel(link);
  if (a.length < 2 || b.length < 2) return false;
  return a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
}

export const VORGABE = {
  radius: 50, // m, wie --search-range in MATSim
  maxWinkel: 60, // Grad zwischen Fahrtrichtung der Stelle und Richtung des Links
  winkelGewicht: 0.3, // m Abstand je Grad Abweichung, für die Reihenfolge der Kandidaten
  nameBonus: 10, // m, wenn der Straßenname passt
  maxKandidaten: 6,
};

/** Die Verkehrsmittel eines Links; ohne Angabe gilt, wie in MATSim, car. */
export function modiVon(link) {
  const liste = link.modes.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  return liste.length ? liste : ["car"];
}

/** Ob ein Link mindestens eines der Verkehrsmittel erlaubt. */
export function erlaubt(link, modi) {
  if (!modi.length) return true;
  const liste = modiVon(link);
  return modi.some((m) => liste.includes(m));
}

/**
 * Die Kandidaten einer Stelle { x, y, grad, name, modi }: [{ i, d, abweichung, grad, anteil,
 * name, score }], nach score sortiert. Ohne Himmelsrichtung zählt nur der Abstand.
 */
export function kandidaten(index, stelle, p = VORGABE) {
  const out = [];
  for (const i of index.umkreis(stelle.x, stelle.y, p.radius)) {
    const link = index.links[i];
    if (!erlaubt(link, stelle.modi)) continue;
    const n = naechsterPunkt(stelle.x, stelle.y, link.xy);
    if (!(n.d <= p.radius)) continue;
    let abweichung = null;
    if (stelle.grad != null && n.grad != null) {
      abweichung = winkelAbstand(stelle.grad, n.grad);
      if (abweichung > p.maxWinkel) continue;
    }
    const name = stelle.name && link.name ? namePasst(stelle.name, link.name) : false;
    const score = n.d + (abweichung ?? 0) * p.winkelGewicht - (name ? p.nameBonus : 0);
    out.push({ i, d: n.d, abweichung, grad: n.grad, anteil: n.anteil, name, score });
  }
  out.sort((a, b) => a.score - b.score || a.d - b.d || a.i - b.i);
  return out.slice(0, p.maxKandidaten);
}

/**
 * Jeder Stelle einen Link, jeden Link nur einmal: alle Paare aus Stelle und Kandidat nach score,
 * das beste Paar zuerst. -> Array: je Stelle der gewählte Kandidat oder null.
 * `fest` (Map Stelle -> Link-Index) sind Zuordnungen von Hand; ihre Links nimmt keine andere Stelle.
 */
export function verteile(alleKandidaten, fest = new Map()) {
  const wahl = alleKandidaten.map(() => null);
  const vergeben = new Set(fest.values());
  const paare = [];
  alleKandidaten.forEach((liste, s) => {
    if (fest.has(s)) return;
    for (const k of liste) paare.push([k.score, s, k]);
  });
  paare.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, s, k] of paare) {
    if (wahl[s] || vergeben.has(k.i)) continue;
    wahl[s] = k;
    vergeben.add(k.i);
  }
  return wahl;
}

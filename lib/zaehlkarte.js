// Die Dauerzählstellen der Zählkarte (github.com/vizsim-lab/zaehlkarte): dauer/index.json mit
// Stellen, Quellen und Kalender, dazu je Stelle dauer/{n}.json mit den Stundenwerten der jüngsten
// 12 Monate. Gelesen wird nur, was die Zuordnung und das Mitteln brauchen.
import { richtung } from "./richtung.js";

/** Version von dauer/index.json, nach der diese Seite gebaut ist (VERSION in pipeline/src/zaehlkarte/dauer/site.py). */
export const VERTRAG = 5;
/** Die Gruppen in der Reihenfolge ihrer Bits im Feld `g`. */
export const GRUPPEN = ["kfz", "lkw", "sv", "rad", "fuss"];
export const STANDARD_DATEN = "https://vizsim-lab.github.io/zaehlkarte/data/";

const TAG_MS = 86400000;
/** Tage seit 1970-01-01 (UTC) für ein Datum „JJJJ-MM-TT“. */
export function tagNr(iso) {
  const [j, m, t] = String(iso).split("-").map(Number);
  return Math.round(Date.UTC(j, m - 1, t) / TAG_MS);
}
/** „JJJJ-MM-TT“ zur Tagesnummer. */
export const isoTag = (nr) => new Date(nr * TAG_MS).toISOString().slice(0, 10);
/** Wochentag wie Date.getUTCDay: 0 Sonntag, 1 Montag … 6 Samstag. */
export const wochentag = (nr) => (((nr + 4) % 7) + 7) % 7;

/** Die Lizenzen einer Quelle; sie hat eine, wenn jeder Eintrag eine nennt (Quellen ohne Lizenz gehen nie in einen Export). */
function lizenzVon(q) {
  const liste = (q.lizenzen ?? []).map((l) => ({
    code: l.code,
    titel: l.titel ?? null,
    herausgeber: l.herausgeber ?? null,
    lizenz: l.lizenz ?? null,
    url: l.lizenz_url ?? null,
  }));
  return { liste, ok: liste.length > 0 && liste.every((l) => l.lizenz) };
}

/**
 * dauer/index.json -> { version, erzeugt, gruppenNamen, details (Muster), kalender, kalenderAb,
 * quellen (Map code -> Quelle), stellen (Liste) }.
 */
export function leseIndex(ix) {
  if (!ix || typeof ix !== "object" || !ix.stellen?.felder) throw new Error("Das ist keine dauer/index.json der Zählkarte.");
  const f = ix.stellen.felder;
  const at = Object.fromEntries(f.map((name, i) => [name, i]));
  for (const pflicht of ["id", "quelle", "lon", "lat", "g", "chunk"]) {
    if (!(pflicht in at)) throw new Error(`In dauer/index.json fehlt das Feld „${pflicht}“ der Stellen.`);
  }
  const gruppen = ix.gruppen ?? GRUPPEN;
  const quellen = new Map();
  for (const q of ix.quellen ?? []) {
    const lizenz = lizenzVon(q);
    quellen.set(q.code, {
      code: q.code,
      name: q.name ?? q.code,
      land: q.land ?? null,
      quellenvermerk: q.quellenvermerk ?? null,
      portal: q.portal ?? null,
      lizenzen: lizenz.liste,
      hatLizenz: lizenz.ok,
      stundenVon: q.stunden_von ?? null,
      bis: q.bis ?? null,
      gruppen: q.gruppen ?? [],
      hinweise: q.hinweise ?? [],
    });
  }
  const stellen = ix.stellen.werte.map((w) => {
    const quelle = w[at.quelle];
    const g = Number(w[at.g]) || 0;
    const text = at.richtung !== undefined ? w[at.richtung] : null;
    return {
      id: String(w[at.id]),
      quelle,
      name: at.name !== undefined ? w[at.name] ?? "" : "",
      abschnitt: at.abschnitt !== undefined ? w[at.abschnitt] ?? null : null,
      richtungText: text ?? null,
      r: richtung(text),
      lon: Number(w[at.lon]),
      lat: Number(w[at.lat]),
      von: at.von !== undefined ? w[at.von] : null,
      bis: at.bis !== undefined ? w[at.bis] : null,
      gruppen: gruppen.filter((_, i) => g & (1 << i)),
      chunk: Number(w[at.chunk]),
      land: quellen.get(quelle)?.land ?? null,
    };
  });
  return {
    version: ix.version ?? null,
    erzeugt: ix.erzeugt ?? null,
    gruppenNamen: ix.gruppen_namen ?? {},
    details: ix.dateien?.details ?? "dauer/{n}.json",
    kalender: ix.kalender ?? {},
    kalenderAb: ix.von ? tagNr(ix.von) : null,
    quellen,
    stellen,
  };
}

/**
 * Art eines Tages im Kalender eines Landes: s Schultag, f Ferien, h Feiertag, w Wochenende,
 * u unbekannt (vor dem ersten Ferienkalender des Landes oder ohne Kalender).
 */
export function tagArt(daten, land, nr) {
  const k = daten.kalender[land];
  if (!k || daten.kalenderAb == null) return "u";
  const i = nr - daten.kalenderAb;
  return i >= 0 && i < k.length ? k[i] : "u";
}

/**
 * Die Stundenwerte einer Stelle aus ihrer dauer/{n}.json: { von (Tagesnummer), stunden
 * ({ gruppe: [[24 Werte oder null] oder null je Tag] }), doppelt (Set der Tagesnummern mit
 * doppelter Stunde 2–3 Uhr), fahrstreifen, hinweise }.
 */
export function leseStunden(eintrag) {
  if (!eintrag?.stunden || !eintrag.stunden_von) return null;
  return {
    von: tagNr(eintrag.stunden_von),
    stunden: eintrag.stunden,
    doppelt: new Set((eintrag.doppelt ?? []).map(tagNr)),
    fahrstreifen: eintrag.fahrstreifen ?? [],
    hinweise: eintrag.hinweise ?? [],
  };
}

/** Pfad der Datei mit den Details einer Stelle, relativ zum Datenordner. */
export const detailPfad = (daten, chunk) => daten.details.replace("{n}", String(chunk));

// Mitteln über ausgewählte Tage, je Stunde. Wie in MATSims CreateCountsFromBAStData: Wochentage,
// Zeiträume, Mittel oder Median, eine Mindestzahl an Tagen. Dazu der Ferienkalender der
// Zählkarte. Nicht gezählte Stunden bleiben leer, nichts wird aufgefüllt oder hochgerechnet.
import { isoTag, tagArt, wochentag } from "./zaehlkarte.js";

export const WOCHENTAGE = [
  { nr: 1, kurz: "Mo", lang: "MONDAY" },
  { nr: 2, kurz: "Di", lang: "TUESDAY" },
  { nr: 3, kurz: "Mi", lang: "WEDNESDAY" },
  { nr: 4, kurz: "Do", lang: "THURSDAY" },
  { nr: 5, kurz: "Fr", lang: "FRIDAY" },
  { nr: 6, kurz: "Sa", lang: "SATURDAY" },
  { nr: 0, kurz: "So", lang: "SUNDAY" },
];

/** Vorgabe wie MATSims `midweek=TUESDAY,WEDNESDAY,THURSDAY`, dazu nur Schultage. */
export const VORGABE = {
  wochentage: [2, 3, 4],
  von: null, // Tagesnummern; null = so weit die Daten reichen
  bis: null,
  tagesarten: ["s"], // für Montag bis Freitag: s Schultag, f Ferien, h Feiertag, u ohne Kalender
  statistik: "mittel", // oder "median"
  minTage: 5,
  nurVollstaendig: true,
};

/** Ob ein Tag in die Auswahl fällt. Samstag und Sonntag zählen ohne Blick auf den Kalender. */
export function tagGilt(daten, land, nr, opts) {
  if (opts.von != null && nr < opts.von) return false;
  if (opts.bis != null && nr > opts.bis) return false;
  const wt = wochentag(nr);
  if (!opts.wochentage.includes(wt)) return false;
  if (wt === 0 || wt === 6) return true;
  const art = tagArt(daten, land, nr);
  return opts.tagesarten.includes(art === "w" ? "u" : art);
}

function median(werte) {
  const s = Float64Array.from(werte).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Die Werte einer Gruppe einer Stelle: { werte: [24] (Zahl oder null), tage: [24] (Tage je
 * Stunde), tageGenutzt (Tage mit mindestens einem Wert), vollstaendig (alle 24 Stunden) }.
 * Tage mit doppelter Stunde 2–3 Uhr (Zeitumstellung) bleiben draußen.
 */
export function mittle(daten, stelle, stunden, gruppe, opts) {
  const reihe = stunden?.stunden?.[gruppe];
  const sammlung = Array.from({ length: 24 }, () => []);
  let tageGenutzt = 0;
  if (reihe) {
    for (let i = 0; i < reihe.length; i++) {
      const tag = reihe[i];
      if (!tag) continue;
      const nr = stunden.von + i;
      if (stunden.doppelt.has(nr) || !tagGilt(daten, stelle.land, nr, opts)) continue;
      let genutzt = false;
      for (let h = 0; h < 24; h++) {
        const v = tag[h];
        if (v == null || !Number.isFinite(v)) continue;
        sammlung[h].push(v);
        genutzt = true;
      }
      if (genutzt) tageGenutzt++;
    }
  }
  const tage = sammlung.map((s) => s.length);
  const werte = sammlung.map((s) => {
    if (s.length === 0 || s.length < opts.minTage) return null;
    if (opts.statistik === "median") return median(s);
    let sum = 0;
    for (const v of s) sum += v;
    return sum / s.length;
  });
  return { werte, tage, tageGenutzt, vollstaendig: werte.every((v) => v != null) };
}

/** Der Zeitraum, den die Stundenwerte einer Stelle abdecken: [erster, letzter] Tag oder null. */
export function zeitraum(stunden) {
  if (!stunden) return null;
  let n = 0;
  for (const reihe of Object.values(stunden.stunden)) n = Math.max(n, reihe?.length ?? 0);
  return n ? [stunden.von, stunden.von + n - 1] : null;
}

/**
 * Die Auswahl in MATSims Schreibweise (`--aggregate`), etwa
 * `midweek=TUESDAY,WEDNESDAY,THURSDAY@2024-07-01:2025-06-30`.
 */
export function aggregatText(opts, name = "auswahl") {
  const tage = WOCHENTAGE.filter((w) => opts.wochentage.includes(w.nr)).map((w) => w.lang).join(",");
  const raum = opts.von != null || opts.bis != null ? `@${opts.von != null ? isoTag(opts.von) : ""}:${opts.bis != null ? isoTag(opts.bis) : ""}` : "";
  return `${name}=${tage}${raum}`;
}

const ARTEN = { s: "Schultage", f: "Ferientage", h: "Feiertage", u: "Tage ohne Ferienkalender" };

/** Die Auswahl in Worten, für die Beschreibung der counts.xml. */
export function auswahlText(opts) {
  const tage = WOCHENTAGE.filter((w) => opts.wochentage.includes(w.nr)).map((w) => w.kurz).join(", ");
  const werktags = opts.wochentage.some((w) => w >= 1 && w <= 5);
  const arten = werktags ? ` (Mo–Fr nur ${opts.tagesarten.map((a) => ARTEN[a]).filter(Boolean).join(", ") || "keine"})` : "";
  const raum = opts.von != null || opts.bis != null ? `, ${opts.von != null ? isoTag(opts.von) : "Anfang"} bis ${opts.bis != null ? isoTag(opts.bis) : "Ende"}` : "";
  const stat = opts.statistik === "median" ? "Median" : "Mittel";
  return `${stat} je Stunde über ${tage}${arten}${raum}, mindestens ${opts.minTage} Tag${opts.minTage === 1 ? "" : "e"} je Stunde`;
}

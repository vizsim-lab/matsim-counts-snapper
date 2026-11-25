// Die Kurzzeitzählungen der Zählkarte je Strom und Arm (stroeme/{quelle}-{jahr}.json, seit
// zaehlkarte#45), dazu Lage und Art der Stellen aus index.json und die Lizenzen der Lieferungen aus
// manifest.json. Eine Knotenzählung wird je Arm zu zwei Punkten: der Zufahrt (die Ströme vom Arm,
// zum Knoten hin) und der Ausfahrt (die Ströme zum Arm, vom Knoten weg), beide ein Stück vom Knoten
// auf dem Arm und ein wenig rechts ihrer Fahrtrichtung. Ein Querschnitt wird je Fahrtrichtung zu
// einem Punkt an der Stelle, ebenso rechts der Fahrtrichtung. Je Stelle und
// Gruppe gilt die jüngste Zählung, die zur Auswahl passt. Es bleibt bei dem einen gezählten Tag:
// nur die gezählten Stunden, nichts aufgefüllt, hochgerechnet oder über Tage gemittelt.
//
// Winkel der Arme: Grad im Uhrzeigersinn ab Nord, vom Knoten weg (wie in den Dateien). Ein Strom
// fährt auf dem Arm `von` zum Knoten hin (Winkel + 180°) und auf dem Arm `nach` vom Knoten weg.
import { tagNr, wochentag } from "./zaehlkarte.js";
import { tx } from "./sprache.js";

/** Version von stroeme/{quelle}-{jahr}.json, nach der diese Seite gebaut ist (STROEME_VERSION in site.py). */
export const STROEME_VERTRAG = 1;
/** Gruppen, die als Messung taugen; „kind“ (Kinder/Jugendliche) ist ein Teil von „fuss“ und nie eine eigene. */
export const KURZ_GRUPPEN = ["kfz", "sv", "rad", "fuss"];

export const KURZ_VORGABE = {
  vonJahr: 2019, // ab 2019 liefert Berlin unter dl-de/by-2-0, davor unter CC BY-SA 3.0 DE
  bisJahr: null, // null = bis zum jüngsten Jahr
  wochentage: [2, 3, 4], // wie MATSims midweek
  tage: ["s"], // Montag bis Freitag nur an: s Schultag, f Ferientag, h Feiertag, u ohne Kalender
  gruppen: ["kfz"],
  minStunden: 12, // gezählte Stunden der Gruppe; 12 = das übliche Fenster 7–19 Uhr
  abstand: 25, // m vom Knoten auf dem Arm
};

/**
 * So weit liegt ein Punkt rechts seiner Fahrtrichtung (m), wie im Rechtsverkehr: Zufahrt und
 * Ausfahrt eines Arms liegen dann nicht aufeinander, und bei getrennten Fahrbahnen liegt der Punkt
 * näher an der richtigen.
 */
export const SEITE_M = 3;

const R = 6371008.8;

/** Ein Punkt `m` Meter von (lon, lat) in Richtung `grad` (Kugel, für kurze Wege genau genug). */
export function versetze(lon, lat, grad, m) {
  const a = (grad * Math.PI) / 180;
  const dLat = (m * Math.cos(a)) / R;
  const dLon = (m * Math.sin(a)) / (R * Math.cos((lat * Math.PI) / 180));
  return [lon + (dLon * 180) / Math.PI, lat + (dLat * 180) / Math.PI];
}

/**
 * manifest.json -> { erzeugt, index (Pfad), muster (Pfad der Ströme mit {quelle} und {jahr}, oder
 * null, wenn die Zählkarte keine ausgibt), jahre (Map Quelle -> Jahre), gruppenNamen, quellen (Map
 * Code -> { code, name, land, lizenzen: Map Code -> { code, titel, herausgeber, lizenz, url,
 * herkunft, ohneLizenz } }) }. Die Lizenz einer Zählung ist die ihrer Lieferung; `lage` ist die
 * Lizenz der Geokodierung (ODbL, aus OpenStreetMap).
 */
export function leseManifest(m) {
  if (!m || typeof m !== "object" || !m.dateien) throw new Error(tx("Das ist keine manifest.json der Zählkarte.", "This is not a manifest.json of the Zählkarte."));
  const quellen = new Map();
  for (const q of m.quellen ?? []) {
    const lizenzen = new Map();
    for (const l of q.lizenzen ?? []) {
      lizenzen.set(l.code, {
        code: l.code,
        titel: l.titel ?? null,
        herausgeber: l.herausgeber ?? null,
        lizenz: l.lizenz ?? null,
        url: l.lizenz_url ?? null,
        herkunft: l.herkunft_url ?? null,
        ohneLizenz: Boolean(l.ohne_lizenz),
      });
    }
    quellen.set(q.code, { code: q.code, name: q.name ?? q.code, land: q.land ?? null, lizenzen });
  }
  const jahre = new Map(Object.entries(m.stroeme ?? {}).map(([q, j]) => [q, [...j].map(Number).filter(Number.isInteger).sort((a, b) => a - b)]));
  return {
    erzeugt: m.erzeugt ?? null,
    index: m.dateien.index ?? "index.json",
    muster: m.dateien.stroeme ?? null,
    jahre,
    gruppenNamen: Object.fromEntries((m.gruppen ?? []).map((g) => [g.id, g.name])),
    quellen,
  };
}

/** Pfad der Ströme einer Quelle in einem Jahr, relativ zum Datenordner. */
export const stroemePfad = (manifest, quelle, jahr) => manifest.muster.replace("{quelle}", quelle).replace("{jahr}", String(jahr));

/** index.json -> Map ID -> { id, quelle, name, typ (K Knoten, Q Querschnitt), lon, lat, lage }; nur Stellen mit Lage. */
export function leseStellen(ix) {
  if (!ix || typeof ix !== "object" || !ix.stellen?.felder) throw new Error(tx("Das ist keine index.json der Zählkarte.", "This is not an index.json of the Zählkarte."));
  const at = Object.fromEntries(ix.stellen.felder.map((name, i) => [name, i]));
  for (const pflicht of ["id", "quelle", "lon", "lat"]) {
    if (!(pflicht in at)) throw new Error(tx(`In index.json fehlt das Feld „${pflicht}“ der Stellen.`, `In index.json, the sites lack the field “${pflicht}”.`));
  }
  const quellen = ix.quellen ?? [];
  const lagen = ix.lagen ?? [];
  const out = new Map();
  for (const w of ix.stellen.werte ?? []) {
    const lon = Number(w[at.lon]);
    const lat = Number(w[at.lat]);
    if (w[at.lon] == null || w[at.lat] == null || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const q = w[at.quelle];
    const lage = at.lage !== undefined ? w[at.lage] : null;
    out.set(String(w[at.id]), {
      id: String(w[at.id]),
      quelle: typeof q === "number" ? quellen[q] ?? String(q) : String(q),
      name: at.name !== undefined ? w[at.name] ?? "" : "",
      typ: at.typ !== undefined ? w[at.typ] ?? null : null,
      lon,
      lat,
      lage: typeof lage === "number" ? lagen[lage] ?? null : lage ?? null,
    });
  }
  return out;
}

/**
 * Die Stundenwerte mehrerer Ströme zusammen, je Gruppe: { gruppe: [Werte ab h0] }. Eine Gruppe
 * kommt nur hinein, wenn jeder Strom sie gezählt hat; eine Stunde ist null, wenn sie einem Strom
 * fehlt. Gruppen ohne einen einzigen Wert bleiben weg.
 */
export function summe(stroeme, gruppen) {
  const out = {};
  if (!stroeme.length) return out;
  for (const g of gruppen) {
    if (stroeme.some((s) => !Array.isArray(s.stunden?.[g]))) continue;
    const n = Math.max(...stroeme.map((s) => s.stunden[g].length));
    const werte = [];
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (const s of stroeme) {
        const v = s.stunden[g][k];
        if (v == null || !Number.isFinite(v)) {
          sum = null;
          break;
        }
        sum += v;
      }
      werte.push(sum);
    }
    if (werte.some((v) => v != null)) out[g] = werte;
  }
  return out;
}

/**
 * Wie viele Stunden eine Zählung die Gruppe ganz gezählt hat: Stunden, in denen jeder Strom mit
 * dieser Gruppe einen Wert hat (wie die Summe in der Zählkarte). 0, wenn kein Strom sie zählt.
 */
export function gezaehlteStunden(z, g) {
  const mit = (z.stroeme ?? []).filter((s) => Array.isArray(s.stunden?.[g]));
  const w = summe(mit, [g])[g];
  return w ? w.filter((v) => v != null).length : 0;
}

/** Ob ein Tag in die Auswahl fällt: Wochentag, für Montag bis Freitag dazu die Art des Tages. */
export function tagPasst(z, opts) {
  if (!z.datum) return false;
  const wt = wochentag(tagNr(z.datum));
  if (!opts.wochentage.includes(wt)) return false;
  if (wt === 0 || wt === 6) return true;
  const art = z.tag === "w" || !z.tag ? "u" : z.tag;
  return opts.tage.includes(art);
}

/**
 * Je Stelle und Gruppe die jüngste Zählung, die passt: Jahr, Wochentag, Art des Tages und
 * mindestens `minStunden` gezählte Stunden der Gruppe. Am selben Tag gewinnt die mit mehr
 * gezählten Stunden (Berlin legt manche Zählung in zwei Dateien ab, 7–9 und 15–18 Uhr, oder je
 * Gehweg eine), dann die Kennung; die übrigen stehen als `andere` dabei. `eintraege`:
 * [{ quelle, kennung, z }], `imGebiet`: Set der Stellen, die in Frage kommen (null: alle).
 * -> [{ quelle, kennung, z, gruppen, andere: [Kennungen] }], sortiert nach Stelle und Kennung.
 */
export function waehleZaehlungen(eintraege, opts, imGebiet = null) {
  const best = new Map(); // Stelle + Gruppe -> { e, n }
  const amTag = new Map(); // Stelle + Gruppe + Datum -> Set der Kennungen
  for (const e of eintraege) {
    const z = e.z;
    if (!z?.stelle || (imGebiet && !imGebiet.has(z.stelle))) continue;
    const jahr = Number(String(z.datum ?? "").slice(0, 4));
    if (!Number.isInteger(jahr) || !jahr) continue;
    if (opts.vonJahr != null && jahr < opts.vonJahr) continue;
    if (opts.bisJahr != null && jahr > opts.bisJahr) continue;
    if (!tagPasst(z, opts)) continue;
    for (const g of opts.gruppen) {
      const n = gezaehlteStunden(z, g);
      if (n < Math.max(1, opts.minStunden ?? 1)) continue;
      const key = `${z.stelle}\u0000${g}`;
      const tagKey = `${key}\u0000${z.datum}`;
      if (!amTag.has(tagKey)) amTag.set(tagKey, new Set());
      amTag.get(tagKey).add(e.kennung);
      const alt = best.get(key);
      const besser = !alt || z.datum > alt.e.z.datum || (z.datum === alt.e.z.datum && (n > alt.n || (n === alt.n && e.kennung > alt.e.kennung)));
      if (besser) best.set(key, { e, n });
    }
  }
  const jeZaehlung = new Map();
  for (const [key, { e }] of best) {
    const g = key.split("\u0000")[1];
    const k = `${e.quelle}\u0000${e.kennung}`;
    if (!jeZaehlung.has(k)) jeZaehlung.set(k, { quelle: e.quelle, kennung: e.kennung, z: e.z, gruppen: [], andere: new Set() });
    const a = jeZaehlung.get(k);
    a.gruppen.push(g);
    for (const x of amTag.get(`${key}\u0000${e.z.datum}`) ?? []) if (x !== e.kennung) a.andere.add(x);
  }
  return [...jeZaehlung.values()]
    .map((a) => ({ ...a, gruppen: opts.gruppen.filter((g) => a.gruppen.includes(g)), andere: [...a.andere].sort() }))
    .sort((a, b) => (a.z.stelle < b.z.stelle ? -1 : a.z.stelle > b.z.stelle ? 1 : a.kennung < b.kennung ? -1 : a.kennung > b.kennung ? 1 : 0));
}

/** Ob eine Zählung als Knoten zu lesen ist: nach der Art der Stelle, sonst ab drei Armen in den Strömen. */
export function istKnoten(stelle, z) {
  if (stelle.typ === "K") return true;
  if (stelle.typ === "Q") return false;
  return new Set((z.stroeme ?? []).flatMap((s) => [s.von, s.nach])).size >= 3;
}

/** Ein Straßenname zum Vergleich mit den Links: ohne Klammer am Ende („Oranienburger Chaussee (NW)“), ohne Zusatz nach „/“. */
export function strassenName(text) {
  const t = String(text ?? "").split(/\s+\/\s+|\s*\(/)[0].replace(/\s+-\s+.*$/, "").trim();
  return t.length >= 3 ? t : null;
}

const KOMPASS_WORT = /^(nord|nordost|ost|südost|sued|süd|südwest|west|nordwest|norden|osten|süden|westen|stadteinwärts|stadtauswärts)$/i;

/**
 * Die Punkte einer gewählten Zählung (aus `waehleZaehlungen`) an ihrer Stelle { id, name, typ,
 * lon, lat, lage }. -> { punkte, ohneWinkel (Zu- und Ausfahrten an Armen ohne Winkel), ohneWerte }.
 * Ein Punkt: { id, stelle, quelle, kennung, name, art (knoten | querschnitt), seite (zu | aus |
 * richtung), arm ({ nr, name, winkel }: bei einem Querschnitt der Arm, zu dem es geht), vonArme,
 * lon, lat, grad (Fahrtrichtung oder null), knoten ({ lon, lat } der Stelle), suchName, h0, werte
 * ({ gruppe: [Werte ab h0] }), stroeme ([[von, nach]]), datum, tag, fenster, intervall, lieferung,
 * lage, andere }.
 */
export function punkte(stelle, a, opts = {}) {
  const z = a.z;
  const abstand = opts.abstand ?? KURZ_VORGABE.abstand;
  const seitlich = opts.seitlich ?? SEITE_M;
  const arme = new Map((z.arme ?? []).map((x) => [x.nr, x]));
  const armVon = (nr) => arme.get(nr) ?? { nr, name: "", winkel: null };
  const basis = {
    stelle: stelle.id,
    quelle: a.quelle,
    kennung: a.kennung,
    name: stelle.name,
    knoten: { lon: stelle.lon, lat: stelle.lat },
    h0: z.h0,
    datum: z.datum,
    tag: z.tag ?? null,
    fenster: z.fenster ?? "",
    intervall: z.intervall ?? null,
    lieferung: z.lieferung ?? null,
    lage: stelle.lage ?? null,
    andere: a.andere ?? [],
  };
  const out = [];
  let ohneWinkel = 0;
  let ohneWerte = 0;
  const stroeme = z.stroeme ?? [];
  if (istKnoten(stelle, z)) {
    for (const arm of z.arme ?? []) {
      const zu = stroeme.filter((s) => s.von === arm.nr);
      const aus = stroeme.filter((s) => s.nach === arm.nr);
      if (arm.winkel == null) {
        ohneWinkel += (zu.length ? 1 : 0) + (aus.length ? 1 : 0);
        continue;
      }
      const [armLon, armLat] = versetze(stelle.lon, stelle.lat, arm.winkel, abstand);
      for (const [seite, liste, grad] of [["zu", zu, (arm.winkel + 180) % 360], ["aus", aus, arm.winkel]]) {
        if (!liste.length) continue;
        const werte = summe(liste, a.gruppen);
        if (!Object.keys(werte).length) {
          ohneWerte++;
          continue;
        }
        const [lon, lat] = versetze(armLon, armLat, (grad + 90) % 360, seitlich);
        out.push({
          ...basis,
          id: `${stelle.id}/${a.kennung}/${arm.nr}${seite}`,
          art: "knoten",
          seite,
          arm: { ...arm },
          vonArme: seite === "zu" ? [{ ...arm }] : [...new Set(liste.map((s) => s.von))].map(armVon),
          lon,
          lat,
          grad,
          suchName: strassenName(arm.name),
          werte,
          stroeme: liste.map((s) => [s.von, s.nach]),
        });
      }
    }
  } else {
    // Querschnitt: je Arm, zu dem Ströme fahren, eine Fahrtrichtung; Wenden gibt es hier nicht
    const nach = new Map();
    for (const s of stroeme) {
      if (s.von === s.nach) continue;
      if (!nach.has(s.nach)) nach.set(s.nach, []);
      nach.get(s.nach).push(s);
    }
    for (const [nr, liste] of nach) {
      const arm = armVon(nr);
      const vonArme = [...new Set(liste.map((s) => s.von))].map(armVon);
      // ohne Winkel am Ziel: vom Arm, von dem alle kommen, weg (dessen Winkel + 180°)
      const grad = arm.winkel ?? (vonArme.length === 1 && vonArme[0].winkel != null ? (vonArme[0].winkel + 180) % 360 : null);
      const werte = summe(liste, a.gruppen);
      if (!Object.keys(werte).length) {
        ohneWerte++;
        continue;
      }
      const armStrasse = arm.name && !KOMPASS_WORT.test(arm.name.replace(/[()]/g, "").trim()) ? strassenName(arm.name) : null;
      const [lon, lat] = grad != null ? versetze(stelle.lon, stelle.lat, (grad + 90) % 360, seitlich) : [stelle.lon, stelle.lat];
      out.push({
        ...basis,
        id: `${stelle.id}/${a.kennung}/nach${nr}`,
        art: "querschnitt",
        seite: "richtung",
        arm: { ...arm },
        vonArme,
        lon,
        lat,
        grad,
        suchName: strassenName(stelle.name) ?? armStrasse,
        werte,
        stroeme: liste.map((s) => [s.von, s.nach]),
      });
    }
  }
  return { punkte: out, ohneWinkel, ohneWerte };
}

/**
 * Die Lizenzen eines Punkts: die seiner Lieferung (ohne Lieferung die erste der Quelle außer der
 * Lage) und, wenn die Lage der Stelle aus OpenStreetMap geokodiert oder von dort übertragen ist,
 * die der Geokodierung. -> { lieferung (Eintrag oder null), lage (Eintrag oder null), ok }.
 * `ok`, wenn die Lieferung eine Lizenz nennt: Ohne Lizenz geht nichts in eine Ausgabe.
 */
export function lizenzenVon(manifest, p) {
  const q = manifest.quellen.get(p.quelle);
  const liste = q ? [...q.lizenzen.values()] : [];
  const lieferung = (p.lieferung != null ? q?.lizenzen.get(p.lieferung) : null) ?? liste.find((l) => l.code !== "lage") ?? null;
  const lage = p.lage === "geokodiert" || p.lage === "uebertragen" ? q?.lizenzen.get("lage") ?? null : null;
  return { lieferung, lage, ok: Boolean(lieferung?.lizenz) && !lieferung.ohneLizenz };
}

export const TAGTYP = { s: "Schultag", f: "Ferientag", h: "Feiertag", w: "Wochenende", u: "ohne Kalender" };

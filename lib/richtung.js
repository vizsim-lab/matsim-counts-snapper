// Die Fahrtrichtung einer Dauerzählstelle aus dem Text der Zählkarte (`richtung` in
// dauer/index.json). Die Quellen schreiben sie verschieden:
//   Berlin (VIZ)      „Richtung AK Zehlendorf (Südwest)“
//   Baden-Württemberg „Richtung Norden“
//   Hamburg           „von Nord nach Süd“, „ohne Richtung (Querschnitt)“
//   Bayern, Ettlingen „Richtung Lindau“ (nur das Ziel)
// Eine MATSim-Messstelle hängt an einem gerichteten Link. Brauchbar sind darum nur Stellen, die
// eine Richtung zählen; eine Himmelsrichtung macht die Zuordnung eindeutig, ein bloßes Ziel nicht.

/** Himmelsrichtung -> Winkel in Grad, im Uhrzeigersinn ab Norden. */
const KOMPASS = {
  nord: 0, norden: 0,
  nordost: 45, nordosten: 45,
  ost: 90, osten: 90,
  südost: 135, südosten: 135,
  süd: 180, süden: 180,
  südwest: 225, südwesten: 225,
  west: 270, westen: 270,
  nordwest: 315, nordwesten: 315,
};

const KURZ = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];

/** Winkel einer Himmelsrichtung, oder null, wenn das Wort keine ist. */
export function kompass(wort) {
  if (wort == null) return null;
  const w = String(wort).trim().toLowerCase().replace(/ue/g, "ü").replace(/-/g, "");
  return Object.hasOwn(KOMPASS, w) ? KOMPASS[w] : null;
}

const LANG = ["Nord", "Nordost", "Ost", "Südost", "Süd", "Südwest", "West", "Nordwest"];

/** Langform eines Winkels: Nord, Nordost, … */
export function lang(grad) {
  if (grad == null || !Number.isFinite(grad)) return "";
  return LANG[Math.round((((grad % 360) + 360) % 360) / 45) % 8];
}

/** Kurzform eines Winkels: N, NO, O, … */
export function kurz(grad) {
  if (grad == null || !Number.isFinite(grad)) return "";
  return KURZ[Math.round((((grad % 360) + 360) % 360) / 45) % 8];
}

/**
 * Was der Text über die Richtung sagt:
 * - art "gerichtet": die Stelle zählt eine Richtung; `grad` ist ihre Himmelsrichtung oder null,
 *   wenn nur ein Ziel genannt ist (`ziel`)
 * - art "beide": beide Richtungen zusammen (Querschnitt)
 * - art "ohne": keine Angabe; bei den meisten Rad-Zählstellen heißt das ebenfalls beide Richtungen
 */
export function richtung(text) {
  const t = text == null ? "" : String(text).trim();
  if (!t) return { art: "ohne", grad: null, ziel: null };
  if (/ohne\s+richtung|querschnitt|beide\s+richtungen/i.test(t)) return { art: "beide", grad: null, ziel: null };

  // „von Nord nach Süd“: gefahren wird nach Süden
  const vonNach = /^von\s+(.+?)\s+nach\s+(.+)$/i.exec(t);
  if (vonNach) {
    const grad = kompass(vonNach[2]);
    return { art: "gerichtet", grad, ziel: grad == null ? vonNach[2].trim() : null };
  }

  // „Richtung AK Zehlendorf (Südwest)“: die Klammer am Ende
  const klammer = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(t);
  const rumpf = klammer ? klammer[1] : t;
  const zielText = rumpf.replace(/^richtung\s+/i, "").trim() || null;
  if (klammer) {
    const grad = kompass(klammer[2]);
    if (grad != null) return { art: "gerichtet", grad, ziel: zielText && kompass(zielText) == null ? zielText : null };
  }

  // „Richtung Norden“: das Ziel selbst ist eine Himmelsrichtung, ein Ortsname wie „Nordhausen“ nicht
  const grad = kompass(zielText);
  if (grad != null) return { art: "gerichtet", grad, ziel: null };

  return { art: "gerichtet", grad: null, ziel: zielText ?? t };
}

/** Kleinster Unterschied zweier Winkel in Grad, 0 bis 180. */
export function winkelAbstand(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

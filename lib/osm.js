// OpenStreetMap als Netz: eine .osm.pbf lesen und ihre Wege als gerichtete Kanten liefern, die der
// Snapper wie MATSim-Links behandelt (Aufbau wie in lib/netz.js, Koordinaten in WGS 84).
//
// Ohne Bibliothek: Die Datei ist eine Folge von Blobs, fast immer zlib-komprimiert (das entpackt der
// Browser selbst, DecompressionStream "deflate"), darin Protobuf
// (https://wiki.openstreetmap.org/wiki/PBF_Format). Zwei Durchgänge: erst die Wege, die der Filter
// behält, dann nur deren Knoten. So bleibt der Speicher klein; die Knoten-Blobs werden dafür zweimal
// entpackt.
//
// Kanten heißen wie bei SUMO: Weg-ID#Abschnitt, die Gegenrichtung mit Minus davor („-123#0“). Ein Weg
// wird an jedem Knoten geteilt, den er mit einem anderen Weg teilt (oder zweimal durchläuft). Das sind
// nicht unbedingt die IDs eines MATSim-Netzes aus denselben Daten – die Übernahme (lib/uebertrag.js)
// prüft darum immer die Lage.

const TD = new TextDecoder();

// ---------- Protobuf ----------

/** Liest Protobuf aus buf[pos, end). Ganze Zahlen bis 2^53 genau (OSM-IDs passen). */
class Leser {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  get mehr() {
    return this.pos < this.end;
  }

  varint() {
    const buf = this.buf;
    let b = buf[this.pos++];
    if (b < 0x80) return b;
    let x = b & 0x7f;
    b = buf[this.pos++];
    x |= (b & 0x7f) << 7;
    if (b < 0x80) return x;
    b = buf[this.pos++];
    x |= (b & 0x7f) << 14;
    if (b < 0x80) return x;
    b = buf[this.pos++];
    x |= (b & 0x7f) << 21;
    if (b < 0x80) return x;
    // über 28 Bit: weiter mit Multiplikation, Bitoperationen rechnen nur mit 32 Bit
    let mal = 268435456;
    for (;;) {
      b = buf[this.pos++];
      x += (b & 0x7f) * mal;
      if (b < 0x80) return x;
      mal *= 128;
    }
  }

  /** sint64/sint32 (ZigZag). */
  sint() {
    const v = this.varint();
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }

  /** int64 als Zweierkomplement (negative Werte belegen zehn Bytes). */
  int64() {
    const v = this.varint();
    return v >= 9223372036854775808 ? v - 18446744073709551616 : v;
  }

  /** Länge und Bereich eines Felds mit Drahttyp 2: [anfang, ende). */
  bereich() {
    const n = this.varint();
    const a = this.pos;
    this.pos += n;
    return [a, this.pos];
  }

  text() {
    const [a, b] = this.bereich();
    return TD.decode(this.buf.subarray(a, b));
  }

  ueberspringe(draht) {
    if (draht === 0) this.varint();
    else if (draht === 1) this.pos += 8;
    else if (draht === 2) {
      const n = this.varint(); // erst lesen: `this.pos += this.varint()` nähme die alte Position
      this.pos += n;
    } else if (draht === 5) this.pos += 4;
    else throw new Error(`Protobuf: Drahttyp ${draht} kennt der Leser nicht – ist die Datei beschädigt?`);
  }
}

/** Die Blobs der Datei: [{ typ ("OSMHeader" | "OSMData"), daten (Blob-Bytes) }]. */
export function blobs(bytes) {
  const out = [];
  let p = 0;
  while (p + 4 <= bytes.length) {
    const laenge = ((bytes[p] << 24) >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3];
    p += 4;
    if (laenge > 65536 || p + laenge > bytes.length) throw new Error("Das ist keine lesbare .osm.pbf (Blob-Kopf passt nicht).");
    const r = new Leser(bytes, p, p + laenge);
    let typ = "";
    let groesse = -1;
    while (r.mehr) {
      const k = r.varint();
      if (k >>> 3 === 1 && (k & 7) === 2) typ = r.text();
      else if (k >>> 3 === 3 && (k & 7) === 0) groesse = r.varint();
      else r.ueberspringe(k & 7);
    }
    p += laenge;
    if (groesse < 0 || p + groesse > bytes.length) throw new Error("Die .osm.pbf ist abgeschnitten.");
    out.push({ typ, daten: bytes.subarray(p, p + groesse) });
    p += groesse;
  }
  if (!out.length || out[0].typ !== "OSMHeader") throw new Error("Das ist keine .osm.pbf (am Anfang fehlt der OSMHeader).");
  return out;
}

/** Ob die Bytes nach einer .osm.pbf aussehen: Länge des ersten Kopfs, dann Feld 1 = „OSMHeader“. */
export function istPbf(bytes) {
  if (!bytes || bytes.length < 16 || bytes[0] || bytes[1]) return false;
  return bytes[4] === 0x0a && bytes[5] === 9 && TD.decode(bytes.subarray(6, 15)) === "OSMHeader";
}

const VERFAHREN = { 4: "LZMA", 5: "bzip2", 6: "LZ4", 7: "Zstandard" };

/** Den Inhalt eines Blobs: roh oder zlib. */
async function entpacke(blob) {
  const r = new Leser(blob);
  let roh = null;
  let zlib = null;
  let anders = null;
  while (r.mehr) {
    const k = r.varint();
    const f = k >>> 3;
    if ((k & 7) === 2) {
      const [a, b] = r.bereich();
      if (f === 1) roh = blob.subarray(a, b);
      else if (f === 3) zlib = blob.subarray(a, b);
      else anders = VERFAHREN[f] ?? `Feld ${f}`;
    } else r.ueberspringe(k & 7);
  }
  if (roh) return roh;
  if (zlib) {
    const strom = new Blob([zlib]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(strom).arrayBuffer());
  }
  throw new Error(`Die .osm.pbf ist mit ${anders ?? "einem unbekannten Verfahren"} komprimiert, lesen kann der Snapper nur zlib. Umpacken mit: osmium cat ein.osm.pbf -o aus.osm.pbf -f pbf,pbf_compression=zlib`);
}

/** Blobs entpacken, bis zu `breite` gleichzeitig, in der Reihenfolge der Liste. */
async function* entpackt(liste, breite = 8) {
  const offen = [];
  let i = 0;
  while (i < liste.length || offen.length) {
    while (i < liste.length && offen.length < breite) {
      const p = entpacke(liste[i].daten);
      p.catch(() => {}); // der Fehler kommt beim await an der Reihe, nicht als unbehandelt
      offen.push({ i, p });
      i++;
    }
    const { i: nr, p } = offen.shift();
    yield { nr, daten: await p };
  }
}

const BEKANNT = new Set(["OsmSchema-V0.6", "DenseNodes"]);

/** HeaderBlock: benötigte und optionale Eigenschaften. */
function leseKopf(buf) {
  const r = new Leser(buf);
  const kopf = { benoetigt: [], optional: [] };
  while (r.mehr) {
    const k = r.varint();
    if (k >>> 3 === 4 && (k & 7) === 2) kopf.benoetigt.push(r.text());
    else if (k >>> 3 === 5 && (k & 7) === 2) kopf.optional.push(r.text());
    else r.ueberspringe(k & 7);
  }
  const fremd = kopf.benoetigt.filter((x) => !BEKANNT.has(x));
  if (fremd.includes("HistoricalInformation")) throw new Error("Die .osm.pbf enthält die Versionsgeschichte (HistoricalInformation). Bitte einen normalen Auszug nehmen.");
  if (fremd.length) throw new Error(`Die .osm.pbf verlangt ${fremd.join(", ")} – das kann der Snapper nicht lesen.`);
  return kopf;
}

/** PrimitiveBlock: Bereich der Stringtabelle, Bereiche der Gruppen, Raster der Koordinaten. */
function leseBlock(buf) {
  const r = new Leser(buf);
  const b = { strings: null, gruppen: [], raster: 100, latVersatz: 0, lonVersatz: 0 };
  while (r.mehr) {
    const k = r.varint();
    const f = k >>> 3;
    const w = k & 7;
    if (f === 1 && w === 2) b.strings = r.bereich();
    else if (f === 2 && w === 2) b.gruppen.push(r.bereich());
    else if (f === 17 && w === 0) b.raster = r.varint();
    else if (f === 19 && w === 0) b.latVersatz = r.int64();
    else if (f === 20 && w === 0) b.lonVersatz = r.int64();
    else r.ueberspringe(w);
  }
  return b;
}

/** Die Stringtabelle eines Blocks; entschlüsselt wird erst, was gebraucht wird. */
class Strings {
  constructor(buf, bereich) {
    this.buf = buf;
    this.anfang = [];
    this.ende = [];
    this.text = [];
    if (!bereich) return;
    const r = new Leser(buf, bereich[0], bereich[1]);
    while (r.mehr) {
      const k = r.varint();
      if (k >>> 3 === 1 && (k & 7) === 2) {
        const [a, b] = r.bereich();
        this.anfang.push(a);
        this.ende.push(b);
      } else r.ueberspringe(k & 7);
    }
  }

  get(i) {
    let s = this.text[i];
    if (s === undefined) {
      s = i < this.anfang.length ? TD.decode(this.buf.subarray(this.anfang[i], this.ende[i])) : "";
      this.text[i] = s;
    }
    return s;
  }
}

/** Ein wachsendes Float64Array. */
class Reihe {
  constructor(n = 1 << 16) {
    this.a = new Float64Array(n);
    this.n = 0;
  }

  push(v) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }

  get werte() {
    return this.a.subarray(0, this.n);
  }
}

// ---------- Tags: Verkehrsmittel und Richtung ----------

// Straßenklassen mit Kfz-Verkehr (https://wiki.openstreetmap.org/wiki/DE:Key:highway)
const KFZ = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "road", "service"]);
const WEGE = new Set(["path", "footway", "pedestrian", "bridleway", "track", "steps"]);
const OHNE_RAD = new Set(["motorway", "motorway_link"]);
const OHNE_FUSS = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);
const FREI = new Set(["yes", "designated", "permissive"]);
const ZU = new Set(["no", "private"]);
const VOR = new Set(["yes", "true", "1"]);
const RUECK = new Set(["-1", "reverse"]);
const BEIDE = new Set(["no", "false", "0"]);
const KEINE_STRASSE = new Set(["proposed", "construction", "abandoned", "razed", "platform", "bus_stop", "elevator", "corridor", "raceway", "rest_area", "services", "emergency_bay"]);

/** Die Schlüssel, die der Leser von einem Weg braucht. */
const SCHLUESSEL = new Set(["highway", "name", "ref", "oneway", "oneway:bicycle", "junction", "access", "vehicle", "motor_vehicle", "motorcar", "bicycle", "foot", "cycleway", "cycleway:left", "cycleway:right", "cycleway:both", "motorroad", "maxspeed", "area"]);

const einbahn = (wert, vorgabe) => (VOR.has(wert) ? 1 : RUECK.has(wert) ? -1 : BEIDE.has(wert) ? 0 : vorgabe);

/**
 * Wer einen Weg in welcher Richtung benutzen darf -> { vor, rueck } als MATSim-Modes („car,bike“);
 * vor = in Zeichenrichtung des Wegs. Grob, aber für Zählstellen genug: Kfz auf den Straßenklassen
 * ohne Sperre, Rad dazu auf Radwegen und freigegebenen Wegen (nicht auf Autobahnen, Kraftfahrstraßen
 * und bei bicycle=no/use_sidepath), zu Fuß auf allem außer Autobahnen und Kraftstraßen.
 */
export function verkehrsmittel(t) {
  const hw = t.highway;
  const gesperrt = ZU.has(t.access) || ZU.has(t.vehicle);
  let kfz = KFZ.has(hw) && !gesperrt && !ZU.has(t.motor_vehicle) && t.motorcar !== "no";
  if (KFZ.has(hw) && gesperrt && (FREI.has(t.motor_vehicle) || FREI.has(t.motorcar))) kfz = true;
  let rad;
  if (hw === "cycleway") rad = t.bicycle !== "no";
  else if (WEGE.has(hw)) rad = hw !== "steps" && FREI.has(t.bicycle);
  else if (KFZ.has(hw)) rad = FREI.has(t.bicycle) || (!OHNE_RAD.has(hw) && t.motorroad !== "yes" && !gesperrt && t.bicycle !== "no" && t.bicycle !== "use_sidepath");
  else rad = FREI.has(t.bicycle);
  const fuss = FREI.has(t.foot) || (!OHNE_FUSS.has(hw) && t.motorroad !== "yes" && t.foot !== "no" && t.foot !== "use_sidepath" && t.access !== "no" && (WEGE.has(hw) || KFZ.has(hw) || hw === "cycleway"));

  const implizit = t.junction === "roundabout" || t.junction === "circular" || hw === "motorway" || hw === "motorway_link" ? 1 : 0;
  const kfzRichtung = einbahn(t.oneway, implizit);
  let radRichtung = einbahn(t["oneway:bicycle"], kfzRichtung);
  const gegen = [t.cycleway, t["cycleway:left"], t["cycleway:right"], t["cycleway:both"]].some((v) => typeof v === "string" && v.startsWith("opposite"));
  if (kfzRichtung !== 0 && t["oneway:bicycle"] === undefined && gegen) radRichtung = 0;

  const vor = [];
  const rueck = [];
  if (kfz && kfzRichtung !== -1) vor.push("car");
  if (kfz && kfzRichtung !== 1) rueck.push("car");
  if (rad && radRichtung !== -1) vor.push("bike");
  if (rad && radRichtung !== 1) rueck.push("bike");
  if (fuss) {
    vor.push("walk");
    rueck.push("walk");
  }
  return { vor: vor.join(","), rueck: rueck.join(",") };
}

// wie das Makefile von matsim-berlin (osmosis --tf accept-ways …, Netz im Szenariogebiet)
const BERLIN = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary_link", "secondary", "tertiary", "residential", "living_street", "unclassified", "cycleway"]);
const HAUPT = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"]);
const STRASSEN = new Set([...KFZ].filter((k) => k !== "service"));

/** Welche Wege der Leser behält und welche Verkehrsmittel er ihnen gibt. */
export const OSM_FILTER = {
  strassen: {
    name: "Straßen und Radwege",
    text: "Straßen von motorway bis living_street, dazu Radwege und für Rad freigegebene Wege; ohne service, Fußwege und Treppen.",
    nimm: (t) => STRASSEN.has(t.highway) || t.highway === "cycleway" || (WEGE.has(t.highway) && FREI.has(t.bicycle)),
    modi: ["car", "bike"],
  },
  berlin: {
    name: "wie matsim-berlin",
    text: "Der Filter aus dem Makefile von matsim-berlin für das Szenariogebiet: motorway bis tertiary (ohne tertiary_link), residential, living_street, unclassified, cycleway und alles mit bicycle=designated.",
    nimm: (t) => BERLIN.has(t.highway) || t.bicycle === "designated",
    modi: ["car", "bike"],
  },
  haupt: {
    name: "nur Hauptstraßen",
    text: "motorway bis tertiary samt Rampen – für große Gebiete, in denen sonst der Browser zu viel zu tragen hat.",
    nimm: (t) => HAUPT.has(t.highway),
    modi: ["car", "bike"],
  },
  alle: {
    name: "alle Wege, auch zu Fuß",
    text: "Jeder Weg mit highway=* außer geplanten, Bahnsteigen und Ähnlichem; zu Fuß als walk.",
    nimm: (t) => !KEINE_STRASSE.has(t.highway),
    modi: ["car", "bike", "walk"],
  },
};

/** Grobe Kapazität je Klasse – nur für die Linienbreite in der Karte. */
const BREITE = { motorway: 4000, motorway_link: 3000, trunk: 4000, trunk_link: 3000, primary: 3000, primary_link: 3000, secondary: 1500, secondary_link: 1500, tertiary: 1000, tertiary_link: 1000 };

/** maxspeed in km/h, wenn eine Zahl dasteht („50“, „30 mph“). */
function kmh(maxspeed) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph)?\s*$/.exec(maxspeed ?? "");
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1.609344 : 1);
}

/** Länge einer Polylinie in WGS 84, in Metern (gleichabständig genähert). */
function laengeWgs(xy) {
  let s = 0;
  for (let k = 0; k + 3 < xy.length; k += 2) {
    const kx = 111320 * Math.cos((((xy[k + 1] + xy[k + 3]) / 2) * Math.PI) / 180);
    s += Math.hypot((xy[k + 2] - xy[k]) * kx, (xy[k + 3] - xy[k + 1]) * 110540);
  }
  return s;
}

/** Index von x in der sortierten Liste a, sonst -1. */
function suche(a, x) {
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const v = a[m];
    if (v < x) lo = m + 1;
    else if (v > x) hi = m - 1;
    else return m;
  }
  return -1;
}

// ---------- Lesen ----------

/**
 * Eine .osm.pbf -> { links (wie lib/netz.js, xy in WGS 84, dazu `weg` mit Vorzeichen und `wege`),
 * nodes, crs: "EPSG:4326", stats, osm: { filter, wege, kanten, ohneKnoten } }.
 */
export async function leseOsm(bytes, { filter = "strassen", status = () => {} } = {}) {
  const f = OSM_FILTER[filter] ?? OSM_FILTER.strassen;
  const behalte = new Set(f.modi);
  const nurBehalten = (modes) => modes.split(",").filter((m) => behalte.has(m)).join(",");
  if (!istPbf(bytes)) throw new Error("Das ist keine .osm.pbf (am Anfang fehlt der OSMHeader).");
  const liste = blobs(bytes);
  const kopf = leseKopf(await entpacke(liste[0].daten));
  const daten = liste.slice(1).filter((b) => b.typ === "OSMData");
  const stats = { blobs: daten.length, knoten: 0, wege: 0, behalten: 0, kanten: 0, ohneKnoten: 0, missing: 0, withGeometry: 0, fromCsv: 0, fromOrigGeom: 0, csvMatched: 0, ptLinks: 0, named: 0 };

  // 1. Durchgang: Wege
  const wegId = [];
  const anfang = [];
  const tags = [];
  const modi = [];
  const refs = new Reihe();
  const lage = new Reihe(); // lon, lat je Ref, wenn die Datei sie an den Wegen trägt (LocationsOnWays)
  const knotenBloecke = [];
  let lageAmWeg = false;
  for await (const { nr, daten: buf } of entpackt(daten)) {
    const blk = leseBlock(buf);
    let strings = null;
    let hatKnoten = false;
    for (const [ga, gb] of blk.gruppen) {
      const g = new Leser(buf, ga, gb);
      while (g.mehr) {
        const k = g.varint();
        const feld = k >>> 3;
        if ((k & 7) !== 2) {
          g.ueberspringe(k & 7);
          continue;
        }
        const [a, b] = g.bereich();
        if (feld === 1 || feld === 2) {
          hatKnoten = true;
          continue;
        }
        if (feld !== 3) continue;
        stats.wege++;
        strings ??= new Strings(buf, blk.strings);
        // ein Weg: id, keys, vals, refs, dazu lat/lon bei LocationsOnWays
        const w = new Leser(buf, a, b);
        let id = 0;
        let keys = null;
        let vals = null;
        let rf = null;
        let la = null;
        let lo = null;
        while (w.mehr) {
          const kk = w.varint();
          const ff = kk >>> 3;
          const ww = kk & 7;
          if (ff === 1 && ww === 0) id = w.int64();
          else if (ff === 2 && ww === 2) keys = w.bereich();
          else if (ff === 3 && ww === 2) vals = w.bereich();
          else if (ff === 8 && ww === 2) rf = w.bereich();
          else if (ff === 9 && ww === 2) la = w.bereich();
          else if (ff === 10 && ww === 2) lo = w.bereich();
          else w.ueberspringe(ww);
        }
        if (!keys || !vals || !rf) continue;
        const t = {};
        let hw = false;
        const kr = new Leser(buf, keys[0], keys[1]);
        const vr = new Leser(buf, vals[0], vals[1]);
        while (kr.mehr && vr.mehr) {
          const s = strings.get(kr.varint());
          const v = vr.varint();
          if (!SCHLUESSEL.has(s)) continue;
          t[s] = strings.get(v);
          if (s === "highway") hw = true;
        }
        if (!hw || t.area === "yes" || !f.nimm(t)) continue;
        const m = verkehrsmittel(t);
        const vor = nurBehalten(m.vor);
        const rueck = nurBehalten(m.rueck);
        if (!vor && !rueck) continue;
        stats.behalten++;
        wegId.push(id);
        anfang.push(refs.n);
        tags.push({ highway: t.highway, name: t.name ?? t.ref ?? null, maxspeed: t.maxspeed ?? null });
        modi.push({ vor, rueck });
        const rr = new Leser(buf, rf[0], rf[1]);
        let ref = 0;
        while (rr.mehr) {
          ref += rr.sint();
          refs.push(ref);
        }
        if (la && lo) {
          lageAmWeg = true;
          const lr = new Leser(buf, la[0], la[1]);
          const or = new Leser(buf, lo[0], lo[1]);
          let y = 0;
          let x = 0;
          while (lr.mehr && or.mehr) {
            y += lr.sint();
            x += or.sint();
            lage.push(1e-9 * (blk.lonVersatz + blk.raster * x));
            lage.push(1e-9 * (blk.latVersatz + blk.raster * y));
          }
        } else {
          for (let i = anfang[anfang.length - 1]; i < refs.n; i++) {
            lage.push(NaN);
            lage.push(NaN);
          }
        }
        while (lage.n < 2 * refs.n) lage.push(NaN); // weniger Lagen als Refs: Rest ohne
      }
    }
    if (hatKnoten) knotenBloecke.push(nr);
    if (nr % 64 === 0) status(`OSM lesen, Wege: ${Math.round((100 * nr) / daten.length)} % …`);
  }
  anfang.push(refs.n);
  if (!wegId.length) throw new Error(`In der Datei stehen keine Wege, die der Filter „${f.name}“ behält.`);

  // Knoten der behaltenen Wege, sortiert, mit Anzahl (ab 2 ein Knotenpunkt) und Lage
  const alle = Float64Array.from(refs.werte).sort();
  const ids = new Float64Array(alle.length);
  const anzahl = new Uint32Array(alle.length);
  let n = 0;
  for (let i = 0; i < alle.length; i++) {
    if (n && alle[i] === ids[n - 1]) anzahl[n - 1]++;
    else {
      ids[n] = alle[i];
      anzahl[n] = 1;
      n++;
    }
  }
  const knoten = ids.subarray(0, n);
  const lon = new Float64Array(n).fill(NaN);
  const lat = new Float64Array(n).fill(NaN);
  const refIndex = new Int32Array(refs.n);
  for (let i = 0; i < refs.n; i++) {
    const j = suche(knoten, refs.a[i]);
    refIndex[i] = j;
    if (lageAmWeg && Number.isFinite(lage.a[2 * i]) && Number.isNaN(lon[j])) {
      lon[j] = lage.a[2 * i];
      lat[j] = lage.a[2 * i + 1];
    }
  }

  // 2. Durchgang: die Lage der Knoten, die noch fehlt
  let offen = 0;
  for (let j = 0; j < n; j++) if (Number.isNaN(lon[j])) offen++;
  if (offen) {
    let zeiger = 0; // in sortierten Dateien steigen die IDs: dann reicht ein Zeiger statt Suche
    const finde = (id) => {
      if (zeiger > 0 && id <= knoten[zeiger - 1]) {
        if (id === knoten[zeiger - 1]) return zeiger - 1;
        const j = suche(knoten, id);
        if (j >= 0) zeiger = j + 1;
        return j;
      }
      while (zeiger < n && knoten[zeiger] < id) zeiger++;
      if (zeiger < n && knoten[zeiger] === id) return zeiger++;
      return -1;
    };
    const setze = (id, y, x, blk) => {
      const j = finde(id);
      if (j >= 0 && Number.isNaN(lon[j])) {
        lon[j] = 1e-9 * (blk.lonVersatz + blk.raster * x);
        lat[j] = 1e-9 * (blk.latVersatz + blk.raster * y);
      }
    };
    const auswahl = knotenBloecke.map((i) => daten[i]);
    let fertig = 0;
    for await (const { daten: buf } of entpackt(auswahl)) {
      const blk = leseBlock(buf);
      for (const [ga, gb] of blk.gruppen) {
        const g = new Leser(buf, ga, gb);
        while (g.mehr) {
          const k = g.varint();
          if ((k & 7) !== 2) {
            g.ueberspringe(k & 7);
            continue;
          }
          const feld = k >>> 3;
          const [a, b] = g.bereich();
          if (feld === 2) {
            // DenseNodes: id, lat, lon je für sich gepackt, als Differenzen
            const d = new Leser(buf, a, b);
            let bi = null;
            let bla = null;
            let blo = null;
            while (d.mehr) {
              const kk = d.varint();
              const ff = kk >>> 3;
              if ((kk & 7) === 2 && (ff === 1 || ff === 8 || ff === 9)) {
                const r = d.bereich();
                if (ff === 1) bi = r;
                else if (ff === 8) bla = r;
                else blo = r;
              } else d.ueberspringe(kk & 7);
            }
            if (!bi || !bla || !blo) continue;
            const ri = new Leser(buf, bi[0], bi[1]);
            const ry = new Leser(buf, bla[0], bla[1]);
            const rx = new Leser(buf, blo[0], blo[1]);
            let id = 0;
            let y = 0;
            let x = 0;
            while (ri.mehr) {
              id += ri.sint();
              y += ry.sint();
              x += rx.sint();
              stats.knoten++;
              setze(id, y, x, blk);
            }
          } else if (feld === 1) {
            // ein einzelner Node: id, lat, lon
            const d = new Leser(buf, a, b);
            let id = 0;
            let y = 0;
            let x = 0;
            while (d.mehr) {
              const kk = d.varint();
              const ff = kk >>> 3;
              if (ff === 1 && (kk & 7) === 0) id = d.sint();
              else if (ff === 8 && (kk & 7) === 0) y = d.sint();
              else if (ff === 9 && (kk & 7) === 0) x = d.sint();
              else d.ueberspringe(kk & 7);
            }
            stats.knoten++;
            setze(id, y, x, blk);
          }
        }
      }
      fertig++;
      if (fertig % 64 === 0) status(`OSM lesen, Knoten: ${Math.round((100 * fertig) / auswahl.length)} % …`);
    }
  }

  // Kanten: jeder Weg geteilt an Knotenpunkten, je Richtung mit ihren Verkehrsmitteln
  status("OSM: Kanten bilden …");
  const links = [];
  const benutzt = new Uint8Array(n);
  for (let w = 0; w < wegId.length; w++) {
    const a0 = anfang[w];
    const a1 = anfang[w + 1];
    if (a1 - a0 < 2) continue;
    const { vor, rueck } = modi[w];
    const t = tags[w];
    const id = wegId[w];
    const tempo = kmh(t.maxspeed);
    const wid = String(id);
    const wege = [wid];
    const freespeed = tempo != null ? tempo / 3.6 : NaN;
    const capacity = BREITE[t.highway] ?? NaN;
    const kante = (kid, from, to, modes, weg, xy, length) => ({ id: kid, from, to, modes, type: t.highway, name: t.name, freespeed, capacity, permlanes: NaN, length, allowedSpeed: null, weg, wege, osm: true, xy });
    let k = 0;
    let von = a0;
    for (let i = a0 + 1; i < a1; i++) {
      if (i < a1 - 1 && anzahl[refIndex[i]] < 2) continue;
      // Abschnitt von..i, nur Knoten mit Lage
      let m = 0;
      for (let r = von; r <= i; r++) if (!Number.isNaN(lon[refIndex[r]])) m++;
      const xy = new Float64Array(2 * m);
      let q = 0;
      for (let r = von; r <= i; r++) {
        const j = refIndex[r];
        if (Number.isNaN(lon[j])) continue;
        xy[q++] = lon[j];
        xy[q++] = lat[j];
        benutzt[j] = 1;
      }
      const laenge = m >= 2 ? laengeWgs(xy) : 0;
      if (laenge > 0.01) {
        const vonId = String(refs.a[von]);
        const nachId = String(refs.a[i]);
        if (vor) links.push(kante(`${wid}#${k}`, vonId, nachId, vor, wid, xy, laenge));
        if (rueck) {
          const r = new Float64Array(xy.length);
          for (let p = 0; p < xy.length; p += 2) {
            r[xy.length - 2 - p] = xy[p];
            r[xy.length - 1 - p] = xy[p + 1];
          }
          links.push(kante(`-${wid}#${k}`, nachId, vonId, rueck, `-${wid}`, r, laenge));
        }
        if (t.name) stats.named += (vor ? 1 : 0) + (rueck ? 1 : 0);
      } else stats.ohneKnoten++;
      k++;
      von = i;
    }
  }
  let knotenGenutzt = 0;
  for (let j = 0; j < n; j++) knotenGenutzt += benutzt[j];
  stats.kanten = links.length;
  stats.withGeometry = links.length;
  if (!links.length) throw new Error("Aus den Wegen ließ sich keine Kante bilden – fehlen der Datei die Knoten?");
  return {
    links,
    nodes: knotenGenutzt,
    crs: "EPSG:4326",
    stats,
    osm: { filter: f.name, filterCode: filter in OSM_FILTER ? filter : "strassen", wege: stats.behalten, kanten: links.length, ohneKnoten: stats.ohneKnoten, lageAmWeg, optional: kopf.optional },
  };
}

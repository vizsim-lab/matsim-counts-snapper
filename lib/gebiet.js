// Ein Gebiet, auf das sich die Auswahl der Zählstellen beschränkt: auf der Karte gezeichnet oder aus
// einer Datei – GeoJSON, die .poly-Datei von osmium und Osmosis, ein Shapefile (auch gezippt).
// Intern immer WGS 84, als Liste von Polygonen, je Polygon der äußere Ring und seine Löcher; Ringe
// ohne wiederholten Anfangspunkt. Ohne DOM und ohne Bibliothek: Das Umrechnen aus einem anderen
// Koordinatensystem gibt die Seite als Funktion herein (lib/crs.js).

/** Über so vielen Punkten wird ein Gebiet vereinfacht (Douglas-Peucker, VEREINFACHT_M Meter). */
export const MAX_PUNKTE = 2000;
export const VEREINFACHT_M = 2;

const GRAD_M_LAT = 110540;
const GRAD_M_LON = 111320;

/** Ring ohne doppelten Schluss und ohne aufeinanderfolgende gleiche Punkte. */
function saeubere(ring) {
  const out = [];
  for (const [x, y] of ring) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const l = out[out.length - 1];
    if (!l || l[0] !== x || l[1] !== y) out.push([x, y]);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/** Ist (x, y) im Ring? Strahlverfahren, Ring offen oder geschlossen, in jeder ebenen Koordinate. */
export function inRing(x, y, ring) {
  let innen = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) innen = !innen;
  }
  return innen;
}

/** Doppelte Fläche mit Vorzeichen: positiv gegen den Uhrzeigersinn (y nach oben). */
function vorzeichenFlaeche(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2;
}

/** Löcher dem kleinsten äußeren Ring zuordnen, in dem ihr erster Punkt liegt; ohne Platz fallen sie weg. */
function mitLoechern(aussen, loecher) {
  const polygone = aussen.map((ring) => ({ ring, a: Math.abs(vorzeichenFlaeche(ring)), loecher: [] }));
  for (const loch of loecher) {
    const [x, y] = loch[0];
    const drin = polygone.filter((p) => inRing(x, y, p.ring)).sort((u, v) => u.a - v.a)[0];
    if (drin) drin.loecher.push(loch);
  }
  return polygone.map((p) => [p.ring, ...p.loecher]);
}

/** Abstand eines Punkts von einer Strecke, alles in Metern. */
function abstand([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const ll = dx * dx + dy * dy;
  const t = ll > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / ll)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ein Ring nach Douglas-Peucker, in örtlichen Metern; höchstens so weit wie `toleranz` vom alten. */
function vereinfacheRing(ring, toleranz, kx) {
  if (ring.length <= 4) return ring;
  const m = ring.map(([lon, lat]) => [lon * GRAD_M_LON * kx, lat * GRAD_M_LAT]);
  m.push(m[0]);
  const behalten = new Uint8Array(m.length);
  behalten[0] = behalten[m.length - 1] = 1;
  const stapel = [[0, m.length - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop();
    let best = -1;
    let weit = toleranz;
    for (let i = a + 1; i < b; i++) {
      const d = abstand(m[i], m[a], m[b]);
      if (d > weit) [best, weit] = [i, d];
    }
    if (best >= 0) {
      behalten[best] = 1;
      stapel.push([a, best], [best, b]);
    }
  }
  const out = ring.filter((_, i) => behalten[i]);
  return out.length >= 3 ? out : ring;
}

/** Alle Punkte in Grad? Dann ist es schon WGS 84. */
export function siehtNachGradAus(polygone) {
  return polygone.every((p) => p.every((r) => r.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90)));
}

/** Jeden Punkt umrechnen, etwa nach WGS 84. */
export const umrechnen = (polygone, f) => polygone.map((p) => p.map((r) => r.map(([x, y]) => f(x, y))));

/**
 * Ein Gebiet aus Polygonen in WGS 84: { name, art (gezeichnet | datei), datei, polygone, bbox,
 * punkte, flaeche_km2, vereinfacht }. Leere Ringe und Polygone fallen weg; große Gebiete werden
 * vereinfacht (nicht mit `vereinfachen: false`, etwa aus einer Konfiguration), damit der Test je
 * Stelle schnell bleibt und das Gebiet in die Konfiguration passt. Die Punkte sind auf 6 Stellen
 * nach dem Komma gerundet (gut 0,1 m), so wie die Konfiguration sie schreibt: Ein wieder
 * eingelesenes Gebiet ist dasselbe.
 */
export function baueGebiet({ name = "Gebiet", art = "datei", datei = null, polygone, vereinfachen = true }) {
  let liste = (polygone ?? [])
    .map((p) => (Array.isArray(p) ? p.map((r) => saeubere(Array.isArray(r) ? r : [])) : []))
    .map(([aussen, ...loecher]) => (aussen && aussen.length >= 3 ? [aussen, ...loecher.filter((r) => r.length >= 3)] : null))
    .filter(Boolean);
  if (!liste.length) throw new Error("Darin ist keine Fläche.");
  if (!siehtNachGradAus(liste)) throw new Error("Die Koordinaten sind nicht in WGS 84.");
  const zaehle = (l) => l.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
  let vereinfacht = false;
  if (vereinfachen && zaehle(liste) > MAX_PUNKTE) {
    liste = liste.map((p) => {
      const kx = Math.cos((p[0][0][1] * Math.PI) / 180);
      return p.map((r) => vereinfacheRing(r, VEREINFACHT_M, kx));
    });
    vereinfacht = true;
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  liste = liste.map((p) => p.map((r) => saeubere(r.map(([x, y]) => [r6(x), r6(y)])))).filter(([a]) => a.length >= 3).map(([a, ...l]) => [a, ...l.filter((r) => r.length >= 3)]);
  if (!liste.length) throw new Error("Darin ist keine Fläche.");
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [aussen] of liste) {
    for (const [x, y] of aussen) {
      if (x < bbox[0]) bbox[0] = x;
      if (y < bbox[1]) bbox[1] = y;
      if (x > bbox[2]) bbox[2] = x;
      if (y > bbox[3]) bbox[3] = y;
    }
  }
  return { name: String(name || "Gebiet"), art, datei, polygone: liste, bbox, punkte: zaehle(liste), flaeche_km2: flaeche(liste), vereinfacht };
}

/** Liegt (lon, lat) im Gebiet? Ohne Gebiet immer. */
export function imGebiet(g, lon, lat) {
  if (!g) return true;
  const [w, s, o, n] = g.bbox;
  if (!(lon >= w && lon <= o && lat >= s && lat <= n)) return false;
  return g.polygone.some(([aussen, ...loecher]) => inRing(lon, lat, aussen) && !loecher.some((l) => inRing(lon, lat, l)));
}

/** Überschneiden sich das Gebiet und ein Rechteck [w, s, o, n]? (über die Rechtecke, grob) */
export const ueberschneidet = (g, [w, s, o, n]) => !g || (g.bbox[0] <= o && g.bbox[2] >= w && g.bbox[1] <= n && g.bbox[3] >= s);

/** Fläche in km², in örtlicher Näherung je Polygon. */
export function flaeche(polygone) {
  let summe = 0;
  for (const [aussen, ...loecher] of polygone) {
    const kx = Math.cos((aussen[0][1] * Math.PI) / 180);
    const m = (r) => Math.abs(vorzeichenFlaeche(r.map(([lon, lat]) => [lon * GRAD_M_LON * kx, lat * GRAD_M_LAT])));
    summe += m(aussen) - loecher.reduce((a, l) => a + m(l), 0);
  }
  return summe / 1e6;
}

/** Das Gebiet als GeoJSON-Feature (MultiPolygon, Ringe geschlossen, 6 Stellen nach dem Komma). */
export function gebietGeojson(g) {
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    type: "Feature",
    properties: { name: g.name, art: g.art, datei: g.datei ?? null },
    geometry: { type: "MultiPolygon", coordinates: g.polygone.map((p) => p.map((r) => [...r, r[0]].map(([x, y]) => [r6(x), r6(y)]))) },
  };
}

/** Polygone aus GeoJSON (FeatureCollection, Feature, Geometrie) -> { polygone, crs, name }; andere Geometrien fallen weg. */
export function leseGeojson(json) {
  if (!json || typeof json !== "object" || typeof json.type !== "string") throw new Error("Das ist kein GeoJSON.");
  const polygone = [];
  const punkte = (r) => (Array.isArray(r) ? r.filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))).map((p) => [Number(p[0]), Number(p[1])]) : []);
  const geom = (g) => {
    if (!g || typeof g !== "object") return;
    if (g.type === "Polygon" && Array.isArray(g.coordinates)) polygone.push(g.coordinates.map(punkte));
    else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) for (const p of g.coordinates) if (Array.isArray(p)) polygone.push(p.map(punkte));
    else if (g.type === "GeometryCollection") for (const x of g.geometries ?? []) geom(x);
  };
  if (json.type === "FeatureCollection") for (const f of json.features ?? []) geom(f?.geometry);
  else if (json.type === "Feature") geom(json.geometry);
  else geom(json);
  // ältere GeoJSON nennen ein anderes CRS so: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::25833" } }
  const crsName = json.crs?.properties?.name ?? null;
  const crs = crsName && !/CRS84|(^|\D)4326$/i.test(String(crsName)) ? String(crsName) : null;
  const name = json.name ?? json.properties?.name ?? null;
  return { polygone, crs, name: typeof name === "string" ? name : null };
}

/** Die .poly-Datei von osmium und Osmosis: Name, dann Abschnitte mit „Länge Breite“ je Zeile, „!“ vor einem Loch. */
export function lesePoly(text) {
  const zeilen = String(text ?? "").split(/\r?\n/).map((z) => z.trim());
  let i = 0;
  while (i < zeilen.length && !zeilen[i]) i++;
  const name = zeilen[i++] || "Gebiet";
  const aussen = [];
  const loecher = [];
  let abschnitte = 0;
  while (i < zeilen.length) {
    const kopf = zeilen[i++];
    if (!kopf) continue;
    if (kopf.toUpperCase() === "END") break;
    const ring = [];
    while (i < zeilen.length && zeilen[i].toUpperCase() !== "END") {
      const t = zeilen[i++].split(/\s+/).map(Number);
      if (t.length >= 2 && Number.isFinite(t[0]) && Number.isFinite(t[1])) ring.push([t[0], t[1]]);
    }
    if (i >= zeilen.length) throw new Error("In der .poly-Datei fehlt ein END.");
    i++;
    abschnitte++;
    const r = saeubere(ring);
    if (r.length >= 3) (kopf.startsWith("!") ? loecher : aussen).push(r);
  }
  if (!abschnitte) throw new Error("Das ist keine .poly-Datei.");
  return { name, polygone: mitLoechern(aussen, loecher) };
}

const SHP_TYPEN = { 1: "Punkte", 3: "Linien", 8: "Punktgruppen", 11: "Punkte", 13: "Linien", 18: "Punktgruppen", 21: "Punkte", 23: "Linien", 28: "Punktgruppen", 31: "Flächen aus Mehrfachpatches" };
const FLAECHEN = new Set([5, 15, 25]);

/**
 * Die Flächen eines Shapefiles (.shp; Polygon, PolygonZ, PolygonM) in seinen Koordinaten. Äußere
 * Ringe laufen dort im Uhrzeigersinn, Löcher dagegen; schreibt ein Programm alle andersherum, gelten
 * alle als äußere Ringe.
 */
export function leseShp(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error("Das ist keine Shapefile-Datei (.shp).");
  const typ = dv.getInt32(32, true);
  if (!FLAECHEN.has(typ) && typ !== 0) throw new Error(`Das Shapefile enthält ${SHP_TYPEN[typ] ?? `Formen vom Typ ${typ}`}, keine Flächen.`);
  const ende = Math.min(bytes.byteLength, dv.getInt32(24, false) * 2);
  const polygone = [];
  let p = 100;
  while (p + 12 <= ende) {
    const laenge = dv.getInt32(p + 4, false) * 2;
    const inhalt = p + 8;
    p = inhalt + laenge;
    if (laenge < 44 || p > bytes.byteLength) continue;
    if (!FLAECHEN.has(dv.getInt32(inhalt, true))) continue;
    const teile = dv.getInt32(inhalt + 36, true);
    const anzahl = dv.getInt32(inhalt + 40, true);
    const xy = inhalt + 44 + 4 * teile;
    if (teile < 1 || anzahl < 3 || xy + 16 * anzahl > p) continue;
    const start = Array.from({ length: teile }, (_, k) => dv.getInt32(inhalt + 44 + 4 * k, true));
    const ringe = start.map((von, k) => {
      const bis = k + 1 < teile ? start[k + 1] : anzahl;
      const ring = [];
      for (let i = von; i < bis; i++) ring.push([dv.getFloat64(xy + 16 * i, true), dv.getFloat64(xy + 16 * i + 8, true)]);
      return saeubere(ring);
    }).filter((r) => r.length >= 3);
    let aussen = ringe.filter((r) => vorzeichenFlaeche(r) < 0);
    let loecher = ringe.filter((r) => vorzeichenFlaeche(r) > 0);
    if (!aussen.length) [aussen, loecher] = [loecher, []];
    polygone.push(...mitLoechern(aussen, loecher));
  }
  return polygone;
}

/**
 * Das Koordinatensystem aus einer .prj-Datei: ein EPSG-Code, wo er sich erkennen lässt (die
 * Definitionen der Seite tragen die Datumsverschiebung, die ESRI-WKT oft fehlt), sonst die WKT.
 */
export function crsAusPrj(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  // die letzte AUTHORITY gehört zum ganzen System, wenn danach nur noch die schließende Klammer kommt
  const auth = [...t.matchAll(/AUTHORITY\["EPSG",\s*"?(\d+)"?\]/gi)].pop();
  if (auth && /^[^\]]*\]\s*\]\s*$/.test(t.slice(auth.index))) return `EPSG:${auth[1]}`;
  // WKT2 (PROJCRS[…, ID["EPSG",25833]])
  const id = /ID\["EPSG",\s*(\d+)\]\s*\]\s*$/i.exec(t);
  if (id) return `EPSG:${id[1]}`;
  const name = (/^(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS)\["([^"]+)"/i.exec(t)?.[1] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let m;
  if ((m = /^etrs_?(?:19)?89_utm_zone_(3[123])n$/.exec(name))) return `EPSG:258${m[1]}`;
  if ((m = /^wgs_?(?:19)?84_utm_zone_(3[123])n$/.exec(name))) return `EPSG:326${m[1]}`;
  if ((m = /^dhdn_3_degree_gauss(?:_kruger)?_zone_([2-5])$/.exec(name))) return `EPSG:${31464 + Number(m[1])}`;
  if (/^(?:gcs_)?(?:wgs_?(?:19)?84|etrs_?(?:19)?89)$/.test(name)) return "EPSG:4326";
  if (/laea/.test(name) && /etrs/.test(name)) return "EPSG:3035";
  if (/web_mercator|pseudo_mercator/.test(name)) return "EPSG:3857";
  return t;
}

/** Entpacken, so wie der Browser es kann (Node hat dieselben Klassen). */
async function entpacke(roh) {
  const strom = new Blob([roh]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(strom).arrayBuffer());
}

/**
 * Die Dateien einer ZIP-Datei -> Map(Name -> Bytes), nur die, für die `passt(name)` gilt; ohne
 * ZIP64, ohne Verschlüsselung. Ordner und die Ressourcen von macOS (__MACOSX, „._…“) fallen weg.
 */
export async function leseZip(bytes, passt = () => true) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Das ist keine ZIP-Datei.");
  const anzahl = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const text = new TextDecoder();
  const dateien = new Map();
  for (let k = 0; k < anzahl; k++) {
    if (p + 46 > bytes.byteLength || dv.getUint32(p, true) !== 0x02014b50) throw new Error("Das Verzeichnis der ZIP-Datei ist beschädigt.");
    const flags = dv.getUint16(p + 8, true);
    const methode = dv.getUint16(p + 10, true);
    const groesse = dv.getUint32(p + 20, true);
    const nLen = dv.getUint16(p + 28, true);
    const name = text.decode(bytes.subarray(p + 46, p + 46 + nLen));
    const lokal = dv.getUint32(p + 42, true);
    p += 46 + nLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    const basis = name.split("/").pop();
    if (!basis || name.includes("__MACOSX/") || basis.startsWith("._") || !passt(name)) continue;
    if (flags & 1) throw new Error(`${basis} ist verschlüsselt.`);
    const start = lokal + 30 + dv.getUint16(lokal + 26, true) + dv.getUint16(lokal + 28, true);
    const roh = bytes.subarray(start, start + groesse);
    if (methode === 0) dateien.set(name, roh);
    else if (methode === 8) dateien.set(name, await entpacke(roh));
    else throw new Error(`${basis}: Diese Art der Kompression (${methode}) kennt die Seite nicht.`);
  }
  return dateien;
}

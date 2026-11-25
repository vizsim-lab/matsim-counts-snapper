// Worker: liest das Netz, hält es im Speicher und sucht für Zählstellen die passenden Links.
// Ein Netz ist ein MATSim-Netz (network.xml) oder ein OSM-Auszug (.osm.pbf, lib/osm.js), dessen
// Wege als gerichtete Kanten wie Links gelten. Die Seite bekommt das Netz als GeoJSON in WGS84 für
// die Karte, Kandidaten mit ihrer Geometrie, auf Nachfrage einzelne Links und die Übernahme einer
// Zuordnung von einem anderen Netz (lib/uebertrag.js).
import { leseNetz, leseLinkGeometrien, istPtLink } from "./lib/netz.js";
import { istPbf, leseOsm } from "./lib/osm.js";
import { projektion, lageMit, randpunkte, KANDIDATEN } from "./lib/crs.js";
import { LinkIndex, kandidaten, modiVon, naechsterPunkt, VORGABE } from "./lib/zuordnung.js";
import { siehtNachSumoAus, uebertrage, wegeVonLink } from "./lib/uebertrag.js";
import { winkelAbstand } from "./lib/richtung.js";
import { tx, setzeSprache, zahl } from "./lib/sprache.js";

const status = (text) => postMessage({ type: "status", text });
const de = (n) => zahl(n);

let netz = null; // { links, proj, metrisch (Links in Metern), index, ids (Link-ID -> Index), name }

/** Für ein Netz in Grad: Meter um die Mitte, genähert (gleichabständig). */
function meterUm(lon0, lat0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return {
    hin: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    zurueck: (x, y) => [x / kx + lon0, y / ky + lat0],
  };
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** Die Polylinie eines Links in WGS84 als [[lon, lat], …]. */
function wgs(link) {
  const out = [];
  const xy = link.xy;
  for (let k = 0; k + 1 < xy.length; k += 2) {
    const [lon, lat] = netz.proj.zuWgs(xy[k], xy[k + 1]);
    out.push([r6(lon), r6(lat)]);
  }
  return out;
}

/** Was die Seite von einem Link zeigt. */
function steckbrief(i) {
  const l = netz.links[i];
  return {
    i,
    id: l.id,
    from: l.from,
    to: l.to,
    modes: l.modes,
    type: l.type,
    name: l.name,
    kmh: Number.isFinite(l.freespeed) ? Math.round(l.freespeed * 36) / 10 : null,
    capacity: Number.isFinite(l.capacity) ? l.capacity : null,
    permlanes: Number.isFinite(l.permlanes) ? l.permlanes : null,
    length: Number.isFinite(l.length) ? l.length : null,
    weg: l.weg ?? null,
    osm: Boolean(l.osm),
    geom: wgs(l),
  };
}

/** Index eines Links nach seiner ID, über eine Tabelle, die beim ersten Mal entsteht. */
function indexVon(id) {
  netz.ids ??= new Map(netz.links.map((l, i) => [l.id, i]));
  return netz.ids.get(id);
}

/** Lage und Richtung einer Stelle in Metern, wie der Index rechnet. */
function inMetern(lon, lat) {
  const [x, y] = netz.proj.vonWgs(lon, lat);
  return netz.meter ? netz.meter.hin(x, y) : [x, y];
}

/** Abstand, Richtung und Abweichung eines Links zu einer Stelle { lon, lat, grad }. */
function bezug(i, s) {
  const [mx, my] = inMetern(s.lon, s.lat);
  const n = naechsterPunkt(mx, my, netz.metrisch[i].xy);
  return { d: n.d, grad: n.grad, anteil: n.anteil, abweichung: s.grad != null && n.grad != null ? winkelAbstand(s.grad, n.grad) : null };
}

/** Das Netz als GeoJSON in WGS84, ohne pt-Links, in Stücken kodiert; dazu seine Ausdehnung in WGS84 und in seinen eigenen Koordinaten. */
function anzeige(links, proj) {
  const enc = new TextEncoder();
  const stuecke = [enc.encode('{"type":"FeatureCollection","features":[')];
  let teile = [];
  let laenge = 0;
  let erstes = true;
  let n = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const xy = [Infinity, Infinity, -Infinity, -Infinity];
  const flush = () => {
    if (!teile.length) return;
    stuecke.push(enc.encode((erstes ? "" : ",") + teile.join(",")));
    erstes = false;
    teile = [];
    laenge = 0;
  };
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (istPtLink(l.modes)) continue;
    const coords = [];
    for (let k = 0; k + 1 < l.xy.length; k += 2) {
      const x = l.xy[k];
      const y = l.xy[k + 1];
      if (x < xy[0]) xy[0] = x;
      if (y < xy[1]) xy[1] = y;
      if (x > xy[2]) xy[2] = x;
      if (y > xy[3]) xy[3] = y;
      const [lon, lat] = proj.zuWgs(x, y);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (lon < bbox[0]) bbox[0] = lon;
      if (lat < bbox[1]) bbox[1] = lat;
      if (lon > bbox[2]) bbox[2] = lon;
      if (lat > bbox[3]) bbox[3] = lat;
      coords.push(`[${r6(lon)},${r6(lat)}]`);
    }
    if (coords.length < 2) continue;
    // nur, was die Karte zum Zeichnen braucht; alles andere fragt die Seite beim Worker nach
    const car = modiVon(l).includes("car") ? 1 : 0;
    const cap = Number.isFinite(l.capacity) ? Math.round(l.capacity) : 0;
    const f = `{"type":"Feature","properties":{"i":${i},"car":${car},"cap":${cap}},"geometry":{"type":"LineString","coordinates":[${coords.join(",")}]}}`;
    teile.push(f);
    laenge += f.length;
    n++;
    if (laenge > 1 << 22) flush();
    if (n % 50000 === 0) status(tx(`Karte vorbereiten: ${de(n)} Links …`, `Preparing the map: ${de(n)} links …`));
  }
  flush();
  stuecke.push(enc.encode("]}"));
  const gesamt = stuecke.reduce((s, c) => s + c.length, 0);
  const bytes = new Uint8Array(gesamt);
  let at = 0;
  for (const c of stuecke) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, features: n, bbox: Number.isFinite(bbox[0]) ? bbox : null, xy: xy.every(Number.isFinite) ? xy : null };
}

async function ladeNetz(job) {
  const t0 = performance.now();
  let geometries = null;
  let geoInfo = null;
  if (job.geoBytes) {
    status(tx("Link-Geometrien lesen …", "Reading link geometries …"));
    const g = await leseLinkGeometrien(job.geoBytes, status);
    geometries = g.map;
    geoInfo = { rows: g.rows, invalid: g.invalid };
  }
  const osm = istPbf(job.bytes);
  let r;
  if (osm) {
    status(tx("OSM-Auszug lesen …", "Reading OSM extract …"));
    r = await leseOsm(job.bytes, { filter: job.osmFilter, status });
  } else {
    status(tx("MATSim-Netz lesen …", "Reading MATSim network …"));
    r = await leseNetz(job.bytes, geometries, status);
    // OSM-Wege der Links, wenn das Netz sie verrät: für die Übernahme einer Zuordnung aus OSM
    const sumo = siehtNachSumoAus(r.links);
    let mitWeg = 0;
    for (const l of r.links) {
      const w = wegeVonLink(l, sumo);
      l.weg = w.weg;
      l.wege = w.wege;
      if (w.wege.length) mitWeg++;
    }
    r.wegeInfo = { sumo, links: mitWeg };
  }
  // „Atlantis“ ist die Vorgabe von MATSims global.coordinateSystem: Ein Netz trägt es, wenn beim
  // Schreiben kein Koordinatensystem gesetzt war. Es ist keins; dann gilt das aus dem Formular.
  const platzhalter = r.crs && /^atlantis$/i.test(r.crs.trim()) ? r.crs.trim() : null;
  const crsDatei = platzhalter ? null : r.crs;
  const crsName = osm ? "EPSG:4326" : crsDatei ?? job.crs;
  let proj;
  try {
    proj = projektion(crsName);
  } catch (err) {
    throw new Error(`${crsDatei ? tx("Das CRS des Netzes", "The network's CRS") : tx("Das Koordinatensystem aus dem Formular", "The coordinate system from the form")}: ${err.message}`);
  }
  status(tx("Karte vorbereiten …", "Preparing the map …"));
  const karte = anzeige(r.links, proj);
  // Ohne eigenes CRS: wo das Netz mit dem aus dem Formular und mit den üblichen anderen läge. Die
  // Seite zählt die Zählstellen darin und schlägt ein anderes vor, wenn mit diesem keine im Netz liegt.
  let crsProbe = null;
  if (!osm && !crsDatei && karte.xy) {
    // die äußersten Punkte wie auf der Karte (ohne pt-Links): umgerechnet fast genau die Ausdehnung
    const rand = randpunkte(r.links.filter((l) => !istPtLink(l.modes)).map((l) => l.xy), karte.xy);
    crsProbe = {
      imLand: Boolean(lageMit(rand, proj)?.imLand),
      andere: KANDIDATEN.filter((code) => code !== proj.code).flatMap((code) => {
        const lage = lageMit(rand, code);
        return lage?.imLand ? [{ code, bbox: lage.bbox }] : [];
      }),
    };
  }
  let metrisch = r.links;
  let meter = null;
  if (proj.geographisch && karte.bbox) {
    meter = meterUm((karte.bbox[0] + karte.bbox[2]) / 2, (karte.bbox[1] + karte.bbox[3]) / 2);
    metrisch = r.links.map((l) => {
      const xy = new Float64Array(l.xy.length);
      for (let k = 0; k + 1 < l.xy.length; k += 2) [xy[k], xy[k + 1]] = meter.hin(l.xy[k], l.xy[k + 1]);
      return { ...l, xy };
    });
  }
  netz = { links: r.links, metrisch, meter, proj, index: null, ids: null, name: job.name };
  const modi = {};
  for (const l of r.links) for (const m of modiVon(l)) modi[m] = (modi[m] ?? 0) + 1;
  postMessage(
    {
      type: "netz",
      token: job.token,
      info: {
        links: r.links.length,
        nodes: r.nodes,
        crs: proj.code,
        crsName: proj.name,
        crsAusDatei: Boolean(crsDatei),
        crsPlatzhalter: platzhalter,
        crsProbe,
        osm: r.osm ?? null,
        wege: r.wegeInfo ?? null,
        stats: r.stats,
        geometrien: geoInfo,
        modi,
        bbox: karte.bbox,
        features: karte.features,
        ms: Math.round(performance.now() - t0),
      },
      geojson: karte.bytes,
    },
    [karte.bytes.buffer],
  );
}

/** Das Raster über die Links; eine Zelle ist so groß wie der Umkreis, mindestens 50 m. */
function raster(radius) {
  if (!netz.index || netz.index.zelle !== Math.max(50, radius)) {
    status(tx("Links in ein Raster legen …", "Putting the links into a grid …"));
    netz.index = new LinkIndex(netz.metrisch, Math.max(50, radius));
  }
  return netz.index;
}

function suche(job) {
  if (!netz) throw new Error(tx("Es ist noch kein Netz geladen.", "No network loaded yet."));
  const p = { ...VORGABE, ...job.params };
  raster(p.radius);
  status(tx("Links zu den Zählstellen suchen …", "Searching links for the count sites …"));
  const ergebnisse = job.stellen.map((s) => {
    const [x, y] = netz.proj.vonWgs(s.lon, s.lat);
    const [mx, my] = netz.meter ? netz.meter.hin(x, y) : [x, y];
    const umkreis = { links: 0, modus: 0 };
    const liste = Number.isFinite(mx) && Number.isFinite(my)
      ? kandidaten(netz.index, { x: mx, y: my, grad: s.grad, name: s.name, modi: s.modi, radius: s.radius ?? undefined, rueckfall: s.rueckfall }, p, umkreis)
      : [];
    // x/y (für die counts.xml): die Lage der Stelle selbst, auch wenn die Suche vom Anker einer
    // übernommenen Zuordnung ausgeht – sonst änderte eine wieder eingelesene Zuordnung die Koordinaten
    const [sx, sy] = s.ort ? netz.proj.vonWgs(s.ort.lon, s.ort.lat) : [x, y];
    return {
      id: s.id,
      x: sx,
      y: sy,
      umkreis,
      kandidaten: liste.map((k) => ({ ...steckbrief(k.i), d: k.d, abweichung: k.abweichung, grad: k.grad, anteil: k.anteil, namePasst: k.name, score: k.score, weit: Boolean(k.weit) })),
    };
  });
  postMessage({ type: "suche", token: job.token, ergebnisse });
}

/** Ein Link für die Seite, mit Abstand und Richtung zu einer Stelle, wenn sie dabei ist. */
function link(job) {
  if (!netz) return;
  const i = job.i ?? indexVon(job.id);
  if (!(i >= 0 && i < netz.links.length)) {
    postMessage({ type: "link", token: job.token, link: null, id: job.id });
    return;
  }
  const out = steckbrief(i);
  if (job.stelle) Object.assign(out, bezug(i, job.stelle));
  postMessage({ type: "link", token: job.token, link: out });
}

/**
 * Zuordnungen von einem anderen Netz übernehmen: je Anker { id, lon, lat, grad, linkId, weg, modi,
 * stelle } der Link, der eindeutig passt, sonst der Grund (lib/uebertrag.js).
 */
function uebernimm(job) {
  if (!netz) throw new Error(tx("Es ist noch kein Netz geladen.", "No network loaded yet."));
  const index = raster(VORGABE.radius);
  netz.ids ??= new Map(netz.links.map((l, i) => [l.id, i]));
  status(tx(`${de(job.anker.length)} Zuordnungen übernehmen …`, `Transferring ${de(job.anker.length)} assignments …`));
  const ergebnisse = job.anker.map((a) => {
    const [x, y] = inMetern(a.lon, a.lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { id: a.id, link: null, wie: null, grund: tx("der Anker liegt außerhalb des Koordinatensystems", "the anchor lies outside the coordinate system") };
    const r = uebertrage(index, { x, y, grad: a.grad, linkId: a.linkId, weg: a.weg, modi: a.modi }, undefined, netz.ids);
    if (r.i == null) return { id: a.id, link: null, wie: null, grund: r.grund };
    return { id: a.id, wie: r.wie, link: { ...steckbrief(r.i), ...bezug(r.i, a.stelle) }, ankerAbstand: r.d };
  });
  postMessage({ type: "uebertrage", token: job.token, ergebnisse });
}

onmessage = async (e) => {
  const job = e.data;
  // die Sprache der Seite für Fortschritt und Meldungen dieses Auftrags
  setzeSprache(job.sprache);
  try {
    if (job.type === "netz") await ladeNetz(job);
    else if (job.type === "suche") suche(job);
    else if (job.type === "link") link(job);
    else if (job.type === "uebertrage") uebernimm(job);
  } catch (err) {
    postMessage({ type: "error", job: job.type, token: job.token, message: err?.message ?? String(err) });
  }
};

// Worker: liest das Netz, hält es im Speicher und sucht für Zählstellen die passenden Links.
// Die Seite bekommt das Netz als GeoJSON in WGS84 für die Karte, Kandidaten mit ihrer Geometrie
// und auf Nachfrage einzelne Links.
import { leseNetz, leseLinkGeometrien, istPtLink } from "./lib/netz.js";
import { projektion } from "./lib/crs.js";
import { LinkIndex, kandidaten, modiVon, naechsterPunkt, VORGABE } from "./lib/zuordnung.js";
import { winkelAbstand } from "./lib/richtung.js";

const status = (text) => postMessage({ type: "status", text });
const de = (n) => n.toLocaleString("de-DE");

let netz = null; // { links, proj, metrisch (Links in Metern), index, name }

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
    geom: wgs(l),
  };
}

/** Das Netz als GeoJSON in WGS84, ohne pt-Links, in Stücken kodiert; dazu seine Ausdehnung. */
function anzeige(links, proj) {
  const enc = new TextEncoder();
  const stuecke = [enc.encode('{"type":"FeatureCollection","features":[')];
  let teile = [];
  let laenge = 0;
  let erstes = true;
  let n = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
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
      const [lon, lat] = proj.zuWgs(l.xy[k], l.xy[k + 1]);
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
    if (n % 50000 === 0) status(`Karte vorbereiten: ${de(n)} Links …`);
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
  return { bytes, features: n, bbox: Number.isFinite(bbox[0]) ? bbox : null };
}

async function ladeNetz(job) {
  const t0 = performance.now();
  let geometries = null;
  let geoInfo = null;
  if (job.geoBytes) {
    status("Link-Geometrien lesen …");
    const g = await leseLinkGeometrien(job.geoBytes, status);
    geometries = g.map;
    geoInfo = { rows: g.rows, invalid: g.invalid };
  }
  status("MATSim-Netz lesen …");
  const r = await leseNetz(job.bytes, geometries, status);
  const crsName = r.crs ?? job.crs;
  let proj;
  try {
    proj = projektion(crsName);
  } catch (err) {
    throw new Error(`${r.crs ? "Das CRS des Netzes" : "Das Koordinatensystem aus dem Formular"}: ${err.message}`);
  }
  status("Karte vorbereiten …");
  const karte = anzeige(r.links, proj);
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
  netz = { links: r.links, metrisch, meter, proj, index: null, name: job.name };
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
        crsAusDatei: Boolean(r.crs),
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

function suche(job) {
  if (!netz) throw new Error("Es ist noch kein Netz geladen.");
  const p = { ...VORGABE, ...job.params };
  if (!netz.index || netz.index.zelle !== Math.max(50, p.radius)) {
    status("Links in ein Raster legen …");
    netz.index = new LinkIndex(netz.metrisch, Math.max(50, p.radius));
  }
  status("Links zu den Zählstellen suchen …");
  const ergebnisse = job.stellen.map((s) => {
    const [x, y] = netz.proj.vonWgs(s.lon, s.lat);
    const [mx, my] = netz.meter ? netz.meter.hin(x, y) : [x, y];
    const umkreis = { links: 0, modus: 0 };
    const liste = Number.isFinite(mx) && Number.isFinite(my)
      ? kandidaten(netz.index, { x: mx, y: my, grad: s.grad, name: s.name, modi: s.modi }, p, umkreis)
      : [];
    return {
      id: s.id,
      x,
      y,
      umkreis,
      kandidaten: liste.map((k) => ({ ...steckbrief(k.i), d: k.d, abweichung: k.abweichung, grad: k.grad, anteil: k.anteil, namePasst: k.name, score: k.score })),
    };
  });
  postMessage({ type: "suche", token: job.token, ergebnisse });
}

/** Ein Link für die Seite, mit Abstand und Richtung zu einer Stelle, wenn sie dabei ist. */
function link(job) {
  if (!netz) return;
  const i = job.i ?? netz.links.findIndex((l) => l.id === job.id);
  if (!(i >= 0 && i < netz.links.length)) {
    postMessage({ type: "link", token: job.token, link: null, id: job.id });
    return;
  }
  const out = steckbrief(i);
  if (job.stelle) {
    const s = job.stelle;
    const [x, y] = netz.proj.vonWgs(s.lon, s.lat);
    const [mx, my] = netz.meter ? netz.meter.hin(x, y) : [x, y];
    const n = naechsterPunkt(mx, my, netz.metrisch[i].xy);
    Object.assign(out, { d: n.d, grad: n.grad, anteil: n.anteil, abweichung: s.grad != null && n.grad != null ? winkelAbstand(s.grad, n.grad) : null });
  }
  postMessage({ type: "link", token: job.token, link: out });
}

onmessage = async (e) => {
  const job = e.data;
  try {
    if (job.type === "netz") await ladeNetz(job);
    else if (job.type === "suche") suche(job);
    else if (job.type === "link") link(job);
  } catch (err) {
    postMessage({ type: "error", job: job.type, token: job.token, message: err?.message ?? String(err) });
  }
};

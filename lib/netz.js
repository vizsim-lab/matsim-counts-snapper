// Ein MATSim-Netz lesen: network.xml (v1 oder v2, auch .gz) mit den Link-Geometrien aus der
// CSV des SUMO-Konverters oder dem Attribut origgeom. Übernommen aus kachelwerk (worker.js,
// github.com/vizsim-lab/kachelwerk), hier mit Links als Polylinien im CRS des Netzes statt GeoJSON.

/** Der Text einer Datei, normal oder gzip, in Stücken, wie sie ankommen. */
function textReader(bytes) {
  let stream = new Blob([bytes]).stream();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  return stream.pipeThrough(new TextDecoderStream()).getReader();
}

/** Ihre Zeilen, ein Bündel je Stück. */
async function* lineBatches(bytes) {
  const reader = textReader(bytes);
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = rest + value;
    const cut = text.lastIndexOf("\n");
    if (cut < 0) {
      rest = text;
      continue;
    }
    yield text.slice(0, cut).split("\n");
    rest = text.slice(cut + 1);
  }
  if (rest) yield [rest];
}

/** Ein CSV-Satz in Felder; Anführungszeichen dürfen das Trennzeichen enthalten, "" ist ein Anführungszeichen. */
function csvFields(line, delim) {
  const out = [];
  let i = 0;
  for (;;) {
    if (line[i] === '"') {
      let value = "";
      let j = i + 1;
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) { value += line.slice(j); j = line.length; break; }
        if (line[q + 1] === '"') { value += line.slice(j, q + 1); j = q + 2; continue; }
        value += line.slice(j, q);
        j = q + 1;
        break;
      }
      out.push(value);
      const d = line.indexOf(delim, j);
      if (d < 0) return out;
      i = d + 1;
    } else {
      const d = line.indexOf(delim, i);
      if (d < 0) { out.push(line.slice(i)); return out; }
      out.push(line.slice(i, d));
      i = d + 1;
    }
  }
}

/** Punkte einer Geometrie-Zelle als [x0, y0, x1, y1, …]: „(x,y),(x,y)“ vom SUMO-Konverter, WKT oder „x y, x y“. */
function parseGeometry(raw) {
  let t = raw.trim();
  const wkt = /^LINESTRING\s*Z?\s*\((.*)\)$/is.exec(t);
  if (wkt) t = wkt[1];
  const out = [];
  if (!wkt && t.includes("(")) {
    for (const group of t.split("(").slice(1)) {
      const [x, y, extra] = group.split(")")[0].split(",");
      if (extra !== undefined) continue;
      const px = Number(x);
      const py = Number(y);
      if (Number.isFinite(px) && Number.isFinite(py) && x.trim() && y?.trim()) out.push(px, py);
    }
    return out;
  }
  for (const token of t.split(",")) {
    const [x, y] = token.trim().split(/\s+/);
    const px = Number(x);
    const py = Number(y);
    if (x && y && Number.isFinite(px) && Number.isFinite(py)) out.push(px, py);
  }
  return out;
}

/** Eine Datei mit Link-Geometrien (LinkId,Geometry) als Map von der Link-ID zu ihren Punkten. */
export async function leseLinkGeometrien(bytes, status = () => {}) {
  const map = new Map();
  let delim = null;
  let idCol = 0;
  let geomCol = 1;
  let rows = 0;
  let invalid = 0;
  let record = "";
  for await (const batch of lineBatches(bytes)) {
    for (let line of batch) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      // eine Zelle in Anführungszeichen kann über Zeilen gehen
      record = record ? `${record}\n${line}` : line;
      if ((record.split('"').length - 1) % 2 === 1) continue;
      const text = record;
      record = "";
      if (!text) continue;
      if (delim === null) {
        delim = [",", ";", "\t"].reduce((best, d) => (text.split(d).length > text.split(best).length ? d : best), ",");
        const head = csvFields(text, delim).map((h) => h.trim().toLowerCase());
        const g = head.findIndex((h) => /geom|wkt|shape|coord/.test(h));
        const i = head.findIndex((h) => /^(link_?id|id|link)$/.test(h));
        if (g >= 0) {
          geomCol = g;
          idCol = i >= 0 ? i : g === 0 ? 1 : 0;
          continue;
        }
        // ohne Kopfzeile ist schon die erste Zeile ein Datensatz
      }
      const f = csvFields(text, delim);
      const id = f[idCol]?.trim();
      const points = f.length > geomCol ? parseGeometry(f[geomCol]) : [];
      if (!id || points.length < 4) {
        invalid++;
        continue;
      }
      rows++;
      map.set(id, Float64Array.from(points));
    }
    status(`Link-Geometrien lesen: ${rows.toLocaleString("de-DE")} Zeilen …`);
  }
  if (map.size === 0) {
    throw new Error("Die Geometrie-Datei enthält keine lesbaren Geometrien. Erwartet wird eine CSV mit LinkId und Geometry, z. B. „(x,y),(x,y)“.");
  }
  return { map, rows, invalid };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.includes("&")
    ? s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
        e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m)
    : s;

// ein pt-Link hat nur Verkehrsmittel des ÖV; eine Straße, die auch Busse nutzen („car,pt“), ist keiner
const PT_MODES = new Set(["pt", "bus", "tram", "rail", "train", "subway", "metro", "ferry", "funicular", "gondola", "cablecar", "cable_car", "monorail", "artificial"]);
export const istPtLink = (modes) => {
  const list = modes.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 && list.every((m) => PT_MODES.has(m));
};

// ---------- Geometrie eines Links, wie in matsim_trace ----------
const SAME_POINT_M = 1e-3; // die CSV rundet auf 1e-6 m, das Netz hat volle Genauigkeit
const same = (ax, ay, bx, by) => Math.abs(ax - bx) <= SAME_POINT_M && Math.abs(ay - by) <= SAME_POINT_M;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Die Punkte zwischen den Knoten: CSV-Punkte ohne Wiederholungen und ohne Enden, die auf einem Knoten liegen. */
function innerPoints(points, fx, fy, tx, ty) {
  const shape = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const n = shape.length;
    if (n && same(shape[n - 2], shape[n - 1], points[i], points[i + 1])) continue;
    shape.push(points[i], points[i + 1]);
  }
  const onNode = (x, y) => same(x, y, fx, fy) || same(x, y, tx, ty);
  if (shape.length && onNode(shape[0], shape[1])) shape.splice(0, 2);
  if (shape.length && onNode(shape[shape.length - 2], shape[shape.length - 1])) shape.splice(-2, 2);
  return shape;
}

/** origgeom: „nodeId,x,y nodeId,x,y …“, die OSM-Knoten, die beim Vereinfachen wegfielen, ohne die Knoten des Links. */
function origGeomPoints(raw) {
  const out = [];
  for (const token of raw.trim().split(/\s+/)) {
    const parts = token.split(",");
    if (parts.length !== 3) continue;
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (parts[1] && parts[2] && Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  return out;
}

/** Der Link als Polylinie: Von-Knoten, die inneren Punkte (umgedreht, wenn sie gegen den Link laufen), Nach-Knoten. */
function polylinie(fx, fy, tx, ty, shape) {
  const out = [fx, fy];
  const n = shape.length;
  if (n) {
    // MATSims OsmBicycleReader kopiert origgeom unverändert auf die *_bike-reverse-Links
    const reversed = dist(shape[0], shape[1], tx, ty) + dist(shape[n - 2], shape[n - 1], fx, fy) <
      dist(shape[0], shape[1], fx, fy) + dist(shape[n - 2], shape[n - 1], tx, ty);
    if (reversed) for (let i = n - 2; i >= 0; i -= 2) out.push(shape[i], shape[i + 1]);
    else for (let i = 0; i < n; i += 2) out.push(shape[i], shape[i + 1]);
  }
  out.push(tx, ty);
  return Float64Array.from(out);
}

const NUMERIC_CLASS = /^java\.lang\.(Double|Float|Integer|Long|Short)$/;

function attributeValue(cls, raw) {
  const text = unescapeXml(raw).trim();
  if (cls && NUMERIC_CLASS.test(cls)) {
    const n = Number(text);
    return text && text.toLowerCase() !== "nan" && Number.isFinite(n) ? n : undefined;
  }
  if (cls === "java.lang.Boolean") return text === "true";
  return text || undefined;
}

// Attribute der Links, die die Zuordnung zeigt oder nutzt; die übrigen bleiben im Netz
const BEHALTEN = new Set(["type", "name", "osm:way:name", "osm:way:highway", "allowed_speed", "origgeom"]);

/**
 * Ein MATSim-Netz -> { links: [{ id, from, to, modes, type, name, freespeed, capacity, permlanes,
 * length, xy (Float64Array, CRS des Netzes) }], nodes, crs, stats }.
 */
export async function leseNetz(bytes, geometries, status = () => {}) {
  const reader = textReader(bytes);
  const tagRe = /<(\/?)(node|link|attribute)\b([^>]*)>/g;
  const attrRe = /([\w:.-]+)="([^"]*)"/g;
  const crsRe = /<attribute\s+name="coordinateReferenceSystem"[^>]*>\s*([^<\s]+)\s*<\/attribute>/;
  const parseAttrs = (s) => {
    const a = {};
    attrRe.lastIndex = 0;
    let m;
    while ((m = attrRe.exec(s))) a[m[1]] = m[2];
    return a;
  };
  const nodes = new Map();
  const links = [];
  const stats = { missing: 0, withGeometry: 0, fromCsv: 0, fromOrigGeom: 0, csvMatched: 0, ptLinks: 0, named: 0 };
  let rest = "";
  let head = "";
  let crs = null;
  let link = null; // das offene <link>, bis </link>
  let attr = null; // das offene <attribute> dieses Links: { name, cls, text }

  function finishLink(l) {
    const id = unescapeXml(l.a.id ?? "");
    const fromId = unescapeXml(l.a.from ?? "");
    const toId = unescapeXml(l.a.to ?? "");
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) {
      stats.missing++;
      return;
    }
    const extra = l.extra;
    const modes = unescapeXml(l.a.modes ?? "");
    if (istPtLink(modes)) stats.ptLinks++;
    const type = l.a.type !== undefined ? unescapeXml(l.a.type) : extra.type ?? extra["osm:way:highway"];
    const name = extra.name ?? extra["osm:way:name"];
    if (name) stats.named++;

    // Geometrie: die CSV geht vor origgeom, wie in matsim_trace
    let shape = [];
    const csv = geometries?.get(id);
    if (csv) {
      stats.csvMatched++;
      shape = innerPoints(csv, from[0], from[1], to[0], to[1]);
      if (shape.length) stats.fromCsv++;
    }
    if (!shape.length && typeof extra.origgeom === "string") {
      shape = origGeomPoints(extra.origgeom);
      if (shape.length) stats.fromOrigGeom++;
    }
    if (shape.length) stats.withGeometry++;

    links.push({
      id,
      from: fromId,
      to: toId,
      modes,
      type: type !== undefined ? String(type) : null,
      name: name !== undefined ? String(name) : null,
      freespeed: Number(l.a.freespeed),
      capacity: Number(l.a.capacity),
      permlanes: Number(l.a.permlanes),
      length: Number(l.a.length),
      allowedSpeed: typeof extra.allowed_speed === "number" ? extra.allowed_speed : null,
      xy: polylinie(from[0], from[1], to[0], to[1], shape),
    });
    if (links.length % 50000 === 0) status(`MATSim-Netz lesen: ${links.length.toLocaleString("de-DE")} Links …`);
  }

  for (;;) {
    const { value, done } = await reader.read();
    const text = rest + (value ?? "");
    let cut = done ? text.length : text.lastIndexOf(">") + 1;
    // ein Kommentar, der am Schnitt noch offen ist, wartet auf das nächste Stück
    const open = text.lastIndexOf("<!--", cut);
    const close = open < 0 ? -1 : text.indexOf("-->", open);
    if (!done && open >= 0 && (close < 0 || close + 3 > cut)) cut = open;
    // auskommentierte Knoten und Links gehören nicht zum Netz
    const chunk = text.slice(0, cut).replace(/<!--[\s\S]*?-->/g, "");
    rest = text.slice(cut);
    if (crs === null && head.length < 1 << 20) {
      head += chunk;
      const m = crsRe.exec(head);
      if (m) crs = m[1];
    }
    tagRe.lastIndex = 0;
    let at = 0;
    let m;
    while ((m = tagRe.exec(chunk))) {
      if (attr) attr.text += chunk.slice(at, m.index);
      at = m.index + m[0].length;
      const [, closing, tag, body] = m;
      const selfClosing = body.endsWith("/");
      if (tag === "node") {
        if (closing || link) continue;
        const a = parseAttrs(body);
        const x = Number(a.x);
        const y = Number(a.y);
        if (Number.isFinite(x) && Number.isFinite(y)) nodes.set(unescapeXml(a.id), [x, y]);
      } else if (tag === "link") {
        if (closing) {
          if (link) finishLink(link);
          link = null;
          attr = null;
        } else {
          const l = { a: parseAttrs(body), extra: {} };
          if (selfClosing) finishLink(l);
          else link = l;
        }
      } else if (link) {
        // <attribute> des offenen Links; die der Knoten und des Netzes braucht es nicht
        if (closing) {
          if (attr) {
            const v = attributeValue(attr.cls, attr.text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
            if (v !== undefined) link.extra[attr.name] = v;
          }
          attr = null;
        } else {
          const a = parseAttrs(body);
          if (!a.name) continue;
          const name = unescapeXml(a.name).toLowerCase();
          if (!BEHALTEN.has(name)) continue;
          if (selfClosing) {
            const v = attributeValue(a.class, a.value ?? "");
            if (v !== undefined) link.extra[name] = v;
          } else {
            attr = { name, cls: a.class, text: "" };
          }
        }
      }
    }
    if (attr) attr.text += chunk.slice(at);
    if (done) break;
  }
  if (links.length === 0) {
    throw new Error("In der Datei stehen keine <link>-Elemente. Ist es ein MATSim-Netz (network.xml)?");
  }
  return { links, nodes: nodes.size, crs, stats };
}

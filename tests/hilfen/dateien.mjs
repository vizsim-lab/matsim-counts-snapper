// Dateien für die Tests des Gebiets: ein Shapefile (.shp) und eine ZIP-Datei, von Hand gebaut.
import { deflateRawSync } from "node:zlib";

/** Ein Shapefile aus Datensätzen: je Datensatz eine Liste von Ringen; Typ 5 Polygon, 15 PolygonZ, 0 leer. */
export function shp(datensaetze, typ = 5) {
  const teile = datensaetze.map(({ typ: t = typ, ringe = [] }) => {
    if (t === 0) return new Uint8Array(new Int32Array([0]).buffer);
    const punkte = ringe.flat();
    const z = t === 15 ? 16 + 8 * punkte.length : 0;
    const b = new ArrayBuffer(44 + 4 * ringe.length + 16 * punkte.length + z);
    const v = new DataView(b);
    v.setInt32(0, t, true);
    v.setInt32(36, ringe.length, true);
    v.setInt32(40, punkte.length, true);
    let start = 0;
    ringe.forEach((r, k) => {
      v.setInt32(44 + 4 * k, start, true);
      start += r.length;
    });
    const xy = 44 + 4 * ringe.length;
    punkte.forEach(([x, y], i) => {
      v.setFloat64(xy + 16 * i, x, true);
      v.setFloat64(xy + 16 * i + 8, y, true);
    });
    for (let i = 0; i < z / 8; i++) v.setFloat64(xy + 16 * punkte.length + 8 * i, 34.5, true);
    return new Uint8Array(b);
  });
  const laenge = 100 + teile.reduce((n, t) => n + 8 + t.length, 0);
  const out = new Uint8Array(laenge);
  const v = new DataView(out.buffer);
  v.setInt32(0, 9994, false);
  v.setInt32(24, laenge / 2, false);
  v.setInt32(28, 1000, true);
  v.setInt32(32, typ, true);
  let p = 100;
  teile.forEach((t, k) => {
    v.setInt32(p, k + 1, false);
    v.setInt32(p + 4, t.length / 2, false);
    out.set(t, p + 8);
    p += 8 + t.length;
  });
  return out;
}

/** Eine ZIP-Datei aus [Name, Bytes, gepackt]. */
export function zip(eintraege) {
  const lokal = [];
  const zentral = [];
  let p = 0;
  const enc = new TextEncoder();
  for (const [name, roh, packen] of eintraege) {
    const n = enc.encode(name);
    const daten = packen ? new Uint8Array(deflateRawSync(roh)) : roh;
    const kopf = new Uint8Array(30 + n.length);
    const v = new DataView(kopf.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(8, packen ? 8 : 0, true);
    v.setUint32(18, daten.length, true);
    v.setUint32(22, roh.length, true);
    v.setUint16(26, n.length, true);
    kopf.set(n, 30);
    const z = new Uint8Array(46 + n.length);
    const w = new DataView(z.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(10, packen ? 8 : 0, true);
    w.setUint32(20, daten.length, true);
    w.setUint32(24, roh.length, true);
    w.setUint16(28, n.length, true);
    w.setUint32(42, p, true);
    z.set(n, 46);
    lokal.push(kopf, daten);
    zentral.push(z);
    p += kopf.length + daten.length;
  }
  const groesse = zentral.reduce((s, z) => s + z.length, 0);
  const ende = new Uint8Array(22);
  const e = new DataView(ende.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, eintraege.length, true);
  e.setUint16(10, eintraege.length, true);
  e.setUint32(12, groesse, true);
  e.setUint32(16, p, true);
  const teile = [...lokal, ...zentral, ende];
  const out = new Uint8Array(teile.reduce((s, t) => s + t.length, 0));
  let q = 0;
  for (const t of teile) {
    out.set(t, q);
    q += t.length;
  }
  return out;
}

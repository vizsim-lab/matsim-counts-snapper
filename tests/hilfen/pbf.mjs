// Eine .osm.pbf von Hand (Protobuf, zlib aus node:zlib), für die Tests des OSM-Lesers und die
// Testdaten der Browser-Tests (tests/web/fixtures/baue.mjs).
import { deflateSync } from "node:zlib";

export const varint = (n) => {
  const out = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
export const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
export const text = (s) => [...new TextEncoder().encode(s)];
export const feld = (nr, draht, inhalt) => [...varint(nr * 8 + draht), ...(draht === 2 ? [...varint(inhalt.length), ...inhalt] : varint(inhalt))];
export const gepackt = (werte) => werte.flatMap(varint);
export const delta = (werte) => werte.map((v, i) => v - (i ? werte[i - 1] : 0));
export const roh = (grad) => Math.round(grad * 1e7); // Raster 100 Nanograd

export function blob(typ, daten, { unkomprimiert = false } = {}) {
  const inhalt = unkomprimiert ? feld(1, 2, daten) : [...feld(2, 0, daten.length), ...feld(3, 2, [...deflateSync(Uint8Array.from(daten))])];
  const kopf = [...feld(1, 2, text(typ)), ...feld(3, 0, inhalt.length)];
  const n = kopf.length;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...kopf, ...inhalt];
}

export const KOPF = [...feld(4, 2, text("OsmSchema-V0.6")), ...feld(4, 2, text("DenseNodes"))];

/** Ein PrimitiveBlock aus Strings und Gruppen (fertig kodierte Bytes je Gruppe). */
export const block = (strings, gruppen) => [...feld(1, 2, strings.flatMap((s) => feld(1, 2, text(s)))), ...gruppen.flatMap((g) => feld(2, 2, g))];

/** DenseNodes: [[id, lon, lat], …]. */
export const dicht = (knoten) => feld(2, 2, [
  ...feld(1, 2, gepackt(delta(knoten.map((k) => k[0])).map(zz))),
  ...feld(8, 2, gepackt(delta(knoten.map((k) => roh(k[2]))).map(zz))),
  ...feld(9, 2, gepackt(delta(knoten.map((k) => roh(k[1]))).map(zz))),
]);

/** Einzelne Nodes (ohne DenseNodes). */
export const einzeln = (knoten) => knoten.flatMap(([id, lon, lat]) => feld(1, 2, [...feld(1, 0, zz(id)), ...feld(8, 0, zz(roh(lat))), ...feld(9, 0, zz(roh(lon)))]));

/** Ways: [{ id, tags: {k: v}, refs, lage?: [[lon, lat], …] }] mit der Stringtabelle `st`. */
export function wege(liste, st) {
  const nr = (s) => {
    let i = st.indexOf(s);
    if (i < 0) i = st.push(s) - 1;
    return i;
  };
  return liste.flatMap((w) => {
    const keys = Object.keys(w.tags).map(nr);
    const vals = Object.values(w.tags).map(nr);
    const teile = [...feld(1, 0, w.id), ...feld(2, 2, gepackt(keys)), ...feld(3, 2, gepackt(vals)), ...feld(8, 2, gepackt(delta(w.refs).map(zz)))];
    if (w.lage) teile.push(...feld(9, 2, gepackt(delta(w.lage.map((p) => roh(p[1]))).map(zz))), ...feld(10, 2, gepackt(delta(w.lage.map((p) => roh(p[0]))).map(zz))));
    return feld(3, 2, teile);
  });
}

/** Eine ganze Datei: Kopf, ein Block mit den Knoten ([id, lon, lat]), einer mit den Wegen. */
export function pbfDatei({ knoten, wege: liste, einzelneKnoten = false, unkomprimiert = false }) {
  const st = [""];
  const wegGruppe = wege(liste, st);
  const knotenGruppe = einzelneKnoten ? einzeln(knoten) : dicht(knoten);
  return Uint8Array.from([
    ...blob("OSMHeader", KOPF),
    ...blob("OSMData", block([""], [knotenGruppe]), { unkomprimiert }),
    ...blob("OSMData", block(st, [wegGruppe])),
  ]);
}

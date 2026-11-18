// OSM-Leser, Übernahme einer Zuordnung und die Zuordnungs-CSV mit Anker. Die .osm.pbf baut der Test
// selbst (Protobuf von Hand, zlib aus node:zlib), damit er ohne Dateien und ohne Netz läuft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { istPbf, leseOsm, verkehrsmittel } from "../lib/osm.js";
import { uebertrage, wegeVonLink, siehtNachSumoAus, ohneVorzeichen } from "../lib/uebertrag.js";
import { LinkIndex } from "../lib/zuordnung.js";
import { zuordnungCsv, leseZuordnungCsv } from "../lib/counts.js";

// ---------- eine .osm.pbf von Hand ----------
const varint = (n) => {
  const out = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const text = (s) => [...new TextEncoder().encode(s)];
const feld = (nr, draht, inhalt) => [...varint(nr * 8 + draht), ...(draht === 2 ? [...varint(inhalt.length), ...inhalt] : varint(inhalt))];
const gepackt = (werte) => werte.flatMap(varint);
const delta = (werte) => werte.map((v, i) => v - (i ? werte[i - 1] : 0));
const roh = (grad) => Math.round(grad * 1e7); // Raster 100 Nanograd

function blob(typ, daten, { unkomprimiert = false } = {}) {
  const inhalt = unkomprimiert ? feld(1, 2, daten) : [...feld(2, 0, daten.length), ...feld(3, 2, [...deflateSync(Uint8Array.from(daten))])];
  const kopf = [...feld(1, 2, text(typ)), ...feld(3, 0, inhalt.length)];
  const n = kopf.length;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...kopf, ...inhalt];
}

const KOPF = [...feld(4, 2, text("OsmSchema-V0.6")), ...feld(4, 2, text("DenseNodes"))];

/** Ein PrimitiveBlock aus Strings und Gruppen (fertig kodierte Bytes je Gruppe). */
const block = (strings, gruppen) => [...feld(1, 2, strings.flatMap((s) => feld(1, 2, text(s)))), ...gruppen.flatMap((g) => feld(2, 2, g))];

/** DenseNodes: [[id, lon, lat], …]. */
const dicht = (knoten) => feld(2, 2, [
  ...feld(1, 2, gepackt(delta(knoten.map((k) => k[0])).map(zz))),
  ...feld(8, 2, gepackt(delta(knoten.map((k) => roh(k[2]))).map(zz))),
  ...feld(9, 2, gepackt(delta(knoten.map((k) => roh(k[1]))).map(zz))),
]);

/** Einzelne Nodes (ohne DenseNodes). */
const einzeln = (knoten) => knoten.flatMap(([id, lon, lat]) => feld(1, 2, [...feld(1, 0, zz(id)), ...feld(8, 0, zz(roh(lat))), ...feld(9, 0, zz(roh(lon)))]));

/** Ways: [{ id, tags: {k: v}, refs, lage?: [[lon, lat], …] }] mit der Stringtabelle `st`. */
function wege(liste, st) {
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

const KNOTEN = [
  [1, 13.4, 52.5],
  [2, 13.401, 52.5],
  [3, 13.402, 52.5],
  [4, 13.401, 52.501],
  [5, 13.403, 52.5],
  [6, 13.402, 52.499],
];
const WEGE = [
  { id: 10, tags: { highway: "residential", name: "Teststraße" }, refs: [1, 2, 3] },
  { id: 11, tags: { highway: "cycleway", oneway: "yes" }, refs: [2, 4] },
  { id: 12, tags: { highway: "footway" }, refs: [3, 5] },
  { id: 14, tags: { highway: "residential", oneway: "yes", "oneway:bicycle": "no" }, refs: [3, 6] },
  { id: 15, tags: { building: "yes" }, refs: [4, 5, 6, 4] },
];

function testDatei({ einzelneKnoten = false, unkomprimiert = false } = {}) {
  const st = [""];
  const wegGruppe = wege(WEGE, st);
  const knotenGruppe = einzelneKnoten ? einzeln(KNOTEN) : dicht(KNOTEN);
  return Uint8Array.from([
    ...blob("OSMHeader", KOPF),
    ...blob("OSMData", block([""], [knotenGruppe]), { unkomprimiert }),
    ...blob("OSMData", block(st, [wegGruppe])),
  ]);
}

const nachId = (r) => new Map(r.links.map((l) => [l.id, l]));
const nah = (a, b) => Math.abs(a - b) < 1e-7;

test("PBF erkennen", () => {
  assert.equal(istPbf(testDatei()), true);
  assert.equal(istPbf(new TextEncoder().encode('<?xml version="1.0"?><network>')), false);
});

test("OSM: Wege an Knotenpunkten geteilt, je Richtung mit Verkehrsmitteln", async () => {
  for (const art of [{}, { einzelneKnoten: true }, { unkomprimiert: true }]) {
    const r = await leseOsm(testDatei(art));
    const l = nachId(r);
    assert.deepEqual([...l.keys()].sort(), ["-10#0", "-10#1", "-14#0", "10#0", "10#1", "11#0", "14#0"], JSON.stringify(art));
    // Weg 10 ist an Knoten 2 geteilt (dort beginnt der Radweg 11)
    assert.deepEqual([l.get("10#0").from, l.get("10#0").to], ["1", "2"]);
    assert.deepEqual([l.get("10#1").from, l.get("10#1").to], ["2", "3"]);
    assert.deepEqual([l.get("-10#0").from, l.get("-10#0").to], ["2", "1"]);
    assert.ok(nah(l.get("10#0").xy[0], 13.4) && nah(l.get("10#0").xy[1], 52.5) && nah(l.get("10#0").xy[2], 13.401));
    assert.ok(nah(l.get("-10#0").xy[0], 13.401), "Gegenrichtung läuft rückwärts");
    assert.equal(l.get("10#0").modes, "car,bike");
    assert.equal(l.get("10#0").name, "Teststraße");
    assert.equal(l.get("10#0").weg, "10");
    assert.equal(l.get("-10#0").weg, "-10");
    assert.deepEqual(l.get("-10#0").wege, ["10"]);
    // Einbahn-Radweg nur vorwärts, Einbahnstraße mit Rad in Gegenrichtung
    assert.equal(l.get("11#0").modes, "bike");
    assert.equal(l.get("14#0").modes, "car,bike");
    assert.equal(l.get("-14#0").modes, "bike");
    assert.ok(Math.abs(l.get("10#0").length - 67.8) < 0.5, `Länge ${l.get("10#0").length}`);
    assert.equal(r.crs, "EPSG:4326");
    assert.equal(r.osm.wege, 3); // ohne Fußweg und Gebäude
  }
});

test("OSM-Filter: alle Wege mit Fuß, nur Hauptstraßen", async () => {
  const alle = nachId(await leseOsm(testDatei(), { filter: "alle" }));
  assert.equal(alle.get("12#0").modes, "walk");
  assert.equal(alle.get("-12#0").modes, "walk");
  assert.equal(alle.get("10#0").modes, "car,bike,walk");
  await assert.rejects(leseOsm(testDatei(), { filter: "haupt" }), /keine Wege/);
});

test("OSM: Lage an den Wegen (LocationsOnWays) ohne Knoten", async () => {
  const st = [""];
  const g = wege([{ id: 20, tags: { highway: "primary" }, refs: [7, 8], lage: [[13.41, 52.51], [13.412, 52.51]] }], st);
  const datei = Uint8Array.from([...blob("OSMHeader", [...KOPF, ...feld(5, 2, text("LocationsOnWays"))]), ...blob("OSMData", block(st, [g]))]);
  const r = await leseOsm(datei);
  const l = nachId(r).get("20#0");
  assert.ok(nah(l.xy[0], 13.41) && nah(l.xy[2], 13.412) && nah(l.xy[3], 52.51));
  assert.equal(r.osm.lageAmWeg, true);
});

test("OSM: fremde Kompression und Versionsgeschichte mit klarer Meldung", async () => {
  const lz4 = Uint8Array.from([...blob("OSMHeader", KOPF), ...(() => {
    const inhalt = [...feld(2, 0, 10), ...feld(6, 2, [1, 2, 3])];
    const kopf = [...feld(1, 2, text("OSMData")), ...feld(3, 0, inhalt.length)];
    return [0, 0, 0, kopf.length, ...kopf, ...inhalt];
  })()]);
  await assert.rejects(leseOsm(lz4), /LZ4.*zlib/);
  const geschichte = Uint8Array.from(blob("OSMHeader", [...KOPF, ...feld(4, 2, text("HistoricalInformation"))]));
  await assert.rejects(leseOsm(geschichte), /Versionsgeschichte/);
  await assert.rejects(leseOsm(new Uint8Array([0, 0, 0, 5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /keine \.osm\.pbf/);
});

test("Verkehrsmittel aus Tags", () => {
  assert.deepEqual(verkehrsmittel({ highway: "motorway" }), { vor: "car", rueck: "" });
  assert.deepEqual(verkehrsmittel({ highway: "primary", oneway: "-1" }), { vor: "walk", rueck: "car,bike,walk" }); // zu Fuß gilt keine Einbahn
  assert.deepEqual(verkehrsmittel({ highway: "primary", bicycle: "use_sidepath" }), { vor: "car,walk", rueck: "car,walk" });
  assert.deepEqual(verkehrsmittel({ highway: "trunk", motorroad: "yes" }), { vor: "car", rueck: "car" });
  assert.deepEqual(verkehrsmittel({ highway: "residential", oneway: "yes", cycleway: "opposite_lane" }), { vor: "car,bike,walk", rueck: "bike,walk" });
  assert.deepEqual(verkehrsmittel({ highway: "footway", bicycle: "yes" }), { vor: "bike,walk", rueck: "bike,walk" });
  assert.deepEqual(verkehrsmittel({ highway: "service", access: "private" }), { vor: "walk", rueck: "walk" });
  assert.deepEqual(verkehrsmittel({ highway: "secondary", junction: "roundabout" }), { vor: "car,bike,walk", rueck: "walk" });
});

// ---------- Übernahme ----------
function netz(links) {
  return new LinkIndex(links.map((l) => ({ modes: "car", ...l, xy: Float64Array.from(l.xy) })), 50);
}
const LINKS = [
  { id: "100#0", xy: [0, 0, 100, 0], wege: ["100"] }, // nach Osten
  { id: "-100#0", xy: [100, 5, 0, 5], wege: ["100"] }, // nach Westen
  { id: "200#0", xy: [0, 20, 100, 20], wege: ["200"] },
];

test("Übernahme: gleiche ID am selben Ort, sonst gleicher Weg, sonst eindeutige Lage", () => {
  const index = netz(LINKS);
  const ids = new Map(LINKS.map((l, i) => [l.id, i]));
  // 1. gleiche ID, 1 m daneben
  assert.deepEqual(pick(uebertrage(index, { x: 50, y: 1, grad: 90, linkId: "100#0", modi: ["car"] }, undefined, ids)), { i: 0, wie: "id" });
  // gleiche ID, aber 12 m weg: zählt nicht; der Weg 100 liegt 12 m weg -> über den Weg
  assert.deepEqual(pick(uebertrage(index, { x: 50, y: 12, grad: 90, linkId: "100#0", weg: "-100", modi: ["car"] }, undefined, ids)), { i: 0, wie: "weg" });
  // 2. Weg 100 nach Osten, obwohl 200 näher liegt
  assert.deepEqual(pick(uebertrage(index, { x: 50, y: 14, grad: 90, weg: "100", modi: ["car"] }, undefined, ids)), { i: 0, wie: "weg" });
  // 3. ohne ID und Weg: der einzige Link nach Osten dicht am Anker; die Gegenrichtung zählt nicht
  assert.deepEqual(pick(uebertrage(index, { x: 50, y: 2, grad: 90, modi: ["car"] }, undefined, ids)), { i: 0, wie: "lage" });
  assert.deepEqual(pick(uebertrage(index, { x: 50, y: 3, grad: 270, modi: ["car"] }, undefined, ids)), { i: 1, wie: "lage" });
});

test("Übernahme: nicht eindeutig, mit Grund", () => {
  const links = [...LINKS, { id: "300#0", xy: [0, 4, 100, 4], wege: ["300"] }];
  const index = netz(links);
  let r = uebertrage(index, { x: 50, y: 2, grad: 90, modi: ["car"] });
  assert.equal(r.i, null);
  assert.match(r.grund, /zwei Links dicht am Anker \(2 und 2 m\)/);
  r = uebertrage(index, { x: 50, y: 11, grad: 90, modi: ["car"] });
  assert.match(r.grund, /der nächste passende Link liegt 7 m vom Anker/);
  r = uebertrage(index, { x: 50, y: 11.5, grad: 90, modi: ["car"] });
  assert.match(r.grund, /liegt 7,5 m vom Anker/);
  r = uebertrage(index, { x: 500, y: 500, grad: 90, modi: ["car"] });
  assert.match(r.grund, /kein passender Link im Umkreis von 30 m/);
  r = uebertrage(netz(LINKS), { x: 50, y: 1, grad: 90, modi: ["bike"] });
  assert.equal(r.i, null, "nur Links mit dem Verkehrsmittel");
});

test("OSM-Wege eines MATSim-Links", () => {
  assert.deepEqual(wegeVonLink({ id: "-123#2" }, true), { weg: "-123", wege: ["123"] });
  assert.deepEqual(wegeVonLink({ id: "123" }, true), { weg: "123", wege: ["123"] });
  assert.deepEqual(wegeVonLink({ id: "123" }, false), { weg: null, wege: [] });
  assert.deepEqual(wegeVonLink({ id: "5", osmWayId: 777 }, false), { weg: "777", wege: ["777"] });
  assert.deepEqual(wegeVonLink({ id: "x", origId: "123#0 456" }, false), { weg: "123", wege: ["123", "456"] });
  assert.equal(siehtNachSumoAus([{ id: "1#0" }, { id: "-2#1" }, { id: "pt_3" }]), true);
  assert.equal(siehtNachSumoAus([{ id: "1" }, { id: "2" }, { id: "3" }]), false);
  assert.equal(ohneVorzeichen("-42"), "42");
});

test("Zuordnungs-CSV trägt den Anker hin und zurück", () => {
  const csv = zuordnungCsv([
    { station: "berlin_rad:02-MI-JAN-N", linkid: "-123#0", using: true, zuordnung: "geprüft", abstand_m: 4.2, richtung: "Richtung Norden", name: "Jannowitzbrücke", quelle: "berlin_rad", anker_lon: "13.4178350", anker_lat: "52.5139320", anker_grad: 2, osm_weg: "-123", netz: "berlin.osm.pbf" },
    { station: "x:1", linkid: "", using: false, zuordnung: "ausgelassen" },
  ]);
  assert.match(csv.split("\n")[0], /;anker_lon;anker_lat;anker_grad;osm_weg;netz;zaehlart$/);
  const [a, b] = leseZuordnungCsv(csv);
  assert.deepEqual(a.anker, { lon: 13.417835, lat: 52.513932, grad: 2 });
  assert.equal(a.weg, "-123");
  assert.equal(a.netz, "berlin.osm.pbf");
  assert.equal(b.anker, null);
  // eine CSV ohne die Spalten (MATSim, ältere Fassung) geht weiter
  const [c] = leseZuordnungCsv("station;linkid;using\ns1;42;y\n");
  assert.equal(c.anker, null);
  assert.equal(c.linkid, "42");
});

function pick(r) {
  return { i: r.i, wie: r.wie };
}

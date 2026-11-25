// Testdaten der Browser-Tests, alle erfunden: ein kleines Gitter als MATSim-Netz (ETRS89 / UTM 33N,
// mitten in Berlin) und als OSM-Auszug, ein Auszug der Zählkarte mit Dauerzählstellen und
// Kurzzeitzählungen daran, ein Gebiet (.poly). Neu bauen: npm run testdaten
//
// Gitter: 4 Spalten × 3 Reihen, 300 m Abstand, Knoten k{Spalte}{Reihe}. Jede Strecke in beide
// Richtungen; die mittlere Reihe („Mittelweg“) nur für car, alle anderen für car und bike.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projektion } from "../../../lib/crs.js";
import { pbfDatei } from "../../hilfen/pbf.mjs";

const HIER = dirname(fileURLToPath(import.meta.url));
const X0 = 390000;
const Y0 = 5819000;
const D = 300;
const SPALTEN = 4;
const REIHEN = 3;
const utm = projektion("EPSG:25833");
const wgs = (x, y) => utm.zuWgs(x, y).map((v) => Math.round(v * 1e7) / 1e7);

const schreibe = (pfad, inhalt) => {
  const ziel = join(HIER, pfad);
  mkdirSync(dirname(ziel), { recursive: true });
  writeFileSync(ziel, inhalt);
};
const json = (pfad, daten, kompakt = false) => schreibe(pfad, `${kompakt ? JSON.stringify(daten) : JSON.stringify(daten, null, 1)}\n`);

// ---------- Netz ----------
const knoten = [];
for (let c = 0; c < SPALTEN; c++) for (let r = 0; r < REIHEN; r++) knoten.push({ id: `k${c}${r}`, c, r, x: X0 + c * D, y: Y0 + r * D });
const REIHE = ["Hauptstraße", "Mittelweg", "Nordstraße"];
const strecken = [];
for (let r = 0; r < REIHEN; r++) for (let c = 0; c + 1 < SPALTEN; c++) strecken.push({ a: `k${c}${r}`, b: `k${c + 1}${r}`, name: REIHE[r], typ: "secondary", weg: 100 + r, modes: r === 1 ? "car" : "car,bike" });
for (let c = 0; c < SPALTEN; c++) for (let r = 0; r + 1 < REIHEN; r++) strecken.push({ a: `k${c}${r}`, b: `k${c}${r + 1}`, name: `Querweg ${c}`, typ: "residential", weg: 200 + c, modes: "car,bike" });
const links = strecken.flatMap((s) => [{ ...s, id: `${s.a}-${s.b}`, von: s.a, nach: s.b }, { ...s, id: `${s.b}-${s.a}`, von: s.b, nach: s.a }]);
const attr = (name, wert) => `<attribute name="${name}" class="java.lang.String">${wert}</attribute>`;
schreibe("netz.xml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE network SYSTEM "http://www.matsim.org/files/dtd/network_v2.dtd">
<network name="testgitter">
\t<attributes>
\t\t${attr("coordinateReferenceSystem", "EPSG:25833")}
\t</attributes>
\t<nodes>
${knoten.map((k) => `\t\t<node id="${k.id}" x="${k.x}" y="${k.y}"/>`).join("\n")}
\t</nodes>
\t<links capperiod="01:00:00" effectivecellsize="7.5" effectivelanewidth="3.75">
${links.map((l) => `\t\t<link id="${l.id}" from="${l.von}" to="${l.nach}" length="${D}.0" freespeed="13.89" capacity="1800.0" permlanes="1.0" oneway="1" modes="${l.modes}">
\t\t\t<attributes>${attr("name", l.name)}${attr("type", l.typ)}${attr("origid", l.weg)}</attributes>
\t\t</link>`).join("\n")}
\t</links>
</network>
`);

// dasselbe Netz gepackt: gzip und Zstandard (MATSim mit compressionType = zst)
const netzXml = readFileSync(join(HIER, "netz.xml"));
schreibe("netz.xml.gz", gzipSync(netzXml, { level: 9 }));
schreibe("netz.xml.zst", zstdCompressSync(netzXml));

// ---------- dasselbe Gitter als OSM-Auszug ----------
const osmId = (k) => 1000 + k.c * 10 + k.r;
const osmKnoten = knoten.map((k) => [osmId(k), ...wgs(k.x, k.y)]);
const nachId = new Map(knoten.map((k) => [k.id, k]));
const wege = [
  ...REIHE.map((name, r) => ({ id: 100 + r, tags: { highway: "secondary", name, ...(r === 1 ? { bicycle: "no" } : {}) }, refs: Array.from({ length: SPALTEN }, (_, c) => osmId(nachId.get(`k${c}${r}`))) })),
  ...Array.from({ length: SPALTEN }, (_, c) => ({ id: 200 + c, tags: { highway: "residential", name: `Querweg ${c}` }, refs: Array.from({ length: REIHEN }, (_, r) => osmId(nachId.get(`k${c}${r}`))) })),
];
schreibe("netz.osm.pbf", pbfDatei({ knoten: osmKnoten, wege }));

// ---------- Dauerzählstellen ----------
// Lage in Metern vom Ursprung; die Richtung so, wie die Zählkarte sie schreibt
const DAUER = [
  // id, quelle, name, richtung, dx, dy, g (Bits: kfz 1, lkw 2, rad 8)
  ["test_viz:D1", "test_viz", "Hauptstraße", "Richtung Osten", 150, 6, 3], // -> k00-k10
  ["test_viz:D2", "test_viz", "Hauptstraße", "Richtung Westen", 150, -6, 3], // -> k10-k00
  ["test_viz:D3", "test_viz", "Querweg 1", "Richtung Norden", 306, 150, 3], // -> k10-k11, ein Tag mit Lücke
  ["test_viz:D4", "test_viz", "Hinterhof", "Richtung Osten", 150, 150, 3], // kein Link im Umkreis
  ["test_viz:D5", "test_viz", "Querweg 3", "Richtung Süden", 894, 150, 3], // -> k31-k30, außerhalb des Gebiets
  ["test_rad:R1", "test_rad", "Querweg 2", "Richtung Norden", 606, 150, 8], // -> k20-k21 (bike), außerhalb des Gebiets
  ["test_rad:R2", "test_rad", "Mittelweg", "Richtung Osten", 150, 306, 8], // Mittelweg ohne bike: kein Link
  ["test_rad:R3", "test_rad", "Querweg 0", null, 6, 450, 8], // ohne Richtung: nur angezeigt
  ["test_ohne:X1", "test_ohne", "Ohne Lizenz", "Richtung Osten", 420, 6, 1], // Quelle ohne Lizenz: nie dabei
];
const VON = "2025-06-02"; // Montag; 21 Tage, Pfingstmontag (9. Juni) ist Feiertag
const KALENDER = "sssssww" + "hssssww" + "sssssww";
const TAGE = KALENDER.length;
const versatz = { "test_viz:D1": 0, "test_viz:D2": 1000, "test_viz:D3": 2000, "test_viz:D4": 4000, "test_viz:D5": 3000 };
const stunden = {};
for (const [id, , , , , , g] of DAUER) {
  const s = {};
  if (g & 1) s.kfz = Array.from({ length: TAGE }, (_, d) => Array.from({ length: 24 }, (_, h) => (versatz[id] ?? 0) + 100 + 10 * h + d));
  if (g & 2) s.lkw = Array.from({ length: TAGE }, (_, d) => Array.from({ length: 24 }, (_, h) => Math.round((versatz[id] ?? 0) / 100) + 10 + h));
  if (g & 8) s.rad = Array.from({ length: TAGE }, (_, d) => Array.from({ length: 24 }, (_, h) => 5 + h + d));
  stunden[id] = s;
}
stunden["test_viz:D3"].kfz[8][3] = null; // Dienstag, 10. Juni: eine Stunde fehlt, der Tag ist nicht ganz
const lizenz = (code, titel, l, url) => ({ code, titel, herausgeber: "Teststadt", lizenz: l, lizenz_url: url });
json("zaehlkarte/dauer/index.json", {
  version: 5,
  erzeugt: "2026-11-20",
  gruppen: ["kfz", "lkw", "sv", "rad", "fuss"],
  gruppen_namen: { kfz: "Kfz", lkw: "Lkw (Detektor)", sv: "Schwerverkehr (Detektor)", rad: "Rad", fuss: "Fuß" },
  dateien: { details: "dauer/{n}.json" },
  von: VON,
  kalender: { BE: KALENDER },
  quellen: [
    { code: "test_viz", name: "Teststadt (Detektoren)", land: "BE", quellenvermerk: "Teststadt / Detektoren", lizenzen: [lizenz("test_viz", "Detektoren", "dl-de/by-2-0", "https://www.govdata.de/dl-de/by-2-0")], stunden_von: VON, bis: "2025-06-22", gruppen: ["kfz", "lkw"] },
    { code: "test_rad", name: "Teststadt (Rad)", land: "BE", lizenzen: [lizenz("test_rad", "Rad-Zählstellen", "dl-de/zero-2-0", "https://www.govdata.de/dl-de/zero-2-0")], stunden_von: VON, bis: "2025-06-22", gruppen: ["rad"] },
    { code: "test_ohne", name: "Teststadt (ohne Lizenz)", land: "BE", lizenzen: [{ code: "test_ohne", titel: "ohne", lizenz: null }], gruppen: ["kfz"] },
  ],
  stellen: {
    felder: ["id", "quelle", "name", "abschnitt", "richtung", "lon", "lat", "von", "bis", "g", "ags", "chunk"],
    werte: DAUER.map(([id, quelle, name, richtung, dx, dy, g]) => [id, quelle, name, null, richtung, ...wgs(X0 + dx, Y0 + dy), "2020-01-01", "2025-06-22", g, "11000000", 0]),
  },
});
json("zaehlkarte/dauer/0.json", {
  stellen: Object.fromEntries(DAUER.map(([id]) => [id, { stunden_von: VON, stunden: stunden[id], doppelt: [], fahrstreifen: id.startsWith("test_viz") ? ["Hauptfahrbahn, 1 Fahrstreifen"] : [], hinweise: [] }])),
}, true);

// ---------- Kurzzeitzählungen ----------
// K1: Knoten k11 mit vier Armen; Q1: Querschnitt auf dem Querweg 0 zwischen k00 und k01
const reihe = (basis) => Array.from({ length: 12 }, (_, i) => basis + i);
const ARME = [{ nr: 1, name: "Mittelweg (W)", winkel: 270 }, { nr: 2, name: "Querweg 1 (N)", winkel: 0 }, { nr: 3, name: "Mittelweg (O)", winkel: 90 }, { nr: 4, name: "Querweg 1 (S)", winkel: 180 }];
const stroeme = [];
for (const von of [1, 2, 3, 4]) for (const nach of [1, 2, 3, 4]) if (von !== nach) stroeme.push({ von, nach, stunden: { kfz: reihe(10 * von + nach), rad: reihe(von) } });
json("zaehlkarte/manifest.json", {
  version: 1,
  erzeugt: "2026-11-19",
  dateien: { index: "index.json", details: "details/{n}.json", stroeme: "stroeme/{quelle}-{jahr}.json" },
  stroeme: { test: [2024] },
  gruppen: [{ id: "kfz", name: "Kfz" }, { id: "sv", name: "Schwerverkehr" }, { id: "rad", name: "Rad" }, { id: "fuss", name: "Fuß" }],
  quellen: [{ code: "test", name: "Teststadt", land: "BE", lizenzen: [{ code: "2024", titel: "Zählungen 2024", lizenz: "dl-de/by-2-0", lizenz_url: "https://www.govdata.de/dl-de/by-2-0" }] }],
});
json("zaehlkarte/index.json", {
  version: 1,
  quellen: ["test"],
  lagen: ["gps", "quelle", "geokodiert", "uebertragen"],
  stellen: {
    felder: ["id", "quelle", "name", "typ", "lon", "lat", "lage", "chunk"],
    werte: [
      ["test:K1", 0, "Mittelweg / Querweg 1", "K", ...wgs(X0 + D, Y0 + D), 0, 0],
      ["test:Q1", 0, "Querweg 0 (nördl. Hauptstraße)", "Q", ...wgs(X0, Y0 + 150), 0, 0],
    ],
  },
});
json("zaehlkarte/stroeme/test-2024.json", {
  version: 1,
  quelle: "test",
  zaehlungen: {
    K1_20240611: { stelle: "test:K1", datum: "2024-06-11", tag: "s", fenster: "7–19", intervall: 15, lieferung: "2024", h0: 7, arme: ARME, stroeme },
    Q1_20240612: {
      stelle: "test:Q1", datum: "2024-06-12", tag: "s", fenster: "7–19", intervall: 15, lieferung: "2024", h0: 7,
      arme: [{ nr: 1, name: "Querweg 0 (N)", winkel: 0 }, { nr: 2, name: "Querweg 0 (S)", winkel: 180 }],
      stroeme: [{ von: 1, nach: 2, stunden: { kfz: reihe(200), rad: reihe(20) } }, { von: 2, nach: 1, stunden: { kfz: reihe(300), rad: reihe(30) } }],
    },
  },
});

// ---------- Gebiet: die westliche Hälfte des Gitters ----------
const gebiet = [[-100, -100], [450, -100], [450, 700], [-100, 700], [-100, -100]].map(([dx, dy]) => wgs(X0 + dx, Y0 + dy));
schreibe("gebiet.poly", `westen\n1\n${gebiet.map(([lon, lat]) => `   ${lon.toFixed(7)}   ${lat.toFixed(7)}`).join("\n")}\nEND\nEND\n`);
console.log(`Testdaten in ${HIER}: ${knoten.length} Knoten, ${links.length} Links, ${DAUER.length} Dauerzählstellen, 2 Kurzzeitzählungen`);

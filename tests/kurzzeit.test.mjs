// Tests der Kurzzeitzählungen (lib/kurzzeit.js) mit kleinen, erfundenen Zählungen
import { test } from "node:test";
import assert from "node:assert/strict";
import { versetze, leseManifest, leseStellen, stroemePfad, summe, gezaehlteStunden, tagPasst, waehleZaehlungen, punkte, lizenzenVon, strassenName, istKnoten, KURZ_VORGABE } from "../lib/kurzzeit.js";
import { LinkIndex, kandidaten, verteile } from "../lib/zuordnung.js";
import { setzeSprache } from "../lib/sprache.js";

// Die Bausteine sprechen hier Deutsch; Englisch prüft sprache.test.mjs
setzeSprache("de");

const MANIFEST = {
  version: 1,
  erzeugt: "2026-11-18",
  dateien: { index: "index.json", details: "details/{n}.json", stroeme: "stroeme/{quelle}-{jahr}.json" },
  stroeme: { berlin: [2023, 2019, 2024] },
  gruppen: [{ id: "kfz", name: "Kfz" }, { id: "rad", name: "Rad" }],
  quellen: [{
    code: "berlin",
    name: "Berlin",
    land: "BE",
    lizenzen: [
      { code: "2019-2025", titel: "Rohdaten 2019–2025", lizenz: "dl-de/by-2-0", lizenz_url: "https://www.govdata.de/dl-de/by-2-0" },
      { code: "1990-2019", titel: "Verkehrszähldaten 1990–2019", lizenz: "CC BY-SA 3.0 DE", lizenz_url: "https://creativecommons.org/licenses/by-sa/3.0/de/" },
      { code: "lage", titel: "Geokodierung", lizenz: "ODbL (abgeleitet aus OpenStreetMap)" },
    ],
  }, {
    code: "ohne",
    name: "Ohne",
    lizenzen: [{ code: "ohne", titel: "x", lizenz: null, ohne_lizenz: { herausgegeben: "auf Anfrage", geprueft: "2026-11-14" } }],
  }],
};

const INDEX = {
  version: 1,
  quellen: ["berlin"],
  lagen: ["gps", "quelle", "geokodiert", "uebertragen"],
  stellen: {
    felder: ["id", "quelle", "name", "typ", "lon", "lat", "lage", "chunk"],
    werte: [
      ["berlin:K1", 0, "Hauptstraße / Nebenweg", "K", 13.4, 52.5, 0, 0],
      ["berlin:Q7", 0, "Langer Weg (südl. Kurzer Weg)", "Q", 13.41, 52.51, 2, 0],
      ["berlin:Q8", 0, "ohne Lage", "Q", null, null, null, 0],
    ],
  },
};

const reihe = (...w) => w;
// Knoten mit drei Armen: 1 nach Norden (0°), 2 nach Osten (90°), 3 nach Süden (180°)
const knoten = (datum, extra = {}) => ({
  stelle: "berlin:K1",
  datum,
  tag: "s",
  fenster: "7–9",
  intervall: 15,
  lieferung: "2019-2025",
  h0: 7,
  arme: [{ nr: 1, name: "Hauptstraße (N)", winkel: 0 }, { nr: 2, name: "Nebenweg (O)", winkel: 90 }, { nr: 3, name: "Hauptstraße (S)", winkel: 180 }],
  stroeme: [
    { von: 1, nach: 3, stunden: { kfz: reihe(100, 110), rad: reihe(5, 6) } },
    { von: 1, nach: 2, stunden: { kfz: reihe(10, null), rad: reihe(1, 1) } },
    { von: 3, nach: 1, stunden: { kfz: reihe(90, 95), rad: reihe(4, 4) } },
    { von: 2, nach: 1, stunden: { kfz: reihe(20, 25), rad: reihe(2, 3) } },
    { von: 3, nach: 3, stunden: { kfz: reihe(1, 0), rad: reihe(0, 0) } }, // Wende
  ],
  ...extra,
});

test("kurzzeit: Manifest, Stellen, Pfade", () => {
  const m = leseManifest(MANIFEST);
  assert.equal(m.muster, "stroeme/{quelle}-{jahr}.json");
  assert.deepEqual(m.jahre.get("berlin"), [2019, 2023, 2024]);
  assert.equal(stroemePfad(m, "berlin", 2023), "stroeme/berlin-2023.json");
  assert.equal(m.gruppenNamen.rad, "Rad");
  assert.equal(m.quellen.get("berlin").lizenzen.get("1990-2019").lizenz, "CC BY-SA 3.0 DE");
  assert.equal(m.quellen.get("ohne").lizenzen.get("ohne").ohneLizenz, true);
  // ohne Ströme in der Zählkarte (vor zaehlkarte#45)
  assert.equal(leseManifest({ dateien: { index: "index.json" } }).muster, null);
  assert.throws(() => leseManifest({}), /keine manifest.json/);
  const st = leseStellen(INDEX);
  assert.deepEqual([...st.keys()], ["berlin:K1", "berlin:Q7"], "ohne Lage keine Stelle");
  assert.deepEqual(st.get("berlin:Q7"), { id: "berlin:Q7", quelle: "berlin", name: "Langer Weg (südl. Kurzer Weg)", typ: "Q", lon: 13.41, lat: 52.51, lage: "geokodiert" });
  assert.throws(() => leseStellen({ stellen: { felder: ["id"] } }), /Feld „quelle“/);
});

test("kurzzeit: versetzen auf dem Arm", () => {
  const [lon, lat] = versetze(13.4, 52.5, 0, 25);
  assert.equal(lon, 13.4);
  assert.ok(Math.abs((lat - 52.5) * 111195 - 25) < 0.05, `${lat}`);
  const [lonO, latO] = versetze(13.4, 52.5, 90, 25);
  assert.ok(Math.abs(latO - 52.5) < 1e-12);
  assert.ok(Math.abs((lonO - 13.4) * 111195 * Math.cos((52.5 * Math.PI) / 180) - 25) < 0.05);
  const [, latS] = versetze(13.4, 52.5, 180, 10);
  assert.ok(latS < 52.5);
});

test("kurzzeit: Summe der Ströme, nichts aufgefüllt", () => {
  const z = knoten("2023-10-19");
  const s = summe(z.stroeme.slice(0, 2), ["kfz", "rad", "fuss"]);
  assert.deepEqual(s, { kfz: [110, null], rad: [6, 7] }, "fehlt einem Strom eine Stunde, ist sie leer; fuss zählt keiner");
  // fehlt einem Strom die Gruppe ganz, fehlt sie der Summe
  const ohneRad = [{ stunden: { kfz: [1] } }, { stunden: { kfz: [2], rad: [3] } }];
  assert.deepEqual(summe(ohneRad, ["kfz", "rad"]), { kfz: [3] });
  assert.deepEqual(summe([], ["kfz"]), {});
  assert.equal(gezaehlteStunden(z, "kfz"), 1);
  assert.equal(gezaehlteStunden(z, "rad"), 2);
  assert.equal(gezaehlteStunden(z, "fuss"), 0);
  // wie die Zählkarte: Ströme ohne die Gruppe zählen nicht mit
  assert.equal(gezaehlteStunden({ stroeme: ohneRad }, "rad"), 1);
});

test("kurzzeit: Tage wie beim Mitteln", () => {
  const o = { wochentage: [2, 3, 4], tage: ["s"] };
  assert.equal(tagPasst({ datum: "2023-10-19", tag: "s" }, o), true, "Donnerstag, Schultag");
  assert.equal(tagPasst({ datum: "2023-10-16", tag: "s" }, o), false, "Montag");
  assert.equal(tagPasst({ datum: "2023-10-18", tag: "f" }, o), false);
  assert.equal(tagPasst({ datum: "2023-10-18", tag: null }, { ...o, tage: ["u"] }), true, "ohne Kalender");
  assert.equal(tagPasst({ datum: "2023-10-22", tag: "w" }, { wochentage: [0], tage: [] }), true, "Sonntag ohne Blick auf den Kalender");
  assert.equal(tagPasst({ datum: null, tag: "s" }, o), false);
});

test("kurzzeit: je Stelle und Gruppe die jüngste passende Zählung", () => {
  const e = (kennung, z, quelle = "berlin") => ({ quelle, kennung, z });
  const opts = { ...KURZ_VORGABE, gruppen: ["kfz", "rad"], minStunden: 1 };
  const alle = [
    e("K1_2019", knoten("2019-05-08")),
    e("K1_2023", knoten("2023-10-19")),
    e("K1_2024", knoten("2024-03-12", { stroeme: knoten("x").stroeme.map((s) => ({ ...s, stunden: { rad: s.stunden.rad } })) })), // nur Rad
    e("K1_2025f", knoten("2025-07-08", { tag: "f" })), // Ferien
    e("K1_2018", knoten("2018-05-08")), // vor dem Zeitraum
  ];
  const w = waehleZaehlungen(alle, opts);
  assert.deepEqual(w.map((a) => [a.kennung, a.gruppen]), [["K1_2023", ["kfz"]], ["K1_2024", ["rad"]]]);
  // mindestens 2 Stunden: Kfz hat 2023 nur eine ganz gezählte Stunde, also 2019 – auch nur eine
  assert.deepEqual(waehleZaehlungen(alle, { ...opts, minStunden: 2 }).map((a) => [a.kennung, a.gruppen]), [["K1_2024", ["rad"]]]);
  // bis 2023 und nur im Gebiet
  assert.deepEqual(waehleZaehlungen(alle, { ...opts, bisJahr: 2023 }).map((a) => [a.kennung, a.gruppen]), [["K1_2023", ["kfz", "rad"]]]);
  assert.deepEqual(waehleZaehlungen(alle, opts, new Set(["berlin:Q7"])), []);
  // am selben Tag zwei Dateien (7–9 und 15–18 Uhr): die mit mehr Stunden, die andere als Hinweis
  const frueh = knoten("2023-10-19", { stroeme: [{ von: 1, nach: 3, stunden: { kfz: [1, 2] } }] });
  const spaet = knoten("2023-10-19", { h0: 15, fenster: "15–18", stroeme: [{ von: 1, nach: 3, stunden: { kfz: [3, 4, 5] } }] });
  const zwei = waehleZaehlungen([e("K1_a", frueh), e("K1_b", spaet)], { ...opts, gruppen: ["kfz"] });
  assert.deepEqual(zwei.map((a) => [a.kennung, a.andere]), [["K1_b", ["K1_a"]]]);
});

test("kurzzeit: Knoten je Arm als Zufahrt und Ausfahrt", () => {
  const st = leseStellen(INDEX).get("berlin:K1");
  const a = { quelle: "berlin", kennung: "K1_2023", z: knoten("2023-10-19"), gruppen: ["kfz", "rad"], andere: [] };
  assert.equal(istKnoten(st, a.z), true);
  const r = punkte(st, a, { abstand: 25, seitlich: 0 });
  assert.deepEqual(r.punkte.map((p) => p.id), [
    "berlin:K1/K1_2023/1zu", "berlin:K1/K1_2023/1aus",
    "berlin:K1/K1_2023/2zu", "berlin:K1/K1_2023/2aus",
    "berlin:K1/K1_2023/3zu", "berlin:K1/K1_2023/3aus",
  ]);
  const by = Object.fromEntries(r.punkte.map((p) => [p.id.split("/").pop(), p]));
  // Zufahrt Nord: 1->3 und 1->2, nach Süden zum Knoten hin; die fehlende Stunde bleibt leer
  assert.deepEqual(by["1zu"].werte, { kfz: [110, null], rad: [6, 7] });
  assert.equal(by["1zu"].grad, 180);
  assert.equal(by["1aus"].grad, 0);
  assert.deepEqual(by["1aus"].werte, { kfz: [110, 120], rad: [6, 7] }, "3->1 und 2->1");
  // die Wende 3->3 zählt in der Zufahrt und in der Ausfahrt von Arm 3
  assert.deepEqual(by["3zu"].werte.kfz, [91, 95]);
  assert.deepEqual(by["3aus"].werte.kfz, [101, 110]);
  assert.deepEqual(by["3aus"].stroeme, [[1, 3], [3, 3]]);
  // 25 m vom Knoten auf dem Arm: Nord höher, Ost weiter östlich
  assert.ok(Math.abs((by["1zu"].lat - 52.5) * 111195 - 25) < 0.05 && by["1zu"].lon === 13.4);
  assert.ok(by["2zu"].lon > 13.4 && Math.abs(by["2zu"].lat - 52.5) < 1e-12);
  assert.equal(by["2zu"].grad, 270);
  assert.deepEqual(by["2zu"].knoten, { lon: 13.4, lat: 52.5 });
  assert.equal(by["1zu"].suchName, "Hauptstraße");
  assert.equal(by["1zu"].art, "knoten");
  assert.equal(by["1zu"].datum, "2023-10-19");
  assert.equal(r.ohneWinkel, 0);
  // wie im Rechtsverkehr: die Zufahrt von Norden (nach Süden) liegt westlich des Arms, die Ausfahrt östlich
  const rechts = Object.fromEntries(punkte(st, a, { abstand: 25 }).punkte.map((p) => [p.id.split("/").pop(), p]));
  const m = (dlon) => dlon * 111195 * Math.cos((52.5 * Math.PI) / 180);
  assert.ok(Math.abs(m(rechts["1zu"].lon - 13.4) + 3) < 0.01, `${rechts["1zu"].lon}`);
  assert.ok(Math.abs(m(rechts["1aus"].lon - 13.4) - 3) < 0.01);
  assert.ok(Math.abs((rechts["1zu"].lat - by["1zu"].lat) * 111195) < 0.01, "auf derselben Höhe des Arms");
  // ein Arm ohne Winkel bekommt keine Punkte: ohne Richtung kein Ort auf dem Arm
  const ohne = { ...a, z: knoten("2023-10-19", { arme: knoten("x").arme.map((x) => (x.nr === 2 ? { ...x, winkel: null } : x)) }) };
  const r2 = punkte(st, ohne);
  assert.equal(r2.ohneWinkel, 2);
  assert.deepEqual(r2.punkte.map((p) => p.id.split("/").pop()), ["1zu", "1aus", "3zu", "3aus"]);
});

test("kurzzeit: Querschnitt je Fahrtrichtung an der Stelle", () => {
  const st = leseStellen(INDEX).get("berlin:Q7");
  const z = {
    stelle: "berlin:Q7", datum: "2024-05-14", tag: "s", fenster: "7–19", intervall: 60, lieferung: "2019-2025", h0: 7,
    arme: [{ nr: 1, name: "Norden", winkel: 350 }, { nr: 2, name: "Kurzer Weg", winkel: 260 }, { nr: 3, name: "Süden", winkel: null }],
    stroeme: [
      { von: 1, nach: 3, stunden: { kfz: [40] } },
      { von: 3, nach: 1, stunden: { kfz: [30] } },
      { von: 1, nach: 1, stunden: { kfz: [1] } }, // Wende: an einem Querschnitt nicht
    ],
  };
  const r = punkte(st, { quelle: "berlin", kennung: "Q7_2024", z, gruppen: ["kfz"], andere: [] }, { seitlich: 0 });
  assert.deepEqual(r.punkte.map((p) => [p.id, p.grad, p.werte.kfz[0], p.lon, p.lat]), [
    ["berlin:Q7/Q7_2024/nach3", 170, 40, 13.41, 52.51], // ohne Winkel am Ziel: weg vom Arm 1
    ["berlin:Q7/Q7_2024/nach1", 350, 30, 13.41, 52.51],
  ]);
  assert.equal(r.punkte[0].art, "querschnitt");
  assert.equal(r.punkte[0].suchName, "Langer Weg");
  assert.equal(r.punkte[0].lage, "geokodiert");
  // ohne Winkel an beiden Enden: keine Richtung, der Punkt bleibt (zum Prüfen)
  const z2 = { ...z, arme: z.arme.map((x) => ({ ...x, winkel: null })) };
  assert.deepEqual(punkte(st, { quelle: "berlin", kennung: "Q7_2024", z: z2, gruppen: ["kfz"] }).punkte.map((p) => p.grad), [null, null]);
});

test("kurzzeit: Lizenz je Lieferung, Lage aus OSM", () => {
  const m = leseManifest(MANIFEST);
  const neu = lizenzenVon(m, { quelle: "berlin", lieferung: "2019-2025", lage: "gps" });
  assert.equal(neu.lieferung.lizenz, "dl-de/by-2-0");
  assert.equal(neu.lage, null);
  assert.equal(neu.ok, true);
  const alt = lizenzenVon(m, { quelle: "berlin", lieferung: "1990-2019", lage: "geokodiert" });
  assert.equal(alt.lieferung.lizenz, "CC BY-SA 3.0 DE");
  assert.equal(alt.lage.lizenz, "ODbL (abgeleitet aus OpenStreetMap)");
  assert.equal(lizenzenVon(m, { quelle: "berlin", lieferung: null, lage: "uebertragen" }).lieferung.code, "2019-2025");
  assert.equal(lizenzenVon(m, { quelle: "ohne", lieferung: "ohne" }).ok, false);
  assert.equal(lizenzenVon(m, { quelle: "unbekannt" }).ok, false);
});

test("kurzzeit: Straßennamen für den Vergleich mit den Links", () => {
  assert.equal(strassenName("Oranienburger Chaussee (NW)"), "Oranienburger Chaussee");
  assert.equal(strassenName("Rauentaler Straße - Am Pilz (NO)"), "Rauentaler Straße");
  assert.equal(strassenName("Schlesische Straße / Falckensteinstraße (nur Fußverkehr)"), "Schlesische Straße");
  assert.equal(strassenName("General-Pape-Straße (Höhe Nr. 62-66)"), "General-Pape-Straße");
  assert.equal(strassenName("(West)"), null);
  assert.equal(strassenName(""), null);
});

test("zuordnung: Umkreis und Rückfall je Stelle, belegte Links von vorher", () => {
  // eine Straße nach Norden (0°) und zurück, dazu eine Querstraße nach Osten 30 m weiter südlich
  const links = [
    { id: "nord", modes: "car", xy: Float64Array.from([0, 0, 0, 100]) },
    { id: "sued", modes: "car", xy: Float64Array.from([4, 100, 4, 0]) },
    { id: "ost", modes: "car", xy: Float64Array.from([-50, -30, 50, -30]) },
  ];
  const index = new LinkIndex(links, 50);
  const p = { radius: 50, maxWinkel: 60, winkelGewicht: 0.3, nameBonus: 10, maxKandidaten: 6 };
  // Richtung Nordost (45°) liegt 45° neben „nord“ und „ost“: im allgemeinen Umkreis beide
  const weit = kandidaten(index, { x: 1, y: 10, grad: 45, modi: ["car"] }, p);
  assert.deepEqual(weit.map((k) => links[k.i].id), ["nord", "ost"]);
  // mit eigenem Umkreis von 20 m nur der Link am Punkt
  assert.deepEqual(kandidaten(index, { x: 1, y: 10, grad: 45, modi: ["car"], radius: 20 }, p).map((k) => links[k.i].id), ["nord"]);
  // 70° daneben: als Rückfall zum Prüfen, mit rueckfall: false nicht
  assert.deepEqual(kandidaten(index, { x: 1, y: 10, grad: 70, modi: ["car"], radius: 20 }, p).map((k) => [links[k.i].id, k.weit]), [["nord", true]]);
  assert.deepEqual(kandidaten(index, { x: 1, y: 10, grad: 70, modi: ["car"], radius: 20, rueckfall: false }, p), []);
  // was vorher vergeben ist, nimmt niemand automatisch; von Hand geht es trotzdem
  const k = (i, score) => ({ i, d: score, score });
  const alle = [[k(0, 1), k(1, 5)], [k(2, 1)]];
  const vorher = new Map([[0, new Set(["car"])]]);
  assert.deepEqual(verteile(alle, new Map(), [["car"], ["car"]], vorher).map((w) => w?.i), [1, 2]);
  assert.deepEqual(verteile(alle, new Map(), [["bike"], ["car"]], vorher).map((w) => w?.i), [0, 2], "ein anderes Verkehrsmittel darf");
  assert.deepEqual(verteile(alle, new Map([[0, 0]]), [["car"], ["car"]], vorher).map((w) => w?.i), [undefined, 2]);
  assert.deepEqual([...vorher.get(0)], ["car"], "vorher bleibt unverändert");
});

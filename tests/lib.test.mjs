// Tests der Bausteine ohne Browser: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { richtung, kompass, kurz, winkelAbstand } from "../lib/richtung.js";
import { crsDefinition, projektion } from "../lib/crs.js";
import { leseNetz, leseLinkGeometrien } from "../lib/netz.js";
import { LinkIndex, kandidaten, verteile, naechsterPunkt, namePasst, erlaubt } from "../lib/zuordnung.js";
import { leseIndex, tagArt, tagNr, isoTag, wochentag, leseStunden, richtungAusNamen } from "../lib/zaehlkarte.js";
import { mittle, tagGilt, aggregatText, auswahlText, zeitraum, VORGABE } from "../lib/mitteln.js";
import { countsXml, zuordnungCsv, leseZuordnungCsv, zahl } from "../lib/counts.js";

const bytes = (s) => new TextEncoder().encode(s);
async function gzip(s) {
  const stream = new Blob([bytes(s)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("richtung: die Schreibweisen der Quellen", () => {
  assert.deepEqual(richtung("Richtung AK Zehlendorf (Südwest)"), { art: "gerichtet", grad: 225, ziel: "AK Zehlendorf" });
  assert.deepEqual(richtung("Richtung Norden"), { art: "gerichtet", grad: 0, ziel: null });
  assert.deepEqual(richtung("Richtung Stuttgart (Osten)"), { art: "gerichtet", grad: 90, ziel: "Stuttgart" });
  assert.deepEqual(richtung("von Nord nach Süd"), { art: "gerichtet", grad: 180, ziel: null });
  assert.deepEqual(richtung("von Ost nach West"), { art: "gerichtet", grad: 270, ziel: null });
  assert.deepEqual(richtung("ohne Richtung (Querschnitt)"), { art: "beide", grad: null, ziel: null });
  assert.deepEqual(richtung(null), { art: "ohne", grad: null, ziel: null });
  // ein Ortsname, der mit einer Himmelsrichtung anfängt, ist keine
  assert.deepEqual(richtung("Richtung Nordhausen"), { art: "gerichtet", grad: null, ziel: "Nordhausen" });
  assert.deepEqual(richtung("Richtung Lindleinsmühle, Versbach"), { art: "gerichtet", grad: null, ziel: "Lindleinsmühle, Versbach" });
  assert.equal(kompass("Nordosten"), 45);
  assert.equal(kompass("Nordhausen"), null);
  assert.equal(kurz(225), "SW");
  assert.equal(kurz(359), "N");
  assert.equal(winkelAbstand(350, 10), 20);
  assert.equal(winkelAbstand(90, 270), 180);
});

test("crs: Schreibweisen und Umrechnung", () => {
  assert.equal(crsDefinition("EPSG:25832").code, "EPSG:25832");
  assert.equal(crsDefinition("epsg:25833").code, "EPSG:25833");
  assert.equal(crsDefinition("25832").code, "EPSG:25832");
  assert.equal(crsDefinition("urn:ogc:def:crs:EPSG::31468").code, "EPSG:31468");
  assert.equal(crsDefinition("DHDN_GK4").code, "EPSG:31468");
  assert.throws(() => crsDefinition("EPSG:9999"), /kennt die Seite nicht/);
  assert.throws(() => crsDefinition("Atlantis"), /kein bekanntes/);
  assert.equal(crsDefinition("+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs").name, "eigene Definition");
  const p = projektion("EPSG:25832");
  const [x, y] = p.vonWgs(11.5, 48.1);
  const [lon, lat] = p.zuWgs(x, y);
  assert.ok(Math.abs(lon - 11.5) < 1e-8 && Math.abs(lat - 48.1) < 1e-8);
  // 2,5° östlich des Mittelmeridians 9°: rund 186 km östlich von 500 km
  assert.ok(Math.abs(x - 686121.8) < 1 && Math.abs(y - 5330438.1) < 1, `${x} ${y}`);
  assert.equal(projektion("EPSG:4326").geographisch, true);
  // Gauß-Krüger mit Datumsübergang (Bessel, 7 Parameter); mit diesen Werten liegen die Berliner
  // Detektoren im Mittel 8 m neben den Links des Berliner Beispielnetzes aus matsim-libs
  const gk = projektion("EPSG:31468").vonWgs(13.4132, 52.5219);
  assert.ok(Math.abs(gk[0] - 4596024.1) < 1 && Math.abs(gk[1] - 5821914.6) < 1, `${gk}`);
});

const NETZ = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE network SYSTEM "http://www.matsim.org/files/dtd/network_v2.dtd">
<network>
  <attributes><attribute name="coordinateReferenceSystem" class="java.lang.String">EPSG:25832</attribute></attributes>
  <nodes>
    <node id="a" x="0" y="0"/>
    <node id="b" x="100" y="0"/>
    <node id="c" x="100" y="100"/>
  </nodes>
  <links capperiod="01:00:00">
    <link id="ab" from="a" to="b" length="100" freespeed="13.89" capacity="1800" permlanes="1" modes="car,bike">
      <attributes><attribute name="type" class="java.lang.String">highway.primary</attribute><attribute name="name" class="java.lang.String">Hauptstraße</attribute><attribute name="egal" class="java.lang.String">weg</attribute></attributes>
    </link>
    <link id="ba" from="b" to="a" length="100" freespeed="13.89" capacity="1800" permlanes="1" modes="car,bike"/>
    <!-- <link id="alt" from="a" to="c" length="1" freespeed="1" capacity="1" permlanes="1" modes="car"/> -->
    <link id="bc" from="b" to="c" length="120" freespeed="8.33" capacity="600" permlanes="1" modes="bike"/>
    <link id="bus" from="a" to="c" length="150" freespeed="8.33" capacity="600" permlanes="1" modes="pt,bus"/>
  </links>
</network>`;

test("netz: Links, CRS, Kommentare und Geometrien", async () => {
  const geo = await leseLinkGeometrien(bytes('LinkId,Geometry\nbc,"(100.0,100.0),(150.0,50.0),(100.0,0.0)"\n'));
  const r = await leseNetz(await gzip(NETZ), geo.map);
  assert.equal(r.crs, "EPSG:25832");
  assert.equal(r.nodes, 3);
  assert.deepEqual(r.links.map((l) => l.id), ["ab", "ba", "bc", "bus"]);
  const ab = r.links[0];
  assert.equal(ab.type, "highway.primary");
  assert.equal(ab.name, "Hauptstraße");
  assert.deepEqual([...ab.xy], [0, 0, 100, 0]);
  // die CSV läuft gegen den Link (c nach b) und wird umgedreht
  assert.deepEqual([...r.links[2].xy], [100, 0, 150, 50, 100, 100]);
  assert.equal(r.stats.ptLinks, 1);
  assert.equal(r.stats.fromCsv, 1);
});

test("zuordnung: Richtung entscheidet zwischen Hin- und Rückrichtung", async () => {
  const r = await leseNetz(bytes(NETZ), null);
  const index = new LinkIndex(r.links, 50);
  const p = { radius: 30, maxWinkel: 60, winkelGewicht: 0.3, nameBonus: 10, maxKandidaten: 6 };
  // Stelle 3 m neben der Straße, Fahrtrichtung Ost
  const ost = kandidaten(index, { x: 50, y: 3, grad: 90, name: "Hauptstraße", modi: ["car"] }, p);
  assert.deepEqual(ost.map((k) => r.links[k.i].id), ["ab"]);
  assert.equal(ost[0].name, true);
  assert.ok(Math.abs(ost[0].d - 3) < 1e-9 && ost[0].abweichung === 0 && Math.abs(ost[0].anteil - 0.5) < 1e-9);
  const west = kandidaten(index, { x: 50, y: 3, grad: 270, name: null, modi: ["car"] }, p);
  assert.deepEqual(west.map((k) => r.links[k.i].id), ["ba"]);
  // ohne Himmelsrichtung beide, gleich weit
  const offen = kandidaten(index, { x: 50, y: 3, grad: null, name: null, modi: ["car"] }, p);
  assert.deepEqual(offen.map((k) => r.links[k.i].id).sort(), ["ab", "ba"]);
  // bike-Link nur für Rad, pt nie
  const rad = kandidaten(index, { x: 102, y: 50, grad: null, name: null, modi: ["bike"] }, p);
  assert.deepEqual(rad.map((k) => r.links[k.i].id), ["bc"]);
  assert.equal(erlaubt({ modes: "" }, ["car"]), true);
  assert.equal(erlaubt({ modes: "pt,bus" }, ["car"]), false);
});

test("zuordnung: jeder Link nur einmal, Zuordnungen von Hand gehen vor", () => {
  const k = (i, score) => ({ i, d: score, score });
  const alle = [
    [k(0, 5), k(1, 9)], // Stelle 0
    [k(0, 2), k(2, 8)], // Stelle 1 will denselben Link, näher
    [k(3, 1)],
  ];
  const wahl = verteile(alle);
  assert.deepEqual(wahl.map((w) => w?.i), [1, 0, 3]);
  const vonHand = verteile(alle, new Map([[2, 0]]));
  assert.deepEqual(vonHand.map((w) => w?.i), [1, 2, undefined]);
  // eine Kfz- und eine Rad-Stelle dürfen denselben Link haben, zwei Kfz-Stellen nicht
  assert.deepEqual(verteile(alle, new Map(), [["car"], ["bike"], ["car"]]).map((w) => w?.i), [0, 0, 3]);
  assert.deepEqual(verteile(alle, new Map(), [["car"], ["car", "truck"], ["bike"]]).map((w) => w?.i), [1, 0, 3]);
  // Link 0 von Hand an Stelle 2 (car): die Rad-Stelle 1 teilt ihn, die Kfz-Stelle 0 weicht aus
  assert.deepEqual(verteile(alle, new Map([[2, 0]]), [["car"], ["bike"], ["car"]]).map((w) => w?.i), [1, 0, undefined]);
});

test("zuordnung: lange Segmente ohne Zwischenpunkte", () => {
  const links = [{ id: "lang", modes: "car", xy: Float64Array.from([0, 0, 20000, 15000]) }];
  const index = new LinkIndex(links, 50);
  const mitte = kandidaten(index, { x: 10000 + 6, y: 7500 - 8, grad: null, name: null, modi: ["car"] }, { radius: 50, maxWinkel: 60, winkelGewicht: 0, nameBonus: 0, maxKandidaten: 3 });
  assert.equal(mitte.length, 1);
  assert.ok(Math.abs(mitte[0].d - 10) < 1e-6);
  assert.ok(index.raster.size < 2000, `${index.raster.size} Zellen`);
  const n = naechsterPunkt(0, 10, Float64Array.from([0, 0, 0, 100]));
  assert.equal(n.grad, 0);
  assert.ok(namePasst("A115", "A 115"));
  assert.ok(namePasst("Berliner Straße", "Berliner Str."));
  assert.ok(!namePasst("Clayallee", "Argentinische Allee"));
});

const INDEX = {
  version: 5,
  erzeugt: "2026-11-16",
  gruppen: ["kfz", "lkw", "sv", "rad", "fuss"],
  dateien: { details: "dauer/{n}.json" },
  von: "2024-07-01",
  kalender: { BE: "sssssww" + "ffff" + "h" + "ww" }, // Mo 2024-07-01 bis So 2024-07-14
  quellen: [
    { code: "berlin_viz", name: "Berlin", land: "BE", lizenzen: [{ code: "berlin_viz", lizenz: "dl-de/by-2-0", lizenz_url: "https://www.govdata.de/dl-de/by-2-0" }] },
    { code: "ohne", name: "Ohne Lizenz", land: "BE", lizenzen: [{ code: "ohne", lizenz: null }] },
  ],
  stellen: {
    felder: ["id", "quelle", "name", "abschnitt", "richtung", "lon", "lat", "von", "bis", "g", "ags", "chunk"],
    werte: [
      ["berlin_viz:TE001", "berlin_viz", "A115", "AS Spanische Allee", "Richtung AK Zehlendorf (Südwest)", 13.19, 52.43, "2015-01-01", "2025-06-21", 3, "11000000", 0],
      ["ohne:1", "ohne", "Weg", null, null, 13.2, 52.4, "2020-01-01", "2025-01-01", 8, "11000000", 1],
    ],
  },
};

test("zaehlkarte: Index, Lizenzen, Kalender, Tage", () => {
  const d = leseIndex(INDEX);
  assert.equal(d.stellen.length, 2);
  const s = d.stellen[0];
  assert.deepEqual(s.gruppen, ["kfz", "lkw"]);
  assert.equal(s.r.grad, 225);
  assert.equal(s.land, "BE");
  assert.equal(d.quellen.get("berlin_viz").hatLizenz, true);
  assert.equal(d.quellen.get("ohne").hatLizenz, false);
  assert.deepEqual(d.stellen[1].gruppen, ["rad"]);
  assert.equal(isoTag(tagNr("2024-07-02")), "2024-07-02");
  assert.equal(wochentag(tagNr("2024-07-02")), 2); // Dienstag
  assert.equal(tagArt(d, "BE", tagNr("2024-07-01")), "s");
  assert.equal(tagArt(d, "BE", tagNr("2024-07-08")), "f");
  assert.equal(tagArt(d, "BE", tagNr("2024-07-12")), "h");
  assert.equal(tagArt(d, "BE", tagNr("2030-01-01")), "u");
  assert.equal(tagArt(d, "HH", tagNr("2024-07-01")), "u");
  assert.throws(() => leseIndex({}), /keine dauer\/index.json/);
});

test("zaehlkarte: Berliner Rad-Zählstellen tragen die Richtung im Namen oder in der Kennung", () => {
  const stelle = (id, quelle, name) => [id, quelle, name, null, null, 13.4, 52.5, "2020-01-01", "2025-12-31", 8, "11000000", 0];
  const d = leseIndex({
    ...INDEX,
    quellen: [...INDEX.quellen, { code: "berlin_rad", land: "BE", lizenzen: [{ code: "berlin_rad", lizenz: "dl-de/zero-2-0" }] }, { code: "mobidata_rad", land: "BW", lizenzen: [{ code: "mobidata_rad", lizenz: "dl-de/by-2-0" }] }],
    stellen: {
      felder: INDEX.stellen.felder,
      werte: [
        stelle("berlin_rad:02-MI-JAN-N", "berlin_rad", "Jannowitzbrücke Nord"),
        stelle("berlin_rad:03-MI-SAN-W", "berlin_rad", "Invalidenstraße West"),
        stelle("berlin_rad:01-MI-AL-W", "berlin_rad", "Karl-Marx-Allee"),
        stelle("berlin_rad:04-MI-NO", "berlin_rad", "Nordufer"),
        stelle("berlin_rad:12-PA-SCH", "berlin_rad", "Schwedter Steg"),
        stelle("mobidata_rad:100027946", "mobidata_rad", "Route Nord"),
      ],
    },
  });
  assert.deepEqual(d.stellen.map((s) => [s.r.art, s.r.grad]), [
    ["gerichtet", 0], ["gerichtet", 270], ["gerichtet", 270], ["ohne", null], ["ohne", null], ["ohne", null],
  ]);
  assert.equal(d.stellen[0].r.ausNamen, true);
  assert.equal(richtungAusNamen("Messe-Allee (Ost-West)", "1"), null);
  assert.equal(richtungAusNamen("Mariendorfer Damm Süd", "20-TS-MAR-S"), 180);
});

test("mitteln: Tage wählen, Mittel, Median, Mindestzahl, Zeitumstellung", () => {
  const d = leseIndex(INDEX);
  const stelle = d.stellen[0];
  const tag = (v) => Array.from({ length: 24 }, (_, h) => (h === 5 ? null : v + h));
  // Tag i (ab Mo 07-01) hat die Werte 100 * (i + 1) + Stunde: Di 07-02 200, Di 07-09 900 …
  const reihe = Array.from({ length: 14 }, (_, i) => tag(100 * (i + 1)));
  reihe[3] = null; // Do 07-04 ohne Werte
  const stunden = leseStunden({ stunden_von: "2024-07-01", stunden: { kfz: reihe }, doppelt: ["2024-07-03"] });
  const opts = { ...VORGABE, minTage: 1, nurVollstaendig: false };
  // Di und Mi sind Schultage, Mi hat aber die doppelte Stunde: bleibt Di 07-02 (Wert 200 + h)
  let r = mittle(d, stelle, stunden, "kfz", opts);
  assert.equal(r.tageGenutzt, 1);
  assert.equal(r.werte[0], 200);
  assert.equal(r.werte[5], null);
  assert.equal(r.vollstaendig, false);
  // nur dienstags, mit Ferien: Di 07-09 (900 + h) kommt dazu
  r = mittle(d, stelle, stunden, "kfz", { ...opts, wochentage: [2], tagesarten: ["s", "f"] });
  assert.equal(r.tageGenutzt, 2);
  assert.equal(r.werte[1], (201 + 901) / 2);
  // Mo bis Fr, Schul- und Ferientage: 100, 200, 500 (Fr), 800, 900, 1000, 1100; Mi 07-03 hat die
  // doppelte Stunde, Do 07-04 keine Werte, Fr 07-12 ist Feiertag
  r = mittle(d, stelle, stunden, "kfz", { ...opts, tagesarten: ["s", "f"], statistik: "median", wochentage: [1, 2, 3, 4, 5] });
  assert.equal(r.tageGenutzt, 7);
  assert.equal(r.werte[0], 800);
  assert.equal(mittle(d, stelle, stunden, "kfz", { ...opts, minTage: 2 }).werte[0], null);
  // Samstag ohne Blick auf den Kalender
  assert.equal(tagGilt(d, "BE", tagNr("2024-07-06"), { ...opts, wochentage: [6] }), true);
  assert.deepEqual(zeitraum(stunden), [tagNr("2024-07-01"), tagNr("2024-07-14")]);
  assert.equal(aggregatText({ ...VORGABE, von: tagNr("2024-07-01"), bis: tagNr("2025-06-30") }, "midweek"), "midweek=TUESDAY,WEDNESDAY,THURSDAY@2024-07-01:2025-06-30");
  assert.match(auswahlText(VORGABE), /^Mittel je Stunde über Di, Mi, Do \(Mo–Fr nur Schultage\), mindestens 5 Tage je Stunde$/);
});

test("counts: XML nach counts_v2 und Zuordnung als CSV", () => {
  const x = countsXml({
    name: "Test & Co",
    source: "Zählkarte",
    description: "Mittel <je> Stunde",
    year: 2025,
    attributes: [["quellen", "berlin_viz: dl-de/by-2-0"], ["min_tage", 5], ["leer", ""]],
    locations: [{
      refId: "ab",
      id: "berlin_viz:TE001",
      name: "A115",
      x: 4581211.8905,
      y: 5811848.9,
      attributes: [["richtung", "Richtung AK Zehlendorf (Südwest)"], ["abstand_m", 3.456], ["gerundet", 5, "java.lang.Double"]],
      measurements: [{ type: "volumes", networkMode: "car", interval: 3600, values: [[0, 226.04], [3600, 144]] }],
    }],
  });
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<counts xmlns="http:\/\/www.matsim.org\/files\/dtd"/);
  assert.match(x, /name="Test &amp; Co"/);
  assert.match(x, /description="Mittel &lt;je&gt; Stunde"/);
  assert.match(x, /year="2025">/);
  assert.match(x, /<attribute name="min_tage" class="java.lang.Integer">5<\/attribute>/);
  assert.doesNotMatch(x, /name="leer"/);
  assert.match(x, /<location refId="ab" id="berlin_viz:TE001" name="A115" x="4581211.89" y="5811848.9">/);
  assert.match(x, /<attribute name="abstand_m" class="java.lang.Double">3.46<\/attribute>/);
  assert.match(x, /<attribute name="gerundet" class="java.lang.Double">5.0<\/attribute>/);
  assert.match(x, /<measurements type="volumes" networkMode="car" interval="3600">\n\t\t\t<value t="0" val="226.0"\/>\n\t\t\t<value t="3600" val="144.0"\/>/);
  assert.throws(() => countsXml({ year: 2025.5, locations: [] }), /Jahr/);
  assert.equal(zahl(1234.5678), "1234.6");
  assert.equal(zahl(2), "2.0");

  const csv = zuordnungCsv([
    { station: "berlin_viz:TE001", linkid: "ab", using: true, kommentar: 'passt; "sicher"', zuordnung: "geprüft", abstand_m: 3.5, richtung: "SW", name: "A115", quelle: "berlin_viz" },
    { station: "berlin_viz:TE002", linkid: "", using: false, kommentar: "", zuordnung: "ausgelassen", abstand_m: null, richtung: "NO", name: "A115", quelle: "berlin_viz" },
  ]);
  assert.equal(csv.split("\n")[0], "station;linkid;using;kommentar;zuordnung;abstand_m;richtung;name;quelle;anker_lon;anker_lat;anker_grad;osm_weg;netz");
  assert.equal(csv.split("\n")[1], 'berlin_viz:TE001;ab;y;"passt; ""sicher""";geprüft;3.5;SW;A115;berlin_viz;;;;;');
  assert.deepEqual(leseZuordnungCsv(csv), [
    { station: "berlin_viz:TE001", linkid: "ab", using: true, kommentar: 'passt; "sicher"', zuordnung: "geprüft", anker: null, weg: null, netz: null },
    { station: "berlin_viz:TE002", linkid: "", using: false, kommentar: "", zuordnung: "ausgelassen", anker: null, weg: null, netz: null },
  ]);
  // wie input/counts_mapping.csv im Berliner Szenario: Using leer heißt auslassen
  assert.deepEqual(leseZuordnungCsv("MQ_ID;linkid;Using;Kommentar;Check\n10016;80205;;same as 10015;\n10017;4711;x;;\n"), [
    { station: "10016", linkid: "80205", using: false, kommentar: "same as 10015", zuordnung: null, anker: null, weg: null, netz: null },
    { station: "10017", linkid: "4711", using: true, kommentar: "", zuordnung: null, anker: null, weg: null, netz: null },
  ]);
  // ohne using und ignore: alle verwenden; linkid vorne: Station in Spalte zwei
  assert.deepEqual(leseZuordnungCsv("link_id,station\n1,A\n"), [{ station: "A", linkid: "1", using: true, kommentar: "", zuordnung: null, anker: null, weg: null, netz: null }]);
  assert.deepEqual(leseZuordnungCsv("station;linkid;ignore\nA;1;y\nB;2;\n").map((z) => z.using), [false, true]);
  assert.throws(() => leseZuordnungCsv("station;link\nA;1\n"), /linkid/);
});

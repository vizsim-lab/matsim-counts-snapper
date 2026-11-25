// Tests des Gebiets (lib/gebiet.js) mit kleinen, erfundenen Dateien: GeoJSON, .poly, Shapefile, ZIP
import { test } from "node:test";
import assert from "node:assert/strict";
import { shp, zip } from "./hilfen/dateien.mjs";
import { baueGebiet, imGebiet, inRing, flaeche, gebietGeojson, leseGeojson, lesePoly, leseShp, leseZip, crsAusPrj, siehtNachGradAus, umrechnen, ueberschneidet, MAX_PUNKTE } from "../lib/gebiet.js";
import { projektion } from "../lib/crs.js";
import { setzeSprache } from "../lib/sprache.js";

// Die Bausteine sprechen hier Deutsch; Englisch prüft sprache.test.mjs
setzeSprache("de");

// ein Quadrat um den Alexanderplatz, etwa 1 km Kante, mit einem Loch in der Mitte
const LON = 13.4132;
const LAT = 52.5219;
const DX = 0.5 / (111.32 * Math.cos((LAT * Math.PI) / 180)); // 500 m in Grad
const DY = 0.5 / 110.54;
const quadrat = (f = 1) => [[LON - DX * f, LAT - DY * f], [LON + DX * f, LAT - DY * f], [LON + DX * f, LAT + DY * f], [LON - DX * f, LAT + DY * f]];

test("gebiet: Punkt im Polygon, Löcher, mehrere Polygone, Rechteck vorab", () => {
  const g = baueGebiet({ name: "Mitte", polygone: [[quadrat(), quadrat(0.2)], [quadrat(0.3).map(([x, y]) => [x + 4 * DX, y])]] });
  assert.equal(g.polygone.length, 2);
  assert.equal(imGebiet(g, LON + 0.5 * DX, LAT), true);
  assert.equal(imGebiet(g, LON, LAT), false, "im Loch");
  assert.equal(imGebiet(g, LON + 4 * DX, LAT), true, "im zweiten Polygon");
  assert.equal(imGebiet(g, LON + 2.5 * DX, LAT), false, "dazwischen");
  assert.equal(imGebiet(g, LON, LAT + 5 * DY), false, "außerhalb des Rechtecks");
  assert.equal(imGebiet(null, 0, 0), true, "ohne Gebiet zählt alles");
  assert.equal(ueberschneidet(g, [LON + 10 * DX, LAT, LON + 11 * DX, LAT + DY]), false);
  assert.equal(ueberschneidet(g, [LON, LAT, LON + 11 * DX, LAT + DY]), true);
  assert.equal(inRing(0.5, 0.5, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]), true, "geschlossener Ring");
});

test("gebiet: säubern, Rechteck, Fläche, Fehler", () => {
  const g = baueGebiet({ name: "Quadrat", art: "gezeichnet", polygone: [[[...quadrat(), quadrat()[0]]]] });
  assert.equal(g.polygone[0][0].length, 4, "Schlusspunkt fällt weg");
  assert.equal(g.art, "gezeichnet");
  assert.ok(Math.abs(g.flaeche_km2 - 1) < 0.01, `Fläche ${g.flaeche_km2}`);
  assert.ok(Math.abs(flaeche([[quadrat(), quadrat(0.5)]]) - 0.75) < 0.01, "Loch abgezogen");
  assert.deepEqual(g.bbox.map((x) => Math.round(x * 1e4)), [LON - DX, LAT - DY, LON + DX, LAT + DY].map((x) => Math.round(x * 1e4)));
  assert.throws(() => baueGebiet({ polygone: [] }), /keine Fläche/);
  assert.throws(() => baueGebiet({ polygone: [[[[1, 1], [2, 2]]]] }), /keine Fläche/);
  assert.throws(() => baueGebiet({ polygone: [[[[390000, 5800000], [391000, 5800000], [391000, 5801000]]]] }), /nicht in WGS 84/);
});

test("gebiet: große Gebiete werden vereinfacht, die Fläche bleibt", () => {
  const n = 5000;
  const kreis = Array.from({ length: n }, (_, i) => [LON + DX * 2 * Math.cos((2 * Math.PI * i) / n), LAT + DY * 2 * Math.sin((2 * Math.PI * i) / n)]);
  const g = baueGebiet({ polygone: [[kreis]] });
  assert.equal(g.vereinfacht, true);
  assert.ok(g.punkte < MAX_PUNKTE && g.punkte < n / 5, `${g.punkte} Punkte`);
  const soll = Math.PI; // Radius 1 km
  assert.ok(Math.abs(g.flaeche_km2 - soll) / soll < 0.005, `Fläche ${g.flaeche_km2}`);
  assert.equal(baueGebiet({ polygone: [[quadrat()]] }).vereinfacht, false);
  // aus einer Konfiguration: nicht noch einmal vereinfachen
  const roh = baueGebiet({ polygone: [[kreis]], vereinfachen: false });
  assert.equal(roh.punkte, n);
  assert.equal(roh.vereinfacht, false);
});

test("gebiet: Punkte gerundet wie in der Konfiguration, wieder eingelesen dasselbe", () => {
  const g = baueGebiet({ name: "x", art: "gezeichnet", polygone: [[[[13.123456789, 52.987654321], [13.2, 52.9], [13.3, 53.0]]]] });
  assert.deepEqual(g.polygone[0][0][0], [13.123457, 52.987654]);
  const wieder = baueGebiet({ name: "x", art: "gezeichnet", polygone: leseGeojson(gebietGeojson(g)).polygone, vereinfachen: false });
  assert.deepEqual(wieder.polygone, g.polygone);
  assert.deepEqual(wieder.bbox, g.bbox);
});

test("gebiet: GeoJSON hin und zurück, andere Geometrien und CRS", () => {
  const g = baueGebiet({ name: "Mitte", art: "gezeichnet", polygone: [[quadrat(), quadrat(0.2)]] });
  const f = gebietGeojson(g);
  assert.equal(f.geometry.type, "MultiPolygon");
  const ring = f.geometry.coordinates[0][0];
  assert.deepEqual(ring[0], ring[ring.length - 1], "Ringe geschlossen");
  assert.equal(String(ring[1][0]).split(".")[1].length <= 6, true);
  const zurueck = leseGeojson(f);
  assert.equal(zurueck.crs, null);
  const g2 = baueGebiet({ name: "Mitte", polygone: zurueck.polygone });
  assert.equal(imGebiet(g2, LON, LAT), false);
  assert.equal(imGebiet(g2, LON + 0.5 * DX, LAT), true);
  const fc = {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::25833" } },
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] } },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] } },
      { type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[[[20, 0], [30, 0], [30, 10], [20, 0]]], [[[40, 0], [50, 0], [50, 10], [40, 0]]]] } },
      { type: "Feature", geometry: null },
    ],
  };
  const r = leseGeojson(fc);
  assert.equal(r.polygone.length, 3);
  assert.equal(r.crs, "urn:ogc:def:crs:EPSG::25833");
  assert.equal(leseGeojson({ ...fc, crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } } }).crs, null);
  assert.equal(leseGeojson({ type: "Polygon", coordinates: [quadrat()] }).polygone.length, 1);
  assert.throws(() => leseGeojson({ hallo: 1 }), /kein GeoJSON/);
});

test("gebiet: .poly mit Loch und zweitem Polygon", () => {
  const poly = `berlin_mitte
1
   1.340000E+01   5.250000E+01
   1.345000E+01   5.250000E+01
   1.345000E+01   5.255000E+01
   1.340000E+01   5.255000E+01
   1.340000E+01   5.250000E+01
END
!1-loch
   13.42 52.52
   13.43 52.52
   13.43 52.53
END
2
   13.50 52.50
   13.51 52.50
   13.51 52.51
END
END
`;
  const r = lesePoly(poly);
  assert.equal(r.name, "berlin_mitte");
  assert.equal(r.polygone.length, 2);
  assert.equal(r.polygone[0].length, 2, "das Loch gehört zum ersten");
  const g = baueGebiet({ name: r.name, polygone: r.polygone });
  assert.equal(imGebiet(g, 13.41, 52.51), true);
  assert.equal(imGebiet(g, 13.428, 52.522), false, "im Loch");
  assert.equal(imGebiet(g, 13.508, 52.502), true);
  assert.throws(() => lesePoly("name\n1\n 13 52\n"), /END/);
  assert.throws(() => lesePoly(""), /keine .poly/);
});

// Ringe in Metern (ETRS89 / UTM 33N) um den Alexanderplatz; außen im Uhrzeigersinn, Löcher dagegen
const X = 392000;
const Y = 5820500;
const uhr = (d, dx = 0) => [[X - d + dx, Y - d], [X - d + dx, Y + d], [X + d + dx, Y + d], [X + d + dx, Y - d], [X - d + dx, Y - d]];
const gegen = (d, dx = 0) => uhr(d, dx).reverse();

test("gebiet: Shapefile mit Loch, PolygonZ und leerem Datensatz; nach WGS 84", () => {
  const bytes = shp([{ ringe: [uhr(500), gegen(100)] }, { typ: 0 }, { typ: 15, ringe: [uhr(200, 3000)] }]);
  const polygone = leseShp(bytes);
  assert.equal(polygone.length, 2);
  assert.equal(polygone[0].length, 2, "Loch beim ersten");
  assert.equal(siehtNachGradAus(polygone), false);
  const p = projektion("EPSG:25833");
  const g = baueGebiet({ name: "aus shp", polygone: umrechnen(polygone, p.zuWgs) });
  const [lon, lat] = p.zuWgs(X + 300, Y);
  assert.equal(imGebiet(g, lon, lat), true);
  const [lonL, latL] = p.zuWgs(X, Y);
  assert.equal(imGebiet(g, lonL, latL), false, "im Loch");
  const [lonZ, latZ] = p.zuWgs(X + 3000, Y);
  assert.equal(imGebiet(g, lonZ, latZ), true, "PolygonZ");
  // andersherum geschrieben: alle Ringe gelten als äußere
  assert.equal(leseShp(shp([{ ringe: [gegen(500), gegen(100, 3000)] }])).length, 2);
  const punkte = shp([], 1);
  assert.throws(() => leseShp(punkte), /Punkte, keine Flächen/);
  assert.throws(() => leseShp(new Uint8Array(120)), /keine Shapefile/);
});

test("gebiet: Koordinatensystem aus der .prj", () => {
  const esri = 'PROJCS["ETRS_1989_UTM_Zone_33N",GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",15.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  assert.equal(crsAusPrj(esri), "EPSG:25833");
  assert.equal(crsAusPrj('PROJCS["DHDN_3_Degree_Gauss_Zone_4",GEOGCS["GCS_Deutsches_Hauptdreiecksnetz",DATUM["D_Deutsches_Hauptdreiecksnetz",SPHEROID["Bessel_1841",6377397.155,299.1528128]]]]'), "EPSG:31468");
  assert.equal(crsAusPrj('PROJCS["WGS 84 / UTM zone 32N",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32632"]]'), "EPSG:32632");
  assert.equal(crsAusPrj('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'), "EPSG:4326");
  assert.equal(crsAusPrj('PROJCRS["ETRS89 / UTM zone 32N",BASEGEOGCRS["ETRS89"],ID["EPSG",25832]]'), "EPSG:25832");
  assert.equal(crsAusPrj('PROJCS["DHDN / 3-degree Gauss-Kruger zone 3",GEOGCS["DHDN"]]'), "EPSG:31467");
  const fremd = 'PROJCS["Irgendwas",GEOGCS["X"]]';
  assert.equal(crsAusPrj(fremd), fremd, "sonst die WKT für proj4");
  assert.equal(crsAusPrj("  "), null);
});

test("gebiet: Shapefile aus einer ZIP-Datei, gepackt und ungepackt", async () => {
  const enc = new TextEncoder();
  const bytes = zip([
    ["gebiet/berlin.shp", shp([{ ringe: [uhr(500)] }]), true],
    ["gebiet/berlin.prj", enc.encode('PROJCS["ETRS_1989_UTM_Zone_33N",GEOGCS["GCS_ETRS_1989"]]'), false],
    ["gebiet/berlin.dbf", new Uint8Array(10), false],
    ["__MACOSX/gebiet/._berlin.shp", new Uint8Array(5), false],
  ]);
  const dateien = await leseZip(bytes, (n) => /\.(shp|prj)$/i.test(n));
  assert.deepEqual([...dateien.keys()].sort(), ["gebiet/berlin.prj", "gebiet/berlin.shp"]);
  const polygone = leseShp(dateien.get("gebiet/berlin.shp"));
  assert.equal(polygone.length, 1);
  assert.equal(crsAusPrj(new TextDecoder().decode(dateien.get("gebiet/berlin.prj"))), "EPSG:25833");
  await assert.rejects(() => leseZip(new Uint8Array(100)), /keine ZIP-Datei/);
});

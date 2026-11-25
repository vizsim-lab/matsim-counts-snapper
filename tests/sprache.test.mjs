// Die Bausteine auf Englisch, der Vorgabe der Seite; Deutsch prüfen die anderen Tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tx, sprache, setzeSprache, zahl, anzahl, VORGABE, SPRACHEN } from "../lib/sprache.js";
import { crsVorschlag } from "../lib/crsvorschlag.js";
import { crsDefinition } from "../lib/crs.js";
import { kurz } from "../lib/richtung.js";
import { OSM_FILTER } from "../lib/osm.js";
import { auswahlText, VORGABE as MITTEL } from "../lib/mitteln.js";
import { leseZuordnungCsv } from "../lib/counts.js";

test("sprache: Vorgabe Englisch, nur „de“ macht Deutsch", () => {
  assert.equal(VORGABE, "en");
  assert.deepEqual(SPRACHEN, ["en", "de"]);
  assert.equal(sprache(), "en");
  assert.equal(tx("Netz", "Network"), "Network");
  for (const s of [null, "", "fr", "EN", "en-GB"]) assert.equal(setzeSprache(s), "en", String(s));
  assert.equal(setzeSprache("de-DE"), "de");
  assert.equal(tx("Netz", "Network"), "Netz");
  assert.equal(zahl(1234.5, 1), "1.234,5");
  assert.equal(anzahl(1, "Link", "Links"), "1 Link");
  setzeSprache("en");
  assert.equal(zahl(1234.5, 1), "1,234.5");
  assert.equal(anzahl(2, "link", "links"), "2 links");
});

test("sprache: Meldungen der Bausteine auf Englisch", () => {
  setzeSprache("en");
  assert.equal(crsVorschlag({ code: "EPSG:25832", imLand: true, stellen: 0 }, [{ code: "EPSG:25833", stellen: 9 }]).text, "With EPSG:25832 there is no permanent counter of the Zählkarte in the network area. With EPSG:25833 there would be 9.");
  assert.equal(crsVorschlag({ code: "EPSG:31468", imLand: false, stellen: 0 }, [{ code: "EPSG:25832", stellen: 1 }]).text, "With EPSG:31468 the network is not in Germany and there is no permanent counter of the Zählkarte in its area. With EPSG:25832 there would be one.");
  assert.throws(() => crsDefinition("Atlantis"), /“Atlantis” is not a known coordinate system/);
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315].map(kurz), ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
  assert.equal(OSM_FILTER.strassen.name, "Roads and cycle paths");
  assert.throws(() => leseZuordnungCsv(""), /The CSV is empty/);
  // die Beschreibung der counts.xml bleibt deutsch, auch auf der englischen Seite
  assert.match(auswahlText(MITTEL), /^Mittel je Stunde über Di, Mi, Do/);
  assert.equal(auswahlText(MITTEL, "en"), "Mean per hour over Tue, Wed, Thu (Mon–Fri only school days), at least 5 days per hour");
  setzeSprache("de");
  assert.equal(OSM_FILTER.strassen.name, "Straßen und Radwege");
  assert.equal(kurz(45), "NO");
});

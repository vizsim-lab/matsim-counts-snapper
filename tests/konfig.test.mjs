// Tests der Konfiguration (lib/konfig.js): bauen, wieder lesen, Entscheidungen im Format der Zuordnung
import { test } from "node:test";
import assert from "node:assert/strict";
import { KONFIG_FORMAT, KONFIG_VERSION, baueKonfiguration, entscheidung, leseKonfiguration } from "../lib/konfig.js";
import { leseZuordnungCsv, zuordnungCsv } from "../lib/counts.js";

const EINSTELLUNGEN = {
  crs: "EPSG:25833",
  osm_filter: "strassen",
  suche: { radius_m: 40, max_winkel_grad: 45, nur_ziel_mitnehmen: true },
  gruppen: { kfz: { an: true, network_mode: "car", link_erlaubt: "car" } },
  kurzzeit: { an: false },
  mitteln: { wochentage: [2, 3, 4], von: null, bis: null, tagesarten: ["s"], statistik: "mittel", min_tage: 5, nur_vollstaendig: true },
  ausgabe: { name: null, jahr: 2025, nur_gepruefte: false },
};

test("entscheidung: Anker gerundet, ausgelassen ohne Link-ID, leere Texte als null", () => {
  const e = entscheidung({ station: "berlin:TE001", zuordnung: "geprüft", linkid: "4711", anker: { lon: 13.123456789, lat: 52.987654321, grad: 271.6 }, kommentar: "" });
  assert.deepEqual(e.anker, { lon: 13.1234568, lat: 52.9876543, grad: 272 });
  assert.equal(e.kommentar, null);
  assert.equal(e.zaehlart, "dauer");
  assert.equal(e.in_auswahl, true);
  const aus = entscheidung({ station: "berlin:TE002", zuordnung: "ausgelassen", linkid: "99", kommentar: "Baustelle" });
  assert.equal(aus.linkid, null);
  assert.equal(aus.kommentar, "Baustelle");
  const ohneGrad = entscheidung({ station: "x", zuordnung: "geprüft", linkid: "1", anker: { lon: 1, lat: 2, grad: null } });
  assert.equal(ohneGrad.anker.grad, null);
});

test("baueKonfiguration: Format, Version und alle Teile", () => {
  const k = baueKonfiguration({ erstellt: "2026-11-25T10:00:00.000Z", netz: { name: "netz.xml.gz", links: 3 }, einstellungen: EINSTELLUNGEN, entscheidungen: [] });
  assert.equal(k.format, KONFIG_FORMAT);
  assert.equal(k.version, KONFIG_VERSION);
  assert.deepEqual(Object.keys(k), ["format", "version", "erstellt", "seite", "netz", "daten", "einstellungen", "ergebnis", "quellen", "entscheidungen"]);
});

test("leseKonfiguration: Rundreise über JSON, Zeilen wie die Zuordnungs-CSV", () => {
  const k = baueKonfiguration({
    netz: { name: "berlin-v6.4.output_network.xml.gz", links: 123 },
    einstellungen: EINSTELLUNGEN,
    entscheidungen: [
      entscheidung({ station: "berlin:TE001", zuordnung: "geprüft", linkid: "4711", anker: { lon: 13.4, lat: 52.5, grad: 90 }, osmWeg: "-123" }),
      entscheidung({ station: "berlin:TE002", zuordnung: "ausgelassen", kommentar: "Baustelle" }),
      entscheidung({ station: "berlin:K2/K0000002_20231019/1zu", zaehlart: "kurzzeit", zuordnung: "automatisch", kommentar: "prüfen" }),
      entscheidung({ station: "berlin:TE003", zuordnung: "geprüft", linkid: "15", inAuswahl: false }),
    ],
  });
  const r = leseKonfiguration(JSON.parse(JSON.stringify(k)));
  assert.equal(r.zeilen.length, 3);
  assert.deepEqual(r.weitere.map((e) => e.station), ["berlin:TE003"]);
  const [a, b, c] = r.zeilen;
  assert.deepEqual(a, { station: "berlin:TE001", linkid: "4711", using: true, kommentar: "", zuordnung: "geprüft", anker: { lon: 13.4, lat: 52.5, grad: 90 }, weg: "-123", netz: "berlin-v6.4.output_network.xml.gz" });
  assert.equal(b.using, false);
  assert.equal(b.linkid, "");
  assert.equal(b.kommentar, "Baustelle");
  assert.equal(c.zuordnung, "automatisch");
  assert.equal(c.anker, null);
  assert.deepEqual(r.einstellungen, EINSTELLUNGEN);
});

test("leseKonfiguration: die Zeilen entsprechen denen einer CSV mit denselben Entscheidungen", () => {
  const csv = zuordnungCsv([
    { station: "a", linkid: "1", using: true, kommentar: "", zuordnung: "geprüft", anker_lon: "13.4000000", anker_lat: "52.5000000", anker_grad: 90, osm_weg: "77", netz: "n.xml" },
    { station: "b", linkid: "", using: false, kommentar: "weg", zuordnung: "ausgelassen", anker_lon: "", anker_lat: "", anker_grad: "", osm_weg: "", netz: "" },
  ]);
  const ausCsv = leseZuordnungCsv(csv);
  const ausJson = leseKonfiguration(baueKonfiguration({
    netz: { name: "n.xml" },
    einstellungen: EINSTELLUNGEN,
    entscheidungen: [
      entscheidung({ station: "a", zuordnung: "geprüft", linkid: "1", anker: { lon: 13.4, lat: 52.5, grad: 90 }, osmWeg: "77" }),
      entscheidung({ station: "b", zuordnung: "ausgelassen", kommentar: "weg" }),
    ],
  })).zeilen;
  for (const [x, y] of ausCsv.map((z, i) => [z, ausJson[i]])) {
    assert.equal(y.station, x.station);
    assert.equal(y.using, x.using);
    assert.equal(y.linkid, x.linkid);
    assert.equal(y.kommentar, x.kommentar);
    assert.equal(y.zuordnung, x.zuordnung);
    assert.deepEqual(y.anker, x.anker);
  }
});

test("leseKonfiguration: fremde, zu neue oder unvollständige Dateien", () => {
  assert.throws(() => leseKonfiguration({ format: "etwas anderes" }), /keine Konfiguration/);
  assert.throws(() => leseKonfiguration(null), /keine Konfiguration/);
  assert.throws(() => leseKonfiguration({ format: KONFIG_FORMAT, version: KONFIG_VERSION + 1, einstellungen: {} }), /Version/);
  assert.throws(() => leseKonfiguration({ format: KONFIG_FORMAT, version: 1 }), /Einstellungen/);
  // kaputte Einträge fallen weg, ein Anker ohne Zahlen auch
  const r = leseKonfiguration({ format: KONFIG_FORMAT, version: 1, einstellungen: {}, entscheidungen: [null, { station: "" }, { station: "x", zuordnung: "Geprüft", linkid: "3", anker: { lon: "13", lat: 52 } }] });
  assert.equal(r.zeilen.length, 1);
  assert.equal(r.zeilen[0].zuordnung, "geprüft");
  assert.equal(r.zeilen[0].anker, null);
  assert.equal(r.zeilen[0].netz, null);
});

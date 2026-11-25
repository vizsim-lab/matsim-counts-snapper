// Die Konfiguration: speichern, auf einer frischen Seite wieder laden, ohne Netz laden, Fehler.
import { readFileSync } from "node:fs";
import { test, expect, oeffne, frisch, fertig, lade, taste, stand } from "./hilfen.js";

/** Einstellungen ändern und drei Entscheidungen von Hand treffen. */
async function sitzung(page, baseURL) {
  await oeffne(page, baseURL);
  await page.fill("#radius", "45");
  await page.dispatchEvent("#radius", "change");
  await fertig(page);
  await page.click("#statistik button[value='median']");
  await page.fill("#counts-name", "Test der Konfiguration");
  await taste(page, "test_viz:D1", "p");
  await taste(page, "test_viz:D4", "a");
  await page.evaluate(() => window.snapper.waehle("test_viz:D3"));
  await page.fill("#kommentar", 'Lücke am 10. Juni; mit "Zeichen"');
  await page.dispatchEvent("#kommentar", "change");
  await page.evaluate(() => document.activeElement?.blur());
  const konfig = await lade(page, "#konfig-json");
  return {
    konfig,
    stand: await stand(page),
    counts: (await lade(page, "#counts-xml")).text,
    zuordnung: (await lade(page, "#zuordnung-csv")).text,
  };
}

const ohneHerkunft = (liste) => liste.map(({ uebernommen, ...e }) => e);

test("Konfiguration speichern und auf einer frischen Seite wieder laden", async ({ page, baseURL }) => {
  const vorher = await sitzung(page, baseURL);
  expect(vorher.konfig.name).toBe("netz-snapper-konfiguration.json");
  const k = JSON.parse(vorher.konfig.text);
  expect(k.format).toBe("matsim-counts-snapper/konfiguration");
  expect(k.netz).toMatchObject({ name: "netz.xml", url: `${baseURL}/tests/web/fixtures/netz.xml`, art: "matsim", crs: "EPSG:25833", crs_aus_datei: true, links: 34 });
  expect(k.daten.dauer).toEqual({ erzeugt: "2026-11-20", version: 5 });
  expect(k.einstellungen.suche.radius_m).toBe(45);
  expect(k.einstellungen.mitteln.statistik).toBe("median");
  expect(k.einstellungen.gebiet).toBeNull();
  expect(k.entscheidungen.map((e) => [e.station, e.zuordnung, e.linkid, e.kommentar])).toEqual([
    ["test_viz:D1", "geprüft", "k00-k10", null],
    ["test_viz:D3", "automatisch", null, 'Lücke am 10. Juni; mit "Zeichen"'],
    ["test_viz:D4", "ausgelassen", null, null],
  ]);
  // nach Osten; im UTM-Gitter um die Meridiankonvergenz gedreht
  expect(Math.abs(k.entscheidungen[0].anker.grad - 90)).toBeLessThanOrEqual(2);
  expect(k.quellen.map((q) => [q.code, q.lizenzen.map((l) => l.lizenz)])).toEqual([["test_rad", ["dl-de/zero-2-0"]], ["test_viz", ["dl-de/by-2-0"]]]);

  await frisch(page, baseURL);
  expect(await page.inputValue("#radius")).toBe("50");
  await page.setInputFiles("#konfig-file", { name: vorher.konfig.name, mimeType: "application/json", buffer: Buffer.from(vorher.konfig.text) });
  await expect(page.locator("#status-text")).toContainText("Einstellungen übernommen.");
  await fertig(page);
  await expect(page.locator("#status-text")).toContainText("1 von 1 geprüften Zuordnung übernommen (1 gleiche Link-ID). 1 Entscheidung ohne Anker übernommen.");
  expect(await page.inputValue("#radius")).toBe("45");
  expect(await page.inputValue("#counts-name")).toBe("Test der Konfiguration");
  expect(await stand(page)).toEqual(vorher.stand);
  expect((await lade(page, "#counts-xml")).text).toBe(vorher.counts);
  expect((await lade(page, "#zuordnung-csv")).text).toBe(vorher.zuordnung);
  const wieder = JSON.parse((await lade(page, "#konfig-json")).text);
  expect(wieder.einstellungen).toEqual(k.einstellungen);
  expect(ohneHerkunft(wieder.entscheidungen)).toEqual(ohneHerkunft(k.entscheidungen));
});

test("Konfiguration ohne Netz lädt ihr Netz; fremde und kaputte Dateien", async ({ page, baseURL }) => {
  const vorher = await sitzung(page, baseURL);
  // ohne Netz in der Adresse lädt die Seite das Beispiel von GitHub; der Test sperrt das Netz
  await page.evaluate(() => localStorage.clear());
  await oeffne(page, baseURL, { netz: null });
  await expect(page.locator("#status-text")).toContainText("ließ sich nicht laden");
  await expect(page.locator("#konfig-json")).toBeDisabled();
  await page.setInputFiles("#konfig-file", { name: vorher.konfig.name, mimeType: "application/json", buffer: Buffer.from(vorher.konfig.text) });
  await expect(page.locator("#status-text")).toContainText("Einstellungen übernommen.");
  await fertig(page);
  await expect(page.locator("#source")).toContainText("netz.xml");
  expect(await stand(page)).toEqual(vorher.stand);
  expect((await lade(page, "#counts-xml")).text).toBe(vorher.counts);

  await page.setInputFiles("#konfig-file", { name: "kaputt.json", mimeType: "application/json", buffer: Buffer.from("{ nicht json") });
  await expect(page.locator("#status-text")).toHaveText("kaputt.json: Die Datei ist kein JSON.");
  await page.setInputFiles("#konfig-file", { name: "fremd.json", mimeType: "application/json", buffer: Buffer.from('{"format": "etwas"}') });
  await expect(page.locator("#status-text")).toHaveText("fremd.json: Das ist keine Konfiguration des matsim-counts-snapper.");
  // Konfiguration und Netz zusammen ins Feld von Schritt 1
  await page.evaluate(() => localStorage.clear());
  await oeffne(page, baseURL, { netz: null });
  await page.setInputFiles("#file", [
    { name: vorher.konfig.name, mimeType: "application/json", buffer: Buffer.from(vorher.konfig.text) },
    { name: "netz.xml", mimeType: "application/xml", buffer: readFileSync("tests/web/fixtures/netz.xml") },
  ]);
  await expect(page.locator("#status-text")).toContainText("Einstellungen übernommen.");
  await fertig(page);
  expect(await stand(page)).toEqual(vorher.stand);
});

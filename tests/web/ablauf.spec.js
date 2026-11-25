// Der Ablauf mit dem MATSim-Netz der Testdaten: welche Stelle an welchen Link kommt, was Schritt 2
// sagt, welche Felder Schritt 1 zeigt, und die Ausgaben gegen erwartete Dateien.
import { readFileSync } from "node:fs";
import { test, expect, oeffne, fertig, stand, lade, wieErwartet } from "./hilfen.js";

const STELLEN = {
  "test_viz:D1": ["dauer", "passt", "k00-k10"],
  "test_viz:D2": ["dauer", "passt", "k10-k00"],
  "test_viz:D3": ["dauer", "passt", "k10-k11"],
  "test_viz:D4": ["dauer", "ohne", null],
  "test_viz:D5": ["dauer", "passt", "k31-k30"],
  "test_rad:R1": ["dauer", "passt", "k20-k21"],
  "test_rad:R2": ["dauer", "ohne", null],
  "test_rad:R3": ["quer", "quer", null],
};

test("MATSim-Netz: Stellen, Schritt 2 und Formular", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  expect(await stand(page)).toEqual(STELLEN);
  await expect(page.locator("#daten-text")).toContainText("Zählkarte vom 20.11.2026: Im Gebiet des Netzes liegen 9 Dauerzählstellen aus 3 Quellen (in ganz Deutschland 9 aus 3)");
  await expect(page.locator("#auswahl-text")).toContainText("Teststadt (ohne Lizenz)");
  await expect(page.locator("#status-text")).toHaveText("7 Zählstellen, 5 davon mit Link. 1 ohne Richtung nur angezeigt.");
  // Schritt 1 zeigt nur, was für ein MATSim-Netz gilt
  await expect(page.locator("#crs-feld")).toBeVisible();
  await expect(page.locator("#osm-feld")).toBeHidden();
  await expect(page.locator("section.step")).toHaveCount(5);
  await expect(page.locator("#konfig-json")).toBeEnabled();
});

test("gepackte Netze: .xml.gz und .xml.zst wie .xml, über die Adresse und als Datei", async ({ page, baseURL }) => {
  for (const netz of ["netz.xml.gz", "netz.xml.zst"]) {
    await oeffne(page, baseURL, { netz });
    expect(await stand(page), netz).toEqual(STELLEN);
    await expect(page.locator("#source")).toContainText(netz);
    wieErwartet("counts.xml", (await lade(page, "#counts-xml")).text.replaceAll(`fixtures/${netz}`, "fixtures/netz.xml"));
  }
  await page.setInputFiles("#file", "tests/web/fixtures/netz.xml.zst");
  await fertig(page);
  expect(await stand(page)).toEqual(STELLEN);
  // abgeschnitten: eine klare Meldung statt eines halben Netzes
  const voll = readFileSync("tests/web/fixtures/netz.xml.zst");
  await page.setInputFiles("#file", { name: "halb.xml.zst", mimeType: "application/zstd", buffer: voll.subarray(0, Math.floor(voll.length / 2)) });
  await expect(page.locator("#status-text")).toContainText("Die Zstandard-Datei lässt sich nicht entpacken");
});

test("Netz mit „Atlantis“ und bicycle: CRS aus dem Formular, Rad mit einem Klick", async ({ page, baseURL }) => {
  // so schreibt MATSim, wenn global.coordinateSystem fehlt; die Koordinaten sind ETRS89 / UTM 33N
  await oeffne(page, baseURL, { netz: "netz-atlantis.xml.zst", crs: "EPSG:25833" });
  await expect(page.locator("#crs-platzhalter")).toBeVisible();
  await expect(page.locator("#crs-platzhalter")).toContainText("Das Netz nennt „Atlantis“");
  await expect(page.locator("#source")).toContainText("EPSG:25833 aus Formular");
  const vorher = await stand(page);
  expect(vorher["test_viz:D1"]).toEqual(STELLEN["test_viz:D1"]);
  // die Links erlauben bicycle, die Rad-Gruppe sucht bike
  expect(vorher["test_rad:R1"]).toEqual(["dauer", "ohne", null]);
  await expect(page.locator("#gruppen-hinweis")).toContainText("Kein Link im Netz erlaubt bike (Rad).");
  await expect(page.locator("#gruppen-hinweis")).toContainText("Das Netz kennt: car (34), bicycle (28).");
  await page.click("#gruppen-hinweis button");
  await fertig(page);
  await expect(page.locator("#gruppen-hinweis")).toBeHidden();
  expect(await page.evaluate(() => window.snapper.state.gruppen.rad)).toEqual({ an: true, mode: "bicycle", link: "bicycle" });
  expect(await stand(page)).toEqual(STELLEN);
  const counts = (await lade(page, "#counts-xml")).text;
  const r1 = counts.slice(counts.indexOf('id="test_rad:R1"'));
  expect(r1.slice(0, r1.indexOf("</location>"))).toContain('networkMode="bicycle"');
  // ein Netz mit eigenem CRS zeigt den Hinweis nicht
  await oeffne(page, baseURL);
  await expect(page.locator("#crs-platzhalter")).toBeHidden();
});

test("Ausgaben wie erwartet, Mittel nachgerechnet", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  const counts = await lade(page, "#counts-xml");
  expect(counts.name).toBe("netz-counts-zaehlkarte.xml");
  wieErwartet("counts.xml", counts.text);
  wieErwartet("zuordnung.csv", (await lade(page, "#zuordnung-csv")).text);
  // Kfz 8–9 Uhr, Di bis Do an Schultagen: 9 Tage mit dem Wert 180 + Tag (1, 2, 3, 8, 9, 10, 15, 16, 17) -> 189
  const messung = (id, modus) => {
    const ort = counts.text.slice(counts.text.indexOf(`id="${id}"`));
    return ort.slice(ort.indexOf(`networkMode="${modus}"`), ort.indexOf("</measurements>"));
  };
  expect(messung("test_viz:D1", "car")).toMatch(/<value t="28800" val="189(\.0)?"\/>/);
  // D3 fehlt am 10. Juni (Tag 8) die Stunde 3–4: Sie mittelt über 8 Tage (im Mittel Tag 9,125), die übrigen über 9
  expect(messung("test_viz:D3", "car")).toMatch(/<value t="10800" val="2139\.1"\/>/);
  expect(messung("test_viz:D3", "car")).toMatch(/<value t="28800" val="2189(\.0)?"\/>/);
  // Rad: 5 + Stunde + Tag
  expect(messung("test_rad:R1", "bike")).toMatch(/<value t="28800" val="22(\.0)?"\/>/);
  // ohne Link, ohne Richtung und ohne Lizenz: nicht in der Datei
  for (const id of ["test_viz:D4", "test_rad:R2", "test_rad:R3", "test_ohne:X1"]) expect(counts.text).not.toContain(`"${id}"`);
});

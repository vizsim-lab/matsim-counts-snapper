// Der Ablauf mit dem MATSim-Netz der Testdaten: welche Stelle an welchen Link kommt, was Schritt 2
// sagt, welche Felder Schritt 1 zeigt, und die Ausgaben gegen erwartete Dateien.
import { test, expect, oeffne, stand, lade, wieErwartet } from "./hilfen.js";

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

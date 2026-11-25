// Das Gebiet: zeichnen, eine Ecke ziehen, aus Dateien laden (.poly, GeoJSON, Shapefile), gemerkt,
// in Konfiguration und counts.xml. Das Testgebiet ist die westliche Hälfte des Gitters: D5 und R1
// liegen draußen.
import { test, expect, oeffne, fertig, lade, stand, gebietEcken, pixel } from "./hilfen.js";
import { shp, zip } from "../hilfen/dateien.mjs";

const DRAUSSEN = ["test_viz:D5", "test_rad:R1"];
const ohne = (alle, weg) => Object.fromEntries(Object.entries(alle).filter(([id]) => !weg.includes(id)));

/** Die Karte auf das ganze Netz, damit alle Ecken zu sehen sind; unten links liegt die Legende. */
async function aufsNetz(page) {
  await page.evaluate(() => {
    const [w, s, o, n] = window.snapper.state.netz.info.bbox;
    window.snapper.map.fitBounds([[w, s], [o, n]], { padding: { top: 80, right: 80, bottom: 300, left: 300 }, duration: 0 });
  });
  await page.waitForTimeout(200);
}

test("Gebiet zeichnen, eine Ecke ziehen, wieder das ganze Netz", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  const alle = await stand(page);
  await aufsNetz(page);
  await page.click("#gebiet-zeichnen");
  await expect(page.locator("#gebiethint")).toBeVisible();
  const ecken = gebietEcken(); // Südwest, Südost, Nordost, Nordwest
  for (const e of ecken) {
    const [x, y] = await pixel(page, e);
    await page.mouse.click(x, y);
    await page.waitForTimeout(80);
  }
  await expect(page.locator("#gebiet-text")).toContainText("4 Ecken gesetzt");
  await page.keyboard.press("Enter");
  await fertig(page);
  await expect(page.locator("#gebiethint")).toBeHidden();
  expect(await stand(page)).toEqual(ohne(alle, DRAUSSEN));
  await expect(page.locator("#daten-text")).toContainText("Im gewählten Gebiet liegen 7 Dauerzählstellen aus 3 Quellen (im ganzen Netz 9, in ganz Deutschland 9)");
  await expect(page.locator("#st-gebiet-titel")).toHaveText("Im Gebiet");
  await expect(page.locator("#gebiet-text")).toContainText("Gezeichnetes Gebiet (gezeichnet)");

  // die Südostecke nach Osten ziehen, bis R1 im Gebiet liegt (D5 bleibt draußen)
  const [sw, so] = ecken;
  const ziel = [so[0] + ((so[0] - sw[0]) * 250) / 550, so[1] + ((so[1] - sw[1]) * 250) / 550];
  const [x, y] = await pixel(page, so);
  await expect.poll(() => page.evaluate(([lon, lat]) => {
    const p = window.snapper.map.project([lon, lat]);
    return window.snapper.map.queryRenderedFeatures([p.x, p.y], { layers: ["gebiet-ecken"] }).length;
  }, so)).toBeGreaterThan(0);
  const [x2, y2] = await pixel(page, ziel);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + x2) / 2, (y + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
  await fertig(page);
  expect(await stand(page)).toEqual(ohne(alle, ["test_viz:D5"]));

  // Esc bricht ein neues Zeichnen ab, das Gebiet bleibt
  await page.click("#gebiet-zeichnen");
  await page.mouse.click(x, y);
  await page.keyboard.press("Escape");
  await expect(page.locator("#gebiet-zeichnen")).toHaveText("Neu zeichnen");
  expect(await stand(page)).toEqual(ohne(alle, ["test_viz:D5"]));

  await page.click("#gebiet-weg");
  await fertig(page);
  expect(await stand(page)).toEqual(alle);
  await expect(page.locator("#st-gebiet-titel")).toHaveText("Im Netzgebiet");
});

test("Gebiet aus Dateien, gemerkt, in Konfiguration und counts.xml", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  const alle = await stand(page);
  const imGebiet = ohne(alle, DRAUSSEN);

  await page.setInputFiles("#gebiet-file", "tests/web/fixtures/gebiet.poly");
  await fertig(page);
  expect(await stand(page)).toEqual(imGebiet);
  await expect(page.locator("#gebiet-text")).toContainText("westen (aus gebiet.poly)");
  const counts = (await lade(page, "#counts-xml")).text;
  expect(counts).toMatch(/<attribute name="gebiet" class="java.lang.String">westen \(gebiet.poly\), \d+,\d km²; nur Stellen darin<\/attribute>/);
  expect(counts).not.toContain('"test_viz:D5"');
  const konfig = await lade(page, "#konfig-json");
  const k = JSON.parse(konfig.text);
  expect(k.einstellungen.gebiet.properties).toEqual({ name: "westen", art: "datei", datei: "gebiet.poly" });
  expect(k.ergebnis.gebiet).toMatchObject({ name: "westen", dauerzaehlstellen: 7, quellen: 3 });
  expect(k.ergebnis.netzgebiet).toEqual({ dauerzaehlstellen: 9, quellen: 3 });

  // neu laden: Das Gebiet ist gemerkt
  await page.reload();
  await fertig(page);
  expect(await stand(page)).toEqual(imGebiet);
  await page.click("#gebiet-weg");
  await fertig(page);
  expect(await stand(page)).toEqual(alle);

  // aus der Konfiguration
  await page.setInputFiles("#konfig-file", { name: konfig.name, mimeType: "application/json", buffer: Buffer.from(konfig.text) });
  await expect(page.locator("#status-text")).toContainText("Einstellungen übernommen, keine Entscheidungen von Hand.");
  await fertig(page);
  expect(await stand(page)).toEqual(imGebiet);
  expect((await lade(page, "#counts-xml")).text).toBe(counts);
  await page.click("#gebiet-weg");
  await fertig(page);

  // GeoJSON, ins Feld von Schritt 1 gezogen
  const ring = [...gebietEcken(), gebietEcken()[0]];
  const geojson = { type: "FeatureCollection", name: "westen", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
  await page.setInputFiles("#file", { name: "westen.geojson", mimeType: "application/geo+json", buffer: Buffer.from(JSON.stringify(geojson)) });
  await fertig(page);
  expect(await stand(page)).toEqual(imGebiet);
  await page.click("#gebiet-weg");
  await fertig(page);

  // Shapefile in ETRS89 / UTM 33N, gezippt, mit .prj; außen im Uhrzeigersinn
  const X0 = 390000;
  const Y0 = 5819000;
  const utm = [[-100, -100], [-100, 700], [450, 700], [450, -100], [-100, -100]].map(([dx, dy]) => [X0 + dx, Y0 + dy]);
  const prj = 'PROJCS["ETRS_1989_UTM_Zone_33N",GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",15.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  const datei = zip([["westen/westen.shp", shp([{ ringe: [utm] }]), true], ["westen/westen.prj", new TextEncoder().encode(prj), false]]);
  await page.setInputFiles("#gebiet-file", { name: "westen.zip", mimeType: "application/zip", buffer: Buffer.from(datei) });
  await fertig(page);
  expect(await stand(page)).toEqual(imGebiet);
  await expect(page.locator("#gebiet-text")).toContainText("westen (aus westen.zip)");

  // ohne .prj und nicht in Grad: im CRS des Netzes gelesen, mit Hinweis
  await page.setInputFiles("#gebiet-file", { name: "westen.shp", mimeType: "application/octet-stream", buffer: Buffer.from(shp([{ ringe: [utm] }])) });
  await fertig(page);
  expect(await stand(page)).toEqual(imGebiet);
  await expect(page.locator("#gebiet-text")).toContainText("Die Datei nennt kein Koordinatensystem; gelesen als EPSG:25833.");

  // keine Fläche
  await page.setInputFiles("#gebiet-file", { name: "punkt.geojson", mimeType: "application/geo+json", buffer: Buffer.from('{"type":"Point","coordinates":[13.4,52.5]}') });
  await expect(page.locator("#status-text")).toHaveText("Gebiet aus punkt.geojson: Darin ist keine Fläche.");
});

// Ein OSM-Auszug als Netz (auch über die Adresse) und die Übernahme der Entscheidungen auf das
// MATSim-Netz derselben Straßen, über die Konfiguration wie über die Zuordnungs-CSV.
import { test, expect, oeffne, frisch, fertig, lade, taste, stand } from "./hilfen.js";

test("OSM-Auszug per Adresse, Entscheidungen auf das MATSim-Netz übertragen", async ({ page, baseURL }) => {
  await oeffne(page, baseURL, { netz: "netz.osm.pbf" });
  await expect(page.locator("#source")).toContainText("OSM-Auszug");
  await expect(page.locator("#source")).toContainText("7 Wege, 34 Kanten");
  // Schritt 1 zeigt nur, was für einen OSM-Auszug gilt
  await expect(page.locator("#crs-feld")).toBeHidden();
  await expect(page.locator("#osm-feld")).toBeVisible();
  const osm = await stand(page);
  expect(osm["test_viz:D1"]).toEqual(["dauer", "passt", "100#0"]);
  expect(osm["test_viz:D2"]).toEqual(["dauer", "passt", "-100#0"]);
  expect(osm["test_rad:R2"]).toEqual(["dauer", "ohne", null]); // Mittelweg mit bicycle=no
  await expect(page.locator("#counts-xml")).toBeDisabled();
  await expect(page.locator("#osm-export")).toBeVisible();

  await taste(page, "test_viz:D1", "p");
  await taste(page, "test_viz:D2", "a");
  const konfig = await lade(page, "#konfig-json");
  const k = JSON.parse(konfig.text);
  expect(k.netz).toMatchObject({ name: "netz.osm.pbf", art: "osm", osm_filter: "strassen" });
  expect(k.entscheidungen[0]).toMatchObject({ station: "test_viz:D1", zuordnung: "geprüft", linkid: "100#0", osm_weg: "100" });
  const csv = await lade(page, "#zuordnung-csv");

  // auf das MATSim-Netz: über die Konfiguration …
  await frisch(page, baseURL);
  await page.setInputFiles("#konfig-file", { name: konfig.name, mimeType: "application/json", buffer: Buffer.from(konfig.text) });
  await expect(page.locator("#status-text")).toContainText("1 von 1 geprüften Zuordnung übernommen (1 gleicher OSM-Weg)");
  await expect(page.locator("#status-text")).toContainText("Die Konfiguration stammt von netz.osm.pbf (OSM-Auszug).");
  await fertig(page);
  const matsim = await stand(page);
  expect(matsim["test_viz:D1"]).toEqual(["dauer", "geprueft", "k00-k10"]);
  expect(matsim["test_viz:D2"][1]).toBe("aus");
  // das CRS des MATSim-Netzes bleibt; eine Konfiguration aus OSM ändert es nicht
  expect(await page.inputValue("#crs")).toBe("EPSG:25832");
  await expect(page.locator("#source")).toContainText("EPSG:25833");

  // … und über die Zuordnungs-CSV: dasselbe
  await frisch(page, baseURL);
  await page.setInputFiles("#csv-file", { name: csv.name, mimeType: "text/csv", buffer: Buffer.from(csv.text) });
  await expect(page.locator("#status-text")).toContainText("gleicher OSM-Weg");
  await fertig(page);
  expect(await stand(page)).toEqual(matsim);
});

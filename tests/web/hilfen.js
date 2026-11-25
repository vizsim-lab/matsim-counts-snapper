// Gemeinsames der Browser-Tests: die Seite mit den Testdaten öffnen, auf die Seite warten, Dateien
// laden, mit erwarteten Dateien vergleichen. Nach draußen geht keine Anfrage: Alles außer dem
// Testserver wird abgewiesen, die Hintergrundkarte ist aus.
import { test as basis, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export { expect };
export const FIXTURES = "/tests/web/fixtures";
const FERTIG = "['done','error','idle'].includes(document.getElementById('status').dataset.state)";

export const test = basis.extend({
  // Die Tests prüfen die deutschen Texte; mit sprache: null gilt die Vorgabe der Seite (Englisch)
  // und eine Wahl über den Umschalter bleibt beim Neuladen
  sprache: ["de", { option: true }],
  page: async ({ page, baseURL, sprache }, use) => {
    const host = new URL(baseURL).host;
    await page.route("**/*", (route) => (new URL(route.request().url()).host === host ? route.continue() : route.abort()));
    await page.addInitScript((sp) => {
      try {
        // leerer Speicher beim ersten Öffnen; beim Neuladen bleibt er (Gebiet, Entscheidungen)
        if (!sessionStorage.getItem("snapper.test")) {
          localStorage.clear();
          sessionStorage.setItem("snapper.test", "1");
        }
        localStorage.setItem("snapper.basemap", "none");
        if (sp) localStorage.setItem("snapper.sprache", sp);
      } catch {
        /* ohne Speicher */
      }
    }, sprache);
    const fehler = [];
    page.on("pageerror", (e) => fehler.push(String(e)));
    await use(page);
    expect(fehler, "Fehler im Browser").toEqual([]);
  },
});

/** Die Adresse der Seite: Netz und Daten der Zählkarte aus den Testdaten, wahlweise ein CRS fürs Formular. */
export function adresse(baseURL, { netz = "netz.xml", crs = null } = {}) {
  const teile = [];
  if (netz) teile.push(`net=${baseURL}${FIXTURES}/${netz}`);
  if (crs) teile.push(`crs=${crs}`);
  teile.push(`daten=${baseURL}${FIXTURES}/zaehlkarte/`, "debug");
  return `/?${teile.join("&")}`;
}

/** Warten, bis die Seite fertig ist (Status nicht mehr „busy“). */
export async function fertig(page) {
  await page.waitForTimeout(150);
  await page.waitForFunction(FERTIG, null, { timeout: 60_000 });
}

export async function oeffne(page, baseURL, optionen) {
  await page.goto(adresse(baseURL, optionen));
  await fertig(page);
}

/** Den Speicher leeren und neu laden: wie eine frische Seite. */
export async function frisch(page, baseURL, optionen) {
  await page.evaluate(() => localStorage.clear());
  await oeffne(page, baseURL, optionen);
}

/** Eine Datei über einen Knopf herunterladen -> { name, text }. */
export async function lade(page, knopf) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(knopf)]);
  const text = readFileSync(await dl.path(), "utf8");
  await fertig(page);
  return { name: dl.suggestedFilename(), text };
}

/** Je Stelle [Familie, Lage, Link]. */
export const stand = (page) => page.evaluate(() => Object.fromEntries(window.snapper.state.stellen.map((s) => [s.id, [s.familie ?? "dauer", window.snapper.lageVon(s), window.snapper.linkVon(s)?.id ?? null]])));

/** Eine Stelle wählen und eine Taste drücken (p passt, a auslassen). */
export async function taste(page, id, t) {
  await page.evaluate((i) => {
    document.activeElement?.blur();
    window.snapper.waehle(i);
  }, id);
  await page.locator("body").press(t);
  await fertig(page);
}

/** Mit einer erwarteten Datei in tests/web/erwartet vergleichen; ERWARTET_NEU=1 schreibt sie neu. */
export function wieErwartet(name, text) {
  const ordner = new URL("./erwartet/", import.meta.url);
  if (process.env.ERWARTET_NEU) {
    mkdirSync(ordner, { recursive: true });
    writeFileSync(new URL(name, ordner), text);
  }
  expect(text, `${name} wie in tests/web/erwartet (neu schreiben mit ERWARTET_NEU=1)`).toBe(readFileSync(new URL(name, ordner), "utf8"));
}

/** Die Ecken des Testgebiets (gebiet.poly) in WGS 84, ohne den Schlusspunkt. */
export function gebietEcken() {
  const text = readFileSync(new URL("./fixtures/gebiet.poly", import.meta.url), "utf8");
  const punkte = text.split("\n").map((z) => z.trim().split(/\s+/).map(Number)).filter((z) => z.length === 2 && z.every(Number.isFinite));
  return punkte.slice(0, -1);
}

/** Der Bildschirmpunkt zu einem Ort auf der Karte. */
export async function pixel(page, [lon, lat]) {
  const box = await page.locator("#map canvas").boundingBox();
  const p = await page.evaluate(([x, y]) => window.snapper.map.project([x, y]), [lon, lat]);
  return [box.x + p.x, box.y + p.y];
}

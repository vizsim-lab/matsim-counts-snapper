// Englisch ist die Vorgabe; der Umschalter neben dem Titel wechselt ohne Neuladen, die Wahl bleibt,
// und die Ausgaben sind in beiden Sprachen dieselben Dateien.
import { test, expect, oeffne, fertig, stand, lade, wieErwartet } from "./hilfen.js";

test.use({ sprache: null });

// deutsche Wörter, die nur in der Oberfläche stehen, nie in den Testdaten (Namen, Richtungen, Quellen)
const DEUTSCH = /(?<![-\w])(und|oder|nicht|keine?|mit|von|für|Netz|Netzes|Stellen?|Zählstellen?|Dauerzählstellen?|Kurzzeitzählungen?|Gebiet|laden|Prüfen|prüfen|Mitteln|Ausgeben|Umkreis|Koordinatensystem|Beispiel|Wochentage|Stunde|Schultagen|zeichnen|Zuordnung|Konfiguration|Quellen|Lizenz(en)?|passt|ausgelassen)\b/i;

/** Der sichtbare Text der Seitenleiste ohne das, was aus den Daten kommt (Liste, Steckbrief, Namen, Quellen). */
const oberflaeche = (page) => page.evaluate(() => {
  const panel = document.querySelector(".panel").cloneNode(true);
  for (const el of panel.querySelectorAll("#liste, #karte, #auswahl-text, #quellen, .source .name, #gruppen-body label, datalist")) el.remove();
  document.body.append(panel);
  panel.style.cssText = "position:absolute;left:-9999px;width:420px";
  const text = panel.innerText;
  panel.remove();
  return text;
});

test("Englisch als Vorgabe, Umschalten ohne Neuladen, die Wahl bleibt", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('#sprache button[value="en"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#status-text")).toHaveText("7 count sites, 5 of them with a link. 1 without direction, shown only.");
  await expect(page.locator("#daten-text")).toContainText("Zählkarte of 2026-11-20: In the network area there are 9 permanent counters from 3 sources (9 from 3 sources in all of Germany)");
  // feste Texte stehen in beiden Sprachen im DOM: sichtbar ist nur die eine
  await expect(page.locator("#h-netz")).toContainText(/network/i, { useInnerText: true });
  await expect(page.locator("#h-netz")).not.toContainText(/netz/i, { useInnerText: true });
  await expect(page.locator("#gruppen-body")).toContainText("Motor vehicles");
  await expect(page.locator("#source")).toContainText("34 links");
  const vorher = await stand(page);
  // eine Stelle gewählt: der Steckbrief spricht Englisch
  await page.evaluate(() => window.snapper.waehle("test_viz:D1"));
  await expect(page.locator("#karte")).toContainText("Pick on the map");
  await expect(page.locator("#karte .lage")).toHaveText("matched");
  const text = await oberflaeche(page);
  expect([...text.matchAll(new RegExp(DEUTSCH.source, "gi"))].map((m) => m[0]), `deutsch in: ${text}`).toEqual([]);

  // auf Deutsch: alles neu gezeichnet, nichts neu geladen, Zustand gleich
  await page.click('#sprache button[value="de"]');
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#status-text")).toHaveText("7 Zählstellen, 5 davon mit Link. 1 ohne Richtung nur angezeigt.");
  await expect(page.locator("#daten-text")).toContainText("Zählkarte vom 20.11.2026: Im Gebiet des Netzes liegen 9 Dauerzählstellen aus 3 Quellen");
  await expect(page.locator("#h-netz")).toContainText(/netz/i, { useInnerText: true });
  await expect(page.locator("#h-netz")).not.toContainText(/network/i, { useInnerText: true });
  await expect(page.locator("#gruppen-body")).toContainText("Kfz");
  await expect(page.locator("#karte")).toContainText("Auf der Karte wählen");
  await expect(page.locator("#karte .lage")).toHaveText("passt");
  await expect(page.locator("#radius")).toHaveValue("50");
  expect(await stand(page)).toEqual(vorher);
  expect(new URL(page.url()).searchParams.get("lang")).toBe("de");

  // neu geladen: Deutsch bleibt
  await page.reload();
  await fertig(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#status-text")).toHaveText("7 Zählstellen, 5 davon mit Link. 1 ohne Richtung nur angezeigt.");

  // zurück auf Englisch: ohne lang in der Adresse
  await page.click('#sprache button[value="en"]');
  await expect(page.locator("#status-text")).toHaveText("7 count sites, 5 of them with a link. 1 without direction, shown only.");
  expect(new URL(page.url()).searchParams.has("lang")).toBe(false);
});

test("?lang=de öffnet Deutsch, auch ohne gemerkte Wahl", async ({ page, baseURL }) => {
  await page.goto(`/?net=${baseURL}/tests/web/fixtures/netz.xml&daten=${baseURL}/tests/web/fixtures/zaehlkarte/&lang=de&debug`);
  await fertig(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#status-text")).toHaveText("7 Zählstellen, 5 davon mit Link. 1 ohne Richtung nur angezeigt.");
  await expect(page.locator('#sprache button[value="de"]')).toHaveAttribute("aria-pressed", "true");
});

test("Ausgaben auf Englisch dieselben Dateien wie auf Deutsch", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  wieErwartet("counts.xml", (await lade(page, "#counts-xml")).text);
  await expect(page.locator("#status-text")).toContainText("count stations in netz-counts-zaehlkarte.xml");
  wieErwartet("zuordnung.csv", (await lade(page, "#zuordnung-csv")).text);
  // die Kurzzeitzählungen ebenso
  await page.evaluate(() => {
    document.getElementById("kurz").open = true;
  });
  await page.check("#kurz-an");
  await fertig(page);
  await expect(page.locator("#kurz-text")).toContainText("1 junction, 1 cross-section");
  wieErwartet("counts-kurzzeit.xml", (await lade(page, "#kurz-xml")).text);
});

test("ein gezeichnetes Gebiet heißt in den Ausgaben wie auf Deutsch", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  await page.click("#gebiet-zeichnen");
  const box = await page.locator("#map").boundingBox();
  for (const [x, y] of [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]) await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  await page.locator("body").press("Enter");
  await fertig(page);
  await expect(page.locator("#gebiet-text")).toContainText("Drawn area (drawn)");
  const xml = (await lade(page, "#counts-xml")).text;
  expect(xml).toContain("Gezeichnetes Gebiet (gezeichnet)");
  expect(xml).not.toContain("Drawn area");
});

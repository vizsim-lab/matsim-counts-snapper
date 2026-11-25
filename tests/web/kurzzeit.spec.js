// Kurzzeitzählungen: Punkte je Arm und Fahrtrichtung, Dauerzählstellen gehen vor, die eigene Datei.
import { test, expect, oeffne, fertig, lade, stand, wieErwartet } from "./hilfen.js";

test("Kurzzeitzählungen je Arm und Richtung, eigene counts-kurzzeit.xml", async ({ page, baseURL }) => {
  await oeffne(page, baseURL);
  await page.evaluate(() => {
    document.getElementById("kurz").open = true;
  });
  await page.check("#kurz-an");
  await fertig(page);
  const kurz = Object.fromEntries(Object.entries(await stand(page)).filter(([, [familie]]) => familie === "kurz"));
  const K = "test:K1/K1_20240611/";
  const Q = "test:Q1/Q1_20240612/";
  expect(kurz).toEqual({
    [`${K}1aus`]: ["kurz", "passt", "k11-k01"],
    [`${K}1zu`]: ["kurz", "passt", "k01-k11"],
    [`${K}2aus`]: ["kurz", "passt", "k11-k12"],
    [`${K}2zu`]: ["kurz", "passt", "k12-k11"],
    [`${K}3aus`]: ["kurz", "passt", "k11-k21"],
    [`${K}3zu`]: ["kurz", "passt", "k21-k11"],
    [`${K}4aus`]: ["kurz", "passt", "k11-k10"],
    // die Zufahrt aus dem Süden fände k10-k11, aber den hat die Dauerzählstelle D3
    [`${K}4zu`]: ["kurz", "ohne", null],
    [`${Q}nach1`]: ["kurz", "passt", "k00-k01"],
    [`${Q}nach2`]: ["kurz", "passt", "k01-k00"],
  });
  await expect(page.locator("#kurz-text")).toContainText("1 Knoten, 1 Querschnitt");
  await expect(page.locator("#kurz-export")).toBeVisible();
  const xml = (await lade(page, "#kurz-xml")).text;
  wieErwartet("counts-kurzzeit.xml", xml);
  // Zufahrt aus Arm 3 (Osten), 7–8 Uhr: die Ströme 3→1, 3→2, 3→4 mit 31, 32 und 34
  const ort = xml.slice(xml.indexOf(`id="${K}3zu"`));
  expect(ort.slice(0, ort.indexOf("</location>"))).toMatch(/<value t="25200" val="97(\.0)?"\/>/);
  expect(xml).not.toContain(`${K}4zu`);
  // die counts.xml der Dauerzählstellen bleibt dieselbe wie ohne Kurzzeitzählungen
  wieErwartet("counts.xml", (await lade(page, "#counts-xml")).text);
});

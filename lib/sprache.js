// Die Sprache der Oberfläche: Englisch (Vorgabe) oder Deutsch. Texte stehen dort, wo sie gebraucht
// werden, in beiden Sprachen: tx("Deutsch", "English"). Die Seite setzt die Sprache aus ?lang=
// oder der gemerkten Wahl; der Worker bekommt sie mit jedem Auftrag. Ausgaben (counts.xml,
// Zuordnung, Konfiguration) und Texte aus den Daten der Zählkarte bleiben, wie sie sind.

export const SPRACHEN = ["en", "de"];
export const VORGABE = "en";

let aktuell = VORGABE;

/** Die Sprache der Oberfläche, „en“ oder „de“. */
export const sprache = () => aktuell;

/** Setzt die Sprache; alles andere als „de“ wird Englisch. Gibt die gesetzte zurück. */
export function setzeSprache(s) {
  aktuell = String(s ?? "").toLowerCase().startsWith("de") ? "de" : "en";
  return aktuell;
}

/** Der Text in der Sprache der Oberfläche. */
export const tx = (de, en) => (aktuell === "de" ? de : en);

/** Das Gebietsschema für toLocaleString & Co. */
export const locale = () => (aktuell === "de" ? "de-DE" : "en-GB");

/** Eine Zahl wie in der Sprache üblich: 1.234,5 oder 1,234.5. */
export const zahl = (n, stellen = 0) => Number(n).toLocaleString(locale(), { maximumFractionDigits: stellen, minimumFractionDigits: stellen });

/** n mit Einzahl oder Mehrzahl: anzahl(2, "Link", "Links") -> „2 Links“. */
export const anzahl = (n, eins, viele) => `${zahl(n)} ${n === 1 ? eins : viele}`;

// Ein anderes Koordinatensystem für ein Netz ohne eigene Angabe („Atlantis“ oder gar keine): Liegt
// mit dem aus dem Formular keine Dauerzählstelle der Zählkarte im Gebiet des Netzes, mit einem der
// üblichen aber schon, nennt die Seite das, mit einem Knopf zum Übernehmen. Ohne die Daten der
// Zählkarte zählt nur, ob das Netz in Deutschland liegt. Ohne proj4: Die Lagen rechnet der Worker
// (lageMit in crs.js), hier wird nur entschieden.

const zahl = (n) => n.toLocaleString("de-DE");

/**
 * `jetzt`: das CRS, mit dem das Netz gelesen ist, { code, imLand, stellen }; `andere`: die übrigen,
 * mit denen es in Deutschland läge, das übliche zuerst, [{ code, stellen }]. `stellen` ist die Zahl
 * der Dauerzählstellen im Gebiet des Netzes, null ohne die Daten der Zählkarte.
 * -> null, wenn es nichts zu sagen gibt, sonst { text, besser: [{ code, stellen }] }, höchstens zwei
 * Vorschläge, der beste zuerst.
 */
export function crsVorschlag(jetzt, andere) {
  const mitDaten = jetzt.stellen != null;
  // mit Stellen im Netz passt das CRS wohl; ein anderes mit mehr Stellen läge nur woanders
  if (mitDaten ? jetzt.stellen > 0 : jetzt.imLand) return null;
  const besser = (mitDaten ? andere.filter((k) => k.stellen > 0).sort((a, b) => b.stellen - a.stellen) : andere).slice(0, 2);
  if (!besser.length) {
    if (jetzt.imLand) return null;
    return { text: `Mit ${jetzt.code} liegt das Netz nicht in Deutschland, wo die Zählkarte zählt, und keins der hier bekannten Koordinatensysteme legt es dorthin. Das richtige steht in der Config, mit der MATSim das Netz geschrieben hat (global.coordinateSystem).`, besser };
  }
  if (!mitDaten) return { text: `Mit ${jetzt.code} liegt das Netz nicht in Deutschland, wo die Zählkarte zählt; mit ${besser.map((k) => k.code).join(" oder ")} läge es dort.`, besser };
  const vorher = jetzt.imLand ? `Mit ${jetzt.code} liegt keine Dauerzählstelle der Zählkarte im Gebiet des Netzes.` : `Mit ${jetzt.code} liegt das Netz nicht in Deutschland und keine Dauerzählstelle der Zählkarte in seinem Gebiet.`;
  const nachher = besser.map((k, i) => `${i ? "mit" : "Mit"} ${k.code} ${k.stellen === 1 ? "wäre es eine" : `wären es ${zahl(k.stellen)}`}`).join(", ");
  return { text: `${vorher} ${nachher}.`, besser };
}

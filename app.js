// MATSim Counts Snapper: Netz laden, Dauerzählstellen der Zählkarte auf Links legen, prüfen,
// mitteln und als counts.xml ausgeben. Das Netz liegt im Worker; hier leben Karte und Oberfläche.
// Ein Netz ist ein MATSim-Netz oder ein OSM-Auszug (.osm.pbf); aus OSM gibt es nur die Zuordnung,
// die sich mit ihrem Anker (Punkt, Richtung, OSM-Weg) auf ein MATSim-Netz übertragen lässt.
// Wahlweise kommen Kurzzeitzählungen dazu (lib/kurzzeit.js): je Knotenarm eine Zufahrt und eine
// Ausfahrt, je Querschnitt die Fahrtrichtungen. Sie sind eine zweite Familie von Stellen
// (`familie: "kurz"`), gehen nach den Dauerzählstellen an die Links und in eine eigene Datei.
import { STANDARD_DATEN, VERTRAG, GRUPPEN, leseIndex, leseStunden, detailPfad, tagNr, isoTag, wochentag } from "./lib/zaehlkarte.js";
import { kurz } from "./lib/richtung.js";
import { verteile } from "./lib/zuordnung.js";
import { VORGABE as MITTEL_VORGABE, WOCHENTAGE, mittle, aggregatText, auswahlText } from "./lib/mitteln.js";
import { countsXml, zuordnungCsv, leseZuordnungCsv } from "./lib/counts.js";
import { OSM_FILTER } from "./lib/osm.js";
import { baueKonfiguration, leseKonfiguration, entscheidung as konfigEntscheidung } from "./lib/konfig.js";
import { crsVorschlag } from "./lib/crsvorschlag.js";
import { tx, sprache, setzeSprache, zahl, anzahl, VORGABE as SPRACHE_VORGABE } from "./lib/sprache.js";
import { baueGebiet, imGebiet as punktImGebiet, gebietGeojson, leseGeojson, lesePoly, leseShp, leseZip, crsAusPrj, siehtNachGradAus, umrechnen, ueberschneidet, VEREINFACHT_M } from "./lib/gebiet.js";
import { STROEME_VERTRAG, KURZ_GRUPPEN, KURZ_VORGABE, TAGTYP, leseManifest, leseStellen, stroemePfad, waehleZaehlungen, punkte as kurzPunkte, lizenzenVon } from "./lib/kurzzeit.js";

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Die Sprache der Oberfläche steht in <html lang>, gesetzt vom Skript im Kopf der Seite (?lang=,
// sonst die gemerkte Wahl, sonst Englisch); Texte entstehen mit tx("Deutsch", "English").
setzeSprache(document.documentElement.lang);
// Zahlen und Daten wie in der Sprache üblich: 1.234,5 oder 1,234.5 (lib/sprache.js); anzahl() von dort
const nr = zahl;
/** Zahlen in Ausgaben (counts.xml, Zuordnung): immer wie bisher deutsch, gleich in jeder Sprache. */
const nrAusgabe = (n, digits = 0) => Number(n).toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits });
/** 2026-11-23 -> 23.11.2026 auf Deutsch, auf Englisch bleibt es so; anderes bleibt, wie es ist. */
const datumAnzeige = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? (sprache() === "de" ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso.slice(0, 10)) : iso ?? "?");
const mb = (bytes) => `${nr(bytes / 1048576, bytes < 10485760 ? 1 : 0)} MB`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reason = (err) => (err?.name === "TypeError" ? tx("nicht erreichbar oder vom Browser blockiert", "unreachable or blocked by the browser") : err?.message ?? String(err));
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* privater Modus, Speicher gesperrt */ } },
};

// VSP's öffentliches SVN an der TU Berlin; es erlaubt anderen Seiten das Lesen (CORS), wie in kachelwerk
const SVN_ROOT = "https://svn.vsp.tu-berlin.de/repos/public-svn/matsim/scenarios/countries/de/";
const BASEMAPS = { positron: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
// Beispiel: das alte Berliner Netz aus matsim-libs (2006, DHDN / Gauß-Krüger 4, ohne CRS-Angabe),
// zur Laufzeit geladen und nicht Teil dieses Repositorys; auf einen Commit festgelegt
const BEISPIEL = {
  url: "https://raw.githubusercontent.com/matsim-org/matsim-libs/b5a8ff72f1a850a36d01268c8b39c3f867c2948e/examples/scenarios/berlin/network.xml.gz",
  seite: "https://github.com/matsim-org/matsim-libs/tree/b5a8ff72f1a850a36d01268c8b39c3f867c2948e/examples/scenarios/berlin",
  crs: "EPSG:31468",
  name: "berlin-network.xml.gz",
};
const LAGEN = ["pruefen", "ohne", "passt", "geprueft", "aus", "quer"];
// „quer“: eine Dauerzählstelle, die beide Richtungen zusammen zählt oder keine nennt; nur angezeigt
const LAGE_TEXTE = {
  de: { passt: "passt", pruefen: "prüfen", geprueft: "geprüft", ohne: "ohne Link", aus: "ausgelassen", quer: "nicht richtungsfein" },
  en: { passt: "matched", pruefen: "to review", geprueft: "reviewed", ohne: "no link", aus: "skipped", quer: "not directional" },
};
const lageText = (l) => LAGE_TEXTE[sprache()][l] ?? l;
const LAGE_FARBE = { passt: "--st-passt", pruefen: "--st-pruefen", geprueft: "--st-geprueft", ohne: "--st-ohne", aus: "--st-aus", quer: "--st-quer" };
const GRUPPE_FARBE = { kfz: "#1f4ea3", lkw: "#c0522b", sv: "#8f4fb3", rad: "#2e7d32", fuss: "#6b7785" };
const WEIT_M = 20; // ab hier ist eine Zuordnung zu prüfen
const WINKEL_PRUEFEN = 35; // Grad

const params = new URLSearchParams(location.search);
const DATEN = (params.get("daten") || STANDARD_DATEN).replace(/\/?$/, "/");

const state = {
  daten: null, // leseIndex(...)
  datenFehler: null,
  netz: null, // { name, url, geoName, geoUrl, info, key, beispiel }
  letzterVersuch: null, // das zuletzt gewählte Netz, auch wenn es nicht zu lesen war
  einpassen: false, // nach dem nächsten Suchen die Karte auf die Stellen einpassen
  bereich: null, // alle Stellen im Netzgebiet mit Grund, warum sie (nicht) dabei sind
  stellen: [], // die gewählten Stellen
  byId: new Map(),
  ergebnisse: new Map(), // id -> { x, y, kandidaten }
  wahl: new Map(), // id -> Kandidat (automatisch)
  entscheid: new Map(), // id -> { link (Steckbrief) | null, aus, kommentar }
  auswahl: null,
  filter: "alle",
  pick: false,
  stunden: new Map(), // id -> leseStunden(...)
  chunks: new Map(), // chunk -> Promise
  gruppen: {
    kfz: { an: true, mode: "car", link: "car" },
    lkw: { an: false, mode: "truck", link: "car" },
    sv: { an: false, mode: "truck", link: "car" },
    rad: { an: true, mode: "bike", link: "bike" },
    fuss: { an: false, mode: "walk", link: "walk" },
  },
  mittel: { ...MITTEL_VORGABE },
  ergebnisMittel: new Map(), // id -> { gruppe: mittle(...) }
  suchToken: 0,
  ladeNr: 0, // das jüngste Netz gewinnt, wenn zwei gleichzeitig gelesen werden
  familie: "alle", // Filter der Liste: alle, dauer, kurz
  gebiet: null, // nur Stellen darin (lib/gebiet.js); null: das ganze Netz
  zeichnen: null, // { punkte, zeiger }, solange ein Gebiet gezeichnet wird
  // Kurzzeitzählungen: Einstellungen, Daten der Zählkarte (manifest.json, index.json, stroeme/…)
  kurz: {
    an: false,
    opts: { ...KURZ_VORGABE, lieferungen: {} }, // lieferungen: „quelle:code“ -> an/aus, wo jemand gewählt hat
    manifest: null, // leseManifest(...)
    stellen: null, // leseStellen(...): Map ID -> Stelle
    dateien: new Map(), // "quelle-jahr" -> Promise des JSON
    laedt: null, // Promise, solange manifest und index kommen
    fehler: null,
    info: null, // was die letzte Auswahl ergab
  },
};
const KURZ_LISTE_MAX = 400; // so viele Stellen zeigt die Liste höchstens, die gewählte immer
/** Der Name einer Gruppe: auf Deutsch wie in den Daten der Zählkarte, auf Englisch wie in ihrer englischen Oberfläche. */
const GRUPPEN_NAMEN = {
  de: { kfz: "Kfz", lkw: "Lkw", sv: "Schwerverkehr", rad: "Rad", fuss: "Fuß" },
  en: { kfz: "Motor vehicles", lkw: "Trucks", sv: "Heavy vehicles", rad: "Cyclists", fuss: "Pedestrians" },
};
const gruppenName = (g, namen = state.daten?.gruppenNamen) => (sprache() === "de" ? namen?.[g] ?? GRUPPEN_NAMEN.de[g] : GRUPPEN_NAMEN.en[g]) ?? g;
// Familien: dauer (gerichtete Dauerzählstellen), kurz (Kurzzeit-Punkte), quer (Dauerzählstellen
// ohne Richtung: auf Karte und Liste, aber ohne Linksuche, Zuordnung und Ausgabe)
const familieVon = (s) => s?.familie ?? "dauer";
// Kurzzeit-IDs tragen Zählung und Arm hinter „/“; die der Dauerzählstellen nie
const familieVonId = (id) => (String(id).includes("/") ? "kurz" : "dauer");

// ---------- Status ----------
// Der Text darf eine Funktion sein: Beim Wechsel der Sprache baut sie ihn neu (renderSprache).
let letzterStatus = null;
function setStatus(text, kind = "busy", pct = null) {
  letzterStatus = { text, kind, pct };
  if (typeof text === "function") text = text();
  $("status-text").textContent = text;
  $("status").dataset.state = kind;
  const bar = $("bar");
  bar.hidden = kind !== "busy";
  bar.classList.toggle("indeterminate", pct === null);
  bar.querySelector("i").style.width = pct === null ? "" : `${Math.max(2, Math.min(100, pct))}%`;
  if (kind === "busy" || !netzLaedt) {
    $("busy").hidden = kind !== "busy";
    $("busy").textContent = text;
  } else $("busy").textContent = tx("Netz zeichnen …", "Drawing the network …");
}

// ---------- Worker ----------
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let token = 0;
const offen = new Map();
function frage(msg, transfer = []) {
  const t = ++token;
  return new Promise((resolve, reject) => {
    offen.set(t, { resolve, reject });
    worker.postMessage({ ...msg, token: t, sprache: sprache() }, transfer);
  });
}
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "status") return setStatus(m.text);
  const o = offen.get(m.token);
  if (!o) return;
  offen.delete(m.token);
  if (m.type === "error") o.reject(new Error(m.message));
  else o.resolve(m);
};
worker.onerror = (e) => {
  for (const o of offen.values()) o.reject(new Error(e.message || tx("Der Worker ist abgestürzt.", "The worker crashed.")));
  offen.clear();
};

// ---------- Karte ----------
const mapwrap = $("mapwrap");
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const plainStyle = () => ({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": css("--map-bg") } }] });
const map = new maplibregl.Map({ container: "map", style: plainStyle(), center: [13.4, 52.52], zoom: 10, dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true } });
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
let styleReady = false;
let netzUrl = null; // GeoJSON des Netzes als blob:
let basemap = null;

/** Pfeile als SDF-Bilder: „pfeil“ zeigt nach rechts (entlang einer Linie), „nord“ nach oben. */
function pfeilBild(richtung) {
  const s = 32;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.translate(s / 2, s / 2);
  if (richtung === "nord") g.rotate(-Math.PI / 2);
  g.beginPath();
  g.moveTo(-7, -9);
  g.lineTo(8, 0);
  g.lineTo(-7, 9);
  g.lineTo(-3, 0);
  g.closePath();
  g.fillStyle = "#000";
  g.fill();
  const d = g.getImageData(0, 0, s, s);
  return { width: s, height: s, data: new Uint8Array(d.data.buffer) };
}

const lageFarbe = () => ["match", ["get", "lage"], ...LAGEN.flatMap((l) => [l, css(LAGE_FARBE[l])]), css("--st-aus")];
const netzFarbe = () => (basemap === "dark" ? "#7d8a9c" : basemap === "positron" ? "#5f6b79" : css("--muted"));
const halo = () => (basemap === "dark" ? "#0c0c0c" : basemap === "positron" ? "#ffffff" : css("--map-bg"));
const maskeFarbe = () => (basemap === "dark" || darkScheme.matches ? "#000000" : "#1b2430");
const maskeDeckung = () => (basemap === "dark" || darkScheme.matches ? 0.38 : 0.16);

const EIGENE = ["gebiet-maske", "gebiet-rand", "gebiet-entwurf", "gebiet-ecken", "kandidaten-linie", "zuordnung-linie", "zuordnung-pfeil", "auswahl-linie", "schnapp-linie", "kandidaten-rang", "arme-linie", "stellen-kreis", "stellen-pfeil", "auswahl-kreis", "auswahl-pfeil"];
// Kurzzeit-Punkte als Ring (innen der Hintergrund), Dauerzählstellen gefüllt; die gewählte Stelle immer gefüllt
const istKurz = ["==", ["get", "kurz"], 1];
const istSel = ["==", ["get", "sel"], 1];
const kreisFarbe = () => ["case", ["all", istKurz, ["!", istSel]], halo(), lageFarbe()];
const kreisRand = () => ["case", istSel, css("--fg"), istKurz, lageFarbe(), halo()];
const pfeilFarbe = () => ["case", ["all", istKurz, ["!", istSel]], lageFarbe(), "#ffffff"];
// MATSim fährt rechts: Hin- und Rückrichtung liegen ab Zoom 14 nebeneinander, jede auf ihrer Seite
const VERSATZ = ["interpolate", ["linear"], ["zoom"], 13, 0, 15, 1.5, 17, 3.5, 19, 6];

/** Alle eigenen Quellen und Ebenen, nach jedem Wechsel der Hintergrundkarte von vorn. */
function zeichneEbenen() {
  if (!styleReady) return;
  for (const name of ["pfeil", "nord"]) if (!map.hasImage(name)) map.addImage(name, pfeilBild(name), { sdf: true });
  const leer = { type: "FeatureCollection", features: [] };
  // das Netz unter die Beschriftungen der Hintergrundkarte und unter die eigenen Ebenen
  const vor = map.getStyle().layers.find((l) => l.type === "symbol" && !EIGENE.includes(l.id))?.id ?? EIGENE.find((id) => map.getLayer(id));
  if (netzUrl && !map.getSource("netz")) {
    // große Netze: weniger Überlappung und keine Kacheln über Zoom 16, das spart Zeit beim Zeichnen
    map.addSource("netz", { type: "geojson", data: netzUrl, promoteId: "i", maxzoom: 16, buffer: 32, tolerance: 0.5 });
    netzZeichnen(true);
    map.addLayer({
      id: "netz-linie",
      type: "line",
      source: "netz",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": netzFarbe(),
        "line-opacity": ["case", ["==", ["get", "car"], 1], 0.75, 0.4],
        "line-offset": VERSATZ,
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 9, 0.3, 13, ["case", [">=", ["get", "cap"], 3000], 1.6, 0.9], 17, ["case", [">=", ["get", "cap"], 3000], 6, 3]],
      },
    }, vor);
    map.addLayer({
      id: "netz-hover",
      type: "line",
      source: "netz",
      layout: { "line-cap": "round" },
      paint: { "line-color": css("--signal"), "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 18, 10], "line-offset": VERSATZ, "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.9, 0] },
    }, vor);
  }
  const quelle = (id, data) => {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: data ?? leer });
  };
  quelle("kandidaten");
  quelle("zuordnung");
  quelle("schnapp");
  quelle("arme");
  quelle("stellen");
  quelle("auswahl");
  quelle("gebiet");
  quelle("gebiet-ecken");
  // die Karte zeigt neue Daten, sobald sie gezeichnet werden
  gezeichnet = -1;
  const add = (layer, before) => { if (!map.getLayer(layer.id)) map.addLayer(layer, before); };
  const linie = { layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": lageFarbe(), "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, ["case", istSel, 9, 6]], "line-offset": VERSATZ, "line-opacity": 0.9 } };
  const kreis = { paint: { "circle-color": kreisFarbe(), "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, ["case", istSel, 6, istKurz, 2.5, 3.5], 15, ["case", istSel, 11, istKurz, 6, 7]], "circle-stroke-color": kreisRand(), "circle-stroke-width": ["case", istSel, 2.5, istKurz, 2, 1.2] } };
  const pfeil = { minzoom: 12, layout: { "icon-image": "nord", "icon-rotate": ["get", "grad"], "icon-rotation-alignment": "map", "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.3, 16, 0.5], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": pfeilFarbe() } };
  const istPunkt = ["==", ["geometry-type"], "Point"];
  // das Gebiet: draußen abgedunkelt, darüber sein Rand; beim Zeichnen die Linie bis zum Zeiger
  const art = (a) => ["==", ["get", "art"], a];
  add({ id: "gebiet-maske", type: "fill", source: "gebiet", filter: art("maske"), paint: { "fill-color": maskeFarbe(), "fill-opacity": maskeDeckung() } });
  add({ id: "gebiet-rand", type: "line", source: "gebiet", filter: art("rand"), layout: { "line-join": "round" }, paint: { "line-color": css("--accent"), "line-width": 2, "line-opacity": 0.9 } });
  add({ id: "gebiet-entwurf", type: "line", source: "gebiet", filter: art("entwurf"), layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": css("--accent"), "line-width": 2, "line-dasharray": [2, 1.5] } });
  add({ id: "kandidaten-linie", type: "line", source: "kandidaten", layout: { "line-cap": "round" }, paint: { "line-color": css("--fg"), "line-width": 2.5, "line-offset": VERSATZ, "line-dasharray": [1.2, 1.4], "line-opacity": 0.85 } });
  add({ id: "zuordnung-linie", type: "line", source: "zuordnung", ...linie });
  add({ id: "zuordnung-pfeil", type: "symbol", source: "zuordnung", minzoom: 13, layout: { "symbol-placement": "line", "symbol-spacing": 36, "icon-image": "pfeil", "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.35, 17, 0.6], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": halo() } });
  add({ id: "auswahl-linie", type: "line", source: "auswahl", filter: ["==", ["geometry-type"], "LineString"], ...linie });
  add({ id: "schnapp-linie", type: "line", source: "schnapp", paint: { "line-color": lageFarbe(), "line-width": 1.5, "line-dasharray": [1, 1.5] } });
  // Zahlen brauchen Glyphen; die Karte „Ohne“ hat keine, dann stehen die Ränge nur in der Tabelle
  if (map.getStyle().glyphs) add({ id: "kandidaten-rang", type: "symbol", source: "kandidaten", minzoom: 13, layout: { "symbol-placement": "line-center", "text-field": ["to-string", ["get", "rang"]], "text-size": 13, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true }, paint: { "text-color": css("--fg"), "text-halo-color": halo(), "text-halo-width": 2.5 } });
  // vom Knoten zu den Punkten seiner Arme
  add({ id: "arme-linie", type: "line", source: "arme", minzoom: 14, paint: { "line-color": css("--muted"), "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.8 } });
  add({ id: "stellen-kreis", type: "circle", source: "stellen", ...kreis });
  add({ id: "stellen-pfeil", type: "symbol", source: "stellen", filter: [">=", ["get", "grad"], 0], ...pfeil });
  // die gewählte Stelle obenauf, aus einer eigenen kleinen Quelle: Wählen zeichnet nicht alle neu
  add({ id: "auswahl-kreis", type: "circle", source: "auswahl", filter: istPunkt, ...kreis });
  add({ id: "auswahl-pfeil", type: "symbol", source: "auswahl", filter: ["all", istPunkt, [">=", ["get", "grad"], 0]], ...pfeil });
  // die Ecken des Gebiets obenauf, damit sie sich greifen lassen
  add({ id: "gebiet-ecken", type: "circle", source: "gebiet-ecken", paint: { "circle-radius": ["case", ["==", ["get", "erste"], 1], 7, 5], "circle-color": "#ffffff", "circle-stroke-color": css("--accent"), "circle-stroke-width": 2 } });
  zeichneDaten();
  zeichneGebiet();
}

/** Solange MapLibre das Netz aufbereitet, sagt die Karte es; bei großen Netzen dauert das. */
let netzLaedt = false;
function netzZeichnen(an) {
  netzLaedt = an;
  if (an) {
    $("busy").textContent = tx("Netz zeichnen …", "Drawing the network …");
    $("busy").hidden = false;
  } else if ($("status").dataset.state !== "busy") $("busy").hidden = true;
}
map.on("sourcedata", (e) => {
  if (netzLaedt && e.sourceId === "netz" && map.isSourceLoaded("netz")) netzZeichnen(false);
});

function setzeDaten(id, fc) {
  map.getSource(id)?.setData(fc);
}

// Stand der Zuordnung: wächst mit jeder Verteilung (verteileNeu). Die Karte zeichnet alle Stellen
// nur neu, wenn er sich geändert hat; mit Tausenden von Kurzzeit-Punkten kostet das spürbar Zeit.
let stand = 0;
let gezeichnet = -1;

/** Die Stellen, ihre Links und die Kandidaten der gewählten Stelle als GeoJSON; die gewählte Stelle eigens. */
function zeichneDaten() {
  if (!styleReady) return;
  const punkt = (s, sel) => ({ type: "Feature", properties: { id: s.id, lage: lageVon(s), sel, grad: s.r.grad ?? -1, kurz: familieVon(s) === "kurz" ? 1 : 0 }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } });
  const linkLinie = (s, sel) => {
    const lage = lageVon(s);
    const link = lage === "aus" ? null : linkVon(s);
    return link?.geom?.length >= 2 ? { type: "Feature", properties: { stelle: s.id, lage, sel }, geometry: { type: "LineString", coordinates: link.geom } } : null;
  };
  if (gezeichnet !== stand) {
    gezeichnet = stand;
    const stellen = [];
    const zuordnung = [];
    const schnapp = [];
    const arme = [];
    for (const s of state.stellen) {
      stellen.push(punkt(s, 0));
      if (familieVon(s) === "kurz" && s.kurz.art === "knoten") arme.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[s.kurz.knoten.lon, s.kurz.knoten.lat], [s.lon, s.lat]] } });
      const l = linkLinie(s, 0);
      if (!l) continue;
      zuordnung.push(l);
      const p = naechsterPunktWgs(s.lon, s.lat, l.geometry.coordinates);
      if (p) schnapp.push({ type: "Feature", properties: { lage: l.properties.lage }, geometry: { type: "LineString", coordinates: [[s.lon, s.lat], p] } });
    }
    setzeDaten("stellen", { type: "FeatureCollection", features: stellen });
    setzeDaten("zuordnung", { type: "FeatureCollection", features: zuordnung });
    setzeDaten("schnapp", { type: "FeatureCollection", features: schnapp });
    setzeDaten("arme", { type: "FeatureCollection", features: arme });
  }
  const s = state.byId.get(state.auswahl);
  setzeDaten("auswahl", { type: "FeatureCollection", features: s ? [linkLinie(s, 1), punkt(s, 1)].filter(Boolean) : [] });
  const kand = s ? state.ergebnisse.get(s.id)?.kandidaten ?? [] : [];
  const cur = s ? linkVon(s)?.id : null;
  setzeDaten("kandidaten", {
    type: "FeatureCollection",
    features: kand.filter((k) => k.geom.length >= 2).map((k, r) => ({ type: "Feature", properties: { rang: r + 1, cur: k.id === cur ? 1 : 0 }, geometry: { type: "LineString", coordinates: k.geom } })),
  });
}

/** Der Punkt einer Linie in WGS84, der (lon, lat) am nächsten liegt, in einer örtlichen Näherung. */
function naechsterPunktWgs(lon, lat, geom) {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  for (let k = 0; k + 1 < geom.length; k++) {
    const [ax, ay] = geom[k];
    const [bx, by] = geom[k + 1];
    const dx = (bx - ax) * kx;
    const dy = by - ay;
    const ll = dx * dx + dy * dy;
    const t = ll > 0 ? Math.max(0, Math.min(1, (((lon - ax) * kx) * dx + (lat - ay) * dy) / ll)) : 0;
    const px = ax + t * (bx - ax);
    const py = ay + t * (by - ay);
    const d = Math.hypot((px - lon) * kx, py - lat);
    if (d < bestD) [best, bestD] = [[px, py], d];
  }
  return best;
}

function farbenNeu() {
  if (!styleReady) return;
  const set = (id, prop, v) => map.getLayer(id) && map.setPaintProperty(id, prop, v);
  set("netz-linie", "line-color", netzFarbe());
  set("netz-hover", "line-color", css("--signal"));
  set("kandidaten-linie", "line-color", css("--fg"));
  set("zuordnung-linie", "line-color", lageFarbe());
  set("zuordnung-pfeil", "icon-color", halo());
  set("schnapp-linie", "line-color", lageFarbe());
  set("kandidaten-rang", "text-color", css("--fg"));
  set("kandidaten-rang", "text-halo-color", halo());
  for (const id of ["stellen-kreis", "auswahl-kreis"]) {
    set(id, "circle-color", kreisFarbe());
    set(id, "circle-stroke-color", kreisRand());
  }
  for (const id of ["stellen-pfeil", "auswahl-pfeil"]) set(id, "icon-color", pfeilFarbe());
  set("auswahl-linie", "line-color", lageFarbe());
  set("arme-linie", "line-color", css("--muted"));
  set("gebiet-maske", "fill-color", maskeFarbe());
  set("gebiet-maske", "fill-opacity", maskeDeckung());
  for (const id of ["gebiet-rand", "gebiet-entwurf"]) set(id, "line-color", css("--accent"));
  set("gebiet-ecken", "circle-stroke-color", css("--accent"));
  if (map.getLayer("bg")) map.setPaintProperty("bg", "background-color", css("--map-bg"));
}

map.on("style.load", () => {
  styleReady = true;
  zeichneEbenen();
});

// Hintergrundkarten von OpenFreeMap; die Wahl merkt sich der Browser, sonst folgt sie Hell/Dunkel
const styles = {};
function baseStyle(name) {
  if (name === "none") return Promise.resolve(plainStyle());
  styles[name] ??= fetch(BASEMAPS[name]).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return styles[name].then((style) => structuredClone(style), (err) => {
    delete styles[name];
    throw err;
  });
}
let basemapChoice = store.get("snapper.basemap");
if (!["positron", "dark", "none"].includes(basemapChoice)) basemapChoice = null;
const autoBasemap = () => (darkScheme.matches ? "dark" : "positron");
let basemapToken = 0;
let basisQuellen = new Set(); // die Quellen der Hintergrundkarte; die eigenen kommen erst danach dazu
function markBasemap(name) {
  basemap = name;
  mapwrap.dataset.basemap = name;
  for (const b of $("basemap").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.value === name));
}
function basemapNichtDa() {
  const e = $("basemap-error");
  e.textContent = tx("nicht erreichbar", "unreachable");
  e.title = tx("OpenFreeMap antwortet nicht. Netz, Zählstellen und Ausgaben gehen trotzdem; ein Klick auf Positron oder Dark versucht es noch einmal.", "OpenFreeMap does not respond. Network, counting stations and outputs work anyway; clicking Positron or Dark tries again.");
  e.hidden = false;
}
async function setBasemap(name) {
  const t = ++basemapToken;
  markBasemap(name);
  $("basemap-error").hidden = true;
  let style;
  try {
    style = await baseStyle(name);
  } catch {
    if (t !== basemapToken) return;
    markBasemap("none");
    basemapNichtDa();
    style = plainStyle();
  }
  if (t !== basemapToken) return;
  styleReady = false;
  basisQuellen = new Set(Object.keys(style.sources ?? {}));
  map.setStyle(style, { diff: false });
}
// Was die Karte nicht laden kann. Kommt die Hintergrundkarte nicht (ihr TileJSON oder ihre Kacheln,
// etwa weil tiles.openfreemap.org nicht antwortet), steht das an ihren Knöpfen; alles andere und
// die Einzelheiten bleiben in der Konsole, wie ohne diesen Empfänger.
map.on("error", (e) => {
  if (e.sourceId && basisQuellen.has(e.sourceId)) {
    // eine fehlende Kachel (404) ist kein Ausfall, eine ohne Antwort (Status 0) schon
    if (!e.tile || !e.error?.status) basemapNichtDa();
    console.warn("Hintergrundkarte:", e.error?.message ?? e.error);
    return;
  }
  console.error(e.error ?? e);
});
$("basemap").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  basemapChoice = b.value;
  store.set("snapper.basemap", b.value);
  setBasemap(b.value);
});
setBasemap(basemapChoice ?? autoBasemap());
darkScheme.addEventListener("change", () => {
  if (!basemapChoice) setBasemap(autoBasemap());
  else farbenNeu();
  renderKarte();
});

// Klicks: Stelle wählen; im Wählmodus einen Link nehmen; sonst einen Link zeigen
let hoverId = null;
function hover(id) {
  if (hoverId === id) return;
  if (hoverId != null && map.getSource("netz")) map.setFeatureState({ source: "netz", id: hoverId }, { hover: false });
  hoverId = id;
  if (id != null && map.getSource("netz")) map.setFeatureState({ source: "netz", id }, { hover: true });
}
const linkUnter = (point) => (map.getLayer("netz-linie") ? map.queryRenderedFeatures([[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]], { layers: ["netz-linie"] }) : []);
map.on("mousemove", (e) => {
  if (ziehen) {
    ziehen.ring[ziehen.i] = [e.lngLat.lng, e.lngLat.lat];
    zeichneGebiet(ziehen.ring);
    return;
  }
  if (state.zeichnen) {
    state.zeichnen.zeiger = [e.lngLat.lng, e.lngLat.lat];
    zeichneGebiet();
    return;
  }
  if (!state.pick) {
    const ecke = gebietEditierbar() && map.getLayer("gebiet-ecken") && map.queryRenderedFeatures(e.point, { layers: ["gebiet-ecken"] }).length;
    const stelle = !ecke && map.getLayer("stellen-kreis") && map.queryRenderedFeatures(e.point, { layers: ["stellen-kreis"] }).length;
    map.getCanvas().style.cursor = ecke ? "move" : stelle ? "pointer" : "";
    return;
  }
  const f = linkUnter(e.point)[0];
  hover(f ? f.properties.i : null);
});
let popup = null;
/** Die Links unter dem Zeiger, jeder einmal. */
function linksUnter(point) {
  const gesehen = new Set();
  return linkUnter(point).map((f) => f.properties.i).filter((i) => !gesehen.has(i) && gesehen.add(i));
}
map.on("click", async (e) => {
  if (state.zeichnen) return zeichnePunkt(e);
  if (Date.now() - gezogen < 400) return; // das Ende eines Zugs an einer Ecke
  const st = map.getLayer("stellen-kreis") ? map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: ["stellen-kreis"] }) : [];
  if (st.length && !state.pick) return waehle(st[st.length - 1].properties.id, { fliegen: false });
  const ids = linksUnter(e.point).slice(0, 6);
  if (!ids.length) return;
  const s = state.byId.get(state.auswahl);
  const stelle = s ? { lon: s.lon, lat: s.lat, grad: s.r.grad } : null;
  const links = (await Promise.all(ids.map((i) => frage({ type: "link", i, stelle }).catch(() => null)))).map((r) => r?.link).filter(Boolean);
  if (!links.length) return;
  // im Wählmodus nimmt ein einzelner Link sofort; liegen Hin- und Rückrichtung übereinander, wird gefragt
  if (state.pick && s && links.length === 1) {
    pickEnde();
    return nimmLink(s.id, { i: links[0].i, link: links[0] });
  }
  zeigeLinks(e.lngLat, links, s);
});

function zeigeLinks(lngLat, links, s) {
  popup?.remove();
  const div = document.createElement("div");
  div.className = "linkwahl";
  const kannZuordnen = s && lageVon(s) !== "aus";
  if (state.pick && s) div.insertAdjacentHTML("beforeend", `<p class="note" style="margin:0 0 6px">${tx(`Hier liegen ${links.length} Links. Welcher gehört zu ${esc(s.name || s.id)}?`, `There are ${links.length} links here. Which one belongs to ${esc(s.name || s.id)}?`)}</p>`);
  for (const l of links) {
    const zeilen = [
      [tx("Richtung", "Direction"), l.grad != null ? `${kurz(l.grad)} ${nr(l.grad)}°${l.abweichung != null ? tx(`, ${nr(l.abweichung)}° Abweichung`, `, ${nr(l.abweichung)}° off`) : ""}` : null],
      [tx("Abstand", "Distance"), s && l.d != null ? `${nr(l.d, 1)} m` : null],
      ["modes", l.modes || "(car)"], ["type", l.type], ["name", l.name],
      [tx("Tempo", "Speed"), l.kmh != null ? `${nr(l.kmh, 1)} km/h` : null], ["capacity", l.capacity != null && !l.osm ? `${nr(l.capacity)} ${tx("Fz/h", "veh/h")}` : null],
    ].filter(([, v]) => v != null && v !== "");
    const box = document.createElement("div");
    box.className = "linkwahl-eintrag";
    box.innerHTML = `<strong>${kompassSvg(l.grad)}${l.osm ? tx("Kante", "Edge") : "Link"} ${esc(l.id)}</strong><dl class="linkinfo">${zeilen.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}${l.weg ? `<dt>${tx("OSM-Weg", "OSM way")}</dt><dd>${wegHtml(l.weg)}</dd>` : ""}</dl>`;
    if (kannZuordnen && linkVon(s)?.id !== l.id) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn small";
      b.textContent = tx(`${s.name || s.id} zuordnen`, `Assign to ${s.name || s.id}`);
      b.addEventListener("click", () => {
        popup?.remove();
        pickEnde();
        nimmLink(s.id, { i: l.i, link: l });
      });
      box.append(b);
    } else if (kannZuordnen) box.insertAdjacentHTML("beforeend", `<span class="note">${tx("gehört schon zu dieser Stelle", "already belongs to this station")}</span>`);
    div.append(box);
  }
  popup = new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setDOMContent(div).addTo(map);
}

/** Ein OSM-Weg als Link zu openstreetmap.org; mit Minus: gegen die Zeichenrichtung. */
function wegHtml(weg) {
  if (!weg) return "";
  const id = String(weg).replace(/^-/, "");
  if (!/^\d+$/.test(id)) return esc(weg);
  return `<a href="https://www.openstreetmap.org/way/${id}" target="_blank" rel="noopener">${id}</a>${String(weg).startsWith("-") ? tx(" (gegen die Zeichenrichtung)", " (against the direction of the way)") : ""}`;
}

/** Wie eine übernommene Zuordnung ihren Link fand (lib/uebertrag.js). */
const wieText = (wie) => ({
  id: tx("gleiche Link-ID am selben Ort", "same link ID at the same place"),
  weg: tx("gleicher OSM-Weg in derselben Richtung", "same OSM way in the same direction"),
  lage: tx("einziger passender Link am übernommenen Punkt", "only matching link at the transferred point"),
})[wie];

// ---------- Netz laden ----------
let laden = null;
async function fetchBytes(url, label, signal) {
  setStatus(tx(`${label} laden …`, `Loading ${label} …`));
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (performance.now() - shown > 150) {
      shown = performance.now();
      const known = total >= got;
      setStatus(tx(`${label} laden … ${mb(got)}${known ? ` von ${mb(total)}` : ""}`, `Loading ${label} … ${mb(got)}${known ? ` of ${mb(total)}` : ""}`), "busy", known ? (100 * got) / total : null);
    }
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

const fileName = (url) => {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
  try { return decodeURIComponent(last); } catch { return last; }
};
const folderOf = (url) => new URL(".", url).href;
const artVon = (name) => (/linkgeometr/i.test(name) || /\.csv(\.gz|\.zst)?$/i.test(name) ? "geometrien" : /\.xml(\.gz|\.zst)?$|\.pbf$/i.test(name) ? "netz" : /\.json$/i.test(name) ? "konfiguration" : /\.(geojson|poly|zip|shp|prj)$/i.test(name) ? "gebiet" : null);
const istOsmName = (name) => /\.pbf$/i.test(name ?? "");

/** Der Szenario-Stamm eines Dateinamens, wie in kachelwerk: berlin-v7.0-10pct.output_network.xml.gz (oder .zst) -> berlin-v7.0. */
function scenarioStem(name) {
  return name.toLowerCase().replace(/\.osm\.pbf$|\.pbf$/, "").replace(/\.(xml|csv)(\.gz|\.zst)?$/, "").split(/[._-]?output_|[._-]?network|[._-]?linkgeometr/)[0].replace(/[._-]\d+(\.\d+)?pct$/, "").replace(/[._-]+$/, "");
}
function stemFit(netName, geoName) {
  const a = scenarioStem(netName);
  const b = scenarioStem(geoName);
  if (!a || !b) return 0;
  if (a === b) return 2;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.startsWith(short) && /[._-]/.test(long[short.length]) ? 1 : 0;
}
function bestGeometry(netName, geos, { strict = false } = {}) {
  let best = null;
  let bestScore = -1;
  for (const g of geos) {
    const fit = stemFit(netName, g.name);
    if (strict && fit === 0) continue;
    let n = 0;
    while (n < netName.length && netName[n] === g.name[n]) n++;
    const score = fit * 1000 + n;
    if (score > bestScore) [best, bestScore] = [g, score];
  }
  return best;
}

/** Ein Netz an den Worker; danach die Zählstellen dazu. */
/** Das Netz aus der Karte nehmen. */
function netzWeg() {
  if (styleReady) {
    for (const id of ["netz-hover", "netz-linie"]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource("netz")) map.removeSource("netz");
  }
  if (netzUrl) URL.revokeObjectURL(netzUrl);
  netzUrl = null;
  netzZeichnen(false);
}

async function nimmNetz({ name, bytes, geoName = null, geoBytes = null, url = null, geoUrl = null, beispiel = false, datei = null, geoDatei = null }) {
  const ladeNr = ++state.ladeNr;
  pickEnde();
  popup?.remove();
  state.netz = null;
  state.ergebnisse.clear();
  state.wahl.clear();
  state.stellen = [];
  stand++;
  state.byId.clear();
  state.bereich = null;
  state.auswahl = null;
  renderAlles();
  renderAuswahl();
  renderQuelle({ name, url, geoName, beispiel, laeuft: true });
  setStatus(tx(`${name} lesen …`, `Reading ${name} …`));
  const kopie = { name, geoName, url, geoUrl, beispiel, datei, geoDatei };
  state.letzterVersuch = kopie;
  try {
    const transfer = [bytes.buffer];
    if (geoBytes) transfer.push(geoBytes.buffer);
    // Das Beispiel nennt kein CRS, hat aber ein bekanntes: Es gilt nur für das Beispiel, das Feld
    // bleibt für das nächste Netz, wie es ist (sonst läse ein Netz mit „Atlantis“ in Gauß-Krüger).
    const crs = beispiel ? BEISPIEL.crs : $("crs").value.trim();
    const r = await frage({ type: "netz", name, bytes, geoBytes, crs, osmFilter: $("osm-filter").value }, transfer);
    if (ladeNr !== state.ladeNr) return;
    const info = r.info;
    if (beispiel) info.crsBeispiel = true;
    netzWeg();
    netzUrl = URL.createObjectURL(new Blob([r.geojson], { type: "application/geo+json" }));
    state.netz = { name, url, geoName, geoUrl, beispiel, datei, geoDatei, info, key: url ? `url:${url}` : beispiel ? "beispiel:berlin" : `datei:${name}:${info.links}${info.osm ? `:${info.osm.filterCode}` : ""}` };
    state.einpassen = true;
    zeichneEbenen();
    if (info.bbox) map.fitBounds([[info.bbox[0], info.bbox[1]], [info.bbox[2], info.bbox[3]]], { padding: 30, duration: 0, maxZoom: 15 });
    renderQuelle(state.netz);
    updateLink();
    ladeEntscheide();
    await waehleStellen();
  } catch (err) {
    if (ladeNr !== state.ladeNr) return;
    netzWeg();
    renderQuelle(null);
    setStatus(`${name}: ${err.message}`, "error");
  }
}

async function ladeNetzVonUrl({ net, geo = "auto", beispiel = false }) {
  laden?.abort();
  const ctrl = (laden = new AbortController());
  const name = beispiel ? BEISPIEL.name : fileName(net);
  try {
    let geoUrl = null;
    // ein OSM-Auszug und das Beispiel haben keine Geometrien daneben („auto“ ist keine Datei)
    if (geo === "auto") {
      if (!beispiel && !istOsmName(net)) {
        setStatus(tx("Link-Geometrien suchen …", "Looking for link geometries …"));
        geoUrl = (await findGeometry(net).catch(() => ({ match: null }))).match?.url ?? null;
      }
    } else if (geo && geo !== "0" && !beispiel && !istOsmName(net)) {
      geoUrl = new URL(geo, folderOf(net)).href;
    }
    const bytes = await fetchBytes(net, beispiel ? tx("Beispielnetz von GitHub", "example network from GitHub") : name, ctrl.signal);
    const geoBytes = geoUrl ? await fetchBytes(geoUrl, fileName(geoUrl), ctrl.signal) : null;
    if (ctrl.signal.aborted) return;
    laden = null;
    await nimmNetz({ name, bytes, url: beispiel ? null : net, geoName: geoUrl ? fileName(geoUrl) : null, geoBytes, geoUrl, beispiel });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    laden = null;
    setStatus(tx(`${beispiel ? "Das Beispielnetz" : name} ließ sich nicht laden (${reason(err)}).`, `${beispiel ? "The example network" : name} could not be loaded (${reason(err)}).`), "error");
  }
}

async function nimmDateien(files) {
  const liste = [...files];
  if (!liste.length) return;
  const netz = liste.find((f) => artVon(f.name) === "netz");
  const geos = liste.filter((f) => artVon(f.name) === "geometrien");
  // erst eine Konfiguration, dann ein Gebiet: Beides gilt schon beim Lesen des Netzes
  const konfig = liste.find((f) => artVon(f.name) === "konfiguration");
  const gebiet = liste.filter((f) => artVon(f.name) === "gebiet");
  if (konfig && !(await nimmKonfiguration(konfig, Boolean(netz)))) return;
  if (gebiet.length && !(await nimmGebietDateien(gebiet, { waehlen: !netz }))) return;
  if (!netz) {
    if (konfig || gebiet.length) return;
    if (geos.length && state.netz) return nimmGeometrie(geos[0]);
    return setStatus(tx("Darunter ist kein Netz (MATSim network.xml, .xml.gz, .xml.zst oder OSM .osm.pbf).", "None of these is a network (MATSim network.xml, .xml.gz, .xml.zst or OSM .osm.pbf)."), "error");
  }
  const geo = geos.length ? bestGeometry(netz.name, geos.map((g) => ({ name: g.name, file: g })))?.file : null;
  await nimmNetz({
    name: netz.name,
    bytes: new Uint8Array(await netz.arrayBuffer()),
    geoName: geo?.name ?? null,
    geoBytes: geo ? new Uint8Array(await geo.arrayBuffer()) : null,
    datei: netz,
    geoDatei: geo ?? null,
  });
}

/** Die Bytes des Netzes noch einmal: von der Festplatte oder aus dem Netz. */
async function netzBytes(n) {
  if (n.datei) return new Uint8Array(await n.datei.arrayBuffer());
  return fetchBytes(n.beispiel ? BEISPIEL.url : n.url, n.name);
}

/** Geometrien zum geladenen Netz: das Netz wird dafür neu gelesen. */
async function nimmGeometrie(file) {
  const n = state.netz;
  if (!n) return;
  try {
    const bytes = await netzBytes(n);
    await nimmNetz({ ...n, bytes, geoName: file.name, geoBytes: new Uint8Array(await file.arrayBuffer()), geoDatei: file, geoUrl: null });
  } catch (err) {
    setStatus(tx(`${n.name} ließ sich nicht neu lesen (${reason(err)}).`, `${n.name} could not be read again (${reason(err)}).`), "error");
  }
}

/** Das letzte Netz noch einmal lesen, etwa mit einem anderen CRS. */
async function nochmal() {
  const n = state.netz ?? state.letzterVersuch;
  if (!n) return;
  if (n.url) return ladeNetzVonUrl({ net: n.url, geo: n.geoUrl ?? "0" });
  if (n.beispiel) return ladeNetzVonUrl({ net: BEISPIEL.url, beispiel: true });
  try {
    const bytes = await netzBytes(n);
    const geoBytes = n.geoDatei ? new Uint8Array(await n.geoDatei.arrayBuffer()) : null;
    await nimmNetz({ ...n, bytes, geoBytes });
  } catch (err) {
    setStatus(tx(`${n.name} ließ sich nicht neu lesen (${reason(err)}).`, `${n.name} could not be read again (${reason(err)}).`), "error");
  }
}

$("file").addEventListener("change", (e) => {
  nimmDateien(e.target.files);
  e.target.value = "";
});
$("geo-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) nimmGeometrie(f);
});
$("geo-clear").addEventListener("click", async () => {
  const n = state.netz;
  if (!n) return;
  if (n.url) return ladeNetzVonUrl({ net: n.url, geo: "0" });
  await nimmNetz({ ...n, bytes: await netzBytes(n), geoName: null, geoBytes: null, geoDatei: null });
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  nimmDateien(e.dataTransfer.files);
});
$("beispiel").addEventListener("click", () => ladeNetzVonUrl({ net: BEISPIEL.url, beispiel: true }));
/** Die Auswahl der Wege aus OSM, in der Sprache der Seite; die Wahl bleibt. */
function renderOsmFilter() {
  const sel = $("osm-filter");
  const wert = sel.value;
  sel.replaceChildren(...Object.entries(OSM_FILTER).map(([code, f]) => {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = f.name;
    o.title = f.text;
    return o;
  }));
  if (wert) sel.value = wert;
  $("osm-filter-text").textContent = OSM_FILTER[sel.value]?.text ?? "";
}
{
  const sel = $("osm-filter");
  renderOsmFilter();
  const gemerkt = store.get("snapper.osmFilter");
  if (gemerkt && OSM_FILTER[gemerkt]) sel.value = gemerkt;
  const hilfe = () => { $("osm-filter-text").textContent = OSM_FILTER[sel.value]?.text ?? ""; };
  hilfe();
  sel.addEventListener("change", () => {
    store.set("snapper.osmFilter", sel.value);
    hilfe();
    if (state.netz?.info?.osm) nochmal();
  });
}
/** Das CRS steht fest: aus dem Netz selbst oder das des Beispiels. Sonst gilt das Feld. */
function crsFest(info) {
  return Boolean(info?.crsAusDatei || info?.crsBeispiel);
}
$("crs").addEventListener("change", () => {
  // ein anderes CRS wirkt nur auf ein Netz ohne eigenes
  if (crsFest(state.netz?.info)) return;
  nochmal();
});

/** Die Stellen in einem Kasten [West, Süd, Ost, Nord] in WGS84, mit Rand: so weit reicht das Gebiet des Netzes. */
function imKasten(stellen, [w, s, o, n], rand = 0.002) {
  return stellen.filter((x) => x.lon >= w - rand && x.lon <= o + rand && x.lat >= s - rand && x.lat <= n + rand);
}

/**
 * Ein Netz ohne eigenes CRS: Liegt mit dem aus dem Feld keine Dauerzählstelle in seinem Gebiet, mit
 * einem der üblichen aber schon, steht das unter dem Feld, mit einem Knopf zum Übernehmen. Ohne die
 * Daten der Zählkarte nur, wenn das Netz nicht in Deutschland liegt.
 */
function renderCrsVorschlag() {
  const feld = $("crs-vorschlag");
  const info = state.netz?.info;
  const probe = info?.crsProbe;
  const d = state.daten;
  const imNetz = (bbox) => (!d ? null : bbox ? imKasten(d.stellen, bbox).length : 0);
  const v = probe && !crsFest(info) ? crsVorschlag({ code: info.crs, imLand: probe.imLand, stellen: imNetz(info.bbox) }, probe.andere.map((k) => ({ code: k.code, stellen: imNetz(k.bbox) }))) : null;
  feld.hidden = !v;
  if (!v) return;
  const knoepfe = v.besser.map((k) => ` <button type="button" class="linkbtn" data-crs="${esc(k.code)}">${esc(tx(`${k.code} nehmen`, `Use ${k.code}`))}</button>`).join("");
  feld.querySelector("small").innerHTML = `${esc(v.text)}${knoepfe}`;
}
$("crs-vorschlag").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-crs]");
  if (!b) return;
  $("crs").value = b.dataset.crs;
  nochmal();
});

function chip(text, extra = "") {
  const c = document.createElement("span");
  c.className = `chip ${extra}`.trim();
  c.textContent = text;
  return c;
}

function renderQuelle(n) {
  const platzhalter = n?.info?.crsPlatzhalter;
  $("crs-platzhalter").hidden = !platzhalter;
  if (platzhalter) {
    const vorgabe = n.info.crs === $("crs").defaultValue;
    $("crs-platzhalter").querySelector("small").textContent = tx(
      `Das Netz nennt „${platzhalter}“ als Koordinatensystem: So schreibt MATSim es, wenn in der Config global.coordinateSystem fehlt. Gelesen mit ${n.info.crs}${vorgabe ? ", der Vorgabe hier" : " aus dem Feld"}; liegt das Netz auf der Karte am falschen Ort, hier das richtige eintragen.`,
      `The network names “${platzhalter}” as its coordinate system: MATSim writes this when global.coordinateSystem is missing in the config. Read with ${n.info.crs}${vorgabe ? ", the default here" : " from the field"}; if the network is in the wrong place on the map, enter the right one here.`,
    );
  }
  renderCrsVorschlag();
  // nur die Felder, die für das Netz gelten: der OSM-Filter beim OSM-Auszug, das CRS beim MATSim-Netz
  const osmNetz = n ? Boolean(n.info?.osm) || (!n.info && istOsmName(n.name)) : null;
  $("osm-feld").hidden = osmNetz === false;
  $("crs-feld").hidden = $("crs-hinweis").hidden = osmNetz === true;
  const box = $("source");
  box.replaceChildren();
  if (!n) {
    box.innerHTML = `<span class="note">${tx("Noch kein Netz geladen.", "No network loaded yet.")}</span>`;
    return;
  }
  const name = document.createElement(n.url ? "a" : "span");
  name.className = "name";
  name.textContent = n.beispiel ? "Berlin (matsim-libs, 2006)" : n.name;
  if (n.url) {
    name.href = n.url.startsWith(SVN_ROOT) ? folderOf(n.url) : n.url;
    name.target = "_blank";
    name.rel = "noopener";
  }
  box.append(name);
  if (n.beispiel) box.append(chip(tx("Beispiel", "Example"), "example"));
  const osm = n.info?.osm;
  if (osm) {
    box.append(chip(tx("OSM-Auszug", "OSM extract"), "fit"));
    box.append(chip(tx(`${nr(osm.wege)} Wege, ${nr(n.info.links)} Kanten`, `${nr(osm.wege)} ways, ${nr(n.info.links)} edges`)));
    box.append(chip(OSM_FILTER[osm.filterCode]?.name ?? osm.filter));
  } else if (n.info) {
    box.append(chip(`${nr(n.info.links)} ${tx("Links", "links")}`));
    const crs = chip(n.info.crs + (crsFest(n.info) ? "" : tx(" aus Formular", " from form")), crsFest(n.info) ? "fit" : "");
    if (n.info.crsPlatzhalter) crs.title = tx(`Das Netz nennt „${n.info.crsPlatzhalter}“: MATSims Vorgabe, wenn beim Schreiben kein Koordinatensystem gesetzt war.`, `The network names “${n.info.crsPlatzhalter}”: MATSim's default when no coordinate system was set on writing.`);
    else if (n.info.crsBeispiel) crs.title = tx(`Das Beispielnetz nennt kein Koordinatensystem; es liegt in ${n.info.crsName}. Das Feld gilt für das nächste Netz.`, `The example network names no coordinate system; it is in ${n.info.crsName}. The field applies to the next network.`);
    box.append(crs);
    const w = n.info.wege;
    if (w?.links) {
      const c = chip(tx(`OSM-Weg an ${nr((100 * w.links) / n.info.links)} % der Links`, `OSM way on ${nr((100 * w.links) / n.info.links)} % of links`));
      c.title = w.sumo
        ? tx("Die Link-IDs sehen nach SUMO aus (Weg-ID#Abschnitt): Eine Zuordnung aus OSM lässt sich über den Weg übernehmen.", "The link IDs look like SUMO (way ID#section): an assignment from OSM can be transferred via the way.")
        : tx("Die Links tragen osm:way:id oder origid: Eine Zuordnung aus OSM lässt sich über den Weg übernehmen.", "The links carry osm:way:id or origid: an assignment from OSM can be transferred via the way.");
      box.append(c);
    }
  }
  const geo = $("geo");
  geo.hidden = !n.info;
  $("geo-file").closest("label").hidden = Boolean(osm);
  if (osm) {
    $("geo-text").innerHTML = tx(
      'Die Kanten folgen den Wegen aus OSM, geteilt an jedem Knotenpunkt, und heißen wie bei SUMO: <code>Weg-ID#Abschnitt</code>, die Gegenrichtung mit Minus. Eine <code>counts.xml</code> gibt es dafür nicht, aber eine Zuordnung, die sich auf ein MATSim-Netz übertragen lässt. Daten © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap-Mitwirkende</a> (ODbL).',
      'The edges follow the OSM ways, split at every junction, and are named as in SUMO: <code>wayID#section</code>, the opposite direction with a minus. There is no <code>counts.xml</code> for them, but an assignment that can be transferred to a MATSim network. Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL).',
    );
    $("geo-clear").hidden = true;
  } else if (n.info) {
    const g = n.info.geometrien;
    const s = n.info.stats;
    $("geo-text").innerHTML = g
      ? tx(`Link-Geometrien: <strong>${esc(n.geoName)}</strong>, ${nr(s.fromCsv)} von ${nr(n.info.links)} Links mit Verlauf.`, `Link geometries: <strong>${esc(n.geoName)}</strong>, ${nr(s.fromCsv)} of ${nr(n.info.links)} links with a shape.`)
      : s.fromOrigGeom
        ? tx(`Link-Geometrien aus <code>origgeom</code>: ${nr(s.fromOrigGeom)} Links mit Verlauf.`, `Link geometries from <code>origgeom</code>: ${nr(s.fromOrigGeom)} links with a shape.`)
        : tx("Ohne Link-Geometrien: Die Links laufen gerade von Knoten zu Knoten, die Abstände sind gröber.", "Without link geometries: links run straight from node to node, so distances are rougher.");
    $("geo-clear").hidden = !g;
  }
  const credit = $("credit");
  credit.hidden = !n.beispiel;
  if (n.beispiel) {
    credit.innerHTML = tx(
      `Beispielnetz: <a href="${BEISPIEL.seite}" target="_blank" rel="noopener"><code>examples/scenarios/berlin</code></a> aus matsim-libs, ein altes Netz der Hauptstraßen von 2006 in DHDN / Gauß-Krüger 4. Die Seite lädt es von GitHub. Neuere Netze mit Geometrien gibt es im VSP-SVN, etwa unter <code>berlin/</code>.`,
      `Example network: <a href="${BEISPIEL.seite}" target="_blank" rel="noopener"><code>examples/scenarios/berlin</code></a> from matsim-libs, an old network of the main roads from 2006 in DHDN / Gauss-Krüger 4. The page loads it from GitHub. Newer networks with geometries are in the VSP SVN, e.g. under <code>berlin/</code>.`,
    );
  }
}

// ---------- VSP-SVN, wie in kachelwerk ----------
const svn = { url: null, entries: [], token: 0, hint: null, skipToggle: false };
const listings = new Map();
function listFolder(url) {
  if (!listings.has(url)) {
    const p = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const hrefs = [...doc.querySelectorAll("li > a[href]")].map((a) => a.getAttribute("href"));
      for (const el of doc.querySelectorAll("index > dir[href], index > file[href]")) {
        const href = el.getAttribute("href");
        hrefs.push(el.localName === "dir" && !href.endsWith("/") ? `${href}/` : href);
      }
      const entries = [];
      for (const href of hrefs) {
        let abs;
        try { abs = new URL(href, url).href; } catch { continue; }
        if (!abs.startsWith(url) || abs === url) continue;
        let name = abs.slice(url.length).replace(/\/$/, "");
        try { name = decodeURIComponent(name); } catch { /* bleibt kodiert */ }
        if (!name || name.includes("/")) continue;
        entries.push({ name, url: abs, dir: abs.endsWith("/") });
      }
      const natural = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
      return entries.sort((a, b) => b.dir - a.dir || natural.compare(a.name, b.name));
    })();
    listings.set(url, p);
    p.catch(() => listings.delete(url));
  }
  return listings.get(url);
}
const isGeometryEntry = (e) => !e.dir && artVon(e.name) === "geometrien" && /linkgeometr/i.test(e.name);

async function geometriesNear(folder) {
  const entries = await listFolder(folder).catch(() => []);
  const near = [{ folder, geos: entries.filter(isGeometryEntry) }];
  for (const dir of entries.filter((e) => e.dir && /^input$/i.test(e.name))) {
    near.push({ folder: dir.url, geos: (await listFolder(dir.url).catch(() => [])).filter(isGeometryEntry) });
  }
  return near;
}

/** Die Link-Geometrien eines Netzes auf einem Server: daneben jede; weiter oben nur eine desselben Szenarios. */
async function findGeometry(netUrl, name = fileName(netUrl)) {
  let folder = folderOf(netUrl);
  const here = (await listFolder(folder).catch(() => [])).filter(isGeometryEntry);
  if (here.length) return { match: bestGeometry(name, here), folder };
  const top = new URL("/", folder).href;
  for (let up = 0; up < 4; up++) {
    if (folder === SVN_ROOT || folder === top) break;
    folder = new URL("../", folder).href;
    if (folder === SVN_ROOT || folder === top) break;
    for (const near of await geometriesNear(folder)) {
      const match = bestGeometry(name, near.geos, { strict: true });
      if (match) return { match, folder: near.folder };
    }
  }
  return { match: null, folder: null };
}

function svnNote(text) {
  $("svn-note").textContent = text ?? "";
  $("svn-note").hidden = !text;
}

async function openFolder(url) {
  if (!url.endsWith("/")) url += "/";
  const t = ++svn.token;
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = tx("Ordner laden …", "Loading folder …");
  $("svn-list").replaceChildren(li);
  svnNote(null);
  try {
    const entries = await listFolder(url);
    if (t !== svn.token) return;
    Object.assign(svn, { url, entries });
    store.set("snapper.svn", url);
    renderSvn();
  } catch (err) {
    if (t !== svn.token) return;
    Object.assign(svn, { url, entries: [] });
    renderSvn();
    svnNote(tx(`Der Ordner ließ sich nicht laden (${reason(err)}).`, `The folder could not be loaded (${reason(err)}).`));
  }
}

function renderSvn() {
  const inRoot = svn.url.startsWith(SVN_ROOT);
  const base = inRoot ? SVN_ROOT : new URL("/", svn.url).href;
  const crumb = (label, url) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.url = url;
    return b;
  };
  const crumbs = [crumb(inRoot ? "countries/de" : new URL(svn.url).host, base)];
  let at = base;
  for (const part of svn.url.slice(base.length).split("/").filter(Boolean)) {
    at += `${part}/`;
    const sep = document.createElement("span");
    sep.textContent = "/";
    let label = part;
    try { label = decodeURIComponent(part); } catch { /* bleibt kodiert */ }
    crumbs.push(sep, crumb(label, at));
  }
  $("svn-crumbs").replaceChildren(...crumbs);
  const items = [];
  const item = (e, kind) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = e.dir ? "dir" : "file";
    Object.assign(b.dataset, { url: e.url, kind });
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = e.dir && e.name !== ".." ? `${e.name}/` : e.name;
    b.append(n);
    if (kind === "netz") b.append(chip(tx("Netz", "Network")));
    if (kind === "geometrien") {
      b.append(chip(tx("Geometrien", "Geometries")));
      if (state.netz && stemFit(state.netz.name, e.name)) b.append(chip(tx("passt zum Netz", "fits the network"), "fit"));
    }
    li.append(b);
    return li;
  };
  if (svn.url !== base) items.push(item({ name: "..", url: new URL("../", svn.url).href, dir: true }, "dir"));
  let hidden = 0;
  for (const e of svn.entries) {
    const kind = e.dir ? "dir" : isGeometryEntry(e) ? "geometrien" : artVon(e.name) === "netz" && /network/i.test(e.name) ? "netz" : null;
    if (kind) items.push(item(e, kind));
    else hidden++;
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = tx("Leer", "Empty");
    items.push(li);
  }
  $("svn-list").replaceChildren(...items);
  $("svn-list").scrollTop = 0;
  svnNote([svn.hint, hidden ? tx(`${nr(hidden)} weitere Datei${hidden === 1 ? "" : "en"} ausgeblendet.`, `${nr(hidden)} more file${hidden === 1 ? "" : "s"} hidden.`) : null].filter(Boolean).join(" ") || null);
}

$("svn").addEventListener("toggle", () => {
  if ($("svn").open && !svn.url) openFolder(store.get("snapper.svn") ?? SVN_ROOT);
});
$("svn-crumbs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) openFolder(b.dataset.url);
});
$("svn-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const { url, kind } = b.dataset;
  if (kind === "dir") return openFolder(url);
  if (kind === "geometrien") {
    if (!state.netz?.url) return svnNote(tx("Link-Geometrien gehören zu einem Netz aus dem SVN. Wähle zuerst das Netz.", "Link geometries belong to a network from the SVN. Choose the network first."));
    return ladeNetzVonUrl({ net: state.netz.url, geo: url });
  }
  ladeNetzVonUrl({ net: url, geo: "auto" });
});
$("svn-url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("svn-url").value.trim();
  if (!value) return;
  let url;
  try {
    url = new URL(value, svn.url ?? SVN_ROOT).href;
  } catch {
    return svnNote(tx("Das ist kein gültiger Pfad und keine gültige Adresse.", "That is neither a valid path nor a valid address."));
  }
  if (url.endsWith("/")) openFolder(url);
  else ladeNetzVonUrl({ net: url, geo: "auto" });
});

// ---------- Adresszeile: ?net=…&geo=…&crs=…&daten=…&lang=de ----------
function relativeTo(folder, url) {
  if (url.startsWith(folder)) return url.slice(folder.length);
  const a = new URL(folder);
  const b = new URL(url);
  if (a.origin !== b.origin) return url;
  const from = a.pathname.split("/").slice(0, -1);
  const to = b.pathname.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return "../".repeat(from.length - i) + to.slice(i).join("/");
}
function updateLink() {
  const n = state.netz;
  const p = new URLSearchParams();
  if (n?.url) {
    p.set("net", n.url.startsWith(SVN_ROOT) ? n.url.slice(SVN_ROOT.length) : n.url);
    if (n.geoUrl) p.set("geo", relativeTo(folderOf(n.url), n.geoUrl));
    else p.set("geo", "0");
    if (!n.info?.crsAusDatei) p.set("crs", n.info?.crs ?? $("crs").value.trim());
  }
  if (DATEN !== STANDARD_DATEN) p.set("daten", DATEN);
  // die Sprache nur, wenn sie nicht die Vorgabe ist: so öffnet ein geteilter Link in derselben
  if (sprache() !== SPRACHE_VORGABE) p.set("lang", sprache());
  if (params.has("debug")) p.set("debug", "");
  const q = p.toString().replace(/%2F/g, "/").replace(/%3A/g, ":");
  history.replaceState(null, "", q ? `?${q}` : location.pathname);
}

// ---------- Zählkarte ----------
async function ladeDaten() {
  try {
    const res = await fetch(`${DATEN}dauer/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.daten = leseIndex(await res.json());
    renderDatenText();
    renderGruppen();
    if (state.netz) await waehleStellen();
  } catch (err) {
    state.datenFehler = err;
    renderDatenText();
    if (state.netz) setStatus(() => tx("Ohne die Daten der Zählkarte gibt es nichts zuzuordnen.", "Without the Zählkarte data there is nothing to assign."), "error");
  }
}

/**
 * Was von der Zählkarte da ist: mit Netz die Dauerzählstellen in seinem Gebiet, ganz Deutschland
 * nur in Klammern; ohne Netz ganz Deutschland.
 */
function renderDatenText() {
  const d = state.daten;
  if (!d) {
    const err = state.datenFehler;
    if (err) $("daten-text").textContent = tx(`Die Dauerzählstellen der Zählkarte ließen sich nicht laden (${reason(err)}). Adresse: ${DATEN}dauer/index.json`, `The permanent counters of the Zählkarte could not be loaded (${reason(err)}). Address: ${DATEN}dauer/index.json`);
    else $("daten-text").textContent = tx("Die Dauerzählstellen der Zählkarte werden geladen …", "Loading the permanent counters of the Zählkarte …");
    return;
  }
  const b = state.bereich;
  const g = state.gebiet;
  let text;
  if (sprache() === "de") {
    const stand = `Zählkarte vom ${esc(datumAnzeige(d.erzeugt))}`;
    const alle = `${nr(d.stellen.length)} Dauerzählstellen aus ${nr(d.quellen.size)} Quellen`;
    const wo = g ? "Im gewählten Gebiet" : "Im Gebiet des Netzes";
    const klammer = g && b ? `im ganzen Netz ${nr(b.imNetz)}, in ganz Deutschland ${nr(d.stellen.length)}` : `in ganz Deutschland ${nr(d.stellen.length)} aus ${nr(d.quellen.size)}`;
    if (!b) text = `${stand}: ${alle} in ganz Deutschland. Mit einem Netz zählen nur die in seinem Gebiet.`;
    else if (!b.imGebiet) text = `${stand}: ${wo} liegen keine Dauerzählstellen (${g ? klammer : `in ganz Deutschland ${alle}`}).`;
    else text = `${stand}: ${wo} liegen ${anzahl(b.imGebiet, "Dauerzählstelle", "Dauerzählstellen")} aus ${anzahl(b.quellen, "Quelle", "Quellen")} (${klammer}).`;
    if (d.version !== VERTRAG) text += ` <strong>Achtung:</strong> Die Daten haben Version ${esc(d.version)}, gebaut ist die Seite für Version ${VERTRAG}.`;
  } else {
    const stand = `Zählkarte of ${esc(datumAnzeige(d.erzeugt))}`;
    const alle = `${nr(d.stellen.length)} permanent counters from ${nr(d.quellen.size)} sources`;
    const wo = g ? "In the chosen area" : "In the network area";
    const klammer = g && b ? `${nr(b.imNetz)} in the whole network, ${nr(d.stellen.length)} in all of Germany` : `${nr(d.stellen.length)} from ${anzahl(d.quellen.size, "source", "sources")} in all of Germany`;
    if (!b) text = `${stand}: ${alle} in all of Germany. With a network, only those in its area count.`;
    else if (!b.imGebiet) text = `${stand}: ${wo} there are no permanent counters (${g ? klammer : `${alle} in all of Germany`}).`;
    else text = `${stand}: ${wo} there ${b.imGebiet === 1 ? "is" : "are"} ${anzahl(b.imGebiet, "permanent counter", "permanent counters")} from ${anzahl(b.quellen, "source", "sources")} (${klammer}).`;
    if (d.version !== VERTRAG) text += ` <strong>Note:</strong> The data have version ${esc(d.version)}; the page is built for version ${VERTRAG}.`;
  }
  $("daten-text").innerHTML = text;
}

// ---------- Kurzzeitzählungen der Zählkarte ----------
async function holeJson(pfad) {
  const res = await fetch(`${DATEN}${pfad}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** manifest.json und index.json, einmal je Sitzung; danach weiß die Seite, ob es Ströme gibt. */
function ladeKurz() {
  const k = state.kurz;
  if (k.manifest && k.stellen) return Promise.resolve(true);
  k.laedt ??= (async () => {
    try {
      setStatus(tx("Kurzzeitzählungen der Zählkarte laden …", "Loading the short-term counts of the Zählkarte …"));
      k.manifest = leseManifest(await holeJson("manifest.json"));
      if (!k.manifest.muster) throw new Error(tx("Diese Daten der Zählkarte enthalten noch keine Werte je Strom (stroeme/, ab zaehlkarte#45)", "These Zählkarte data contain no values per movement yet (stroeme/, from zaehlkarte#45)"));
      k.stellen = leseStellen(await holeJson(k.manifest.index));
      k.fehler = null;
      return true;
    } catch (err) {
      k.manifest = null;
      k.stellen = null;
      k.fehler = err;
      return false;
    } finally {
      k.laedt = null;
    }
  })();
  return k.laedt;
}

/** Die Ströme einer Quelle in einem Jahr, je Datei einmal. */
function kurzDatei(quelle, jahr) {
  const key = `${quelle}-${jahr}`;
  if (!state.kurz.dateien.has(key)) {
    const p = holeJson(stroemePfad(state.kurz.manifest, quelle, jahr)).then((json) => {
      if (json.version !== STROEME_VERTRAG) console.warn(`${key}: Ströme in Version ${json.version}, gebaut ist die Seite für ${STROEME_VERTRAG}`);
      return json;
    });
    state.kurz.dateien.set(key, p);
    p.catch(() => state.kurz.dateien.delete(key));
  }
  return state.kurz.dateien.get(key);
}

// Lizenzen mit Weitergabe unter gleichen Bedingungen (CC BY-SA): Ihre Bedingungen gingen auf die ganze
// counts-kurzzeit.xml über. Lieferungen unter ihnen sind aus, bis man sie einschaltet (Berlin 1990–2019).
const WEITERGABE = /\bSA\b/;

/** Der Lizenzeintrag einer Lieferung; ohne Angabe der erste der Quelle außer der Lage. */
function lieferungVon(quelle, code) {
  const q = state.kurz.manifest?.quellen.get(quelle);
  if (!q) return null;
  return (code != null ? q.lizenzen.get(code) : null) ?? [...q.lizenzen.values()].find((l) => l.code !== "lage") ?? null;
}
/** Ob Zählungen einer Lieferung dabei sind: wie gewählt, sonst alle außer denen mit Weitergabe unter gleichen Bedingungen. */
function lieferungAn(quelle, l) {
  const wahl = state.kurz.opts.lieferungen?.[`${quelle}:${l.code}`];
  return wahl ?? !WEITERGABE.test(l.lizenz ?? "");
}

/**
 * Die Kurzzeit-Punkte im Gebiet des Netzes: je Stelle und Gruppe die jüngste passende Zählung
 * (lib/kurzzeit.js), daraus die Punkte der Arme und Fahrtrichtungen, als Stellen der Familie „kurz“.
 */
async function kurzStellen([w, s, o, n]) {
  const k = state.kurz;
  if (!k.an) {
    k.info = null;
    return [];
  }
  if (!(await ladeKurz())) {
    k.info = { fehler: k.fehler };
    return [];
  }
  const rand = 0.002;
  const imGebiet = new Set();
  const quellen = new Set();
  for (const st of k.stellen.values()) {
    if (st.lon >= w - rand && st.lon <= o + rand && st.lat >= s - rand && st.lat <= n + rand && inGebiet(`k:${st.id}`, st.lon, st.lat)) {
      imGebiet.add(st.id);
      quellen.add(st.quelle);
    }
  }
  const opts = k.opts;
  const dateien = [];
  for (const q of quellen) {
    for (const j of k.manifest.jahre.get(q) ?? []) {
      if ((opts.vonJahr == null || j >= opts.vonJahr) && (opts.bisJahr == null || j <= opts.bisJahr)) dateien.push([q, j]);
    }
  }
  const eintraege = [];
  let fertig = 0;
  let fehlerJahre = 0;
  await Promise.all(dateien.map(async ([q, j]) => {
    try {
      const json = await kurzDatei(q, j);
      for (const [kennung, z] of Object.entries(json.zaehlungen ?? {})) eintraege.push({ quelle: json.quelle ?? q, kennung, z });
    } catch {
      fehlerJahre++;
    }
    fertig++;
    setStatus(tx(`Kurzzeitzählungen laden … ${nr(fertig)} von ${nr(dateien.length)} Jahren`, `Loading short-term counts … ${nr(fertig)} of ${nr(dateien.length)} years`), "busy", (100 * fertig) / Math.max(1, dateien.length));
  }));
  // erst die Lieferungen, dann je Stelle die jüngste: Ist die jüngste aus einer abgewählten, gilt die davor
  const aus = new Map();
  const erlaubt = eintraege.filter((e) => {
    if (!imGebiet.has(e.z.stelle)) return false;
    const l = lieferungVon(e.quelle, e.z.lieferung);
    if (l && lieferungAn(e.quelle, l)) return true;
    const key = l ? `${l.lizenz} (${l.titel ?? l.code})` : ""; // "": ohne Lieferung
    aus.set(key, (aus.get(key) ?? 0) + 1);
    return false;
  });
  const gewaehlt = waehleZaehlungen(erlaubt, opts, imGebiet);
  const info = { gebiet: imGebiet.size, dateien: dateien.length, fehlerJahre, zaehlungen: gewaehlt.length, knoten: new Set(), querschnitte: new Set(), ohneWinkel: 0, ohneRichtung: 0, ohneLizenz: 0, stellen: new Set(), ausLieferung: aus };
  const out = [];
  for (const a of gewaehlt) {
    const st = k.stellen.get(a.z.stelle);
    if (!st) continue;
    const r = kurzPunkte(st, a, { abstand: opts.abstand });
    info.ohneWinkel += r.ohneWinkel;
    for (const p of r.punkte) {
      const liz = lizenzenVon(k.manifest, p);
      if (!liz.ok) {
        info.ohneLizenz++;
        continue;
      }
      out.push(kurzStelle(p, liz));
      info.stellen.add(p.stelle);
      if (p.grad == null) info.ohneRichtung++;
    }
    if (r.punkte.length) info[r.punkte[0].art === "knoten" ? "knoten" : "querschnitte"].add(st.id);
  }
  info.punkte = out.length;
  k.info = info;
  return out;
}

const WOCHENTAG_KURZ = { de: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };
const datumText = (iso) => {
  if (!iso) return "";
  const [j, m, t] = iso.split("-");
  const wt = WOCHENTAG_KURZ[sprache()][wochentag(tagNr(iso))];
  return sprache() === "de" ? `${wt} ${t}.${m}.${j}` : `${wt} ${j}-${m}-${t}`;
};
// Arm, Abschnitt und Richtung eines Kurzzeit-Punkts. Die Stelle trägt sie auf Deutsch (sp = "de"),
// wie sie in die Ausgaben gehen; die Oberfläche fragt in ihrer Sprache (abschnittText & Co.).
const armText = (arm, sp = sprache()) => `${sp === "de" ? "Arm" : "arm"} ${arm.nr}${arm.name ? (sp === "de" ? ` „${arm.name}“` : ` “${arm.name}”`) : ""}`;
function kurzAbschnitt(p, sp = sprache()) {
  if (p.art === "knoten") return sp === "de" ? `${p.seite === "zu" ? "Zufahrt" : "Ausfahrt"} Arm ${p.arm.nr}` : `${p.seite === "zu" ? "Approach" : "Exit"}, arm ${p.arm.nr}`;
  return sp === "de" ? `Richtung Arm ${p.arm.nr}` : `Towards arm ${p.arm.nr}`;
}
function kurzRichtung(p, sp = sprache()) {
  if (p.art === "knoten") return sp === "de" ? `${p.seite === "zu" ? "Zufahrt aus" : "Ausfahrt in"} ${armText(p.arm, sp)}` : `${p.seite === "zu" ? "Approach from" : "Exit into"} ${armText(p.arm, sp)}`;
  const von = p.vonArme.length === 1 ? (sp === "de" ? ` (von ${armText(p.vonArme[0], sp)})` : ` (from ${armText(p.vonArme[0], sp)})`) : "";
  return `${sp === "de" ? "Richtung" : "Towards"} ${armText(p.arm, sp)}${von}`;
}
const abschnittText = (s) => (familieVon(s) === "kurz" ? kurzAbschnitt(s.kurz) : s.abschnitt);
const richtungAnzeige = (s) => (familieVon(s) === "kurz" ? kurzRichtung(s.kurz) : s.richtungText);
const zielText = (s) => (familieVon(s) === "kurz" && s.r.ziel != null ? armText(s.kurz.arm) : s.r.ziel);

/** Ein Punkt aus lib/kurzzeit.js als Stelle der Liste, der Karte und der Zuordnung. */
function kurzStelle(p, liz) {
  const knoten = p.art === "knoten";
  const gruppen = KURZ_GRUPPEN.filter((g) => p.werte[g]);
  const modi = [...new Set(gruppen.flatMap((g) => state.gruppen[g].link.split(/[,\s]+/).map((m) => m.trim().toLowerCase()).filter(Boolean)))];
  return {
    id: p.id,
    familie: "kurz",
    quelle: p.quelle,
    name: p.name,
    abschnitt: kurzAbschnitt(p, "de"),
    richtungText: kurzRichtung(p, "de"),
    r: { art: "gerichtet", grad: p.grad, ziel: p.grad == null ? armText(p.arm, "de") : null },
    lon: p.lon,
    lat: p.lat,
    gruppen,
    aktiv: gruppen,
    modi,
    land: null,
    chunk: null,
    suchName: p.suchName,
    // ein Arm-Punkt sucht nur bis kurz vor den Knoten, sonst fände er die Links der anderen Arme
    radius: knoten ? Math.max(5, state.kurz.opts.abstand - 5) : null,
    rueckfall: false,
    lizenz: liz,
    kurz: p,
  };
}

// ---------- Einstellungen der Kurzzeitzählungen ----------
const kurzSpeichern = () => store.set("snapper.kurz", JSON.stringify({ an: state.kurz.an, opts: state.kurz.opts }));

/** Formular aus den Einstellungen; Wochentage und Gruppen als Knöpfe. */
function renderKurz() {
  const k = state.kurz;
  const o = k.opts;
  $("kurz-an").checked = k.an;
  $("kurz-felder").classList.toggle("off", !k.an);
  $("kurz-von").value = o.vonJahr ?? "";
  $("kurz-bis").value = o.bisJahr ?? "";
  if (k.manifest) {
    const alle = [...k.manifest.jahre.values()].flat();
    if (alle.length) $("kurz-bis").placeholder = String(Math.max(...alle));
  }
  $("kurz-stunden").value = o.minStunden;
  $("kurz-abstand").value = o.abstand;
  for (const c of document.querySelectorAll(".kurz-tag")) c.checked = o.tage.includes(c.value);
  $("kurz-wochentage").replaceChildren(...WOCHENTAGE.map((w) => {
    const b = document.createElement("button");
    b.type = "button";
    b.value = String(w.nr);
    b.textContent = tx(w.kurz, w.en);
    b.setAttribute("aria-pressed", String(o.wochentage.includes(w.nr)));
    return b;
  }));
  const lieferungen = [];
  for (const [code, q] of k.manifest?.quellen ?? []) {
    if (!k.manifest.jahre.get(code)?.length) continue;
    for (const l of q.lizenzen.values()) if (l.code !== "lage" && l.lizenz && !l.ohneLizenz) lieferungen.push([q, l]);
  }
  $("kurz-lieferungen-feld").hidden = !lieferungen.length;
  $("kurz-lieferungen").replaceChildren(...lieferungen.map(([q, l]) => {
    const el = document.createElement("label");
    el.className = "check";
    el.innerHTML = `<input type="checkbox" class="kurz-lieferung" value="${esc(`${q.code}:${l.code}`)}"${lieferungAn(q.code, l) ? " checked" : ""}><span>${esc(q.name)}: ${esc(l.titel ?? l.code)} <small class="hint">· ${esc(l.lizenz)}${WEITERGABE.test(l.lizenz) ? tx(", Weitergabe unter gleichen Bedingungen", ", share-alike") : ""}</small></span>`;
    return el;
  }));
  $("kurz-gruppen").replaceChildren(...KURZ_GRUPPEN.map((g) => {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox" class="kurz-gruppe" value="${g}"${o.gruppen.includes(g) ? " checked" : ""}>${esc(gruppenName(g, k.manifest?.gruppenNamen))} <small class="hint">→ ${esc(state.gruppen[g].mode)}</small>`;
    return l;
  }));
  renderKurzStats();
}

const KURZ_TEXT = $("kurz-text").innerHTML;

/** Was die Auswahl der Kurzzeitzählungen ergab, im Kopf und unter dem Schalter. */
function renderKurzStats() {
  const k = state.kurz;
  const sum = $("kurz-sum");
  const t = $("kurz-text");
  const i = k.info;
  if (!k.an || !i) {
    sum.textContent = k.an ? tx("an", "on") : tx("aus", "off");
    t.innerHTML = KURZ_TEXT;
    return;
  }
  if (i.fehler) {
    sum.textContent = tx("nicht verfügbar", "not available");
    t.innerHTML = tx(`Die Kurzzeitzählungen ließen sich nicht laden (${esc(reason(i.fehler))}). Adresse: <code>${esc(DATEN)}manifest.json</code>`, `The short-term counts could not be loaded (${esc(reason(i.fehler))}). Address: <code>${esc(DATEN)}manifest.json</code>`);
    return;
  }
  const mitLink = state.stellen.filter((s) => familieVon(s) === "kurz" && linkVon(s)).length;
  sum.textContent = tx(`${nr(i.punkte)} Punkte`, `${nr(i.punkte)} points`);
  const mitLinkText = state.netz && state.ergebnisse.size ? tx(`, ${nr(mitLink)} mit Link`, `, ${nr(mitLink)} with a link`) : "";
  const teile = [tx(
    `Zählkarte vom ${esc(datumAnzeige(k.manifest.erzeugt))}: ${state.gebiet ? "Im gewählten Gebiet" : "Im Gebiet des Netzes"} liegen ${nr(i.gebiet)} Stellen mit Kurzzeitzählungen; ${nr(i.stellen.size)} davon haben eine passende Zählung (${anzahl(i.knoten.size, "Knoten", "Knoten")}, ${anzahl(i.querschnitte.size, "Querschnitt", "Querschnitte")}). Das ergibt ${nr(i.punkte)} Punkte${mitLinkText}.`,
    `Zählkarte of ${esc(datumAnzeige(k.manifest.erzeugt))}: ${state.gebiet ? "In the chosen area" : "In the network area"} there are ${nr(i.gebiet)} sites with short-term counts; ${nr(i.stellen.size)} of them have a matching count (${anzahl(i.knoten.size, "junction", "junctions")}, ${anzahl(i.querschnitte.size, "cross-section", "cross-sections")}). That makes ${nr(i.punkte)} points${mitLinkText}.`,
  )];
  if (i.ohneWinkel) teile.push(tx(`${nr(i.ohneWinkel)} Zu- oder Ausfahrten an Armen ohne Winkel bleiben draußen.`, `${nr(i.ohneWinkel)} approaches or exits on arms without an angle are left out.`));
  if (i.ohneRichtung) teile.push(tx(`${nr(i.ohneRichtung)} Fahrtrichtungen an Querschnitten ohne Winkel sind zum Prüfen markiert.`, `${nr(i.ohneRichtung)} directions at cross-sections without an angle are marked for review.`));
  if (i.ohneLizenz) teile.push(tx(`${nr(i.ohneLizenz)} Punkte aus Lieferungen ohne Lizenz bleiben draußen.`, `${nr(i.ohneLizenz)} points from deliveries without a licence are left out.`));
  for (const [was, n] of i.ausLieferung ?? []) teile.push(tx(`${nr(n)} Zählungen unter ${esc(was || "ohne Lieferung")} sind abgewählt.`, `${nr(n)} counts under ${esc(was || "no delivery")} are deselected.`));
  if (i.fehlerJahre) teile.push(tx(`<strong>${nr(i.fehlerJahre)} von ${nr(i.dateien)} Jahren ließen sich nicht laden.</strong>`, `<strong>${nr(i.fehlerJahre)} of ${nr(i.dateien)} years could not be loaded.</strong>`));
  t.innerHTML = teile.join(" ");
}

function leseKurzForm() {
  const o = state.kurz.opts;
  const jahr = (id) => {
    const v = $(id).value.trim();
    return v && Number.isInteger(Number(v)) ? Number(v) : null;
  };
  o.vonJahr = jahr("kurz-von");
  o.bisJahr = jahr("kurz-bis");
  o.tage = [...document.querySelectorAll(".kurz-tag")].filter((c) => c.checked).map((c) => c.value);
  o.gruppen = [...document.querySelectorAll(".kurz-gruppe")].filter((c) => c.checked).map((c) => c.value);
  o.minStunden = Math.max(1, Math.min(24, Number($("kurz-stunden").value) || KURZ_VORGABE.minStunden));
  o.abstand = Math.max(10, Math.min(100, Number($("kurz-abstand").value) || KURZ_VORGABE.abstand));
}

/** Nach einer Änderung: speichern und die Stellen neu wählen, wenn ein Netz da ist. */
function kurzGeaendert() {
  kurzSpeichern();
  renderKurz();
  if (state.netz) waehleStellen();
}

$("kurz-an").addEventListener("change", (e) => {
  state.kurz.an = e.target.checked;
  if (state.kurz.an) $("kurz").open = true;
  kurzGeaendert();
});
for (const id of ["kurz-von", "kurz-bis", "kurz-stunden", "kurz-abstand"]) {
  $(id).addEventListener("change", () => {
    leseKurzForm();
    if (state.kurz.an) kurzGeaendert();
    else kurzSpeichern();
  });
}
$("kurz-felder").addEventListener("change", (e) => {
  if (e.target.matches(".kurz-lieferung")) {
    state.kurz.opts.lieferungen = { ...state.kurz.opts.lieferungen, [e.target.value]: e.target.checked };
    if (state.kurz.an) kurzGeaendert();
    else kurzSpeichern();
    return;
  }
  if (!e.target.matches(".kurz-tag, .kurz-gruppe")) return;
  leseKurzForm();
  if (state.kurz.an) kurzGeaendert();
  else kurzSpeichern();
});
$("kurz-wochentage").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const tag = Number(b.value);
  const w = state.kurz.opts.wochentage;
  state.kurz.opts.wochentage = w.includes(tag) ? w.filter((x) => x !== tag) : [...w, tag];
  if (state.kurz.an) kurzGeaendert();
  else {
    kurzSpeichern();
    renderKurz();
  }
});

let waehlToken = 0;
/** Die Stellen im Gebiet des Netzes, die eine Richtung zählen und aus einer Quelle mit Lizenz stammen, dazu die Kurzzeit-Punkte. */
async function waehleStellen() {
  const d = state.daten;
  const n = state.netz;
  // die Zählstellen sind jetzt da oder neu: Sie entscheiden, ob ein anderes CRS besser passt
  renderCrsVorschlag();
  if (!d || !n?.info?.bbox) {
    if (n && !d) {
      if (state.datenFehler) setStatus(() => tx("Netz geladen, aber ohne die Daten der Zählkarte gibt es nichts zuzuordnen (siehe Schritt 2).", "Network loaded, but without the Zählkarte data there is nothing to assign (see step 2)."), "error");
      else setStatus(tx("Netz geladen. Die Zählstellen kommen gleich …", "Network loaded. The count sites are coming …"), "busy");
    } else if (n && !n.info?.bbox) setStatus(() => tx("Das Netz hat keine Links, die sich zeichnen lassen.", "The network has no links that can be drawn."), "error");
    return;
  }
  const imNetz = imKasten(d.stellen, n.info.bbox);
  const imGebiet = imNetz.filter((x) => inGebiet(`d:${x.id}`, x.lon, x.lat));
  const ohneKompass = $("ohne-kompass").checked;
  const gruende = { beide: 0, lizenz: 0, gruppe: 0, kompass: 0 };
  const ohneLizenz = new Set();
  const gewaehlt = [];
  for (const x of imGebiet) {
    const q = d.quellen.get(x.quelle);
    if (!q?.hatLizenz) {
      gruende.lizenz++;
      ohneLizenz.add(q?.name ?? x.quelle);
      continue;
    }
    const gruppen = x.gruppen.filter((g) => state.gruppen[g]?.an);
    if (x.r.art !== "gerichtet") {
      // beide Richtungen zusammen oder keine genannt: passt auf keinen einzelnen Link, nur anzeigen
      if (!gruppen.length) { gruende.gruppe++; continue; }
      gruende.beide++;
      gewaehlt.push({ ...x, familie: "quer", aktiv: gruppen, modi: [] });
      continue;
    }
    if (x.r.grad == null && !ohneKompass) { gruende.kompass++; continue; }
    if (!gruppen.length) { gruende.gruppe++; continue; }
    const modi = [...new Set(gruppen.flatMap((g) => state.gruppen[g].link.split(/[,\s]+/).map((m) => m.trim().toLowerCase()).filter(Boolean)))];
    gewaehlt.push({ ...x, familie: "dauer", aktiv: gruppen, modi });
  }
  const t = ++waehlToken;
  const kurze = await kurzStellen(n.info.bbox);
  // inzwischen ein anderes Netz oder eine neuere Auswahl: die gilt
  if (t !== waehlToken || n !== state.netz) return;
  const ordnung = new Intl.Collator("de", { numeric: true });
  gewaehlt.sort((a, b) => ordnung.compare(a.id, b.id));
  kurze.sort((a, b) => ordnung.compare(a.id, b.id));
  gewaehlt.push(...kurze);
  state.bereich = { imNetz: imNetz.length, quellenNetz: new Set(imNetz.map((x) => x.quelle)).size, imGebiet: imGebiet.length, quellen: new Set(imGebiet.map((x) => x.quelle)).size, gruende, ohneLizenz: [...ohneLizenz], dauer: gewaehlt.filter((x) => familieVon(x) === "dauer").length };
  renderKurz();
  state.stellen = gewaehlt;
  state.byId = new Map(gewaehlt.map((x) => [x.id, x]));
  if (state.auswahl && !state.byId.has(state.auswahl)) state.auswahl = null;
  for (const id of [...state.stunden.keys()]) if (!state.byId.has(id)) state.stunden.delete(id);
  await suche();
  if (t === waehlToken && n === state.netz) await uebernimmAusstehende();
}

/**
 * Von wo aus die Suche geht: vom Anker einer übernommenen Zuordnung (ein Punkt auf der Fahrbahn,
 * mit der Richtung des Links dort), sonst von der Stelle selbst.
 */
function suchpunkt(s) {
  const e = state.entscheid.get(s.id);
  const a = e ? e.anker : gespeichert[s.id]?.anker;
  return a ? { lon: a.lon, lat: a.lat, grad: a.grad ?? s.r.grad } : { lon: s.lon, lat: s.lat, grad: s.r.grad };
}

/** Der Umkreis, in dem eine Stelle Links sucht: der allgemeine, bei Arm-Punkten höchstens bis kurz vor den Knoten. */
const umkreisVon = (s) => {
  const r = Number($("radius").value) || 50;
  return s.radius != null ? Math.min(r, s.radius) : r;
};

async function suche() {
  const t = ++state.suchToken;
  const stellen = state.stellen.filter((s) => familieVon(s) !== "quer").map((s) => ({ id: s.id, ...suchpunkt(s), ort: { lon: s.lon, lat: s.lat }, name: s.suchName ?? s.name, modi: s.modi, radius: umkreisVon(s), rueckfall: s.rueckfall }));
  if (!stellen.length) {
    state.ergebnisse.clear();
    nachSuche();
    setStatus(() => tx(`${state.gebiet ? "Im gewählten Gebiet" : "Im Gebiet des Netzes"} liegen keine passenden Zählstellen.`, `There are no matching count sites ${state.gebiet ? "in the chosen area" : "in the network area"}.`), "idle");
    return;
  }
  setStatus(tx(`Links zu ${nr(stellen.length)} Zählstellen suchen …`, `Searching links for ${nr(stellen.length)} count sites …`));
  try {
    const r = await frage({ type: "suche", stellen, params: { radius: Number($("radius").value) || 50, maxWinkel: Number($("winkel").value) || 60 } });
    if (t !== state.suchToken) return;
    state.ergebnisse = new Map(r.ergebnisse.map((e) => [e.id, e]));
    await loeseEntscheide();
    nachSuche();
  } catch (err) {
    if (t !== state.suchToken) return;
    setStatus(tx(`Die Suche nach Links ging schief: ${err.message}`, `The link search failed: ${err.message}`), "error");
  }
}

function nachSuche() {
  verteileNeu();
  for (const id of ["s-stellen", "s-pruefen", "s-mitteln", "s-ausgeben"]) $(id).classList.toggle("inactive", !state.stellen.length);
  $("legend").hidden = !state.stellen.length;
  $("legend-kurz").hidden = !state.stellen.some((s) => familieVon(s) === "kurz");
  $("legend-quer").hidden = !state.stellen.some((s) => familieVon(s) === "quer");
  const mit = state.stellen.filter((s) => linkVon(s)).length;
  const kurze = state.stellen.filter((s) => familieVon(s) === "kurz").length;
  const quer = state.stellen.filter((s) => familieVon(s) === "quer").length;
  const dauer = state.stellen.length - kurze - quer;
  const pruefen = zaehle("pruefen");
  setStatus(() => {
    if (sprache() === "de") {
      const wer = kurze ? `${nr(dauer)} Dauerzählstellen und ${nr(kurze)} Kurzzeit-Punkte` : `${nr(dauer)} Zählstellen`;
      return `${wer}, ${nr(mit)} davon mit Link. ${pruefen ? `${nr(pruefen)} zum Prüfen.` : ""}${quer ? ` ${nr(quer)} ohne Richtung nur angezeigt.` : ""}`.trim();
    }
    const wer = kurze ? `${nr(dauer)} permanent counters and ${nr(kurze)} short-term points` : `${anzahl(dauer, "count site", "count sites")}`;
    return `${wer}, ${nr(mit)} of them with a link. ${pruefen ? `${nr(pruefen)} to review.` : ""}${quer ? ` ${nr(quer)} without direction, shown only.` : ""}`.trim();
  }, "done");
  renderAuswahl();
  renderMittelRahmen();
  mittleAlle();
  renderAlles();
  if (state.einpassen && state.stellen.length) {
    state.einpassen = false;
    const lon = state.stellen.map((s) => s.lon);
    const lat = state.stellen.map((s) => s.lat);
    map.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 50, duration: 0, maxZoom: 15 });
  }
}

/**
 * Automatische Wahl neu: jeder Link je Verkehrsmittel nur einmal, Zuordnungen von Hand gehen vor,
 * ausgelassene Stellen nehmen nichts. Erst die Dauerzählstellen, dann die Kurzzeit-Punkte auf den
 * Links, die übrig sind: Je Link und Verkehrsmittel geht eine Dauerzählstelle vor.
 */
function verteileNeu() {
  const liste = state.stellen;
  lageCache.clear();
  stand++;
  state.wahl = new Map();
  const belegt = new Map(); // Link-Index -> Set der Verkehrsmittel, die die Familien davor schon haben
  for (const familie of ["dauer", "kurz"]) {
    const teil = liste.filter((s) => familieVon(s) === familie);
    if (!teil.length) continue;
    const fest = new Map();
    const kandidaten = teil.map((s, idx) => {
      const e = state.entscheid.get(s.id);
      if (e?.link) fest.set(idx, e.link.i);
      if (e?.aus) return [];
      return state.ergebnisse.get(s.id)?.kandidaten ?? [];
    });
    const wahl = verteile(kandidaten, fest, teil.map(ausgabeModi), belegt);
    teil.forEach((s, idx) => state.wahl.set(s.id, wahl[idx]));
    for (const s of teil) {
      const l = linkVon(s);
      if (!l) continue;
      if (!belegt.has(l.i)) belegt.set(l.i, new Set());
      for (const m of ausgabeModi(s)) belegt.get(l.i).add(m);
    }
  }
  // wer welchen Link hat: für die Gründe („vergeben an …“)
  state.inhaber = new Map();
  for (const s of liste) {
    const l = linkVon(s);
    if (l) state.inhaber.set(l.id, [...(state.inhaber.get(l.id) ?? []), s]);
  }
}

/**
 * Die anderen Stellen, die einen Link mit einem der Verkehrsmittel von `s` haben und ihn `s`
 * nehmen: für eine Dauerzählstelle die anderen Dauerzählstellen, für einen Kurzzeit-Punkt alle.
 */
function inhaberVon(linkId, s) {
  const modi = ausgabeModi(s);
  return (state.inhaber?.get(linkId) ?? []).filter((t) => t.id !== s.id && (familieVon(s) === "kurz" || familieVon(t) === "dauer") && ausgabeModi(t).some((m) => modi.includes(m)));
}
const stelleText = (t) => (familieVon(t) === "kurz" ? `${t.name || t.kurz.stelle} (${abschnittText(t)}, ${t.kurz.stelle})` : `${t.name || t.id} (${t.id})`);

/** Die Inhaber eines Links als Text; Dauerzählstellen beim Namen, weil sie vor Kurzzeit-Punkten gehen. */
function inhaberText(linkId, s) {
  const andere = inhaberVon(linkId, s);
  const dauer = andere.filter((t) => familieVon(t) === "dauer");
  const kurze = andere.filter((t) => familieVon(t) === "kurz");
  const teile = [];
  if (familieVon(s) === "kurz" && dauer.length) teile.push(tx(`die Dauerzählstelle ${dauer.map(stelleText).join(", ")}, die vorgeht`, `the permanent counter ${dauer.map(stelleText).join(", ")}, which takes precedence`));
  else if (dauer.length) teile.push(dauer.map(stelleText).join(", "));
  if (kurze.length) teile.push(kurze.map(stelleText).join(", "));
  return teile.join("; ");
}

/** Die networkModes, die eine Stelle ausgibt; ein Link trägt je Verkehrsmittel nur eine Stelle. */
function ausgabeModi(s) {
  return [...new Set(s.aktiv.map((g) => state.gruppen[g].mode))];
}

/** Der Link einer Stelle: von Hand, sonst automatisch. */
function linkVon(s) {
  if (familieVon(s) === "quer") return null; // nur angezeigt, nie an einem Link
  const e = state.entscheid.get(s.id);
  if (e?.aus) return null;
  return e?.link ?? state.wahl.get(s.id) ?? null;
}

/** Warum eine automatische Zuordnung angesehen werden sollte. */
function gruendeVon(s) {
  const w = state.wahl.get(s.id);
  const k = state.ergebnisse.get(s.id)?.kandidaten ?? [];
  if (!w) {
    const e = state.entscheid.get(s.id);
    const vorab = e?.anker && !e.link ? [tx(`Aus „${e.anker.netz ?? "einer Zuordnung"}“ nicht eindeutig übernommen (${e.anker.grund ?? "unklar"}).`, `Not uniquely transferred from “${e.anker.netz ?? "an assignment"}” (${e.anker.grund ?? "unclear"}).`)] : [];
    if (vorab.length && !k.length) return [...vorab, tx("Im Umkreis des übernommenen Punkts liegt kein passender Link.", "There is no matching link around the transferred point.")];
    if (k.length) {
      const an = inhaberText(k[0].id, s);
      return [...vorab, tx(`Alle passenden Links im Umkreis sind an andere Stellen mit demselben Verkehrsmittel vergeben${an ? `, der nächste an ${an}` : ""}.`, `All matching links in the radius are taken by other sites with the same mode${an ? `, the nearest by ${an}` : ""}.`)];
    }
    const u = state.ergebnisse.get(s.id)?.umkreis;
    const r = umkreisVon(s);
    const amArm = familieVon(s) === "kurz" && s.kurz.art === "knoten";
    const arm = amArm ? tx(` um den Punkt auf dem Arm (${nr(state.kurz.opts.abstand)} m vom Knoten; gesucht wird bis kurz vor den Knoten, damit der Punkt nicht auf einen anderen Arm fällt)`, ` around the point on the arm (${nr(state.kurz.opts.abstand)} m from the junction; the search stops just short of the junction so that the point does not fall onto another arm)`) : "";
    const oder = tx(" oder ", " or ");
    if (!u?.links) return [...vorab, tx(`Im Umkreis von ${nr(r)} m${arm} liegt kein Link.${familieVon(s) === "kurz" ? " Hat das Netz diese Straße?" : ""}`, `There is no link within ${nr(r)} m${arm}.${familieVon(s) === "kurz" ? " Does the network have this road?" : ""}`)];
    if (!u.modus) return [...vorab, tx(`Im Umkreis liegen ${nr(u.links)} Links, aber keiner erlaubt ${s.modi.join(oder)}. Hat das Netz dieses Verkehrsmittel? Sonst unter „Link erlaubt“ anpassen.`, `There are ${nr(u.links)} links in the radius, but none allows ${s.modi.join(oder)}. Does the network have this mode? Otherwise adjust “Link allows”.`)];
    return [...vorab, tx(`Im Umkreis${arm} liegen ${nr(u.modus)} Links mit ${s.modi.join(oder)}, aber keiner weicht höchstens ${nr(Number($("winkel").value) || 60)}° von der Fahrtrichtung ab.`, `There are ${nr(u.modus)} links with ${s.modi.join(oder)} in the radius${arm}, but none is within ${nr(Number($("winkel").value) || 60)}° of the direction of travel.`)];
  }
  const out = [];
  const e = state.entscheid.get(s.id);
  if (e?.anker && !e.link) out.push(tx(`Aus „${e.anker.netz ?? "einer Zuordnung"}“ nicht eindeutig übernommen (${e.anker.grund ?? "unklar"}). Gesucht wird vom übernommenen Punkt aus.`, `Not uniquely transferred from “${e.anker.netz ?? "an assignment"}” (${e.anker.grund ?? "unclear"}). The search starts from the transferred point.`));
  if (s.r.grad == null && !e?.anker) {
    out.push(familieVon(s) === "kurz"
      ? tx(`Die Zählung nennt für ${zielText(s)} keinen Winkel: Hin- oder Rückrichtung prüfen.`, `The count gives no angle for ${zielText(s)}: check which of the two directions it is.`)
      : tx(`Die Quelle nennt nur das Ziel („${s.r.ziel}“), keine Himmelsrichtung: Hin- oder Rückrichtung prüfen.`, `The source only names the destination (“${s.r.ziel}”), no compass direction: check which of the two directions it is.`));
  }
  const wovon = e?.anker ? tx("vom übernommenen Punkt", "the transferred point") : familieVon(s) === "kurz" && s.kurz.art === "knoten" ? tx("vom Punkt auf dem Arm", "the point on the arm") : tx("von der Stelle", "the site");
  if (w.d > WEIT_M) out.push(tx(`Der Link liegt ${nr(w.d)} m ${wovon} entfernt.`, `The link is ${nr(w.d)} m away from ${wovon}.`));
  if (w.weit) out.push(tx(`Kein Link liegt innerhalb von ${nr(Number($("winkel").value) || 60)}° der genannten Richtung (${kurz(s.r.grad)}). Dieser weicht ${nr(w.abweichung)}° ab, liegt aber näher an ihr als seine Gegenrichtung – die Quelle nennt wohl nur eine grobe Himmelsrichtung.`, `No link is within ${nr(Number($("winkel").value) || 60)}° of the given direction (${kurz(s.r.grad)}). This one is ${nr(w.abweichung)}° off but closer to it than its opposite direction – the source probably only gives a rough compass direction.`));
  else if (w.abweichung != null && w.abweichung > WINKEL_PRUEFEN) out.push(tx(`Die Richtung des Links weicht um ${nr(w.abweichung)}° ab.`, `The link's direction is ${nr(w.abweichung)}° off.`));
  if (k[0] && k[0].i !== w.i) {
    const an = inhaberText(k[0].id, s);
    out.push(tx(`Der nächste Link ist an eine andere Stelle vergeben${an ? `: ${an}` : ""}.`, `The nearest link is taken by another site${an ? `: ${an}` : ""}.`));
  }
  return out;
}

// Die Lage jeder Stelle, bis die Zuordnung sich ändert (verteileNeu): Bei Tausenden von
// Kurzzeit-Punkten fragen Liste, Filter und Karte sonst bei jedem Zeichnen alle Gründe neu ab.
const lageCache = new Map();
function lageVon(s) {
  if (familieVon(s) === "quer") return "quer";
  const e = state.entscheid.get(s.id);
  if (e?.aus) return "aus";
  if (e?.link) return "geprueft";
  if (!state.wahl.get(s.id)) return "ohne";
  let lage = lageCache.get(s.id);
  if (lage === undefined) {
    lage = gruendeVon(s).length ? "pruefen" : "passt";
    lageCache.set(s.id, lage);
  }
  return lage;
}
const zaehle = (lage) => state.stellen.filter((s) => lageVon(s) === lage).length;
/** Die Richtung einer Stelle in Worten, wie die Quelle sie nennt. */
const richtungsText = (s) => richtungAnzeige(s) || "";

// ---------- Entscheidungen ----------
const speicherSchluessel = () => (state.netz ? `snapper.entscheide:${state.netz.key}` : null);
let gespeichert = {}; // id -> { link (ID), aus, kommentar }, auch für Stellen, die gerade nicht gewählt sind

function ladeEntscheide() {
  state.entscheid.clear();
  gespeichert = {};
  const key = speicherSchluessel();
  try {
    gespeichert = JSON.parse(store.get(key) ?? "{}") ?? {};
  } catch {
    gespeichert = {};
  }
}

function speichere() {
  const key = speicherSchluessel();
  if (!key) return;
  for (const [id, e] of state.entscheid) {
    const roh = { link: e.link?.id ?? null, aus: Boolean(e.aus), kommentar: e.kommentar ?? "", anker: e.anker ?? null, uebernommen: e.uebernommen ?? null };
    if (!roh.link && !roh.aus && !roh.kommentar && !roh.anker) delete gespeichert[id];
    else gespeichert[id] = roh;
  }
  store.set(key, JSON.stringify(gespeichert));
}

/** Gespeicherte Link-IDs der gewählten Stellen beim Worker nachschlagen, mit Abstand zur Stelle. */
async function loeseEntscheide() {
  for (const s of state.stellen) {
    const roh = gespeichert[s.id];
    if (!roh || state.entscheid.has(s.id) || familieVon(s) === "quer") continue;
    const e = { link: null, aus: Boolean(roh.aus), kommentar: roh.kommentar ?? "", anker: roh.anker ?? null, uebernommen: roh.uebernommen ?? null };
    if (roh.link) {
      const r = await frage({ type: "link", id: roh.link, stelle: { lon: s.lon, lat: s.lat, grad: s.r.grad } }).catch(() => null);
      if (r?.link) e.link = r.link;
    }
    state.entscheid.set(s.id, e);
  }
}

function entscheid(id) {
  if (!state.entscheid.has(id)) state.entscheid.set(id, { link: null, aus: false, kommentar: "", anker: null, uebernommen: null });
  return state.entscheid.get(id);
}

/** Eine Entscheidung von Hand ersetzt, was aus einem anderen Netz übernommen war. */
function vonHand(e) {
  e.anker = null;
  e.uebernommen = null;
}

function geaendert(meldung) {
  verteileNeu();
  speichere();
  renderAlles();
  if (meldung) setStatus(meldung, "done");
}

/** Den Link einer Stelle festlegen; hatte ihn eine andere Stelle von Hand, sucht diese neu. */
async function nimmLink(id, { i, link = null }) {
  const s = state.byId.get(id);
  if (!s) return;
  if (!link) {
    const r = await frage({ type: "link", i, stelle: { lon: s.lon, lat: s.lat, grad: s.r.grad } }).catch((err) => {
      setStatus(err.message, "error");
      return null;
    });
    link = r?.link;
  }
  if (!link) return;
  let meldung = tx(`${s.name || s.id}: Link ${link.id} festgelegt.`, `${s.name || s.id}: link ${link.id} set.`);
  const modi = ausgabeModi(s);
  for (const [andere, e] of state.entscheid) {
    const t = state.byId.get(andere);
    // ein Link trägt eine Kfz- und eine Rad-Stelle; nur wer dasselbe Verkehrsmittel ausgibt, muss
    // weichen, und nur in derselben Familie: Dauer- und Kurzzeitzählungen gehen in eigene Dateien
    const gleicheFamilie = (t ? familieVon(t) : familieVonId(andere)) === familieVon(s);
    if (andere !== id && e.link?.id === link.id && gleicheFamilie && (!t || ausgabeModi(t).some((m) => modi.includes(m)))) {
      e.link = null;
      meldung += tx(` ${t?.name || andere} hatte ihn und sucht neu.`, ` ${t?.name || andere} had it and searches again.`);
    }
  }
  if (familieVon(s) === "kurz") {
    const dauer = (state.inhaber?.get(link.id) ?? []).filter((t) => familieVon(t) === "dauer" && ausgabeModi(t).some((m) => modi.includes(m)));
    if (dauer.length) meldung += tx(` Auf dem Link liegt auch ${dauer.map(stelleText).join(", ")}; beide gehen in ihre eigene Datei.`, ` ${dauer.map(stelleText).join(", ")} is also on this link; each goes into its own file.`);
  }
  const e = entscheid(id);
  e.link = link;
  e.aus = false;
  vonHand(e);
  geaendert(meldung);
}

function passt(id) {
  const s = state.byId.get(id);
  const w = s && state.wahl.get(id);
  if (!w) return;
  nimmLink(id, { i: w.i, link: w });
}

function auslassen(id, aus = true) {
  const e = entscheid(id);
  e.aus = aus;
  if (aus) e.link = null;
  vonHand(e);
  geaendert();
}

function zuruecksetzen(id) {
  const e = entscheid(id);
  e.link = null;
  e.aus = false;
  const neuSuchen = Boolean(e.anker);
  vonHand(e);
  if (neuSuchen) {
    speichere();
    suche();
  } else geaendert();
}

/** Zwei Stellen ohne Himmelsrichtung am selben Ort tauschen ihre Links; bei Kurzzeitzählungen die beiden Richtungen einer Zählung. */
function partnerVon(s) {
  if (s.r.grad != null) return null;
  if (familieVon(s) === "kurz") {
    const andere = state.stellen.filter((t) => familieVon(t) === "kurz" && t.id !== s.id && t.r.grad == null && t.kurz.kennung === s.kurz.kennung && t.kurz.stelle === s.kurz.stelle);
    return andere.length === 1 ? andere[0] : null;
  }
  let best = null;
  let bestD = 40; // m
  for (const t of state.stellen) {
    if (t.id === s.id || familieVon(t) !== "dauer" || t.quelle !== s.quelle || t.r.grad != null) continue;
    const d = Math.hypot((t.lon - s.lon) * 111320 * Math.cos((s.lat * Math.PI) / 180), (t.lat - s.lat) * 110540);
    if (d < bestD) [best, bestD] = [t, d];
  }
  return best;
}
async function tausche(id) {
  const s = state.byId.get(id);
  const t = s && partnerVon(s);
  const a = s && linkVon(s);
  const b = t && linkVon(t);
  if (!a || !b) return;
  const [fuerS, fuerT] = await Promise.all([
    frage({ type: "link", i: b.i, stelle: { lon: s.lon, lat: s.lat, grad: s.r.grad } }),
    frage({ type: "link", i: a.i, stelle: { lon: t.lon, lat: t.lat, grad: t.r.grad } }),
  ]);
  Object.assign(entscheid(s.id), { link: fuerS.link, aus: false, anker: null, uebernommen: null });
  Object.assign(entscheid(t.id), { link: fuerT.link, aus: false, anker: null, uebernommen: null });
  geaendert(tx(`${s.name}: ${zielText(s)} und ${zielText(t)} haben die Links getauscht.`, `${s.name}: ${zielText(s)} and ${zielText(t)} swapped their links.`));
}

// ---------- Wählen auf der Karte ----------
function pickStart() {
  if (!state.auswahl) return;
  state.pick = true;
  mapwrap.classList.add("pick");
  $("pickhint").hidden = false;
  renderKarte();
}
function pickEnde() {
  if (!state.pick) return;
  state.pick = false;
  mapwrap.classList.remove("pick");
  $("pickhint").hidden = true;
  hover(null);
  renderKarte();
}

function waehle(id, { fliegen = true } = {}) {
  pickEnde();
  popup?.remove();
  state.auswahl = id;
  const s = state.byId.get(id);
  if (s && fliegen) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 600 });
  if (s && familieVon(s) !== "kurz" && !state.stunden.has(id)) ladeStunden([s]).then(() => state.auswahl === id && renderKarte());
  renderListe();
  renderKarte();
  zeichneDaten();
  const btn = $("liste").querySelector(`button[data-id="${CSS.escape(id)}"]`);
  btn?.scrollIntoView({ block: "nearest" });
}

function naechste() {
  const liste = state.stellen.filter((s) => familiePasst(s) && (lageVon(s) === "pruefen" || lageVon(s) === "ohne"));
  if (!liste.length) return setStatus(() => tx("Nichts mehr zu prüfen.", "Nothing left to review."), "done");
  const at = liste.findIndex((s) => s.id === state.auswahl);
  waehle(liste[(at + 1) % liste.length].id);
}
$("naechste").addEventListener("click", naechste);

document.addEventListener("keydown", (e) => {
  if (state.zeichnen) {
    const feld = e.target.closest("input, textarea, select");
    if (e.key === "Escape") return zeichneEnde(false);
    if (e.key === "Enter" && !feld) {
      e.preventDefault();
      return zeichneEnde(true);
    }
    if (e.key === "Backspace" && !feld) {
      e.preventDefault();
      state.zeichnen.punkte.pop();
      zeichneGebiet();
      return renderGebiet();
    }
  }
  if (e.key === "Escape") return pickEnde();
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const quer = familieVon(state.byId.get(state.auswahl)) === "quer";
  const id = quer ? null : state.auswahl;
  if (e.key === "n") naechste();
  else if (e.key === "p" && id) passt(id);
  else if (e.key === "w" && id) (state.pick ? pickEnde() : pickStart());
  else if (e.key === "a" && id) auslassen(id, lageVon(state.byId.get(id)) !== "aus");
  else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement?.closest("#liste")) {
    e.preventDefault();
    const ids = sichtbare().map((s) => s.id);
    const at = ids.indexOf(state.auswahl);
    const next = ids[Math.max(0, Math.min(ids.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      waehle(next);
      $("liste").querySelector(`button[data-id="${CSS.escape(next)}"]`)?.focus();
    }
  }
});

// ---------- Darstellung ----------
function renderAlles() {
  renderFilter();
  renderListe();
  renderKarte();
  renderStats();
  zeichneDaten();
  renderExport();
}

function renderStats() {
  const b = state.bereich;
  $("auswahl-stats").hidden = !b;
  if (!b) return;
  const dauer = state.stellen.filter((s) => familieVon(s) === "dauer");
  $("st-gebiet-titel").textContent = state.gebiet ? tx("Im Gebiet", "In the area") : tx("Im Netzgebiet", "In network area");
  $("st-gebiet").textContent = nr(b.imGebiet);
  $("st-gerichtet").textContent = nr(dauer.length);
  $("st-link").textContent = nr(dauer.filter((s) => linkVon(s)).length);
  renderKurzStats();
}

function renderAuswahl() {
  renderDatenText();
  const b = state.bereich;
  const t = $("auswahl-text");
  t.hidden = !b;
  if (!b) return;
  const teile = [];
  const eine = (n, eins, viele) => `${nr(n)} ${n === 1 ? eins : viele}`;
  const g = b.gruende;
  if (sprache() === "de") {
    if (g.lizenz) teile.push(`${eine(g.lizenz, "stammt", "stammen")} aus Quellen ohne Lizenz (${b.ohneLizenz.map(esc).join(", ")})`);
    if (g.kompass) teile.push(`${eine(g.kompass, "nennt", "nennen")} nur ein Ziel`);
    if (g.gruppe) teile.push(`${eine(g.gruppe, "zählt", "zählen")} keine der gewählten Gruppen`);
    const quer = g.beide ? ` Nur angezeigt: ${eine(g.beide, "zählt beide Richtungen zusammen oder nennt keine", "zählen beide Richtungen zusammen oder nennen keine")} (die meisten Rad-Zählstellen). Sie passen auf keinen einzelnen Link; auf der Karte sind sie violett und werden nicht zugeordnet.` : "";
    t.innerHTML = `${teile.length ? `Draußen bleiben: ${teile.join("; ")}.` : "Alle gerichteten Stellen im Gebiet sind dabei."}${quer}`;
  } else {
    if (g.lizenz) teile.push(`${eine(g.lizenz, "comes", "come")} from sources without a licence (${b.ohneLizenz.map(esc).join(", ")})`);
    if (g.kompass) teile.push(`${eine(g.kompass, "names", "name")} only a destination`);
    if (g.gruppe) teile.push(`${eine(g.gruppe, "counts", "count")} none of the chosen groups`);
    const quer = g.beide ? ` Shown only: ${eine(g.beide, "counts both directions together or names none", "count both directions together or name none")} (most cycle counters). They fit no single link; on the map they are purple and are not assigned.` : "";
    t.innerHTML = `${teile.length ? `Left out: ${teile.join("; ")}.` : "All directional sites in the area are included."}${quer}`;
  }
  renderGruppen();
}

function renderGruppen() {
  const d = state.daten;
  if (!d) return;
  const body = $("gruppen-body");
  const zaehler = Object.fromEntries(GRUPPEN.map((g) => [g, state.stellen.filter((s) => familieVon(s) === "dauer" && s.gruppen.includes(g)).length]));
  body.replaceChildren(...GRUPPEN.map((g) => {
    const cfg = state.gruppen[g];
    const tr = document.createElement("tr");
    tr.className = cfg.an ? "" : "off";
    tr.innerHTML = `<td><label class="check"><input type="checkbox" data-g="${g}" data-f="an"${cfg.an ? " checked" : ""}>${esc(gruppenName(g))}</label></td>
      <td><input type="text" data-g="${g}" data-f="mode" value="${esc(cfg.mode)}" spellcheck="false" aria-label="${esc(tx(`networkMode für ${g}`, `networkMode for ${g}`))}"></td>
      <td><input type="text" data-g="${g}" data-f="link" value="${esc(cfg.link)}" spellcheck="false" aria-label="${esc(tx(`Modi, die der Link erlauben muss, für ${g}`, `Modes the link must allow, for ${g}`))}"></td>
      <td class="n">${state.bereich?.dauer ? nr(zaehler[g]) : ""}</td>`;
    return tr;
  }));
  renderModusHinweis();
}

// Dasselbe Verkehrsmittel unter anderem Namen: MATSim sagt bike, manche Netze bicycle
const MODUS_GLEICH = { bike: ["bicycle"], bicycle: ["bike"], walk: ["foot"], foot: ["walk"], truck: ["hgv"], hgv: ["truck"] };

/** Eine eingeschaltete Gruppe, deren „Link erlaubt“ im Netz kein Link hat: sagen, was das Netz kennt. */
function renderModusHinweis() {
  const box = $("gruppen-hinweis");
  const modi = state.netz?.info?.modi;
  const imNetz = new Set(Object.keys(modi ?? {}));
  const zeilen = [];
  if (modi) {
    for (const g of GRUPPEN) {
      const cfg = state.gruppen[g];
      if (!cfg.an) continue;
      const gesucht = cfg.link.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
      if (!gesucht.length || gesucht.some((m) => imNetz.has(m))) continue;
      const ersatz = gesucht.flatMap((m) => MODUS_GLEICH[m] ?? []).find((m) => imNetz.has(m));
      const name = gruppenName(g);
      const knopf = ersatz ? ` <button type="button" class="linkbtn" data-g="${esc(g)}" data-modus="${esc(ersatz)}">${esc(tx(`${name} auf ${ersatz} stellen`, `Set ${name} to ${ersatz}`))}</button>` : "";
      const codes = gesucht.map((m) => `<code>${esc(m)}</code>`).join(tx(" oder ", " or "));
      zeilen.push(tx(`Kein Link im Netz erlaubt ${codes} (${esc(name)}).${knopf}`, `No link in the network allows ${codes} (${esc(name)}).${knopf}`));
    }
  }
  box.hidden = !zeilen.length;
  if (!zeilen.length) return;
  const bekannt = Object.entries(modi).sort((a, b) => b[1] - a[1]).map(([m, n]) => `<code>${esc(m)}</code> (${nr(n)})`).join(", ");
  box.innerHTML = `${zeilen.join(" ")} ${tx(`Das Netz kennt: ${bekannt}.`, `The network has: ${bekannt}.`)}`;
}
$("gruppen-hinweis").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-g]");
  if (!b) return;
  const cfg = state.gruppen[b.dataset.g];
  // der networkMode zieht mit, wenn er wie der Link hieß: Die counts.xml soll das Verkehrsmittel des Netzes tragen
  if (cfg.mode === cfg.link) cfg.mode = b.dataset.modus;
  cfg.link = b.dataset.modus;
  store.set("snapper.gruppen", JSON.stringify(state.gruppen));
  renderGruppen();
  renderKurz();
  if (state.netz) waehleStellen();
});
$("gruppen-body").addEventListener("change", (e) => {
  const el = e.target;
  const g = el.dataset.g;
  if (!g) return;
  const cfg = state.gruppen[g];
  if (el.dataset.f === "an") cfg.an = el.checked;
  else cfg[el.dataset.f] = el.value.trim();
  store.set("snapper.gruppen", JSON.stringify(state.gruppen));
  renderKurz();
  if (el.dataset.f === "mode") {
    verteileNeu();
    mittleAlle();
    renderAlles();
  } else waehleStellen();
});
for (const id of ["radius", "winkel"]) $(id).addEventListener("change", () => state.netz && suche());
$("ohne-kompass").addEventListener("change", () => state.netz && waehleStellen());

const FILTER = [
  ["alle", "Alle", "All"],
  ["pruefen", "Prüfen", "To review"],
  ["ohne", "Ohne Link", "No link"],
  ["passt", "Passt", "Matched"],
  ["geprueft", "Geprüft", "Reviewed"],
  ["aus", "Ausgelassen", "Skipped"],
  ["quer", "Beide Richtungen", "Both directions"],
];
const FAMILIEN = [
  ["alle", "Alle", "All"],
  ["dauer", "Dauer", "Permanent"],
  ["kurz", "Kurzzeit", "Short-term"],
];
// in der Liste gehören die Stellen ohne Richtung zu den Dauerzählstellen
const familiePasst = (s) => state.familie === "alle" || (familieVon(s) === "kurz" ? "kurz" : "dauer") === state.familie;
function renderFilter() {
  const kurze = state.stellen.filter((s) => familieVon(s) === "kurz").length;
  const fam = $("familie");
  fam.hidden = !kurze;
  if (!kurze && state.familie !== "alle") state.familie = "alle";
  fam.replaceChildren(...FAMILIEN.map(([wert, de, en]) => {
    const text = tx(de, en);
    const n = wert === "alle" ? state.stellen.length : wert === "kurz" ? kurze : state.stellen.length - kurze;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(state.familie === wert));
    b.value = wert;
    b.innerHTML = `${text}<span>${nr(n)}</span>`;
    return b;
  }));
  const box = $("filter");
  const teil = state.stellen.filter(familiePasst);
  box.replaceChildren(...FILTER.map(([wert, de, en]) => {
    const text = tx(de, en);
    const n = wert === "alle" ? teil.length : teil.filter((s) => lageVon(s) === wert).length;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(state.filter === wert));
    b.value = wert;
    b.innerHTML = `${text}<span>${nr(n)}</span>`;
    b.disabled = !n && wert !== "alle";
    b.hidden = wert === "quer" && !n;
    return b;
  }));
}
$("filter").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.filter = b.value;
  renderFilter();
  renderListe();
});
$("familie").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.familie = b.value;
  renderFilter();
  renderListe();
});

const sichtbare = () => state.stellen.filter((s) => familiePasst(s) && (state.filter === "alle" || lageVon(s) === state.filter));

/** Die zweite Zeile eines Eintrags: Richtung und Kennung, bei Kurzzeit-Punkten dazu der Tag der Zählung. */
const listenText = (s) => {
  if (familieVon(s) === "kurz") return `${richtungAnzeige(s)} · ${datumText(s.kurz.datum)} · ${s.kurz.stelle}`;
  if (familieVon(s) === "quer") return tx(`${richtungsText(s) || "ohne Fahrtrichtung"}, nur angezeigt · ${s.id}`, `${richtungsText(s) || "no direction"}, shown only · ${s.id}`);
  return `${richtungsText(s)} · ${s.id}`;
};

function renderListe() {
  const ul = $("liste");
  const alle = sichtbare();
  if (!alle.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = state.stellen.length ? tx("Keine Stellen in dieser Auswahl.", "No sites in this selection.") : tx("Noch keine Zählstellen.", "No count sites yet.");
    ul.replaceChildren(li);
    return;
  }
  // mit Kurzzeitzählungen werden es schnell Tausende: die Liste zeigt die ersten, die gewählte immer
  let liste = alle.slice(0, KURZ_LISTE_MAX);
  const sel = state.byId.get(state.auswahl);
  if (sel && alle.length > KURZ_LISTE_MAX && !liste.includes(sel) && alle.includes(sel)) liste = [sel, ...liste];
  const items = liste.map((s) => {
    const lage = lageVon(s);
    const link = linkVon(s);
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = s.id;
    b.setAttribute("aria-current", String(s.id === state.auswahl));
    b.innerHTML = `<span class="dot${familieVon(s) === "kurz" ? " ring" : ""}" style="--c: var(${LAGE_FARBE[lage]})" title="${esc(lageText(lage))}${familieVon(s) === "kurz" ? tx(", Kurzzeitzählung", ", short-term count") : ""}"></span>
      <span class="t">${esc(s.name || s.id)} <small>${esc(abschnittText(s) ?? "")}</small></span>
      <span class="m">${link?.d != null ? `${nr(link.d)} m` : "–"}</span>
      <span class="s">${esc(listenText(s))}</span>`;
    li.append(b);
    return li;
  });
  if (alle.length > liste.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = tx(`… und ${nr(alle.length - liste.length)} weitere. Mit den Filtern eingrenzen, „Nächste zum Prüfen“ nehmen oder auf der Karte wählen.`, `… and ${nr(alle.length - liste.length)} more. Narrow down with the filters, use “Next to review” or pick on the map.`);
    items.push(li);
  }
  ul.replaceChildren(...items);
}
$("liste").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (b) waehle(b.dataset.id);
});

function kompassSvg(grad) {
  if (grad == null) return "";
  return `<span class="kompass" title="${nr(grad)}°"><svg viewBox="-10 -10 20 20" aria-hidden="true"><path d="M0 -8 L5 6 L0 3 L-5 6 Z" fill="currentColor" transform="rotate(${grad})"/></svg></span>`;
}

function profilSvg(s) {
  const r = state.ergebnisMittel.get(s.id);
  if (!r) return "";
  const gruppen = Object.keys(r).filter((g) => r[g].werte.some((v) => v != null));
  if (!gruppen.length) return `<p class="note">${tx("Im gewählten Zeitraum gibt es für diese Stelle keine Werte.", "There are no values for this site in the chosen period.")}</p>`;
  const max = Math.max(...gruppen.flatMap((g) => r[g].werte.filter((v) => v != null)));
  const W = 360;
  const H = 92;
  const unten = 14;
  const breit = W / 24;
  const balken = breit / gruppen.length - 1;
  let bars = "";
  gruppen.forEach((g, gi) => {
    r[g].werte.forEach((v, h) => {
      if (v == null) return;
      const hoehe = ((H - unten - 4) * v) / max;
      bars += `<rect x="${(h * breit + gi * (balken + 1)).toFixed(1)}" y="${(H - unten - hoehe).toFixed(1)}" width="${balken.toFixed(1)}" height="${hoehe.toFixed(1)}" fill="${GRUPPE_FARBE[g] ?? "#888"}"><title>${tx(`${g} ${h}–${h + 1} Uhr: ${nr(v, 1)} (${r[g].tage[h]} Tage)`, `${g} ${h}:00–${h + 1}:00: ${nr(v, 1)} (${r[g].tage[h]} days)`)}</title></rect>`;
    });
  });
  const ticks = [0, 6, 12, 18, 23].map((h) => `<text x="${(h * breit + breit / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">${h}</text>`).join("");
  // eine Stelle ohne Richtung geht in keine Ausgabe: dort kein networkMode in der Legende
  const modus = (g) => (familieVon(s) === "quer" ? "" : ` → ${esc(state.gruppen[g].mode)}`);
  const leg = gruppen.map((g) => `<span><i style="--c:${GRUPPE_FARBE[g]}"></i>${esc(gruppenName(g))}${modus(g)}: ${tx(`${nr(r[g].tageGenutzt)} Tage${r[g].vollstaendig ? "" : ", nicht alle Stunden"}`, `${nr(r[g].tageGenutzt)} days${r[g].vollstaendig ? "" : ", not all hours"}`)}</span>`).join("");
  return `<svg class="profil" viewBox="0 0 ${W} ${H}" role="img" aria-label="${tx("Tagesgang der Stelle", "Daily profile of the site")}"><text x="0" y="9">${nr(max)} ${tx("Fz/h", "veh/h")}</text>${bars}${ticks}</svg><div class="legende-profil">${leg}</div>`;
}

const TAGTYP_EN = { s: "School day", f: "School holiday", h: "Public holiday", w: "Weekend", u: "no calendar" };
const tagtypText = (t) => (sprache() === "de" ? TAGTYP[t] : TAGTYP_EN[t]) ?? "";
const lizenzLink = (l) => (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.lizenz)}</a>` : esc(l.lizenz));

/** Die gezählten Stunden eines Kurzzeit-Punkts als Balken, je Gruppe; nicht gezählte Stunden bleiben leer. */
function profilKurzSvg(s) {
  const p = s.kurz;
  const gruppen = s.aktiv.filter((g) => p.werte[g]?.some((v) => v != null));
  if (!gruppen.length) return "";
  const W = 360;
  const H = 92;
  const unten = 14;
  const breit = W / 24;
  const balken = breit / gruppen.length - 1;
  const max = Math.max(1, ...gruppen.flatMap((g) => p.werte[g].filter((v) => v != null)));
  let bars = "";
  gruppen.forEach((g, gi) => {
    p.werte[g].forEach((v, k) => {
      const h = p.h0 + k;
      if (v == null || h < 0 || h > 23) return;
      const hoehe = ((H - unten - 4) * v) / max;
      bars += `<rect x="${(h * breit + gi * (balken + 1)).toFixed(1)}" y="${(H - unten - hoehe).toFixed(1)}" width="${balken.toFixed(1)}" height="${hoehe.toFixed(1)}" fill="${GRUPPE_FARBE[g] ?? "#888"}"><title>${tx(`${g} ${h}–${h + 1} Uhr: ${nr(v)}`, `${g} ${h}:00–${h + 1}:00: ${nr(v)}`)}</title></rect>`;
    });
  });
  const ticks = [0, 6, 12, 18, 23].map((h) => `<text x="${(h * breit + breit / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">${h}</text>`).join("");
  const namen = state.kurz.manifest?.gruppenNamen ?? {};
  const leg = gruppen.map((g) => {
    const n = p.werte[g].filter((v) => v != null).length;
    const summe = p.werte[g].reduce((a, v) => a + (v ?? 0), 0);
    return `<span><i style="--c:${GRUPPE_FARBE[g]}"></i>${esc(gruppenName(g, namen))} → ${esc(state.gruppen[g].mode)}: ${tx(`${nr(n)} gezählte Stunden, Summe ${nr(summe)}`, `${nr(n)} counted hours, total ${nr(summe)}`)}</span>`;
  }).join("");
  return `<svg class="profil" viewBox="0 0 ${W} ${H}" role="img" aria-label="${tx("Gezählte Stunden", "Counted hours")}"><text x="0" y="9">${nr(max)} ${tx("Fz/h", "veh/h")}</text>${bars}${ticks}</svg><div class="legende-profil">${leg}</div><p class="note">${tx(`Ein gezählter Tag, nur die gezählten Stunden (${esc(p.fenster)} Uhr): kein Mittel, keine Hochrechnung.`, `One counted day, only the counted hours (${esc(p.fenster)} h): no average, no extrapolation.`)}</p>`;
}

/** Kopf der Karte einer Kurzzeit-Stelle: Zählung, Tag, Lizenz, Lage. */
function kopfKurz(s) {
  const p = s.kurz;
  const q = state.kurz.manifest?.quellen.get(p.quelle);
  const namen = state.kurz.manifest?.gruppenNamen ?? {};
  const liz = [s.lizenz.lieferung, s.lizenz.lage].filter(Boolean);
  const lage = p.lage === "geokodiert"
    ? tx("Lage aus OpenStreetMap geokodiert (Straßenkreuzung): Der Punkt kann an der Kreuzung liegen statt an der Zählstelle.", "Location geocoded from OpenStreetMap (road junction): the point may lie at the junction instead of the count site.")
    : p.lage === "uebertragen" ? tx("Lage von anderen Zählungen derselben Stelle übertragen.", "Location transferred from other counts at the same site.") : null;
  const stroeme = p.stroeme.map(([a, b]) => `${a}→${b}`).join(", ");
  return `
    <div><h3>${esc(s.name || p.stelle)}</h3><p class="sub">${esc(richtungAnzeige(s))}</p></div>
    <div class="meta">${kompassSvg(s.r.grad)}<span>${s.r.grad != null ? `${kurz(s.r.grad)} ${nr(s.r.grad)}°` : tx("ohne Richtung", "no direction")}</span>·<span>${p.art === "knoten" ? tx(`Knoten, Punkt ${nr(state.kurz.opts.abstand)} m auf dem Arm`, `Junction, point ${nr(state.kurz.opts.abstand)} m along the arm`) : tx("Querschnitt", "Cross-section")}</span>·<span title="${tx("Ströme von Arm nach Arm", "Movements from arm to arm")}">${tx("Ströme", "Movements")} ${esc(stroeme)}</span></div>
    <div class="meta"><span class="chip">${tx("Kurzzeitzählung", "Short-term count")}</span><span>${esc(datumText(p.datum))}</span>·<span>${esc(tagtypText(p.tag ?? "u"))}</span>·<span>${esc(p.fenster)} ${tx("Uhr", "h")}</span>${p.intervall ? `·<span>${esc(tx(`${p.intervall}-Minuten-Werte`, `${p.intervall}-minute values`))}</span>` : ""}</div>
    <div class="meta"><span>${esc(p.stelle)}</span>·<span>${esc(p.kennung)}</span>·<span>${esc(q?.name ?? p.quelle)}</span>·<span>${liz.map(lizenzLink).join(", ")}</span>·<span>${s.aktiv.map((g) => esc(gruppenName(g, namen))).join(", ")}</span></div>
    ${lage ? `<p class="note">${esc(lage)}</p>` : ""}
    ${p.andere.length ? `<p class="note">${tx(
      `Am selben Tag gibt es hier ${p.andere.length === 1 ? "eine weitere Zählung" : "weitere Zählungen"} (${esc(p.andere.join(", "))}), etwa zu anderen Stunden oder auf dem anderen Gehweg; sie ${p.andere.length === 1 ? "bleibt" : "bleiben"} draußen.`,
      `On the same day there ${p.andere.length === 1 ? "is another count" : "are other counts"} here (${esc(p.andere.join(", "))}), e.g. at other hours or on the other footway; ${p.andere.length === 1 ? "it is" : "they are"} left out.`,
    )}</p>` : ""}`;
}

/** Steckbrief einer Stelle ohne Richtung: was sie zählt und warum sie an keinen Link geht, dazu ihr Tagesgang. */
function karteQuer(box, s) {
  const q = state.daten.quellen.get(s.quelle);
  const warum = s.r.art === "beide"
    ? tx("Die Stelle zählt beide Fahrtrichtungen zusammen.", "The site counts both directions together.")
    : tx("Die Quelle nennt keine Fahrtrichtung. Meist zählt eine solche Stelle beide Richtungen zusammen, etwa an einem Radweg, der in beiden Richtungen befahren wird.", "The source names no direction. Such a site usually counts both directions together, e.g. on a two-way cycle path.");
  box.innerHTML = `
    <div><h3>${esc(s.name || s.id)}</h3>${s.abschnitt ? `<p class="sub">${esc(abschnittText(s))}</p>` : ""}</div>
    <div class="meta">${kompassSvg(null)}<span>${esc(richtungsText(s) || tx("ohne Fahrtrichtung", "no direction"))}</span></div>
    <div class="meta"><span>${esc(s.id)}</span>·<span>${esc(q.name)}</span>·<span>${q.lizenzen.map(lizenzLink).join(", ")}</span>·<span>${s.gruppen.map((g) => esc(gruppenName(g))).join(", ")}</span></div>
    <div class="row"><span class="lage" style="--c: var(${LAGE_FARBE.quer})">${tx("nicht richtungsfein · nur angezeigt", "not directional · shown only")}</span></div>
    <p class="note">${esc(warum)} ${tx("Eine MATSim-Messstelle hängt an einem gerichteten Link, darum geht die Stelle an keinen Link und nicht in die Ausgabe. Der Tagesgang unten ist die Summe beider Richtungen.", "A MATSim count station sits on one directed link, so this site goes to no link and not into the output. The daily profile below is the sum of both directions.")}</p>
    <div>${state.stunden.has(s.id) ? profilSvg(s) : `<p class="note">${tx("Stundenwerte werden geladen …", "Loading hourly values …")}</p>`}</div>`;
}

function renderKarte() {
  const box = $("karte");
  const s = state.byId.get(state.auswahl);
  box.hidden = !s;
  if (!s) return;
  if (familieVon(s) === "quer") return karteQuer(box, s);
  const kurzPunkt = familieVon(s) === "kurz";
  const q = kurzPunkt ? null : state.daten.quellen.get(s.quelle);
  const lage = lageVon(s);
  const link = linkVon(s);
  const e = state.entscheid.get(s.id);
  const kand = state.ergebnisse.get(s.id)?.kandidaten ?? [];
  const lizenz = q ? q.lizenzen.map(lizenzLink).join(", ") : "";
  const partner = partnerVon(s);
  const gruende = lage === "pruefen" || lage === "ohne" ? gruendeVon(s) : [];
  const zeile = (k, v) => (v == null || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${v}</dd>`);
  const linkHtml = link
    ? `<dl class="linkinfo">${zeile("Link", esc(link.id))}${zeile(tx("Abstand", "Distance"), link.d != null ? `${nr(link.d, 1)} m` : null)}${zeile(tx("Richtung", "Direction"), link.grad != null ? `${kurz(link.grad)} ${nr(link.grad)}°${link.abweichung != null ? tx(`, ${nr(link.abweichung)}° Abweichung`, `, ${nr(link.abweichung)}° off`) : ""}` : null)}${zeile("type", esc(link.type ?? ""))}${zeile("name", esc(link.name ?? ""))}${zeile("modes", esc(link.modes || "(car)"))}${zeile(tx("OSM-Weg", "OSM way"), wegHtml(link.weg))}${zeile(tx("Tempo", "Speed"), link.kmh != null ? `${nr(link.kmh, 1)} km/h` : null)}${zeile("capacity", link.capacity != null && !link.osm ? tx(`${nr(link.capacity)} Fz/h, ${nr(link.permlanes ?? 0, 1)} Fahrstreifen`, `${nr(link.capacity)} veh/h, ${nr(link.permlanes ?? 0, 1)} lanes`) : null)}</dl>`
    : "";
  // ein Kurzzeit-Punkt von Hand auf einem Link einer Dauerzählstelle: erlaubt, aber sagen
  const dauerDort = kurzPunkt && link ? (state.inhaber?.get(link.id) ?? []).filter((t) => familieVon(t) === "dauer" && ausgabeModi(t).some((m) => ausgabeModi(s).includes(m))) : [];
  const kopf = kurzPunkt
    ? kopfKurz(s)
    : `
    <div><h3>${esc(s.name || s.id)}</h3>${s.abschnitt ? `<p class="sub">${esc(abschnittText(s))}</p>` : ""}</div>
    <div class="meta">${kompassSvg(s.r.grad)}<span>${esc(richtungsText(s))}</span></div>
    <div class="meta"><span>${esc(s.id)}</span>·<span>${esc(q.name)}</span>·<span>${lizenz}</span>·<span>${s.gruppen.map((g) => esc(gruppenName(g))).join(", ")}</span></div>
    ${state.stunden.get(s.id)?.fahrstreifen?.length ? `<div class="meta"><span>${tx("Fahrstreifen", "Lanes")}: ${esc(state.stunden.get(s.id).fahrstreifen.join(", "))}</span></div>` : ""}`;
  const profil = kurzPunkt ? profilKurzSvg(s) : state.stunden.has(s.id) ? profilSvg(s) : `<p class="note">${tx("Stundenwerte werden geladen …", "Loading hourly values …")}</p>`;
  const woher = e?.uebernommen && e.link ? tx(" · übernommen", " · transferred") : e?.link && kand[0]?.id !== e.link.id ? tx(" · von Hand", " · by hand") : "";
  const uebernommen = e?.uebernommen && e.link
    ? tx(`Übernommen aus „${esc(e.uebernommen.netz ?? "einer Zuordnung")}“: ${esc(wieText(e.uebernommen.wie) ?? e.uebernommen.wie)}${e.uebernommen.d != null ? `, ${nr(e.uebernommen.d, 1)} m vom übernommenen Punkt` : ""}.`, `Transferred from “${esc(e.uebernommen.netz ?? "an assignment")}”: ${esc(wieText(e.uebernommen.wie) ?? e.uebernommen.wie)}${e.uebernommen.d != null ? `, ${nr(e.uebernommen.d, 1)} m from the transferred point` : ""}.`)
    : "";
  box.innerHTML = `${kopf}
    <div class="row"><span class="lage" style="--c: var(${LAGE_FARBE[lage]})">${esc(lageText(lage))}${woher}</span></div>
    ${dauerDort.length ? `<p class="note">${tx(`Auf diesem Link liegt auch ${esc(dauerDort.map(stelleText).join(", "))}. Beide gehen in ihre eigene Datei.`, `${esc(dauerDort.map(stelleText).join(", "))} is also on this link. Each goes into its own file.`)}</p>` : ""}
    ${uebernommen ? `<p class="note">${uebernommen}</p>` : ""}
    ${gruende.length ? `<ul class="gruende">${gruende.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
    ${linkHtml}
    <div class="row">
      ${lage === "pruefen" || lage === "passt" ? `<button type="button" class="btn small" data-act="passt">${tx("Passt", "Accept")}</button>` : ""}
      ${lage !== "aus" ? `<button type="button" class="btn secondary small${state.pick ? " on" : ""}" data-act="pick">${state.pick ? tx("Wählen abbrechen", "Cancel picking") : tx("Auf der Karte wählen", "Pick on the map")}</button>` : ""}
      ${partner && link && linkVon(partner) ? `<button type="button" class="btn secondary small" data-act="tausch" title="${esc(tx(`mit ${richtungsText(partner)}`, `with ${richtungsText(partner)}`))}">${tx("Mit Gegenrichtung tauschen", "Swap with opposite direction")}</button>` : ""}
      ${lage === "aus" ? `<button type="button" class="btn secondary small" data-act="ein">${tx("Wieder aufnehmen", "Include again")}</button>` : `<button type="button" class="btn secondary small" data-act="aus">${tx("Auslassen", "Skip")}</button>`}
      ${e?.link ? `<button type="button" class="linkbtn" data-act="reset">${tx("Zurück zur automatischen Wahl", "Back to the automatic choice")}</button>` : ""}
    </div>
    <div class="field"><label for="kommentar">${tx("Kommentar", "Comment")}</label><textarea id="kommentar" rows="1" placeholder="${tx("geht in die CSV", "goes into the CSV")}">${esc(e?.kommentar ?? "")}</textarea></div>
    ${kand.length ? `<table class="kand"><caption class="visually-hidden">${tx("Links im Umkreis", "Links in the radius")}</caption><thead><tr><th></th><th>Link</th><th>${tx("Abstand", "Distance")}</th><th>${tx("Abw.", "Off")}</th><th>${tx("Name / Typ", "Name / type")}</th><th></th></tr></thead><tbody>${kand.map((k, r) => `<tr class="${k.id === link?.id ? "cur" : ""}"><td><span class="rang">${r + 1}</span></td><td>${esc(k.id)}</td><td>${nr(k.d, 1)} m</td><td>${k.abweichung != null ? `${nr(k.abweichung)}°` : "–"}</td><td class="x" title="${esc([k.name, k.type].filter(Boolean).join(" · "))}">${esc([k.name, k.type].filter(Boolean).join(" · ") || "–")}</td><td>${k.id === link?.id || lage === "aus" ? "" : `<button type="button" class="linkbtn" data-act="nimm" data-i="${k.i}">${tx("nehmen", "use")}</button>`}</td></tr>`).join("")}</tbody></table>` : `<p class="note">${tx("Kein Link im Umkreis. Auf der Karte lässt sich einer wählen.", "No link in the radius. You can pick one on the map.")}</p>`}
    <div>${profil}</div>`;
  const k = box.querySelector("#kommentar");
  k.addEventListener("change", () => {
    entscheid(s.id).kommentar = k.value.trim();
    speichere();
  });
}
$("karte").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const id = state.auswahl;
  const act = b.dataset.act;
  if (act === "passt") passt(id);
  else if (act === "pick") (state.pick ? pickEnde() : pickStart());
  else if (act === "aus") auslassen(id, true);
  else if (act === "ein") auslassen(id, false);
  else if (act === "reset") zuruecksetzen(id);
  else if (act === "tausch") tausche(id);
  else if (act === "nimm") {
    const k = state.ergebnisse.get(id)?.kandidaten.find((x) => x.i === Number(b.dataset.i));
    if (k) nimmLink(id, { i: k.i, link: k });
  }
});

// ---------- Stundenwerte und Mitteln ----------
async function ladeStunden(stellen) {
  const d = state.daten;
  const fehlt = stellen.filter((s) => !state.stunden.has(s.id));
  const chunks = [...new Set(fehlt.map((s) => s.chunk))];
  let fertig = 0;
  let fehler = 0;
  const zeige = () => {
    if (chunks.length > 1) $("stunden-text").textContent = tx(`${nr(fertig)} von ${nr(chunks.length)} Dateien geladen …`, `${nr(fertig)} of ${nr(chunks.length)} files loaded …`);
  };
  zeige();
  const holen = (chunk) => {
    if (!state.chunks.has(chunk)) {
      const p = fetch(`${DATEN}${detailPfad(d, chunk)}`).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      state.chunks.set(chunk, p);
      p.catch(() => state.chunks.delete(chunk));
    }
    return state.chunks.get(chunk);
  };
  let at = 0;
  const arbeiter = async () => {
    while (at < chunks.length) {
      const chunk = chunks[at++];
      try {
        const json = await holen(chunk);
        for (const [id, eintrag] of Object.entries(json.stellen ?? {})) {
          if (state.byId.has(id) && !state.stunden.has(id)) state.stunden.set(id, leseStunden(eintrag));
        }
      } catch {
        fehler++;
      }
      fertig++;
      zeige();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, arbeiter));
  // der Chunk hält nur, was er kennt; eine Stelle ohne Eintrag bekommt null
  for (const s of fehlt) if (!state.stunden.has(s.id) && state.chunks.has(s.chunk)) state.stunden.set(s.id, null);
  if (fehler) $("stunden-text").textContent = tx(`${nr(fehler)} Datei${fehler === 1 ? " ließ" : "en ließen"} sich nicht laden.`, `${nr(fehler)} file${fehler === 1 ? "" : "s"} could not be loaded.`);
  mittleAlle();
  return fehler === 0;
}

/** Die Stellen einer Familie, die in die Ausgabe gehen: mit Link, nicht ausgelassen, wahlweise nur geprüfte. */
function genutzteStellen(familie = "dauer") {
  return state.stellen.filter((s) => familieVon(s) === familie && lageVon(s) !== "aus" && linkVon(s) && (!$("nur-geprueft").checked || lageVon(s) === "geprueft"));
}

async function ladeAlleStunden() {
  const stellen = genutzteStellen();
  $("stunden-laden").disabled = true;
  setStatus(tx(`Stundenwerte von ${nr(stellen.length)} Stellen laden …`, `Loading hourly values of ${nr(stellen.length)} sites …`));
  const ok = await ladeStunden(stellen);
  $("stunden-laden").disabled = false;
  setStatus(() => (ok ? tx("Stundenwerte geladen.", "Hourly values loaded.") : tx("Nicht alle Stundenwerte ließen sich laden.", "Not all hourly values could be loaded.")), ok ? "done" : "error");
  renderMittelRahmen();
  renderAlles();
}
$("stunden-laden").addEventListener("click", ladeAlleStunden);

/** Wochentage, Zeitraum und die Hinweise zum Zeitraum der Daten. */
function renderMittelRahmen() {
  const m = state.mittel;
  $("wochentage").replaceChildren(...WOCHENTAGE.map((w) => {
    const b = document.createElement("button");
    b.type = "button";
    b.value = String(w.nr);
    b.textContent = tx(w.kurz, w.en);
    b.setAttribute("aria-pressed", String(m.wochentage.includes(w.nr)));
    return b;
  }));
  // der Zeitraum der Stundenwerte je Quelle (die jüngsten 12 Monate)
  if (!state.daten) return;
  const quellen = [...new Set(state.stellen.filter((s) => familieVon(s) === "dauer").map((s) => s.quelle))].map((c) => state.daten.quellen.get(c)).filter(Boolean);
  const raeume = quellen.filter((q) => q.stundenVon && q.bis).map((q) => [tagNr(q.stundenVon), tagNr(q.bis)]);
  if (raeume.length) {
    const min = Math.min(...raeume.map((r) => r[0]));
    const max = Math.max(...raeume.map((r) => r[1]));
    for (const id of ["von", "bis"]) {
      $(id).min = isoTag(min);
      $(id).max = isoTag(max);
    }
    $("von").placeholder = isoTag(min);
    if (!$("jahr").value) $("jahr").value = String(new Date(max * 86400000).getUTCFullYear());
  }
  $("zeitraum-text").innerHTML = quellen.length
    ? tx(`Stundenwerte hat die Zählkarte für die jüngsten 12 Monate: ${quellen.map((q) => `${esc(q.name)} ${esc(q.stundenVon)} bis ${esc(q.bis)}`).join("; ")}. Ohne Angabe gilt der ganze Zeitraum.`, `The Zählkarte has hourly values for the latest 12 months: ${quellen.map((q) => `${esc(q.name)} ${esc(q.stundenVon)} to ${esc(q.bis)}`).join("; ")}. Without dates, the whole period applies.`)
    : "";
  const fehlt = genutzteStellen().filter((s) => !state.stunden.has(s.id)).length;
  $("laden-row").hidden = fehlt === 0;
  if (fehlt) {
    const chunks = new Set(genutzteStellen().filter((s) => !state.stunden.has(s.id)).map((s) => s.chunk)).size;
    $("stunden-laden").textContent = tx(`Stundenwerte laden (${nr(fehlt)} Stellen, ${nr(chunks)} Datei${chunks === 1 ? "" : "en"})`, `Load hourly values (${anzahl(fehlt, "site", "sites")}, ${anzahl(chunks, "file", "files")})`);
  }
}

function leseMittelForm() {
  const m = state.mittel;
  m.von = $("von").value ? tagNr($("von").value) : null;
  m.bis = $("bis").value ? tagNr($("bis").value) : null;
  m.tagesarten = [...document.querySelectorAll(".tagesart")].filter((c) => c.checked).map((c) => c.value);
  m.minTage = Math.max(1, Number($("min-tage").value) || 1);
  m.nurVollstaendig = $("vollstaendig").checked;
}
$("wochentage").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const tag = Number(b.value);
  const w = state.mittel.wochentage;
  state.mittel.wochentage = w.includes(tag) ? w.filter((x) => x !== tag) : [...w, tag];
  renderMittelRahmen();
  mittleAlle();
  renderAlles();
});
$("statistik").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.mittel.statistik = b.value;
  for (const x of $("statistik").querySelectorAll("button")) x.setAttribute("aria-checked", String(x === b));
  mittleAlle();
  renderAlles();
});
for (const el of [$("von"), $("bis"), $("min-tage"), $("vollstaendig"), ...document.querySelectorAll(".tagesart")]) {
  el.addEventListener("change", () => {
    leseMittelForm();
    mittleAlle();
    renderAlles();
  });
}

/** Für jede Stelle mit Stundenwerten und jede gewählte Gruppe das Mittel nach der Auswahl. */
function mittleAlle() {
  if (!state.daten) return;
  leseMittelForm();
  state.ergebnisMittel = new Map();
  let mitWerten = 0;
  let unvollstaendig = 0;
  let ohneWerte = 0;
  for (const s of state.stellen) {
    if (familieVon(s) === "kurz") continue; // Kurzzeitzählungen: ein Tag, kein Mittel
    const st = state.stunden.get(s.id);
    if (st === undefined) continue;
    const r = {};
    for (const g of s.aktiv) r[g] = mittle(state.daten, s, st, g, state.mittel);
    state.ergebnisMittel.set(s.id, r);
    if (familieVon(s) === "quer") continue; // nur für den Steckbrief
    const gr = Object.values(r);
    if (gr.some((x) => x.werte.some((v) => v != null))) {
      mitWerten++;
      if (gr.some((x) => !x.vollstaendig && x.werte.some((v) => v != null))) unvollstaendig++;
    } else ohneWerte++;
  }
  const t = $("mittel-text");
  t.hidden = state.ergebnisMittel.size === 0;
  t.textContent = tx(
    `${auswahlText(state.mittel)}. ${nr(mitWerten)} Stellen mit Werten${unvollstaendig ? `, davon ${nr(unvollstaendig)} nicht in allen Stunden` : ""}${ohneWerte ? `; ${nr(ohneWerte)} ohne Werte in dieser Auswahl` : ""}.`,
    `${auswahlText(state.mittel, "en")}. ${anzahl(mitWerten, "site", "sites")} with values${unvollstaendig ? `, ${nr(unvollstaendig)} of them not in all hours` : ""}${ohneWerte ? `; ${nr(ohneWerte)} without values in this selection` : ""}.`,
  );
}

// ---------- Ausgeben ----------
const stamm = () => {
  const n = state.netz;
  if (!n) return "netz";
  return n.beispiel ? "berlin-matsim-libs" : scenarioStem(n.name) || "netz";
};

/**
 * Je Link eine Messstelle aus den Einträgen { s, measurements, attributes, tage } der Stellen:
 * MATSim erlaubt je Link nur eine Messstelle und führt Werte desselben Verkehrsmittels zusammen;
 * die erste Gruppe gilt. -> { locations, genutzt (die Einträge, die hineingingen) }.
 */
function messstellen(jeLink, drausen) {
  const locations = [];
  const alleGenutzt = [];
  for (const [refId, eintraege] of jeLink) {
    const modi = new Set();
    const measurements = [];
    const attributes = [];
    const genutzt = [];
    for (const en of eintraege) {
      const eigene = en.measurements.filter((m) => {
        if (modi.has(m.networkMode)) {
          drausen.doppelterModus++;
          return false;
        }
        modi.add(m.networkMode);
        return true;
      });
      if (!eigene.length) continue;
      measurements.push(...eigene);
      genutzt.push(en);
      // teilen sich Stellen einen Link, tragen ihre Angaben das Verkehrsmittel als Endung
      const endung = eintraege.length > 1 ? `_${eigene[0].networkMode}` : "";
      attributes.push(...en.attributes.map(([k, ...rest]) => [`${k}${endung}`, ...rest]), ...(en.tage ?? []));
    }
    if (!genutzt.length) continue;
    const erste = genutzt[0].s;
    const erg = state.ergebnisse.get(erste.id);
    if (genutzt.length > 1) attributes.unshift(["stellen", genutzt.map((en) => en.s.id).join(", ")]);
    locations.push({
      refId,
      id: genutzt.map((en) => en.s.id).join("+"),
      name: [...new Set(genutzt.map((en) => en.s.name || en.s.id))].join(" / "),
      x: erg?.x,
      y: erg?.y,
      attributes,
      measurements,
    });
    alleGenutzt.push(...genutzt);
  }
  return { locations, genutzt: alleGenutzt };
}

/** Die counts.xml aus den Zuordnungen und dem Mittel; dazu, was dabei draußen blieb. */
function baueCounts() {
  const d = state.daten;
  const quellen = new Map();
  const drausen = { ohneWerte: 0, unvollstaendig: 0, doppelterModus: 0, ohneStunden: 0 };
  // erst je Stelle die Messungen, dann je Link eine Messstelle: MATSim erlaubt je Link nur eine
  const jeLink = new Map();
  for (const s of genutzteStellen()) {
    const link = linkVon(s);
    const st = state.stunden.get(s.id);
    if (st === undefined) {
      drausen.ohneStunden++;
      continue;
    }
    const r = state.ergebnisMittel.get(s.id) ?? {};
    const measurements = [];
    const tage = [];
    for (const g of GRUPPEN) {
      if (!s.aktiv.includes(g) || !r[g]) continue;
      const m = r[g];
      if (!m.werte.some((v) => v != null)) {
        drausen.ohneWerte++;
        continue;
      }
      if (state.mittel.nurVollstaendig && !m.vollstaendig) {
        drausen.unvollstaendig++;
        continue;
      }
      measurements.push({ type: "volumes", networkMode: state.gruppen[g].mode, interval: 3600, values: m.werte.flatMap((v, h) => (v == null ? [] : [[h * 3600, v]])) });
      tage.push([`tage_${g}`, m.tageGenutzt]);
    }
    if (!measurements.length) continue;
    const q = d.quellen.get(s.quelle);
    const e = state.entscheid.get(s.id);
    const eintrag = {
      s,
      q,
      measurements,
      attributes: [
        ["quelle", q.code],
        ["lizenz", q.lizenzen.map((l) => l.lizenz).join(", ")],
        ["abschnitt", s.abschnitt],
        ["richtung", s.richtungText || ""],
        ["abstand_m", link.d != null ? Math.round(link.d * 10) / 10 : null, "java.lang.Double"],
        ["abweichung_grad", link.abweichung != null ? Math.round(link.abweichung) : null],
        ["zuordnung", e?.link ? "geprüft" : "automatisch"],
        ["kommentar", e?.kommentar],
      ],
      tage,
    };
    if (!jeLink.has(link.id)) jeLink.set(link.id, []);
    jeLink.get(link.id).push(eintrag);
  }
  const { locations, genutzt } = messstellen(jeLink, drausen);
  for (const en of genutzt) quellen.set(en.q.code, en.q);
  const m = state.mittel;
  const attributes = [
    ["erstellt_mit", "matsim-counts-snapper, https://github.com/vizsim-lab/matsim-counts-snapper"],
    ["zaehlkarte", `Dauerzählstellen der Zählkarte (vizsim-lab), Stand ${d.erzeugt ?? "?"}, ${DATEN}dauer/`],
    ["netz", state.netz?.url ?? (state.netz?.beispiel ? BEISPIEL.url : state.netz?.name)],
    ...(state.gebiet ? [["gebiet", gebietText()]] : []),
    ["aggregation", aggregatText(m)],
    ["statistik", m.statistik === "median" ? "MEDIAN" : "MEAN"],
    ["min_tage", m.minTage],
    ["tagesarten_mo_fr", m.tagesarten.join(",")],
    ["nur_vollstaendig", String(m.nurVollstaendig)],
    ["gruppen", GRUPPEN.filter((g) => state.gruppen[g].an).map((g) => `${g}=${state.gruppen[g].mode}`).join(", ")],
    ...[...quellen.values()].map((q) => [`quelle_${q.code}`, `${q.name}; ${q.lizenzen.map((l) => `${l.lizenz}${l.url ? ` (${l.url})` : ""}`).join(", ")}${q.quellenvermerk ? `; ${q.quellenvermerk}` : ""}`]),
  ];
  const jahr = Number($("jahr").value);
  const xml = countsXml({
    name: $("counts-name").value.trim() || `Zählkarte ${stamm()}`,
    source: "Zählkarte (vizsim-lab), Dauerzählstellen",
    description: auswahlText(m),
    year: Number.isInteger(jahr) ? jahr : new Date().getFullYear(),
    attributes,
    locations,
  });
  return { xml, locations, quellen: [...quellen.values()], drausen };
}

/** Die Auswahl der Kurzzeitzählungen in Worten, für die counts-kurzzeit.xml. */
function kurzAuswahlText(o = state.kurz.opts) {
  const tage = WOCHENTAGE.filter((w) => o.wochentage.includes(w.nr)).map((w) => w.kurz).join(", ");
  const arten = { s: "Schultage", f: "Ferientage", h: "Feiertage", u: "Tage ohne Ferienkalender" };
  const werktags = o.wochentage.some((w) => w >= 1 && w <= 5) ? ` (Mo–Fr nur ${o.tage.map((a) => arten[a]).filter(Boolean).join(", ") || "keine"})` : "";
  const alle = [...(state.kurz.manifest?.jahre.values() ?? [])].flat();
  const jahre = `${o.vonJahr ?? (alle.length ? Math.min(...alle) : "Anfang")} bis ${o.bisJahr ?? (alle.length ? Math.max(...alle) : "Ende")}`;
  return `je Stelle und Gruppe die jüngste Zählung ${jahre} an ${tage}${werktags} mit mindestens ${o.minStunden} gezählten Stunden; ein Tag, nur die gezählten Stunden, kein Mittel`;
}

/** Die Lizenzen der Kurzzeit-Punkte, die hineingehen, je Quelle: [{ quelle, lizenzen: [Einträge] }]. */
function kurzLizenzen(stellen) {
  const je = new Map();
  for (const s of stellen) {
    const q = s.kurz.quelle;
    if (!je.has(q)) je.set(q, new Map());
    for (const l of [s.lizenz.lieferung, s.lizenz.lage]) if (l) je.get(q).set(l.code, l);
  }
  return [...je].map(([code, l]) => ({ quelle: state.kurz.manifest?.quellen.get(code) ?? { code, name: code }, lizenzen: [...l.values()] }));
}

/**
 * Die counts-kurzzeit.xml: je Kurzzeit-Punkt mit Link die gezählten Stunden seines einen Tages,
 * t = Beginn der Stunde in Sekunden. Gekennzeichnet in den Attributen jeder Messstelle
 * (zaehlart=kurzzeit, Datum, Zählfenster, Art des Tages, Arm); MATSim liest sie, beachtet sie
 * aber nicht – darum eine eigene Datei.
 */
function baueKurzCounts() {
  const drausen = { ohneWerte: 0, doppelterModus: 0 };
  const jeLink = new Map();
  const namen = state.kurz.manifest?.gruppenNamen ?? {};
  const stellen = genutzteStellen("kurz");
  for (const s of stellen) {
    const p = s.kurz;
    const link = linkVon(s);
    const measurements = [];
    for (const g of KURZ_GRUPPEN) {
      if (!s.aktiv.includes(g) || !p.werte[g]) continue;
      const values = p.werte[g].flatMap((v, k) => (v == null ? [] : [[(p.h0 + k) * 3600, v]]));
      if (!values.length) {
        drausen.ohneWerte++;
        continue;
      }
      measurements.push({ type: "volumes", networkMode: state.gruppen[g].mode, interval: 3600, values });
    }
    if (!measurements.length) continue;
    const e = state.entscheid.get(s.id);
    const liz = [s.lizenz.lieferung, s.lizenz.lage].filter(Boolean);
    const eintrag = {
      s,
      measurements,
      attributes: [
        ["zaehlart", "kurzzeit"],
        ["quelle", p.quelle],
        ["lizenz", liz.map((l) => l.lizenz).join(", ")],
        ["stelle", p.stelle],
        ["zaehlung", p.kennung],
        ["datum", p.datum],
        ["wochentag", WOCHENTAG_KURZ.de[wochentag(tagNr(p.datum))]],
        ["tagtyp", TAGTYP[p.tag ?? "u"]],
        ["fenster", p.fenster],
        ["art", p.art === "knoten" ? "Knoten" : "Querschnitt"],
        ["arm", `${p.arm.nr}${p.arm.name ? ` ${p.arm.name}` : ""}`],
        ["seite", p.art === "knoten" ? (p.seite === "zu" ? "Zufahrt" : "Ausfahrt") : "Richtung"],
        ["stroeme", p.stroeme.map(([a, b]) => `${a}→${b}`).join(", ")],
        ["richtung_grad", p.grad != null ? Math.round(p.grad) : null],
        ["gruppen", s.aktiv.filter((g) => p.werte[g]).map((g) => `${namen[g] ?? g}=${state.gruppen[g].mode}`).join(", ")],
        ["lage", p.lage],
        ["abstand_m", link.d != null ? Math.round(link.d * 10) / 10 : null, "java.lang.Double"],
        ["abweichung_grad", link.abweichung != null ? Math.round(link.abweichung) : null],
        ["zuordnung", e?.link ? "geprüft" : "automatisch"],
        ["kommentar", e?.kommentar],
      ],
    };
    if (!jeLink.has(link.id)) jeLink.set(link.id, []);
    jeLink.get(link.id).push(eintrag);
  }
  const { locations, genutzt } = messstellen(jeLink, drausen);
  const o = state.kurz.opts;
  const attributes = [
    ["erstellt_mit", "matsim-counts-snapper, https://github.com/vizsim-lab/matsim-counts-snapper"],
    ["zaehlart", "kurzzeit"],
    ["zaehlkarte", `Kurzzeitzählungen der Zählkarte (vizsim-lab) je Strom, Stand ${state.kurz.manifest?.erzeugt ?? "?"}, ${DATEN}stroeme/`],
    ["netz", state.netz?.url ?? (state.netz?.beispiel ? BEISPIEL.url : state.netz?.name)],
    ...(state.gebiet ? [["gebiet", gebietText()]] : []),
    ["auswahl", kurzAuswahlText(o)],
    ["hinweis", "Je Messstelle ein gezählter Tag (Datum, Zählfenster und Art des Tages in ihren Attributen), nur die gezählten Stunden, meist 7 bis 19 Uhr. Eine Tagessumme ist nur die Summe des Zählfensters. Nach Stunden vergleichen, nicht über den Tag."],
    ["arm_abstand_m", o.abstand],
    ["min_stunden", o.minStunden],
    ["gruppen", o.gruppen.map((g) => `${g}=${state.gruppen[g].mode}`).join(", ")],
    ...kurzLizenzen(genutzt.map((en) => en.s)).map(({ quelle, lizenzen }) => [`quelle_${quelle.code}`, `${quelle.name}; ${lizenzen.map((l) => `${l.lizenz}${l.titel ? ` (${l.titel})` : ""}${l.url ? ` ${l.url}` : ""}`).join("; ")}`]),
  ];
  const jahr = Number($("jahr").value);
  const xml = countsXml({
    name: `${$("counts-name").value.trim() || `Zählkarte ${stamm()}`}, Kurzzeitzählungen`,
    source: "Zählkarte (vizsim-lab), Kurzzeitzählungen",
    description: kurzAuswahlText(o),
    year: Number.isInteger(jahr) ? jahr : new Date().getFullYear(),
    attributes,
    locations,
  });
  return { xml, locations, drausen, stellen: genutzt.map((en) => en.s) };
}

const EINSCHRAENKUNG = /NC|SA|Nutzungsbeschr|ODbL/i;

function renderExport() {
  const dauerDa = state.stellen.some((s) => familieVon(s) === "dauer");
  const kurzDa = state.stellen.some((s) => familieVon(s) === "kurz");
  const osm = Boolean(state.netz?.info?.osm);
  for (const id of ["counts-xml", "counts-gz"]) $(id).disabled = !dauerDa || osm;
  $("kurz-export").hidden = !kurzDa;
  for (const id of ["kurz-xml", "kurz-gz"]) $(id).disabled = !kurzDa || osm;
  $("zuordnung-csv").disabled = !state.stellen.length;
  $("konfig-json").disabled = !state.netz;
  $("osm-export").hidden = !osm;
  const genutzt = genutzteStellen("dauer");
  const kurze = genutzteStellen("kurz");
  const fehlt = genutzt.filter((s) => !state.stunden.has(s.id)).length;
  const offen = (familie) => state.stellen.filter((s) => familieVon(s) === familie && lageVon(s) === "pruefen").length;
  const t = $("export-text");
  const teile = [];
  const nurGeprueft = $("nur-geprueft").checked;
  const nurText = nurGeprueft ? tx(" (nur geprüfte)", " (reviewed only)") : "";
  const offenText = (familie) => (offen(familie) && !nurGeprueft ? tx(`, ${nr(offen(familie))} davon noch nicht geprüft`, `, ${nr(offen(familie))} of them not reviewed yet`) : "");
  if (dauerDa) teile.push(tx(`${nr(genutzt.length)} Dauerzählstellen mit Link gehen in die counts.xml${nurText}${offenText("dauer")}.`, `${nr(genutzt.length)} permanent counters with a link go into the counts.xml${nurText}${offenText("dauer")}.`));
  if (kurzDa) teile.push(tx(`${nr(kurze.length)} Kurzzeit-Punkte mit Link gehen in die counts-kurzzeit.xml${nurText}${offenText("kurz")}.`, `${nr(kurze.length)} short-term points with a link go into the counts-kurzzeit.xml${nurText}${offenText("kurz")}.`));
  if (fehlt) teile.push(tx(`Für ${nr(fehlt)} Dauerzählstellen fehlen noch die Stundenwerte; die Knöpfe laden sie vorher.`, `${nr(fehlt)} permanent counters still lack hourly values; the buttons load them first.`));
  t.hidden = !teile.length;
  t.textContent = teile.join(" ");
  // Quellen und Lizenzen der Stellen, die hineingehen
  const quellen = [...new Set(genutzt.map((s) => s.quelle))].map((c) => state.daten?.quellen.get(c)).filter(Boolean);
  const eintraege = quellen.map((q) => ({ name: q.name, lizenzen: q.lizenzen, vermerk: q.quellenvermerk }));
  for (const { quelle, lizenzen } of kurzLizenzen(kurze)) eintraege.push({ name: `${quelle.name} ${tx("(Kurzzeitzählungen)", "(short-term counts)")}`, lizenzen, vermerk: null, titel: true });
  $("quellen-box").hidden = !eintraege.length;
  $("quellen").replaceChildren(...eintraege.map((q) => {
    const li = document.createElement("li");
    const einschr = q.lizenzen.some((l) => EINSCHRAENKUNG.test(l.lizenz ?? ""));
    li.className = einschr ? "einschr" : "";
    const liz = q.lizenzen.map((l) => `${lizenzLink(l)}${q.titel && l.titel ? ` <span class="v">(${esc(l.titel)})</span>` : ""}`).join(", ");
    li.innerHTML = `<b>${esc(q.name)}</b>: ${liz}${q.vermerk ? ` <span class="v">· ${esc(q.vermerk)}</span>` : ""}${einschr ? ` <span class="v">· ${tx("mit Einschränkung", "with restrictions")}</span>` : ""}`;
    return li;
  }));
  if (!$("counts-name").value && state.netz) $("counts-name").placeholder = `Zählkarte ${stamm()}`;
}
$("nur-geprueft").addEventListener("change", () => {
  renderMittelRahmen();
  renderExport();
});

function speichern(name, daten, typ) {
  const url = URL.createObjectURL(new Blob([daten], { type: typ }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportiere(gz) {
  const genutzt = genutzteStellen();
  if (genutzt.some((s) => !state.stunden.has(s.id))) {
    setStatus(tx("Stundenwerte laden …", "Loading hourly values …"));
    await ladeStunden(genutzt);
    renderMittelRahmen();
  }
  const { xml, locations, drausen } = baueCounts();
  const name = `${stamm()}-counts-zaehlkarte.xml`;
  if (gz) {
    const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream("gzip"));
    speichern(`${name}.gz`, await new Response(stream).arrayBuffer(), "application/gzip");
  } else speichern(name, xml, "application/xml");
  const datei = `${name}${gz ? ".gz" : ""}`;
  setStatus(() => {
    const teile = [tx(`${nr(locations.length)} Messstellen in ${datei}.`, `${anzahl(locations.length, "count station", "count stations")} in ${datei}.`)];
    if (drausen.unvollstaendig) teile.push(tx(`${nr(drausen.unvollstaendig)} Tagesgänge ohne alle 24 Stunden blieben draußen.`, `${nr(drausen.unvollstaendig)} daily profiles without all 24 hours were left out.`));
    if (drausen.ohneWerte) teile.push(tx(`${nr(drausen.ohneWerte)} ohne Werte in der Auswahl.`, `${nr(drausen.ohneWerte)} without values in the selection.`));
    if (drausen.doppelterModus) teile.push(tx(`${nr(drausen.doppelterModus)}-mal zwei Gruppen mit demselben networkMode: nur die erste ging hinein.`, `${nr(drausen.doppelterModus)} times two groups with the same networkMode: only the first went in.`));
    return teile.join(" ");
  }, "done");
  renderAlles();
}
$("counts-xml").addEventListener("click", () => exportiere(false));
$("counts-gz").addEventListener("click", () => exportiere(true));

async function exportiereKurz(gz) {
  const { xml, locations, drausen, stellen } = baueKurzCounts();
  const name = `${stamm()}-counts-kurzzeit.xml`;
  if (gz) {
    const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream("gzip"));
    speichern(`${name}.gz`, await new Response(stream).arrayBuffer(), "application/gzip");
  } else speichern(name, xml, "application/xml");
  const datei = `${name}${gz ? ".gz" : ""}`;
  setStatus(() => {
    const teile = [tx(`${nr(locations.length)} Messstellen aus ${nr(stellen.length)} Kurzzeit-Punkten in ${datei}.`, `${anzahl(locations.length, "count station", "count stations")} from ${nr(stellen.length)} short-term points in ${datei}.`)];
    if (drausen.doppelterModus) teile.push(tx(`${nr(drausen.doppelterModus)}-mal zwei Gruppen mit demselben networkMode an einem Link: nur die erste ging hinein.`, `${nr(drausen.doppelterModus)} times two groups with the same networkMode on one link: only the first went in.`));
    return teile.join(" ");
  }, "done");
}
$("kurz-xml").addEventListener("click", () => exportiereKurz(false));
$("kurz-gz").addEventListener("click", () => exportiereKurz(true));

/** Der Punkt einer Linie in WGS 84, der (lon, lat) am nächsten liegt, mit ihrer Richtung dort (Grad ab Nord). */
function punktAufLinie(lon, lat, geom) {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  for (let k = 0; k + 1 < geom.length; k++) {
    const [ax, ay] = geom[k];
    const [bx, by] = geom[k + 1];
    const dx = (bx - ax) * kx;
    const dy = by - ay;
    const ll = dx * dx + dy * dy;
    const t = ll > 0 ? Math.max(0, Math.min(1, (((lon - ax) * kx) * dx + (lat - ay) * dy) / ll)) : 0;
    const px = ax + t * (bx - ax);
    const py = ay + t * (by - ay);
    const d = Math.hypot((px - lon) * kx, py - lat);
    if (d < bestD) {
      bestD = d;
      best = { lon: px, lat: py, grad: ll > 0 ? ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 : null };
    }
  }
  return best;
}

/** Der Anker einer Stelle: der Punkt ihres Links, der ihrem Suchpunkt am nächsten liegt. */
function ankerVon(s) {
  const link = linkVon(s);
  if (!link?.geom?.length) return null;
  const p = suchpunkt(s);
  return punktAufLinie(p.lon, p.lat, link.geom);
}

const netzName = () => (state.netz?.beispiel ? BEISPIEL.name : state.netz?.name ?? "");

$("zuordnung-csv").addEventListener("click", () => {
  const zeilen = state.stellen.filter((s) => familieVon(s) !== "quer").map((s) => {
    const link = linkVon(s);
    const e = state.entscheid.get(s.id);
    const lage = lageVon(s);
    const a = lage === "aus" ? null : ankerVon(s);
    return {
      station: s.id,
      linkid: link?.id ?? "",
      using: lage !== "aus" && Boolean(link),
      kommentar: e?.kommentar ?? "",
      zuordnung: lage === "aus" ? "ausgelassen" : lage === "geprueft" ? "geprüft" : link ? "automatisch" : "ohne Link",
      abstand_m: link?.d != null ? Math.round(link.d * 10) / 10 : "",
      richtung: s.richtungText || "", // die Ausgabe bleibt in jeder Sprache gleich
      name: s.name,
      quelle: s.quelle,
      anker_lon: a ? a.lon.toFixed(7) : "",
      anker_lat: a ? a.lat.toFixed(7) : "",
      anker_grad: a?.grad != null ? Math.round(a.grad) : "",
      osm_weg: link?.weg ?? "",
      netz: link ? netzName() : "",
      zaehlart: familieVon(s) === "kurz" ? "kurzzeit" : "dauer",
    };
  });
  speichern(`${stamm()}-counts-zuordnung.csv`, zuordnungCsv(zeilen), "text/csv");
  setStatus(() => tx(`Zuordnung von ${nr(zeilen.length)} Stellen gespeichert.`, `Assignment of ${anzahl(zeilen.length, "site", "sites")} saved.`), "done");
});

/**
 * Entscheidungen aus einer Zuordnung übernehmen (Zeilen wie leseZuordnungCsv): von Hand Geprüftes
 * mit Anker über den Anker übertragen, ohne Anker über die Link-ID; Ausgelassenes bleibt
 * ausgelassen, Kommentare kommen mit. `name` ist die Herkunft für Hinweise und Status.
 */
async function uebernimmZuordnung(zeilen, name, vorab = null) {
  let gesetzt = 0;
  let fremd = 0;
  let fremdKurz = 0;
  let ohneLink = 0;
  const mitAnker = [];
  for (const z of zeilen) {
    const s = state.byId.get(z.station);
    if (!s) {
      fremd++;
      if (familieVonId(z.station) === "kurz") fremdKurz++;
      continue;
    }
    if (familieVon(s) === "quer") continue; // nur angezeigt, nie zugeordnet
    const ent = entscheid(s.id);
    ent.kommentar = z.kommentar || ent.kommentar;
    // aus dieser Seite: nur, was jemand entschieden hat; eine fremde CSV gilt ganz, wie in MATSim
    if (z.zuordnung === "automatisch" || z.zuordnung === "ohne link") continue;
    if (!z.using) {
      ent.aus = true;
      ent.link = null;
      vonHand(ent);
      gesetzt++;
      continue;
    }
    ent.aus = false;
    // mit Anker: übertragen, auch auf dasselbe Netz (dann passt die ID am selben Ort)
    if (z.anker) {
      mitAnker.push({ s, z });
      continue;
    }
    if (!z.linkid) continue;
    const r = await frage({ type: "link", id: z.linkid, stelle: { lon: s.lon, lat: s.lat, grad: s.r.grad } }).catch(() => null);
    if (r?.link) {
      ent.link = r.link;
      vonHand(ent);
      gesetzt++;
    } else ohneLink++;
  }
  const wie = { id: 0, weg: 0, lage: 0 };
  let offen = 0;
  if (mitAnker.length) {
    const r = await frage({
      type: "uebertrage",
      anker: mitAnker.map(({ s, z }) => ({ id: s.id, lon: z.anker.lon, lat: z.anker.lat, grad: z.anker.grad, linkId: z.linkid || null, weg: z.weg, modi: s.modi, stelle: { lon: s.lon, lat: s.lat, grad: s.r.grad } })),
    });
    const nach = new Map(r.ergebnisse.map((x) => [x.id, x]));
    // ein Link trägt je Verkehrsmittel und Familie eine Stelle: bei zweien gewinnt, wessen Anker näher liegt
    const belegt = new Map();
    const platz = (familie, linkId) => `${familie}\u0000${linkId}`;
    const mitAnkerIds = new Set(mitAnker.map(({ s }) => s.id));
    for (const [andere, e] of state.entscheid) {
      if (!e.link || mitAnkerIds.has(andere)) continue;
      const key = platz(familieVonId(andere), e.link.id);
      belegt.set(key, [...(belegt.get(key) ?? []), andere]);
    }
    const reihe = [...mitAnker].sort((a, b) => (nach.get(a.s.id)?.ankerAbstand ?? Infinity) - (nach.get(b.s.id)?.ankerAbstand ?? Infinity));
    for (const { s, z } of reihe) {
      const x = nach.get(s.id);
      const ent = entscheid(s.id);
      const herkunft = z.netz || name;
      ent.anker = { lon: z.anker.lon, lat: z.anker.lat, grad: z.anker.grad, weg: z.weg, netz: herkunft };
      const modi = ausgabeModi(s);
      const key = x?.link ? platz(familieVon(s), x.link.id) : null;
      const schon = key ? (belegt.get(key) ?? []).find((t) => ausgabeModi(state.byId.get(t) ?? { aktiv: [] }).some((m) => modi.includes(m))) : null;
      if (x?.link && !schon) {
        ent.link = x.link;
        ent.uebernommen = { wie: x.wie, netz: herkunft, d: x.ankerAbstand != null ? Math.round(x.ankerAbstand * 10) / 10 : null };
        belegt.set(key, [...(belegt.get(key) ?? []), s.id]);
        wie[x.wie]++;
      } else {
        ent.link = null;
        ent.uebernommen = null;
        ent.anker.grund = schon ? tx(`der passende Link ${x.link.id} gehört schon zu ${state.byId.get(schon)?.name || schon}`, `the matching link ${x.link.id} already belongs to ${state.byId.get(schon)?.name || schon}`) : x?.grund ?? tx("unklar", "unclear");
        offen++;
      }
    }
  }
  const teile = [`${name}:`];
  if (vorab) teile.push(vorab);
  const uebernommen = wie.id + wie.weg + wie.lage;
  const wieTeile = [[wie.id, tx("gleiche Link-ID", "same link ID")], [wie.weg, tx("gleicher OSM-Weg", "same OSM way")], [wie.lage, tx("eindeutige Lage", "unique location")]].filter(([n]) => n).map(([n, t]) => `${nr(n)} ${t}`).join(", ");
  if (mitAnker.length) {
    teile.push(tx(
      `${nr(uebernommen)} von ${anzahl(mitAnker.length, "geprüften Zuordnung", "geprüften Zuordnungen")} übernommen${uebernommen ? ` (${wieTeile})` : ""}${offen ? `, ${nr(offen)} zum Prüfen` : ""}.`,
      `${nr(uebernommen)} of ${anzahl(mitAnker.length, "reviewed assignment", "reviewed assignments")} transferred${uebernommen ? ` (${wieTeile})` : ""}${offen ? `, ${nr(offen)} to review` : ""}.`,
    ));
  }
  if (gesetzt || !mitAnker.length) teile.push(tx(`${anzahl(gesetzt, "Entscheidung", "Entscheidungen")} ${mitAnker.length ? "ohne Anker " : ""}übernommen.`, `${anzahl(gesetzt, "decision", "decisions")} ${mitAnker.length ? "without an anchor " : ""}transferred.`));
  if (fremd) {
    teile.push(tx(
      `${anzahl(fremd, "Station gehört", "Stationen gehören")} nicht zur Auswahl${fremdKurz ? ` (${anzahl(fremdKurz, "Kurzzeit-Punkt", "Kurzzeit-Punkte")}${state.kurz.an ? ", etwa aus anderen Jahren oder einer anderen Auswahl" : "; die Kurzzeitzählungen sind aus"})` : ""}.`,
      `${anzahl(fremd, "station is", "stations are")} not in the selection${fremdKurz ? ` (${anzahl(fremdKurz, "short-term point", "short-term points")}${state.kurz.an ? ", e.g. from other years or another selection" : "; the short-term counts are off"})` : ""}.`,
    ));
  }
  if (ohneLink) teile.push(tx(`${anzahl(ohneLink, "Link fehlt", "Links fehlen")} im Netz.`, `${anzahl(ohneLink, "link is", "links are")} missing in the network.`));
  if (mitAnker.length) {
    // die offenen suchen jetzt vom Anker aus
    speichere();
    await suche();
    setStatus(teile.join(" "), "done");
  } else geaendert(teile.join(" "));
  return teile.join(" ");
}

$("csv-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    await uebernimmZuordnung(leseZuordnungCsv(await file.text()), file.name);
  } catch (err) {
    setStatus(`${file.name}: ${err.message}`, "error");
  }
});

// ---------- Gebiet ----------
// Nur die Stellen in einem Gebiet: auf der Karte gezeichnet oder aus einer Datei (lib/gebiet.js).
// Es gilt für Dauerzählstellen und Kurzzeitzählungen, über ihre eigene Lage; der Browser merkt es
// sich, die Konfiguration trägt es, die counts.xml nennt es.
const gebietCache = new Map(); // „d:“ oder „k:“ + ID der Stelle -> im Gebiet?
let gebietHinweis = "";
let ziehen = null; // { i, ring }, solange eine Ecke gezogen wird
let gezogen = 0;

function inGebiet(schluessel, lon, lat) {
  if (!state.gebiet) return true;
  let r = gebietCache.get(schluessel);
  if (r === undefined) gebietCache.set(schluessel, (r = punktImGebiet(state.gebiet, lon, lat)));
  return r;
}

/** Ein Gebiet aus dem GeoJSON-Feature der Konfiguration oder des Browsers, so wie es war (nicht neu vereinfacht). */
function gebietAusFeature(f) {
  const p = f?.properties ?? {};
  return baueGebiet({ name: p.name ?? "Gebiet", art: p.art === "gezeichnet" ? "gezeichnet" : "datei", datei: p.datei ?? null, polygone: leseGeojson(f).polygone, vereinfachen: false });
}

// Der Name geht in counts.xml und Konfiguration und bleibt darum deutsch; die Oberfläche übersetzt ihn
const GEZEICHNET = "Gezeichnetes Gebiet";
const gebietName = (g) => (g.name === GEZEICHNET ? tx(GEZEICHNET, "Drawn area") : g.name);
const gebietEditierbar = () => !state.zeichnen && state.gebiet?.art === "gezeichnet" && state.gebiet.polygone.length === 1 && state.gebiet.polygone[0].length === 1;
const gebietText = () => {
  const g = state.gebiet;
  // geht in die Ausgaben: deutsch in jeder Sprache der Oberfläche
  return g ? `${g.name} (${g.art === "gezeichnet" ? "gezeichnet" : g.datei ?? "Datei"}), ${nrAusgabe(g.flaeche_km2, 1)} km²; nur Stellen darin` : null;
};

/** Das Gebiet setzen oder mit null aufheben: merken, zeichnen und die Stellen neu wählen. */
function setzeGebiet(g, { hinweis = "", einpassen = false, waehlen = true } = {}) {
  state.gebiet = g;
  gebietHinweis = hinweis;
  gebietCache.clear();
  store.set("snapper.gebiet", JSON.stringify(g ? gebietGeojson(g) : null));
  zeichneGebiet();
  renderGebiet();
  if (g && einpassen) map.fitBounds([[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]], { padding: 40, duration: 0, maxZoom: 15 });
  if (waehlen && state.netz) waehleStellen();
  else renderDatenText();
}

const WELT = [[-179.9, -85], [179.9, -85], [179.9, 85], [-179.9, 85], [-179.9, -85]];
const zu = (r) => [...r, r[0]];
/** Ring mit gewünschtem Umlaufsinn: Ein Loch muss andersherum laufen als sein Rand, sonst füllt die Karte es. */
function umlauf(ring, gegenUhr) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return (a > 0) === gegenUhr ? ring : [...ring].reverse();
}

/** Gebiet auf der Karte: draußen abgedunkelt, der Rand, die Ecken; beim Zeichnen der Entwurf. `ring` beim Ziehen einer Ecke. */
function zeichneGebiet(ring = null) {
  if (!styleReady) return;
  const z = state.zeichnen;
  const g = state.gebiet;
  const features = [];
  const ecken = [];
  const punkt = (p, i, erste = 0) => ({ type: "Feature", properties: { i, erste }, geometry: { type: "Point", coordinates: p } });
  if (z) {
    const linie = [...z.punkte, ...(z.zeiger ? [z.zeiger] : [])];
    if (linie.length >= 2) features.push({ type: "Feature", properties: { art: "entwurf" }, geometry: { type: "LineString", coordinates: linie } });
    z.punkte.forEach((p, i) => ecken.push(punkt(p, i, i === 0 && z.punkte.length >= 3 ? 1 : 0)));
  } else if (g) {
    const polygone = ring ? [[ring]] : g.polygone;
    features.push({ type: "Feature", properties: { art: "maske" }, geometry: { type: "Polygon", coordinates: [umlauf(WELT, true), ...polygone.map(([a]) => umlauf(zu(a), false))] } });
    for (const [, ...loecher] of polygone) for (const l of loecher) features.push({ type: "Feature", properties: { art: "maske" }, geometry: { type: "Polygon", coordinates: [umlauf(zu(l), true)] } });
    for (const p of polygone) for (const r of p) features.push({ type: "Feature", properties: { art: "rand" }, geometry: { type: "LineString", coordinates: zu(r) } });
    if (gebietEditierbar()) (ring ?? g.polygone[0][0]).forEach((p, i) => ecken.push(punkt(p, i)));
  }
  setzeDaten("gebiet", { type: "FeatureCollection", features });
  setzeDaten("gebiet-ecken", { type: "FeatureCollection", features: ecken });
}

function renderGebiet() {
  const g = state.gebiet;
  const z = state.zeichnen;
  $("gebiet-zeichnen").textContent = z ? tx("Zeichnen abbrechen", "Cancel drawing") : g ? tx("Neu zeichnen", "Redraw") : tx("Zeichnen", "Draw");
  $("gebiet-zeichnen").setAttribute("aria-pressed", String(Boolean(z)));
  $("gebiet-weg").hidden = !g || Boolean(z);
  $("gebiet-zeigen").hidden = !g || Boolean(z);
  const t = $("gebiet-text");
  if (z) {
    t.textContent = tx(
      `${anzahl(z.punkte.length, "Ecke", "Ecken")} gesetzt. ${z.punkte.length >= 3 ? "Doppelklick, Enter oder ein Klick auf die erste Ecke schließt das Gebiet." : "Klicke die Ecken des Gebiets auf der Karte."}`,
      `${anzahl(z.punkte.length, "corner", "corners")} set. ${z.punkte.length >= 3 ? "Double-click, Enter or a click on the first corner closes the area." : "Click the corners of the area on the map."}`,
    );
    return;
  }
  if (!g) {
    t.innerHTML = tx(
      "Es zählen alle Stellen im Rechteck um die Links des Netzes. Ein Gebiet lässt sich auf der Karte zeichnen oder laden: GeoJSON, <code>.poly</code> wie für <code>osmium extract -p</code> oder ein Shapefile, gezippt oder als <code>.shp</code> mit <code>.prj</code>.",
      "All sites in the rectangle around the network's links count. An area can be drawn on the map or loaded: GeoJSON, <code>.poly</code> as for <code>osmium extract -p</code>, or a shapefile, zipped or as <code>.shp</code> with <code>.prj</code>.",
    );
    return;
  }
  const bbox = state.netz?.info?.bbox;
  const draussen = bbox && !ueberschneidet(g, bbox);
  const wie = g.art === "gezeichnet" ? tx("gezeichnet", "drawn") : tx(`aus ${esc(g.datei ?? "einer Datei")}`, `from ${esc(g.datei ?? "a file")}`);
  const flaechen = g.polygone.length > 1 ? `${tx(anzahl(g.polygone.length, "Fläche", "Flächen"), anzahl(g.polygone.length, "polygon", "polygons"))}, ` : "";
  const km2 = `${nr(g.flaeche_km2, g.flaeche_km2 < 10 ? 1 : 0)} km²`;
  t.innerHTML = tx(
    `<strong>${esc(gebietName(g))}</strong> (${wie}): ${flaechen}${km2}${g.vereinfacht ? `, auf ${nr(VEREINFACHT_M)} m genau vereinfacht (${nr(g.punkte)} Punkte)` : ""}. Es zählen nur die Stellen darin.${gebietEditierbar() ? " Die Ecken lassen sich auf der Karte verschieben." : ""}${gebietHinweis ? ` ${esc(gebietHinweis)}` : ""}${draussen ? " <strong>Das Gebiet liegt nicht im Netz.</strong>" : ""}`,
    `<strong>${esc(gebietName(g))}</strong> (${wie}): ${flaechen}${km2}${g.vereinfacht ? `, simplified to ${nr(VEREINFACHT_M)} m (${nr(g.punkte)} points)` : ""}. Only the sites inside count.${gebietEditierbar() ? " The corners can be moved on the map." : ""}${gebietHinweis ? ` ${esc(gebietHinweis)}` : ""}${draussen ? " <strong>The area is not within the network.</strong>" : ""}`,
  );
}

function zeichneStart() {
  pickEnde();
  popup?.remove();
  state.zeichnen = { punkte: [], zeiger: null };
  mapwrap.classList.add("zeichnen");
  $("gebiethint").hidden = false;
  map.doubleClickZoom.disable();
  zeichneGebiet();
  renderGebiet();
}

function zeichneEnde(fertig) {
  const z = state.zeichnen;
  if (!z) return;
  state.zeichnen = null;
  mapwrap.classList.remove("zeichnen");
  $("gebiethint").hidden = true;
  // erst nach dem Doppelklick, der das Gebiet schließt, wieder mit Doppelklick zoomen
  setTimeout(() => map.doubleClickZoom.enable(), 0);
  if (fertig && z.punkte.length >= 3) {
    try {
      return setzeGebiet(baueGebiet({ name: GEZEICHNET, art: "gezeichnet", polygone: [[z.punkte]] }));
    } catch (err) {
      setStatus(tx(`Gebiet: ${err.message}`, `Area: ${err.message}`), "error");
    }
  }
  zeichneGebiet();
  renderGebiet();
}

/** Ein Klick beim Zeichnen: eine Ecke mehr; auf der ersten Ecke schließt er das Gebiet. */
function zeichnePunkt(e) {
  const z = state.zeichnen;
  const nah = (p, px) => {
    const q = map.project(p);
    return Math.hypot(q.x - e.point.x, q.y - e.point.y) < px;
  };
  // der zweite Klick eines Doppelklicks setzt keine Ecke
  if (z.punkte.length && nah(z.punkte[z.punkte.length - 1], 4)) return;
  if (z.punkte.length >= 3 && nah(z.punkte[0], 10)) return zeichneEnde(true);
  z.punkte.push([e.lngLat.lng, e.lngLat.lat]);
  zeichneGebiet();
  renderGebiet();
}

map.on("dblclick", (e) => {
  if (!state.zeichnen) return;
  e.preventDefault();
  zeichneEnde(true);
});
// eine Ecke eines gezeichneten Gebiets ziehen
map.on("mousedown", "gebiet-ecken", (e) => {
  if (!gebietEditierbar() || !e.features?.length) return;
  e.preventDefault();
  ziehen = { i: e.features[0].properties.i, ring: state.gebiet.polygone[0][0].map((p) => [...p]) };
  map.getCanvas().style.cursor = "grabbing";
});
map.on("mouseup", () => {
  if (!ziehen) return;
  const { ring } = ziehen;
  ziehen = null;
  gezogen = Date.now();
  map.getCanvas().style.cursor = "";
  try {
    setzeGebiet(baueGebiet({ name: state.gebiet.name, art: "gezeichnet", polygone: [[ring]] }));
  } catch (err) {
    setStatus(tx(`Gebiet: ${err.message}`, `Area: ${err.message}`), "error");
    zeichneGebiet();
  }
});

/**
 * Ein Gebiet aus Dateien: GeoJSON, .poly, ein gezipptes Shapefile oder .shp mit .prj. Ohne Angabe
 * des Koordinatensystems gelten Grad als WGS 84, sonst das CRS des Netzes (oder des Formulars). -> ok
 */
async function nimmGebietDateien(files, { waehlen = true } = {}) {
  const endet = (f, ...e) => e.some((x) => f.name.toLowerCase().endsWith(x));
  const stammVon = (n) => n.split("/").pop().replace(/\.[^.]+$/, "");
  const zip = files.find((f) => endet(f, ".zip"));
  const shp = files.find((f) => endet(f, ".shp"));
  const poly = files.find((f) => endet(f, ".poly"));
  const json = files.find((f) => endet(f, ".geojson", ".json"));
  const datei = (zip ?? shp ?? poly ?? json)?.name ?? files[0]?.name ?? "Gebiet";
  try {
    let polygone;
    let crs = null;
    let name;
    if (zip) {
      const dateien = await leseZip(new Uint8Array(await zip.arrayBuffer()), (n) => /\.(shp|prj)$/i.test(n));
      const shpName = [...dateien.keys()].find((n) => /\.shp$/i.test(n));
      if (!shpName) throw new Error(tx("In der ZIP-Datei ist kein Shapefile (.shp).", "There is no shapefile (.shp) in the ZIP file."));
      polygone = leseShp(dateien.get(shpName));
      const prj = dateien.get(shpName.replace(/\.shp$/i, ".prj")) ?? [...dateien].find(([n]) => /\.prj$/i.test(n))?.[1];
      crs = prj ? crsAusPrj(new TextDecoder().decode(prj)) : null;
      name = stammVon(shpName);
    } else if (shp) {
      polygone = leseShp(new Uint8Array(await shp.arrayBuffer()));
      const prj = files.find((f) => endet(f, ".prj"));
      crs = prj ? crsAusPrj(await prj.text()) : null;
      name = stammVon(shp.name);
    } else if (poly) {
      const r = lesePoly(await poly.text());
      polygone = r.polygone;
      name = r.name;
    } else if (json) {
      let roh;
      try {
        roh = JSON.parse(await json.text());
      } catch {
        throw new Error(tx("Die Datei ist kein JSON.", "The file is not JSON."));
      }
      const r = leseGeojson(roh);
      polygone = r.polygone;
      crs = r.crs;
      name = r.name ?? stammVon(json.name);
    } else {
      throw new Error(tx("Erwartet wird GeoJSON, eine .poly-Datei oder ein Shapefile (.zip oder .shp mit .prj).", "Expected GeoJSON, a .poly file or a shapefile (.zip, or .shp with .prj)."));
    }
    if (!polygone.length) throw new Error(tx("Darin ist keine Fläche.", "It contains no polygon."));
    let hinweis = "";
    if (crs && /^EPSG:4326$/i.test(crs)) crs = null;
    if (crs || !siehtNachGradAus(polygone)) {
      if (!crs) {
        crs = state.netz?.info?.osm ? $("crs").value.trim() : state.netz?.info?.crs ?? $("crs").value.trim();
        hinweis = tx(`Die Datei nennt kein Koordinatensystem; gelesen als ${crs}.`, `The file names no coordinate system; read as ${crs}.`);
      }
      const { projektion } = await import("./lib/crs.js");
      let p;
      try {
        p = projektion(crs);
      } catch (err) {
        throw new Error(tx(`Das Koordinatensystem der Datei kennt die Seite nicht (${err.message})`, `The page does not know the file's coordinate system (${err.message})`));
      }
      polygone = umrechnen(polygone, p.zuWgs);
    }
    const g = baueGebiet({ name, art: "datei", datei, polygone });
    setzeGebiet(g, { hinweis, einpassen: true, waehlen });
    return true;
  } catch (err) {
    setStatus(tx(`Gebiet aus ${datei}: ${err.message}`, `Area from ${datei}: ${err.message}`), "error");
    return false;
  }
}

$("gebiet-zeichnen").addEventListener("click", () => (state.zeichnen ? zeichneEnde(false) : zeichneStart()));
$("gebiet-weg").addEventListener("click", () => setzeGebiet(null));
$("gebiet-zeigen").addEventListener("click", () => {
  const g = state.gebiet;
  if (g) map.fitBounds([[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]], { padding: 40, duration: 400, maxZoom: 15 });
});
$("gebiet-file").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) nimmGebietDateien(files);
});

// ---------- Konfiguration ----------
// Mit welchem Netz und welchen Daten gearbeitet wurde, alle Einstellungen und die Entscheidungen
// von Hand, als JSON (lib/konfig.js). Wieder eingelesen gelten ihre Einstellungen, und die
// Entscheidungen gehen wie die Zuordnungs-CSV über den Anker auf das geladene Netz.
let ausstehend = null; // Entscheidungen einer eingelesenen Konfiguration, bis ein Netz mit Stellen da ist

function einstellungenJetzt() {
  leseMittelForm();
  const m = state.mittel;
  const k = state.kurz.opts;
  return {
    crs: $("crs").value.trim(),
    osm_filter: $("osm-filter").value,
    gebiet: state.gebiet ? gebietGeojson(state.gebiet) : null,
    suche: { radius_m: Number($("radius").value) || 50, max_winkel_grad: Number($("winkel").value) || 60, nur_ziel_mitnehmen: $("ohne-kompass").checked },
    gruppen: Object.fromEntries(GRUPPEN.map((g) => [g, { an: state.gruppen[g].an, network_mode: state.gruppen[g].mode, link_erlaubt: state.gruppen[g].link }])),
    kurzzeit: { an: state.kurz.an, von_jahr: k.vonJahr, bis_jahr: k.bisJahr, wochentage: k.wochentage, tage: k.tage, gruppen: k.gruppen, min_stunden: k.minStunden, arm_abstand_m: k.abstand, lieferungen: k.lieferungen ?? {} },
    mitteln: { wochentage: m.wochentage, von: m.von != null ? isoTag(m.von) : null, bis: m.bis != null ? isoTag(m.bis) : null, tagesarten: m.tagesarten, statistik: m.statistik, min_tage: m.minTage, nur_vollstaendig: m.nurVollstaendig },
    ausgabe: { name: $("counts-name").value.trim() || null, jahr: Number($("jahr").value) || null, nur_gepruefte: $("nur-geprueft").checked },
  };
}

function netzJetzt() {
  const n = state.netz;
  if (!n) return null;
  const i = n.info ?? {};
  return {
    name: n.beispiel ? BEISPIEL.name : n.name,
    url: n.beispiel ? BEISPIEL.url : n.url ?? null,
    beispiel: Boolean(n.beispiel),
    geometrien: n.geoName ?? null,
    geometrien_url: n.geoUrl ?? null,
    art: i.osm ? "osm" : "matsim",
    osm_filter: i.osm?.filterCode ?? null,
    crs: i.crs ?? null,
    crs_aus_datei: Boolean(i.crsAusDatei),
    links: i.links ?? null,
    gebiet: i.bbox ? i.bbox.map((x) => Math.round(x * 1e5) / 1e5) : null,
  };
}

const LAGE_JSON = { passt: "passt", pruefen: "zum_pruefen", geprueft: "geprueft", aus: "ausgelassen", ohne: "ohne_link" };

/** Wie viele Stellen je Familie wo stehen und wie viele in die Ausgabe gehen. */
function ergebnisJetzt() {
  const je = (familie) => {
    const liste = state.stellen.filter((s) => familieVon(s) === familie);
    const lagen = Object.fromEntries(Object.values(LAGE_JSON).map((l) => [l, 0]));
    for (const s of liste) lagen[LAGE_JSON[lageVon(s)]]++;
    return { stellen: liste.length, mit_link: liste.filter((s) => linkVon(s)).length, in_ausgabe: genutzteStellen(familie).length, ...lagen };
  };
  const b = state.bereich;
  const g = state.gebiet;
  return {
    netzgebiet: b ? { dauerzaehlstellen: b.imNetz, quellen: b.quellenNetz } : null,
    gebiet: b && g ? { name: g.name, flaeche_km2: Math.round(g.flaeche_km2 * 100) / 100, dauerzaehlstellen: b.imGebiet, quellen: b.quellen } : null,
    dauer: je("dauer"),
    kurzzeit: state.kurz.an ? je("kurz") : null,
    nur_angezeigt: state.stellen.filter((s) => familieVon(s) === "quer").length,
  };
}

const lizenzJson = (l) => Object.fromEntries(Object.entries({ titel: l.titel, lizenz: l.lizenz, herausgeber: l.herausgeber, url: l.url }).filter(([, v]) => v));

/** Die Quellen der Stellen, die in die Ausgabe gehen, mit ihren Lizenzen (wie unter Schritt 5). */
function quellenJetzt() {
  const d = state.daten;
  const liste = [...new Set(genutzteStellen("dauer").map((s) => s.quelle))].map((c) => d?.quellen.get(c)).filter(Boolean)
    .map((q) => ({ zaehlart: "dauer", code: q.code, name: q.name, lizenzen: q.lizenzen.map(lizenzJson), quellenvermerk: q.quellenvermerk ?? null }));
  for (const { quelle, lizenzen } of kurzLizenzen(genutzteStellen("kurz"))) liste.push({ zaehlart: "kurzzeit", code: quelle.code, name: quelle.name, lizenzen: lizenzen.map(lizenzJson), quellenvermerk: null });
  return liste;
}

/** Die Entscheidungen von Hand: geprüft (mit Anker), ausgelassen, Kommentare; dazu die gespeicherten außerhalb der Auswahl. */
function entscheidungenJetzt() {
  const liste = [];
  for (const s of state.stellen) {
    if (familieVon(s) === "quer") continue;
    const e = state.entscheid.get(s.id);
    if (!e || (!e.link && !e.aus && !e.kommentar)) continue;
    const link = e.aus ? null : e.link;
    liste.push(konfigEntscheidung({
      station: s.id,
      zaehlart: familieVon(s) === "kurz" ? "kurzzeit" : "dauer",
      zuordnung: e.aus ? "ausgelassen" : link ? "geprüft" : "automatisch",
      linkid: link?.id ?? null,
      kommentar: e.kommentar,
      anker: link ? ankerVon(s) : null,
      osmWeg: link?.weg ?? null,
      name: s.name,
      richtung: s.richtungText || "", // die Konfiguration bleibt in jeder Sprache gleich
      uebernommen: link && e.uebernommen ? { wie: e.uebernommen.wie, netz: e.uebernommen.netz } : null,
    }));
  }
  // für dieses Netz gespeichert, aber gerade nicht in der Auswahl (etwa eine abgewählte Gruppe)
  for (const [id, roh] of Object.entries(gespeichert)) {
    if (state.byId.has(id) || (!roh.link && !roh.aus && !roh.kommentar)) continue;
    liste.push(konfigEntscheidung({ station: id, zaehlart: familieVonId(id) === "kurz" ? "kurzzeit" : "dauer", zuordnung: roh.aus ? "ausgelassen" : roh.link ? "geprüft" : "automatisch", linkid: roh.link, kommentar: roh.kommentar, inAuswahl: false }));
  }
  return liste;
}

function konfigurationJetzt() {
  const d = state.daten;
  const km = state.kurz.manifest;
  return baueKonfiguration({
    seite: `${location.origin}${location.pathname}`,
    netz: netzJetzt(),
    daten: {
      adresse: DATEN,
      dauer: d ? { erzeugt: d.erzeugt, version: d.version } : null,
      kurzzeit: state.kurz.an && km ? { erzeugt: km.erzeugt ?? null, stroeme_version: STROEME_VERTRAG } : null,
    },
    einstellungen: einstellungenJetzt(),
    ergebnis: ergebnisJetzt(),
    quellen: quellenJetzt(),
    entscheidungen: entscheidungenJetzt(),
  });
}

$("konfig-json").addEventListener("click", () => {
  const k = konfigurationJetzt();
  speichern(`${stamm()}-snapper-konfiguration.json`, `${JSON.stringify(k, null, 2)}\n`, "application/json");
  const hand = k.entscheidungen.filter((e) => e.zuordnung !== "automatisch").length;
  const kommentare = k.entscheidungen.length - hand;
  setStatus(() => tx(
    `Konfiguration gespeichert: Netz, Datenstand, Einstellungen und ${anzahl(hand, "Entscheidung", "Entscheidungen")} von Hand${kommentare ? `, dazu ${anzahl(kommentare, "Kommentar", "Kommentare")}` : ""}.`,
    `Configuration saved: network, data version, settings and ${anzahl(hand, "decision", "decisions")} by hand${kommentare ? `, plus ${anzahl(kommentare, "comment", "comments")}` : ""}.`,
  ), "done");
});

/** Dasselbe Netz: gleicher Name und gleich viele Links. */
const gleichesNetz = (a, b) => Boolean(a && b) && a.name === b.name && a.links === b.links;

/**
 * Die Einstellungen einer Konfiguration ins Formular und in den Zustand; was fehlt, bleibt, wie es
 * ist. Das CRS gehört zu ihrem Netz und gilt nur mit `crs`, der OSM-Filter nur mit `osm`.
 */
function wendeEinstellungenAn(e, { crs = true, osm = true } = {}) {
  const zahl = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const tage = (liste) => liste.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
  if (crs && typeof e.crs === "string" && e.crs.trim()) $("crs").value = e.crs.trim();
  if (osm && e.osm_filter && OSM_FILTER[e.osm_filter]) {
    $("osm-filter").value = e.osm_filter;
    store.set("snapper.osmFilter", e.osm_filter);
    $("osm-filter-text").textContent = OSM_FILTER[e.osm_filter].text ?? "";
  }
  // ohne den Eintrag stammt die Konfiguration aus der Zeit vor dem Gebiet und galt fürs ganze Netz
  let g = null;
  try {
    g = e.gebiet ? gebietAusFeature(e.gebiet) : null;
  } catch {
    g = null;
  }
  setzeGebiet(g, { waehlen: false, hinweis: e.gebiet && !g ? tx("Das Gebiet der Konfiguration ließ sich nicht lesen; es gilt das ganze Netz.", "The configuration's area could not be read; the whole network applies.") : "" });
  if (e.suche) {
    if (zahl(e.suche.radius_m)) $("radius").value = String(zahl(e.suche.radius_m));
    if (zahl(e.suche.max_winkel_grad)) $("winkel").value = String(zahl(e.suche.max_winkel_grad));
    if (typeof e.suche.nur_ziel_mitnehmen === "boolean") $("ohne-kompass").checked = e.suche.nur_ziel_mitnehmen;
  }
  for (const [g, c] of Object.entries(e.gruppen ?? {})) {
    if (!state.gruppen[g] || !c) continue;
    if (typeof c.an === "boolean") state.gruppen[g].an = c.an;
    if (typeof c.network_mode === "string" && c.network_mode.trim()) state.gruppen[g].mode = c.network_mode.trim();
    if (typeof c.link_erlaubt === "string" && c.link_erlaubt.trim()) state.gruppen[g].link = c.link_erlaubt.trim();
  }
  store.set("snapper.gruppen", JSON.stringify(state.gruppen));
  const k = e.kurzzeit;
  if (k) {
    const o = state.kurz.opts;
    if (typeof k.an === "boolean") state.kurz.an = k.an;
    if ("von_jahr" in k) o.vonJahr = zahl(k.von_jahr);
    if ("bis_jahr" in k) o.bisJahr = zahl(k.bis_jahr);
    if (Array.isArray(k.wochentage)) o.wochentage = tage(k.wochentage);
    if (Array.isArray(k.tage)) o.tage = k.tage.filter((x) => typeof x === "string");
    if (Array.isArray(k.gruppen)) o.gruppen = k.gruppen.filter((g) => KURZ_GRUPPEN.includes(g));
    if (zahl(k.min_stunden)) o.minStunden = Math.max(1, Math.min(24, zahl(k.min_stunden)));
    if (zahl(k.arm_abstand_m)) o.abstand = Math.max(10, Math.min(100, zahl(k.arm_abstand_m)));
    if (k.lieferungen && typeof k.lieferungen === "object") o.lieferungen = Object.fromEntries(Object.entries(k.lieferungen).filter(([, v]) => typeof v === "boolean"));
    kurzSpeichern();
    if (state.kurz.an) $("kurz").open = true;
    renderKurz();
  }
  const m = e.mitteln;
  if (m) {
    const t = state.mittel;
    if (Array.isArray(m.wochentage)) t.wochentage = tage(m.wochentage);
    const tag = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
    if ("von" in m) $("von").value = tag(m.von);
    if ("bis" in m) $("bis").value = tag(m.bis);
    if (Array.isArray(m.tagesarten)) for (const c of document.querySelectorAll(".tagesart")) c.checked = m.tagesarten.includes(c.value);
    if (m.statistik === "mittel" || m.statistik === "median") {
      t.statistik = m.statistik;
      for (const x of $("statistik").querySelectorAll("button")) x.setAttribute("aria-checked", String(x.value === m.statistik));
    }
    if (zahl(m.min_tage)) $("min-tage").value = String(Math.max(1, zahl(m.min_tage)));
    if (typeof m.nur_vollstaendig === "boolean") $("vollstaendig").checked = m.nur_vollstaendig;
    leseMittelForm();
    renderMittelRahmen();
  }
  const a = e.ausgabe;
  if (a) {
    if ("name" in a) $("counts-name").value = typeof a.name === "string" ? a.name : "";
    if (zahl(a.jahr)) $("jahr").value = String(zahl(a.jahr));
    if (typeof a.nur_gepruefte === "boolean") $("nur-geprueft").checked = a.nur_gepruefte;
  }
  renderGruppen();
}

/** Nach dem Wählen der Stellen: die Entscheidungen einer eingelesenen Konfiguration übernehmen. */
async function uebernimmAusstehende() {
  if (!ausstehend || !state.netz || !state.stellen.length) return;
  const a = ausstehend;
  ausstehend = null;
  const gleich = gleichesNetz(a.netz, netzJetzt());
  // gespeicherte Entscheidungen außerhalb der Auswahl tragen nur eine Link-ID: nur im selben Netz
  let gemerkt = 0;
  if (a.weitere.length && gleich) {
    for (const e of a.weitere) {
      if (gespeichert[e.station]) continue;
      gespeichert[e.station] = { link: e.linkid ?? null, aus: e.zuordnung === "ausgelassen", kommentar: e.kommentar ?? "", anker: null, uebernommen: null };
      gemerkt++;
    }
    const key = speicherSchluessel();
    if (gemerkt && key) store.set(key, JSON.stringify(gespeichert));
  }
  const teile = [a.zeilen.length ? await uebernimmZuordnung(a.zeilen, a.name, tx("Einstellungen übernommen.", "Settings applied.")) : tx(`${a.name}: Einstellungen übernommen, keine Entscheidungen von Hand.`, `${a.name}: settings applied, no decisions by hand.`)];
  if (gemerkt) teile.push(tx(`${anzahl(gemerkt, "weitere Entscheidung", "weitere Entscheidungen")} für Stellen außerhalb der Auswahl gemerkt.`, `${anzahl(gemerkt, "further decision", "further decisions")} kept for sites outside the selection.`));
  if (a.netz?.name && !gleich) teile.push(tx(`Die Konfiguration stammt von ${a.netz.name}${a.netz.art === "osm" ? " (OSM-Auszug)" : ""}.`, `The configuration comes from ${a.netz.name}${a.netz.art === "osm" ? " (OSM extract)" : ""}.`));
  setStatus(teile.join(" "), "done");
}

/**
 * Eine Konfiguration einlesen: Einstellungen übernehmen und die Entscheidungen merken, bis Stellen
 * da sind. Ohne Netz lädt sie das ihre, wenn es eine Adresse hat; mit `netzDabei` kommt es mit.
 */
async function nimmKonfiguration(file, netzDabei = false) {
  let k;
  try {
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch {
      throw new Error(tx("Die Datei ist kein JSON.", "The file is not JSON."));
    }
    if (!json?.format && ["FeatureCollection", "Feature", "Polygon", "MultiPolygon", "GeometryCollection"].includes(json?.type)) return nimmGebietDateien([file], { waehlen: !netzDabei });
    k = leseKonfiguration(json);
  } catch (err) {
    setStatus(`${file.name}: ${err.message}`, "error");
    return false;
  }
  const n = state.netz;
  const kn = k.netz;
  // Das CRS gehört zum Netz: Es gilt nur für das Netz der Konfiguration und nur, wenn es dort aus
  // dem Formular kam. Den OSM-Filter hat nur eine Sitzung mit OSM-Auszug benutzt.
  // Das Beispiel hat sein eigenes, und ältere Konfigurationen mit dem Beispiel tragen es noch im Formular.
  const crs = kn?.art !== "osm" && !kn?.crs_aus_datei && !kn?.beispiel && (!n || netzDabei || gleichesNetz(kn, netzJetzt()));
  const osm = !kn || kn.art === "osm";
  const vorher = { crs: $("crs").value.trim(), osm: $("osm-filter").value };
  wendeEinstellungenAn(k.einstellungen, { crs, osm });
  ausstehend = { zeilen: k.zeilen, weitere: k.weitere, netz: kn, name: file.name };
  if (netzDabei) return true;
  if (n) {
    // ein anderes CRS oder ein anderer OSM-Filter wirkt erst, wenn das Netz neu gelesen ist
    const neuLesen = n.info?.osm ? $("osm-filter").value !== vorher.osm : !crsFest(n.info) && $("crs").value.trim() !== vorher.crs;
    if (neuLesen) await nochmal();
    else await waehleStellen();
  } else if (k.netz?.beispiel) {
    await ladeNetzVonUrl({ net: BEISPIEL.url, beispiel: true });
  } else if (k.netz?.url) {
    setStatus(tx(`${file.name}: Einstellungen übernommen, ${k.netz.name ?? "das Netz"} wird geladen …`, `${file.name}: settings applied, loading ${k.netz.name ?? "the network"} …`), "busy");
    await ladeNetzVonUrl({ net: k.netz.url, geo: k.netz.geometrien_url ?? (k.netz.geometrien ? "auto" : "0") });
  } else {
    setStatus(() => {
      if (sprache() === "de") {
        const wo = k.netz?.name ? ` (in der Konfiguration: ${k.netz.name})` : "";
        return `${file.name}: Einstellungen übernommen. ${k.zeilen.length ? `${k.zeilen.length === 1 ? "Die Entscheidung kommt" : `Die ${nr(k.zeilen.length)} Entscheidungen kommen`}, sobald ein Netz geladen ist${wo}.` : `Jetzt ein Netz laden${wo}.`}`;
      }
      const wo = k.netz?.name ? ` (in the configuration: ${k.netz.name})` : "";
      return `${file.name}: settings applied. ${k.zeilen.length ? `${k.zeilen.length === 1 ? "The decision is applied" : `The ${nr(k.zeilen.length)} decisions are applied`} once a network is loaded${wo}.` : `Now load a network${wo}.`}`;
    }, "idle");
  }
  return true;
}

$("konfig-file").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (file) nimmKonfiguration(file);
});

// ---------- Sprache ----------
// Feste Texte stehen in index.html in beiden Sprachen (data-en, data-de; das CSS zeigt die der Seite),
// übersetzte Attribute als data-de-title & Co. Was app.js schreibt, zeichnet renderSprache neu.
const SPRACH_ATTRIBUTE = ["title", "aria-label", "placeholder", "content"];
function attributeSprache() {
  for (const a of SPRACH_ATTRIBUTE) {
    for (const el of document.querySelectorAll(`[data-de-${a}]`)) {
      if (!el.hasAttribute(`data-en-${a}`)) el.setAttribute(`data-en-${a}`, el.getAttribute(a) ?? "");
      el.setAttribute(a, el.getAttribute(`data-${sprache()}-${a}`));
    }
  }
}
function renderSprachwahl() {
  for (const b of $("sprache").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.value === sprache()));
}
/** Nach dem Wechsel: alles, was app.js geschrieben hat, in der neuen Sprache; nichts wird neu geladen. */
function renderSprache() {
  document.documentElement.lang = sprache();
  attributeSprache();
  renderSprachwahl();
  renderOsmFilter();
  renderQuelle(state.netz);
  renderKurz();
  renderGebiet();
  renderMittelRahmen();
  mittleAlle();
  renderAuswahl();
  renderGruppen();
  renderAlles();
  if (svn.url) renderSvn();
  if (!$("basemap-error").hidden) basemapNichtDa();
  popup?.remove();
  if (letzterStatus) setStatus(letzterStatus.text, letzterStatus.kind, letzterStatus.pct);
  updateLink();
}
$("sprache").addEventListener("click", (e) => {
  const b = e.target.closest("button[value]");
  if (!b || b.value === sprache()) return;
  setzeSprache(b.value);
  store.set("snapper.sprache", sprache());
  renderSprache();
});

// ---------- Start ----------
attributeSprache();
renderSprachwahl();
try {
  const g = JSON.parse(store.get("snapper.gruppen") ?? "null");
  if (g) for (const k of GRUPPEN) if (g[k]) Object.assign(state.gruppen[k], g[k]);
} catch { /* Vorgabe */ }
try {
  const k = JSON.parse(store.get("snapper.kurz") ?? "null");
  if (k) {
    state.kurz.an = Boolean(k.an);
    for (const key of Object.keys(KURZ_VORGABE)) if (k.opts?.[key] !== undefined) state.kurz.opts[key] = k.opts[key];
    state.kurz.opts.gruppen = state.kurz.opts.gruppen.filter((g) => KURZ_GRUPPEN.includes(g));
    if (k.opts?.lieferungen && typeof k.opts.lieferungen === "object") state.kurz.opts.lieferungen = { ...k.opts.lieferungen };
  }
} catch { /* Vorgabe */ }
try {
  const f = JSON.parse(store.get("snapper.gebiet") ?? "null");
  if (f) state.gebiet = gebietAusFeature(f);
} catch { /* ohne Gebiet */ }
renderGebiet();
renderMittelRahmen();
renderKurz();
ladeDaten();
if (state.kurz.an) {
  $("kurz").open = true;
  ladeKurz().then(renderKurz);
}
const netParam = params.get("net");
if (params.get("crs")) $("crs").value = params.get("crs");
if (netParam) {
  let url;
  try {
    url = new URL(netParam, SVN_ROOT).href;
  } catch {
    url = null;
  }
  if (url) ladeNetzVonUrl({ net: url, geo: params.get("geo") ?? "auto" });
  else setStatus(() => tx("Der Parameter net ist keine gültige Adresse.", "The net parameter is not a valid address."), "error");
} else {
  ladeNetzVonUrl({ net: BEISPIEL.url, beispiel: true });
}

// für Tests im Browser: ?debug gibt Karte und Zustand frei
if (params.has("debug")) window.snapper = { map, state, lageVon, linkVon, waehle, gruendeVon };

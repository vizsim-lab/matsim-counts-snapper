// MATSim Counts Snapper: Netz laden, Dauerzählstellen der Zählkarte auf Links legen, prüfen,
// mitteln und als counts.xml ausgeben. Das Netz liegt im Worker; hier leben Karte und Oberfläche.
// Ein Netz ist ein MATSim-Netz oder ein OSM-Auszug (.osm.pbf); aus OSM gibt es nur die Zuordnung,
// die sich mit ihrem Anker (Punkt, Richtung, OSM-Weg) auf ein MATSim-Netz übertragen lässt.
import { STANDARD_DATEN, VERTRAG, GRUPPEN, leseIndex, leseStunden, detailPfad, tagNr, isoTag } from "./lib/zaehlkarte.js";
import { kurz, lang } from "./lib/richtung.js";
import { verteile } from "./lib/zuordnung.js";
import { VORGABE as MITTEL_VORGABE, WOCHENTAGE, mittle, aggregatText, auswahlText } from "./lib/mitteln.js";
import { countsXml, zuordnungCsv, leseZuordnungCsv } from "./lib/counts.js";
import { OSM_FILTER } from "./lib/osm.js";

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const de = (n, digits = 0) => Number(n).toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const mb = (bytes) => `${de(bytes / 1048576, bytes < 10485760 ? 1 : 0)} MB`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reason = (err) => (err?.name === "TypeError" ? "nicht erreichbar oder vom Browser blockiert" : err?.message ?? String(err));
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
const LAGEN = ["pruefen", "ohne", "passt", "geprueft", "aus"];
const LAGE_TEXT = { passt: "passt", pruefen: "prüfen", geprueft: "geprüft", ohne: "ohne Link", aus: "ausgelassen" };
const LAGE_FARBE = { passt: "--st-passt", pruefen: "--st-pruefen", geprueft: "--st-geprueft", ohne: "--st-ohne", aus: "--st-aus" };
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
};

// ---------- Status ----------
function setStatus(text, kind = "busy", pct = null) {
  $("status-text").textContent = text;
  $("status").dataset.state = kind;
  const bar = $("bar");
  bar.hidden = kind !== "busy";
  bar.classList.toggle("indeterminate", pct === null);
  bar.querySelector("i").style.width = pct === null ? "" : `${Math.max(2, Math.min(100, pct))}%`;
  if (kind === "busy" || !netzLaedt) {
    $("busy").hidden = kind !== "busy";
    $("busy").textContent = text;
  } else $("busy").textContent = "Netz zeichnen …";
}

// ---------- Worker ----------
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let token = 0;
const offen = new Map();
function frage(msg, transfer = []) {
  const t = ++token;
  return new Promise((resolve, reject) => {
    offen.set(t, { resolve, reject });
    worker.postMessage({ ...msg, token: t }, transfer);
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
  for (const o of offen.values()) o.reject(new Error(e.message || "Der Worker ist abgestürzt."));
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

const EIGENE = ["kandidaten-linie", "zuordnung-linie", "zuordnung-pfeil", "schnapp-linie", "kandidaten-rang", "stellen-kreis", "stellen-pfeil"];
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
  quelle("stellen");
  const add = (layer, before) => { if (!map.getLayer(layer.id)) map.addLayer(layer, before); };
  add({ id: "kandidaten-linie", type: "line", source: "kandidaten", layout: { "line-cap": "round" }, paint: { "line-color": css("--fg"), "line-width": 2.5, "line-offset": VERSATZ, "line-dasharray": [1.2, 1.4], "line-opacity": 0.85 } });
  add({ id: "zuordnung-linie", type: "line", source: "zuordnung", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": lageFarbe(), "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, ["case", ["==", ["get", "sel"], 1], 9, 6]], "line-offset": VERSATZ, "line-opacity": 0.9 } });
  add({ id: "zuordnung-pfeil", type: "symbol", source: "zuordnung", minzoom: 13, layout: { "symbol-placement": "line", "symbol-spacing": 36, "icon-image": "pfeil", "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.35, 17, 0.6], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": halo() } });
  add({ id: "schnapp-linie", type: "line", source: "schnapp", paint: { "line-color": lageFarbe(), "line-width": 1.5, "line-dasharray": [1, 1.5] } });
  // Zahlen brauchen Glyphen; die Karte „Ohne“ hat keine, dann stehen die Ränge nur in der Tabelle
  if (map.getStyle().glyphs) add({ id: "kandidaten-rang", type: "symbol", source: "kandidaten", minzoom: 13, layout: { "symbol-placement": "line-center", "text-field": ["to-string", ["get", "rang"]], "text-size": 13, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true }, paint: { "text-color": css("--fg"), "text-halo-color": halo(), "text-halo-width": 2.5 } });
  add({ id: "stellen-kreis", type: "circle", source: "stellen", paint: { "circle-color": lageFarbe(), "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, ["case", ["==", ["get", "sel"], 1], 6, 3.5], 15, ["case", ["==", ["get", "sel"], 1], 11, 7]], "circle-stroke-color": ["case", ["==", ["get", "sel"], 1], css("--fg"), halo()], "circle-stroke-width": ["case", ["==", ["get", "sel"], 1], 2.5, 1.2] } });
  add({ id: "stellen-pfeil", type: "symbol", source: "stellen", minzoom: 12, filter: [">=", ["get", "grad"], 0], layout: { "icon-image": "nord", "icon-rotate": ["get", "grad"], "icon-rotation-alignment": "map", "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.3, 16, 0.5], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": "#ffffff" } });
  zeichneDaten();
}

/** Solange MapLibre das Netz aufbereitet, sagt die Karte es; bei großen Netzen dauert das. */
let netzLaedt = false;
function netzZeichnen(an) {
  netzLaedt = an;
  if (an) {
    $("busy").textContent = "Netz zeichnen …";
    $("busy").hidden = false;
  } else if ($("status").dataset.state !== "busy") $("busy").hidden = true;
}
map.on("sourcedata", (e) => {
  if (netzLaedt && e.sourceId === "netz" && map.isSourceLoaded("netz")) netzZeichnen(false);
});

function setzeDaten(id, fc) {
  map.getSource(id)?.setData(fc);
}

/** Die Stellen, ihre Links und die Kandidaten der gewählten Stelle als GeoJSON. */
function zeichneDaten() {
  if (!styleReady) return;
  const stellen = [];
  const zuordnung = [];
  const schnapp = [];
  for (const s of state.stellen) {
    const lage = lageVon(s);
    const sel = s.id === state.auswahl ? 1 : 0;
    stellen.push({ type: "Feature", properties: { id: s.id, lage, sel, grad: s.r.grad ?? -1 }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } });
    const link = lage === "aus" ? null : linkVon(s);
    if (link?.geom?.length >= 2) {
      zuordnung.push({ type: "Feature", properties: { stelle: s.id, lage, sel }, geometry: { type: "LineString", coordinates: link.geom } });
      const p = naechsterPunktWgs(s.lon, s.lat, link.geom);
      if (p) schnapp.push({ type: "Feature", properties: { lage }, geometry: { type: "LineString", coordinates: [[s.lon, s.lat], p] } });
    }
  }
  // die gewählte Stelle zuletzt, damit sie oben liegt
  stellen.sort((a, b) => a.properties.sel - b.properties.sel);
  zuordnung.sort((a, b) => a.properties.sel - b.properties.sel);
  setzeDaten("stellen", { type: "FeatureCollection", features: stellen });
  setzeDaten("zuordnung", { type: "FeatureCollection", features: zuordnung });
  setzeDaten("schnapp", { type: "FeatureCollection", features: schnapp });
  const s = state.byId.get(state.auswahl);
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
  set("stellen-kreis", "circle-color", lageFarbe());
  set("stellen-kreis", "circle-stroke-color", ["case", ["==", ["get", "sel"], 1], css("--fg"), halo()]);
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
function markBasemap(name) {
  basemap = name;
  mapwrap.dataset.basemap = name;
  for (const b of $("basemap").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.value === name));
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
    $("basemap-error").textContent = "nicht erreichbar";
    $("basemap-error").hidden = false;
    style = plainStyle();
  }
  if (t !== basemapToken) return;
  styleReady = false;
  map.setStyle(style, { diff: false });
}
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
  if (!state.pick) {
    const stelle = map.getLayer("stellen-kreis") && map.queryRenderedFeatures(e.point, { layers: ["stellen-kreis"] }).length;
    map.getCanvas().style.cursor = stelle ? "pointer" : "";
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
  if (state.pick && s) div.insertAdjacentHTML("beforeend", `<p class="note" style="margin:0 0 6px">Hier liegen ${links.length} Links. Welcher gehört zu ${esc(s.name || s.id)}?</p>`);
  for (const l of links) {
    const zeilen = [
      ["Richtung", l.grad != null ? `${kurz(l.grad)} ${de(l.grad)}°${l.abweichung != null ? `, ${de(l.abweichung)}° Abweichung` : ""}` : null],
      ["Abstand", s && l.d != null ? `${de(l.d, 1)} m` : null],
      ["modes", l.modes || "(car)"], ["type", l.type], ["name", l.name],
      ["Tempo", l.kmh != null ? `${de(l.kmh, 1)} km/h` : null], ["capacity", l.capacity != null && !l.osm ? `${de(l.capacity)} Fz/h` : null],
    ].filter(([, v]) => v != null && v !== "");
    const box = document.createElement("div");
    box.className = "linkwahl-eintrag";
    box.innerHTML = `<strong>${kompassSvg(l.grad)}${l.osm ? "Kante" : "Link"} ${esc(l.id)}</strong><dl class="linkinfo">${zeilen.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}${l.weg ? `<dt>OSM-Weg</dt><dd>${wegHtml(l.weg)}</dd>` : ""}</dl>`;
    if (kannZuordnen && linkVon(s)?.id !== l.id) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn small";
      b.textContent = `${s.name || s.id} zuordnen`;
      b.addEventListener("click", () => {
        popup?.remove();
        pickEnde();
        nimmLink(s.id, { i: l.i, link: l });
      });
      box.append(b);
    } else if (kannZuordnen) box.insertAdjacentHTML("beforeend", '<span class="note">gehört schon zu dieser Stelle</span>');
    div.append(box);
  }
  popup = new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setDOMContent(div).addTo(map);
}

/** Ein OSM-Weg als Link zu openstreetmap.org; mit Minus: gegen die Zeichenrichtung. */
function wegHtml(weg) {
  if (!weg) return "";
  const id = String(weg).replace(/^-/, "");
  if (!/^\d+$/.test(id)) return esc(weg);
  return `<a href="https://www.openstreetmap.org/way/${id}" target="_blank" rel="noopener">${id}</a>${String(weg).startsWith("-") ? " (gegen die Zeichenrichtung)" : ""}`;
}

const WIE = {
  id: "gleiche Link-ID am selben Ort",
  weg: "gleicher OSM-Weg in derselben Richtung",
  lage: "einziger passender Link am übernommenen Punkt",
};

// ---------- Netz laden ----------
let laden = null;
async function fetchBytes(url, label, signal) {
  setStatus(`${label} laden …`);
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
      setStatus(`${label} laden … ${mb(got)}${known ? ` von ${mb(total)}` : ""}`, "busy", known ? (100 * got) / total : null);
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
const artVon = (name) => (/linkgeometr/i.test(name) || /\.csv(\.gz)?$/i.test(name) ? "geometrien" : /\.xml(\.gz)?$|\.pbf$/i.test(name) ? "netz" : null);
const istOsmName = (name) => /\.pbf$/i.test(name ?? "");

/** Der Szenario-Stamm eines Dateinamens, wie in kachelwerk: berlin-v7.0-10pct.output_network.xml.gz -> berlin-v7.0. */
function scenarioStem(name) {
  return name.toLowerCase().replace(/\.osm\.pbf$|\.pbf$/, "").replace(/\.(xml|csv)(\.gz)?$/, "").split(/[._-]?output_|[._-]?network|[._-]?linkgeometr/)[0].replace(/[._-]\d+(\.\d+)?pct$/, "").replace(/[._-]+$/, "");
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

async function nimmNetz({ name, bytes, geoName = null, geoBytes = null, url = null, geoUrl = null, beispiel = false, crs = null, datei = null, geoDatei = null }) {
  const nr = ++state.ladeNr;
  pickEnde();
  popup?.remove();
  state.netz = null;
  state.ergebnisse.clear();
  state.wahl.clear();
  state.stellen = [];
  state.byId.clear();
  state.bereich = null;
  state.auswahl = null;
  renderAlles();
  renderAuswahl();
  if (crs) $("crs").value = crs;
  renderQuelle({ name, url, geoName, beispiel, laeuft: true });
  setStatus(`${name} lesen …`);
  const kopie = { name, geoName, url, geoUrl, beispiel, datei, geoDatei };
  state.letzterVersuch = kopie;
  try {
    const transfer = [bytes.buffer];
    if (geoBytes) transfer.push(geoBytes.buffer);
    const r = await frage({ type: "netz", name, bytes, geoBytes, crs: $("crs").value.trim(), osmFilter: $("osm-filter").value }, transfer);
    if (nr !== state.ladeNr) return;
    const info = r.info;
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
    if (nr !== state.ladeNr) return;
    netzWeg();
    renderQuelle(null);
    setStatus(`${name}: ${err.message}`, "error");
  }
}

async function ladeNetzVonUrl({ net, geo = "auto", beispiel = false, crs = null }) {
  laden?.abort();
  const ctrl = (laden = new AbortController());
  const name = beispiel ? BEISPIEL.name : fileName(net);
  try {
    let geoUrl = null;
    if (geo === "auto" && !beispiel && !istOsmName(net)) {
      setStatus("Link-Geometrien suchen …");
      geoUrl = (await findGeometry(net).catch(() => ({ match: null }))).match?.url ?? null;
    } else if (geo && geo !== "0" && !beispiel) {
      geoUrl = new URL(geo, folderOf(net)).href;
    }
    const bytes = await fetchBytes(net, beispiel ? "Beispielnetz von GitHub" : name, ctrl.signal);
    const geoBytes = geoUrl ? await fetchBytes(geoUrl, fileName(geoUrl), ctrl.signal) : null;
    if (ctrl.signal.aborted) return;
    laden = null;
    await nimmNetz({ name, bytes, url: beispiel ? null : net, geoName: geoUrl ? fileName(geoUrl) : null, geoBytes, geoUrl, beispiel, crs });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    laden = null;
    setStatus(`${beispiel ? "Das Beispielnetz" : name} ließ sich nicht laden (${reason(err)}).`, "error");
  }
}

async function nimmDateien(files) {
  const liste = [...files];
  if (!liste.length) return;
  const netz = liste.find((f) => artVon(f.name) === "netz");
  const geos = liste.filter((f) => artVon(f.name) === "geometrien");
  if (!netz) {
    if (geos.length && state.netz) return nimmGeometrie(geos[0]);
    return setStatus("Darunter ist kein Netz (MATSim network.xml, .xml.gz oder OSM .osm.pbf).", "error");
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
    await nimmNetz({ ...n, bytes, geoName: file.name, geoBytes: new Uint8Array(await file.arrayBuffer()), geoDatei: file, geoUrl: null, crs: null });
  } catch (err) {
    setStatus(`${n.name} ließ sich nicht neu lesen (${reason(err)}).`, "error");
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
    await nimmNetz({ ...n, bytes, geoBytes, crs: null });
  } catch (err) {
    setStatus(`${n.name} ließ sich nicht neu lesen (${reason(err)}).`, "error");
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
  await nimmNetz({ ...n, bytes: await netzBytes(n), geoName: null, geoBytes: null, geoDatei: null, crs: null });
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  nimmDateien(e.dataTransfer.files);
});
$("beispiel").addEventListener("click", () => ladeNetzVonUrl({ net: BEISPIEL.url, beispiel: true, crs: BEISPIEL.crs }));
{
  const sel = $("osm-filter");
  sel.replaceChildren(...Object.entries(OSM_FILTER).map(([code, f]) => {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = f.name;
    o.title = f.text;
    return o;
  }));
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
$("crs").addEventListener("change", () => {
  // ein anderes CRS wirkt nur auf ein Netz ohne eigenes
  if (state.netz?.info?.crsAusDatei) return;
  nochmal();
});

function chip(text, extra = "") {
  const c = document.createElement("span");
  c.className = `chip ${extra}`.trim();
  c.textContent = text;
  return c;
}

function renderQuelle(n) {
  const box = $("source");
  box.replaceChildren();
  if (!n) {
    box.innerHTML = '<span class="note">Noch kein Netz geladen.</span>';
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
  if (n.beispiel) box.append(chip("Beispiel", "example"));
  const osm = n.info?.osm;
  if (osm) {
    box.append(chip("OSM-Auszug", "fit"));
    box.append(chip(`${de(osm.wege)} Wege, ${de(n.info.links)} Kanten`));
    box.append(chip(osm.filter));
  } else if (n.info) {
    box.append(chip(`${de(n.info.links)} Links`));
    box.append(chip(n.info.crs + (n.info.crsAusDatei ? "" : " aus Formular"), n.info.crsAusDatei ? "fit" : ""));
    const w = n.info.wege;
    if (w?.links) {
      const c = chip(`OSM-Weg an ${de((100 * w.links) / n.info.links)} % der Links`);
      c.title = w.sumo ? "Die Link-IDs sehen nach SUMO aus (Weg-ID#Abschnitt): Eine Zuordnung aus OSM lässt sich über den Weg übernehmen." : "Die Links tragen osm:way:id oder origid: Eine Zuordnung aus OSM lässt sich über den Weg übernehmen.";
      box.append(c);
    }
  }
  const geo = $("geo");
  geo.hidden = !n.info;
  $("geo-file").closest("label").hidden = Boolean(osm);
  if (osm) {
    $("geo-text").innerHTML = 'Die Kanten folgen den Wegen aus OSM, geteilt an jedem Knotenpunkt, und heißen wie bei SUMO: <code>Weg-ID#Abschnitt</code>, die Gegenrichtung mit Minus. Eine <code>counts.xml</code> gibt es dafür nicht, aber eine Zuordnung, die sich auf ein MATSim-Netz übertragen lässt. Daten © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap-Mitwirkende</a> (ODbL).';
    $("geo-clear").hidden = true;
  } else if (n.info) {
    const g = n.info.geometrien;
    const s = n.info.stats;
    $("geo-text").innerHTML = g
      ? `Link-Geometrien: <strong>${esc(n.geoName)}</strong>, ${de(s.fromCsv)} von ${de(n.info.links)} Links mit Verlauf.`
      : s.fromOrigGeom
        ? `Link-Geometrien aus <code>origgeom</code>: ${de(s.fromOrigGeom)} Links mit Verlauf.`
        : "Ohne Link-Geometrien: Die Links laufen gerade von Knoten zu Knoten, die Abstände sind gröber.";
    $("geo-clear").hidden = !g;
  }
  const credit = $("credit");
  credit.hidden = !n.beispiel;
  if (n.beispiel) {
    credit.innerHTML = `Beispielnetz: <a href="${BEISPIEL.seite}" target="_blank" rel="noopener"><code>examples/scenarios/berlin</code></a> aus matsim-libs, ein altes Netz der Hauptstraßen von 2006 in DHDN / Gauß-Krüger 4. Die Seite lädt es von GitHub. Neuere Netze mit Geometrien gibt es im VSP-SVN, etwa unter <code>berlin/</code>.`;
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
  li.textContent = "Ordner laden …";
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
    svnNote(`Der Ordner ließ sich nicht laden (${reason(err)}).`);
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
    if (kind === "netz") b.append(chip("Netz"));
    if (kind === "geometrien") {
      b.append(chip("Geometrien"));
      if (state.netz && stemFit(state.netz.name, e.name)) b.append(chip("passt zum Netz", "fit"));
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
    li.textContent = "Leer";
    items.push(li);
  }
  $("svn-list").replaceChildren(...items);
  $("svn-list").scrollTop = 0;
  svnNote([svn.hint, hidden ? `${de(hidden)} weitere Datei${hidden === 1 ? "" : "en"} ausgeblendet.` : null].filter(Boolean).join(" ") || null);
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
    if (!state.netz?.url) return svnNote("Link-Geometrien gehören zu einem Netz aus dem SVN. Wähle zuerst das Netz.");
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
    return svnNote("Das ist kein gültiger Pfad und keine gültige Adresse.");
  }
  if (url.endsWith("/")) openFolder(url);
  else ladeNetzVonUrl({ net: url, geo: "auto" });
});

// ---------- Adresszeile: ?net=…&geo=…&crs=…&daten=… ----------
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
  const q = p.toString().replace(/%2F/g, "/").replace(/%3A/g, ":");
  history.replaceState(null, "", q ? `?${q}` : location.pathname);
}

// ---------- Zählkarte ----------
async function ladeDaten() {
  try {
    const res = await fetch(`${DATEN}dauer/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.daten = leseIndex(await res.json());
    const d = state.daten;
    const n = d.stellen.length;
    $("daten-text").innerHTML = `Zählkarte vom ${esc(d.erzeugt ?? "?")}: ${de(n)} Dauerzählstellen aus ${de(d.quellen.size)} Quellen.` +
      (d.version !== VERTRAG ? ` <strong>Achtung:</strong> Die Daten haben Version ${esc(d.version)}, gebaut ist die Seite für Version ${VERTRAG}.` : "");
    renderGruppen();
    if (state.netz) await waehleStellen();
  } catch (err) {
    state.datenFehler = err;
    $("daten-text").textContent = `Die Dauerzählstellen der Zählkarte ließen sich nicht laden (${reason(err)}). Adresse: ${DATEN}dauer/index.json`;
    if (state.netz) setStatus("Ohne die Daten der Zählkarte gibt es nichts zuzuordnen.", "error");
  }
}

/** Die Stellen im Gebiet des Netzes, die eine Richtung zählen und aus einer Quelle mit Lizenz stammen. */
async function waehleStellen() {
  const d = state.daten;
  const n = state.netz;
  if (!d || !n?.info?.bbox) {
    if (n && !d) {
      if (state.datenFehler) setStatus("Netz geladen, aber ohne die Daten der Zählkarte gibt es nichts zuzuordnen (siehe Schritt 2).", "error");
      else setStatus("Netz geladen. Die Zählstellen kommen gleich …", "busy");
    } else if (n && !n.info?.bbox) setStatus("Das Netz hat keine Links, die sich zeichnen lassen.", "error");
    return;
  }
  const [w, s, o, nn] = n.info.bbox;
  const rand = 0.002;
  const imGebiet = d.stellen.filter((x) => x.lon >= w - rand && x.lon <= o + rand && x.lat >= s - rand && x.lat <= nn + rand);
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
    if (x.r.art !== "gerichtet") { gruende.beide++; continue; }
    if (x.r.grad == null && !ohneKompass) { gruende.kompass++; continue; }
    const gruppen = x.gruppen.filter((g) => state.gruppen[g]?.an);
    if (!gruppen.length) { gruende.gruppe++; continue; }
    const modi = [...new Set(gruppen.flatMap((g) => state.gruppen[g].link.split(/[,\s]+/).map((m) => m.trim().toLowerCase()).filter(Boolean)))];
    gewaehlt.push({ ...x, aktiv: gruppen, modi });
  }
  gewaehlt.sort((a, b) => a.id.localeCompare(b.id, "de", { numeric: true }));
  state.bereich = { imGebiet: imGebiet.length, gruende, ohneLizenz: [...ohneLizenz] };
  state.stellen = gewaehlt;
  state.byId = new Map(gewaehlt.map((x) => [x.id, x]));
  if (state.auswahl && !state.byId.has(state.auswahl)) state.auswahl = null;
  for (const id of [...state.stunden.keys()]) if (!state.byId.has(id)) state.stunden.delete(id);
  await suche();
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

async function suche() {
  const t = ++state.suchToken;
  const stellen = state.stellen.map((s) => ({ id: s.id, ...suchpunkt(s), name: s.name, modi: s.modi }));
  if (!stellen.length) {
    state.ergebnisse.clear();
    nachSuche();
    setStatus(`Im Gebiet des Netzes liegen keine passenden Dauerzählstellen.`, "idle");
    return;
  }
  setStatus(`Links zu ${de(stellen.length)} Zählstellen suchen …`);
  try {
    const r = await frage({ type: "suche", stellen, params: { radius: Number($("radius").value) || 50, maxWinkel: Number($("winkel").value) || 60 } });
    if (t !== state.suchToken) return;
    state.ergebnisse = new Map(r.ergebnisse.map((e) => [e.id, e]));
    await loeseEntscheide();
    nachSuche();
  } catch (err) {
    if (t !== state.suchToken) return;
    setStatus(`Die Suche nach Links ging schief: ${err.message}`, "error");
  }
}

function nachSuche() {
  verteileNeu();
  for (const id of ["s-stellen", "s-pruefen", "s-mitteln", "s-ausgeben"]) $(id).classList.toggle("inactive", !state.stellen.length);
  $("legend").hidden = !state.stellen.length;
  const mit = state.stellen.filter((s) => linkVon(s)).length;
  setStatus(`${de(state.stellen.length)} Zählstellen, ${de(mit)} davon mit Link. ${zaehle("pruefen") ? `${de(zaehle("pruefen"))} zum Prüfen.` : ""}`.trim(), "done");
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

/** Automatische Wahl neu: jeder Link nur einmal, Zuordnungen von Hand gehen vor, ausgelassene Stellen nehmen nichts. */
function verteileNeu() {
  const liste = state.stellen;
  const fest = new Map();
  const kandidaten = liste.map((s, idx) => {
    const e = state.entscheid.get(s.id);
    if (e?.link) fest.set(idx, e.link.i);
    if (e?.aus) return [];
    return state.ergebnisse.get(s.id)?.kandidaten ?? [];
  });
  const wahl = verteile(kandidaten, fest, liste.map(ausgabeModi));
  state.wahl = new Map(liste.map((s, idx) => [s.id, wahl[idx]]));
}

/** Die networkModes, die eine Stelle ausgibt; ein Link trägt je Verkehrsmittel nur eine Stelle. */
function ausgabeModi(s) {
  return [...new Set(s.aktiv.map((g) => state.gruppen[g].mode))];
}

/** Der Link einer Stelle: von Hand, sonst automatisch. */
function linkVon(s) {
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
    const vorab = e?.anker && !e.link ? [`Aus „${e.anker.netz ?? "einer Zuordnung"}“ nicht eindeutig übernommen (${e.anker.grund ?? "unklar"}).`] : [];
    if (vorab.length && !k.length) return [...vorab, "Im Umkreis des übernommenen Punkts liegt kein passender Link."];
    if (k.length) return [...vorab, "Alle passenden Links im Umkreis sind an andere Stellen mit demselben Verkehrsmittel vergeben."];
    const u = state.ergebnisse.get(s.id)?.umkreis;
    const r = Number($("radius").value) || 50;
    if (!u?.links) return [`Im Umkreis von ${de(r)} m liegt kein Link.`];
    if (!u.modus) return [`Im Umkreis liegen ${de(u.links)} Links, aber keiner erlaubt ${s.modi.join(" oder ")}. Hat das Netz dieses Verkehrsmittel? Sonst unter „Link erlaubt“ anpassen.`];
    return [`Im Umkreis liegen ${de(u.modus)} Links mit ${s.modi.join(" oder ")}, aber keiner weicht höchstens ${de(Number($("winkel").value) || 60)}° von der Fahrtrichtung ab.`];
  }
  const out = [];
  const e = state.entscheid.get(s.id);
  if (e?.anker && !e.link) out.push(`Aus „${e.anker.netz ?? "einer Zuordnung"}“ nicht eindeutig übernommen (${e.anker.grund ?? "unklar"}). Gesucht wird vom übernommenen Punkt aus.`);
  if (s.r.grad == null && !e?.anker) out.push(`Die Quelle nennt nur das Ziel („${s.r.ziel}“), keine Himmelsrichtung: Hin- oder Rückrichtung prüfen.`);
  if (w.d > WEIT_M) out.push(`Der Link liegt ${de(w.d)} m ${e?.anker ? "vom übernommenen Punkt" : "von der Stelle"} entfernt.`);
  if (w.abweichung != null && w.abweichung > WINKEL_PRUEFEN) out.push(`Die Richtung des Links weicht um ${de(w.abweichung)}° ab.`);
  if (k[0] && k[0].i !== w.i) out.push("Der nächste Link ist an eine andere Stelle vergeben.");
  return out;
}

function lageVon(s) {
  const e = state.entscheid.get(s.id);
  if (e?.aus) return "aus";
  if (e?.link) return "geprueft";
  if (!state.wahl.get(s.id)) return "ohne";
  return gruendeVon(s).length ? "pruefen" : "passt";
}
const zaehle = (lage) => state.stellen.filter((s) => lageVon(s) === lage).length;
/** Die Richtung einer Stelle in Worten; steht sie nur im Namen oder in der Kennung, mit Hinweis. */
const richtungsText = (s) => s.richtungText || (s.r.ausNamen ? `Richtung ${lang(s.r.grad)} (aus Name oder Kennung)` : "");

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
    if (!roh || state.entscheid.has(s.id)) continue;
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
  let meldung = `${s.name || s.id}: Link ${link.id} festgelegt.`;
  const modi = ausgabeModi(s);
  for (const [andere, e] of state.entscheid) {
    const t = state.byId.get(andere);
    // ein Link trägt eine Kfz- und eine Rad-Stelle; nur wer dasselbe Verkehrsmittel ausgibt, muss weichen
    if (andere !== id && e.link?.id === link.id && (!t || ausgabeModi(t).some((m) => modi.includes(m)))) {
      e.link = null;
      meldung += ` ${t?.name || andere} hatte ihn und sucht neu.`;
    }
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

/** Zwei Stellen ohne Himmelsrichtung am selben Ort tauschen ihre Links. */
function partnerVon(s) {
  if (s.r.grad != null) return null;
  let best = null;
  let bestD = 40; // m
  for (const t of state.stellen) {
    if (t.id === s.id || t.quelle !== s.quelle || t.r.grad != null) continue;
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
  geaendert(`${s.name}: ${s.r.ziel} und ${t.r.ziel} haben die Links getauscht.`);
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
  if (s && !state.stunden.has(id)) ladeStunden([s]).then(() => state.auswahl === id && renderKarte());
  renderListe();
  renderKarte();
  zeichneDaten();
  const btn = $("liste").querySelector(`button[data-id="${CSS.escape(id)}"]`);
  btn?.scrollIntoView({ block: "nearest" });
}

function naechste() {
  const liste = state.stellen.filter((s) => lageVon(s) === "pruefen" || lageVon(s) === "ohne");
  if (!liste.length) return setStatus("Nichts mehr zu prüfen.", "done");
  const at = liste.findIndex((s) => s.id === state.auswahl);
  waehle(liste[(at + 1) % liste.length].id);
}
$("naechste").addEventListener("click", naechste);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return pickEnde();
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const id = state.auswahl;
  if (e.key === "n") naechste();
  else if (e.key === "p" && id) passt(id);
  else if (e.key === "w" && id) (state.pick ? pickEnde() : pickStart());
  else if (e.key === "a" && id) auslassen(id, lageVon(state.byId.get(id)) !== "aus");
  else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement?.closest("#liste")) {
    e.preventDefault();
    const ids = sichtbare().map((s) => s.id);
    const at = ids.indexOf(id);
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
  $("st-gebiet").textContent = de(b.imGebiet);
  $("st-gerichtet").textContent = de(state.stellen.length);
  $("st-link").textContent = de(state.stellen.filter((s) => linkVon(s)).length);
}

function renderAuswahl() {
  const b = state.bereich;
  const t = $("auswahl-text");
  t.hidden = !b;
  if (!b) return;
  const teile = [];
  if (b.gruende.beide) teile.push(`${de(b.gruende.beide)} zählen beide Richtungen zusammen oder nennen keine (die meisten Rad-Zählstellen) und passen auf keinen einzelnen Link`);
  if (b.gruende.lizenz) teile.push(`${de(b.gruende.lizenz)} stammen aus Quellen ohne Lizenz (${b.ohneLizenz.map(esc).join(", ")})`);
  if (b.gruende.kompass) teile.push(`${de(b.gruende.kompass)} nennen nur ein Ziel`);
  if (b.gruende.gruppe) teile.push(`${de(b.gruende.gruppe)} zählen keine der gewählten Gruppen`);
  t.innerHTML = teile.length ? `Draußen bleiben: ${teile.join("; ")}.` : "Alle Stellen im Gebiet sind dabei.";
  renderGruppen();
}

function renderGruppen() {
  const d = state.daten;
  if (!d) return;
  const body = $("gruppen-body");
  const zaehler = Object.fromEntries(GRUPPEN.map((g) => [g, state.stellen.filter((s) => s.gruppen.includes(g)).length]));
  body.replaceChildren(...GRUPPEN.map((g) => {
    const cfg = state.gruppen[g];
    const tr = document.createElement("tr");
    tr.className = cfg.an ? "" : "off";
    tr.innerHTML = `<td><label class="check"><input type="checkbox" data-g="${g}" data-f="an"${cfg.an ? " checked" : ""}>${esc(d.gruppenNamen[g] ?? g)}</label></td>
      <td><input type="text" data-g="${g}" data-f="mode" value="${esc(cfg.mode)}" spellcheck="false" aria-label="networkMode für ${esc(g)}"></td>
      <td><input type="text" data-g="${g}" data-f="link" value="${esc(cfg.link)}" spellcheck="false" aria-label="Modi, die der Link erlauben muss, für ${esc(g)}"></td>
      <td class="n">${state.stellen.length ? de(zaehler[g]) : ""}</td>`;
    return tr;
  }));
}
$("gruppen-body").addEventListener("change", (e) => {
  const el = e.target;
  const g = el.dataset.g;
  if (!g) return;
  const cfg = state.gruppen[g];
  if (el.dataset.f === "an") cfg.an = el.checked;
  else cfg[el.dataset.f] = el.value.trim();
  store.set("snapper.gruppen", JSON.stringify(state.gruppen));
  if (el.dataset.f === "mode") {
    verteileNeu();
    mittleAlle();
    renderAlles();
  } else waehleStellen();
});
for (const id of ["radius", "winkel"]) $(id).addEventListener("change", () => state.netz && suche());
$("ohne-kompass").addEventListener("change", () => state.netz && waehleStellen());

const FILTER = [
  ["alle", "Alle"],
  ["pruefen", "Prüfen"],
  ["ohne", "Ohne Link"],
  ["passt", "Passt"],
  ["geprueft", "Geprüft"],
  ["aus", "Ausgelassen"],
];
function renderFilter() {
  const box = $("filter");
  box.replaceChildren(...FILTER.map(([wert, text]) => {
    const n = wert === "alle" ? state.stellen.length : zaehle(wert);
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(state.filter === wert));
    b.value = wert;
    b.innerHTML = `${text}<span>${de(n)}</span>`;
    b.disabled = !n && wert !== "alle";
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

const sichtbare = () => state.stellen.filter((s) => state.filter === "alle" || lageVon(s) === state.filter);

function renderListe() {
  const ul = $("liste");
  const liste = sichtbare();
  if (!liste.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = state.stellen.length ? "Keine Stellen in dieser Auswahl." : "Noch keine Zählstellen.";
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...liste.map((s) => {
    const lage = lageVon(s);
    const link = linkVon(s);
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = s.id;
    b.setAttribute("aria-current", String(s.id === state.auswahl));
    b.innerHTML = `<span class="dot" style="--c: var(${LAGE_FARBE[lage]})" title="${esc(LAGE_TEXT[lage])}"></span>
      <span class="t">${esc(s.name || s.id)} <small>${esc(s.abschnitt ?? "")}</small></span>
      <span class="m">${link?.d != null ? `${de(link.d)} m` : "–"}</span>
      <span class="s">${esc(richtungsText(s))} · ${esc(s.id)}</span>`;
    li.append(b);
    return li;
  }));
}
$("liste").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (b) waehle(b.dataset.id);
});

function kompassSvg(grad) {
  if (grad == null) return "";
  return `<span class="kompass" title="${de(grad)}°"><svg viewBox="-10 -10 20 20" aria-hidden="true"><path d="M0 -8 L5 6 L0 3 L-5 6 Z" fill="currentColor" transform="rotate(${grad})"/></svg></span>`;
}

function profilSvg(s) {
  const r = state.ergebnisMittel.get(s.id);
  if (!r) return "";
  const gruppen = Object.keys(r).filter((g) => r[g].werte.some((v) => v != null));
  if (!gruppen.length) return '<p class="note">Im gewählten Zeitraum gibt es für diese Stelle keine Werte.</p>';
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
      bars += `<rect x="${(h * breit + gi * (balken + 1)).toFixed(1)}" y="${(H - unten - hoehe).toFixed(1)}" width="${balken.toFixed(1)}" height="${hoehe.toFixed(1)}" fill="${GRUPPE_FARBE[g] ?? "#888"}"><title>${g} ${h}–${h + 1} Uhr: ${de(v, 1)} (${r[g].tage[h]} Tage)</title></rect>`;
    });
  });
  const ticks = [0, 6, 12, 18, 23].map((h) => `<text x="${(h * breit + breit / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">${h}</text>`).join("");
  const leg = gruppen.map((g) => `<span><i style="--c:${GRUPPE_FARBE[g]}"></i>${esc(state.daten.gruppenNamen[g] ?? g)} → ${esc(state.gruppen[g].mode)}: ${de(r[g].tageGenutzt)} Tage${r[g].vollstaendig ? "" : ", nicht alle Stunden"}</span>`).join("");
  return `<svg class="profil" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tagesgang der Stelle"><text x="0" y="9">${de(max)} Fz/h</text>${bars}${ticks}</svg><div class="legende-profil">${leg}</div>`;
}

function renderKarte() {
  const box = $("karte");
  const s = state.byId.get(state.auswahl);
  box.hidden = !s;
  if (!s) return;
  const q = state.daten.quellen.get(s.quelle);
  const lage = lageVon(s);
  const link = linkVon(s);
  const e = state.entscheid.get(s.id);
  const kand = state.ergebnisse.get(s.id)?.kandidaten ?? [];
  const lizenz = q.lizenzen.map((l) => (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.lizenz)}</a>` : esc(l.lizenz))).join(", ");
  const partner = partnerVon(s);
  const gruende = lage === "pruefen" || lage === "ohne" ? gruendeVon(s) : [];
  const zeile = (k, v) => (v == null || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${v}</dd>`);
  const linkHtml = link
    ? `<dl class="linkinfo">${zeile("Link", esc(link.id))}${zeile("Abstand", link.d != null ? `${de(link.d, 1)} m` : null)}${zeile("Richtung", link.grad != null ? `${kurz(link.grad)} ${de(link.grad)}°${link.abweichung != null ? `, ${de(link.abweichung)}° Abweichung` : ""}` : null)}${zeile("type", esc(link.type ?? ""))}${zeile("name", esc(link.name ?? ""))}${zeile("modes", esc(link.modes || "(car)"))}${zeile("OSM-Weg", wegHtml(link.weg))}${zeile("Tempo", link.kmh != null ? `${de(link.kmh, 1)} km/h` : null)}${zeile("capacity", link.capacity != null && !link.osm ? `${de(link.capacity)} Fz/h, ${de(link.permlanes ?? 0, 1)} Fahrstreifen` : null)}</dl>`
    : "";
  box.innerHTML = `
    <div><h3>${esc(s.name || s.id)}</h3>${s.abschnitt ? `<p class="sub">${esc(s.abschnitt)}</p>` : ""}</div>
    <div class="meta">${kompassSvg(s.r.grad)}<span>${esc(richtungsText(s))}</span></div>
    <div class="meta"><span>${esc(s.id)}</span>·<span>${esc(q.name)}</span>·<span>${lizenz}</span>·<span>${s.gruppen.map((g) => esc(state.daten.gruppenNamen[g] ?? g)).join(", ")}</span></div>
    <div class="row"><span class="lage" style="--c: var(${LAGE_FARBE[lage]})">${esc(LAGE_TEXT[lage])}${e?.uebernommen && e.link ? " · übernommen" : e?.link && kand[0]?.id !== e.link.id ? " · von Hand" : ""}</span></div>
    ${e?.uebernommen && e.link ? `<p class="note">Übernommen aus „${esc(e.uebernommen.netz ?? "einer Zuordnung")}“: ${esc(WIE[e.uebernommen.wie] ?? e.uebernommen.wie)}${e.uebernommen.d != null ? `, ${de(e.uebernommen.d, 1)} m vom übernommenen Punkt` : ""}.</p>` : ""}
    ${gruende.length ? `<ul class="gruende">${gruende.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
    ${linkHtml}
    <div class="row">
      ${lage === "pruefen" || lage === "passt" ? '<button type="button" class="btn small" data-act="passt">Passt</button>' : ""}
      ${lage !== "aus" ? `<button type="button" class="btn secondary small${state.pick ? " on" : ""}" data-act="pick">${state.pick ? "Wählen abbrechen" : "Auf der Karte wählen"}</button>` : ""}
      ${partner && link && linkVon(partner) ? `<button type="button" class="btn secondary small" data-act="tausch" title="mit ${esc(richtungsText(partner))}">Mit Gegenrichtung tauschen</button>` : ""}
      ${lage === "aus" ? '<button type="button" class="btn secondary small" data-act="ein">Wieder aufnehmen</button>' : '<button type="button" class="btn secondary small" data-act="aus">Auslassen</button>'}
      ${e?.link ? '<button type="button" class="linkbtn" data-act="reset">Zurück zur automatischen Wahl</button>' : ""}
    </div>
    <div class="field"><label for="kommentar">Kommentar</label><textarea id="kommentar" rows="1" placeholder="geht in die CSV">${esc(e?.kommentar ?? "")}</textarea></div>
    ${kand.length ? `<table class="kand"><caption class="visually-hidden">Links im Umkreis</caption><thead><tr><th></th><th>Link</th><th>Abstand</th><th>Abw.</th><th>Name / Typ</th><th></th></tr></thead><tbody>${kand.map((k, r) => `<tr class="${k.id === link?.id ? "cur" : ""}"><td><span class="rang">${r + 1}</span></td><td>${esc(k.id)}</td><td>${de(k.d, 1)} m</td><td>${k.abweichung != null ? `${de(k.abweichung)}°` : "–"}</td><td class="x" title="${esc([k.name, k.type].filter(Boolean).join(" · "))}">${esc([k.name, k.type].filter(Boolean).join(" · ") || "–")}</td><td>${k.id === link?.id || lage === "aus" ? "" : `<button type="button" class="linkbtn" data-act="nimm" data-i="${k.i}">nehmen</button>`}</td></tr>`).join("")}</tbody></table>` : '<p class="note">Kein Link im Umkreis. Auf der Karte lässt sich einer wählen.</p>'}
    <div>${state.stunden.has(s.id) ? profilSvg(s) : '<p class="note">Stundenwerte werden geladen …</p>'}</div>`;
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
    if (chunks.length > 1) $("stunden-text").textContent = `${de(fertig)} von ${de(chunks.length)} Dateien geladen …`;
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
  if (fehler) $("stunden-text").textContent = `${de(fehler)} Datei${fehler === 1 ? "" : "en"} ließen sich nicht laden.`;
  mittleAlle();
  return fehler === 0;
}

function genutzteStellen() {
  return state.stellen.filter((s) => lageVon(s) !== "aus" && linkVon(s) && (!$("nur-geprueft").checked || lageVon(s) === "geprueft"));
}

async function ladeAlleStunden() {
  const stellen = genutzteStellen();
  $("stunden-laden").disabled = true;
  setStatus(`Stundenwerte von ${de(stellen.length)} Stellen laden …`);
  const ok = await ladeStunden(stellen);
  $("stunden-laden").disabled = false;
  setStatus(ok ? "Stundenwerte geladen." : "Nicht alle Stundenwerte ließen sich laden.", ok ? "done" : "error");
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
    b.textContent = w.kurz;
    b.setAttribute("aria-pressed", String(m.wochentage.includes(w.nr)));
    return b;
  }));
  // der Zeitraum der Stundenwerte je Quelle (die jüngsten 12 Monate)
  if (!state.daten) return;
  const quellen = [...new Set(state.stellen.map((s) => s.quelle))].map((c) => state.daten.quellen.get(c)).filter(Boolean);
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
    ? `Stundenwerte hat die Zählkarte für die jüngsten 12 Monate: ${quellen.map((q) => `${esc(q.name)} ${esc(q.stundenVon)} bis ${esc(q.bis)}`).join("; ")}. Ohne Angabe gilt der ganze Zeitraum.`
    : "";
  const fehlt = genutzteStellen().filter((s) => !state.stunden.has(s.id)).length;
  $("laden-row").hidden = fehlt === 0;
  if (fehlt) {
    const chunks = new Set(genutzteStellen().filter((s) => !state.stunden.has(s.id)).map((s) => s.chunk)).size;
    $("stunden-laden").textContent = `Stundenwerte laden (${de(fehlt)} Stellen, ${de(chunks)} Datei${chunks === 1 ? "" : "en"})`;
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
  const nr = Number(b.value);
  const w = state.mittel.wochentage;
  state.mittel.wochentage = w.includes(nr) ? w.filter((x) => x !== nr) : [...w, nr];
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
    const st = state.stunden.get(s.id);
    if (st === undefined) continue;
    const r = {};
    for (const g of s.aktiv) r[g] = mittle(state.daten, s, st, g, state.mittel);
    state.ergebnisMittel.set(s.id, r);
    const gr = Object.values(r);
    if (gr.some((x) => x.werte.some((v) => v != null))) {
      mitWerten++;
      if (gr.some((x) => !x.vollstaendig && x.werte.some((v) => v != null))) unvollstaendig++;
    } else ohneWerte++;
  }
  const t = $("mittel-text");
  t.hidden = state.ergebnisMittel.size === 0;
  t.textContent = `${auswahlText(state.mittel)}. ${de(mitWerten)} Stellen mit Werten${unvollstaendig ? `, davon ${de(unvollstaendig)} nicht in allen Stunden` : ""}${ohneWerte ? `; ${de(ohneWerte)} ohne Werte in dieser Auswahl` : ""}.`;
}

// ---------- Ausgeben ----------
const stamm = () => {
  const n = state.netz;
  if (!n) return "netz";
  return n.beispiel ? "berlin-matsim-libs" : scenarioStem(n.name) || "netz";
};

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
        ["richtung", richtungsText(s)],
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
  const locations = [];
  for (const [refId, eintraege] of jeLink) {
    // MATSim führt Werte desselben Verkehrsmittels an einer Messstelle zusammen; die erste Gruppe gilt
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
      quellen.set(en.q.code, en.q);
      // teilen sich Stellen einen Link, tragen ihre Angaben das Verkehrsmittel als Endung
      const endung = eintraege.length > 1 ? `_${eigene[0].networkMode}` : "";
      attributes.push(...en.attributes.map(([k, ...rest]) => [`${k}${endung}`, ...rest]), ...en.tage);
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
  }
  const m = state.mittel;
  const attributes = [
    ["erstellt_mit", "matsim-counts-snapper, https://github.com/vizsim-lab/matsim-counts-snapper"],
    ["zaehlkarte", `Dauerzählstellen der Zählkarte (vizsim-lab), Stand ${d.erzeugt ?? "?"}, ${DATEN}dauer/`],
    ["netz", state.netz?.url ?? (state.netz?.beispiel ? BEISPIEL.url : state.netz?.name)],
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

function renderExport() {
  const bereit = state.stellen.length > 0;
  const osm = Boolean(state.netz?.info?.osm);
  for (const id of ["counts-xml", "counts-gz"]) $(id).disabled = !bereit || osm;
  $("zuordnung-csv").disabled = !bereit;
  $("osm-export").hidden = !osm;
  const genutzt = genutzteStellen();
  const fehlt = genutzt.filter((s) => !state.stunden.has(s.id)).length;
  const offen = zaehle("pruefen");
  const t = $("export-text");
  const teile = [];
  if (bereit) teile.push(`${de(genutzt.length)} Stellen mit Link gehen hinein${$("nur-geprueft").checked ? " (nur geprüfte)" : ""}.`);
  if (offen && !$("nur-geprueft").checked) teile.push(`${de(offen)} davon sind noch nicht geprüft.`);
  if (fehlt) teile.push(`Für ${de(fehlt)} fehlen noch die Stundenwerte; die Knöpfe laden sie vorher.`);
  t.hidden = !teile.length;
  t.textContent = teile.join(" ");
  // Quellen und Lizenzen der Stellen, die hineingehen
  const quellen = [...new Set(genutzt.map((s) => s.quelle))].map((c) => state.daten?.quellen.get(c)).filter(Boolean);
  $("quellen-box").hidden = !quellen.length;
  $("quellen").replaceChildren(...quellen.map((q) => {
    const li = document.createElement("li");
    const einschr = q.lizenzen.some((l) => /NC|SA|Nutzungsbeschr/i.test(l.lizenz ?? ""));
    li.className = einschr ? "einschr" : "";
    li.innerHTML = `<b>${esc(q.name)}</b>: ${q.lizenzen.map((l) => (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.lizenz)}</a>` : esc(l.lizenz))).join(", ")}${q.quellenvermerk ? ` <span class="v">· ${esc(q.quellenvermerk)}</span>` : ""}${einschr ? ' <span class="v">· mit Einschränkung</span>' : ""}`;
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
    setStatus("Stundenwerte laden …");
    await ladeStunden(genutzt);
    renderMittelRahmen();
  }
  const { xml, locations, drausen } = baueCounts();
  const name = `${stamm()}-counts-zaehlkarte.xml`;
  if (gz) {
    const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream("gzip"));
    speichern(`${name}.gz`, await new Response(stream).arrayBuffer(), "application/gzip");
  } else speichern(name, xml, "application/xml");
  const teile = [`${de(locations.length)} Messstellen in ${name}${gz ? ".gz" : ""}.`];
  if (drausen.unvollstaendig) teile.push(`${de(drausen.unvollstaendig)} Tagesgänge ohne alle 24 Stunden blieben draußen.`);
  if (drausen.ohneWerte) teile.push(`${de(drausen.ohneWerte)} ohne Werte in der Auswahl.`);
  if (drausen.doppelterModus) teile.push(`${de(drausen.doppelterModus)}-mal zwei Gruppen mit demselben networkMode: nur die erste ging hinein.`);
  setStatus(teile.join(" "), "done");
  renderAlles();
}
$("counts-xml").addEventListener("click", () => exportiere(false));
$("counts-gz").addEventListener("click", () => exportiere(true));

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
  const zeilen = state.stellen.map((s) => {
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
      richtung: richtungsText(s),
      name: s.name,
      quelle: s.quelle,
      anker_lon: a ? a.lon.toFixed(7) : "",
      anker_lat: a ? a.lat.toFixed(7) : "",
      anker_grad: a?.grad != null ? Math.round(a.grad) : "",
      osm_weg: link?.weg ?? "",
      netz: link ? netzName() : "",
    };
  });
  speichern(`${stamm()}-counts-zuordnung.csv`, zuordnungCsv(zeilen), "text/csv");
  setStatus(`Zuordnung von ${de(zeilen.length)} Stellen gespeichert.`, "done");
});

$("csv-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const zeilen = leseZuordnungCsv(await file.text());
    let gesetzt = 0;
    let fremd = 0;
    let ohneLink = 0;
    const mitAnker = [];
    for (const z of zeilen) {
      const s = state.byId.get(z.station);
      if (!s) {
        fremd++;
        continue;
      }
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
      // ein Link trägt je Verkehrsmittel eine Stelle: bei zweien gewinnt, wessen Anker näher liegt
      const belegt = new Map();
      for (const [andere, e] of state.entscheid) if (e.link && !mitAnker.some(({ s }) => s.id === andere)) belegt.set(e.link.id, [...(belegt.get(e.link.id) ?? []), andere]);
      const reihe = [...mitAnker].sort((a, b) => (nach.get(a.s.id)?.ankerAbstand ?? Infinity) - (nach.get(b.s.id)?.ankerAbstand ?? Infinity));
      for (const { s, z } of reihe) {
        const x = nach.get(s.id);
        const ent = entscheid(s.id);
        const herkunft = z.netz || file.name;
        ent.anker = { lon: z.anker.lon, lat: z.anker.lat, grad: z.anker.grad, weg: z.weg, netz: herkunft };
        const modi = ausgabeModi(s);
        const schon = x?.link ? (belegt.get(x.link.id) ?? []).find((t) => ausgabeModi(state.byId.get(t) ?? { aktiv: [] }).some((m) => modi.includes(m))) : null;
        if (x?.link && !schon) {
          ent.link = x.link;
          ent.uebernommen = { wie: x.wie, netz: herkunft, d: x.ankerAbstand != null ? Math.round(x.ankerAbstand * 10) / 10 : null };
          belegt.set(x.link.id, [...(belegt.get(x.link.id) ?? []), s.id]);
          wie[x.wie]++;
        } else {
          ent.link = null;
          ent.uebernommen = null;
          ent.anker.grund = schon ? `der passende Link ${x.link.id} gehört schon zu ${state.byId.get(schon)?.name || schon}` : x?.grund ?? "unklar";
          offen++;
        }
      }
    }
    const teile = [`${file.name}:`];
    const uebernommen = wie.id + wie.weg + wie.lage;
    if (mitAnker.length) teile.push(`${de(uebernommen)} von ${de(mitAnker.length)} geprüften Zuordnungen übernommen${uebernommen ? ` (${[[wie.id, "gleiche Link-ID"], [wie.weg, "gleicher OSM-Weg"], [wie.lage, "eindeutige Lage"]].filter(([n]) => n).map(([n, t]) => `${de(n)} ${t}`).join(", ")})` : ""}${offen ? `, ${de(offen)} zum Prüfen` : ""}.`);
    if (gesetzt || !mitAnker.length) teile.push(`${de(gesetzt)} Entscheidungen ${mitAnker.length ? "ohne Anker " : ""}übernommen.`);
    if (fremd) teile.push(`${de(fremd)} Stationen gehören nicht zur Auswahl.`);
    if (ohneLink) teile.push(`${de(ohneLink)} Links fehlen im Netz.`);
    if (mitAnker.length) {
      // die offenen suchen jetzt vom Anker aus
      speichere();
      await suche();
      setStatus(teile.join(" "), "done");
    } else geaendert(teile.join(" "));
  } catch (err) {
    setStatus(`${file.name}: ${err.message}`, "error");
  }
});

// ---------- Start ----------
try {
  const g = JSON.parse(store.get("snapper.gruppen") ?? "null");
  if (g) for (const k of GRUPPEN) if (g[k]) Object.assign(state.gruppen[k], g[k]);
} catch { /* Vorgabe */ }
renderMittelRahmen();
ladeDaten();
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
  else setStatus("Der Parameter net ist keine gültige Adresse.", "error");
} else {
  ladeNetzVonUrl({ net: BEISPIEL.url, beispiel: true, crs: BEISPIEL.crs });
}

// für Tests im Browser: ?debug gibt Karte und Zustand frei
if (params.has("debug")) window.snapper = { map, state, lageVon, linkVon };

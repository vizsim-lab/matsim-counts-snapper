// Koordinatensysteme. MATSim-Netze liegen meist in einem metrischen CRS, die Zählstellen der
// Zählkarte in WGS84. Bekannt sind hier die in Deutschland üblichen Systeme und die Namen aus
// MATSims TransformationFactory; jedes andere geht als proj4-Text oder WKT, etwa von epsg.io.
import proj4 from "../vendor/proj4/proj4.js";

const DHDN = "+ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs";
const ETRS = "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

/** EPSG-Code -> [Name, proj4-Text]; die Texte wie bei epsg.io. */
const EPSG = {
  4326: ["WGS 84", "+proj=longlat +datum=WGS84 +no_defs"],
  3857: ["WGS 84 / Pseudo-Mercator", "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs"],
  25831: ["ETRS89 / UTM 31N", `+proj=utm +zone=31 ${ETRS}`],
  25832: ["ETRS89 / UTM 32N", `+proj=utm +zone=32 ${ETRS}`],
  25833: ["ETRS89 / UTM 33N", `+proj=utm +zone=33 ${ETRS}`],
  4647: ["ETRS89 / UTM 32N (zE-N)", `+proj=tmerc +lat_0=0 +lon_0=9 +k=0.9996 +x_0=32500000 +y_0=0 ${ETRS}`],
  5650: ["ETRS89 / UTM 33N (zE-N)", `+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=33500000 +y_0=0 ${ETRS}`],
  32631: ["WGS 84 / UTM 31N", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs"],
  32632: ["WGS 84 / UTM 32N", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs"],
  32633: ["WGS 84 / UTM 33N", "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs"],
  31466: ["DHDN / Gauß-Krüger 2", `+proj=tmerc +lat_0=0 +lon_0=6 +k=1 +x_0=2500000 +y_0=0 ${DHDN}`],
  31467: ["DHDN / Gauß-Krüger 3", `+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 ${DHDN}`],
  31468: ["DHDN / Gauß-Krüger 4", `+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 ${DHDN}`],
  31469: ["DHDN / Gauß-Krüger 5", `+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=5500000 +y_0=0 ${DHDN}`],
  3068: ["DHDN / Soldner Berlin", `+proj=cass +lat_0=52.4186482777778 +lon_0=13.6272036666667 +x_0=40000 +y_0=10000 ${DHDN}`],
  3035: ["ETRS89 / LAEA Europe", `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${ETRS}`],
};

/** Namen aus MATSims TransformationFactory, soweit sie hier gebraucht werden können. */
const MATSIM = {
  WGS84: 4326,
  GK4: 31468,
  DHDN_GK4: 31468,
  DHDN_SOLDNERBERLIN: 3068,
  WGS84_UTM32N: 32632,
  WGS84_UTM33N: 32633,
  ETRS89_UTM32N: 25832,
  ETRS89_UTM33N: 25833,
};

/** Codes für das Formular. */
export const BEKANNT = Object.entries(EPSG).map(([code, [name]]) => ({ code: `EPSG:${code}`, name }));

/**
 * Ein CRS aus dem Netz oder dem Formular: { code, name, def }. Versteht „EPSG:25832“, „epsg:25832“,
 * „25832“, „urn:ogc:def:crs:EPSG::25832“, MATSim-Namen wie „DHDN_GK4“, proj4-Texte und WKT.
 */
export function crsDefinition(eingabe) {
  const t = String(eingabe ?? "").trim();
  if (!t) throw new Error("Kein Koordinatensystem angegeben.");
  if (/^\+proj=/.test(t) || /^(PROJCS|GEOGCS|PROJCRS|GEOGCRS)\[/i.test(t)) {
    return { code: t.length > 40 ? `${t.slice(0, 40)}…` : t, name: "eigene Definition", def: t };
  }
  const nr = /^(?:urn:ogc:def:crs:)?(?:epsg)?:{0,2}(\d{4,5})$/i.exec(t.replace(/\s+/g, ""));
  const code = nr ? Number(nr[1]) : MATSIM[t.toUpperCase()];
  if (code && EPSG[code]) return { code: `EPSG:${code}`, name: EPSG[code][0], def: EPSG[code][1] };
  if (code) throw new Error(`EPSG:${code} kennt die Seite nicht. Trage die proj4-Definition ein, etwa von epsg.io.`);
  throw new Error(`„${t}“ ist kein bekanntes Koordinatensystem. Erwartet wird z. B. EPSG:25832 oder eine proj4-Definition.`);
}

/**
 * Umrechnung zwischen dem CRS des Netzes und WGS84. `geographisch` sagt, ob das Netz in Grad
 * vorliegt; dann rechnet die Zuordnung ihre Abstände selbst in Meter um.
 */
export function projektion(eingabe) {
  const crs = crsDefinition(eingabe);
  const p = proj4(crs.def, "EPSG:4326");
  const geographisch = /\+proj=longlat/.test(crs.def) || /^GEOG/i.test(crs.def);
  return {
    ...crs,
    geographisch,
    zuWgs: (x, y) => p.forward([x, y]),
    vonWgs: (lon, lat) => p.inverse([lon, lat]),
  };
}

// Ein kleiner Server für die Browser-Tests: liefert das Repository so aus wie GitHub Pages, dazu die
// Testdaten unter /tests/web/fixtures/. Kein Content-Encoding: .gz und .pbf kommen als Bytes, so wie
// die Seite sie erwartet. Aufruf: node tests/web/server.mjs [Port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WURZEL = fileURLToPath(new URL("../../", import.meta.url));
const TYPEN = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json",
  ".xml": "application/xml",
  ".gz": "application/gzip",
  ".pbf": "application/octet-stream",
  ".csv": "text/csv; charset=utf-8",
  ".poly": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".md": "text/markdown; charset=utf-8",
};
const port = Number(process.argv[2] ?? 4173);

createServer(async (req, res) => {
  try {
    let pfad = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pfad.endsWith("/")) pfad += "index.html";
    const datei = normalize(join(WURZEL, pfad));
    if (!datei.startsWith(WURZEL) || datei.split(sep).includes("node_modules")) throw new Error("nicht erlaubt");
    const daten = await readFile(datei);
    res.writeHead(200, { "content-type": TYPEN[extname(datei).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(daten);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("nicht gefunden");
  }
}).listen(port, "127.0.0.1", () => console.log(`Testserver: http://127.0.0.1:${port}/`));

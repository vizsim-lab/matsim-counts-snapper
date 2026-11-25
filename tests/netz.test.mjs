// Tests des Netz-Lesers (lib/netz.js): dasselbe Netz unverpackt, als gzip und als Zstandard (.zst,
// wie MATSim mit compressionType = zst schreibt); der Zstandard-Strom in kleinen Stücken, mehrere
// Rahmen, kaputte Dateien und was die Seite ablehnt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync, zstdCompressSync, createZstdCompress, constants as Z } from "node:zlib";
import { leseNetz, leseLinkGeometrien, zstdStrom, zstdKopf, istZstd, istGzip, ZSTD_MAX_FENSTER } from "../lib/netz.js";
import { setzeSprache } from "../lib/sprache.js";

// Die Bausteine sprechen hier Deutsch; Englisch prüft sprache.test.mjs
setzeSprache("de");

const NETZ = readFileSync(new URL("./web/fixtures/netz.xml", import.meta.url));
const zst = (b, params = {}) => new Uint8Array(zstdCompressSync(b, { params }));
/** Wie MATSim (ein Strom, die Größe vorher unbekannt). */
const gestreamt = (b, params = {}) => new Promise((ok, fehler) => {
  const teile = [];
  const z = createZstdCompress({ params });
  z.on("data", (t) => teile.push(t));
  z.on("end", () => ok(new Uint8Array(Buffer.concat(teile))));
  z.on("error", fehler);
  z.end(b);
});
const text = async (strom) => new TextDecoder().decode(new Uint8Array(await new Response(strom).arrayBuffer()));
const kurz = (n) => ({ crs: n.crs, nodes: n.nodes, links: n.links.map((l) => [l.id, l.from, l.to, l.modes, l.name, l.origId, [...l.xy]]) });

test("netz: unverpackt, gzip und Zstandard ergeben dasselbe Netz", async () => {
  const roh = await leseNetz(new Uint8Array(NETZ));
  assert.equal(roh.links.length, 34);
  assert.equal(roh.crs, "EPSG:25833");
  const gz = new Uint8Array(gzipSync(NETZ));
  const z = zst(NETZ);
  assert.equal(istGzip(gz), true);
  assert.equal(istZstd(z), true);
  assert.equal(istZstd(gz), false);
  assert.deepEqual(kurz(await leseNetz(gz)), kurz(roh));
  assert.deepEqual(kurz(await leseNetz(z)), kurz(roh));
  for (const stufe of [1, 19]) assert.deepEqual(kurz(await leseNetz(zst(NETZ, { [Z.ZSTD_c_compressionLevel]: stufe }))), kurz(roh));
  assert.deepEqual(kurz(await leseNetz(await gestreamt(NETZ))), kurz(roh));
});

test("netz: Link-Geometrien als .csv.zst", async () => {
  const csv = "LinkId,Geometry\nk00-k10,\"LINESTRING (390000 5819000, 390150 5819010, 390300 5819000)\"\nk10-k00,\"LINESTRING (390300 5819000, 390000 5819000)\"\n";
  const roh = await leseLinkGeometrien(new TextEncoder().encode(csv));
  const z = await leseLinkGeometrien(zst(Buffer.from(csv)));
  assert.equal(z.rows, 2);
  assert.deepEqual([...z.map.entries()].map(([k, v]) => [k, [...v]]), [...roh.map.entries()].map(([k, v]) => [k, [...v]]));
});

test("netz: Zstandard in winzigen Stücken, mehrere Rahmen, übersprungener Rahmen", async () => {
  const z = zst(NETZ);
  assert.equal(await text(zstdStrom(z, 7)), NETZ.toString("utf8"));
  // zwei Rahmen hintereinander gelten als eine Datei (wie bei zstd)
  const a = Buffer.from("<erster/>\n");
  const b = Buffer.from("<zweiter/>\n");
  const zwei = new Uint8Array(Buffer.concat([zstdCompressSync(a), zstdCompressSync(b)]));
  assert.equal(await text(zstdStrom(zwei, 5)), "<erster/>\n<zweiter/>\n");
  // ein übersprungener Rahmen (Metadaten) vorneweg
  const meta = Buffer.alloc(8 + 4);
  meta.writeUInt32LE(0x184d2a50, 0);
  meta.writeUInt32LE(4, 4);
  const mit = new Uint8Array(Buffer.concat([meta, zstdCompressSync(a)]));
  assert.ok(zstdKopf(mit));
  assert.equal(await text(zstdStrom(mit)), "<erster/>\n");
});

test("netz: Kopf eines Rahmens, Fenster und Wörterbuch", async () => {
  assert.equal(zstdKopf(new Uint8Array([1, 2, 3, 4, 5, 6])), null);
  // gestreamt (ohne bekannte Größe) wie bei MATSim: Fenster aus dem Kopf
  const stufe3 = zstdKopf(await gestreamt(Buffer.alloc(3 << 20, 65), { [Z.ZSTD_c_compressionLevel]: 3 }));
  assert.ok(stufe3.fenster >= 2 ** 20 && stufe3.fenster <= ZSTD_MAX_FENSTER, `Fenster ${stufe3.fenster}`);
  assert.equal(stufe3.woerterbuch, 0);
  // ein Segment: das Fenster ist der ganze Inhalt
  assert.equal(zstdKopf(zst(Buffer.from("klein"))).fenster, 5);
  // Wörterbuch-ID im Kopf (von Hand gesetzt)
  const k = zst(Buffer.from("x"));
  const mitWb = new Uint8Array([...k.subarray(0, 4), (k[4] & ~3) | 1, ...(k[4] & 32 ? [] : [k[5]]), 7, ...k.subarray(k[4] & 32 ? 5 : 6)]);
  assert.equal(zstdKopf(mitWb).woerterbuch, 7);
});

test("netz: kaputte, abgeschnittene und abgelehnte Zstandard-Dateien", async () => {
  const z = zst(NETZ);
  await assert.rejects(() => leseNetz(z.subarray(0, Math.floor(z.length / 2))), /Zstandard-Datei lässt sich nicht entpacken .*unvollständig oder beschädigt/);
  const kaputt = new Uint8Array(z);
  for (let i = 20; i < kaputt.length; i += 3) kaputt[i] ^= 0x5a;
  await assert.rejects(() => leseNetz(kaputt), /Zstandard-Datei lässt sich nicht entpacken/);
  // ein Fenster über 32 MiB (zstd --long): lieber ablehnen als vielleicht falsch entpacken; gestreamt,
  // sonst passt der Packer das Fenster an die bekannte Größe an
  const lang = await gestreamt(Buffer.alloc(1 << 16, 66), { [Z.ZSTD_c_windowLog]: 27, [Z.ZSTD_c_enableLongDistanceMatching]: 1 });
  assert.ok(zstdKopf(lang).fenster > ZSTD_MAX_FENSTER);
  await assert.rejects(() => text(zstdStrom(lang)), /Fenster ist 128 MiB groß \(zstd --long oder --ultra\)/);
});

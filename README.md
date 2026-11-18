# MATSim Counts Snapper

Statische Seite, die Dauerzählstellen der [Zählkarte](https://github.com/vizsim-lab/zaehlkarte)
auf die Links eines MATSim-Netzes legt, ihre Stundenwerte über gewählte Tage mittelt und eine
`counts.xml` im Format `counts_v2` schreibt. Geprüft werden kann auch auf einem OSM-Auszug
(`.osm.pbf`): Die Zuordnung trägt dann einen Anker, der sich auf jede Version eines MATSim-Netzes
übertragen lässt, statt nach jeder Überarbeitung des Netzes neu zu prüfen. Alles läuft im Browser;
ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner nicht.

Ohne Angabe lädt die Seite ein Beispiel: das alte Berliner Netz aus matsim-libs und die Berliner
Detektoren der Verkehrsinformationszentrale.

## Ablauf

1. **Netz:** `network.xml` (auch `.xml.gz`) von der Festplatte oder aus dem VSP-SVN, gern mit den
   Link-Geometrien (`…-linkGeometries.csv`, wie MATSims SUMO-Konverter sie schreibt) oder dem
   Attribut `origgeom`. Gelesen wird wie in [kachelwerk](https://github.com/vizsim-lab/kachelwerk);
   Links ohne `modes` gelten wie in MATSim als `car`, pt-Links bleiben aus der Karte. Das CRS kommt
   aus dem Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. Oder ein OSM-Auszug
   (`.osm.pbf`), siehe [unten](#osm-auszug-und-übernahme-auf-ein-anderes-netz).
2. **Zählstellen:** die Dauerzählstellen der Zählkarte im Gebiet des Netzes, die eine Richtung
   zählen und aus einer Quelle mit Lizenz stammen. Je Gruppe der Zählkarte (`kfz`, `lkw`, `sv`,
   `rad`, `fuss`) lässt sich wählen, ob sie mitkommt, unter welchem `networkMode` sie in die
   counts.xml geht und welche Modi ihr Link erlauben muss. Vorgabe: Kfz als `car`, Rad als `bike`.
3. **Prüfen:** Für jede Stelle sucht die Seite Links im Umkreis (Vorgabe 50 m), die das
   Verkehrsmittel erlauben und deren Richtung höchstens 60° von der Fahrtrichtung der Stelle
   abweicht (liegt keiner so nah, der nächste unter 90°, zum Prüfen). Der nächste gewinnt; jeder Link geht je Verkehrsmittel nur an eine Stelle, das beste
   Paar zuerst. Eine Kfz- und eine Rad-Stelle dürfen sich also einen Link teilen.
   Ein passender Straßenname zählt wie 10 m weniger Abstand. Auf der Karte und in der Liste lässt
   sich jede Zuordnung bestätigen, durch einen anderen Link ersetzen oder auslassen.
4. **Mitteln:** je Stunde über gewählte Wochentage, einen Zeitraum und, für Montag bis Freitag,
   Schultage, Ferien- oder Feiertage nach dem Ferienkalender der Zählkarte; als Mittel oder Median,
   mit einer Mindestzahl an Tagen je Stunde. Vorgabe wie MATSims `CreateCountsFromBAStData`:
   Dienstag bis Donnerstag, Mittel, dazu nur Schultage und mindestens 5 Tage.
5. **Ausgeben:** `counts.xml` oder `.xml.gz`, dazu die Zuordnung als CSV (bei einem OSM-Auszug
   nur sie).

### Welche Stellen zum Prüfen markiert sind

- Die Quelle nennt nur ein Ziel („Richtung Lindau“) und keine Himmelsrichtung. Liegen zwei solche
  Stellen am selben Ort (je Fahrtrichtung eine), tauscht ein Knopf ihre Links.
- Der Link liegt mehr als 20 m entfernt, oder seine Richtung weicht mehr als 35° ab.
- Kein Link liegt innerhalb der 60° um die genannte Richtung. Dann nimmt die Seite den nächsten
  unter 90°: Er liegt näher an der genannten Richtung als seine Gegenrichtung, und viele Quellen
  nennen nur eine grobe Himmelsrichtung (die Berliner Detektoren etwa „Ost“ an der Potsdamer
  Straße, die dort nach Nordnordost läuft).
- Der nächste Link ist an eine andere Stelle vergeben; die Seite nennt sie. Oft ist das ein
  zweiter Messquerschnitt derselben Richtung, etwa die Busspur neben der Hauptfahrbahn – die
  Fahrstreifen stehen bei der Stelle.

Tasten: `n` nächste Stelle zum Prüfen, `p` passt, `w` Link auf der Karte wählen, `a` auslassen,
`Esc` bricht das Wählen ab. Liegen an einer Stelle der Karte mehrere Links übereinander (Hin- und
Rückrichtung), fragt die Seite, welcher gemeint ist. Ab Zoom 14 liegen die beiden Richtungen
nebeneinander, jede auf ihrer rechten Seite.

Entscheidungen merkt sich der Browser je Netz. Weitergeben, versionieren und auf ein anderes Netz
übertragen lassen sie sich als CSV.

## OSM-Auszug und Übernahme auf ein anderes Netz

Wird ein MATSim-Netz überarbeitet, ändern sich Link-IDs, und die geprüfte Zuordnung wäre neu zu
machen. Darum lässt sie sich einmal auf OSM prüfen (oder auf einer Netzversion) und dann auf jede
neue Version übertragen.

**OSM lesen.** Die Seite liest `.osm.pbf` selbst, ohne Bibliothek: Blobs mit zlib (der Browser
entpackt sie), darin Protobuf, in zwei Durchgängen – erst die Wege, die der Filter behält, dann nur
deren Knoten. Jeder Weg wird an jedem Knoten geteilt, den er mit einem anderen teilt; die Kanten
heißen wie bei SUMO `Weg-ID#Abschnitt`, die Gegenrichtung mit Minus (`-123#0`). Verkehrsmittel und
Richtung kommen aus den Tags: `car` auf den Straßenklassen ohne Sperre, `bike` dazu auf Radwegen und
freigegebenen Wegen (nicht auf Autobahnen, Kraftfahrstraßen und bei `bicycle=no|use_sidepath`),
Einbahnen samt `oneway:bicycle=no` und `cycleway=opposite*`, Kreisverkehre und Autobahnen als
Einbahn. Filter beim Lesen:

| Filter | behält |
| --- | --- |
| Straßen und Radwege (Vorgabe) | `motorway` bis `living_street` ohne `service`, dazu Radwege und für Rad freigegebene Wege |
| wie matsim-berlin | der Filter aus dem Makefile von matsim-berlin fürs Szenariogebiet: `motorway` bis `tertiary` (ohne `tertiary_link`), `residential`, `living_street`, `unclassified`, `cycleway`, dazu alles mit `bicycle=designated` |
| nur Hauptstraßen | `motorway` bis `tertiary` samt Rampen, für große Gebiete |
| alle Wege, auch zu Fuß | jeder Weg mit `highway=*` außer geplanten, Bahnsteigen und Ähnlichem; zu Fuß als `walk` |

Ein Stadtauszug geht gut. Eine Testdatei mit 69 MB (10 Mio. Knoten, 450 000 Kanten) liest Node in
etwa 7 s; in Chrome dauert es vom Wählen bis zur gezeichneten Karte gut eine halbe Minute. Größere
Gebiete vorher zuschneiden:

```sh
osmium extract -p gebiet.poly deutschland.osm.pbf -o gebiet.osm.pbf
osmium tags-filter gebiet.osm.pbf w/highway -o gebiet-strassen.osm.pbf
```

Nur zlib-komprimierte Dateien (wie bei Geofabrik); andere schreibt
`osmium cat ein.osm.pbf -o aus.osm.pbf -f pbf,pbf_compression=zlib` um. Dateien mit der Lage an
den Wegen (`osmium add-locations-to-ways`) gehen auch. Aus OSM gibt es keine `counts.xml`, nur die
Zuordnung. Daten © OpenStreetMap-Mitwirkende, [ODbL](https://www.openstreetmap.org/copyright).

**Der Anker.** Die Zuordnungs-CSV trägt je Stelle mit Link den Punkt auf dem Link, der der Stelle am
nächsten liegt (WGS 84), die Richtung des Links dort und, wenn bekannt, den OSM-Weg – mit Minus,
wenn es gegen die Zeichenrichtung geht. Der Anker liegt auf der Fahrbahn; die Rohkoordinate der
Zählstelle liegt oft daneben.

**Übernehmen.** „Zuordnung laden“ überträgt jede geprüfte Zuordnung über ihren Anker, der Reihe nach:

1. dieselbe Link-ID, höchstens 5 m vom Anker
2. ein Link desselben OSM-Wegs, höchstens 25 m vom Anker (Geometrien aus OSM und MATSim weichen
   ab). Den Weg kennt die Seite bei SUMO-Netzen aus der Link-ID (`123#0`, `-123#2`; gilt, wenn
   mindestens 30 % der IDs so aussehen), sonst aus den Attributen `osm:way:id` (pt2matsim) oder
   `origid`. Das Netz zeigt an, an wie vielen Links es einen Weg gefunden hat.
3. der einzige passende Link am Anker: der nächste höchstens 5 m, der zweite mindestens 5 m weiter

Immer nur Links mit dem Verkehrsmittel der Stelle und höchstens 45° Abweichung von der Richtung am
Anker; je Verkehrsmittel trägt ein Link eine Stelle. Was so übernommen ist, gilt als geprüft und
zeigt, woher und wie. Der Rest kommt zum Prüfen, mit Grund, und wird vom Anker aus gesucht statt von
der Zählstelle. Typisch dafür: Rad-Zählstellen auf einem eigenen Radweg, den das MATSim-Netz nicht
hat oder mit der Straße zusammenlegt. Das geht in jede Richtung – OSM auf MATSim, eine Netzversion
auf die nächste, MATSim auf OSM. Eine CSV ohne Anker (ältere Fassung, MATSims `counts-mapping`)
gilt weiter über die Link-ID.

## Daten der Zählkarte

Die Seite liest `dauer/index.json` und, für die Stundenwerte, `dauer/{n}.json` aus
`https://vizsim-lab.github.io/zaehlkarte/data/` (Version 5 dieser Dateien). Die Stundenwerte
reichen dort je Quelle über ihre jüngsten 12 Monate, also je Quelle über einen anderen Zeitraum:
bei den Berliner Detektoren etwa Juli 2024 bis Juni 2025, bei den Berliner Rad-Zählstellen das
Jahr 2025 (die Quelle ergänzt einmal im Jahr). Ohne Angabe von „von“ und „bis“ nimmt die Seite für
jede Stelle alle Tage, die sie hat; ein gemeinsamer Zeitraum lässt sich einstellen.

Kurzzeitzählungen bleiben draußen: Die Zählkarte veröffentlicht sie als Summe über alle
Richtungen, und eine MATSim-Messstelle hängt an genau einem gerichteten Link. Aus demselben Grund
fehlen die meisten Rad-Zählstellen, die beide Richtungen zusammen zählen. Gerichtet sind etwa die
Berliner Detektoren, die Dauerzählstellen in Baden-Württemberg und Bayern und ein Teil der
Hamburger Stellen.

Die Berliner Rad-Zählstellen nennen ihre Richtung in den Daten bis November 2026 nicht im Feld
`richtung`, sondern im Namen („Jannowitzbrücke Nord“) oder in der Kennung („01-MI-AL-W“). Berlin
führt sie als Richtungszählstellen, je Fahrtrichtung eine; die Seite liest die Richtung darum für
diese Quelle aus Name oder Kennung, solange das Feld leer ist. So kommen 23 der 33 Stellen hinein;
die übrigen nennen keine Richtung. Die Zählkarte füllt das Feld künftig selbst
([zaehlkarte#44](https://github.com/vizsim-lab/zaehlkarte/pull/44)).

Die Zählkarte rechnet nichts um und füllt nichts auf; das gilt hier auch: Nicht gezählte Stunden
bleiben leer, Tage mit doppelter Stunde 2–3 Uhr (Zeitumstellung) bleiben draußen, und es gibt
keine Hochrechnung. Berlins `lkw` ist die Klasse des Detektors, nicht der Schwerverkehr.

## Ausgabe

### counts.xml

Nach [`counts_v2.xsd`](https://github.com/matsim-org/matsim-libs/blob/main/matsim/src/main/resources/dtd/counts_v2.xsd):

- `<location refId="Link" id="Station" name="Straße" x="…" y="…">`, die Koordinaten der Stelle
  im CRS des Netzes
- je Gruppe `<measurements type="volumes" networkMode="car" interval="3600">` mit
  `<value t="…" val="…"/>`; `t` ist der Beginn der Stunde in Sekunden (0 = 0 bis 1 Uhr)
- in den `attributes` der Stelle: Quelle, Lizenz, Abschnitt, Richtung, Abstand und Abweichung zum
  Link, ob die Zuordnung geprüft oder automatisch ist, die Zahl der Tage je Gruppe, der Kommentar
- in den `attributes` der Datei: die Auswahl in MATSims Schreibweise (`--aggregate`, etwa
  `auswahl=TUESDAY,WEDNESDAY,THURSDAY@2024-07-01:2025-06-30`), Statistik, Mindesttage, Gruppen,
  Netz, Stand der Zählkarte und je Quelle Lizenz und Quellenvermerk

Ohne Werte in der Auswahl kommt eine Gruppe nicht hinein; ebenso ein Tagesgang ohne alle 24
Stunden, solange „Nur ganze Tagesgänge“ gewählt ist (wie in MATSims BASt-Werkzeug). MATSim
erlaubt je Link nur eine Messstelle und je Messstelle ein Verkehrsmittel nur einmal: Gehen zwei
Gruppen einer Stelle auf denselben `networkMode`, kommt nur die erste hinein.

Teilen sich eine Kfz- und eine Rad-Stelle einen Link, stehen beide in einer Messstelle:
`id="berlin_rad:20-TS-MAR-N+berlin_viz:TE014"`, die Namen mit „ / “ verbunden, das Attribut
`stellen` mit beiden Kennungen, und die Angaben jeder Stelle tragen ihr Verkehrsmittel als Endung
(`quelle_bike`, `quelle_car`, `abstand_m_car`, …).

### Zuordnung als CSV

Getrennt mit `;`, im Format von MATSims `CountsOptions` (`--counts-mapping`):

```
station;linkid;using;kommentar;zuordnung;abstand_m;richtung;name;quelle;anker_lon;anker_lat;anker_grad;osm_weg;netz
berlin_viz:TE010;7279;y;;geprüft;49.2;Richtung stadtauswärts (Südwest);Marienfelder Allee;berlin_viz;13.3712345;52.4123456;214;;berlin-network.xml.gz
```

`using` ist `y` für jede Stelle mit Link und leer für ausgelassene. `zuordnung` sagt, wie der Link
zustande kam: `geprüft`, `automatisch`, `ausgelassen` oder `ohne Link`. Dahinter der Anker: Punkt
auf dem Link (WGS 84), Richtung des Links dort (Grad ab Nord), OSM-Weg und das Netz, zu dem die
`linkid` gehört. MATSim übergeht diese Spalten. Wieder eingelesen überträgt die CSV die geprüften
Links über den Anker (siehe oben) und stellt die ausgelassenen Stellen her; die übrigen sucht die
Seite neu. Eine CSV ohne die Spalte `zuordnung`, etwa `input/counts_mapping.csv` aus dem Berliner
Szenario, gilt ganz, so wie MATSim sie liest.

## Lizenzen der Daten

In die Ausgabe kommen nur Quellen mit Lizenz, wie beim CSV-Export der Zählkarte. Ihre
Bedingungen gelten auch für die counts.xml; unter den gerichteten Quellen ist das vor allem
CC BY-NC 4.0 bei Ettlingen, die übrigen stehen unter dl-de/by-2-0 oder GeoNutzV. Die Seite zeigt
die Lizenzen der Stellen, die hineingehen, markiert Einschränkungen und schreibt alles in die Datei.

## Adresse

Die Adresszeile zeigt auf das geladene Netz und lässt sich teilen, zum Beispiel:

<https://vizsim-lab.github.io/matsim-counts-snapper/?net=kelheim/kelheim-v3.0/input/kelheim-v3.0-network-with-pt.xml.gz>

- `net`: ein Netz, als Pfad unter `countries/de/` im VSP-SVN oder volle Adresse
- `geo`: die Geometrie-Datei, vom Ordner des Netzes aus oder als volle Adresse, `0` für keine;
  fehlt der Parameter, sucht die Seite neben dem Netz und im `input`-Ordner seines Szenarios
- `crs`: nur nötig, wenn das Netz keins nennt und es nicht `EPSG:25832` ist
- `daten`: ein anderer Ort für die Daten der Zählkarte (Ordner mit `dauer/`)

## Hosten

Kein Build-Schritt: Die Seite muss nur über HTTP laufen, weil der Worker ein ES-Modul ist.

```sh
python3 -m http.server 8000   # dann http://localhost:8000
```

GitHub Pages reicht. Andere Server fragt die Seite nur an für die Daten der Zählkarte
(`vizsim-lab.github.io`), das Beispielnetz (`raw.githubusercontent.com`), Netze aus dem VSP-SVN
(`svn.vsp.tu-berlin.de`) und die Hintergrundkarte (`tiles.openfreemap.org`, außer bei „Ohne“).

## Dateien

- `index.html`: Oberfläche
- `app.js`: Karte, Ablauf, Prüfen, Mitteln, Ausgabe
- `worker.js`: hält das Netz, zeichnet es als GeoJSON und sucht Links zu den Stellen
- `lib/netz.js`: MATSim-Netz und Link-Geometrien lesen (aus kachelwerk)
- `lib/osm.js`: `.osm.pbf` lesen, Wege filtern und in gerichtete Kanten teilen
- `lib/uebertrag.js`: eine Zuordnung über ihren Anker auf ein anderes Netz übertragen
- `lib/crs.js`: Koordinatensysteme (proj4), auch MATSim-Namen wie `DHDN_GK4`
- `lib/zuordnung.js`: Raster über die Links, Kandidaten, jeder Link nur einmal
- `lib/richtung.js`: die Richtung aus dem Text der Zählkarte
- `lib/zaehlkarte.js`: `dauer/index.json` und die Stundenwerte lesen, Ferienkalender
- `lib/mitteln.js`: Tage wählen, Mittel oder Median
- `lib/counts.js`: counts.xml schreiben, Zuordnungs-CSV schreiben und lesen
- `vendor/`: MapLibre GL JS, proj4, Schriften
- `tests/`: Tests der Bausteine, `npm test` (Node 20 oder neuer, ohne Abhängigkeiten)

## Offen

- Kurzzeitzählungen, sobald die Zählkarte Werte je Richtung und Knotenarm ausgibt
- Stellen, die beide Richtungen zusammen zählen
- Stundenwerte über ganze Jahre (die Zählkarte gibt für die Karte nur die jüngsten 12 Monate aus)
- die Sonderregel für die Berliner Rad-Zählstellen streichen, sobald die Zählkarte das Feld
  `richtung` füllt (zaehlkarte#44) und neu gebaut hat
- Netze aus MATSims `OsmNetworkReader` tragen keinen OSM-Weg: Übernahme dort nur über ID und Lage
- den Netz-Leser mit kachelwerk teilen statt ihn zu kopieren

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

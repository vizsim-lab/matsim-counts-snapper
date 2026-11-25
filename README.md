# MATSim Counts Snapper

Statische Seite, die Dauerzählstellen der [Zählkarte](https://github.com/vizsim-lab/zaehlkarte)
auf die Links eines MATSim-Netzes legt, ihre Stundenwerte über gewählte Tage mittelt und eine
`counts.xml` im Format `counts_v2` schreibt. Wahlweise kommen Kurzzeitzählungen dazu, je Knotenarm
als Zu- und Ausfahrt und je Querschnitt als Fahrtrichtung, in eine eigene `counts-kurzzeit.xml`
(siehe [unten](#kurzzeitzählungen)). Geprüft werden kann auch auf einem OSM-Auszug
(`.osm.pbf`): Die Zuordnung trägt dann einen Anker, der sich auf jede Version eines MATSim-Netzes
übertragen lässt, statt nach jeder Überarbeitung des Netzes neu zu prüfen. Alles läuft im Browser;
ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner nicht.

Ohne Angabe lädt die Seite ein Beispiel: das alte Berliner Netz aus matsim-libs und die Berliner
Detektoren der Verkehrsinformationszentrale.

## Ablauf

1. **Netz:** `network.xml` (auch `.xml.gz` oder `.xml.zst`) von der Festplatte oder aus dem
   VSP-SVN, gern mit den Link-Geometrien (`…-linkGeometries.csv`, wie MATSims SUMO-Konverter sie
   schreibt, auch gepackt) oder dem Attribut `origgeom`. Zur [Kompression](#gepackte-dateien)
   unten mehr. Gelesen wird wie in [kachelwerk](https://github.com/vizsim-lab/kachelwerk);
   Links ohne `modes` gelten wie in MATSim als `car`, pt-Links bleiben aus der Karte. Das CRS kommt
   aus dem Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. „Atlantis“ zählt als
   keins: So schreibt MATSim das Attribut, wenn in der Config `global.coordinateSystem` fehlt; die
   Koordinaten stimmen oft trotzdem, und die Seite nimmt das CRS aus dem Formular, mit Hinweis. Oder ein OSM-Auszug
   (`.osm.pbf`), siehe [unten](#osm-auszug-und-übernahme-auf-ein-anderes-netz). Das Formular zeigt
   nur, was für das geladene Netz gilt: das CRS bei einem MATSim-Netz, die Auswahl der Wege bei
   einem OSM-Auszug. Hierher lässt sich auch eine [Konfiguration](#konfiguration) ziehen, gern
   zusammen mit ihrem Netz.
2. **Zählstellen:** die Dauerzählstellen der Zählkarte im Gebiet des Netzes, die eine Richtung
   zählen und aus einer Quelle mit Lizenz stammen; die ohne Richtung nur zum Ansehen (siehe
   [unten](#daten-der-zählkarte)). Mit geladenem Netz nennt der Schritt die Zahl der Stellen und
   Quellen in seinem Gebiet, ganz Deutschland nur in Klammern. Ein [Gebiet](#gebiet), gezeichnet
   oder aus einer Datei, beschränkt die Stellen weiter. Je Gruppe der Zählkarte (`kfz`, `lkw`, `sv`,
   `rad`, `fuss`) lässt sich wählen, ob sie mitkommt, unter welchem `networkMode` sie in die
   counts.xml geht und welche Modi ihr Link erlauben muss. Vorgabe: Kfz als `car`, Rad als `bike`.
   Erlaubt im Netz kein Link das Verkehrsmittel einer Gruppe, sagt die Seite, welche das Netz kennt;
   heißt es dort nur anders (`bicycle` statt `bike`), stellt ein Klick die Gruppe um.
   Darunter lassen sich die Kurzzeitzählungen dazunehmen.
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
5. **Ausgeben:** `counts.xml` oder `.xml.gz`, mit Kurzzeitzählungen dazu `counts-kurzzeit.xml`,
   die Zuordnung als CSV (bei einem OSM-Auszug nur sie) und die [Konfiguration](#konfiguration):
   Netz, Datenstand, alle Einstellungen und die Entscheidungen von Hand.

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
jede Stelle alle Tage, die sie hat; ein gemeinsamer Zeitraum lässt sich einstellen. Für die
Kurzzeitzählungen liest sie `manifest.json` (Lizenzen der Lieferungen, welche Jahre es gibt),
`index.json` (Lage, Name und Art der Stellen) und je Quelle und Jahr `stroeme/{quelle}-{jahr}.json`
(Version 1 dieser Dateien), nur die Jahre der Auswahl.

Eine MATSim-Messstelle hängt an genau einem gerichteten Link. Stellen, die beide Richtungen
zusammen zählen oder keine nennen (die meisten Rad-Zählstellen, in Berlin etwa der Schwedter Steg),
passen auf keinen. Die Seite zeigt sie trotzdem: violett auf der Karte, in der Liste unter „Beide
Richtungen“, mit ihrem Tagesgang (der Summe beider Richtungen). Sie sucht für sie aber keinen Link,
und sie gehen weder in die counts.xml noch in die Zuordnung. Gerichtet sind etwa die Berliner
Detektoren, die Dauerzählstellen in Baden-Württemberg und Bayern und ein Teil der Hamburger
Stellen.

Die Richtung kommt nur aus dem Feld `richtung`, für alle Quellen gleich; aus Namen oder Kennungen
liest die Seite keine. Die Berliner Rad-Zählstellen (Richtungszählstellen, je Fahrtrichtung eine)
tragen sie dort seit [zaehlkarte#44](https://github.com/vizsim-lab/zaehlkarte/pull/44): Mit den
Daten vom 23.11.2026 sind 23 der 33 Stellen gerichtet, die übrigen 10 nennen keine Richtung und
werden nur angezeigt.

Die Zählkarte rechnet nichts um und füllt nichts auf; das gilt hier auch: Nicht gezählte Stunden
bleiben leer, Tage mit doppelter Stunde 2–3 Uhr (Zeitumstellung) bleiben draußen, und es gibt
keine Hochrechnung. Berlins `lkw` ist die Klasse des Detektors, nicht der Schwerverkehr.

## Gebiet

Ohne Gebiet zählen alle Stellen im Rechteck um die Links des Netzes. MATSim-Netze reichen meist
weit über das Untersuchungsgebiet hinaus; ein Gebiet in Schritt 2 beschränkt die Auswahl auf die
Stellen darin, die Dauerzählstellen wie die Kurzzeitzählungen, jeweils nach der Lage der Stelle.

- **Zeichnen:** auf der Karte die Ecken klicken; ein Doppelklick, Enter oder ein Klick auf die erste
  Ecke schließt das Gebiet, ⌫ nimmt die letzte Ecke zurück, Esc bricht ab. Die Ecken eines
  gezeichneten Gebiets lassen sich danach verschieben.
- **Laden:** GeoJSON (Polygon oder MultiPolygon, auch als FeatureCollection; ein anderes CRS über
  das alte Feld `crs`), die `.poly`-Datei von osmium und Osmosis (wie für `osmium extract -p`)
  oder ein Shapefile, gezippt oder als `.shp` mit `.prj`. Das CRS des Shapefiles kommt aus der
  `.prj`; bekannte Systeme (ETRS89/UTM, WGS 84/UTM, DHDN/Gauß-Krüger) rechnet die Seite mit ihren
  eigenen Definitionen samt Datumsverschiebung, andere mit der WKT. Ohne Angabe gelten Grad als
  WGS 84, sonst das CRS des Netzes, mit Hinweis. Mehrere Flächen und Löcher gehen. Mit mehr als
  2.000 Punkten vereinfacht die Seite das Gebiet auf 2 m genau, damit der Test je Stelle schnell
  bleibt.

Draußen ist die Karte abgedunkelt. Der Browser merkt sich das Gebiet; die
[Konfiguration](#konfiguration) trägt es (als GeoJSON), und die counts.xml nennt es in ihren
Angaben (`gebiet`). Entscheidungen für Stellen außerhalb bleiben gespeichert.

## Kurzzeitzählungen

Berlin zählt an Tausenden Knoten und Querschnitten von Hand, je Stelle an einem Tag, meist von 7
bis 19 Uhr. Das ist eine Momentaufnahme, aber das Netz der Stellen ist so dicht wie keine
Dauerzählung. Die Zählkarte gibt die Werte je Strom aus (`stroeme/{quelle}-{jahr}.json`, ab
[zaehlkarte#45](https://github.com/vizsim-lab/zaehlkarte/pull/45)), je Strom von Arm zu Arm, und
den Winkel jedes Arms. Daraus macht die Seite Punkte mit Richtung:

- **Knoten:** je Arm eine **Zufahrt** (die Summe der Ströme vom Arm, Richtung zum Knoten hin) und
  eine **Ausfahrt** (die Summe der Ströme zum Arm, vom Knoten weg), beide 25 m vom Knoten auf dem
  Arm (einstellbar). Eine Wende zählt in beiden. Ein Arm-Punkt sucht Links nur bis 5 m vor den
  Knoten, sonst fände er die Links der anderen Arme. Ein Arm ohne Winkel bekommt keine Punkte.
- **Querschnitt:** je Fahrtrichtung ein Punkt an der Stelle, Richtung zum Arm, zu dem es geht.
  Nennt die Zählung für ihn keinen Winkel, gilt die Gegenrichtung des Arms, von dem es kommt;
  sonst bleibt der Punkt ohne Richtung und kommt zum Prüfen (ein Knopf tauscht die Links der beiden
  Richtungen).
- Jeder Punkt liegt 3 m rechts seiner Fahrtrichtung, wie im Rechtsverkehr: Zufahrt und Ausfahrt
  liegen nicht aufeinander, und bei getrennten Fahrbahnen liegt der Punkt näher an der richtigen.
- Die Richtung des Links darf wie bei den Dauerzählstellen höchstens 60° abweichen, aber ohne den
  Rückfall auf Links unter 90°: Die Winkel der Arme sind genauer als die Himmelsrichtungen der
  Dauerzählstellen (an den Berliner Armen mit Himmelsrichtung im Namen liegen 98 % höchstens 45°
  neben ihr).

**Welche Zählung.** Je Stelle und Gruppe die jüngste, die passt: Jahre (Vorgabe ab 2019),
Wochentage (Vorgabe Dienstag bis Donnerstag), für Montag bis Freitag die Art des Tages aus dem
Ferienkalender der Zählkarte (Vorgabe Schultage) und mindestens so viele gezählte Stunden der Gruppe
(Vorgabe 12, das Fenster 7–19 Uhr). Vorgabe ist nur Kfz: Rad schwankt an einem einzelnen Tag
stärker. Liegen am selben Tag zwei Zählungen an einer Stelle (Berlin legt manche in zwei Dateien
ab, 7–9 und 15–18 Uhr, oder je Gehweg eine), gilt die mit mehr gezählten Stunden; die andere nennt
die Seite. Eine Stunde ist nur gezählt, wenn jeder Strom des Punkts einen Wert hat; nichts wird
aufgefüllt, hochgerechnet oder über Tage gemittelt.

**Wie stark ein Tag streut**, an den Berliner Dauerzählstellen gemessen (ein Schultag Di–Do,
7–19 Uhr, gegen das Mittel aller Schultage der Stelle): Kfz im Median 6 %, an 90 % der Tage
höchstens 24 %; Rad im Median 21 %, höchstens 45 %.

**Dauerzählstellen gehen vor.** Erst bekommen die Dauerzählstellen ihre Links, dann die
Kurzzeit-Punkte die übrigen; je Link und Verkehrsmittel trägt jede Familie eine Stelle. Von Hand
darf ein Kurzzeit-Punkt auch auf den Link einer Dauerzählstelle; die Seite sagt es dann, und beide
gehen in ihre eigene Datei.

**Lieferungen und Lizenzen.** Berlin hat zweimal geliefert: 2019–2025 unter dl-de/by-2-0, 1990–2019
unter CC BY-SA 3.0 DE. Lieferungen unter CC BY-SA sind aus, bis man sie einschaltet: Deren
Bedingung, die Weitergabe unter gleicher Lizenz, gälte für die ganze Datei. Ist die Lage einer
Stelle aus OpenStreetMap geokodiert (Straßenkreuzung, vor allem bei älteren Zählungen), kommt die
ODbL dazu; der Punkt kann dann an der Kreuzung liegen statt an der Zählstelle.

**Die Liste** zeigt mit Kurzzeitzählungen schnell Tausende Punkte. Ein Filter wählt Dauer oder
Kurzzeit; angezeigt werden die ersten 400, die gewählte Stelle immer. Auf der Karte sind
Kurzzeit-Punkte Ringe, gestrichelt mit ihrem Knoten verbunden.

## Ausgabe

### counts.xml

Nach [`counts_v2.xsd`](https://github.com/matsim-org/matsim-libs/blob/main/matsim/src/main/resources/dtd/counts_v2.xsd):

- `<location refId="Link" id="Station" name="Straße" x="…" y="…">`, die Koordinaten der Stelle
  im CRS des Netzes (auch bei einer übertragenen Zuordnung die der Stelle, nicht die des Ankers)
- je Gruppe `<measurements type="volumes" networkMode="car" interval="3600">` mit
  `<value t="…" val="…"/>`; `t` ist der Beginn der Stunde in Sekunden (0 = 0 bis 1 Uhr)
- in den `attributes` der Stelle: Quelle, Lizenz, Abschnitt, Richtung, Abstand und Abweichung zum
  Link, ob die Zuordnung geprüft oder automatisch ist, die Zahl der Tage je Gruppe, der Kommentar
- in den `attributes` der Datei: die Auswahl in MATSims Schreibweise (`--aggregate`, etwa
  `auswahl=TUESDAY,WEDNESDAY,THURSDAY@2024-07-01:2025-06-30`), Statistik, Mindesttage, Gruppen,
  Netz, das [Gebiet](#gebiet), wenn eins gewählt ist, Stand der Zählkarte und je Quelle Lizenz und
  Quellenvermerk

Ohne Werte in der Auswahl kommt eine Gruppe nicht hinein; ebenso ein Tagesgang ohne alle 24
Stunden, solange „Nur ganze Tagesgänge“ gewählt ist (wie in MATSims BASt-Werkzeug). MATSim
erlaubt je Link nur eine Messstelle und je Messstelle ein Verkehrsmittel nur einmal: Gehen zwei
Gruppen einer Stelle auf denselben `networkMode`, kommt nur die erste hinein.

Teilen sich eine Kfz- und eine Rad-Stelle einen Link, stehen beide in einer Messstelle:
`id="berlin_rad:20-TS-MAR-N+berlin_viz:TE014"`, die Namen mit „ / “ verbunden, das Attribut
`stellen` mit beiden Kennungen, und die Angaben jeder Stelle tragen ihr Verkehrsmittel als Endung
(`quelle_bike`, `quelle_car`, `abstand_m_car`, …).

### counts-kurzzeit.xml

Gleicher Aufbau, aber je Messstelle ein gezählter Tag: nur die gezählten Stunden, `t` ist der Beginn
der Stunde. `counts_v2` erlaubt Attribute nur je Messstelle, nicht je Messung; dort steht, was die
Werte sind:

| Attribut | Beispiel |
| --- | --- |
| `zaehlart` | `kurzzeit` (auch an der Datei) |
| `stelle`, `zaehlung` | `berlin:K2`, `K0000002_20231019` |
| `datum`, `wochentag`, `tagtyp` | `2023-10-19`, `Do`, `Schultag` |
| `fenster` | `7–19` |
| `art`, `arm`, `seite` | `Knoten`, `1 Oranienburger Chaussee (NW)`, `Ausfahrt` |
| `stroeme`, `richtung_grad` | `2→1, 3→1, 4→1`, `325` |
| `quelle`, `lizenz`, `lage` | `berlin`, `dl-de/by-2-0`, `gps` |
| `abstand_m`, `abweichung_grad`, `zuordnung`, `kommentar` | wie in der counts.xml |

MATSim liest die Attribute, beachtet sie aber nicht. Darum eine eigene Datei: Eine Tagessumme ist
hier nur die Summe des Zählfensters, also nach Stunden vergleichen, nicht über den Tag. Teilen sich
zwei Punkte einen Link (etwa Kfz aus einer Zählung, Rad aus einer anderen), stehen sie wie bei den
Dauerzählstellen in einer Messstelle.

### Zuordnung als CSV

Getrennt mit `;`, im Format von MATSims `CountsOptions` (`--counts-mapping`):

```
station;linkid;using;kommentar;zuordnung;abstand_m;richtung;name;quelle;anker_lon;anker_lat;anker_grad;osm_weg;netz;zaehlart
berlin_viz:TE010;7279;y;;geprüft;49.2;Richtung stadtauswärts (Südwest);Marienfelder Allee;berlin_viz;13.3712345;52.4123456;214;;berlin-network.xml.gz;dauer
berlin:K2/K0000002_20231019/1aus;2422;y;;geprüft;0.4;Ausfahrt in Arm 1 „Oranienburger Chaussee (NW)“;Oranienburger Ch. / Zeltinger Straße- Rauentaler Straße- Am Pilz;berlin;13.3013037;52.6434265;330;;berlin-network.xml.gz;kurzzeit
```

`using` ist `y` für jede Stelle mit Link und leer für ausgelassene. `zuordnung` sagt, wie der Link
zustande kam: `geprüft`, `automatisch`, `ausgelassen` oder `ohne Link`. Dahinter der Anker: Punkt
auf dem Link (WGS 84), Richtung des Links dort (Grad ab Nord), OSM-Weg und das Netz, zu dem die
`linkid` gehört, und `zaehlart` (`dauer` oder `kurzzeit`; ein Kurzzeit-Punkt heißt
`Stelle/Zählung/Arm`, etwa `…/1zu` für die Zufahrt aus Arm 1 und `…/nach2` für die Richtung zu Arm 2
eines Querschnitts). MATSim übergeht diese Spalten. Wieder eingelesen überträgt die CSV die geprüften
Links über den Anker (siehe oben) und stellt die ausgelassenen Stellen her; die übrigen sucht die
Seite neu. Eine CSV ohne die Spalte `zuordnung`, etwa `input/counts_mapping.csv` aus dem Berliner
Szenario, gilt ganz, so wie MATSim sie liest.

### Konfiguration

`…-snapper-konfiguration.json` hält fest, wie eine Ausgabe entstand, und lässt sich wieder
einlesen (Schritt 5, „Konfiguration laden“, oder in das Feld von Schritt 1 ziehen):

```json
{
  "format": "matsim-counts-snapper/konfiguration",
  "version": 1,
  "erstellt": "2026-11-25T10:07:46.330Z",
  "netz": { "name": "berlin-network.xml.gz", "url": "https://…", "art": "matsim", "crs": "EPSG:31468",
            "crs_aus_datei": false, "links": 27664, "gebiet": [11.27297, 50.32298, 14.97004, 54.30024] },
  "daten": { "adresse": "https://vizsim-lab.github.io/zaehlkarte/data/",
             "dauer": { "erzeugt": "2026-11-23", "version": 5 }, "kurzzeit": { "erzeugt": "2026-11-18" } },
  "einstellungen": { "crs": "…", "osm_filter": "…", "suche": { "radius_m": 50, "max_winkel_grad": 60 },
                     "gruppen": { "kfz": { "an": true, "network_mode": "car", "link_erlaubt": "car" } },
                     "kurzzeit": { "an": true, "von_jahr": 2019 }, "mitteln": { "statistik": "mittel" },
                     "ausgabe": { "jahr": 2024 } },
  "ergebnis": { "netzgebiet": { "dauerzaehlstellen": 403, "quellen": 5 }, "dauer": { "stellen": 288, "geprueft": 2 } },
  "quellen": [{ "zaehlart": "dauer", "code": "berlin_viz", "lizenzen": [{ "lizenz": "dl-de/by-2-0" }] }],
  "entscheidungen": [
    { "station": "berlin_viz:TE011", "zaehlart": "dauer", "zuordnung": "geprüft", "linkid": "2437",
      "anker": { "lon": 13.3592345, "lat": 52.409723, "grad": 22 }, "osm_weg": null, "in_auswahl": true },
    { "station": "berlin_viz:TE021", "zuordnung": "ausgelassen", "linkid": null, "in_auswahl": true },
    { "station": "berlin_viz:TE022", "zuordnung": "automatisch", "kommentar": "…", "in_auswahl": true }
  ]
}
```

(gekürzt). `netz` sagt, mit welchem Netz gearbeitet wurde: Datei oder Adresse, OSM-Auszug oder
MATSim-Netz, CRS und ob es aus der Datei kam, Zahl der Links, Gebiet (WGS 84). `daten` nennt Ort
und Stand der Zählkarte, `einstellungen` alles aus den Schritten 1 bis 5 (darin `gebiet` als
GeoJSON-Feature oder `null`), `ergebnis` und `quellen` was dabei herauskam. `entscheidungen` sind nur die von Hand: geprüfte Links mit Anker, ausgelassene
Stellen und Kommentare (`automatisch` mit Kommentar); `in_auswahl: false` sind Entscheidungen für
dieses Netz, deren Stellen gerade nicht gewählt sind, etwa weil ihre Gruppe aus ist.

Wieder eingelesen gelten die Einstellungen. Das CRS gehört zum Netz: Es gilt nur für das Netz der
Konfiguration und nur, wenn es dort aus dem Formular kam; der Filter der OSM-Wege nur aus einer
Sitzung mit OSM-Auszug. Ist kein Netz geladen und kennt die Konfiguration die Adresse ihres Netzes,
lädt sie es. Die Entscheidungen gehen wie die der [Zuordnung](#zuordnung-als-csv) über den Anker
auf das geladene Netz, auch auf ein anderes oder aus OSM; die außerhalb der Auswahl nur ins selbe
Netz, denn sie tragen nur die Link-ID. Mit demselben Netz und Datenstand ergibt sich wieder dieselbe
`counts.xml`.

## Lizenzen der Daten

In die Ausgabe kommen nur Quellen mit Lizenz, wie beim CSV-Export der Zählkarte. Ihre
Bedingungen gelten auch für die counts.xml; unter den gerichteten Quellen ist das vor allem
CC BY-NC 4.0 bei Ettlingen, die übrigen stehen unter dl-de/by-2-0 oder GeoNutzV. Die Seite zeigt
die Lizenzen der Stellen, die hineingehen, markiert Einschränkungen und schreibt alles in die Datei.
Bei den Kurzzeitzählungen gilt die Lizenz der Lieferung, dazu die ODbL, wo die Lage aus
OpenStreetMap geokodiert ist (siehe oben).

## Adresse

Die Adresszeile zeigt auf das geladene Netz und lässt sich teilen, zum Beispiel:

<https://vizsim-lab.github.io/matsim-counts-snapper/?net=kelheim/kelheim-v3.0/input/kelheim-v3.0-network-with-pt.xml.gz>

- `net`: ein Netz, als Pfad unter `countries/de/` im VSP-SVN oder volle Adresse
- `geo`: die Geometrie-Datei, vom Ordner des Netzes aus oder als volle Adresse, `0` für keine;
  fehlt der Parameter, sucht die Seite neben dem Netz und im `input`-Ordner seines Szenarios
- `crs`: nur nötig, wenn das Netz keins nennt und es nicht `EPSG:25832` ist
- `daten`: ein anderer Ort für die Daten der Zählkarte (Ordner mit `dauer/`, für die
  Kurzzeitzählungen mit `manifest.json`, `index.json` und `stroeme/`)

## Gepackte Dateien

Netze und Link-Geometrien dürfen unverpackt, mit gzip (`.gz`) oder mit Zstandard (`.zst`) gepackt
sein; erkannt wird das an den ersten Bytes, nicht am Namen. MATSim schreibt `.zst`, wenn
`controller.compressionType` auf `zst` steht (die Ausgaben des Sioux-Falls-Szenarios im VSP-SVN
etwa). gzip entpackt der Browser selbst; Zstandard kann er (Stand Ende 2026) in keinem Browser,
dafür liegt [fzstd](https://github.com/101arrowz/fzstd) bei (`vendor/fzstd/`, in reinem
JavaScript). Beides geschieht als Strom: Auch ein großes Netz liegt nie ganz entpackt im
Speicher. Ein Gitter mit 434.000 Links (108 MB XML) lädt in Chrome als `.zst` in gut 5 s, als
`.gz` in knapp 5 s; das Lesen des XML kostet mehr als das Entpacken.

Zstandard-Dateien mit einem Wörterbuch (`zstd -D`) oder einem Fenster über 32 MiB (`zstd --long`,
`--ultra -21` und höher) lehnt die Seite mit einer Meldung ab, statt sie vielleicht falsch zu
entpacken; die normalen Stufen (bis 19) brauchen höchstens 8 MiB. MATSims dritte Kompression,
`lz4`, liest die Seite nicht.

## Hosten

Kein Build-Schritt: Die Seite muss nur über HTTP laufen, weil der Worker ein ES-Modul ist.

```sh
python3 -m http.server 8000   # dann http://localhost:8000
```

GitHub Pages reicht. Andere Server fragt die Seite nur an für die Daten der Zählkarte
(`vizsim-lab.github.io`; die Kurzzeitzählungen nur, wenn sie an sind: `manifest.json`,
`index.json`, je Jahr eine Datei der Ströme), das Beispielnetz (`raw.githubusercontent.com`), Netze aus dem VSP-SVN
(`svn.vsp.tu-berlin.de`) und die Hintergrundkarte (`tiles.openfreemap.org`, außer bei „Ohne“).

## Tests

```sh
npm test            # Bausteine (node --test), ohne Abhängigkeiten
npm ci              # einmal: Playwright für die Browser-Tests
npx playwright install chromium
npm run test:web    # Browser-Tests; mit vorhandenem Chrome: CHROME=/pfad/zu/chrome npm run test:web
```

Die Browser-Tests (`tests/web/`) laufen gegen erfundene Testdaten in `tests/web/fixtures/`: ein
Gitter aus 12 Knoten mitten in Berlin als MATSim-Netz und als OSM-Auszug, ein Auszug der Zählkarte
mit neun Dauerzählstellen und zwei Kurzzeitzählungen, ein Gebiet. Neu bauen mit `npm run testdaten`.
Nach draußen geht keine Anfrage. Sie prüfen den ganzen Ablauf: welche Stelle an welchen Link kommt,
die Ausgaben gegen erwartete Dateien in `tests/web/erwartet/` (nach einer gewollten Änderung neu
schreiben mit `ERWARTET_NEU=1 npm run test:web`), ein Mittel von Hand nachgerechnet, Konfiguration
hin und zurück, das Gebiet, Kurzzeitzählungen und die Übernahme aus einem OSM-Auszug.

Der Workflow „Prüfen und veröffentlichen“ (`.github/workflows/pruefen.yml`) führt beide bei jedem
Push und Pull Request aus. Auf `main` veröffentlicht er danach die Seite, sobald GitHub Pages auf
„GitHub Actions“ steht (Einstellungen > Pages > Quelle); solange Pages direkt aus dem Branch
veröffentlicht, geht die Seite ohne Tests online, und der Workflow sagt das als Hinweis.

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
- `lib/kurzzeit.js`: Kurzzeitzählungen je Strom, jüngste Zählung je Stelle, Punkte der Arme und
  Fahrtrichtungen, Lizenz je Lieferung
- `lib/mitteln.js`: Tage wählen, Mittel oder Median
- `lib/counts.js`: counts.xml schreiben, Zuordnungs-CSV schreiben und lesen
- `lib/konfig.js`: Konfiguration bauen und lesen
- `lib/gebiet.js`: Gebiet aus GeoJSON, `.poly` oder Shapefile (auch gezippt), Punkt im Gebiet
- `vendor/`: MapLibre GL JS, proj4, fzstd (Zstandard entpacken), Schriften
- `tests/`: Tests der Bausteine, `npm test` (Node 20 oder neuer, ohne Abhängigkeiten); in
  `tests/web/` die Browser-Tests mit Testdaten und erwarteten Dateien, `npm run test:web`
- `playwright.config.js`, `.github/workflows/pruefen.yml`: Browser-Tests, Prüfen vor dem Veröffentlichen

## Offen

- Kurzzeitzählungen: Querschnitte, deren Lage an einer Kreuzung geokodiert ist, liegen dort statt
  an der Zählstelle („südl. Bäkestraße“); Arme mit mehreren Links (Doppelfahrbahn mit
  Abbiegestreifen, SUMO-Knotencluster); Zählungen, die Berlin am selben Tag in zwei Dateien ablegt,
  zusammenführen; wahlweise in dieselbe Datei wie die Dauerzählstellen
- Kurzzeitzählungen anderer Städte, sobald die Zählkarte sie je Strom ausgibt (bisher nur Berlin)
- Stellen, die beide Richtungen zusammen zählen, zuordnen: beide Links und die gezählte Summe,
  für eine eigene Auswertung (MATSims Vergleich kennt keine Summe über zwei Links)
- Stundenwerte über ganze Jahre (die Zählkarte gibt für die Karte nur die jüngsten 12 Monate aus)
- Netze aus MATSims `OsmNetworkReader` tragen keinen OSM-Weg: Übernahme dort nur über ID und Lage
- den Netz-Leser mit kachelwerk teilen statt ihn zu kopieren

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

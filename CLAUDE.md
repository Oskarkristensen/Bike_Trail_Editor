# Bike Trail Editor

Interaktiv webapp til oprettelse og redigering af cykelruter på et kort.

## Tech stack

- **Frontend:** React + Vite + TypeScript, Leaflet.js + react-leaflet
- **Backend:** Node.js + Express (CommonJS)
- **Routing:** BRouter (offentlig API via backend-proxy, `trekking`-profil)
- **Database:** Postgres på Neon via `pg` (Pool, pooled connection string)

## Projektstruktur

```
backend/          Express API server (port 3001, override med PORT)
  src/index.js    Alle routes, BRouter proxy, validering
  src/db.js       Postgres-pool; fejler ved opstart hvis DATABASE_URL mangler
  src/init-db.js  Kører schema.sql (npm run db:init)
  src/auth.js     Login, sessioner, invitationskode, requireUser
  schema.sql      Databaseskemaet
  .env.example    Påkrævede miljøvariabler (i git); den rigtige .env er gitignoreret
frontend/         Vite + React app (port 5173, proxy /api → backend)
  src/
    components/   Map.tsx, RoutingControl.tsx, Sidebar.tsx, ElevationProfile.tsx,
                  LoginScreen.tsx
    api.ts        apiFetch (401 → login-skærm) og login-kaldene
    elevation.ts  Højdeprofil: stigning/fald, nedsampling til graf
    gpx.ts        GPX-import og -eksport
    types.ts      Delte TypeScript interfaces
```

## Kørsel

Start begge servere fra root:
```
npm run dev
```
Alternativt start dem separat:
```
npm run dev:backend
npm run dev:frontend
```

Backend-porten kan overrides med `PORT=3099 npm run dev:backend` (nyttigt hvis en
gammel instans stadig holder 3001). Frontendens Vite-proxy peger fast på 3001.

Backenden kræver `backend/.env` med `DATABASE_URL`, `SESSION_SECRET` og `INVITE_CODE`
(se `.env.example`) og nægter at starte uden dem. Lokalt peger den
på Neon-branchen **`test`**, ikke `main` — `main` er produktion. Skemaet oprettes med
`npm run db:init --prefix backend`; det er idempotent og kan køres igen.

**Læs aldrig `backend/.env` og skriv aldrig dens indhold ud** — den indeholder
databasens adgangskode. Skal noget kontrolleres, så tæl med `grep -c` i stedet for at vise
linjen.

## API endpoints

- `GET /api/health` — healthcheck
- `POST /api/route` — BRouter proxy. Body: `{ waypoints: [{lat, lng}, ...], profile?: string }`. Returnerer GeoJSON.
- `GET /api/routes` — liste over gemte ruter
- `POST /api/routes` — gem rute. Body: `{ name, waypoints }`
- `DELETE /api/routes/:id` — slet gemt rute
- `POST /api/auth/register` — opret bruger. Body: `{ username, password, invite }`. 403 ved
  forkert kode, 409 hvis navnet er taget
- `POST /api/auth/login` — Body: `{ username, password }`
- `POST /api/auth/logout`
- `GET /api/auth/me` — `{ username }` eller 401

**Alt undtagen `/api/health` og `/api/auth/*` kræver login** (fase 3) og svarer ellers
401. Ruterne er pr. bruger: man ser og sletter kun sine egne.

## Arkitekturbeslutninger

- **Ingen Leaflet Routing Machine (LRM):** LRM's custom router-integration virkede ikke med Vite/ESM. Routing er implementeret manuelt med Leaflet polylines og markers. Pakken er afinstalleret.
- **Midpoint markers:** Hule, stiplede cirkler placeret midt på hvert rutesegment (langs den faktiske vej, ikke lige linje). Træk dem for at indsætte nye waypoints.
- **Frontend kalder aldrig BRouter direkte** — alt går gennem `/api/route` så routing-provider kan skiftes uden frontend-ændringer.
- **Alle markører er `L.divIcon` stylet i `App.css`** — ingen billedfiler og ingen CDN. Leaflets standard-ikonimport virker ikke med Vite, og den tidligere workaround (PNG'er fra unpkg) er fjernet, da ingen markør længere bruger default-ikonet.
- **Markør-semantik** — fire visuelle typer, hver med sit signal:
  | Type | Udseende | Betydning |
  |---|---|---|
  | Start | Grønt flag | Rutens første waypoint |
  | Slut | Ternet målflag | Rutens sidste waypoint |
  | Waypoint | Fyldt blå cirkel, hvid pil | Et rigtigt punkt på ruten; pilen viser vejen ruten forlader det |
  | Midpoint | Hul stiplet cirkel, blå pil | Træk mig for at indsætte et nyt waypoint; pilen viser segmentets retning |

  Flagenes `iconAnchor` ligger ved **flagstangens fod**, ikke i midten, så de peger på det præcise punkt. `transform-origin` på `.flag-body` matcher samme punkt, så hover-skalering ikke flytter flaget.
- **Markørens rod-element tilhører Leaflet — alt visuelt skal ligge i et indre element** (`.marker-dot`, `.flag-body`). Leaflet skriver en *inline* `transform: translate3d(...)` på roden ved hver positionsopdatering (`leaflet-src.js:2532`). Sætter man `transition: transform` der, animeres hvert skridt under et træk, og markøren halter efter musen. Sætter man `transform: scale()` der, sker der omvendt ingenting — inline styles slår stylesheet-regler. Begge dele var reelle fejl indtil hover-effekten blev flyttet ned i de indre elementer. Af samme grund skal `transform-origin` heller ikke stå på roden: det overskriver Leaflets egen `.leaflet-zoom-animated { transform-origin: 0 0 }` og kan forskyde markøren under zoom-animationer.
- **Start/slut gentildeles ved hver ændring.** Rollen følger markørens plads i listen, ikke markøren selv — sletter man det første waypoint, overtager nummer to. `applyMarkerRoles()` kaldes synkront i `scheduleRouteUpdate` (ikke i det debouncede `runRouteUpdate`, hvor ikonet ville halte 150 ms efter klikket). Ét enkelt waypoint bliver start, ikke slut.
- **Routing-kald er debounced (150 ms) og sekvensnummererede** i `RoutingControl.tsx`. Hvert nyt kald aborter det forrige, og svar fra forældede kald kasseres — ellers kan et langsomt svar overskrive en nyere rute.
- **GPX-import er et udgangspunkt, ikke en nøjagtig gengivelse.** Filen nedsamples til maks. 20 waypoints (`MAX_WAYPOINTS` i `src/gpx.ts`), og BRouter re-router imellem dem. Den importerede rute snapper altså til veje og afviger fra originalsporet — det er med vilje.
- **GPX-eksport er målrettet cykelcomputer-apps** (Garmin Connect, iGPSPORT, Strava). Al GPX-håndtering ligger i `frontend/src/gpx.ts`. Fire bevidste valg:
  - **Hele rutegeometrien eksporteres**, ikke de klikkede waypoints. `getRouteCoords()` på `RoutingControlHandle` giver BRouters fulde punktliste — det er den, computeren navigerer efter.
  - **`<trk>`, ikke `<rte>`.** Alle tre platforme importerer tracks; har filen begge dele, opfatter nogle af dem det som to separate ruter.
  - **Ingen `<time>` på trackpoints.** Det er ikke en forglemmelse: en GPX *med* tidsstempler ser ud som en gennemført tur, og Strava tilbyder da at uploade den som aktivitet i stedet for som rute. `<metadata><time>` er filens oprettelsestidspunkt og har ikke den effekt. **Tilføj dem ikke.**
  - **Højde med.** Derfor bevarer `fetchRoute` nu tredje koordinat som `L.LatLng.alt` — `L.latLng(c[1], c[0], c[2])`. Den påvirker hverken `distanceTo()` (2D) eller polylinjen.

  Kendt begrænsning: ældre Garmin Edge-enheder har historisk et loft på ca. 10.000 punkter pr. course. Vi nedsampler ikke ved eksport.
- **Backend validerer al input** (lat/lng skal være tal i gyldigt interval, profil skal stå på allowlisten). BRouter-kald har 15 s timeout.
- **Postgres-detaljer der ikke er åbenlyse** (migreret fra SQLite i oktober 2026):
  - **`routes.id` er `INTEGER`, ikke `BIGINT`.** `pg` leverer int8 som *streng* for ikke at
    miste præcision, og frontendens `SavedRoute.id` er et `number`.
  - **Derfor afviser `DELETE /api/routes/:id` id'er uden for 1–2147483647 med 400.** Et
    større tal er et gyldigt JS-heltal, men Postgres svarer "out of range", og det blev til
    500. SQLite gav 404 for samme input.
  - **`sslmode=verify-full`, ikke `require`.** `pg` 8 behandler `require` som `verify-full`
    og advarer om at `require` i v9 skifter til libpq's svagere betydning (kryptering uden
    certifikattjek). `sslmode` i connection stringen vinder over `ssl`-optionen i `db.js`,
    så det er strengen der bestemmer. Neon leverer `require` — ret det ved kopiering, også i
    Render.
  - **`waypoints_json` er `jsonb`**, så `pg` parser den selv og Postgres afviser ugyldig
    JSON ved INSERT. Den gamle "spring korrupte rækker over"-logik er fjernet.
  - **`.env` indlæses med `node --env-file-if-exists=.env`**, ikke `dotenv`. `-if-exists`
    fordi Render ikke har nogen `.env`-fil — med `--env-file` alene fejler opstarten. `dev`
    genstarter også når `.env` ændres (`--watch .env`).
  - **`created_at` er nu ISO (`2026-10-16T13:26:31.069Z`)**, ikke SQLite's
    `2026-10-16 13:26:31`. Frontenden viser den ikke, så det er ligegyldigt i dag.
- **Den viste tid er `distance / brugerhastighed`, ikke BRouters `total-time`.** BRouters egen tidsmodel (bakker, belægning, lyskryds) læses ikke længere — kun `track-length`. Hastigheden sættes i sidepanelet (5–50 km/t, standard 20) og gemmes i localStorage under `bike-trail-editor:speed-kmh`. Bemærk at "skalér BRouters tid efter en ønsket hastighed" matematisk reducerer til samme formel, så der er ikke noget mellemliggende alternativ.
- **Hastighedsfeltet har to states** (`speed` og `speedInput` i `Sidebar.tsx`). Feltet må være midlertidigt ugyldigt mens man skriver — værdien klampes først ved `onBlur`. Klampning ved hvert tastetryk gør feltet ubrugeligt: man kan ikke skrive "5" på vej mod "50" eller rydde feltet for at starte forfra.
- **Knapkolonnen ligger uden for `routeInfo`-betingelsen** i `Sidebar.tsx`. Knapper der kræver en rute er `disabled`, men "Importér GPX" er altid aktiv — den skal netop kunne bruges når kortet er tomt.
- **Kortets klik-handler ignorerer klik på `.leaflet-marker-icon`.** `addWaypoint` lægger altid punktet sidst i listen, så et klik der falder igennem fra en markør ville gøre den til det nye mål. Markørerne har deres egne handlere; kortklik er kun til tom baggrund.
- **Midpoint-markører reagerer på både `click` og `dragend`** gennem den samme engangs-indsættelse (`consumed`-flaget i `createMidpoints`). Leaflet starter først et drag efter 3 px bevægelse, så et kort, præcist klik giver aldrig `dragend` — uden klik-handleren skete der ingenting. Flaget sikrer at kun den første af de to events indsætter; markøren bygges alligevel om ved næste `createMidpoints()`.
- **Retningspile på waypoints og midpoints** (oktober 2026) — så man kan se om et punkt
  ligger på ud- eller hjemturen, når de to følger samme vej. Flagene har ingen pil.
  - **Waypoints matches til ruten ved at søge *fremad*** (`findWaypointIndices`), ikke ved
    nærmeste punkt i hele ruten som før. Det var en reel fejl: ligger et hjemturs-waypoint
    præcis oven i et udturs-waypoint, matchede den gamle kode begge til udturen. Segmentet
    blev vendt om, midpointet havnede på forkert ben, og en pil ville have peget forkert.
    Bevist med en rigtig BRouter-rute ud og hjem ad Silkeborgvej: gammel kode gav indeks
    64 for hjemturs-waypointet (udturen), ny kode 209. Tolerancen på 5 m
    (`WAYPOINT_MATCH_TOLERANCE_M`) gør at første passage vinder når to ligger lige tæt.
  - **Vinklen regnes i Web Mercator-koordinater på fast zoom 0**, ikke i grader lat/lng.
    Mercator er vinkeltro, så vinklen gælder på alle zoomniveauer; lat/lng-grader ville
    give skæve pile langt fra ækvator (i Aarhus er en længdegrad ~56 % af en breddegrad).
  - **Retningen gemmes pr. markør i et `WeakMap`, ikke pr. indeks**, og ikonet bygges om
    i `applyMarkerRoles`. Indsættes eller slettes et waypoint, forskydes indekserne; pr.
    markør følger pilen med indtil den nye rute kommer 150 ms+ senere.
  - **Pilen drejes på `.marker-arrow`** — samme regel som resten: aldrig på rod-elementet.
    Den bruger `currentColor`, så midpointets pil bliver hvid når cirklen fyldes ved hover.
  - Kendt begrænsning: ligger to midpoints *præcis* oven i hinanden (symmetriske
    waypoints ud og hjem), ses kun den øverste pil.
- **Hastighedsfeltet er `type="text"`, ikke `type="number"`** — bevidst, for at undgå op/ned-pile og at scrollhjulet ændrer værdien. `parseSpeed()` accepterer dansk decimalkomma.
- **Højdeprofilen bygger på BRouters tredje koordinat**, den samme højde GPX-eksporten
  bruger. Al beregning ligger i `frontend/src/elevation.ts`, tegningen i
  `components/ElevationProfile.tsx`. Fire ting er værd at kende:
  - **Stigning og fald er støjfiltreret med en hysterese på 3 m**
    (`ELEVATION_THRESHOLD_M`). BRouters højder kommer fra SRTM-gitteret og svinger et par
    meter mellem nabopunkter; summerer man hver positiv forskel, får en flad rute rundt om
    Brabrand Sø hundredvis af "højdemeter". Tærsklen måles fra sidste *bekræftede* punkt,
    ikke fra naboen, så en lang jævn stigning stadig tælles fuldt ud. **Sænk den ikke**
    uden at se på en flad rute bagefter.
  - **Nedsamplingen beholder både højeste og laveste punkt i hver spand** (`downsample`).
    "Tag hvert n'te punkt" ville ramme ved siden af bakketoppene og gøre lange ruter
    fladere end de er. Stigning/fald regnes på det *fulde* datasæt, ikke det nedsamplede.
  - **Grafens bredde måles med en `ResizeObserver`** i stedet for et `viewBox` der strækkes.
    Et strakt viewBox ville skalere x og y forskelligt, så stregtykkelse og tekst blev
    forvrænget.
  - **Y-aksen tvinges op på mindst 20 meters spænd** (`MIN_ELEVATION_RANGE_M`). Uden det
    ville en flad rute fylde hele grafen med et par meters SRTM-støj og ligne en bjergetape.
- **Højdeprofilen ligger i `.map-main` under kortet, og en `ResizeObserver` på kortets
  container kalder `invalidateSize()`** (`setMap` i `Map.tsx`). Leaflet opdager kun selv
  når *vinduet* ændrer størrelse, ikke containeren, og efterlader ellers et gråt bånd uden
  fliser. Observeren dækker profilen der vises/skjules, mobilarket og en telefon der
  drejes. Den erstattede en `useEffect` der kun reagerede på profilen.
- **Hover-markøren er en `L.circleMarker` med `interactive: false`** — den er ikke et
  waypoint, må ikke kunne trækkes eller klikkes, og skal ikke stjæle klik fra kortet.
  Den fjernes både når ruten forsvinder (`dropRouteLine`, `clearAll`) og når profilpanelet
  lukkes mens musen står inde i grafen (cleanup i `ElevationProfile`), hvor `pointerleave`
  aldrig når at blive kaldt.

## Mobil

Lavet 18. oktober 2026, testet med Playwright (iPhone SE/16 Pro, Pixel 7, Galaxy S24,
Z Fold 7, iPads, landskab) og af Oskar på en rigtig **iPhone 16 Pro med iOS 26.5**. Al CSS
ligger i `@media (max-width: 700px), (max-height: 500px)` nederst i `App.css`; desktop er
uændret og eftervist med samme mål før og efter.

- **Telefonlayout = smal *eller* lav skærm.** En telefon på langs er bredere end 700 px
  (iPhone 16 Pro: 756) og fik desktop-layoutet med et kort på 476×169. Det der gør den
  til en telefon er at den er lav; tablets og desktop er aldrig under 500 px høje. På
  lave skærme skjules højdeprofilen helt — stigningen står i arkets opsummering.
  iPad (gen 11) og Galaxy Tab S9 er smallere end 700 og får telefonlayoutet — bevidst,
  det giver dem et kort på ~650×700 i stedet for ~370 px bredt ved siden af panelet.
- **Sidepanelet er et "bottom sheet" oven på kortet** (Apple/Google Maps-mønsteret):
  hvid flade, afrundede hjørner, skygge, håndtag og en blå "Menu ▴"-knap. **Den første
  udgave — en grå linje med en lille pil — blev ikke fundet** på en rigtig iPhone ("if you
  dont know it is there, there is no way to find it"). Uden rute siger linjen hvad menuen
  indeholder (gem, hent, importér), så de kan findes før man har tegnet noget.
- **Arket flyttes med `transform`, ikke ved at ændre kortets størrelse.** Det animeres på
  GPU'en, og Leaflet skal ikke regne om undervejs. Lukket er det skubbet ned så kun linjen
  ses (`--sheet-peek`), åbent er det ved 0. Fingerens forskydning lægges oveni som
  `--sheet-drag`, og `clamp()` holder det mellem åbent og lukket. Alt i CSS; JS sætter kun
  de to variabler.
- **Under et træk følger arket fingeren** (`.sidebar--dragging` slår transitionen fra),
  og ved slip glider det på plads: op åbner, ned lukker, under 30 px er et tryk. Målt:
  626 → 466 → 399 → 369 → 362 px over 400 ms. `--sheet-drag` sættes direkte på elementet,
  ikke via state, så React ikke renderer 60 gange i sekundet.
- **`setPointerCapture` på `pointerdown` er nødvendig.** Linjen er ~60 px høj, så et
  strøg slutter over kortet, og uden capture lander `pointerup` dér. Strøget blev aldrig
  registreret før det kom på (fanget af Playwright, ikke af en bruger).
- **`touch-action: none` på linjen**, ellers tager Safari strøget som scroll og afbryder
  med `pointercancel`.
- **`--sheet-peek` måles** med en `ResizeObserver` på linjen og sættes på `.map-layout`,
  så kortet kan give plads. Ikke hårdkodet: emulatoren gav 63 px, og på den rigtige
  iPhone var teksten større. Teksten i linjen afkortes med "…" — på iPhonen skubbede den
  ellers Menu-knappen ud over højre kant.
- **Arket har `z-index: 1001`, profilen 1000.** Med ens z-index vandt profilen, fordi den
  kommer senere i HTML'en, og dækkede arkets top — håndtag og skygge forsvandt.
- **Et tip forklarer sletning og træk** (`EDIT_TIP` i `Sidebar.tsx`), fordi højreklik og
  langt tryk ikke er til at gætte. Teksten følger `pointer: coarse` ("Hold fingeren på et
  punkt…" / "Højreklik på et punkt…"). Desktop: under hastigheden. Telefon: i arkets
  linje, så den ses uden at åbne noget. **Sletning står først**, og tippet må fylde to
  linjer (`line-clamp: 2`) — med "…" forsvandt netop sletnings-delen på en iPhone SE.
- **En lukket højdeprofil vises igen med "Højdeprofil ▴" i kortets nederste venstre
  hjørne** (`.elevation-show` i `Map.tsx`) — samme sted som den forsvandt fra, på både
  desktop og telefon. Knappen lå før som nr. 6 i sidepanelets knapkolonne; på en telefon
  skulle man åbne menuen *og* scrolle i den, og Oskar fandt den ikke ("you cant get it
  back"). Den ligger uden for `MapContainer`, så et tryk aldrig bliver et waypoint, og
  skjules på lave skærme, hvor profilen alligevel er skjult.
- **Større markører på berøringsskærme** (`pointer: coarse` → 24/22 px i stedet for
  16/14, pilen følger med i CSS) og knapper på mindst 44 px.
- **Højdeprofilen er 100 px høj under 500 px bredde, og antallet af km-etiketter følger
  bredden** (højst 5 som før). Med fast 5 skrev de oven i hinanden ("2,04,0km").

### iOS 26 Safari — målt, ikke gættet

Safaris værktøjslinje i bunden **svæver oven på siden** i iOS 26 (glas-effekt), i stedet
for at tage plads fra den. Målt med en midlertidig målside på en iPhone 16 Pro, iOS 26.5:

| Mål | Værdi |
|---|---|
| `innerHeight`, `100dvh`, `100svh` | 714 |
| `100vh`, `100lvh` | 754 (ind under linjen) |
| `env(safe-area-inset-bottom)` | **0 — også med `viewport-fit=cover`** |
| `position: fixed; bottom: 0` | lå præcis over linjen ✓ |

Derfor er **`.app` `position: fixed; inset: 0`** og ikke `height: 100dvh`. Det
"sædvanlige" fix (`viewport-fit=cover` + `env(safe-area-inset-bottom)`) virker **ikke** på
iOS 26 — værdien er 0. Sæt heller ikke `height` på `.app`: med `top` + `height` ignoreres
`bottom`.

**Konsekvens: Safaris linje skrumper aldrig.** Den gør det kun når *siden* scroller, og
appen fylder skærmen præcis. Det er accepteret — som Apple/Google Maps på web.

### Teste på mobil

- **Playwright** (`playwright` som devDependency i roden, kun WebKit og Chromium
  installeret) til skærmbilleder og mål på emulerede enheder. Scripts skrives i
  scratchpad, ikke som en testsuite — se "Hobbyprojekt" i hukommelsen. Login via
  `context.request` mod API'et; testbrugere oprettes på `test` og slettes bagefter.
- **Emulering viser ikke Safaris egen værktøjslinje** og ikke hvordan træk med en finger
  *føles*. Begge dele krævede den rigtige telefon.
- **Rigtig telefon på hjemmenettet:** start frontenden med
  `npm run dev --prefix frontend -- --host` og åbn `http://<Mac'ens IP>:5173` på telefonen
  (`ipconfig getifaddr en0`). macOS' firewall kan spørge om node må tage imod forbindelser.
  Skærmbilleder fra telefonen lægges i `screenshots/`, som er gitignoreret.

## Lokale adgangsbegrænsninger

`.claude/` er gitignoreret, så det følgende ligger kun på denne maskine — men det påvirker
hvordan værktøjerne opfører sig, så det er værd at kende:

- **En PreToolUse-hook (`.claude/hooks/project-scope.sh`) afviser Bash-kommandoer der rører
  brugerens hjemmemappe uden for projektet.** Rammer man den, ser man `Uden for
  projektmappen: /Users/...`. Det er ikke en fejl i kommandoen — det er reglen der virker.
  Systemstier (`/dev/null`, `/usr`, `/tmp`) går fri.
- **`permissions.deny` i `settings.local.json` spærrer Read-værktøjet** for `~/.ssh`, `~/.aws`,
  `~/Downloads`, `~/Library`, shell-historik og credential-filer.
- Baggrunden: deny-regler binder kun det navngivne værktøj, så Bash kunne læse de samme
  filer med `cat` eller `python3`. Hooken lukker det hul, fordi den ser kommandoen i stedet
  for værktøjsnavnet.
- **Hooken udfolder `~` som shellen gør** — kun forrest i et ord og efterfulgt af `/` eller
  ordets slutning. Indtil 16. okt. 2026 udfoldede den hvert `~`, så "~15 min" i en
  commit-besked blev til `/Users/oskar15` og blev afvist, og det samme gjorde
  `git log HEAD~3`. Ser du en afvisning med en sti der ikke giver mening, så tjek om
  tekst i kommandoen er blevet læst som en sti. Testene ligger i
  `.claude/hooks/project-scope.test.sh` (`bash .claude/hooks/project-scope.test.sh
  .claude/hooks/project-scope.sh`) — kør dem efter enhver ændring af hooken. Bemærk at
  testkommandoer med fx `~/Downloads` direkte i Bash bliver afvist af hooken selv; de
  skal ligge i en fil.
- Begge dele er værn mod uheld, ikke sikkerhedsgrænser — de ligger i filer der kan redigeres
  herfra. Slå fra med `"disableAllHooks": true` eller `/hooks`.

**Praktisk konsekvens:** filer uden for projektet skal læses med Read-værktøjet, ikke med
`cat`/`python3` i Bash. Det gælder bl.a. memory-mappen under `~/.claude/projects/`.

## Status

Færdigt:
- Kort centreret på Aarhus med OpenStreetMap tiles
- Klik for waypoints, træk for at flytte, højreklik for at slette
- Træk midpoint-cirkler for at indsætte nye waypoints
- Rute beregnes automatisk langs veje via BRouter
- Sidepanel med distance, tid, waypoint-count
- "Ryd rute"-knap
- Gem/hent/slet ruter (Postgres på Neon)
- GPX-import (`.gpx` med `trkpt`, `rtept` eller `wpt`)
- GPX-eksport til Garmin/iGPSPORT/Strava (navn indtastes ved eksport)
- Fejlbeskeder i sidepanelet ved routing-, gem- og importfejl
- Kortet zoomer til ruten når en gemt rute eller GPX-fil indlæses
- Højdeprofil under kortet med stigning/fald i sidepanelet og markør på kortet ved hover
- Brugerkonti: login og oprettelse med invitationskode, ruter pr. bruger (fase 2–4)
- **I produktion på https://bike-trail-editor.onrender.com** (Render + Neon `main`, fase 5)

- Mobillayout med et ark der kan trækkes op fra bunden (se "Mobil")

Ikke implementeret endnu:
- Intet planlagt

## Migreringsplan: brugerkonti (Neon Postgres + eget login med invitationskode)

**Status: alle fem faser færdige 16. oktober 2026; appen kører i produktion.** Afsnittet
er bevaret som dokumentation af *hvorfor* tingene er som de er — flere af valgene blev
truffet for at undgå fælder der ikke er åbenlyse.

**Planen blev lavet om 16. okt. 2026: Neon Auth er droppet** til fordel for samme model
som Oskars `food_waste_website` (offentligt repo): brugernavn + adgangskode i vores egen
tabel, cookie-session i Postgres, og en invitationskode for at oprette sig. Grunde:
- Oskar vil have **brugernavne, ikke e-mails**. Neon viser ikke Better Auths
  username-plugin, så med Neon Auth var login e-mail (eventuelt falsk).
- **Folk skal kunne oprette sig selv, men kun dem Oskar har givet koden.** Neon Auth kunne
  kun "alle" eller "ingen — Oskar opretter dem i dashboardet".
- Adgangskontrollen ligger i **vores kode**, ens på alle branches. Med Neon Auth var den en
  dashboard-indstilling pr. branch, som skulle huskes på en hård tjekliste ved deploy.
- Ingen Beta-afhængighed, ingen JWT/JWKS/`jose`, ingen tokens der udløber efter 15 min.
- Prisen: **vi opbevarer selv adgangskoder.** Med bcrypt er det i orden
  for et hobbyprojekt uden følsomme data — appen gemmer kun ruter.

### Udgangspunkt

Appen hostes på **Render's gratis tier**, hvor filsystemet er flygtigt og instansen
lukker ned efter 15 minutters inaktivitet. **SQLite kan derfor ikke bruges i produktion**
— filen overlever ikke en deploy. Databasen er flyttet til **Neon** (serverless Postgres).

Neon-projektet har **to branches: `main` (produktion) og `test` (lokal udvikling)**. Bevidst
kun to — der kommer ikke en tredje. **Hvilken branch appen bruger, bestemmes alene af
hvilken connection string der står hvor:** `test`'s i `backend/.env`, `main`'s kun i
Render. Lokalt kan man derfor aldrig ramme produktionen — så længe `main`'s string aldrig
lægges i `.env`.

### Skridt der kræver dashboard-adgang (kan ikke gøres herfra)

1. ~~Opret branch og læg pooled connection string i `backend/.env`~~ — gjort (branch `test`).
2. ~~Slå Neon Auth fra på begge branches~~ — gjort 16. okt. 2026. Verificeret på `test`:
   den gamle auth-URL svarer 404, og databasen har kun skemaet `public` tilbage.
   `NEON_AUTH_URL` er fjernet fra `.env` og `.env.example`. Støder du på et
   `neon_auth`-skema eller en auth-URL, er det en rest — ikke noget der bruges.
3. Ved deploy: se fase 5.

Connection stringen er hemmelig: **aldrig i git eller i en chat.** Det samme gælder
`SESSION_SECRET` og `INVITE_CODE`. Repoet er offentligt på GitHub.

### Fase 1 — SQLite → Postgres, uden auth — **færdig**

Gennemført 16. oktober 2026 og testet mod `test`-branchen: gem, list og slet via API'et
og fra browseren, 404 ved ukendt id, 400 ved ugyldigt id. Detaljerne der ikke er
åbenlyse står under "Postgres-detaljer" i Arkitekturbeslutninger. Det gamle `routes.db`
er slettet — den indeholdt kun én testrute, så intet blev migreret.

`better-sqlite3` er væk. `npm audit` er rent i root og frontend; i backend står 3 *high*
tilbage i `braces` via `nodemon` → `chokidar`. Kun dev-afhængighed, kører aldrig i
produktion. `npm audit fix --force` ville *nedgradere* nodemon til 1.14.10 — gør det ikke.

### Fase 2 — brugere, sessioner og login-endpoints i Express — **færdig**

Gennemført 16. oktober 2026 i `src/auth.js`, testet mod `test`-branchen gennem
Vite-proxyen: forkert kode → 403, ugyldigt navn / kort adgangskode → 400, oprettelse →
201 og logget ind, samme navn igen → 409, ens 401-svar ved ukendt bruger og forkert
adgangskode, log ud → `/me` giver 401. Desuden eftervist: adgangskoden gemmes som
`$2b$10$…` (bcrypt), session-id'et skifter ved login, log ud sletter rækken i `session`,
og **et login overlever en genstart af backenden**. Testbrugeren er slettet igen.

Ting fra implementeringen der ikke står nedenfor:
- **`pruneSessionInterval` er sat til 24 timer.** connect-pg-simple rydder ellers op
  hvert ~15. minut (7,5–22,5 min) fra første sessionsopslag og så længe processen lever —
  set i kildekoden. Neon går i dvale efter 5 minutter, så det ville vække databasen igen
  og igen og bruge af gratiskvotens compute-timer, mens dev-serveren kører. Udløbne
  sessioner afvises alligevel ved opslag; oprydningen sparer kun plads.
- **`trust proxy` er sat nu, ikke først i fase 5** — cookien i `auth.js` afhænger af den
  i produktion, og det er netop den slags linje der glemmes.
- **`INVITE_CODE` laves med `openssl rand -base64 15 | tr '+/' '-_'`**, så den kun
  indeholder tegn der er lette at taste og dele.
- Log ud kalder også `res.clearCookie('connect.sid')`, ellers bliver browseren ved med at
  sende et id der ikke findes længere.

Ren tilføjelse; ingen eksisterende endpoints ændrede opførsel.

**Afhængigheder:** `express-session`, `connect-pg-simple`, `bcryptjs`.
`bcryptjs` frem for `bcrypt`, fordi den er ren JavaScript — ingen native build, samme
grund til at vi var glade for at slippe af med `better-sqlite3`.

**Skema** (i `schema.sql`, ikke ved opstart):
```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
- `INTEGER` af samme grund som `routes.id`: `pg` leverer `BIGINT` som streng.
- `CHECK (username = lower(username))` gør at "Oskar" og "oskar" ikke kan blive to
  brugere, selv hvis normaliseringen i koden en dag glemmes.
- **Sessionstabellen skal også i `schema.sql`**, ikke via `createTableIfMissing` som i
  food waste. Hent definitionen fra `node_modules/connect-pg-simple/table.sql` og gør den
  idempotent (`IF NOT EXISTS`). Gjort — pakkens fil (v10.0.0) har stadig den forældede
  `WITH (OIDS=FALSE)`, som er udeladt i vores version.

**Endpoints** — JSON, ikke server-renderede formularer som i food waste, da frontenden er
React:

| Metode | Endpoint | Body | Svar |
|---|---|---|---|
| POST | `/api/auth/register` | `{ username, password, invite }` | 201 + `{ username }`, logget ind |
| POST | `/api/auth/login` | `{ username, password }` | 200 + `{ username }` |
| POST | `/api/auth/logout` | – | 200 |
| GET | `/api/auth/me` | – | 200 + `{ username }` eller 401 |

```js
function requireUser(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Login kræves' });
  req.userId = req.session.userId;
  next();
}
```

**Beslutninger og forbedringer i forhold til food waste** — dér mangler de, så kopiér
ikke derfra uden at læse dette:

- **`SESSION_SECRET` og `INVITE_CODE` er påkrævede; processen fejler ved opstart uden dem**,
  som `DATABASE_URL` allerede gør i `db.js`. Mest for at fejlen viser sig med det samme i
  stedet for som en mystisk opførsel. Uden `INVITE_CODE` kan ingen oprette sig; en
  manglende `SESSION_SECRET` er *ikke* farlig med vores opsætning (se næste punkt).
- **`SESSION_SECRET` beskytter mindre end man skulle tro.** Den signerer kun cookien, og
  cookien indeholder kun et tilfældigt session-id — login-tilstanden ligger i
  `session`-tabellen. Kender en angriber hemmeligheden, kan de signere et vilkårligt id,
  men id'et skal findes i tabellen for at give adgang, og det kan kun skaffes ved at stjæle
  en indlogget brugers cookie. Hemmeligheden ville være kritisk med `cookie-session`, hvor
  hele sessionen ligger i cookien. Det er ikke vores opsætning.
- **Invitationskoden skal være lang og tilfældig** — fx `openssl rand -base64 15`
  (20 tegn). Det er hele beskyttelsen mod at gætte den.
- **Bevidst fravalgt (16. okt. 2026): rate limiting og `timingSafeEqual`.** Med en
  tilfældig kode på 20 tegn er gætteri uoverkommeligt uden loft, og et timingangreb hen
  over internettet er urealistisk mod en app som denne. Indsatsen står ikke mål med hvad
  en angriber vinder: adgang til et routingkort og nogle cykelruter. Kommer der en dag
  noget mere følsomt i appen, så genovervej.
- **`req.session.regenerate()` ved login og oprettelse** — nyt session-id når man logger
  ind, så et id en angriber har plantet før login ikke bliver gyldigt (session fixation).
- **try/catch i alle async-handlere.** Food waste har ingen i `/register`; i Express 4
  vælter en databasefejl der hele processen. Vi kører Express 5, som fanger afviste
  promises, men try/catch giver os stadig pæne fejlbeskeder. **Postgres-fejlkode `23505`
  (unique violation) → 409 "Brugernavnet er taget"** — det fanger to der opretter samme
  navn samtidig, hvor tjek-så-indsæt ikke gør.
- **Validering på serveren**, ikke kun i HTML: brugernavn normaliseres (`trim`,
  `toLowerCase`) og skal matche fx `^[a-z0-9_.-]{3,30}$`; adgangskode mindst 8 tegn.
  Food waste har kun `minlength` i formularen.
- **bcrypt cost 10.** `bcryptjs` er ren JS og langsommere end den native; højere cost
  mærkes på Render's gratis CPU.
- **Login svarer det samme ved ukendt bruger og forkert adgangskode** ("Forkert brugernavn
  eller adgangskode"). Oprettelse afslører at et navn er taget — acceptabelt, da man skal
  have koden for at nå så langt.
- **Cookie:** `httpOnly` (standard), `sameSite: 'lax'`, `secure` i produktion, `maxAge`
  30 dage. **`sameSite: 'lax'` er vores CSRF-beskyttelse** — browseren sender ikke
  cookien med på POST-kald fra andre sites.
- **En fælles kode, ikke en pr. person.** Skift `INVITE_CODE` for at lukke for nye
  oprettelser. Det logger ikke eksisterende brugere ud — slet deres sessioner i
  `session`-tabellen eller brugeren selv for det.

### Fase 3 — brugerejerskab på ruter — **færdig**

Gennemført 16. oktober 2026 og testet mod `test` med to brugere, A og B: uden login
giver alle fire endpoints 401 (også BRouter-proxyen), mens `/api/health` er åben. B ser
en tom liste, B's forsøg på at slette A's rute giver 404 og ruten består, og A kan slette
den selv. `CASCADE` eftervist: sletning af B fjernede B's rute (1 → 0). Testbrugerne er
slettet igen.

- `routes.user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`, plus index på
  `(user_id, created_at DESC)`, som er præcis den forespørgsel listen laver. **Nu hvor vi
  ejer `users`-tabellen, er en foreign key i orden** — med Neon Auth var den fravalgt,
  fordi Neon ejede tabellen. `CASCADE`: sletter man en bruger, forsvinder ruterne med.
- **Kolonnen tilføjes med `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, ikke i `CREATE
  TABLE routes`.** Tabellen fandtes før brugerne, og `CREATE TABLE IF NOT EXISTS` springer
  en eksisterende tabel helt over — kolonnen ville aldrig være kommet på `test`. Samme
  sætning virker på en tom database (`main`), da den står efter `users` i `schema.sql`.
- **`NOT NULL` fejler med vilje hvis der ligger ruter uden ejer.** `routes` var tom på
  `test` (Oskars "Test rute" blev slettet først). På `main` er den tom fordi intet er
  oprettet endnu.
- **En andens rute giver 404, ikke 403** — set fra din konto findes den ikke.
- Alle tre route-endpoints filtreres på `req.userId`. **`DELETE` skal have
  `WHERE id = $1 AND user_id = $2`** — filtrerer man kun listen, kan en bruger stadig
  slette andres ruter ved at gætte et id. Det er den klassiske fejl i netop dette skridt.
- `/api/route` (BRouter-proxyen) får også `requireUser`.

### Fase 4 — frontend — **færdig**

Gennemført 16. oktober 2026. Oskar testede i browseren: oprettelse med invitationskode,
gem rute, reload (stadig logget ind, ruten er der), log ud og ind igen, forkert
adgangskode. **Ikke testet:** at en session der forsvinder *mens man bruger appen*
sender en tilbage til login-skærmen — det kræver at sessionsrækken slettes i databasen
mens man er logget ind.

- Login- og opret-skærm i én formular (`LoginScreen.tsx`); skifter man mellem dem, bevares
  det man har skrevet. `GET /api/auth/me` ved opstart afgør om den vises.
- **Log ud ligger i headeren, ikke i sidepanelet** som oprindeligt planlagt — headeren er
  synlig overalt, og knappen skal ikke trækkes ned gennem komponenterne.
- **`apiFetch` i `api.ts` er den eneste vej til de beskyttede endpoints.** Ved 401 kalder
  den én handler, som `App` registrerer, og som sender tilbage til login-skærmen. **Login-
  kaldene bruger bevidst almindelig `fetch`:** forkert adgangskode giver også 401, og det
  må ikke udløse handleren. Nye kald til `/api/route(s)` skal gå gennem `apiFetch`.
- **"Starter serveren…" mens `/me` svarer.** Render's gratis tier og Neon sover efter en
  pause; food waste-sitet tog 22,7 s om første svar. Uden teksten ligner det at appen er
  gået i stå. Fejler kaldet (ikke 401), vises fejlen med en "Prøv igen"-knap.
- Log ud sætter brugeren til `null` også hvis kaldet fejler — brugeren har bedt om det.
- **Ingen tokens i frontenden.** Cookien sendes automatisk med på kald til samme origin
  (`fetch`'s standard er `credentials: 'same-origin'`). Lokalt sørger Vite-proxyen for at
  `/api` er samme origin.
- 401 fra et hvilket som helst kald → tilbage til login-skærmen, ikke en vilkårlig
  fejlbesked i sidepanelet. Sessionen kan være slettet eller udløbet.

### Fase 5 — deploy — **færdig**

**Live 16. oktober 2026 på https://bike-trail-editor.onrender.com.** Eftervist udefra:
health og forside 200; `/api/routes`, `/api/route`, `DELETE` og `/me` uden login 401;
oprettelse med forkert kode 403; login med ukendt bruger 401 og ikke 500 (beviser at
`users` findes på `main`, altså at `db:init` kørte i buildet); ingen CORS-headere mod en
fremmed origin. Oskar eftervist i Safari: konto oprettet med produktionens kode, login
overlever reload, og cookien er `Secure`, `HttpOnly` og `SameSite=Lax`.

**Opsætningen i Render** (Web Service, region **Frankfurt** — samme by som Neons
`eu-central-1`):

| Felt | Værdi |
|---|---|
| Build Command | `npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Env vars | `DATABASE_URL` (`main`, pooled, **`sslmode=verify-full`**), `SESSION_SECRET`, `INVITE_CODE`, `NODE_ENV=production` |

`SESSION_SECRET` og `INVITE_CODE` i Render er **andre værdier end i den lokale `.env`**.

**To fælder vi faktisk ramte:**
- **Render udfylder selv Build Command med `npm install` og Start Command med `node
  index.js`.** Med dem bliver frontenden aldrig bygget, skemaet aldrig kørt, og opstarten
  fejler med `Cannot find module '/opt/render/project/src/index.js'` —
  `/opt/render/project/src/` er repoets rod på Render, ikke vores `src/`-mappe.
- **Repoet var ikke på listen i Render**, fordi GitHub-forbindelsen kun gav adgang til
  `food_waste_website`. Det blev tilføjet som "Public Git Repository" via URL'en. **Så
  deployer Render ikke automatisk ved push** — brug "Manual Deploy". Vil man have
  auto-deploy, så giv Render adgang til repoet i GitHub (Settings → Applications →
  Render → Configure) og forbind servicen om.

**Hvad koden gør for at deployet virker** (`0757e3e`):
- **Express serverer `frontend/dist`** fra samme origin som API'et. Derfor virker
  cookie-login uden cross-site-regler, og **`cors()` er fjernet helt**.
- **`app.set('trust proxy', 1)`** (sat i fase 2 — fjern den ikke). Render sætter en proxy
  foran og taler HTTP til appen; uden linjen bliver `secure`-cookien aldrig sat.
- **`npm run build` kører `db:init` mod `main`.** Render's gratis tier har ingen shell, og
  sådan skal `main`'s connection string aldrig ligge på en lokal maskine. Skemaet er
  idempotent, så det er ufarligt ved hver deploy. **Ændres skemaet, sker det altså ved
  næste deploy** — og `NOT NULL`-kolonner på tabeller med data vil få buildet til at fejle.
- **Frontendens devDependencies installeres eksplicit** (`npm ci --include=dev`). Med
  `NODE_ENV=production` springer `npm ci` dem ellers over, og Vite mangler. Eftervist
  lokalt på en kopi af `package.json`/lockfilen.
- **`.node-version` låser Node 24** — `--env-file-if-exists` kræver mindst 22.9. Render
  viste "Using Node.js version 24" i loggen.

### Afgjorte beslutninger

- **`/api/route` kræver login** (16. okt. 2026). Ellers står den som en gratis
  routing-proxy på vores kvote. Konsekvens: kortet kan ikke bruges uden login.
- **Gamle SQLite-ruter: forfra.** `routes.db` blev slettet i fase 1.
- **Eget login med invitationskode frem for Neon Auth** (16. okt. 2026) — se toppen af
  afsnittet.

### Faldgruber der er værd at kende på forhånd

- **Første kald efter en pause er langsomt.** Render's gratis tier sover efter 15 min
  uden besøg (food waste-sitet tog 22,7 s om første svar), og Neon efter 5 min uden
  forespørgsler. Neons andel er lille — målt 16. okt. 2026 med en død session-cookie mod
  dev-serveren: 1,3 s når Neon sov, 0,4 s vågen med ny forbindelse, 0,06 s med eksisterende.
  Det er kosmetik, ikke en fejl — men det ligner en fejl; derfor "Starter serveren…".
- **Brug den pooled connection string.** Den direkte er til migrationer og engangsjobs.
- **Hvert API-kald læser sessionen fra Postgres** (én forespørgsel). Ubetydeligt her,
  men det er grunden til at sessionstabellen har index på `expire` — connect-pg-simple
  rydder udløbne sessioner op med den.
- **`food_waste_website` er vurderet og efterladt som den er** (16. okt. 2026). Den har
  ingen rate limiting, en `'changeme'`-fallback for `SESSION_SECRET`, ingen try/catch i
  `/register` og `rejectUnauthorized: false` — men den gemmer kun brugernavn og bcrypt-hash,
  og en angriber vinder adgang til offentlige tilbudsdata. Fallbacken er harmløs af samme
  grund som i fase 2 (sessioner ligger i Postgres). Dens `render.yaml` peger på en
  Render-database, men den kører i virkeligheden på Neon — filen er forældet.

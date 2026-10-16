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
  schema.sql      Databaseskemaet
  .env.example    Påkrævede miljøvariabler (i git); den rigtige .env er gitignoreret
frontend/         Vite + React app (port 5173, proxy /api → backend)
  src/
    components/   Map.tsx, RoutingControl.tsx, Sidebar.tsx, ElevationProfile.tsx
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

Backenden kræver `backend/.env` med `DATABASE_URL` (se `.env.example`). Lokalt peger den
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
  | Waypoint | Fyldt blå cirkel | Et rigtigt punkt på ruten |
  | Midpoint | Hul stiplet cirkel | Træk mig for at indsætte et nyt waypoint |

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
- **Panelet ligger i `.map-main` under kortet, og `invalidateSize()` kaldes når det vises
  eller skjules** (`useEffect` i `Map.tsx`). Leaflet opdager ikke selv at containeren blev
  lavere og efterlader et gråt bånd uden fliser.
- **Hover-markøren er en `L.circleMarker` med `interactive: false`** — den er ikke et
  waypoint, må ikke kunne trækkes eller klikkes, og skal ikke stjæle klik fra kortet.
  Den fjernes både når ruten forsvinder (`dropRouteLine`, `clearAll`) og når profilpanelet
  lukkes mens musen står inde i grafen (cleanup i `ElevationProfile`), hvor `pointerleave`
  aldrig når at blive kaldt.

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

Ikke implementeret endnu:
- Brugerkonti/login — planlagt i detaljer, se "Migreringsplan: brugerkonti" nedenfor
- Mobiloptimering

## Migreringsplan: brugerkonti (Neon Postgres + Neon Auth)

**Status: planlagt, intet implementeret.** Skrevet 31. juli 2026. Alt i dette afsnit er
research og beslutninger, ikke kode der findes. Læs det inden du begynder — flere af
valgene er truffet for at undgå fælder der ikke er åbenlyse.

### Udgangspunkt

Appen skal hostes på **Render's gratis tier**, hvor filsystemet er flygtigt: `routes.db`
bliver slettet ved hver deploy, og instansen lukker ned efter ~15 minutters inaktivitet.
**SQLite kan derfor ikke bruges i produktion** — ikke fordi den er for lille, men fordi
filen ikke overlever. Databasen flytter til **Neon** (serverless Postgres).

Der er oprettet et Neon-projekt, **og Neon Auth er slået til** (31. juli 2026) — så
`neon_auth`-skemaet med users og sessions findes allerede i databasen. Derudover er
**intet sat op**: ingen af vores egne tabeller, ingen miljøvariabler, og intet i Render.

### Skridt der kræver dashboard-adgang (kan ikke gøres herfra)

1. ~~Slå Neon Auth til~~ — **gjort.** Tilbage står kun at finde `NEON_AUTH_URL` i Neons
   dashboard og lægge den i `backend/.env`. Den er offentlig — den må gerne stå i kode og
   env-filer, og JWKS-endpointet under den er beregnet til at være frit tilgængeligt.
2. **Kopiér den *pooled* connection string** (den med `-pooler` i værtsnavnet, ikke den
   direkte) og tilføj `sslmode=require`. Læg den i `backend/.env` som `DATABASE_URL`.
   **Den må aldrig i git eller i en chat.** `.env` er allerede gitignoreret.
3. **Opret en Neon-branch `dev`** og peg den lokale backend på den. Auth-brugere klones med
   branchen, så lokale testbrugere aldrig rammer produktionsdata.
4. Ved deploy: `DATABASE_URL` og `NEON_AUTH_URL` som env vars i Render.

### Fase 1 — SQLite → Postgres, uden auth

Selvstændig og testbar alene. **Efter fase 1 skal appen opføre sig præcis som nu.**

- `better-sqlite3` ud, `pg` ind i `backend/package.json`.
- `src/db.js` bliver en `Pool` med `connectionString: process.env.DATABASE_URL` og
  `ssl: { rejectUnauthorized: true }`.
- **better-sqlite3 er synkron, `pg` er asynkron.** De fire kaldsteder
  (`src/index.js:68, 95, 104` plus skemaet i `db.js`) bliver til `await pool.query(...)`,
  og de handlere der ikke allerede er `async`, skal være det — med try/catch, så en
  databasefejl bliver til 500 og ikke en unhandled rejection der vælter processen.
- Dialektforskelle: `?` → `$1`/`$2`, `INTEGER PRIMARY KEY AUTOINCREMENT` →
  `GENERATED ALWAYS AS IDENTITY`, `datetime('now')` → `now()` med `timestamptz`, og
  `result.lastInsertRowid` → `INSERT ... RETURNING id`.
- `waypoints_json TEXT` kan blive `jsonb`. Ikke nødvendigt — vi laver ingen forespørgsler
  ned i strukturen — men det giver validering af at indholdet faktisk er JSON.
- **Skemaet flytter til en `schema.sql` med et `npm run db:init`-script** i stedet for DDL
  ved hver opstart. Mod en serverless database er det spild at køre `CREATE TABLE IF NOT
  EXISTS` ved hvert koldstart, og det gør det svært at se hvornår skemaet sidst ændrede sig.
- Eksisterende ruter i `backend/routes.db` flyttes med et engangsscript, eller droppes.
- **Backenden læser i dag slet ingen `.env`-fil** — der er hverken `dotenv` eller
  `--env-file`, og `process.env.PORT` virker kun fordi den sættes på kommandolinjen. Det
  skal på plads *først*, ellers er `DATABASE_URL` bare en fil ingen kigger i. Node 24 kan
  selv, så ingen ny afhængighed: brug **`--env-file-if-exists=.env`** i `dev`- og
  `start`-scriptet i `backend/package.json`. Varianten `-if-exists` er ikke pedanteri —
  i Render kommer variablerne fra dashboardet, der findes ingen `.env`-fil, og `--env-file`
  alene får processen til at fejle ved opstart.
- **Læg en `backend/.env.example` i git** med tomme pladsholdere for `DATABASE_URL` og
  `NEON_AUTH_URL`, så det fremgår hvilke variabler der kræves. Kun eksemplet — aldrig
  rigtige værdier.
- **Opdatér README.md og CLAUDE.md som en del af fasen.** README siger i dag "Database:
  SQLite (better-sqlite3)" under Tech Stack, og Getting Started nævner ingen miljøvariabler.
  Begge dele bliver forkerte i samme øjeblik fase 1 er kørt.

### Fase 2 — auth-middleware i Express

Ren tilføjelse; ingen endpoints ændrer opførsel endnu.

Frontenden henter tokenet med `authClient.getSession()` og sender det som
`Authorization: Bearer <token>`. Backenden verificerer signaturen lokalt mod Neons
offentlige nøgler — **ingen netværkskald pr. request**:

```js
const jose = require('jose');
// Ét sæt på modulniveau: createRemoteJWKSet cacher selv nøglerne.
// Bygger man det pr. request, hentes JWKS ved hvert kald.
const JWKS = jose.createRemoteJWKSet(
  new URL(`${process.env.NEON_AUTH_URL}/.well-known/jwks.json`)
);
const ISSUER = new URL(process.env.NEON_AUTH_URL).origin;

async function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Login kræves' });
  try {
    const { payload } = await jose.jwtVerify(token, JWKS, { issuer: ISSUER });
    req.userId = payload.sub;   // UUID-streng, ikke et tal
    next();
  } catch {
    res.status(401).json({ error: 'Ugyldigt eller udløbet token' });
  }
}
```

To ting der bider, hvis man ikke kender dem:

- **Tokens signeres med EdDSA (Ed25519).** Det gamle `jsonwebtoken`-bibliotek understøtter
  ikke den algoritme — derfor `jose`. Vælg ikke bibliotek på vane.
- **Access tokens lever kun 15 minutter.** Frontenden skal hente tokenet pr. kald via
  `getSession()` (klienten cacher selv), ikke gemme det i en variabel ved app-start.
  Gør man det sidste, virker appen i et kvarter og begynder så at give 401.

### Fase 3 — brugerejerskab på ruter

- `routes.user_id TEXT NOT NULL` — `sub` er en **UUID-streng**, ikke et heltal — plus
  index på `(user_id, created_at DESC)`, som er præcis den forespørgsel listen laver.
- **Ingen foreign key til `neon_auth`-skemaet i første omgang.** De tabeller ejes og
  administreres af Neon, og vores skema skal ikke bindes til noget vi ikke kontrollerer,
  før det er bekræftet understøttet i den nuværende udgave. Konsekvens: oprydning ved
  sletning af en bruger skal håndteres i kode.
- Alle tre route-endpoints filtreres på `req.userId`. **`DELETE` skal have
  `WHERE id = $1 AND user_id = $2`** — filtrerer man kun listen, kan en bruger stadig
  slette andres ruter ved at gætte et id. Det er den klassiske fejl i netop dette skridt.

### Fase 4 — frontend

- `@neondatabase/auth` (React SPA-SDK'et), login-UI, Bearer-token på alle `/api/routes`-kald.
- 401 skal håndteres i sidepanelet på linje med de øvrige fejlbeskeder — ellers ser en
  udløbet session ud som en vilkårlig fejl.

### Fase 5 — deploy

- `DATABASE_URL` og `NEON_AUTH_URL` som env vars i Render.
- **`cors()` er helt åben i dag** og skal låses til frontendens origin, før det bliver
  offentligt tilgængeligt.

### Åbne beslutninger

- **Skal `/api/route` (BRouter-proxyen) kræve login?** Ellers står den som en gratis
  routing-proxy andre kan bruge på vores kvote. Anbefaling: ja — men det betyder at man
  ikke kan lege med kortet uden at oprette sig.
- **Hvad sker der med de nuværende gemte ruter?** Tildeles de en konto, eller startes der
  forfra?

### Faldgruber der er værd at kende på forhånd

- **Neon Auth er markeret Beta** (udgaven bygget på Better Auth, lanceret december 2025).
  Fint til et hobbyprojekt, men det skal være et bevidst valg.
- **Der findes to generationer af Neon Auth, og næsten alt man finder via Google handler
  om den gamle.** Den tidligere udgave byggede på Stack Auth og synkroniserede brugere ind
  i en `neon_auth.users_sync`-tabel — asynkront, med soft deletes og råd om `LEFT JOIN` og
  forsigtighed med foreign keys. **Det gælder ikke her.** Den gamle tager ikke imod nye
  brugere, og i den nye er databasen selv kilden til sandheden. Følg ikke de guides.
- **Første kald efter en pause er langsomt.** Neon skalerer til nul, og Render's gratis
  tier lukker ned ved inaktivitet. Det er kosmetik, ikke en fejl — men det ligner en fejl.
- **Brug den pooled connection string.** Den direkte er til migrationer og engangsjobs.

# Bike Trail Editor

Interaktiv webapp til oprettelse og redigering af cykelruter på et kort.

## Tech stack

- **Frontend:** React + Vite + TypeScript, Leaflet.js + react-leaflet
- **Backend:** Node.js + Express (CommonJS)
- **Routing:** BRouter (offentlig API via backend-proxy, `trekking`-profil)
- **Database:** SQLite via better-sqlite3 (ikke implementeret endnu)

## Projektstruktur

```
backend/          Express API server (port 3001)
  src/index.js    Alle routes, BRouter proxy
frontend/         Vite + React app (port 5173, proxy /api → backend)
  src/
    components/   Map.tsx, RoutingControl.tsx, Sidebar.tsx
    routing/      BRouterRouter.ts (ubrugt, erstattet af inline fetch i RoutingControl)
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

## API endpoints

- `GET /api/health` — healthcheck
- `POST /api/route` — BRouter proxy. Body: `{ waypoints: [{lat, lng}, ...], profile?: string }`. Returnerer GeoJSON.
- `GET /api/routes` — liste over gemte ruter (placeholder)

## Arkitekturbeslutninger

- **Ingen Leaflet Routing Machine (LRM):** LRM's custom router-integration virkede ikke med Vite/ESM. Routing er implementeret manuelt med Leaflet polylines og markers.
- **Midpoint markers:** Små blå cirkler placeret midt på hvert rutesegment (langs den faktiske vej, ikke lige linje). Træk dem for at indsætte nye waypoints.
- **Frontend kalder aldrig BRouter direkte** — alt går gennem `/api/route` så routing-provider kan skiftes uden frontend-ændringer.
- **Leaflet marker-ikoner:** Loader fra unpkg CDN pga. Vite bundler-kompatibilitet (standard Leaflet icon import virker ikke).

## Status

Færdigt:
- Kort centreret på Aarhus med OpenStreetMap tiles
- Klik for waypoints, træk for at flytte, højreklik for at slette
- Træk midpoint-cirkler for at indsætte nye waypoints
- Rute beregnes automatisk langs veje via BRouter
- Sidepanel med distance, tid, waypoint-count
- "Ryd rute"-knap

Ikke implementeret endnu:
- Gem/hent ruter (SQLite)
- GPX-eksport
- Brugerkonti/login
- Højdeprofil
- Mobiloptimering

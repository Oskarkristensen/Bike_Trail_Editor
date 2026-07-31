# Bike Trail Editor

Interactive web app for creating and editing bike routes on a map. Click to add waypoints, drag to move them, and routes are automatically calculated along real roads and bike paths via [BRouter](https://brouter.de).

## Features

- Click on the map to add waypoints
- Drag waypoints to move them, right-click to delete
- Drag midpoint markers to insert new waypoints along the route
- Routes follow actual roads and bike paths (BRouter trekking profile)
- Start and finish are shown as distinct flag markers; the roles follow position in the list, so deleting the first waypoint promotes the second
- Save and load routes (SQLite)
- Import GPX files (`trkpt`, `rtept` or `wpt`)
- Export GPX for bike computer apps (Garmin Connect, iGPSPORT, Strava) — full routed geometry with elevation
- Distance, and travel time based on a speed you set yourself (5–50 km/h, remembered in localStorage)
- Elevation profile below the map: hover the chart to mark the matching spot on the route. Total ascent and descent are noise-filtered, since BRouter's SRTM elevations jitter by a few metres between neighbouring points

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Leaflet
- **Backend:** Node.js, Express
- **Routing:** BRouter (public API, proxied through backend)
- **Database:** SQLite (better-sqlite3)

## Getting Started

```bash
# Install dependencies
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..

# Start both servers
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Project Structure

```
backend/           Express API (port 3001)
  src/index.js     Routes + BRouter proxy
  src/db.js        SQLite setup
frontend/          Vite + React (port 5173)
  src/components/  Map, RoutingControl, Sidebar, ElevationProfile
  src/elevation.ts Ascent/descent and chart downsampling
  src/gpx.ts       GPX import and export
  src/types.ts     Shared TypeScript interfaces
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/route` | Proxy to BRouter. Body: `{ waypoints, profile? }` |
| GET | `/api/routes` | List saved routes |
| POST | `/api/routes` | Save route. Body: `{ name, waypoints }` |
| DELETE | `/api/routes/:id` | Delete saved route |

## Planned

- User accounts
- Mobile optimization

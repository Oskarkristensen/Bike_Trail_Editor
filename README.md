# Bike Trail Editor

Interactive web app for creating and editing bike routes on a map. Click to add waypoints, drag to move them, and routes are automatically calculated along real roads and bike paths via [BRouter](https://brouter.de).

Live at **https://bike-trail-editor.onrender.com** (invite only). On the free tier the server sleeps after 15 minutes without visitors, so the first page load after a pause can take 20–30 seconds.

## Features

- Click on the map to add waypoints
- Drag waypoints to move them, right-click to delete
- Drag midpoint markers to insert new waypoints along the route
- Direction arrows on waypoints and midpoints, so the outbound and return legs of an out-and-back route can be told apart
- Routes follow actual roads and bike paths (BRouter trekking profile)
- Start and finish are shown as distinct flag markers; the roles follow position in the list, so deleting the first waypoint promotes the second
- Save and load routes (Postgres)
- Import GPX files (`trkpt`, `rtept` or `wpt`)
- Export GPX for bike computer apps (Garmin Connect, iGPSPORT, Strava) — full routed geometry with elevation
- Distance, and travel time based on a speed you set yourself (5–50 km/h, remembered in localStorage)
- Elevation profile below the map: hover the chart to mark the matching spot on the route. Total ascent and descent are noise-filtered, since BRouter's SRTM elevations jitter by a few metres between neighbouring points
- User accounts with username and password. Signing up requires an invite code, and each user only sees their own saved routes

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Leaflet
- **Backend:** Node.js, Express
- **Routing:** BRouter (public API, proxied through backend)
- **Database:** Postgres on [Neon](https://neon.tech) (`pg`)
- **Hosting:** [Render](https://render.com) free tier; Express serves both the API and the built frontend

## Getting Started

```bash
# Install dependencies
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..

# Configure the database (see below), then create the schema once
npm run db:init --prefix backend

# Start both servers
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Database

The backend needs a Postgres database. Copy `backend/.env.example` to `backend/.env`
and set `DATABASE_URL` to a Neon **pooled** connection string (host contains `-pooler`)
ending in `sslmode=verify-full`. The backend loads `.env` itself via Node's
`--env-file-if-exists` — no `dotenv` needed. Never commit `.env`.

The same file needs `SESSION_SECRET` (`openssl rand -hex 32`) and `INVITE_CODE`
(`openssl rand -base64 15`). New users must enter the invite code to sign up, so share
it only with people who should have access. The backend refuses to start without these.

`npm run db:init --prefix backend` runs `backend/schema.sql`. It is safe to run again.

## Project Structure

```
backend/           Express API (port 3001)
  src/index.js     Routes + BRouter proxy
  src/db.js        Postgres connection pool
  src/init-db.js   Runs schema.sql (npm run db:init)
  src/auth.js      Login, sessions and invite-code sign-up
  schema.sql       Database schema
  .env.example     Required environment variables
frontend/          Vite + React (port 5173)
  src/components/  Map, RoutingControl, Sidebar, ElevationProfile, LoginScreen
  src/api.ts       Fetch wrapper (401 → login screen) and auth calls
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
| POST | `/api/auth/register` | Sign up. Body: `{ username, password, invite }` |
| POST | `/api/auth/login` | Log in. Body: `{ username, password }` |
| POST | `/api/auth/logout` | Log out |
| GET | `/api/auth/me` | Current user, or 401 |

Logins are cookie sessions stored in Postgres. Every endpoint except `/api/health` and
`/api/auth/*` requires a login and returns 401 otherwise. Saved routes belong to the user
who created them; other users can neither see nor delete them.

## Deployment

The app runs as a single Render Web Service: Express serves the API and the built
frontend from the same origin, which keeps the session cookie simple.

| Setting | Value |
|---|---|
| Build Command | `npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Environment | `DATABASE_URL`, `SESSION_SECRET`, `INVITE_CODE`, `NODE_ENV=production` |

Render pre-fills `npm install` and `node index.js`; both must be replaced. The build
installs both packages, builds the frontend and runs `db:init`, so schema changes are
applied on the next deploy. Node 24 is pinned in `.node-version`.

## Planned

- Mobile optimization

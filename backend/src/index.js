const path = require('path');
const express = require('express');
const pool = require('./db');
const auth = require('./auth');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Render sætter en proxy foran og taler HTTP til os. Uden denne tror Express at
// forbindelsen er usikker, og den secure session-cookie bliver aldrig sat.
app.set('trust proxy', 1);

// Ingen cors(): i produktion serverer Express selv frontenden (se nederst), og lokalt
// sørger Vite-proxyen for samme origin. Cookie-login kræver netop samme origin.
app.use(express.json());
app.use(auth.sessionMiddleware);
app.use('/api/auth', auth.router);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const BROUTER_TIMEOUT_MS = 15000;
const ALLOWED_PROFILES = ['trekking', 'fastbike', 'shortest', 'safety'];

function isValidWaypoint(wp) {
  return wp
    && Number.isFinite(wp.lat) && wp.lat >= -90 && wp.lat <= 90
    && Number.isFinite(wp.lng) && wp.lng >= -180 && wp.lng <= 180;
}

// BRouter proxy. Kræver login — ellers står den som en gratis routing-proxy på vores kvote
app.post('/api/route', auth.requireUser, async (req, res) => {
  const { waypoints, profile = 'trekking' } = req.body || {};

  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return res.status(400).json({ error: 'At least 2 waypoints required' });
  }
  if (!waypoints.every(isValidWaypoint)) {
    return res.status(400).json({ error: 'Waypoints must have numeric lat/lng within valid ranges' });
  }
  if (!ALLOWED_PROFILES.includes(profile)) {
    return res.status(400).json({ error: `Unknown profile: ${profile}` });
  }

  // BRouter expects "lng,lat|lng,lat|..."
  const lonlats = waypoints
    .map((wp) => `${wp.lng},${wp.lat}`)
    .join('|');

  const url = `https://brouter.de/brouter?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}&alternativeidx=0&format=geojson`;
  console.log('BRouter request:', url);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(BROUTER_TIMEOUT_MS) });
    if (!response.ok) {
      const text = await response.text();
      console.log('BRouter error:', response.status, text);
      return res.status(response.status).json({ error: text.trim().slice(0, 200) });
    }
    const geojson = await response.json();
    console.log('BRouter success:', geojson.features?.length, 'features');
    res.json(geojson);
  } catch (err) {
    console.error('BRouter proxy error:', err);
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'BRouter svarede ikke i tide' : 'Kunne ikke nå BRouter',
    });
  }
});

// Saved routes CRUD — alle tre er låst til den indloggede brugers egne ruter.
// waypoints_json er jsonb, så pg parser den selv — ingen JSON.parse her, og ingen
// korrupte rækker at springe over: Postgres afviser ugyldig JSON ved INSERT.
app.get('/api/routes', auth.requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, waypoints_json AS waypoints, created_at FROM routes
       WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Kunne ikke hente ruter:', err);
    res.status(500).json({ error: 'Kunne ikke hente ruter' });
  }
});

app.post('/api/routes', auth.requireUser, async (req, res) => {
  const { name, waypoints } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return res.status(400).json({ error: 'At least 2 waypoints required' });
  }
  if (!waypoints.every(isValidWaypoint)) {
    return res.status(400).json({ error: 'Waypoints must have numeric lat/lng within valid ranges' });
  }

  const trimmed = name.trim().slice(0, 100);
  const cleaned = waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng }));

  try {
    const { rows } = await pool.query(
      'INSERT INTO routes (name, waypoints_json, user_id) VALUES ($1, $2, $3) RETURNING id',
      [trimmed, JSON.stringify(cleaned), req.userId]
    );
    res.status(201).json({ id: rows[0].id, name: trimmed, waypoints: cleaned });
  } catch (err) {
    console.error('Kunne ikke gemme rute:', err);
    res.status(500).json({ error: 'Kunne ikke gemme ruten' });
  }
});

app.delete('/api/routes/:id', auth.requireUser, async (req, res) => {
  const id = Number(req.params.id);
  // Øvre grænse fordi id er Postgres INTEGER (int4): et større tal giver ellers
  // "out of range" fra databasen og bliver til 500 i stedet for 400.
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
    return res.status(400).json({ error: 'Invalid route id' });
  }

  try {
    // user_id i WHERE er det vigtige: uden den kan enhver indlogget bruger slette andres
    // ruter ved at gætte et id. En andens rute giver 404, ikke 403: set fra din konto
    // findes den ikke, og så behøver vi heller ikke et ekstra opslag for at skelne.
    const { rowCount } = await pool.query(
      'DELETE FROM routes WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Route not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Kunne ikke slette rute:', err);
    res.status(500).json({ error: 'Kunne ikke slette ruten' });
  }
});

// Den byggede frontend (npm run build i frontend/). Samme origin som API'et, så
// session-cookien virker uden cross-site-regler. Lokalt bruges Vite på 5173 i stedet;
// findes mappen ikke, svarer denne bare 404. Står efter /api, så den aldrig skygger.
app.use(express.static(path.join(__dirname, '..', '..', 'frontend', 'dist')));

// Fanger bl.a. malformed JSON fra express.json() så serveren svarer pænt
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled error:', err);
  const status = err.status && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

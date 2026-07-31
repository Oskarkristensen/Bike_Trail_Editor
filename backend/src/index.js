const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json());

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

// BRouter proxy
app.post('/api/route', async (req, res) => {
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

// Saved routes CRUD
app.get('/api/routes', (req, res) => {
  const rows = db.prepare('SELECT id, name, waypoints_json, created_at FROM routes ORDER BY created_at DESC').all();
  const routes = [];
  for (const r of rows) {
    try {
      routes.push({ ...r, waypoints: JSON.parse(r.waypoints_json) });
    } catch {
      // Overspring korrupte rækker frem for at fejle hele listen
      console.warn(`Skipping route ${r.id}: invalid waypoints_json`);
    }
  }
  res.json(routes);
});

app.post('/api/routes', (req, res) => {
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
  const result = db.prepare('INSERT INTO routes (name, waypoints_json) VALUES (?, ?)').run(trimmed, JSON.stringify(cleaned));
  res.status(201).json({ id: result.lastInsertRowid, name: trimmed, waypoints: cleaned });
});

app.delete('/api/routes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid route id' });
  }
  const result = db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.json({ ok: true });
});

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

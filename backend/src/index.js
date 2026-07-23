const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// BRouter proxy
app.post('/api/route', async (req, res) => {
  const { waypoints, profile = 'trekking' } = req.body;

  if (!waypoints || waypoints.length < 2) {
    return res.status(400).json({ error: 'At least 2 waypoints required' });
  }

  // BRouter expects "lng,lat|lng,lat|..."
  const lonlats = waypoints
    .map((wp) => `${wp.lng},${wp.lat}`)
    .join('|');

  const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  console.log('BRouter request:', url);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.log('BRouter error:', response.status, text);
      return res.status(response.status).json({ error: text });
    }
    const geojson = await response.json();
    console.log('BRouter success:', geojson.features?.length, 'features');
    res.json(geojson);
  } catch (err) {
    console.error('BRouter proxy error:', err);
    res.status(502).json({ error: 'Failed to reach BRouter' });
  }
});

// Saved routes CRUD
app.get('/api/routes', (req, res) => {
  const routes = db.prepare('SELECT id, name, waypoints_json, created_at FROM routes ORDER BY created_at DESC').all();
  res.json(routes.map((r) => ({
    ...r,
    waypoints: JSON.parse(r.waypoints_json),
  })));
});

app.post('/api/routes', (req, res) => {
  const { name, waypoints } = req.body;
  if (!name || !waypoints || waypoints.length < 2) {
    return res.status(400).json({ error: 'Name and at least 2 waypoints required' });
  }
  const result = db.prepare('INSERT INTO routes (name, waypoints_json) VALUES (?, ?)').run(name, JSON.stringify(waypoints));
  res.status(201).json({ id: result.lastInsertRowid, name, waypoints });
});

app.delete('/api/routes/:id', (req, res) => {
  const result = db.prepare('DELETE FROM routes WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

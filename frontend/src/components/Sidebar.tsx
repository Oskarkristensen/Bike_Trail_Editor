import { useRef, useState, useEffect, useCallback } from 'react'
import type { RouteInfo, SavedRoute } from '../types'

const MAX_WAYPOINTS = 20

function parseGPX(xml: string): { lat: number; lng: number }[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  // Try <trkpt>, then <rtept>, then <wpt>
  let points = doc.querySelectorAll('trkpt')
  if (points.length === 0) points = doc.querySelectorAll('rtept')
  if (points.length === 0) points = doc.querySelectorAll('wpt')

  const coords: { lat: number; lng: number }[] = []
  points.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute('lat') || '')
    const lng = parseFloat(pt.getAttribute('lon') || '')
    if (!isNaN(lat) && !isNaN(lng)) coords.push({ lat, lng })
  })
  return coords
}

function sampleWaypoints(coords: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  if (coords.length <= MAX_WAYPOINTS) return coords
  const result: { lat: number; lng: number }[] = [coords[0]]
  const step = (coords.length - 1) / (MAX_WAYPOINTS - 1)
  for (let i = 1; i < MAX_WAYPOINTS - 1; i++) {
    result.push(coords[Math.round(i * step)])
  }
  result.push(coords[coords.length - 1])
  return result
}

interface SidebarProps {
  routeInfo: RouteInfo | null
  onClearRoute: () => void
  onSaveRoute: (name: string) => void
  onLoadRoute: (route: SavedRoute) => void
  onImportGPX: (waypoints: { lat: number; lng: number }[]) => void
}

function formatDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`
}

function formatTime(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}t ${m}m`
}

export default function Sidebar({ routeInfo, onClearRoute, onSaveRoute, onLoadRoute, onImportGPX }: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [routeName, setRouteName] = useState('')

  const fetchRoutes = useCallback(async () => {
    const res = await fetch('/api/routes')
    if (res.ok) setSavedRoutes(await res.json())
  }, [])

  useEffect(() => { fetchRoutes() }, [fetchRoutes])

  const handleSave = () => {
    if (!routeName.trim()) return
    onSaveRoute(routeName.trim())
    setRouteName('')
    setShowSaveDialog(false)
    // Refresh list after short delay for DB write
    setTimeout(fetchRoutes, 200)
  }

  const handleDelete = async (id: number) => {
    await fetch(`/api/routes/${id}`, { method: 'DELETE' })
    fetchRoutes()
  }

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const coords = parseGPX(reader.result as string)
      if (coords.length < 2) {
        alert('Kunne ikke finde nok punkter i GPX-filen')
        return
      }
      onImportGPX(sampleWaypoints(coords))
    }
    reader.readAsText(file)
    // Reset så samme fil kan importeres igen
    e.target.value = ''
  }

  return (
    <aside className="sidebar">
      <section className="sidebar-section">
        <h2>Rute</h2>
        {routeInfo ? (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-value">{formatDistance(routeInfo.distance)}</span>
                <span className="stat-label">Distance</span>
              </div>
              <div className="stat">
                <span className="stat-value">{formatTime(routeInfo.time)}</span>
                <span className="stat-label">Estimeret tid</span>
              </div>
              <div className="stat">
                <span className="stat-value">{routeInfo.waypointCount}</span>
                <span className="stat-label">Waypoints</span>
              </div>
            </div>

            <div className="sidebar-actions">
              {showSaveDialog ? (
                <div className="save-dialog">
                  <input
                    type="text"
                    placeholder="Rutenavn..."
                    value={routeName}
                    onChange={(e) => setRouteName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                    autoFocus
                  />
                  <div className="save-dialog-buttons">
                    <button className="btn btn-primary" onClick={handleSave}>
                      Gem
                    </button>
                    <button className="btn btn-secondary" onClick={() => setShowSaveDialog(false)}>
                      Annullér
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={() => setShowSaveDialog(true)}>
                  Gem rute
                </button>
              )}
              <button className="btn btn-secondary" disabled>
                Eksportér GPX
              </button>
              <button className="btn btn-danger" onClick={onClearRoute}>
                Ryd rute
              </button>
            </div>
          </>
        ) : (
          <p className="sidebar-hint">Klik på kortet for at starte en rute</p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".gpx"
          style={{ display: 'none' }}
          onChange={handleFileImport}
        />
        <button
          className="btn btn-secondary"
          style={{ marginTop: routeInfo ? 0 : 12 }}
          onClick={() => fileInputRef.current?.click()}
        >
          Importér GPX
        </button>
      </section>

      <section className="sidebar-section">
        <h2>Gemte ruter</h2>
        {savedRoutes.length === 0 ? (
          <p className="sidebar-hint">Ingen gemte ruter endnu</p>
        ) : (
          <ul className="route-list">
            {savedRoutes.map((route) => (
              <li key={route.id} className="route-item">
                <button className="route-item-name" onClick={() => onLoadRoute(route)}>
                  {route.name}
                </button>
                <span className="route-item-meta">
                  {route.waypoints.length} waypoints
                </span>
                <button className="route-item-delete" onClick={() => handleDelete(route.id)} title="Slet rute">
                  &times;
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

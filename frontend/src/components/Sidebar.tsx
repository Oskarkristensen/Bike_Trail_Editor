import { useRef, useState, useEffect, useCallback } from 'react'
import { parseGPX, sampleWaypoints } from '../gpx'
import { apiFetch } from '../api'
import type { ElevationProfile } from '../elevation'
import type { RouteInfo, SavedRoute } from '../types'

const SPEED_KEY = 'bike-trail-editor:speed-kmh'
const MIN_SPEED = 5
const MAX_SPEED = 50
// 20 km/t svarer omtrent til BRouters trekking-tempo, så tallet ikke hopper
const DEFAULT_SPEED = 20

function clampSpeed(kmh: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, kmh))
}

// Accepterer dansk decimalkomma; null betyder "ikke et brugbart tal"
function parseSpeed(value: string): number | null {
  const trimmed = value.trim().replace(',', '.')
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function loadSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed) ? clampSpeed(parsed) : DEFAULT_SPEED
  } catch {
    // localStorage kan være blokeret (privat browsing, strenge cookie-indstillinger)
    return DEFAULT_SPEED
  }
}

interface SidebarProps {
  routeInfo: RouteInfo | null
  /** null når ruten ikke har højdedata — så vises stigning/fald slet ikke */
  elevation: ElevationProfile | null
  routeError: string | null
  showElevation: boolean
  onToggleElevation: () => void
  onClearRoute: () => void
  onSaveRoute: (name: string) => Promise<void>
  onLoadRoute: (route: SavedRoute) => void
  onImportGPX: (waypoints: { lat: number; lng: number }[]) => void
  onExportGPX: (name: string) => void
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
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

// BRouters egen tidsmodel bruges ikke — tiden følger den hastighed brugeren sætter
function travelSeconds(meters: number, speedKmh: number): number {
  return (meters * 3.6) / speedKmh
}

export default function Sidebar({ routeInfo, elevation, routeError, showElevation, onToggleElevation, onClearRoute, onSaveRoute, onLoadRoute, onImportGPX, onExportGPX }: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [routeName, setRouteName] = useState('')
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [exportName, setExportName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // To states: speed er det tiden regnes ud fra, speedInput er hvad der står i feltet.
  // Feltet må gerne være midlertidigt ugyldigt mens man skriver.
  const [speed, setSpeed] = useState(loadSpeed)
  const [speedInput, setSpeedInput] = useState(() => String(loadSpeed()))

  useEffect(() => {
    try {
      localStorage.setItem(SPEED_KEY, String(speed))
    } catch {
      // Kan ikke gemmes — hastigheden virker stadig i denne session
    }
  }, [speed])

  const handleSpeedChange = (value: string) => {
    setSpeedInput(value)
    const parsed = parseSpeed(value)
    if (parsed !== null && parsed >= MIN_SPEED && parsed <= MAX_SPEED) {
      setSpeed(parsed)
    }
  }

  // Ryd op når feltet forlades: tomt eller uden for interval snapper tilbage
  const handleSpeedBlur = () => {
    const parsed = parseSpeed(speedInput)
    const next = parsed === null ? speed : clampSpeed(parsed)
    setSpeed(next)
    setSpeedInput(String(next))
  }

  const fetchRoutes = useCallback(async () => {
    try {
      const res = await apiFetch('/api/routes')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSavedRoutes(await res.json())
    } catch (err) {
      setActionError(errorMessage(err, 'Kunne ikke hente gemte ruter'))
    }
  }, [])

  useEffect(() => { fetchRoutes() }, [fetchRoutes])

  const handleSave = async () => {
    const name = routeName.trim()
    if (!name || isSaving) return

    setIsSaving(true)
    setActionError(null)
    try {
      await onSaveRoute(name)
      setRouteName('')
      setShowSaveDialog(false)
      await fetchRoutes()
    } catch (err) {
      setActionError(errorMessage(err, 'Kunne ikke gemme ruten'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleExport = () => {
    const name = exportName.trim()
    if (!name) return
    setActionError(null)
    try {
      onExportGPX(name)
      setExportName('')
      setShowExportDialog(false)
    } catch (err) {
      setActionError(errorMessage(err, 'Kunne ikke eksportere ruten'))
    }
  }

  const handleDelete = async (id: number) => {
    setActionError(null)
    try {
      const res = await apiFetch(`/api/routes/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Kunne ikke slette ruten (HTTP ${res.status})`)
      await fetchRoutes()
    } catch (err) {
      setActionError(errorMessage(err, 'Kunne ikke slette ruten'))
    }
  }

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setActionError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const coords = parseGPX(reader.result as string)
      if (coords.length < 2) {
        setActionError('Kunne ikke finde nok punkter i GPX-filen')
        return
      }
      onImportGPX(sampleWaypoints(coords))
    }
    reader.onerror = () => setActionError('Kunne ikke læse GPX-filen')
    reader.readAsText(file)
    // Reset så samme fil kan importeres igen
    e.target.value = ''
  }

  const visibleError = routeError ?? actionError

  return (
    <aside className="sidebar">
      <section className="sidebar-section">
        <h2>Rute</h2>
        {visibleError && <p className="sidebar-error">{visibleError}</p>}
        {routeInfo ? (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-value">{formatDistance(routeInfo.distance)}</span>
                <span className="stat-label">Distance</span>
              </div>
              <div className="stat">
                <span className="stat-value">{formatTime(travelSeconds(routeInfo.distance, speed))}</span>
                <span className="stat-label">Tid ved {speed} km/t</span>
              </div>
              {elevation && (
                <>
                  <div className="stat">
                    <span className="stat-value">{Math.round(elevation.ascent)} m</span>
                    <span className="stat-label">Stigning</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{Math.round(elevation.descent)} m</span>
                    <span className="stat-label">Fald</span>
                  </div>
                </>
              )}
              <div className="stat">
                <span className="stat-value">{routeInfo.waypointCount}</span>
                <span className="stat-label">Waypoints</span>
              </div>
            </div>

            <label className="speed-control">
              <span className="speed-control-label">Hastighed</span>
              {/* type="text", ikke "number" — ingen op/ned-pile, og scrollhjulet
                  kan ikke ændre værdien. Klampningen sker i handleSpeedBlur. */}
              <input
                type="text"
                inputMode="decimal"
                value={speedInput}
                onChange={(e) => handleSpeedChange(e.target.value)}
                onBlur={handleSpeedBlur}
              />
              <span className="speed-control-unit">km/t</span>
            </label>
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

        {/* Knapkolonnen ligger uden for routeInfo-betingelsen, så importknappen
            også er tilgængelig når kortet er tomt */}
        <div className="sidebar-actions">
          {showSaveDialog ? (
            <div className="save-dialog">
              <input
                type="text"
                placeholder="Rutenavn..."
                value={routeName}
                onChange={(e) => setRouteName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
                autoFocus
              />
              <div className="save-dialog-buttons">
                <button className="btn btn-primary" onClick={() => void handleSave()} disabled={isSaving}>
                  {isSaving ? 'Gemmer...' : 'Gem'}
                </button>
                <button className="btn btn-secondary" onClick={() => setShowSaveDialog(false)} disabled={isSaving}>
                  Annullér
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => setShowSaveDialog(true)} disabled={!routeInfo}>
              Gem rute
            </button>
          )}
          {showExportDialog ? (
            <div className="save-dialog">
              <input
                type="text"
                placeholder="Navn til cykelcomputeren..."
                value={exportName}
                onChange={(e) => setExportName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleExport() }}
                autoFocus
              />
              <div className="save-dialog-buttons">
                <button className="btn btn-primary" onClick={handleExport}>
                  Eksportér
                </button>
                <button className="btn btn-secondary" onClick={() => setShowExportDialog(false)}>
                  Annullér
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-secondary" onClick={() => setShowExportDialog(true)} disabled={!routeInfo}>
              Eksportér GPX
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
            Importér GPX
          </button>
          {/* Kun vejen tilbage: panelet lukkes med sit eget kryds, så to knapper
              til samme ting ville stå og skifte plads i kolonnen */}
          {elevation && !showElevation && (
            <button className="btn btn-secondary" onClick={onToggleElevation}>
              Vis højdeprofil
            </button>
          )}
          <button className="btn btn-danger" onClick={onClearRoute} disabled={!routeInfo}>
            Ryd rute
          </button>
        </div>
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

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
  onClearRoute: () => void
  onSaveRoute: (name: string) => Promise<void>
  onLoadRoute: (route: SavedRoute) => void
  onImportGPX: (waypoints: { lat: number; lng: number }[]) => void
  onExportGPX: (name: string) => void
}

// Sletning (højreklik / langt tryk) og træk er ikke til at gætte, så det står på skærmen.
// Teksten følger den primære input: pointer: coarse = finger. Samme test som markørernes
// størrelse i RoutingControl.tsx. Sletning står først: det er den man ikke kan gætte,
// og på en smal skærm blev slutningen af teksten ellers skåret væk.
const EDIT_TIP = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  ? 'Hold fingeren på et punkt for at slette det · træk for at flytte'
  : 'Højreklik på et punkt for at slette det · træk for at flytte'

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

export default function Sidebar({ routeInfo, elevation, routeError, onClearRoute, onSaveRoute, onLoadRoute, onImportGPX, onExportGPX }: SidebarProps) {
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
  // Kun på smalle skærme: panellet ligger under kortet og foldes ud/ind. På desktop
  // er knappen skjult med CSS, og indholdet vises altid.
  const [mobileOpen, setMobileOpen] = useState(false)

  // Håndtaget lover at panelet kan trækkes — så det skal også kunne det. Arket følger
  // fingeren mens man trækker, og glider på plads ved slip: op åbner, ned lukker. Et
  // tryk uden bevægelse håndteres af onClick som før. Et strøg efterfølges også af et
  // click-event, som skal ignoreres, ellers skifter panelet straks tilbage igen.
  // Selve placeringen og animationen ligger i CSS (.sidebar på smalle skærme); her sættes
  // kun fingerens forskydning som --sheet-drag. Den sættes direkte på elementet, ikke
  // via state: React skal ikke rendere 60 gange i sekundet under et træk.
  const asideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const swipeStartY = useRef<number | null>(null)
  const ignoreNextClick = useRef(false)
  const SWIPE_THRESHOLD_PX = 30

  // Højden på den synlige linje, til CSS'ens --sheet-peek. Målt, ikke hårdkodet: på en
  // rigtig iPhone blev teksten større end i emulatoren. Sættes på forælderen, så kortet
  // kan give plads til den lukkede linje.
  useEffect(() => {
    const toggle = toggleRef.current
    const layout = asideRef.current?.parentElement
    if (!toggle || !layout) return
    const observer = new ResizeObserver(() => {
      // offsetHeight er 0 på desktop, hvor linjen er skjult — så rør vi intet
      if (toggle.offsetHeight > 0) {
        layout.style.setProperty('--sheet-peek', `${toggle.offsetHeight}px`)
      }
    })
    observer.observe(toggle)
    return () => observer.disconnect()
  }, [])

  const setDrag = (px: number | null) => {
    const aside = asideRef.current
    if (!aside) return
    if (px === null) {
      aside.style.removeProperty('--sheet-drag')
      aside.classList.remove('sidebar--dragging')
    } else {
      aside.style.setProperty('--sheet-drag', `${px}px`)
      aside.classList.add('sidebar--dragging')
    }
  }

  const handleTogglePointerDown = (e: React.PointerEvent) => {
    swipeStartY.current = e.clientY
    // Linjen er kun ~60 px høj, så et strøg slutter over kortet. Uden capture lander
    // pointerup dér og ikke her — strøget blev aldrig registreret (målt med Playwright)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handleTogglePointerMove = (e: React.PointerEvent) => {
    if (swipeStartY.current === null) return
    setDrag(e.clientY - swipeStartY.current)
  }
  const handleTogglePointerUp = (e: React.PointerEvent) => {
    if (swipeStartY.current === null) return
    const dy = e.clientY - swipeStartY.current
    swipeStartY.current = null
    // Fjern forskydningen og slå transitionen til i samme omgang: så glider arket fra
    // hvor fingeren slap, til åbent eller lukket
    setDrag(null)
    if (Math.abs(dy) < SWIPE_THRESHOLD_PX) return  // et tryk — onClick klarer det
    ignoreNextClick.current = true
    setMobileOpen(dy < 0)  // op = åbn, ned = luk
  }
  const handleTogglePointerCancel = () => {
    swipeStartY.current = null
    setDrag(null)
  }
  const handleToggleClick = () => {
    if (ignoreNextClick.current) {
      ignoreNextClick.current = false
      return
    }
    setMobileOpen((open) => !open)
  }

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

  const summary = routeInfo
    ? [
        formatDistance(routeInfo.distance),
        formatTime(travelSeconds(routeInfo.distance, speed)),
        elevation ? `↑ ${Math.round(elevation.ascent)} m` : null,
      ].filter(Boolean).join(' · ')
    : 'Tryk på kortet for at starte'
  // Uden en rute er der intet at opsummere — sig i stedet hvad menuen indeholder, så
  // import og gemte ruter kan findes før man har tegnet noget
  const emptyHint = 'Gem, hent og importér ruter'

  return (
    <aside ref={asideRef} className={`sidebar${mobileOpen ? ' sidebar--open' : ''}`}>
      {/* Foldet sammen vises kun denne linje. Den skal *ligne* noget der kan trækkes op —
          håndtag, skygge og en tydelig knap — ellers opdager man den ikke (Oskars test på
          en rigtig iPhone, 18. okt. 2026). Fejl vises også her, så en routingfejl ikke
          gemmer sig i et lukket panel. Hele linjen er trykflade, ikke kun knappen. */}
      <button
        ref={toggleRef}
        className="sidebar-toggle"
        onClick={handleToggleClick}
        onPointerDown={handleTogglePointerDown}
        onPointerMove={handleTogglePointerMove}
        onPointerUp={handleTogglePointerUp}
        onPointerCancel={handleTogglePointerCancel}
        aria-expanded={mobileOpen}
      >
        <span className="sidebar-toggle-handle" aria-hidden="true" />
        <span className="sidebar-toggle-text">
          <span className={visibleError ? 'sidebar-toggle-error' : 'sidebar-toggle-summary'}>
            {visibleError ?? summary}
          </span>
          {!visibleError && (
            <span className="sidebar-toggle-hint">{routeInfo ? EDIT_TIP : emptyHint}</span>
          )}
        </span>
        <span className="sidebar-toggle-button">{mobileOpen ? 'Luk ▾' : 'Menu ▴'}</span>
      </button>

      <div className="sidebar-body">
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

            <p className="sidebar-tip">{EDIT_TIP}</p>
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
      </div>
    </aside>
  )
}

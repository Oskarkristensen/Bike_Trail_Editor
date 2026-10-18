import { useCallback, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer } from 'react-leaflet'
import type { Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import RoutingControl from './RoutingControl'
import Sidebar from './Sidebar'
import ElevationProfileChart from './ElevationProfile'
import { buildGPX, gpxFilename, downloadFile } from '../gpx'
import { buildElevationProfile } from '../elevation'
import { apiFetch } from '../api'
import type { RoutingControlHandle, RouteInfo, SavedRoute } from '../types'

const AARHUS_CENTER: [number, number] = [56.15, 10.19]
const DEFAULT_ZOOM = 13

export default function Map() {
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [showElevation, setShowElevation] = useState(true)
  const routingRef = useRef<RoutingControlHandle>(null)
  const mapRef = useRef<LeafletMap | null>(null)

  const handleRouteUpdate = useCallback((info: RouteInfo | null) => {
    setRouteInfo(info)
  }, [])

  // Profilen regnes én gang pr. rute, ikke ved hver bevægelse i grafen
  const elevation = useMemo(
    () => (routeInfo ? buildElevationProfile(routeInfo.points) : null),
    [routeInfo],
  )
  const elevationVisible = showElevation && elevation !== null

  // Leaflet opdager kun selv når *vinduet* ændrer størrelse, ikke når containeren gør.
  // Den ændrer sig når højdeprofilen vises/skjules, når mobilpanelet foldes ud/ind, og
  // når telefonen drejes. Uden invalidateSize regner Leaflet med den gamle størrelse og
  // efterlader et gråt bånd uden fliser. Én observer dækker alle tilfælde.
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const setMap = useCallback((map: LeafletMap | null) => {
    mapRef.current = map
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (map) {
      const observer = new ResizeObserver(() => map.invalidateSize())
      observer.observe(map.getContainer())
      resizeObserverRef.current = observer
    }
  }, [])

  const handleHoverPoint = useCallback((point: { lat: number; lng: number } | null) => {
    routingRef.current?.highlightPoint(point)
  }, [])

  const handleClearRoute = useCallback(() => {
    routingRef.current?.clearRoute()
  }, [])

  // Kaster ved fejl, så Sidebar kan vise beskeden og først derefter lukke dialogen
  const handleSaveRoute = useCallback(async (name: string) => {
    const waypoints = routingRef.current?.getWaypoints()
    if (!waypoints || waypoints.length < 2) {
      throw new Error('Ruten skal have mindst 2 waypoints')
    }

    const res = await apiFetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, waypoints }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error || `Kunne ikke gemme ruten (HTTP ${res.status})`)
    }
  }, [])

  // Eksporterer hele den beregnede rutegeometri, ikke kun de klikkede waypoints —
  // det er den, cykelcomputeren skal navigere efter
  const handleExportGPX = useCallback((name: string) => {
    const points = routingRef.current?.getRouteCoords()
    if (!points || points.length < 2) {
      throw new Error('Der er ingen beregnet rute at eksportere')
    }
    downloadFile(gpxFilename(name), buildGPX({ name, points }), 'application/gpx+xml')
  }, [])

  const handleLoadRoute = useCallback((route: SavedRoute) => {
    routingRef.current?.loadWaypoints(route.waypoints)
  }, [])

  const handleImportGPX = useCallback((waypoints: { lat: number; lng: number }[]) => {
    routingRef.current?.loadWaypoints(waypoints)
  }, [])

  return (
    <div className="map-layout">
      <Sidebar
        routeInfo={routeInfo}
        elevation={elevation}
        routeError={routeError}
        onClearRoute={handleClearRoute}
        onSaveRoute={handleSaveRoute}
        onLoadRoute={handleLoadRoute}
        onImportGPX={handleImportGPX}
        onExportGPX={handleExportGPX}
      />
      <div className="map-main">
        <MapContainer
          ref={setMap}
          center={AARHUS_CENTER}
          zoom={DEFAULT_ZOOM}
          style={{ flex: 1, minHeight: 0 }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <RoutingControl
            ref={routingRef}
            onRouteUpdate={handleRouteUpdate}
            onRouteError={setRouteError}
          />
        </MapContainer>
        {/* Vejen tilbage til en lukket højdeprofil — samme sted som den forsvandt fra.
            Lå før som knap nr. 6 i sidepanelet; på en telefon skulle man åbne menuen og
            scrolle i den, og den blev ikke fundet. Uden for MapContainer, så et tryk
            aldrig lander på kortet som et nyt waypoint. */}
        {elevation && !showElevation && (
          <button className="elevation-show" onClick={() => setShowElevation(true)}>
            Højdeprofil ▴
          </button>
        )}
        {elevation && elevationVisible && (
          <ElevationProfileChart
            profile={elevation}
            onHoverPoint={handleHoverPoint}
            onClose={() => setShowElevation(false)}
          />
        )}
      </div>
    </div>
  )
}

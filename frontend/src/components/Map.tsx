import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer } from 'react-leaflet'
import type { Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import RoutingControl from './RoutingControl'
import Sidebar from './Sidebar'
import ElevationProfileChart from './ElevationProfile'
import { buildGPX, gpxFilename, downloadFile } from '../gpx'
import { buildElevationProfile } from '../elevation'
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

  // Kortet bliver lavere når panelet dukker op. Uden invalidateSize regner
  // Leaflet stadig med den gamle højde og efterlader et gråt bånd uden fliser.
  useEffect(() => {
    mapRef.current?.invalidateSize()
  }, [elevationVisible])

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

    const res = await fetch('/api/routes', {
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
        showElevation={showElevation}
        onToggleElevation={() => setShowElevation((visible) => !visible)}
        onClearRoute={handleClearRoute}
        onSaveRoute={handleSaveRoute}
        onLoadRoute={handleLoadRoute}
        onImportGPX={handleImportGPX}
        onExportGPX={handleExportGPX}
      />
      <div className="map-main">
        <MapContainer
          ref={mapRef}
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

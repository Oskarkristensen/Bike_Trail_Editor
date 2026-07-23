import { useCallback, useRef, useState } from 'react'
import { MapContainer, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import RoutingControl from './RoutingControl'
import Sidebar from './Sidebar'
import type { RoutingControlHandle, RouteInfo, SavedRoute } from '../types'

const AARHUS_CENTER: [number, number] = [56.15, 10.19]
const DEFAULT_ZOOM = 13

export default function Map() {
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  const routingRef = useRef<RoutingControlHandle>(null)

  const handleRouteUpdate = useCallback((info: RouteInfo | null) => {
    setRouteInfo(info)
  }, [])

  const handleClearRoute = useCallback(() => {
    routingRef.current?.clearRoute()
  }, [])

  const handleSaveRoute = useCallback(async (name: string) => {
    const waypoints = routingRef.current?.getWaypoints()
    if (!waypoints || waypoints.length < 2) return

    await fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, waypoints }),
    })
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
        onClearRoute={handleClearRoute}
        onSaveRoute={handleSaveRoute}
        onLoadRoute={handleLoadRoute}
        onImportGPX={handleImportGPX}
      />
      <MapContainer
        center={AARHUS_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ flex: 1 }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <RoutingControl ref={routingRef} onRouteUpdate={handleRouteUpdate} />
      </MapContainer>
    </div>
  )
}

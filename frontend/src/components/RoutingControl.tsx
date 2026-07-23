import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

// Fix default marker icons (Leaflet + Vite bundler issue)
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const midpointIcon = L.divIcon({
  className: 'midpoint-marker',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})

import type { RoutingControlHandle, RouteInfo } from '../types'

interface RoutingControlProps {
  onRouteUpdate?: (info: RouteInfo | null) => void
}

interface RouteState {
  waypoints: L.LatLng[]
  markers: L.Marker[]
  midpointMarkers: L.Marker[]
  routeLine: L.Polyline | null
  routeCoords: L.LatLng[]  // full routed coordinates from BRouter
}

async function fetchRoute(waypoints: L.LatLng[]): Promise<{
  coords: L.LatLng[]
  distance: number
  time: number
} | null> {
  if (waypoints.length < 2) return null

  const wps = waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng }))
  const res = await fetch('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waypoints: wps }),
  })

  if (!res.ok) return null
  const geojson = await res.json()
  const feature = geojson.features?.[0]
  if (!feature) return null

  const coords = feature.geometry.coordinates.map(
    (c: number[]) => L.latLng(c[1], c[0]),
  )
  const props = feature.properties || {}
  return {
    coords,
    distance: parseFloat(props['track-length'] || '0'),
    time: parseFloat(props['total-time'] || '0'),
  }
}

function findClosestIndex(coords: L.LatLng[], target: L.LatLng): number {
  let minDist = Infinity
  let minIdx = 0
  for (let i = 0; i < coords.length; i++) {
    const d = coords[i].distanceTo(target)
    if (d < minDist) {
      minDist = d
      minIdx = i
    }
  }
  return minIdx
}

function findMidpointAlongPath(coords: L.LatLng[]): L.LatLng {
  if (coords.length === 0) return L.latLng(0, 0)
  if (coords.length === 1) return coords[0]

  // Calculate total length
  let totalDist = 0
  for (let i = 1; i < coords.length; i++) {
    totalDist += coords[i - 1].distanceTo(coords[i])
  }

  // Walk along until we reach half the total distance
  const halfDist = totalDist / 2
  let accumulated = 0
  for (let i = 1; i < coords.length; i++) {
    const segDist = coords[i - 1].distanceTo(coords[i])
    if (accumulated + segDist >= halfDist) {
      const frac = (halfDist - accumulated) / segDist
      return L.latLng(
        coords[i - 1].lat + frac * (coords[i].lat - coords[i - 1].lat),
        coords[i - 1].lng + frac * (coords[i].lng - coords[i - 1].lng),
      )
    }
    accumulated += segDist
  }

  return coords[coords.length - 1]
}

export default forwardRef<RoutingControlHandle, RoutingControlProps>(function RoutingControl({ onRouteUpdate }, ref) {
  const map = useMap()
  const stateRef = useRef<RouteState>({
    waypoints: [],
    markers: [],
    midpointMarkers: [],
    routeLine: null,
    routeCoords: [],
  })
  const onRouteUpdateRef = useRef(onRouteUpdate)
  onRouteUpdateRef.current = onRouteUpdate

  const clearAll = useCallback(() => {
    const state = stateRef.current
    state.markers.forEach((m) => m.remove())
    state.midpointMarkers.forEach((m) => m.remove())
    state.routeLine?.remove()
    state.waypoints = []
    state.markers = []
    state.midpointMarkers = []
    state.routeLine = null
    state.routeCoords = []
  }, [])

  useImperativeHandle(ref, () => ({
    clearRoute() {
      clearAll()
      onRouteUpdateRef.current?.(null)
    },
    getWaypoints() {
      return stateRef.current.waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng }))
    },
    loadWaypoints(waypoints: { lat: number; lng: number }[]) {
      clearAll()
      const state = stateRef.current
      waypoints.forEach((wp) => {
        const latlng = L.latLng(wp.lat, wp.lng)
        const marker = createWaypointMarkerRef.current!(latlng)
        state.waypoints.push(latlng)
        state.markers.push(marker)
      })
      updateRouteRef.current?.()
    },
  }))

  // We need stable references to functions that reference each other
  const updateRouteRef = useRef<() => Promise<void>>()
  const insertWaypointRef = useRef<(index: number, latlng: L.LatLng) => void>()
  const createWaypointMarkerRef = useRef<(latlng: L.LatLng) => L.Marker>()

  const createWaypointMarker = useCallback((latlng: L.LatLng): L.Marker => {
    const state = stateRef.current
    const marker = L.marker(latlng, { draggable: true }).addTo(map)

    marker.on('dragend', () => {
      const idx = state.markers.indexOf(marker)
      if (idx >= 0) {
        state.waypoints[idx] = marker.getLatLng()
        updateRouteRef.current?.()
      }
    })

    marker.on('contextmenu', () => {
      const idx = state.markers.indexOf(marker)
      if (idx >= 0) {
        state.waypoints.splice(idx, 1)
        state.markers.splice(idx, 1)
        marker.remove()
        updateRouteRef.current?.()
      }
    })

    return marker
  }, [map])
  createWaypointMarkerRef.current = createWaypointMarker

  const clearMidpoints = useCallback(() => {
    const state = stateRef.current
    state.midpointMarkers.forEach((m) => m.remove())
    state.midpointMarkers = []
  }, [])

  const createMidpoints = useCallback(() => {
    const state = stateRef.current
    clearMidpoints()

    if (state.routeCoords.length === 0) return

    for (let i = 0; i < state.waypoints.length - 1; i++) {
      // Find the segment of routeCoords between waypoint i and i+1
      // by finding the closest route coord to each waypoint
      const startIdx = findClosestIndex(state.routeCoords, state.waypoints[i])
      const endIdx = findClosestIndex(state.routeCoords, state.waypoints[i + 1])

      const lo = Math.min(startIdx, endIdx)
      const hi = Math.max(startIdx, endIdx)

      // Find the midpoint along the actual route segment
      const segmentCoords = state.routeCoords.slice(lo, hi + 1)
      const midCoord = findMidpointAlongPath(segmentCoords)

      const insertIndex = i + 1
      const mid = L.marker(midCoord, {
        icon: midpointIcon,
        draggable: true,
        opacity: 0.6,
      }).addTo(map)

      mid.on('dragend', () => {
        const newLatLng = mid.getLatLng()
        insertWaypointRef.current?.(insertIndex, newLatLng)
      })

      state.midpointMarkers.push(mid)
    }
  }, [map, clearMidpoints])

  // Wire up the ref-based functions
  insertWaypointRef.current = (index: number, latlng: L.LatLng) => {
    const state = stateRef.current
    const marker = createWaypointMarker(latlng)
    state.waypoints.splice(index, 0, latlng)
    state.markers.splice(index, 0, marker)
    updateRouteRef.current?.()
  }

  updateRouteRef.current = async () => {
    const state = stateRef.current
    const result = await fetchRoute(state.waypoints)

    if (state.routeLine) {
      state.routeLine.remove()
      state.routeLine = null
    }

    if (result) {
      state.routeCoords = result.coords
      state.routeLine = L.polyline(result.coords, {
        color: '#2563eb',
        weight: 5,
        opacity: 0.8,
      }).addTo(map)

      onRouteUpdateRef.current?.({
        distance: result.distance,
        time: result.time,
        waypointCount: state.waypoints.length,
      })
    } else {
      state.routeCoords = []
      onRouteUpdateRef.current?.(state.waypoints.length > 0
        ? { distance: 0, time: 0, waypointCount: state.waypoints.length }
        : null
      )
    }

    createMidpoints()
  }

  const addWaypoint = useCallback((latlng: L.LatLng) => {
    const state = stateRef.current
    const marker = createWaypointMarker(latlng)
    state.waypoints.push(latlng)
    state.markers.push(marker)
    updateRouteRef.current?.()
  }, [createWaypointMarker])

  useEffect(() => {
    const onClick = (e: L.LeafletMouseEvent) => {
      addWaypoint(e.latlng)
    }
    map.on('click', onClick)

    return () => {
      map.off('click', onClick)
      clearAll()
    }
  }, [map, addWaypoint])

  return null
})

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

// Alle markører er divIcons stylet i App.css — ingen billeder fra CDN

const FLAG_SIZE: L.PointExpression = [30, 38]
// Ankeret ligger ved flagstangens fod, ikke i midten, så flaget peger på det præcise punkt
const FLAG_ANCHOR: L.PointExpression = [4, 38]
// Alt visuelt ligger i .flag-body — rod-elementet tilhører Leaflets positionering
const FLAG_HTML =
  '<span class="flag-body"><span class="flag-pole"></span><span class="flag-cloth"></span></span>'

const startIcon = L.divIcon({
  className: 'flag-marker flag-start',
  html: FLAG_HTML,
  iconSize: FLAG_SIZE,
  iconAnchor: FLAG_ANCHOR,
})

const endIcon = L.divIcon({
  className: 'flag-marker flag-end',
  html: FLAG_HTML,
  iconSize: FLAG_SIZE,
  iconAnchor: FLAG_ANCHOR,
})

const DOT_HTML = '<span class="marker-dot"></span>'

const waypointIcon = L.divIcon({
  className: 'waypoint-marker',
  html: DOT_HTML,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
})

const midpointIcon = L.divIcon({
  className: 'midpoint-marker',
  html: DOT_HTML,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})

// Coalesce bursts af redigeringer (fx flere hurtige højreklik) til ét BRouter-kald
const ROUTE_DEBOUNCE_MS = 150

import type { RoutingControlHandle, RouteInfo, RoutePoint } from '../types'

interface RoutingControlProps {
  onRouteUpdate?: (info: RouteInfo | null) => void
  onRouteError?: (message: string | null) => void
}

interface RouteState {
  waypoints: L.LatLng[]
  markers: L.Marker[]
  midpointMarkers: L.Marker[]
  routeLine: L.Polyline | null
  routeCoords: L.LatLng[]  // full routed coordinates from BRouter
  requestSeq: number       // stiger for hvert routing-kald; kun det nyeste må vinde
  abortController: AbortController | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  highlight: L.CircleMarker | null  // punktet højdeprofilen peger på
}

// c.alt er højden fra BRouter og kan mangle på ældre svar
function toRoutePoints(coords: L.LatLng[]): RoutePoint[] {
  return coords.map((c) => ({ lat: c.lat, lng: c.lng, ele: c.alt }))
}

async function fetchRoute(waypoints: L.LatLng[], signal: AbortSignal): Promise<{
  coords: L.LatLng[]
  distance: number
}> {
  const wps = waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng }))
  const res = await fetch('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waypoints: wps }),
    signal,
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      if (typeof body?.error === 'string') detail = body.error.trim().slice(0, 200)
    } catch {
      // ikke-JSON fejlsvar — brug bare statuskoden
    }
    throw new Error(detail || `Routing fejlede (HTTP ${res.status})`)
  }

  const geojson = await res.json()
  const feature = geojson.features?.[0]
  if (!feature) throw new Error('BRouter fandt ingen rute mellem punkterne')

  // c[2] er højden i meter — bevares som L.LatLng.alt, så GPX-eksporten kan bruge den
  const coords = feature.geometry.coordinates.map(
    (c: number[]) => L.latLng(c[1], c[0], c[2]),
  )
  // Kun distancen bruges — tiden regnes ud fra brugerens hastighed i Sidebar
  const props = feature.properties || {}
  return {
    coords,
    distance: parseFloat(props['track-length'] || '0'),
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

export default forwardRef<RoutingControlHandle, RoutingControlProps>(function RoutingControl({ onRouteUpdate, onRouteError }, ref) {
  const map = useMap()
  const stateRef = useRef<RouteState>({
    waypoints: [],
    markers: [],
    midpointMarkers: [],
    routeLine: null,
    routeCoords: [],
    requestSeq: 0,
    abortController: null,
    debounceTimer: null,
    highlight: null,
  })
  const onRouteUpdateRef = useRef(onRouteUpdate)
  onRouteUpdateRef.current = onRouteUpdate
  const onRouteErrorRef = useRef(onRouteError)
  onRouteErrorRef.current = onRouteError

  const cancelPending = useCallback(() => {
    const state = stateRef.current
    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer)
      state.debounceTimer = null
    }
    state.abortController?.abort()
    state.abortController = null
    // Invalidér svar fra kald der allerede er undervejs
    state.requestSeq++
  }, [])

  // Punktet højdeprofilen peger på. Ligger uden for markør-systemet med vilje:
  // det er ikke et waypoint, kan ikke trækkes, og må ikke kunne klikkes væk.
  const highlightPoint = useCallback((point: { lat: number; lng: number } | null) => {
    const state = stateRef.current
    if (!point) {
      state.highlight?.remove()
      state.highlight = null
      return
    }
    const latlng = L.latLng(point.lat, point.lng)
    if (state.highlight) {
      state.highlight.setLatLng(latlng)
      return
    }
    state.highlight = L.circleMarker(latlng, {
      radius: 7,
      color: '#ffffff',
      weight: 3,
      fillColor: '#f97316',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map)
  }, [map])

  const clearAll = useCallback(() => {
    const state = stateRef.current
    cancelPending()
    state.markers.forEach((m) => m.remove())
    state.midpointMarkers.forEach((m) => m.remove())
    state.routeLine?.remove()
    state.highlight?.remove()
    state.waypoints = []
    state.markers = []
    state.midpointMarkers = []
    state.routeLine = null
    state.routeCoords = []
    state.highlight = null
  }, [cancelPending])

  useImperativeHandle(ref, () => ({
    clearRoute() {
      clearAll()
      onRouteUpdateRef.current?.(null)
      onRouteErrorRef.current?.(null)
    },
    getWaypoints() {
      return stateRef.current.waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng }))
    },
    getRouteCoords() {
      return toRoutePoints(stateRef.current.routeCoords)
    },
    highlightPoint,
    loadWaypoints(waypoints: { lat: number; lng: number }[]) {
      clearAll()
      const state = stateRef.current
      waypoints.forEach((wp) => {
        const latlng = L.latLng(wp.lat, wp.lng)
        const marker = createWaypointMarkerRef.current!(latlng)
        state.waypoints.push(latlng)
        state.markers.push(marker)
      })
      // Zoom til ruten — ellers bliver kortet stående hvor det var
      if (state.waypoints.length > 0) {
        map.fitBounds(L.latLngBounds(state.waypoints), { padding: [40, 40] })
      }
      onRouteErrorRef.current?.(null)
      scheduleRouteUpdateRef.current?.()
    },
  }))

  // We need stable references to functions that reference each other
  const scheduleRouteUpdateRef = useRef<(() => void) | undefined>(undefined)
  const insertWaypointRef = useRef<((index: number, latlng: L.LatLng) => void) | undefined>(undefined)
  const createWaypointMarkerRef = useRef<((latlng: L.LatLng) => L.Marker) | undefined>(undefined)

  const createWaypointMarker = useCallback((latlng: L.LatLng): L.Marker => {
    const state = stateRef.current
    // Rollen (start/slut/mellempunkt) sættes af applyMarkerRoles lige efter
    const marker = L.marker(latlng, { draggable: true, icon: waypointIcon }).addTo(map)

    marker.on('dragend', () => {
      const idx = state.markers.indexOf(marker)
      if (idx >= 0) {
        state.waypoints[idx] = marker.getLatLng()
        scheduleRouteUpdateRef.current?.()
      }
    })

    marker.on('contextmenu', () => {
      const idx = state.markers.indexOf(marker)
      if (idx >= 0) {
        state.waypoints.splice(idx, 1)
        state.markers.splice(idx, 1)
        marker.remove()
        scheduleRouteUpdateRef.current?.()
      }
    })

    return marker
  }, [map])
  createWaypointMarkerRef.current = createWaypointMarker

  // Start/slut er ikke en egenskab ved markøren, men ved dens plads i listen —
  // derfor gentildeles rollerne efter hver ændring af waypoints
  const applyMarkerRoles = useCallback(() => {
    const state = stateRef.current
    const last = state.markers.length - 1
    state.markers.forEach((marker, i) => {
      const isEndpoint = i === 0 || i === last
      // i === 0 vinder, så et enkelt waypoint bliver start — ikke slut
      marker.setIcon(i === 0 ? startIcon : i === last ? endIcon : waypointIcon)
      marker.setZIndexOffset(isEndpoint ? 1000 : 0)
    })
  }, [])

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
      }).addTo(map)

      // Både klik og træk skal indsætte et waypoint her. Leaflet starter først et drag
      // efter 3 px bevægelse, så et kort, præcist klik giver aldrig 'dragend'.
      // Kun den første af de to events vinder; markøren bygges om ved næste
      // createMidpoints(), så flaget lever kun så længe denne markør gør.
      let consumed = false
      const insertHere = () => {
        if (consumed) return
        consumed = true
        insertWaypointRef.current?.(insertIndex, mid.getLatLng())
      }

      mid.on('dragend', insertHere)
      mid.on('click', insertHere)

      state.midpointMarkers.push(mid)
    }
  }, [map, clearMidpoints])

  // Wire up the ref-based functions
  insertWaypointRef.current = (index: number, latlng: L.LatLng) => {
    const state = stateRef.current
    const marker = createWaypointMarker(latlng)
    state.waypoints.splice(index, 0, latlng)
    state.markers.splice(index, 0, marker)
    scheduleRouteUpdateRef.current?.()
  }

  const dropRouteLine = useCallback(() => {
    const state = stateRef.current
    state.routeLine?.remove()
    state.routeLine = null
    state.routeCoords = []
    // Markøren pegede på en rute der ikke findes længere
    state.highlight?.remove()
    state.highlight = null
    clearMidpoints()
  }, [clearMidpoints])

  const runRouteUpdate = useCallback(async () => {
    const state = stateRef.current

    // Nyt kald gør alle tidligere svar forældede
    state.abortController?.abort()
    const seq = ++state.requestSeq

    if (state.waypoints.length < 2) {
      state.abortController = null
      dropRouteLine()
      onRouteErrorRef.current?.(null)
      onRouteUpdateRef.current?.(state.waypoints.length > 0
        ? { distance: 0, waypointCount: state.waypoints.length, points: [] }
        : null
      )
      return
    }

    const controller = new AbortController()
    state.abortController = controller

    try {
      const result = await fetchRoute(state.waypoints, controller.signal)
      if (seq !== state.requestSeq) return  // et nyere kald har overhalet dette

      state.routeLine?.remove()
      state.routeCoords = result.coords
      state.routeLine = L.polyline(result.coords, {
        color: '#2563eb',
        weight: 5,
        opacity: 0.8,
      }).addTo(map)

      onRouteErrorRef.current?.(null)
      onRouteUpdateRef.current?.({
        distance: result.distance,
        waypointCount: state.waypoints.length,
        points: toRoutePoints(result.coords),
      })
      createMidpoints()
    } catch (err) {
      if (seq !== state.requestSeq) return  // afbrudt eller forældet — ignorér

      dropRouteLine()
      onRouteErrorRef.current?.(err instanceof Error ? err.message : 'Kunne ikke beregne rute')
      onRouteUpdateRef.current?.({
        distance: 0,
        waypointCount: state.waypoints.length,
        points: [],
      })
    }
  }, [map, createMidpoints, dropRouteLine])

  scheduleRouteUpdateRef.current = () => {
    const state = stateRef.current
    // Synkront, ikke inde i det debouncede kald — ellers halter ikonet efter klikket
    applyMarkerRoles()
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null
      void runRouteUpdate()
    }, ROUTE_DEBOUNCE_MS)
  }

  const addWaypoint = useCallback((latlng: L.LatLng) => {
    const state = stateRef.current
    const marker = createWaypointMarker(latlng)
    state.waypoints.push(latlng)
    state.markers.push(marker)
    scheduleRouteUpdateRef.current?.()
  }, [createWaypointMarker])

  useEffect(() => {
    const onClick = (e: L.LeafletMouseEvent) => {
      // Leaflet sætter .leaflet-marker-icon på alle markører (flag, waypoint, midpoint).
      // Et klik på en af dem må aldrig lande som et nyt waypoint sidst i ruten — så ville
      // det blive det nye mål. Markørerne har deres egne handlere.
      const target = e.originalEvent?.target as Element | null
      if (target?.closest?.('.leaflet-marker-icon')) return
      addWaypoint(e.latlng)
    }
    map.on('click', onClick)

    return () => {
      map.off('click', onClick)
      clearAll()
    }
  }, [map, addWaypoint, clearAll])

  return null
})

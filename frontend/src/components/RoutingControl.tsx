import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { apiFetch } from '../api'

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

const DOT_SIZE = { waypoint: 16, midpoint: 14 } as const

// Pilen viser rutens retning, så man kan skelne ud- og hjemtur på samme vej.
// Den peger opad i SVG'en og drejes på selve pilen — aldrig på rod-elementet.
// Ingen retning (ingen rute endnu) = ingen pil.
function dotIcon(kind: keyof typeof DOT_SIZE, heading?: number): L.DivIcon {
  const size = DOT_SIZE[kind]
  const arrow = heading === undefined
    ? ''
    : `<svg class="marker-arrow" viewBox="0 0 10 10" style="transform: rotate(${Math.round(heading)}deg)">`
      + '<path d="M5 1 L9 9 L5 7 L1 9 Z"/></svg>'
  return L.divIcon({
    className: `${kind}-marker`,
    html: `<span class="marker-dot">${arrow}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// Coalesce bursts af redigeringer (fx flere hurtige højreklik) til ét BRouter-kald
const ROUTE_DEBOUNCE_MS = 150

// Retningen måles mellem to punkter så langt fra hinanden langs ruten — kort nok til at
// følge et sving, langt nok til at BRouters tætte punkter i et kryds ikke giver støj
const HEADING_SAMPLE_M = 15

// Ud- og hjemtur på samme vej ligger begge ~0 m fra et waypoint. Uden tolerance afgør
// afrundingsstøj hvilken af dem waypointet matcher; med den vinder den første
const WAYPOINT_MATCH_TOLERANCE_M = 5

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
  // Rutens retning ud fra hvert waypoint. Pr. markør, ikke pr. indeks, så pilen følger
  // med når et waypoint indsættes eller slettes og listen forskydes
  headings: WeakMap<L.Marker, number>
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
  const res = await apiFetch('/api/route', {
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

// Hvert waypoints plads i rutegeometrien. Der søges *fremad* fra forrige waypoints plads,
// ikke i hele ruten: på en ud-og-hjem-rute kan et waypoint på udturen ellers matche
// hjemturen på samme vej, så segmentet vendes om og midpointet havner på forkert ben.
function findWaypointIndices(coords: L.LatLng[], waypoints: L.LatLng[]): number[] {
  const indices: number[] = []
  let from = 0
  for (const wp of waypoints) {
    const dists = coords.slice(from).map((c) => c.distanceTo(wp))
    // reduce, ikke Math.min(...dists) — spread af titusindvis af punkter kan sprænge stakken
    const min = dists.reduce((a, b) => Math.min(a, b), Infinity)
    const offset = dists.findIndex((d) => d <= min + WAYPOINT_MATCH_TOLERANCE_M)
    from += Math.max(offset, 0)
    indices.push(from)
  }
  return indices
}

function pathLength(coords: L.LatLng[]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) total += coords[i - 1].distanceTo(coords[i])
  return total
}

// Punktet `dist` meter inde ad stien, klampet til stiens ender
function pointAlongPath(coords: L.LatLng[], dist: number): L.LatLng {
  if (coords.length === 0) return L.latLng(0, 0)
  if (dist <= 0) return coords[0]
  let accumulated = 0
  for (let i = 1; i < coords.length; i++) {
    const segDist = coords[i - 1].distanceTo(coords[i])
    if (segDist > 0 && accumulated + segDist >= dist) {
      const frac = (dist - accumulated) / segDist
      return L.latLng(
        coords[i - 1].lat + frac * (coords[i].lat - coords[i - 1].lat),
        coords[i - 1].lng + frac * (coords[i].lng - coords[i - 1].lng),
      )
    }
    accumulated += segDist
  }
  return coords[coords.length - 1]
}

// Retning fra a til b i grader med uret fra opad på skærmen. Web Mercator er vinkeltro,
// så vinklen er den samme på alle zoomniveauer — derfor fast zoom 0 og ikke kortets.
// undefined hvis punkterne falder sammen; så findes der ingen retning at vise.
function screenHeading(a: L.LatLng, b: L.LatLng): number | undefined {
  const pa = L.CRS.EPSG3857.latLngToPoint(a, 0)
  const pb = L.CRS.EPSG3857.latLngToPoint(b, 0)
  if (pa.equals(pb)) return undefined
  return (Math.atan2(pb.x - pa.x, -(pb.y - pa.y)) * 180) / Math.PI
}

// Rutens retning fra `from` til `to` meter inde ad stien
function headingAlongPath(coords: L.LatLng[], from: number, to: number): number | undefined {
  return screenHeading(pointAlongPath(coords, from), pointAlongPath(coords, to))
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
    headings: new WeakMap(),
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
    state.headings = new WeakMap()
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
    const marker = L.marker(latlng, { draggable: true, icon: dotIcon('waypoint') }).addTo(map)

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
      // i === 0 vinder, så et enkelt waypoint bliver start — ikke slut.
      // Retningen er fra sidste rute og kan være forældet indtil den nye kommer; den
      // opdateres når runRouteUpdate kalder os igen
      marker.setIcon(i === 0 ? startIcon : i === last ? endIcon
        : dotIcon('waypoint', state.headings.get(marker)))
      marker.setZIndexOffset(isEndpoint ? 1000 : 0)
    })
  }, [])

  const clearMidpoints = useCallback(() => {
    const state = stateRef.current
    state.midpointMarkers.forEach((m) => m.remove())
    state.midpointMarkers = []
  }, [])

  // Midpoints og waypoint-pile bygges ud fra samme opdeling af ruten i segmenter
  const createMidpoints = useCallback(() => {
    const state = stateRef.current
    clearMidpoints()

    if (state.routeCoords.length === 0) return

    const indices = findWaypointIndices(state.routeCoords, state.waypoints)
    const headings = new WeakMap<L.Marker, number>()

    for (let i = 0; i < state.waypoints.length - 1; i++) {
      // findWaypointIndices søger fremad, så indices[i] <= indices[i + 1] altid —
      // segmentet har rutens rigtige retning
      const segmentCoords = state.routeCoords.slice(indices[i], indices[i + 1] + 1)
      const length = pathLength(segmentCoords)

      // Retningen ud fra waypoint i. Ved et vendepunkt er det vejen tilbage
      const outgoing = headingAlongPath(segmentCoords, 0, 2 * HEADING_SAMPLE_M)
      if (outgoing !== undefined) headings.set(state.markers[i], outgoing)

      const midCoord = pointAlongPath(segmentCoords, length / 2)
      const midHeading = headingAlongPath(
        segmentCoords, length / 2 - HEADING_SAMPLE_M, length / 2 + HEADING_SAMPLE_M,
      )

      const insertIndex = i + 1
      const mid = L.marker(midCoord, {
        icon: dotIcon('midpoint', midHeading),
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

    state.headings = headings
    applyMarkerRoles()
  }, [map, clearMidpoints, applyMarkerRoles])

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
    // Ingen rute, ingen retning — en gammel pil ville pege efter en rute der ikke findes
    state.headings = new WeakMap()
    applyMarkerRoles()
  }, [clearMidpoints, applyMarkerRoles])

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

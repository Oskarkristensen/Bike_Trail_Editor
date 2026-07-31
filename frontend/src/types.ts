// Et punkt på den beregnede rute. ele er højden i meter fra BRouter — kan mangle.
export interface RoutePoint {
  lat: number
  lng: number
  ele?: number
}

export interface RoutingControlHandle {
  clearRoute: () => void
  getWaypoints: () => { lat: number; lng: number }[]
  loadWaypoints: (waypoints: { lat: number; lng: number }[]) => void
  /** Hele rutegeometrien fra BRouter — ikke kun de klikkede waypoints */
  getRouteCoords: () => RoutePoint[]
  /** Viser hvor på kortet højdeprofilen peger hen; null fjerner markøren igen */
  highlightPoint: (point: { lat: number; lng: number } | null) => void
}

export interface RouteInfo {
  distance: number
  waypointCount: number
  /** Rutegeometrien med højder — grundlaget for højdeprofilen. Tom uden rute. */
  points: RoutePoint[]
}

export interface SavedRoute {
  id: number
  name: string
  waypoints: { lat: number; lng: number }[]
  created_at: string
}

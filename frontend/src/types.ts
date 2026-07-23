export interface RoutingControlHandle {
  clearRoute: () => void
  getWaypoints: () => { lat: number; lng: number }[]
  loadWaypoints: (waypoints: { lat: number; lng: number }[]) => void
}

export interface RouteInfo {
  distance: number
  time: number
  waypointCount: number
}

export interface SavedRoute {
  id: number
  name: string
  waypoints: { lat: number; lng: number }[]
  created_at: string
}

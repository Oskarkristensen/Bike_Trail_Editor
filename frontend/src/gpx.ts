import type { RoutePoint } from './types'

const MAX_WAYPOINTS = 20

// --- Import ---

export function parseGPX(xml: string): { lat: number; lng: number }[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  // Try <trkpt>, then <rtept>, then <wpt>
  let points = doc.querySelectorAll('trkpt')
  if (points.length === 0) points = doc.querySelectorAll('rtept')
  if (points.length === 0) points = doc.querySelectorAll('wpt')

  const coords: { lat: number; lng: number }[] = []
  points.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute('lat') || '')
    const lng = parseFloat(pt.getAttribute('lon') || '')
    if (!isNaN(lat) && !isNaN(lng)) coords.push({ lat, lng })
  })
  return coords
}

export function sampleWaypoints(coords: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  if (coords.length <= MAX_WAYPOINTS) return coords
  const result: { lat: number; lng: number }[] = [coords[0]]
  const step = (coords.length - 1) / (MAX_WAYPOINTS - 1)
  for (let i = 1; i < MAX_WAYPOINTS - 1; i++) {
    result.push(coords[Math.round(i * step)])
  }
  result.push(coords[coords.length - 1])
  return result
}

// --- Eksport ---

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Bygger en GPX 1.1-fil til cykelcomputer-apps (Garmin Connect, iGPSPORT, Strava).
 *
 * Bevidste valg:
 * - <trk>, ikke <rte>: alle tre platforme importerer tracks, og har filen begge dele,
 *   opfatter nogle af dem det som to separate ruter.
 * - Ingen <time> på trackpoints: en GPX med tidsstempler ser ud som en gennemført tur,
 *   og Strava tilbyder da at uploade den som aktivitet i stedet for som rute.
 *   <metadata><time> er filens oprettelsestidspunkt og har ikke den effekt.
 * - Fuldt namespace + schemaLocation: nogle enheder afviser filer uden.
 */
export function buildGPX({ name, points }: { name: string; points: RoutePoint[] }): string {
  const safeName = escapeXml(name)

  const trkpts = points.map((p) => {
    const lat = p.lat.toFixed(7)
    const lon = p.lng.toFixed(7)
    const ele = Number.isFinite(p.ele) ? `<ele>${(p.ele as number).toFixed(1)}</ele>` : ''
    return `      <trkpt lat="${lat}" lon="${lon}">${ele}</trkpt>`
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Trail Editor"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${safeName}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${safeName}</name>
    <trkseg>
${trkpts.join('\n')}
    </trkseg>
  </trk>
</gpx>
`
}

export function gpxFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    // Behold danske bogstaver — de er gyldige i filnavne på alle tre platforme
    .replace(/[^a-z0-9æøå-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${slug || 'cykelrute'}.gpx`
}

export function downloadFile(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

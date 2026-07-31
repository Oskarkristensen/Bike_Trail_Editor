import type { RoutePoint } from './types'

/**
 * Højdeændringer mindre end denne tærskel tælles ikke med i stigning/fald.
 *
 * BRouters højder kommer fra SRTM-gittermodellen og støjer typisk et par meter
 * fra punkt til punkt. Summerer man hver eneste positive forskel, samler man
 * støjen op: en flad rute rundt om Brabrand Sø ender med hundredvis af
 * "højdemeter". Tærsklen måles fra sidste bekræftede punkt (hysterese), ikke
 * fra naboen, så en lang jævn stigning stadig tælles fuldt ud.
 */
const ELEVATION_THRESHOLD_M = 3

/** Maks. antal punkter grafen tegnes med — se downsample(). */
const MAX_CHART_POINTS = 600

const EARTH_RADIUS_M = 6371008.8

/** Ét punkt i profilen: hvor langt inde på ruten, og hvor højt. */
export interface ElevationSample {
  /** Meter fra rutens start, målt langs ruten */
  distance: number
  /** Meter over havet */
  ele: number
  lat: number
  lng: number
}

export interface ElevationProfile {
  /** Nedsamplet til visning — stigning/fald er regnet på det fulde datasæt */
  samples: ElevationSample[]
  /** Samlet stigning i meter (støjfiltreret) */
  ascent: number
  /** Samlet fald i meter, positivt tal */
  descent: number
  minEle: number
  maxEle: number
  /** Rutens fulde længde i meter, også hvis enkelte punkter mangler højde */
  totalDistance: number
}

function distanceBetween(a: RoutePoint, b: RoutePoint): number {
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const dLat = lat2 - lat1
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Nedsampler til visning uden at klippe toppene af.
 *
 * Et almindeligt "tag hvert n'te punkt" rammer sjældent bakketoppen, så en
 * lang rute ser fladere ud end den er. I stedet deles punkterne i lige store
 * spande, og fra hver spand beholdes både det laveste og det højeste punkt i
 * deres oprindelige rækkefølge. Afstanden er derfor stadig voksende.
 */
function downsample(samples: ElevationSample[], maxPoints: number): ElevationSample[] {
  if (samples.length <= maxPoints) return samples

  const buckets = Math.floor(maxPoints / 2)
  const bucketSize = samples.length / buckets
  const out: ElevationSample[] = []

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * bucketSize)
    const end = Math.min(samples.length, Math.floor((b + 1) * bucketSize))
    let lowest = start
    let highest = start
    for (let i = start + 1; i < end; i++) {
      if (samples[i].ele < samples[lowest].ele) lowest = i
      if (samples[i].ele > samples[highest].ele) highest = i
    }
    const first = Math.min(lowest, highest)
    const second = Math.max(lowest, highest)
    out.push(samples[first])
    if (second !== first) out.push(samples[second])
  }

  // Start- og slutpunkt skal altid være med, ellers stopper grafen for tidligt
  if (out[0] !== samples[0]) out.unshift(samples[0])
  const last = samples[samples.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Bygger højdeprofilen ud fra BRouters rutegeometri.
 *
 * Returnerer null hvis ruten ikke har mindst to punkter med højde — så vises
 * profilen slet ikke i stedet for en tom graf.
 */
export function buildElevationProfile(points: RoutePoint[]): ElevationProfile | null {
  if (points.length < 2) return null

  // Afstanden akkumuleres over *alle* punkter, også dem uden højde, så
  // x-aksen passer med den rute der faktisk køres
  const samples: ElevationSample[] = []
  let distance = 0
  for (let i = 0; i < points.length; i++) {
    if (i > 0) distance += distanceBetween(points[i - 1], points[i])
    const { lat, lng, ele } = points[i]
    if (typeof ele === 'number' && Number.isFinite(ele)) {
      samples.push({ distance, ele, lat, lng })
    }
  }
  if (samples.length < 2) return null

  let ascent = 0
  let descent = 0
  let minEle = samples[0].ele
  let maxEle = samples[0].ele
  // Referencehøjden flytter sig først når ændringen er stor nok til at være reel
  let reference = samples[0].ele
  for (const sample of samples) {
    if (sample.ele < minEle) minEle = sample.ele
    if (sample.ele > maxEle) maxEle = sample.ele
    const delta = sample.ele - reference
    if (delta >= ELEVATION_THRESHOLD_M) {
      ascent += delta
      reference = sample.ele
    } else if (delta <= -ELEVATION_THRESHOLD_M) {
      descent -= delta
      reference = sample.ele
    }
  }

  return {
    samples: downsample(samples, MAX_CHART_POINTS),
    ascent,
    descent,
    minEle,
    maxEle,
    totalDistance: distance,
  }
}

/** Nærmeste punkt på en given afstand — profilens samples er sorteret efter distance */
export function sampleAtDistance(
  samples: ElevationSample[],
  distance: number,
): ElevationSample {
  let lo = 0
  let hi = samples.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].distance < distance) lo = mid + 1
    else hi = mid
  }
  const after = samples[lo]
  const before = samples[Math.max(0, lo - 1)]
  return distance - before.distance <= after.distance - distance ? before : after
}

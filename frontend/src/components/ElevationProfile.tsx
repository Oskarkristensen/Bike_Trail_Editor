import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleAtDistance } from '../elevation'
import type { ElevationProfile, ElevationSample } from '../elevation'

const CHART_HEIGHT = 150
const PAD = { top: 12, right: 12, bottom: 22, left: 46 }
/** Flad rute: tving mindst så mange meter ind på y-aksen, ellers ligner
 *  10 cm støj en bjergetape */
const MIN_ELEVATION_RANGE_M = 20

interface ElevationProfileProps {
  profile: ElevationProfile
  /** Kaldes med punktet musen peger på — Map viser det på kortet */
  onHoverPoint: (point: { lat: number; lng: number } | null) => void
  onClose: () => void
}

/** Pænt akseinterval (1, 2, 5, 10, 20, 50 ...) tæt på range/count */
function niceStep(range: number, count: number): number {
  const raw = range / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function formatKm(meters: number): string {
  const km = meters / 1000
  return `${km.toFixed(km < 10 ? 1 : 0).replace('.', ',')} km`
}

export default function ElevationProfileChart({ profile, onHoverPoint, onClose }: ElevationProfileProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<ElevationSample | null>(null)

  // Bredden måles, ikke skaleres: et viewBox der strækkes ville gøre
  // stregtykkelse og tekst forskellig i de to retninger
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const clearHover = useCallback(() => {
    setHover(null)
    onHoverPoint(null)
  }, [onHoverPoint])

  // Ruten kan skifte under musen (fx når et waypoint trækkes) — så er det
  // gamle hover-punkt ikke længere en del af profilen. Oprydningen dækker
  // også at panelet lukkes mens musen står inde i grafen, hvor svg'ets
  // pointerleave aldrig når at blive kaldt.
  useEffect(() => {
    setHover(null)
    onHoverPoint(null)
    return () => onHoverPoint(null)
  }, [profile, onHoverPoint])

  const { samples, totalDistance, minEle, maxEle, ascent, descent } = profile

  const innerWidth = Math.max(0, width - PAD.left - PAD.right)
  const innerHeight = CHART_HEIGHT - PAD.top - PAD.bottom

  // y-aksen: udvid til et minimumsinterval og rund ud til pæne gridlinjer
  let low = minEle
  let high = maxEle
  if (high - low < MIN_ELEVATION_RANGE_M) {
    const mid = (high + low) / 2
    low = mid - MIN_ELEVATION_RANGE_M / 2
    high = mid + MIN_ELEVATION_RANGE_M / 2
  }
  const eleStep = niceStep(high - low, 3)
  low = Math.floor(low / eleStep) * eleStep
  high = Math.ceil(high / eleStep) * eleStep

  const xAt = (distance: number) =>
    PAD.left + (totalDistance > 0 ? (distance / totalDistance) * innerWidth : 0)
  const yAt = (ele: number) =>
    PAD.top + (1 - (ele - low) / (high - low)) * innerHeight
  const baseline = PAD.top + innerHeight

  const line = samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${xAt(s.distance).toFixed(1)} ${yAt(s.ele).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${xAt(samples[samples.length - 1].distance).toFixed(1)} ${baseline} L${xAt(samples[0].distance).toFixed(1)} ${baseline} Z`

  const eleTicks: number[] = []
  for (let e = low; e <= high + 0.001; e += eleStep) eleTicks.push(e)

  const distStep = niceStep(Math.max(totalDistance, 1), 5)
  const distTicks: number[] = []
  for (let d = 0; d <= totalDistance + 0.001; d += distStep) distTicks.push(d)

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (innerWidth <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left - PAD.left) / innerWidth
    const clamped = Math.min(1, Math.max(0, ratio))
    const sample = sampleAtDistance(samples, clamped * totalDistance)
    setHover(sample)
    onHoverPoint({ lat: sample.lat, lng: sample.lng })
  }

  const summary = `Højdeprofil: ${Math.round(ascent)} meter stigning, ${Math.round(descent)} meter fald, laveste punkt ${Math.round(minEle)} meter, højeste punkt ${Math.round(maxEle)} meter.`

  return (
    <div className="elevation-panel">
      <div className="elevation-header">
        <h2>Højdeprofil</h2>
        <span className="elevation-summary">
          <span className="elevation-ascent">&uarr; {Math.round(ascent)} m</span>
          <span className="elevation-descent">&darr; {Math.round(descent)} m</span>
          <span className="elevation-range">
            {Math.round(minEle)}&ndash;{Math.round(maxEle)} m
          </span>
        </span>
        <button className="elevation-close" onClick={onClose} title="Skjul højdeprofil">
          &times;
        </button>
      </div>

      <div className="elevation-chart" ref={wrapperRef}>
        {width > 0 && (
          <svg
            width={width}
            height={CHART_HEIGHT}
            role="img"
            aria-label={summary}
            onPointerMove={handlePointerMove}
            onPointerLeave={clearHover}
          >
            <defs>
              <linearGradient id="elevation-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563eb" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#2563eb" stopOpacity="0.04" />
              </linearGradient>
            </defs>

            {eleTicks.map((ele) => (
              <g key={ele}>
                <line
                  className="elevation-grid"
                  x1={PAD.left}
                  x2={PAD.left + innerWidth}
                  y1={yAt(ele)}
                  y2={yAt(ele)}
                />
                <text className="elevation-tick" x={PAD.left - 8} y={yAt(ele)} textAnchor="end" dominantBaseline="middle">
                  {Math.round(ele)}
                </text>
              </g>
            ))}

            {distTicks.map((d) => (
              <text
                key={d}
                className="elevation-tick"
                x={xAt(d)}
                y={CHART_HEIGHT - 6}
                textAnchor={d === 0 ? 'start' : 'middle'}
              >
                {formatKm(d)}
              </text>
            ))}

            <path d={area} fill="url(#elevation-fill)" />
            <path className="elevation-line" d={line} />

            {hover && (
              <g>
                <line
                  className="elevation-cursor"
                  x1={xAt(hover.distance)}
                  x2={xAt(hover.distance)}
                  y1={PAD.top}
                  y2={baseline}
                />
                <circle className="elevation-cursor-dot" cx={xAt(hover.distance)} cy={yAt(hover.ele)} r={4.5} />
              </g>
            )}
          </svg>
        )}

        {hover && (
          <div
            className="elevation-tooltip"
            style={{
              // Klampes, så boblen ikke hænger ud over panelets kanter
              left: Math.min(Math.max(xAt(hover.distance), 52), Math.max(width - 52, 52)),
            }}
          >
            <strong>{Math.round(hover.ele)} m</strong>
            <span>{formatKm(hover.distance)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

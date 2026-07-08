import mapboxgl from 'mapbox-gl'
// Vite bundles `mapbox-gl` for the main thread; its default blob-based `workerUrl` is often never set. `?worker` produces a
// same-origin Worker constructor that Mapbox picks up via `workerClass` (fixes blank maps / stalled style/tile loads).
import MapboxCspWorker from 'mapbox-gl/dist/mapbox-gl-csp-worker.js?worker'
import { useLayoutEffect, useRef, useState } from 'react'

import {
  applyMapboxStreetLabels,
  MAPBOX_STYLE,
  mapboxBasemapInitConfig,
} from '../lib/mapboxBasemap'
import { NEXUS_CATEGORIES } from '../lib/nexusCategories'
import {
  installNexusHistoricalGraph,
  NEXUS_LINK_HIT_LAYERS,
  type NexusGraph,
  type NexusHistoricalGraphController,
} from '../lib/nexusHistoricalGraph'

mapboxgl.workerClass = MapboxCspWorker as unknown as typeof mapboxgl.workerClass

const LOG = (...args: unknown[]) => console.log('[NexusMap]', ...args)

let loggedTelemetryBlockerHint = false

function errorLikelyWorkerOrCorsIssue(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('worker') || m.includes('cannot be accessed from origin') || m.includes('cross-origin')
  )
}

function errorLikelyAccessTokenIssue(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('token') ||
    m.includes('unauthorized') ||
    m.includes('forbidden')
  )
}

const GAMLA_STAN_CENTER: mapboxgl.LngLatLike = [18.071, 59.325]
const DEFAULT_ZOOM = 15.2

export type FocusRequest = {
  nodeId: string
  /** Monotonic token so re-clicking the same node re-opens its popup. */
  token: number
}

export type NexusMapProps = {
  mapGraph: NexusGraph
  /** Map-marked peer to pulse when the focused graph entity has no coords (e.g. a person → linked place). */
  highlightTargetId: string | null
  /** Ease to this node and open its popup (kept pending across map rebuilds, e.g. after a year jump). */
  focusRequest?: FocusRequest | null
  onMarkerHover?: (nodeId: string | null) => void
}

const mapFingerprint = (g: NexusGraph) =>
  JSON.stringify({
    nodes: g.nodes.map((n) => [n.id, n.lat, n.lng, n.type, n.category]),
    links: g.links.map((l) => [l.source, l.target, l.label]),
  })

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function NexusMap({
  mapGraph,
  highlightTargetId,
  focusRequest,
  onMarkerHover,
}: NexusMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const popupRef = useRef<mapboxgl.Popup | null>(null)
  const errorReportedRef = useRef(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const highlightTargetRef = useRef<string | null>(null)
  const onMarkerHoverRef = useRef(onMarkerHover)
  const graphControllerRef = useRef<NexusHistoricalGraphController | null>(null)
  /** Focus not yet satisfied (its node may only exist after the next graph rebuild). */
  const pendingFocusRef = useRef<FocusRequest | null>(null)

  const token = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '').trim()
  const graphKey = mapFingerprint(mapGraph)

  useLayoutEffect(() => {
    highlightTargetRef.current = highlightTargetId
    onMarkerHoverRef.current = onMarkerHover
  }, [highlightTargetId, onMarkerHover])

  useLayoutEffect(() => {
    if (!focusRequest) return
    pendingFocusRef.current = focusRequest
    // Try immediately; if the node isn't on the map yet (year jump in flight),
    // the request stays pending and is retried after the graph reinstalls.
    if (graphControllerRef.current?.openPopup(focusRequest.nodeId)) {
      pendingFocusRef.current = null
    }
  }, [focusRequest])

  useLayoutEffect(() => {
    const el = containerRef.current
    const tokenPreview =
      token.length === 0
        ? 'empty'
        : token.startsWith('pk.')
          ? `pk.*** (${token.length} chars)`
          : `unexpected prefix, ${token.length} chars`
    LOG('effect run', {
      hasToken: Boolean(token),
      tokenPreview,
      hasContainerEl: Boolean(el),
      usesBundledWorker: Boolean(mapboxgl.workerClass),
    })

    if (!token) {
      LOG('abort: missing VITE_MAPBOX_ACCESS_TOKEN')
      return
    }
    if (!el) {
      LOG('abort: container ref is null — map DOM not mounted when effect ran')
      return
    }

    const r = el.getBoundingClientRect()
    LOG('map container geometry', {
      width: r.width,
      height: r.height,
      pixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : undefined,
    })
    if (r.width === 0 || r.height === 0) {
      console.warn(
        '[NexusMap] container has zero width or height — Mapbox usually needs non-zero dimensions to render.'
      )
    }

    errorReportedRef.current = false
    setMapError(null)
    mapboxgl.accessToken = token

    let disposed = false
    let mapRo: ResizeObserver | undefined
    let sidebarRo: ResizeObserver | undefined
    let sizeRo: ResizeObserver | undefined
    let windowResizeRaf: number | null = null
    let map: mapboxgl.Map | undefined
    let teardownHistorical: (() => void) | undefined

    const resizeIfLive = () => {
      if (disposed || !map) return
      try {
        map.resize()
      } catch {
        /* map already torn down */
      }
    }

    const sidebarInsetPx = (): number => {
      const panel = document.getElementById('nexus-control-panel')
      const raw = panel?.getBoundingClientRect().width ?? 0
      const vw =
        typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY
      // Never reserve more than ~half the viewport — mis-sized panel wrappers once produced left≈vw and hid the canvas.
      const cap = Number.isFinite(vw) ? Math.min(20 * 16, Math.max(0, vw * 0.5)) : 320
      return Math.round(Math.min(Math.max(raw, 0), cap))
    }

    /** Shifts Mapbox effective viewport so geographic center aligns with visible map (not buried under sidebar). */
    const applySidebarPaddingAndRecenter = (resetCameraDefaults: boolean) => {
      if (disposed || !map) return
      // Avoid `map.loaded()` here: it stays false while style/source dirty bits are set, including inside some `load` handlers.
      if (!map.isStyleLoaded()) return
      try {
        const left = sidebarInsetPx()
        map.setPadding({ top: 0, bottom: 0, right: 0, left })
        map.jumpTo(
          resetCameraDefaults
            ? { center: GAMLA_STAN_CENTER, zoom: DEFAULT_ZOOM, pitch: 42, bearing: -18 }
            : {
                center: GAMLA_STAN_CENTER,
                zoom: map.getZoom(),
                pitch: map.getPitch(),
                bearing: map.getBearing(),
              },
        )
      } catch (err) {
        console.warn('[NexusMap] padding/recenter skipped', err)
      }
      resizeIfLive()
    }

    const onWindowResize = () => {
      if (windowResizeRaf != null) cancelAnimationFrame(windowResizeRaf)
      windowResizeRaf = requestAnimationFrame(() => {
        windowResizeRaf = null
        applySidebarPaddingAndRecenter(false)
      })
    }

    const attachMap = () => {
      if (disposed || map) return

      el.replaceChildren()

      try {
        map = new mapboxgl.Map({
          container: el,
          style: MAPBOX_STYLE,
          config: mapboxBasemapInitConfig(),
          center: GAMLA_STAN_CENTER,
          zoom: DEFAULT_ZOOM,
          pitch: 42,
          bearing: -18,
          attributionControl: true,
          performanceMetricsCollection: false,
        })
        LOG('Map constructor returned')
      } catch (syncErr) {
        console.error('[NexusMap] Map constructor threw (sync)', syncErr)
        setMapError(syncErr instanceof Error ? syncErr.message : String(syncErr))
        return
      }

      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right')
      resizeIfLive()

      mapRo = new ResizeObserver((entries) => {
        if (disposed) return
        const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 }
        if (width > 0 && height > 0) resizeIfLive()
      })
      mapRo.observe(el)

      window.addEventListener('resize', onWindowResize, { passive: true })

      map.on('load', () => {
        if (disposed || !map) return
        LOG('map event: load — style and tiles reached ready state')
        applyMapboxStreetLabels(map)
        if (import.meta.env.DEV && !loggedTelemetryBlockerHint) {
          loggedTelemetryBlockerHint = true
          LOG(
            'Red ERR_BLOCKED_BY_CLIENT for https://events.mapbox.com is analytics/telemetry (ad blockers) — not tiles. The map can still be fine.',
          )
        }
        resizeIfLive()
        applySidebarPaddingAndRecenter(true)
        requestAnimationFrame(() => {
          if (disposed || !map) return
          applySidebarPaddingAndRecenter(false)
        })
        const sidebarEl = document.getElementById('nexus-control-panel')
        if (sidebarEl) {
          sidebarRo?.disconnect()
          sidebarRo = new ResizeObserver(() => applySidebarPaddingAndRecenter(false))
          sidebarRo.observe(sidebarEl)
        }

        try {
          const controller = installNexusHistoricalGraph(map, mapGraph, () => disposed, {
            getMarkerHighlightId: () => highlightTargetRef.current,
            onMarkerHover: (nodeId) => onMarkerHoverRef.current?.(nodeId),
          })
          graphControllerRef.current = controller
          teardownHistorical = controller.dispose
          // Satisfy a focus request that arrived before this rebuild (e.g. a ghost-click year jump).
          const pending = pendingFocusRef.current
          if (pending && controller.openPopup(pending.nodeId)) {
            pendingFocusRef.current = null
          }
        } catch (histErr) {
          console.error('[NexusMap] failed to add historical graph layers', histErr)
        }
      })

      map.on('style.load', () => {
        if (disposed || !map) return
        LOG('map event: style.load')
        applyMapboxStreetLabels(map)
      })

      map.on('error', (e) => {
        console.error('[NexusMap] map event: error', {
          message: e.error?.message,
          error: e.error,
        })
        if (disposed || errorReportedRef.current) return
        const msg = e.error?.message ?? 'Map failed to load a resource (check token and network).'
        errorReportedRef.current = true
        setMapError(msg)
      })

      map.on('click', (e) => {
        if (disposed || !map) return
        graphControllerRef.current?.closePopup()
        if (popupRef.current) {
          popupRef.current.remove()
          popupRef.current = null
        }

        const linkHits = map.queryRenderedFeatures(e.point, { layers: [...NEXUS_LINK_HIT_LAYERS] })
        const linkFeature = linkHits[0]
        const labelProp = linkFeature?.properties?.label
        const linkLabel = typeof labelProp === 'string' ? labelProp : labelProp != null ? String(labelProp) : null
        if (linkLabel) {
          const popup = new mapboxgl.Popup({
            closeButton: true,
            closeOnClick: false,
            className: 'nexus-popup',
            maxWidth: '280px',
            offset: 12,
          })
            .setLngLat(e.lngLat)
            .setHTML(
              `<div class="nexus-link-popup px-3 py-2 font-[family-name:var(--font-nexus-mono)] text-[11px] leading-snug text-violet-100/95">
                 <div class="mb-1 font-[family-name:var(--font-nexus-serif)] text-[9px] uppercase tracking-[0.2em] text-amber-200/70">Nexus · Link</div>
                 ${escapeHtml(linkLabel)}
               </div>`,
            )
            .addTo(map)

          popupRef.current = popup
        }
      })

      mapRef.current = map
    }

    const { width: w0, height: h0 } = el.getBoundingClientRect()
    if (w0 > 0 && h0 > 0) {
      attachMap()
    } else {
      LOG('defer map init until container has non-zero size', { w0, h0 })
      sizeRo = new ResizeObserver((entries) => {
        if (disposed) return
        const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 }
        if (width === 0 || height === 0) return
        sizeRo?.disconnect()
        sizeRo = undefined
        attachMap()
      })
      sizeRo.observe(el)
    }

    return () => {
      disposed = true
      sizeRo?.disconnect()
      mapRo?.disconnect()
      sidebarRo?.disconnect()
      window.removeEventListener('resize', onWindowResize)
      if (windowResizeRaf != null) cancelAnimationFrame(windowResizeRaf)
      LOG('effect cleanup — removing map instance')
      popupRef.current?.remove()
      popupRef.current = null
      graphControllerRef.current = null
      teardownHistorical?.()
      teardownHistorical = undefined
      try {
        map?.remove()
      } catch {
        /* already removed or mid-teardown */
      }
      map = undefined
      mapRef.current = null
      try {
        el.replaceChildren()
      } catch {
        /* detached */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- graphKey fingerprints `mapGraph` content
  }, [token, graphKey])

  const visibleCategories = NEXUS_CATEGORIES.filter((c) =>
    mapGraph.nodes.some((n) => n.category === c.id),
  )

  return (
    <div className="absolute inset-0 isolate z-0 min-h-0 min-w-0 overflow-hidden bg-stone-950">
      <div ref={containerRef} className="absolute inset-0 z-0 min-h-0 min-w-0 bg-stone-950" />

      {visibleCategories.length > 0 && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded border border-stone-800/60 bg-[#070608]/85 px-2.5 py-2 backdrop-blur-sm">
          <ul className="flex flex-col gap-1">
            {visibleCategories.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: c.color, boxShadow: `0 0 5px ${c.color}` }}
                />
                <span className="font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-wider text-stone-400">
                  {c.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mapError && token && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 z-20 max-w-lg -translate-x-1/2 px-4">
          <div className="pointer-events-auto rounded border border-red-900/50 bg-stone-950/95 px-4 py-3 shadow-xl backdrop-blur-md">
            <p className="font-[family-name:var(--font-nexus-mono)] text-[11px] leading-relaxed text-red-200/95">
              {mapError}
            </p>
            {errorLikelyAccessTokenIssue(mapError) ? (
              <p className="mt-2 font-[family-name:var(--font-nexus-mono)] text-[9px] text-stone-500">
                Confirm <code className="text-stone-400">VITE_MAPBOX_ACCESS_TOKEN</code> is a public{' '}
                <code className="text-stone-400">pk.</code> token with Styles, Tilesets, and Fonts enabled; restart{' '}
                <code className="text-stone-400">npm run dev</code> after changing{' '}
                <code className="text-stone-400">.env</code>.
              </p>
            ) : errorLikelyWorkerOrCorsIssue(mapError) ? (
              <p className="mt-2 font-[family-name:var(--font-nexus-mono)] text-[9px] text-stone-500">
                This failure is unrelated to whether your token looks valid: the Web Worker script must load from{' '}
                <strong className="text-stone-400">the same origin as the page</strong> (or blob: workers). Reload after this
                change; avoid pointing <code className="text-stone-400">workerUrl</code> at{' '}
                <code className="text-stone-400">api.mapbox.com</code> from localhost.
              </p>
            ) : (
              <p className="mt-2 font-[family-name:var(--font-nexus-mono)] text-[9px] text-stone-500">
                Check DevTools Console and failing requests under <strong className="text-stone-400">Network</strong> (styles,
                tiles, glyphs).
              </p>
            )}
          </div>
        </div>
      )}

      {!token && (
        <div className="absolute inset-0 flex items-center justify-center bg-stone-950/95 px-6">
          <div className="max-w-md rounded border border-amber-900/30 bg-stone-900/90 p-6 text-center shadow-xl backdrop-blur-md">
            <p className="font-[family-name:var(--font-nexus-serif)] text-lg text-stone-200">
              Mapbox access token required
            </p>
            <p className="mt-3 font-[family-name:var(--font-nexus-mono)] text-xs leading-relaxed text-stone-500">
              Create{' '}
              <code className="text-amber-200/80">.env</code> with{' '}
              <code className="text-amber-200/80">VITE_MAPBOX_ACCESS_TOKEN</code> from your Mapbox account, then restart
              the dev server.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

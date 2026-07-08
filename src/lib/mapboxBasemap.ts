import type { Map as MapboxMap, MapOptions } from 'mapbox-gl'

/** Default: Mapbox Standard — supports showRoadLabels / showPedestrianRoads for gränder. */
export const MAPBOX_STYLE = (
  import.meta.env.VITE_MAPBOX_STYLE ?? 'mapbox://styles/mapbox/standard'
).trim()

export const MAPBOX_LIGHT_PRESET = (
  import.meta.env.VITE_MAPBOX_LIGHT_PRESET ?? 'night'
).trim() as 'dawn' | 'day' | 'dusk' | 'night'

export function isStandardBasemapStyle(styleUrl: string): boolean {
  return /\/standard(?:$|[/?#])/i.test(styleUrl)
}

/** Passed to `new mapboxgl.Map({ config })` when using Mapbox Standard. */
export function mapboxBasemapInitConfig(): MapOptions['config'] | undefined {
  if (!isStandardBasemapStyle(MAPBOX_STYLE)) return undefined
  return {
    basemap: {
      lightPreset: MAPBOX_LIGHT_PRESET,
      showRoadLabels: true,
      showPlaceLabels: true,
      showPedestrianRoads: true,
      showTransitLabels: false,
      showPointOfInterestLabels: false,
      show3dObjects: true,
    },
  }
}

const CLASSIC_LABEL_LAYER = /road|street|path|pedestrian|bridge|tunnel/i

/** Boost label visibility on classic styles (e.g. dark-v11). */
function enhanceClassicStyleLabels(map: MapboxMap): void {
  const layers = map.getStyle()?.layers
  if (!layers) return

  for (const layer of layers) {
    if (layer.type !== 'symbol') continue
    if (!layer.id.includes('label') || !CLASSIC_LABEL_LAYER.test(layer.id)) continue
    try {
      map.setLayoutProperty(layer.id, 'visibility', 'visible')
      map.setPaintProperty(layer.id, 'text-opacity', 1)
      map.setPaintProperty(layer.id, 'text-color', '#ddd6c8')
      map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(7, 6, 8, 0.88)')
      map.setPaintProperty(layer.id, 'text-halo-width', 1.25)
    } catch {
      /* layer may not expose these paint props */
    }
  }
}

function applyStandardBasemapLabels(map: MapboxMap): void {
  try {
    map.setConfigProperty('basemap', 'showRoadLabels', true)
    map.setConfigProperty('basemap', 'showPlaceLabels', true)
    map.setConfigProperty('basemap', 'showPedestrianRoads', true)
    map.setConfigProperty('basemap', 'lightPreset', MAPBOX_LIGHT_PRESET)
  } catch (err) {
    console.warn('[NexusMap] Standard basemap label config failed', err)
  }
}

/** Apply street-name visibility after style load (and on style reload). */
export function applyMapboxStreetLabels(map: MapboxMap): void {
  if (isStandardBasemapStyle(MAPBOX_STYLE)) {
    applyStandardBasemapLabels(map)
  } else {
    enhanceClassicStyleLabels(map)
  }

  try {
    map.setLanguage('sv')
  } catch {
    /* classic styles may not support localized name fields */
  }
}

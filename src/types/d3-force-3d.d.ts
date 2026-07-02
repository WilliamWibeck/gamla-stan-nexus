declare module 'd3-force-3d' {
  export interface ForceCollide {
    (alpha: number): void
    radius(radius: number | ((node: unknown) => number)): ForceCollide
    iterations(iterations: number): ForceCollide
  }
  export function forceCollide(radius?: number | ((node: unknown) => number)): ForceCollide
}

export interface VisualViewportGeometry {
  height: number;
  offsetTop: number;
}

type ViewportMeasurements = Pick<VisualViewport, 'height' | 'offsetTop' | 'pageTop'>;

/**
 * Return the visible browser rect in layout-viewport coordinates. WebKit can
 * publish offsetTop a frame late while opening its keyboard, and some releases
 * report pageTop first, so keep both measurements as equivalent signals.
 */
export function visualViewportGeometry(
  viewport: ViewportMeasurements | null | undefined,
  fallbackHeight: number,
  scrollY: number,
): VisualViewportGeometry {
  if (!viewport) {
    return { height: Math.round(fallbackHeight), offsetTop: 0 };
  }

  const pageOffset = viewport.pageTop - scrollY;
  return {
    height: Math.round(viewport.height),
    offsetTop: Math.max(0, Math.round(viewport.offsetTop), Math.round(pageOffset)),
  };
}

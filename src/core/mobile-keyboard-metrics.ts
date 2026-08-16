const KEYBOARD_THRESHOLD = 120;

export interface KeyboardViewportMetrics {
  visibleHeight: number;
  offsetTop: number;
  keyboardHeight: number;
  availableHeight: number;
  keyboardOpen: boolean;
}

export function calculateKeyboardViewport(
  layoutHeight: number,
  visualHeight: number,
  offsetTop: number,
  surfaceTop: number,
): KeyboardViewportMetrics {
  const layout = Math.max(0, layoutHeight);
  const visible = Math.max(0, Math.min(visualHeight, layout));
  const top = Math.max(0, offsetTop);
  const visibleBottom = Math.min(layout, top + visible);
  const keyboardHeight = Math.max(0, layout - visibleBottom);
  return {
    visibleHeight: visible,
    offsetTop: top,
    keyboardHeight,
    availableHeight: Math.max(0, visibleBottom - Math.max(0, surfaceTop)),
    keyboardOpen: keyboardHeight >= KEYBOARD_THRESHOLD,
  };
}

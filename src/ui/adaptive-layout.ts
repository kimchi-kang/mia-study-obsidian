/** Track the pane's position so host-provided safe areas are not counted twice. */
export function bindAdaptiveLayout(surface: HTMLElement): { destroy(): void } {
  const win = surface.ownerDocument.defaultView;
  if (!win) return { destroy() {} };
  let frame: number | null = null;
  const properties = ["--mia-pane-top", "--mia-pane-left", "--mia-pane-right-gap", "--mia-pane-bottom-gap", "--mia-pane-width"];
  const refresh = (): void => {
    frame = null;
    const rect = surface.getBoundingClientRect();
    // Hidden tabs have no useful geometry; ResizeObserver refreshes them on return.
    if (rect.width <= 0 || rect.height <= 0) return;
    const values = [rect.top, rect.left, win.innerWidth - rect.right, win.innerHeight - rect.bottom, rect.width];
    properties.forEach((property, index) => surface.style.setProperty(property, `${Math.max(0, values[index] ?? 0)}px`));
    surface.dataset.viewportHeight = rect.height < 320 ? "minimal" : rect.height < 440 ? "short" : rect.height < 600 ? "compact" : "regular";
  };
  const schedule = (): void => {
    if (frame === null) frame = win.requestAnimationFrame(refresh);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(surface);
  win.addEventListener("resize", schedule);
  win.visualViewport?.addEventListener("resize", schedule);
  win.visualViewport?.addEventListener("scroll", schedule);
  schedule();
  return {
    destroy(): void {
      observer.disconnect();
      win.removeEventListener("resize", schedule);
      win.visualViewport?.removeEventListener("resize", schedule);
      win.visualViewport?.removeEventListener("scroll", schedule);
      if (frame !== null) win.cancelAnimationFrame(frame);
      properties.forEach(property => surface.style.removeProperty(property));
      delete surface.dataset.viewportHeight;
    },
  };
}

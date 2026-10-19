/** Discard compatibility clicks after dragging across a rating button. */
export function bindRatingTapGuard(surface: HTMLElement): { reset(): void; destroy(): void } {
  let touch: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  let blockedUntil = -1;
  const ratingButton = (target: EventTarget | null) => {
    const button = (target as HTMLElement | null)?.closest?.(".mia-ratings button");
    return button && surface.contains(button) ? button : null;
  };
  const moved = (event: PointerEvent) => touch !== null
    && (touch.moved || Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 16);
  const down = (event: PointerEvent) => {
    blockedUntil = -1;
    if (event.pointerType !== "touch" || !event.isPrimary || !ratingButton(event.target)) {
      if (touch) blockedUntil = event.timeStamp + 500;
      touch = null;
      return;
    }
    touch = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: PointerEvent) => {
    if (touch?.pointerId === event.pointerId) touch.moved = moved(event);
  };
  const up = (event: PointerEvent) => {
    if (touch?.pointerId !== event.pointerId) return;
    // A coalesced touch can arrive without pointermove; always check its endpoint.
    if (moved(event)) blockedUntil = event.timeStamp + 500;
    touch = null;
  };
  const cancel = (event: PointerEvent) => {
    if (touch?.pointerId !== event.pointerId) return;
    touch = null;
    blockedUntil = event.timeStamp + 500;
  };
  const click = (event: MouseEvent) => {
    if (event.detail === 0 || event.timeStamp > blockedUntil || !ratingButton(event.target)) return;
    blockedUntil = -1;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const reset = () => { touch = null; blockedUntil = -1; };
  surface.addEventListener("pointerdown", down, true);
  surface.addEventListener("pointermove", move, true);
  surface.addEventListener("pointerup", up, true);
  surface.addEventListener("pointercancel", cancel, true);
  surface.addEventListener("click", click, true);
  return { reset, destroy() {
    reset();
    surface.removeEventListener("pointerdown", down, true);
    surface.removeEventListener("pointermove", move, true);
    surface.removeEventListener("pointerup", up, true);
    surface.removeEventListener("pointercancel", cancel, true);
    surface.removeEventListener("click", click, true);
  } };
}

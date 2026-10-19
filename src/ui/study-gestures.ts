import { StudySwipe, StudySwipeDirection, SwipePoint, SwipeSensitivity } from "../core/study-swipe";

export interface StudyGestureBinding {
  reset: () => void;
  destroy: () => void;
}

export function bindStudyGestures(
  surface: HTMLElement,
  enabled: () => boolean,
  navigate: (direction: StudySwipeDirection) => void,
  sensitivity: () => SwipeSensitivity = () => "normal",
): StudyGestureBinding {
  const swipe = new StudySwipe();
  let card: HTMLElement | null = null;
  const hasSelection = () => surface.ownerDocument.getSelection()?.isCollapsed === false;
  const point = (event: PointerEvent): SwipePoint => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });
  const reset = () => {
    swipe.cancel();
    if (card) {
      card.style.removeProperty("--mia-swipe-x");
      card.style.removeProperty("--mia-swipe-progress");
      delete card.dataset.swipeLabel;
      card = null;
    }
  };
  const down = (event: PointerEvent) => {
    reset();
    if (!enabled() || event.pointerType !== "touch" || !event.isPrimary || hasSelection()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("button, a, input, textarea, select, summary, [contenteditable]:not([contenteditable='false']), pre, code, table, .math, .math-block, .internal-embed, img, video, audio, canvas")) return;
    const candidate = target?.closest<HTMLElement>(".mia-study-card");
    if (!candidate || !surface.contains(candidate)) return;
    const bounds = candidate.getBoundingClientRect();
    const viewportWidth = surface.ownerDocument.defaultView?.innerWidth ?? bounds.right;
    if (event.clientX < 24 || viewportWidth - event.clientX < 24 || event.clientX - bounds.left < 20 || bounds.right - event.clientX < 20) return;
    card = candidate;
    swipe.begin(point(event), bounds.width, sensitivity());
  };
  const move = (event: PointerEvent) => {
    if (!card) return;
    if (!enabled() || !event.isPrimary || hasSelection()) { reset(); return; }
    const feedback = swipe.move(point(event));
    if (!feedback) {
      card.style.setProperty("--mia-swipe-progress", "0");
      card.style.setProperty("--mia-swipe-x", "0px");
      return;
    }
    card.dataset.swipeLabel = feedback.direction === "next" ? "다음 문제 →" : "← 이전 문제";
    card.style.setProperty("--mia-swipe-progress", String(feedback.progress));
    card.style.setProperty("--mia-swipe-x", `${feedback.offset}px`);
  };
  const up = (event: PointerEvent) => {
    const direction = card && enabled() && !hasSelection() ? swipe.finish(point(event)) : null;
    reset();
    if (direction) navigate(direction);
  };
  // Pointer cancellation lets the browser retain vertical scroll and pinch zoom.
  surface.addEventListener("pointerdown", down);
  surface.addEventListener("pointermove", move);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", reset);
  return {
    reset,
    destroy: () => {
      reset();
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", reset);
    },
  };
}

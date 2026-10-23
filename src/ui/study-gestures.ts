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
  let feedbackSurface: HTMLElement | null = null;
  const hasSelection = () => surface.ownerDocument.getSelection()?.isCollapsed === false;
  const point = (event: PointerEvent): SwipePoint => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });
  const reset = () => {
    swipe.cancel();
    if (feedbackSurface) {
      feedbackSurface.style.removeProperty("--mia-swipe-progress");
      delete feedbackSurface.dataset.swipeLabel;
      feedbackSurface = null;
    }
  };
  const down = (event: PointerEvent) => {
    reset();
    if (!enabled() || event.pointerType !== "touch" || !event.isPrimary || hasSelection()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("button, a, input, textarea, select, summary, [contenteditable]:not([contenteditable='false']), pre, code, table, .math, .math-block, .internal-embed, img, video, audio, canvas")) return;
    const bounds = surface.getBoundingClientRect();
    // Start in the left edge of this view, including the padding outside the card.
    if (event.clientX < bounds.left || event.clientX > bounds.left + Math.min(48, bounds.width * 0.15)) return;
    feedbackSurface = surface;
    swipe.begin(point(event), bounds.width, sensitivity());
  };
  const move = (event: PointerEvent) => {
    if (!feedbackSurface) return;
    if (!enabled() || !event.isPrimary || hasSelection()) { reset(); return; }
    const feedback = swipe.move(point(event));
    if (!feedback) {
      feedbackSurface.style.setProperty("--mia-swipe-progress", "0");
      return;
    }
    feedbackSurface.dataset.swipeLabel = "뒤로가기 →";
    feedbackSurface.style.setProperty("--mia-swipe-progress", String(feedback.progress));
  };
  const up = (event: PointerEvent) => {
    const direction = feedbackSurface && enabled() && !hasSelection() ? swipe.finish(point(event)) : null;
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

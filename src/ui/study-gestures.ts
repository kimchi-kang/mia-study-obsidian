import { StudySwipe, StudySwipeDirection, SwipePoint, SwipeSensitivity } from "../core/study-swipe";
import { TrackpadSwipe } from "../core/trackpad-swipe";

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

/** 대상에서 화면 바깥(surface)까지 올라가며, 왼쪽으로 더 스크롤할 수 있는 가로 스크롤 영역이 있는지 본다. */
function canScrollLeft(target: EventTarget | null, surface: HTMLElement): boolean {
  let node = (target as Node | null)?.nodeType === 1 ? target as HTMLElement : null;
  while (node && node !== surface) {
    if (node.scrollLeft > 0 && node.scrollWidth > node.clientWidth) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * 데스크톱 트랙패드 두 손가락 쓸기(오른쪽으로)를 뒤로가기로 연결한다.
 * 핀치·세로 스크롤·왼쪽으로 스크롤할 수 있는 수식·코드 영역 위의 쓸기는 건드리지 않는다.
 */
export function bindTrackpadBack(
  surface: HTMLElement,
  enabled: () => boolean,
  back: () => void,
  sensitivity: () => SwipeSensitivity = () => "normal",
): StudyGestureBinding {
  const swipe = new TrackpadSwipe();
  const wheel = (event: WheelEvent) => {
    if (!enabled()) return;
    if (canScrollLeft(event.target, surface)) { swipe.suppress(event.timeStamp); return; }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientWidth : 1;
    const result = swipe.feed({ dx: event.deltaX * unit, dy: event.deltaY * unit, time: event.timeStamp, ctrl: event.ctrlKey }, sensitivity());
    if (result === "back") back();
  };
  surface.addEventListener("wheel", wheel, { passive: true });
  return {
    reset: () => swipe.reset(),
    destroy: () => surface.removeEventListener("wheel", wheel),
  };
}

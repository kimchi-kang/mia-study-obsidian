import type { SwipeSensitivity } from "./study-swipe";

export interface TrackpadWheel {
  /** 가로 이동량(px). 맥에서 두 손가락을 오른쪽으로 쓸면 음수다. */
  dx: number;
  dy: number;
  time: number;
  /** 핀치(ctrl + wheel)는 확대·축소라 무시한다. */
  ctrl: boolean;
}

const THRESHOLDS: Record<SwipeSensitivity, number> = { light: 80, normal: 120, firm: 170 };
/** 이만큼 wheel 신호가 끊기면 새 쓸기로 본다. */
const GAP_MS = 220;

/**
 * 트랙패드 두 손가락 쓸기를 "뒤로가기" 한 번으로 바꾼다.
 * 손가락을 오른쪽으로 쓸어(Safari 뒤로가기와 같은 방향) 가로 이동이 기준을 넘고 세로보다 확실히 크면 한 번 반응한다.
 * 반응한 뒤에는 관성 스크롤 신호가 끝날 때까지(GAP_MS 동안 조용할 때까지) 다시 반응하지 않는다.
 */
export class TrackpadSwipe {
  private sumX = 0;
  private sumY = 0;
  private last = Number.NEGATIVE_INFINITY;
  private locked = false;

  reset(): void {
    this.sumX = 0;
    this.sumY = 0;
    this.locked = false;
    this.last = Number.NEGATIVE_INFINITY;
  }

  feed(wheel: TrackpadWheel, sensitivity: SwipeSensitivity = "normal"): "back" | null {
    if (wheel.time - this.last > GAP_MS) {
      this.sumX = 0;
      this.sumY = 0;
      this.locked = false;
    }
    this.last = wheel.time;
    if (wheel.ctrl || this.locked) return null;
    this.sumX += wheel.dx;
    this.sumY += wheel.dy;
    if (this.sumX <= -THRESHOLDS[sensitivity] && Math.abs(this.sumX) > 2 * Math.abs(this.sumY)) {
      this.locked = true;
      return "back";
    }
    return null;
  }
}

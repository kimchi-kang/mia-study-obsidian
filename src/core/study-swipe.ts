export type SwipeSensitivity = "light" | "normal" | "firm";
export type StudySwipeDirection = "back";

export interface SwipePoint {
  pointerId: number;
  x: number;
  y: number;
  time: number;
}

/** One deliberate horizontal stroke; scrolling, pauses and extra fingers cancel it. */
export class StudySwipe {
  private start: SwipePoint | null = null;
  private threshold = 72;

  begin(point: SwipePoint, width: number, sensitivity: SwipeSensitivity = "normal"): void {
    this.start = point;
    const limits = { light: [48, 80, 0.15], normal: [64, 110, 0.2], firm: [84, 140, 0.25] } as const;
    const [minimum, maximum, proportion] = limits[sensitivity];
    this.threshold = Math.max(minimum, Math.min(maximum, width * proportion));
  }

  cancel(): void { this.start = null; }

  move(point: SwipePoint): { direction: StudySwipeDirection; progress: number } | null {
    const start = this.start;
    if (!start || point.pointerId !== start.pointerId) return null;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (point.time - start.time > 900 || Math.abs(dy) > 60 || (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx))) {
      this.cancel();
      return null;
    }
    if (dx < 0) { this.cancel(); return null; }
    if (dx < 16 || dx < Math.abs(dy) * 2) return null;
    return { direction: "back", progress: Math.min(1, Math.abs(dx) / this.threshold) };
  }

  finish(point: SwipePoint): StudySwipeDirection | null {
    const feedback = this.move(point);
    this.cancel();
    return feedback?.progress === 1 ? feedback.direction : null;
  }
}

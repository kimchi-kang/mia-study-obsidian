export type MiaRoute = "dashboard" | "progress" | "questions" | "keywords" | "study";

export class MiaNavigationHistory {
  private previous: MiaRoute[] = [];

  constructor(private active: MiaRoute = "dashboard") {}

  get current(): MiaRoute { return this.active; }
  get canGoBack(): boolean { return this.previous.length > 0; }

  navigate(next: MiaRoute): MiaRoute {
    if (next === this.active) return this.active;
    this.previous.push(this.active);
    this.active = next;
    return this.active;
  }

  back(): MiaRoute {
    this.active = this.previous.pop() ?? "dashboard";
    return this.active;
  }

  reset(next: MiaRoute = "dashboard"): MiaRoute {
    this.previous = [];
    this.active = next;
    return this.active;
  }
}

export interface SwipePoint {
  x: number;
  y: number;
  at: number;
}

export function isBackSwipe(start: SwipePoint, end: SwipePoint): boolean {
  const horizontal = end.x - start.x;
  const vertical = Math.abs(end.y - start.y);
  const duration = end.at - start.at;
  return horizontal >= 80 && vertical <= horizontal * 0.6 && duration >= 0 && duration <= 1_200;
}

export class TrackpadBackGesture {
  private distance = 0;
  private lastAt = 0;
  private cooldownUntil = 0;

  update(deltaX: number, deltaY: number, at: number): boolean {
    if (at < this.cooldownUntil) return false;
    if (at - this.lastAt > 240) this.distance = 0;
    this.lastAt = at;
    if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) {
      this.distance = 0;
      return false;
    }
    this.distance = Math.max(0, this.distance - deltaX);
    if (this.distance < 180) return false;
    this.distance = 0;
    this.cooldownUntil = at + 650;
    return true;
  }
}

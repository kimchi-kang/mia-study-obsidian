/** Recall metadata only; never used by the scheduler or optimizer. */
export const MAX_ANSWER_SECONDS = 60;

export function normalizeAnswerMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_ANSWER_SECONDS * 1000, Math.round(value)) : undefined;
}

export function formatAnswerDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

export function formatTotalAnswerDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return formatAnswerDuration(ms);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes}분`;
  return minutes % 60 ? `${hours}시간 ${minutes % 60}분` : `${hours}시간`;
}

export class AnswerClock {
  private elapsed = 0;
  private started: number | null = null;
  private stopped = false;
  constructor(hidden: boolean) { this.resume(hidden); }
  get milliseconds(): number {
    return normalizeAnswerMs(this.elapsed + (this.started === null ? 0 : Math.max(0, Date.now() - this.started)))!;
  }
  pause(): void {
    this.elapsed = this.milliseconds;
    this.started = null;
  }
  resume(hidden: boolean): void {
    if (!hidden && !this.stopped && this.started === null) this.started = Date.now();
  }
  stop(): number {
    this.pause();
    this.stopped = true;
    return this.milliseconds;
  }
  get running(): boolean { return !this.stopped; }
}

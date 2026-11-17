import { describe, expect, it } from "vitest";
import { formatInterval, summarizeStudySession } from "../src/ui/study-session-calculations";
const now = new Date("2026-11-17T00:00:00Z");
describe("study display calculations", () => {
  it.each([[1, "1분"], [60, "1시간"], [1440, "1일"], [1500, "25시간"]] as const)("preserves fixed interval %i", (minutes, label) => {
    expect(formatInterval(now, 0, minutes, now)).toBe(label);
  });
  it.each([[0, "1분"], [1, "1일"], [29, "29일"], [30, "약 1개월"], [364, "약 12개월"], [365, "약 1.0년"]] as const)("preserves scheduled day label %i", (days, label) => {
    expect(formatInterval(new Date(now.getTime() + days * 86400000), days, undefined, now)).toBe(label);
  });
  it("preserves mixed intervals and expired due dates", () => {
    expect(formatInterval(new Date(now.getTime() + 1501 * 60000), 1, undefined, now)).toBe("1일 1시간 1분");
    expect(formatInterval(new Date(now.getTime() - 60000), 0, undefined, now)).toBe("1분");
  });
  it("counts unique cards, excludes graded skips and omits missing answer times", () => {
    expect(summarizeStudySession({ queue: ["a", "b", "a", "c"], grades: new Map([["a", 1], ["b", 3]]), skipped: new Set(["a", "c"]), startedAt: 1000, now: () => 3500,
      reviewFor: () => undefined })).toEqual({ total: 3, again: 1, hard: 0, good: 1, easy: 0, skipped: 1, durationSeconds: 3 });
  });
});

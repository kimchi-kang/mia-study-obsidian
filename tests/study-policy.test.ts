import { describe, expect, it } from "vitest";
import { learningStepGuidance, progressGuidance } from "../src/ui/study-policy";

describe("configured learning policy copy", () => {
  it("explains six minutes only for the corresponding 1m/10m steps", () => {
    expect(learningStepGuidance(["1m", "10m"], false)).toContain("6분");
    expect(learningStepGuidance(["2m", "20m"], false)).toContain("11분");
    expect(learningStepGuidance(["2m", "20m"], false)).not.toContain("6분");
    expect(learningStepGuidance(["10m"], false)).toContain("15분");
  });
  it("explains review transition for day-sized selected steps or Hard intervals", () => {
    expect(learningStepGuidance(["1d", "2d"], false)).toContain("복습 상태로 전환");
    expect(learningStepGuidance(["16h"], false)).toContain("24시간 이상");
    expect(learningStepGuidance(["1m", "10m"], false)).not.toContain("복습 상태로 전환");
  });
  it("does not promise an automatic Hard interval when a fixed button overrides it", () => {
    const copy = learningStepGuidance(["1m", "10m"], true);
    expect(copy).toContain("고정 간격이 우선"); expect(copy).not.toContain("6분");
    expect(learningStepGuidance([], false)).toContain("고정 학습 단계 없이");
    expect(learningStepGuidance(null, false)).not.toContain("6분");
  });
  it("separates calendar counts, total due and the configured study-day budget", () => {
    const copy = progressGuidance(7);
    expect(copy).toContain("자정"); expect(copy).toContain("한도 적용 전");
    expect(copy).toContain("기기 시간 7시"); expect(copy).not.toContain("4시");
  });
});

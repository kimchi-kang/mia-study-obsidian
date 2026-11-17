import { describe, expect, it } from "vitest";
import { isLeech, LEECH_LAPSES, AUTO_QUESTION_SECONDS, AUTO_ANSWER_SECONDS, parseAutoAdvance, autoRemaining } from "../src/core/study-automation";
import { FsrsService } from "../src/core/fsrs-service";
import { parseStudyAppearance } from "../src/services/study-ui-store";

const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
describe("leech and device auto advance settings", () => {
  it("reads only saved card lapses, including the 7/8 boundary", () => {
    expect(LEECH_LAPSES).toBe(8); expect(isLeech(undefined)).toBe(false);
    const review = fsrs.rate(undefined, 3, new Date(), "q");
    expect(isLeech(review)).toBe(false);
    review.card.lapses = 7; expect(isLeech(review)).toBe(false);
    review.card.lapses = 8; expect(isLeech(review)).toBe(true);
    review.card.lapses = 99; expect(isLeech(review)).toBe(true);
  });
  it.each([undefined, -1, 1, 7, 100, "10", null, NaN, Infinity])("normalizes invalid durations %s to off", value => {
    expect(parseAutoAdvance({ autoQuestionSeconds: value, autoAnswerSeconds: value, autoAnswerAction: value })).toEqual({ autoQuestionSeconds: 0, autoAnswerSeconds: 0, autoAnswerAction: "skip" });
  });
  it("accepts every allowed duration and defaults absent device keys off", () => {
    for (const value of AUTO_QUESTION_SECONDS) expect(parseAutoAdvance({ autoQuestionSeconds: value }).autoQuestionSeconds).toBe(value);
    for (const value of AUTO_ANSWER_SECONDS) expect(parseAutoAdvance({ autoAnswerSeconds: value }).autoAnswerSeconds).toBe(value);
    expect(parseAutoAdvance({ autoAnswerAction: "again" }).autoAnswerAction).toBe("again");
    expect(parseAutoAdvance({ ...parseStudyAppearance({}) })).toEqual({ autoQuestionSeconds: 0, autoAnswerSeconds: 0, autoAnswerAction: "skip" });
    expect(autoRemaining(10, 9999)).toBe(1); expect(autoRemaining(10, 10000)).toBe(0);
  });
});

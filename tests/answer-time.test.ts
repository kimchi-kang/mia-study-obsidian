import { describe, expect, it } from "vitest";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { parsePluginData } from "../src/services/data-store";
import { mergeReviewData } from "../src/core/review-sync";
import { reviewsToOptimizerItems } from "../src/core/fsrs-optimizer";
import { formatAnswerDuration, MAX_ANSWER_SECONDS } from "../src/core/answer-time";

const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
describe("answer time metadata compatibility", () => {
  it.each([undefined, 0, 12345, MAX_ANSWER_SECONDS * 1000])("keeps %s across load and sync without affecting optimization or scheduling", ms => {
    const first=fsrs.rate(undefined, 3, new Date("2026-11-01T00:00:00Z"), "q", ms);
    const state=fsrs.rate(first, 3, new Date("2026-11-03T00:00:00Z"), "q", ms);
    const raw=structuredClone(DEFAULT_PLUGIN_DATA);raw.reviews.q=state;
    const loaded=parsePluginData(raw);
    expect(loaded.reviews.q).toEqual(state);
    const merged=mergeReviewData(structuredClone(DEFAULT_PLUGIN_DATA),loaded);
    expect(merged.reviews.q).toEqual(state);
    const before=structuredClone(merged.reviews);
    const plain=structuredClone(merged.reviews);
    plain.q!.history.forEach(log=>delete log.answer_ms);
    expect(reviewsToOptimizerItems(merged.reviews,4)).toEqual(reviewsToOptimizerItems(plain,4));
    expect(merged.reviews).toEqual(before);
    expect(fsrs.preview(merged.reviews.q,new Date("2026-11-04"),"q")).toEqual(fsrs.preview(plain.q,new Date("2026-11-04"),"q"));
    expect(fsrs.rate(merged.reviews.q,3,new Date("2026-11-04"),"q").card).toEqual(fsrs.rate(plain.q,3,new Date("2026-11-04"),"q").card);
  });
  it.each([[-1,undefined],[NaN,undefined],[Infinity,undefined],[60001,60000],[12.6,13]])("normalizes invalid or excessive %s",(rawMs,expected)=>{
    const raw=structuredClone(DEFAULT_PLUGIN_DATA);
    raw.reviews.q=fsrs.rate(undefined,3,new Date(),"q");raw.reviews.q.history[0]!.answer_ms=rawMs!;
    const loaded=parsePluginData(raw);expect(loaded.reviews.q!.history[0]!.answer_ms).toBe(expected);expect(loaded.quarantinedReviews).toEqual({});
    expect(fsrs.rate(undefined,3,new Date(),"q",rawMs).history[0]!.answer_ms).toBe(expected);
  });
  it("formats rounded averages including minutes",()=>{
    expect(formatAnswerDuration(12000)).toBe("12초");expect(formatAnswerDuration(63000)).toBe("1분 3초");
  });
});

it("retains timed and old untimed branches in a sync conflict",()=>{
  const old=structuredClone(DEFAULT_PLUGIN_DATA),timed=structuredClone(DEFAULT_PLUGIN_DATA);
  old.reviews.q=fsrs.rate(undefined,3,new Date("2026-11-01"),"q");
  timed.reviews.q=fsrs.rate(undefined,3,new Date("2026-11-01"),"q",12000);
  old.reviewVersions.q="2026-11-01T00:00:00.000Z:a";timed.reviewVersions.q="2026-11-02T00:00:00.000Z:b";
  const merged=parsePluginData(mergeReviewData(old,timed));
  expect(merged.reviews.q!.history[0]!.answer_ms).toBe(12000);
  expect(merged.reviewConflicts.q!.some(state=>state.history[0]!.answer_ms===undefined)).toBe(true);
});

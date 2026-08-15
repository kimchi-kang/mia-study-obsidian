import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { DataStoreInternals } from "../src/services/data-store";

describe("settings validation", () => {
  it("clamps invalid values and normalizes roots", () => {
    const settings = DataStoreInternals.parseSettings({
      sourceRoots: [" 전자기학 ", 42, ""],
      targetRetention: 2,
      maximumIntervalDays: -4,
      newCardsPerDay: 12,
      reviewsPerDay: 0,
      keywordFolder: "",
    });
    expect(settings.sourceRoots).toEqual(["전자기학"]);
    expect(settings.targetRetention).toBe(0.99);
    expect(settings.maximumIntervalDays).toBe(36500);
    expect(settings).not.toHaveProperty("newCardsPerDay");
    expect(settings).not.toHaveProperty("reviewsPerDay");
    expect(settings.keywordFolder).toBe("MIA/키워드");
  });

  it("normalizes duplicate paths and rejects traversal or internal keyword folders", () => {
    const settings = DataStoreInternals.parseSettings({
      sourceRoots: ["/전자기학/", "전자기학", "../밖"],
      keywordFolder: ".obsidian/plugins",
    });
    expect(settings.sourceRoots).toEqual(["전자기학"]);
    expect(settings.keywordFolder).toBe("MIA/키워드");
  });
});

describe("review data validation", () => {
  it("accepts complete FSRS data and derives the last rating from its history", () => {
    const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
    const review = fsrs.rate(undefined, Rating.Good, new Date("2026-08-16T00:00:00.000Z"));
    const parsed = DataStoreInternals.parseReviews({ "mia-q-valid": { ...review, lastRating: 99 } });
    expect(parsed.reviews["mia-q-valid"]?.lastRating).toBe(Rating.Good);
    expect(parsed.quarantined).toEqual({});
  });

  it("quarantines malformed records without discarding their original value", () => {
    const corrupt = { card: { due: "not-a-date" }, history: [], lastRating: null };
    const parsed = DataStoreInternals.parseReviews({ "mia-q-corrupt": corrupt });
    expect(parsed.reviews).toEqual({});
    expect(parsed.quarantined["mia-q-corrupt"]).toEqual(corrupt);
  });

  it("preserves an existing quarantine while recovering newly valid records", () => {
    const parsed = DataStoreInternals.parseReviews({}, { "mia-q-old": { raw: true } });
    expect(parsed.quarantined).toEqual({ "mia-q-old": { raw: true } });
  });
});

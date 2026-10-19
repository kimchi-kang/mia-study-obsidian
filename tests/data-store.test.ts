import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import type { Plugin } from "obsidian";
import { DataStoreInternals, MiaDataStore } from "../src/services/data-store";

describe("settings validation", () => {
  it("starts new installs under MIA and preserves existing user locations", () => {
    expect(DataStoreInternals.parseSettings(undefined)).toMatchObject({
      sourceRoots: ["MIA"], keywordFolder: "MIA/키워드",
    });
    expect(DataStoreInternals.parseSettings({ sourceRoots: ["내 학습"], keywordFolder: "내 학습/개념" })).toMatchObject({
      sourceRoots: ["내 학습"], keywordFolder: "내 학습/개념",
    });
  });
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

describe("review deletion", () => {
  it("removes several question records in one persisted update", async () => {
    const writes: unknown[] = [];
    const plugin = {
      loadData: async () => ({}),
      saveData: async (value: unknown) => { writes.push(value); },
    } as unknown as Plugin;
    const store = new MiaDataStore(plugin);
    await store.load();
    const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
    const review = fsrs.rate(undefined, Rating.Good, new Date("2026-08-16T00:00:00.000Z"));
    await store.setReview("one", review);
    await store.setReview("two", review);
    const before = writes.length;
    await store.removeReviews(["one", "two", "one"]);
    expect(store.reviews).toEqual({});
    expect(writes).toHaveLength(before + 1);
  });
});

describe("overlapping saves", () => {
  it("does not carry a failed review into a queued successful settings save", async () => {
    let rejectSave!: (error: Error) => void;
    const writes: unknown[] = [];
    const plugin = {
      loadData: async () => ({}),
      saveData: async (value: unknown) => {
        writes.push(structuredClone(value));
        if (writes.length === 1) await new Promise<void>((_resolve, reject) => { rejectSave = reject; });
      },
    } as unknown as Plugin;
    const store = new MiaDataStore(plugin); await store.load();
    const review = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }).rate(undefined, Rating.Good);
    const first = store.setReview("one", review);
    const failed = expect(first).rejects.toThrow("disk full");
    const second = store.updateSettings({ targetRetention: 0.85 });
    await new Promise(resolve => setTimeout(resolve, 0));
    rejectSave(Error("disk full"));
    await failed; await second;
    expect(store.getReview("one")).toBeUndefined();
    expect(writes.at(-1)).toHaveProperty("reviews", {});
    expect(writes.at(-1)).toMatchObject({ settings: { targetRetention: 0.85 } });
  });

  it("commits queued review changes in order even when the first save fails", async () => {
    const writes: unknown[] = [];
    const store = new MiaDataStore({
      loadData: async () => ({}),
      saveData: async (value: unknown) => { writes.push(structuredClone(value)); if (writes.length === 1) throw Error("disk full"); },
    } as unknown as Plugin);
    await store.load();
    const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
    const old = fsrs.rate(undefined, Rating.Again), latest = fsrs.rate(undefined, Rating.Good);
    const first = store.setReview("one", old);
    const failed = expect(first).rejects.toThrow("disk full");
    const second = store.setReview("one", latest);
    await failed; await second;
    expect(store.getReview("one")).toEqual(latest);
    expect(writes.at(-1)).toMatchObject({ reviews: { one: latest } });
  });
});

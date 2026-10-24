import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { DEFAULT_SETTINGS, MAX_GRADE_INTERVAL_MINUTES } from "../src/core/models";
import { FsrsService } from "../src/core/fsrs-service";
import { DataStoreInternals, MiaDataStore } from "../src/services/data-store";

const now = new Date("2026-10-24T10:00:00Z");
const intervals = { 1: 5, 2: 90, 3: 2 * 1440, 4: 7 * 1440 };
const automatic = new FsrsService(DEFAULT_SETTINGS);
const custom = new FsrsService({ ...DEFAULT_SETTINGS, gradeIntervalsMinutes: intervals });

describe("button-specific review intervals", () => {
  for (const stateName of ["new", "learning", "review", "relearning"] as const) {
    it(`uses the same fixed due time in previews and saved ${stateName} ratings`, () => {
      const learned = automatic.rate(undefined, Rating.Again, new Date(now.getTime() - 86400000));
      const reviewed = automatic.rate(undefined, Rating.Easy, new Date(now.getTime() - 10 * 86400000));
      const relearning = automatic.rate(reviewed, Rating.Again, new Date(now.getTime() - 86400000));
      const state = { new: undefined, learning: learned, review: reviewed, relearning }[stateName];
      const before = JSON.stringify(state);
      for (const preview of custom.preview(state, now, "q")) {
        const rated = custom.rate(state, preview.grade, now, "q");
        expect(preview.due.getTime() - now.getTime()).toBe(intervals[preview.grade] * 60000);
        expect(rated.card.due).toBe(preview.due.toISOString());
        expect(rated.card.scheduled_days).toBe(preview.scheduledDays);
        expect(rated.history.length).toBe((state?.history.length ?? 0) + 1);
        expect(rated.card.reps).toBe((state?.card.reps ?? 0) + 1);
        expect(DataStoreInternals.parseReviews({ q: rated }).quarantined).toEqual({});
        expect(custom.isDue(rated, new Date(preview.due.getTime() - 1))).toBe(false);
        expect(custom.isDue(rated, preview.due)).toBe(true);
      }
      expect(JSON.stringify(state)).toBe(before);
    });
  }

  it("keeps unspecified buttons automatic and caps configured values at the maximum", () => {
    const mixed = new FsrsService({ ...DEFAULT_SETTINGS, maximumIntervalDays: 1, gradeIntervalsMinutes: { 1: 10, 4: 3 * 1440 } });
    const base = new FsrsService({ ...DEFAULT_SETTINGS, maximumIntervalDays: 1 });
    const previews = mixed.preview(undefined, now, "q");
    expect(previews[0]!.due.getTime() - now.getTime()).toBe(600000);
    expect(previews[3]!.due.getTime() - now.getTime()).toBe(86400000);
    expect(previews[1]).toEqual(base.preview(undefined, now, "q")[1]);
    expect(previews[2]).toEqual(base.preview(undefined, now, "q")[2]);
    expect(new FsrsService({ ...DEFAULT_SETTINGS, gradeIntervalsMinutes: {} }).preview(undefined, now, "q")).toEqual(automatic.preview(undefined, now, "q"));
  });

  it("keeps fractional-day hour intervals and the next FSRS review serializable", () => {
    const service = new FsrsService({ ...DEFAULT_SETTINGS, gradeIntervalsMinutes: { 4: 36 * 60 } });
    const first = service.rate(undefined, Rating.Easy, now, "q");
    expect(first.card.scheduled_days).toBe(1.5);
    const restored = JSON.parse(JSON.stringify(first));
    const second = service.rate(restored, Rating.Good, new Date(first.card.due), "q");
    expect(DataStoreInternals.parseReviews({ q: second }).quarantined).toEqual({});
    expect(Number.isFinite(Date.parse(second.card.due))).toBe(true);
  });

  it("migrates old settings to automatic intervals and filters malformed overrides", () => {
    expect(DataStoreInternals.parseSettings({ targetRetention: .9 }).gradeIntervalsMinutes).toEqual({});
    expect(DataStoreInternals.parseSettings({ gradeIntervalsMinutes: { 1: 1, 2: 0, 3: -1, 4: Infinity, 5: 10 } }).gradeIntervalsMinutes).toEqual({ 1: 1 });
    for (const value of [null, [], "x", { 1: "10", 2: 1.5, 3: MAX_GRADE_INTERVAL_MINUTES + 1 }]) {
      expect(DataStoreInternals.parseSettings({ gradeIntervalsMinutes: value }).gradeIntervalsMinutes).toEqual({});
    }
    expect(DataStoreInternals.parseSettings({ gradeIntervalsMinutes: { 4: MAX_GRADE_INTERVAL_MINUTES } }).gradeIntervalsMinutes).toEqual({ 4: MAX_GRADE_INTERVAL_MINUTES });
  });

  it("saves/restores interval settings without rescheduling existing reviews", async () => {
    let disk: unknown = null;
    const storage = { loadData: async () => structuredClone(disk), saveData: async (data: unknown) => { disk = structuredClone(data); } };
    const store = new MiaDataStore(storage);
    await store.load();
    const original = automatic.rate(undefined, Rating.Good, now, "q");
    await store.setReview("q", original);
    await store.updateSettings({ gradeIntervalsMinutes: intervals });
    expect(store.getReview("q")).toEqual(original);
    const reloaded = new MiaDataStore(storage); await reloaded.load();
    expect(reloaded.settings.gradeIntervalsMinutes).toEqual(intervals);
    expect(reloaded.getReview("q")).toEqual(original);
    const service = new FsrsService(reloaded.settings);
    expect(service.rate(original, Rating.Hard, new Date(original.card.due)).card.due).toBe(new Date(Date.parse(original.card.due) + 90 * 60000).toISOString());
    await reloaded.updateSettings({ gradeIntervalsMinutes: {} });
    expect(reloaded.getReview("q")).toEqual(original);
  });
});

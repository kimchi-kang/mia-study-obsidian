import { describe, expect, it } from "vitest";
import { Rating, State } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";

const service = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

describe("FsrsService", () => {
  it("spreads long-term intervals across cards while keeping previews reproducible after restart", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const days = new Set<number>();
    for (let index = 0; index < 40; index += 1) {
      const id = `mia-q-spread-${index}`;
      const preview = service.preview(undefined, now, id).find(item => item.grade === Rating.Easy)!;
      const restored = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
      const rated = restored.rate(undefined, Rating.Easy, now, id);
      expect(rated.card.due).toBe(preview.due.toISOString());
      expect(rated.card.scheduled_days).toBe(preview.scheduledDays);
      expect(rated.card.scheduled_days).toBeGreaterThan(0);
      days.add(preview.scheduledDays);
      const again = restored.preview(undefined, now, id).find(item => item.grade === Rating.Again)!;
      expect(again.due.getTime() - now.getTime()).toBe(60_000);
    }
    expect(days.size).toBeGreaterThan(1);
  });

  it("keeps fuzz within the maximum interval and preserves recall-ordered rating intervals", () => {
    const capped = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 7 });
    const start = new Date("2026-10-17T00:00:00Z");
    for (let index = 0; index < 30; index += 1) {
      const id = `mia-q-cap-${index}`;
      const review = capped.rate(undefined, Rating.Easy, start, id);
      const now = new Date(review.card.due);
      const previews = capped.preview(review, now, id);
      expect(previews.every(item => item.scheduledDays <= 7)).toBe(true);
      expect(previews.map(item => item.due.getTime())).toEqual(previews.map(item => item.due.getTime()).sort((a, b) => a - b));
      for (const item of previews) {
        const rated = capped.rate(review, item.grade, now, id);
        expect(rated.card.due).toBe(item.due.toISOString());
        expect(review.history).toHaveLength(1);
      }
    }
  });

  it("does not describe learning or a fresh lapse as stable memory", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const learning = service.rate(undefined, Rating.Again, now, "q");
    expect(service.isStable(learning, now)).toBe(false);
    const review = service.rate(undefined, Rating.Easy, now, "q");
    expect(service.isStable(review, now)).toBe(true);
    const due = new Date(review.card.due);
    const lapse = service.rate(review, Rating.Again, due, "q");
    expect(lapse.card.state).toBe(State.Relearning);
    expect(service.isStable(lapse, due)).toBe(false);
    expect(service.isStable(review, new Date(due.getTime() + 365 * 86_400_000))).toBe(false);
  });

  it("previews and applies all four FSRS ratings", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const preview = service.preview(undefined, now);
    expect(preview.map((item) => item.grade)).toEqual([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);

    const reviewed = service.rate(undefined, Rating.Good, now);
    expect(reviewed.card.reps).toBe(1);
    expect(reviewed.lastRating).toBe(Rating.Good);
    expect(reviewed.history).toHaveLength(1);
    expect(new Date(reviewed.card.due).getTime()).toBeGreaterThan(now.getTime());
  });

  it("round-trips dates through JSON without changing the next prediction or grade", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const reviewed = service.rate(undefined, Rating.Hard, now);
    const fromJson = JSON.parse(JSON.stringify(reviewed));
    const next = new Date(reviewed.card.due);
    expect(service.preview(fromJson, next)).toEqual(service.preview(reviewed, next));
    expect(service.rate(fromJson, Rating.Good, next)).toEqual(service.rate(reviewed, Rating.Good, next));
  });

  it("does not count new cards as due reviews", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    expect(service.isNew(undefined)).toBe(true);
    expect(service.isDue(undefined, now)).toBe(false);
  });

  it("applies precisely the displayed interval for every grade without mutating previews", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    const original = service.rate(undefined, Rating.Again, now);
    const saved = JSON.stringify(original);
    const next = new Date(original.card.due);
    for (const preview of service.preview(original, next)) {
      const rated = service.rate(original, preview.grade, next);
      expect(rated.card.due).toBe(preview.due.toISOString());
      expect(rated.card.scheduled_days).toBe(preview.scheduledDays);
    }
    expect(JSON.stringify(original)).toBe(saved);
  });

  it("survives repeated restarts through months of reviews and relearning", () => {
    let state = service.rate(undefined, Rating.Easy, new Date("2026-10-15T00:00:00Z"));
    for (let index = 0; index < 40; index += 1) {
      const saved = JSON.stringify(state);
      const prior = JSON.parse(saved);
      const at = new Date(prior.card.due);
      const restored = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
      expect(restored.isDue(prior, new Date(at.getTime() - 1))).toBe(false);
      expect(restored.isDue(prior, at)).toBe(true);
      const grade = index % 7 === 0 ? Rating.Again : Rating.Good;
      state = restored.rate(prior, grade, at);
      expect(state.history).toHaveLength(prior.history.length + 1);
      expect(state.card.reps).toBe(prior.card.reps + 1);
      expect(new Date(state.card.due).getTime()).toBeGreaterThan(at.getTime());
      expect(JSON.stringify(prior)).toBe(saved);
    }
  });
});

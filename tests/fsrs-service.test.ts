import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";

const service = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

describe("FsrsService", () => {
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

  it("round-trips dates through JSON and can undo the last rating", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const reviewed = service.rate(undefined, Rating.Hard, now);
    const fromJson = JSON.parse(JSON.stringify(reviewed));
    const undone = service.undo(fromJson);

    expect(undone).not.toBeNull();
    expect(undone?.history).toHaveLength(0);
    expect(undone?.card.reps).toBe(0);
    expect(undone?.lastRating).toBeNull();
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
      const prior = JSON.parse(JSON.stringify(state));
      const at = new Date(prior.card.due);
      const restored = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
      expect(restored.isDue(prior, new Date(at.getTime() - 1))).toBe(false);
      expect(restored.isDue(prior, at)).toBe(true);
      const grade = index % 7 === 0 ? Rating.Again : Rating.Good;
      state = restored.rate(prior, grade, at);
      expect(state.history).toHaveLength(prior.history.length + 1);
      expect(state.card.reps).toBe(prior.card.reps + 1);
      expect(new Date(state.card.due).getTime()).toBeGreaterThan(at.getTime());
      const undone = restored.undo(state)!;
      expect(undone.card).toEqual(prior.card);
      expect(undone.history).toEqual(prior.history);
    }
  });
});

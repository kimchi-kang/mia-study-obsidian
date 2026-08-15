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
});

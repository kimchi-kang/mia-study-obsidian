import { describe, expect, it } from "vitest";
import { Rating, State } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { planLearningQueue } from "../src/core/learning-queue";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
const start = new Date("2026-10-15T00:00:00Z");
const none = new Set<string>();

describe("Anki-style learning steps within a session", () => {
  it("waits for the scheduled step, then reintroduces the card ahead of new cards", () => {
    const review = fsrs.rate(undefined, Rating.Again, start);
    const due = new Date(review.card.due);
    const before = planLearningQueue(["a", "new"], 1, ["a", "new"], { a: review }, none, new Date(due.getTime() - 1));
    expect(before.queue).toEqual(["a", "new"]);
    expect(before.nextDue).toEqual(due);
    const ready = planLearningQueue(before.queue, 1, ["a", "new"], { a: review }, none, due);
    expect(ready.queue).toEqual(["a", "a", "new"]);
  });

  it("does not declare completion after failing the last card", () => {
    const review = fsrs.rate(undefined, Rating.Again, start);
    const waiting = planLearningQueue(["a"], 1, ["a"], { a: review }, none, start);
    expect(waiting.queue).toEqual(["a"]);
    expect(waiting.nextDue).toEqual(new Date(review.card.due));
    const resumed = planLearningQueue(waiting.queue, 1, ["a"], { a: review }, none, waiting.nextDue!);
    expect(resumed.queue).toEqual(["a", "a"]);
    expect(resumed.nextDue).toBeNull();
  });

  it("accumulates learning attempts until graduation and does not bring long-term reviews forward", () => {
    let review = fsrs.rate(undefined, Rating.Again, start);
    review = JSON.parse(JSON.stringify(review));
    review = fsrs.rate(review, Rating.Good, new Date(review.card.due));
    expect(review.card.state).toBe(State.Learning);
    expect(review.history).toHaveLength(2);
    const waiting = planLearningQueue(["a", "a"], 2, ["a"], { a: review }, none, new Date(review.card.last_review!));
    expect(waiting.nextDue).toEqual(new Date(review.card.due));
    review = fsrs.rate(review, Rating.Good, waiting.nextDue!);
    expect(review.card.state).toBe(State.Review);
    expect(review.card.reps).toBe(3);
    expect(review.history).toHaveLength(3);
    expect(planLearningQueue(["a", "a", "a"], 3, ["a"], { a: review }, none, new Date(review.card.last_review!)))
      .toEqual({ queue: ["a", "a", "a"], nextDue: null });
    const undone = fsrs.undo(review)!;
    expect(undone.card.state).toBe(State.Learning);
    expect(undone.history).toHaveLength(2);
  });

  it("reschedules a lapse in a graduated card as relearning", () => {
    let review = fsrs.rate(undefined, Rating.Easy, start);
    review = fsrs.rate(review, Rating.Again, new Date(review.card.due));
    expect(review.card.state).toBe(State.Relearning);
    const due = new Date(review.card.due);
    expect(planLearningQueue(["a"], 1, ["a"], { a: review }, none, due).queue).toEqual(["a", "a"]);
  });

  it("promotes an already queued learner without duplicating it and respects a skipped card", () => {
    const review = fsrs.rate(undefined, Rating.Again, start);
    const due = new Date(review.card.due);
    expect(planLearningQueue(["a", "new", "a"], 1, ["a", "a"], { a: review }, none, due).queue)
      .toEqual(["a", "a", "new"]);
    expect(planLearningQueue(["a"], 1, ["a"], { a: review }, new Set(["a"]), due))
      .toEqual({ queue: ["a"], nextDue: null });
  });

  it("restores waiting from queue IDs after a restart without session-only state", () => {
    const review = fsrs.rate(undefined, Rating.Good, start);
    const persisted = JSON.parse(JSON.stringify({ queue: ["a"], reviews: { a: review } }));
    expect(planLearningQueue(persisted.queue, 1, persisted.queue, persisted.reviews, none, start).nextDue)
      .toEqual(new Date(review.card.due));
  });

  it("removes a stale repeat when the earlier grade is changed to Easy or postponed", () => {
    const easy = fsrs.rate(undefined, Rating.Easy, start);
    expect(planLearningQueue(["a", "a"], 1, ["a"], { a: easy }, none, start))
      .toEqual({ queue: ["a"], nextDue: null });
    const again = fsrs.rate(undefined, Rating.Again, start);
    expect(planLearningQueue(["a", "a"], 1, ["a"], { a: again }, none, start))
      .toEqual({ queue: ["a"], nextDue: new Date(again.card.due) });
  });
});

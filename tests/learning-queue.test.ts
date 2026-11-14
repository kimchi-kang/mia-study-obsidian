import { describe, expect, it } from "vitest";
import { Rating, State } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { planLearningQueue } from "../src/core/learning-queue";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });
const start = new Date("2026-10-15T00:00:00Z");
const none = new Set<string>();

describe("Anki-style learning steps within a session", () => {
  it.each([State.Learning, State.Relearning])("does not wait for or reinsert an interday card in state %s", (state) => {
    const fixed = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500, gradeIntervalsMinutes: { 1: 1440 } });
    const previous = state === State.Relearning
      ? fixed.rate(undefined, Rating.Easy, new Date(start.getTime() - 30 * 86400000), "a")
      : undefined;
    const review = fixed.rate(previous, Rating.Again, start, "a");
    expect(review.card).toMatchObject({ state, scheduled_days: 1 });
    const completed = { queue: ["a"], nextDue: null };
    const due = new Date(review.card.due);
    expect([start, due].map(now => planLearningQueue(["a"], 1, ["a"], { a: review }, none, now)))
      .toEqual([completed, completed]);
  });

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
    const baseline = structuredClone(review);
    review = fsrs.rate(review, Rating.Good, waiting.nextDue!);
    expect(review.card.state).toBe(State.Review);
    expect(review.card.reps).toBe(3);
    expect(review.history).toHaveLength(3);
    expect(planLearningQueue(["a", "a", "a"], 3, ["a"], { a: review }, none, new Date(review.card.last_review!)))
      .toEqual({ queue: ["a", "a", "a"], nextDue: null });
    const restored = planLearningQueue(["a", "a"], 2, ["a"], { a: baseline }, none, waiting.nextDue!);
    expect(restored.queue).toEqual(["a", "a", "a"]);
    expect(baseline.history).toHaveLength(2);
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

describe("learn ahead only after exhausting other cards", () => {
  const limit = 20 * 60_000;
  const learner = (minutes: number, state = State.Learning) => {
    const review = fsrs.rate(undefined, Rating.Again, start);
    review.card.due = new Date(start.getTime() + minutes * 60_000).toISOString();
    review.card.state = state;
    return review;
  };
  it("does not pull ahead while new/review/currently due cards remain", () => {
    const reviews = { a: learner(19), due: learner(0) };
    for (const id of ["new", "review"]) expect(planLearningQueue(["a", id], 1, ["a", id], reviews, none, start, limit).queue).toEqual(["a", id]);
    expect(planLearningQueue(["a"], 1, ["a", "due"], reviews, none, start, limit).queue).toEqual(["a", "due"]);
  });
  it.each([State.Learning, State.Relearning])("pulls 19 and 20 minute learners in due order, leaves 21 minutes waiting (state %s)", state => {
    const reviews = { late: learner(21, state), boundary: learner(20, state), early: learner(19, state) };
    expect(planLearningQueue(["early"], 1, Object.keys(reviews), reviews, none, start, limit)).toEqual({ queue: ["early", "early", "boundary"], nextDue: new Date(reviews.late.card.due) });
  });
  it("preserves precise waiting with a zero limit", () => {
    const reviews = { a: learner(19) };
    expect(planLearningQueue(["a"], 1, ["a"], reviews, none, start, 0)).toEqual({ queue: ["a"], nextDue: new Date(reviews.a.card.due) });
  });
  it("excludes skipped and interday learners even inside the limit", () => {
    const reviews = { skipped: learner(19), interday: learner(19) };
    reviews.interday.card.scheduled_days = 1;
    expect(planLearningQueue([], 0, Object.keys(reviews), reviews, new Set(["skipped"]), start, limit)).toEqual({ queue: [], nextDue: null });
  });
  it("retains an early learner after refresh and then waits for its new due", () => {
    const reviews = { a: learner(19) };
    const first = planLearningQueue(["a"], 1, ["a"], reviews, none, start, limit);
    expect(planLearningQueue(first.queue, 1, ["a"], reviews, none, start, limit)).toEqual(first);
    reviews.a = learner(21);
    expect(planLearningQueue(first.queue, 2, ["a"], reviews, none, start, limit)).toEqual({ queue: ["a", "a"], nextDue: new Date(reviews.a.card.due) });
  });
});

describe("planLearningQueue keeps skipped questions ahead", () => {
  it("does not drop a skipped question that is still after the current index", () => {
    const plan = planLearningQueue(["a", "b", "c"], 1, ["a", "b", "c"], {}, new Set(["c"]), new Date(), 20 * 60_000);
    expect(plan.queue).toEqual(["a", "b", "c"]);
  });
});

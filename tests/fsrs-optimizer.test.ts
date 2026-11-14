import { describe, it, expect } from "vitest";
import { default_w, State } from "ts-fsrs";
import { optimizeFsrs, evaluateOptimizer, optimizerMemory, reviewsToOptimizerItems, type OptimizerItem, type OptimizerReview } from "../src/core/fsrs-optimizer";
import { validParameters } from "../src/core/study-management";
import { FsrsService } from "../src/core/fsrs-service";

function synthetic(seed = 123, cards = 300): OptimizerItem[] {
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const truth = [...default_w]; truth[8] = 1.8; truth[9] = .3; truth[11] = 1.4;
  const items: OptimizerItem[] = [];
  for (let card = 0; card < cards; card++) {
    let s = 0, d = 0;
    const sequence: OptimizerReview[] = [];
    for (let i = 0; i < 25; i++) {
      const t = i === 0 || i % 7 === 1 ? 0 : Math.max(1, Math.round(s * (.3 + random() * 3)));
      const p = s ? (1 + (Math.pow(.9, -1 / truth[20]!) - 1) * t / s) ** -truth[20]! : 1;
      const rating = !i ? 1 + card % 4 : random() > p ? 1 : random() < .15 ? 2 : random() < .2 ? 4 : 3;
      sequence.push({ rating, deltaT: t });
      if (t > 0) items.push({ reviews: sequence.slice() });
      [s, d] = optimizerMemory(truth, s, d, rating, t);
    }
  }
  return items;
}

const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
describe("optimizer conversion", () => {
  it("uses the 4am study date, sorts records, and retains same-day steps", () => {
    const first = new Date(2026, 9, 15, 3, 59), boundary = new Date(2026, 9, 15, 4);
    let state = fsrs.rate(undefined, 1, first);
    state = fsrs.rate(state, 3, boundary);
    state = fsrs.rate(state, 3, new Date(2026, 9, 15, 12));
    state = fsrs.rate(state, 3, new Date(2026, 9, 16, 4));
    state.history.reverse();
    expect(reviewsToOptimizerItems({ a: state }, 4).map(item => item.reviews.map(r => r.deltaT))).toEqual([[0, 1], [0, 1, 0, 1]]);
  });
  it("excludes partial histories and only uses the last New after a reset", () => {
    let state = fsrs.rate(undefined, 3, new Date(2026, 9, 15, 12));
    state = fsrs.rate(state, 3, new Date(2026, 9, 17, 12));
    const partial = structuredClone(state); partial.history[0]!.state = State.Review;
    expect(reviewsToOptimizerItems({ partial }, 4)).toEqual([]);
    const fresh = fsrs.rate(undefined, 4, new Date(2026, 9, 20, 12));
    const reset = fsrs.rate(fresh, 3, new Date(2026, 9, 22, 12));
    state.history.push(...reset.history);
    expect(reviewsToOptimizerItems({ state }, 4)).toEqual([{ reviews: [{ rating: 4, deltaT: 0 }, { rating: 3, deltaT: 2 }] }]);
    expect(reviewsToOptimizerItems({ cleared: fsrs.createState(new Date()) }, 4)).toEqual([]);
  });
});

describe("pure TypeScript FSRS-6 optimizer", () => {
  it("improves seeded synthetic history and produces valid weights", async () => {
    const result = await optimizeFsrs(synthetic());
    console.log("optimizer loss", result.previous.logLoss, result.optimized.logLoss);
    expect(result.status).toBe("improved");
    expect(result.optimized.logLoss).toBeLessThan(result.previous.logLoss);
    expect(validParameters(result.parameters)).toBe(true);
  }, 60000);
  it("keeps defaults below the binding's eight-target minimum", async () => {
    const result = await optimizeFsrs(synthetic().slice(0, 7));
    expect(result.status).toBe("insufficient"); expect(result.count).toBe(7); expect(result.parameters).toEqual(default_w);
  });
  it("yields progress and aborts without returning partial weights", async () => {
    const controller = new AbortController(); const progress: number[] = [];
    await expect(optimizeFsrs(synthetic(4, 300), default_w, { signal: controller.signal, onProgress: p => { progress.push(p); if (p > 0) controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
    expect(progress[0]).toBe(0); expect(progress.at(-1)).toBeLessThan(100);
  });
  it("stays within 2% of fsrs-rs on the same seeded dataset", async (context) => {
    let binding: typeof import("@open-spaced-repetition/binding");
    try { binding = await import("@open-spaced-repetition/binding"); }
    catch (error) { console.warn("binding unavailable", error); context.skip(); return; }
    const items = synthetic();
    const nativeItems = items.map(item => new binding.FSRSBindingItem(item.reviews.map(r => new binding.FSRSBindingReview(r.rating, r.deltaT))));
    const reference = await binding.computeParameters(nativeItems, { modelVersion: "FSRS-6", enableShortTerm: true });
    const ours = await optimizeFsrs(items);
    const native = new binding.FSRSBinding(reference).evaluate(nativeItems);
    const measured = evaluateOptimizer(items, reference);
    console.log("binding comparison", { ours: ours.optimized.logLoss, binding: native.logLoss, measured, rmse: native.rmseBins });
    // The binding's evaluate() additionally filters/reorders initial-review buckets.
    // Compare both parameter sets on exactly the same raw targets and on its prepared set.
    const nativeOurs = new binding.FSRSBinding(ours.parameters).evaluate(nativeItems);
    expect(evaluateOptimizer(items, ours.parameters).logLoss).toBeLessThanOrEqual(measured.logLoss * 1.02);
    expect(nativeOurs.logLoss).toBeLessThanOrEqual(native.logLoss * 1.02);
    console.log("binding common evaluation", { ours: nativeOurs.logLoss, binding: native.logLoss });
    const repeated = Array.from({ length: 40 }, () => items[0]!);
    const nativeRepeated = repeated.map(item => new binding.FSRSBindingItem(item.reviews.map(r => new binding.FSRSBindingReview(r.rating, r.deltaT))));
    const expected = new binding.FSRSBinding(reference).evaluate(nativeRepeated);
    const actual = evaluateOptimizer(repeated, reference);
    expect(actual.logLoss).toBeCloseTo(expected.logLoss, 5);
    expect(actual.rmseBins).toBeCloseTo(expected.rmseBins, 5);

  }, 60000);
});

// Reference: https://github.com/open-spaced-repetition/fsrs-rs (FSRS-6 training).
// Runtime uses only TypeScript; the Rust oracle is confined to dev tests.
import { default_w, clipParameters, State } from "ts-fsrs";
import type { QuestionReviewState } from "./models";
import { studyDayStart, validParameters } from "./study-management";

export interface OptimizerReview { rating: number; deltaT: number }
export interface OptimizerItem { reviews: OptimizerReview[] }
export interface OptimizerMetrics { logLoss: number; rmseBins: number }
export interface OptimizerResult {
  parameters: number[];
  previous: OptimizerMetrics;
  optimized: OptimizerMetrics;
  count: number;
  status: "improved" | "unchanged" | "insufficient";
}

// Compare civil dates, rather than 24-hour durations, across DST changes.
function studyDate(date: Date, hour: number): number {
  const start = studyDayStart(date, hour);
  return Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) / 86400000;
}

/** Each long-term outcome is a training target, with all preceding same-day steps. */
export function reviewsToOptimizerItems(reviews: Readonly<Record<string, QuestionReviewState>>, dayStartsAt: number): OptimizerItem[] {
  const dated: { item: OptimizerItem; time: number }[] = [];
  for (const state of Object.values(reviews)) {
    const logs = [...state.history].sort((a, b) => Date.parse(a.review) - Date.parse(b.review));
    // removeReview deletes the entire live history. A later New also marks a new start.
    let reset = -1;
    for (let i = 0; i < logs.length; i++) if (logs[i]!.state === State.New) reset = i;
    if (reset < 0) continue;
    const sequence: OptimizerReview[] = [];
    let previousDay = 0;
    for (const log of logs.slice(reset)) {
      const date = new Date(log.review);
      if (!Number.isFinite(date.getTime()) || !Number.isInteger(log.rating) || log.rating < 1 || log.rating > 4) break;
      const day = studyDate(date, dayStartsAt);
      const deltaT = sequence.length ? day - previousDay : 0;
      sequence.push({ rating: log.rating, deltaT });
      previousDay = day;
      if (deltaT > 0) dated.push({ item: { reviews: sequence.slice() }, time: date.getTime() });
    }
  }
  return dated.sort((a, b) => a.time - b.time).map(entry => entry.item);
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** FSRS-6 equations without scheduling/fuzz/rounding; matches fsrs-rs inference. */
export function optimizerMemory(w: readonly number[], s: number, d: number, rating: number, t: number): [number, number] {
  if (s === 0) return [w[rating - 1]!, clamp(w[4]! - Math.exp(w[5]! * (rating - 1)) + 1, 1, 10)];
  const r = retrievability(w, s, t);
  let next: number;
  if (t === 0) {
    const growth = Math.exp(w[17]! * (rating - 3 + w[18]!)) * s ** -w[19]!;
    next = s * (rating >= 2 ? Math.max(1, growth) : growth);
  } else if (rating === 1) {
    next = Math.min(w[11]! * d ** -w[12]! * ((s + 1) ** w[13]! - 1) * Math.exp(w[14]! * (1 - r)), s / Math.exp(w[17]! * w[18]!));
  } else {
    next = s * (1 + Math.exp(w[8]!) * (11 - d) * s ** -w[9]! * Math.expm1(w[10]! * (1 - r)) * (rating === 2 ? w[15]! : 1) * (rating === 4 ? w[16]! : 1));
  }
  const initialEasy = w[4]! - Math.exp(3 * w[5]!) + 1;
  return [clamp(next, .001, 36500), clamp(w[7]! * initialEasy + (1 - w[7]!) * (d - w[6]! * (rating - 3) * (10 - d) / 9), 1, 10)];
}
function retrievability(w: readonly number[], s: number, t: number): number {
  return (1 + Math.expm1(-Math.log(.9) / w[20]!) * t / s) ** -w[20]!;
}

interface Node { parent: number; rating: number; deltaT: number; targets: number; weight: number; longTerm: number; lapses: number }
interface Bin { predicted: number; actual: number; count: number; weight: number }
const recencyWeight = (index: number, total: number) => .25 + .75 * (index / Math.max(1, total - 1)) ** 3;
function binKey(node: Node, nodes: readonly Node[]): string {
  const bucket = (value: number, base: number, factor: number) => Math.round(factor * base ** Math.floor(Math.log(value) / Math.log(base)));
  const priorLapses = node.parent < 0 ? 0 : nodes[node.parent]!.lapses;
  return `${bucket(node.deltaT, 3.62, 248)}:${bucket(node.longTerm + 1, 1.89, 1.99)}:${priorLapses ? bucket(priorLapses, 1.73, 1.65) : 0}`;
}
/** Share history prefixes so numerical differentiation remains practical on mobile. */
function compile(items: readonly OptimizerItem[], offset = 0, total = items.length): Node[] {
  const nodes: Node[] = [];
  const keys = new Map<string, number>();
  for (const [itemIndex, item] of items.entries()) {
    let parent = -1;
    for (const review of item.reviews) {
      const key = `${parent}:${review.rating}:${review.deltaT}`;
      let index = keys.get(key);
      if (index === undefined) {
        index = nodes.length; keys.set(key, index);
        const prior = nodes[parent];
        nodes.push({ parent, ...review, targets: 0, weight: 0,
          longTerm: (prior?.longTerm ?? 0) + (review.deltaT > 0 ? 1 : 0),
          lapses: (prior?.lapses ?? 0) + (review.deltaT > 0 && review.rating === 1 ? 1 : 0) });
      }
      parent = index;
    }
    if (parent >= 0) { nodes[parent]!.targets++; nodes[parent]!.weight += recencyWeight(offset + itemIndex, total); }
  }
  return nodes;
}

function measure(nodes: readonly Node[], w: readonly number[], bins?: Map<string, Bin>): number {
  const stability = new Float64Array(nodes.length), difficulty = new Float64Array(nodes.length);
  let loss = 0, count = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const s = node.parent < 0 ? 0 : stability[node.parent]!;
    const d = node.parent < 0 ? 0 : difficulty[node.parent]!;
    if (node.targets && s > 0 && node.deltaT > 0) {
      const p = clamp(retrievability(w, s, node.deltaT), .0001, .9999), y = node.rating > 1 ? 1 : 0;
      loss -= node.weight * (y * Math.log(p) + (1 - y) * Math.log1p(-p));
      count += node.weight;
      if (bins) {
        const key = binKey(node, nodes);
        const bin = bins.get(key) ?? { predicted: 0, actual: 0, count: 0, weight: 0 };
        bin.predicted += p * node.targets; bin.actual += y * node.targets; bin.count += node.targets; bin.weight += node.weight;
        bins.set(key, bin);
      }
    }
    [stability[i], difficulty[i]] = optimizerMemory(w, s, d, node.rating, node.deltaT);
  }
  return count ? loss / count : 0;
}
export function evaluateOptimizer(items: readonly OptimizerItem[], parameters: readonly number[] = default_w): OptimizerMetrics {
  const bins = new Map<string, Bin>();
  const logLoss = measure(compile(items), parameters, bins);
  let squared = 0, count = 0;
  for (const bin of bins.values()) { squared += (bin.predicted / bin.count - bin.actual / bin.count) ** 2 * bin.weight; count += bin.weight; }
  return { logLoss, rmseBins: count ? Math.sqrt(squared / count) : 0 };
}

// fsrs-rs dataset.rs: discard sparse/long first-review buckets and the rarest 5%
// (at least 20 targets), then exclude the corresponding card prefixes.
function trainingItems(items: readonly OptimizerItem[]): OptimizerItem[] {
  const buckets = new Map<string, { rating: number; delta: number; items: OptimizerItem[] }>();
  const totals = Array<number>(5).fill(0), removed = Array<number>(5).fill(0);
  for (const item of items) {
    const longTerm = item.reviews.filter(r => r.deltaT > 0);
    if (longTerm.length !== 1) continue;
    const rating = item.reviews[0]!.rating, delta = longTerm[0]!.deltaT;
    const key = `${rating}:${delta}`;
    const bucket = buckets.get(key) ?? { rating, delta, items: [] };
    bucket.items.push(item); buckets.set(key, bucket); totals[rating] = totals[rating]! + 1;
  }
  const excluded = new Set<string>();
  for (const b of [...buckets.values()].sort((a, b) => a.rating - b.rating || a.items.length - b.items.length || a.delta - b.delta)) {
    if (removed[b.rating]! + b.items.length < Math.max(20, Math.floor(totals[b.rating]! / 20))) {
      removed[b.rating] = removed[b.rating]! + b.items.length;
      excluded.add(`${b.rating}:${b.delta}`);
    } else if (b.items.length < 6 || b.delta > (b.rating === 4 ? 365 : 100)) excluded.add(`${b.rating}:${b.delta}`);
  }
  return items.filter(item => !excluded.has(`${item.reviews[0]!.rating}:${item.reviews.find(r => r.deltaT > 0)!.deltaT}`));
}

/** fsrs-rs smooth_and_fill: monotone ratings, log interpolation, default scaling. */
function smoothInitial(w: number[], counts: readonly number[]): void {
  const known = [0, 1, 2, 3].filter(i => counts[i]! > 0);
  if (!known.length) return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of known) for (const b of known) {
      if (a >= b || w[a]! <= w[b]!) continue;
      if (counts[a]! > counts[b]!) w[b] = w[a]!; else w[a] = w[b]!;
      changed = true;
    }
  }
  if (known.length === 1) {
    const k = known[0]!, factor = w[k]! / default_w[k]!;
    for (let i = 0; i < 4; i++) w[i] = clamp(default_w[i]! * factor, .001, 100);
    return;
  }
  const positions = [0, .59, 1, (1 - .46 * .59) / .54];
  for (let i = 0; i < 4; i++) {
    if (known.includes(i)) continue;
    const closest = [...known].sort((a, b) => Math.abs(a - i) - Math.abs(b - i));
    const a = closest[0]!, b = closest[1]!;
    const fraction = (positions[i]! - positions[a]!) / (positions[b]! - positions[a]!);
    w[i] = Math.exp(Math.log(w[a]!) * (1 - fraction) + Math.log(w[b]!) * fraction);
  }
  for (let i = 0; i < 4; i++) w[i] = clamp(w[i]!, .001, 100);
}

/** Pre-train w0–w3 on the first long-term outcomes (BCE + fsrs-rs L1 prior). */
function pretrain(items: readonly OptimizerItem[]): number[] {
  const w = [...default_w];
  const initial = items.filter(item => item.reviews.filter(r => r.deltaT > 0).length === 1);
  const average = items.filter(item => item.reviews.at(-1)!.rating > 1).length / items.length;
  for (let rating = 1; rating <= 4; rating++) {
    const buckets = new Map<number, { recalled: number; count: number }>();
    for (const item of initial) {
      if (item.reviews[0]!.rating !== rating) continue;
      const last = item.reviews.at(-1)!;
      const bucket = buckets.get(last.deltaT) ?? { recalled: 0, count: 0 };
      bucket.count++; bucket.recalled += last.rating > 1 ? 1 : 0; buckets.set(last.deltaT, bucket);
    }
    if (!buckets.size) continue;
    const objective = (s: number) => {
      let loss = Math.abs(s - default_w[rating - 1]!) / 16;
      for (const [t, b] of buckets) {
        const p = clamp(retrievability(default_w, s, t), .0001, .9999), y = (b.recalled + average) / (b.count + 1);
        loss -= b.count * (y * Math.log(p) + (1 - y) * Math.log1p(-p));
      }
      return loss;
    };
    let low = .001, high = 100;
    for (let i = 0; i < 80; i++) {
      const left = low + (high - low) / 3, right = high - (high - low) / 3;
      if (objective(left) < objective(right)) high = right; else low = left;
    }
    w[rating - 1] = (low + high) / 2;
  }
  smoothInitial(w, [1, 2, 3, 4].map(rating => initial.filter(item => item.reviews[0]!.rating === rating).length));
  return clipParameters(w, 1);
}

export interface OptimizerOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  numRelearningSteps?: number;
}
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("최적화를 취소했습니다.", "AbortError");
}

/** Pure TS, central-difference gradients + Adam. FSRS-6 defaults: 5 epochs, 512, lr .04. */
export async function optimizeFsrs(items: readonly OptimizerItem[], previous: readonly number[] = default_w, options: OptimizerOptions = {}): Promise<OptimizerResult> {
  checkCancelled(options.signal);
  options.onProgress?.(0);
  await yieldToUI();
  checkCancelled(options.signal);
  const usable = trainingItems(items.filter(item => item.reviews.length > 1 && item.reviews.length <= 256 && item.reviews.at(-1)!.deltaT > 0));
  const baseline = evaluateOptimizer(usable, previous.length ? previous : default_w);
  const result = (parameters: number[], status: OptimizerResult["status"]): OptimizerResult => ({ parameters, status, previous: baseline, optimized: evaluateOptimizer(usable, parameters), count: items.length });
  // fsrs-rs initialize_fsrs6_training returns defaults below eight long-term targets.
  if (usable.length < 8) { options.onProgress?.(100); return result([...default_w], "insufficient"); }
  let w = clipParameters(pretrain(usable), options.numRelearningSteps ?? 1);
  const initial = [...w];
  const stddev = [6.43, 9.66, 17.58, 27.85, .57, .28, .6, .12, .39, .18, .33, .3, .09, .16, .57, .25, 1.03, .31, .32, .14, .27];
  let best = [...w], bestLoss = evaluateOptimizer(usable, w).logLoss;
  const allNodes = compile(usable);
  const batches = Array.from({ length: Math.ceil(usable.length / 512) }, (_, i) => compile(usable.slice(i * 512, (i + 1) * 512), i * 512, usable.length));
  const m = Array<number>(21).fill(0), v = Array<number>(21).fill(0);
  let step = 0, seed = 2023;
  // As in fsrs-rs, 8–63 targets only pre-train the initial stabilities.
  const epochs = usable.length < 64 ? 0 : 5;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = batches.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1); [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const index of order) {
      checkCancelled(options.signal);
      const nodes = batches[index]!;
      const gradient: number[] = [];
      for (let k = 0; k < 21; k++) {
        const original = w[k]!, epsilon = 1e-4 * Math.max(1, Math.abs(original));
        w[k] = original + epsilon; const above = measure(nodes, w);
        w[k] = original - epsilon; const below = measure(nodes, w);
        w[k] = original;
        gradient.push((above - below) / (2 * epsilon));
        // Bound uninterrupted work even for unusually long histories.
        if (k % 4 === 3) { await yieldToUI(); checkCancelled(options.signal); }
      }
      step++;
      const batchWeight = nodes.reduce((sum, node) => sum + node.weight, 0);
      const batchCount = nodes.reduce((sum, node) => sum + node.targets, 0);
      const lr = .04 * (1 + Math.cos(Math.PI * step / ((Math.floor(usable.length / 512) + 1) * 5))) / 2;
      for (let k = 0; k < 21; k++) {
        const g = gradient[k]! * batchWeight + (w[k]! - initial[k]!) * batchCount / (stddev[k]! ** 2 * usable.length);
        m[k] = .7 * m[k]! + .3 * g; v[k] = .98 * v[k]! + .02 * g * g;
        w[k] = w[k]! - lr * (m[k]! / (1 - .7 ** step)) / (Math.sqrt(v[k]! / (1 - .98 ** step)) + 1e-8);
      }
      w = clipParameters(w, options.numRelearningSteps ?? 1);
      options.onProgress?.(Math.round(step / (epochs * batches.length) * 100));
      await yieldToUI();
    }
    const loss = measure(allNodes, w);
    if (loss < bestLoss) { best = [...w]; bestLoss = loss; }
  }
  checkCancelled(options.signal);
  options.onProgress?.(100);
  if (!validParameters(best)) throw new Error("최적화한 FSRS 매개변수가 유효하지 않습니다.");
  return result(best, bestLoss < baseline.logLoss ? "improved" : "unchanged");
}

import { MiaPluginData, QuestionReviewState } from "./models";

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function version(data: MiaPluginData, id: string): string {
  return data.reviewVersions[id] ?? `${data.reviews[id]?.card.last_review ?? "1970-01-01T00:00:00.000Z"}:`;
}
function isPrefix(left: QuestionReviewState, right: QuestionReviewState): boolean {
  return left.history.length <= right.history.length && left.history.every((entry, i) => same(entry, right.history[i]));
}

/** Last edit wins per question; divergent histories remain recoverable, never concatenated into FSRS. */
export function mergeReviewData(local: MiaPluginData, incoming: MiaPluginData): MiaPluginData {
  const next = structuredClone(incoming);
  next.quarantinedReviews = { ...local.quarantinedReviews, ...incoming.quarantinedReviews };
  const ids = new Set([...Object.keys(local.reviews), ...Object.keys(incoming.reviews), ...Object.keys(local.reviewVersions), ...Object.keys(incoming.reviewVersions)]);
  for (const id of ids) {
    const localVersion = version(local, id), remoteVersion = version(incoming, id);
    const localWins = localVersion > remoteVersion;
    const winner = localWins ? local : incoming;
    const state = winner.reviews[id];
    if (state) { next.reviews[id] = structuredClone(state); delete next.quarantinedReviews[id]; }
    else delete next.reviews[id];
    const revision = winner.reviewVersions[id];
    if (revision) next.reviewVersions[id] = revision;
    const alternatives = [...(local.reviewConflicts[id] ?? []), ...(incoming.reviewConflicts[id] ?? [])];
    const left = local.reviews[id], right = incoming.reviews[id];
    if (left && right && !same(left, right) && !isPrefix(left, right) && !isPrefix(right, left)) alternatives.push(localWins ? right : left);
    const unique = new Map(alternatives.map(review => [JSON.stringify(review), review]));
    if (unique.size) next.reviewConflicts[id] = [...unique.keys()].sort().map(key => structuredClone(unique.get(key)!));
  }
  return next;
}

export function nextReviewVersion(versions: Record<string, string>): string {
  const latest = Math.max(0, ...Object.values(versions).map(value => Date.parse(value.slice(0, 24))).filter(Number.isFinite));
  return `${new Date(Math.max(Date.now(), latest + 1)).toISOString()}:${crypto.randomUUID()}`;
}

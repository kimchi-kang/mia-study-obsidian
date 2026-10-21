import { MiaPluginData, QuestionReviewState } from "./models";

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function version(data: MiaPluginData, id: string): string {
  return data.reviewVersions[id] ?? `${data.reviews[id]?.card.last_review ?? "1970-01-01T00:00:00.000Z"}:`;
}
function isPrefix(left: QuestionReviewState, right: QuestionReviewState): boolean {
  return left.history.length <= right.history.length && left.history.every((entry, i) => same(entry, right.history[i]));
}

function prefersLocal(local: MiaPluginData, incoming: MiaPluginData, id: string, leftKey: string, rightKey: string): boolean {
  const left = local.reviews[id], right = incoming.reviews[id];
  const leftCorrupt = !left && Object.hasOwn(local.quarantinedReviews, id);
  const rightCorrupt = !right && Object.hasOwn(incoming.quarantinedReviews, id);
  if (leftCorrupt !== rightCorrupt) return rightCorrupt;
  const localVersion = version(local, id), remoteVersion = version(incoming, id);
  if (localVersion !== remoteVersion) return localVersion > remoteVersion;
  // An explicit deletion wins a tie; an empty new installation is not a deletion.
  if (!left && local.reviewVersions[id]) return true;
  if (!right && incoming.reviewVersions[id]) return false;
  return leftKey > rightKey;
}

/** Last edit wins per question; divergent histories remain recoverable, never concatenated into FSRS. */
export function mergeReviewData(local: MiaPluginData, incoming: MiaPluginData): MiaPluginData {
  return merge(local, incoming, false);
}

/** Consumes a freshly parsed, exclusively owned incoming buffer; local stays unchanged. */
export function mergeIntoOwnedIncoming(local: MiaPluginData, incoming: MiaPluginData): MiaPluginData {
  return merge(local, incoming, true);
}

function merge(local: MiaPluginData, incoming: MiaPluginData, consume: boolean): MiaPluginData {
  for (const [id, original] of Object.entries(local.quarantinedReviews)) {
    if (Object.hasOwn(incoming.quarantinedReviews, id) && !same(original, incoming.quarantinedReviews[id])) {
      throw new Error("같은 문제의 격리 원본이 서로 달라 병합을 중단했습니다. 양쪽 원본을 백업한 뒤 확인하세요.");
    }
  }
  const quarantine = { ...local.quarantinedReviews, ...incoming.quarantinedReviews };
  const next = consume ? incoming : structuredClone(incoming);
  const ids = new Set([...Object.keys(local.reviews), ...Object.keys(incoming.reviews), ...Object.keys(local.reviewVersions), ...Object.keys(incoming.reviewVersions), ...Object.keys(local.reviewConflicts), ...Object.keys(incoming.reviewConflicts)]);
  for (const id of ids) {
    const left = local.reviews[id], right = incoming.reviews[id];
    const leftKey = left ? JSON.stringify(left) : "";
    const rightKey = right ? JSON.stringify(right) : "";
    const localWins = prefersLocal(local, incoming, id, leftKey, rightKey);
    const winner = localWins ? local : incoming;
    const state = winner.reviews[id];
    if (state && localWins) next.reviews[id] = structuredClone(state);
    else if (!state) delete next.reviews[id];
    const revision = winner.reviewVersions[id];
    if (revision) next.reviewVersions[id] = revision;
    else delete next.reviewVersions[id];
    const alternatives = [...(local.reviewConflicts[id] ?? []), ...(incoming.reviewConflicts[id] ?? [])];
    if (left && right && leftKey !== rightKey) {
      const leftPrefix = isPrefix(left, right);
      const equalLength = left.history.length === right.history.length;
      const rightPrefix = equalLength ? leftPrefix : isPrefix(right, left);
      if ((!leftPrefix && !rightPrefix) || (equalLength && leftPrefix)) alternatives.push(localWins ? right : left);
    }
    const unique = new Map(alternatives.map(review => [JSON.stringify(review), review]));
    if (unique.size) next.reviewConflicts[id] = [...unique.keys()].sort().map(key => structuredClone(unique.get(key)!));
  }
  next.quarantinedReviews = quarantine;
  return next;
}

export function nextReviewVersion(versions: Record<string, string>): string {
  const latest = Math.max(0, ...Object.values(versions).map(value => Date.parse(value.slice(0, 24))).filter(Number.isFinite));
  return `${new Date(Math.max(Date.now(), latest + 1)).toISOString()}:${crypto.randomUUID()}`;
}

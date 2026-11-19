import type { MiaPluginData, QuestionReviewState } from "./models";

// Legacy review archives have no edit ID. Fingerprint their normalized content
// with FNV-1a 128 so a dismissal can travel without retaining the removed history.
function fingerprint(text: string): string {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(text)) {
    hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
  }
  return hash.toString(16).padStart(32, "0");
}

export function reviewConflictKey(id: string, review: QuestionReviewState): string {
  const content = JSON.stringify([id, review], (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return Object.fromEntries(entries);
  });
  return `review:${fingerprint(content)}`;
}

export function settingsConflictKey(id: string): string {
  // A legacy settings ID encodes the full settings value.
  return `settings:${fingerprint(id)}`;
}

export function mergeConflictDismissals(local: MiaPluginData, incoming: MiaPluginData): Record<string, string> | undefined {
  if (!local.conflictDismissals && !incoming.conflictDismissals) return;
  const dismissals = { ...incoming.conflictDismissals };
  for (const [key, revision] of Object.entries(local.conflictDismissals ?? {})) {
    if (revision > (dismissals[key] ?? "")) dismissals[key] = revision;
  }
  return Object.fromEntries(Object.keys(dismissals).sort().map(key => [key, dismissals[key]!]));
}

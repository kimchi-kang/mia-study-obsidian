import { KeywordReference } from "./models";

function normalizeTarget(value: string): string {
  return value
    .split("#")[0]
    ?.replaceAll("\\", "/")
    .replace(/\.md$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .trim()
    .toLocaleLowerCase("ko") ?? "";
}

export function keywordReferenceMatches(reference: KeywordReference, targets: readonly string[]): boolean {
  const key = normalizeTarget(reference.target);
  return targets.some((target) => normalizeTarget(target) === key);
}

export function renameKeywordReferences(
  references: readonly KeywordReference[],
  targets: readonly string[],
  nextTarget: string,
  nextLabel: string,
): KeywordReference[] {
  return references.map((reference) => keywordReferenceMatches(reference, targets)
    ? { target: nextTarget, label: nextLabel, raw: `[[${nextTarget}|${nextLabel}]]` }
    : reference);
}

export function removeKeywordReferences(
  references: readonly KeywordReference[],
  targets: readonly string[],
): KeywordReference[] {
  return references.filter((reference) => !keywordReferenceMatches(reference, targets));
}

export const KeywordReferenceInternals = { normalizeTarget };

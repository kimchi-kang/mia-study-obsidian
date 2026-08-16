import { QuestionRecord } from "./models";

export const MAX_FOLLOW_UPS = 50;

type RegisteredQuestion = QuestionRecord & { id: string };

export function normalizeFollowUpIds(baseId: string, ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id && id !== baseId))].slice(0, MAX_FOLLOW_UPS);
}

export function questionBlockLink(question: RegisteredQuestion): string {
  const path = question.filePath.replace(/\.md$/i, "");
  return `[[${path}#^${question.id}|${question.heading}]]`;
}

export function planFollowUpChanges(
  base: RegisteredQuestion,
  selectedIds: readonly string[],
  questions: readonly RegisteredQuestion[],
  bidirectional: boolean,
): Map<string, string[]> {
  const selected = normalizeFollowUpIds(base.id, selectedIds);
  const changes = new Map<string, string[]>([[base.id, selected]]);
  if (!bidirectional) return changes;

  const previous = new Set(base.followUpIds);
  const next = new Set(selected);
  for (const question of questions) {
    if (question.id === base.id) continue;
    if (!previous.has(question.id) && !next.has(question.id)) continue;
    const linked = new Set(question.followUpIds);
    if (next.has(question.id)) linked.add(base.id);
    else linked.delete(base.id);
    changes.set(question.id, normalizeFollowUpIds(question.id, [...linked]));
  }
  return changes;
}

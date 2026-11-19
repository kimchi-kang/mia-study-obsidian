import { QuestionRecord } from "./models";

export const MAX_FOLLOW_UPS = 50;

type RegisteredQuestion = QuestionRecord & { id: string };

/** Raw block links and their offsets, shared by the parser and automatic updates. */
export function* followUpBlockLinks(value: string) {
  for (const match of value.matchAll(/\[\[((?:(?!\[\[|\]\]|\|).)+)(?:\|.*?)?\]\]/g)) {
    const id = match[1]?.trim().match(/#\^(mia-q-[A-Za-z0-9-]+)$/)?.[1];
    if (id) yield { id, raw: match[0], offset: match.index };
  }
}

export function normalizeFollowUpIds(baseId: string, ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id && id !== baseId))].slice(0, MAX_FOLLOW_UPS);
}

export function questionBlockLink(question: RegisteredQuestion): string {
  const path = question.filePath.replace(/\.md$/i, "");
  const heading = question.heading;
  const alias = heading.includes("|") || heading.includes("]]") || heading.endsWith("]") ? "" : `|${heading}`;
  return `[[${path}#^${question.id}${alias}]]`;
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

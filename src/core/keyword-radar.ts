import { Rating } from "ts-fsrs";
import type { FsrsService } from "./fsrs-service";
import type { KeywordReference, QuestionRecord, QuestionReviewState } from "./models";
import { hasWeakRating } from "./question-query";

type RegisteredQuestion = QuestionRecord & { id: string };

/** The keyword page groups note links by the normalized target basename. */
export function keywordKey(keyword: KeywordReference): string {
  const path = keyword.target.split("#")[0]?.replace(/\.md$/i, "").replaceAll("\\", "/") ?? keyword.label;
  return (path.split("/").at(-1) ?? path).trim().toLocaleLowerCase("ko");
}

export function groupKeywordQuestions(questions: readonly RegisteredQuestion[]) {
  const groups = new Map<string, {
    keyword: KeywordReference;
    questions: Map<string, { question: RegisteredQuestion; core: boolean; sub: boolean }>;
  }>();
  for (const question of questions) {
    for (const [kind, references] of [["core", question.coreKeywords], ["sub", question.subKeywords]] as const) {
      for (const keyword of references) {
        const key = keywordKey(keyword);
        const group = groups.get(key) ?? { keyword, questions: new Map() };
        const link = group.questions.get(question.id) ?? { question, core: false, sub: false };
        link[kind] = true;
        group.questions.set(question.id, link);
        groups.set(key, group);
      }
    }
  }
  return groups;
}

export interface KeywordWeakness {
  key: string;
  label: string;
  total: number;
  studied: number;
  averageRecall: number;
  lapses: number;
  again: number;
  hard: number;
  score: number;
  questionIds: string[];
}

export function rankKeywordWeakness(
  groups: ReturnType<typeof groupKeywordQuestions>,
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrs: FsrsService,
  noteNames: ReadonlyMap<string, string>,
  now = new Date(),
): KeywordWeakness[] {
  const recalls = new Map<string, number | null>();
  const ranked: KeywordWeakness[] = [];
  for (const [key, group] of groups) {
    let studied = 0, totalRecall = 0, weightedDeficit = 0, weightSum = 0, lapses = 0, again = 0, hard = 0;
    const links: Array<{ id: string; recall: number | null }> = [];
    for (const [id, link] of group.questions) {
      const review = reviews[id];
      if (!recalls.has(id)) recalls.set(id, fsrs.retrievability(review, now));
      const recall = recalls.get(id) ?? null;
      links.push({ id, recall });
      if (recall === null || !review) continue;
      const weight = link.core ? 1.2 : 1;
      studied += 1;
      weightSum += weight;
      totalRecall += recall;
      weightedDeficit += (1 - recall) * weight;
      lapses += review.card.lapses;
      if (hasWeakRating(review)) {
        if (review.lastRating === Rating.Again) again += 1;
        else hard += 1;
      }
    }
    if (!studied) continue;
    // A square-root divisor lets broader evidence count without letting large
    // groups dominate. Core links carry 20% more weight in the recall deficit.
    // A logarithm keeps a long lapse history from swamping current recall.
    const score = weightedDeficit / Math.sqrt(weightSum) + 0.1 * Math.log1p(lapses);
    links.sort((a, b) => (a.recall ?? Infinity) - (b.recall ?? Infinity) || a.id.localeCompare(b.id));
    ranked.push({ key, label: noteNames.get(key) ?? group.keyword.label, total: links.length, studied,
      averageRecall: totalRecall / studied, lapses, again, hard, score, questionIds: links.map(link => link.id) });
  }
  return ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "ko") || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

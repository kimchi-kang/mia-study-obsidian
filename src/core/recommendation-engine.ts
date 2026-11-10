import { orderManagedQueue, type DailyLimitReason } from "./study-management";
import type { StudyManagementSettings } from "./models";
import { Rating } from "ts-fsrs";
import { FsrsService } from "./fsrs-service";
import { QUESTION_TYPES, QuestionRecord, QuestionReviewState } from "./models";

export interface QuestionRecommendation {
  question: QuestionRecord;
  score: number;
  reasons: string[];
}

const COMMON_KEYWORDS = new Set(["전압", "전류", "저항", "회로", "신호", "함수", "시스템", "시간", "주파수"]);

function normalizeKeyword(target: string): string {
  const path = target
    .split("#")[0]
    ?.replace(/\.md$/i, "")
    .replaceAll("\\", "/")
    .trim() ?? "";
  return (path.split("/").at(-1) ?? path).trim().toLocaleLowerCase("ko");
}

function keywordSet(question: QuestionRecord, kind: "core" | "sub"): Set<string> {
  const values = kind === "core" ? question.coreKeywords : question.subKeywords;
  return new Set(values
    .map((item) => normalizeKeyword(item.target))
    .filter((keyword) => Boolean(keyword) && !COMMON_KEYWORDS.has(keyword)));
}

export function recommendQuestions(
  base: QuestionRecord,
  questions: QuestionRecord[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrsService: FsrsService,
  options: { limit?: number; now?: Date } = {},
): QuestionRecommendation[] {
  const limit = options.limit ?? 5;
  const now = options.now ?? new Date();
  const baseCore = keywordSet(base, "core");
  const baseSub = keywordSet(base, "sub");
  const baseTypeIndex = QUESTION_TYPES.indexOf(base.questionType);

  return questions
    .filter((candidate) => candidate.id && candidate.id !== base.id)
    .map((candidate): QuestionRecommendation | null => {
      const candidateCore = keywordSet(candidate, "core");
      const candidateSub = keywordSet(candidate, "sub");
      const direct = candidate.id ? base.followUpIds.includes(candidate.id) : false;
      let score = direct ? 1000 : 0;
      const reasons: string[] = direct ? ["직접 연결"] : [];

      const coreMatches = [...candidateCore].filter((keyword) => baseCore.has(keyword));
      const subMatches = [...candidateSub].filter((keyword) => baseSub.has(keyword) || baseCore.has(keyword));
      if (coreMatches.length) {
        score += coreMatches.length * 5;
        reasons.push(`핵심 키워드 ${coreMatches.length}개 일치`);
      }
      if (subMatches.length) {
        score += subMatches.length * 2;
        reasons.push(`보조 키워드 ${subMatches.length}개 일치`);
      }
      if (!direct && coreMatches.length === 0 && subMatches.length === 0) return null;

      if (candidate.subject === base.subject) {
        score += 2;
        reasons.push("같은 과목");
      }
      const candidateTypeIndex = QUESTION_TYPES.indexOf(candidate.questionType);
      if (candidateTypeIndex === baseTypeIndex + 1) {
        score += 1;
        reasons.push(`${candidate.questionType} 흐름`);
      }

      const review = candidate.id ? reviews[candidate.id] : undefined;
      if (review?.lastRating === Rating.Again) {
        score += 1;
        reasons.push("최근 못암기");
      } else if (review?.lastRating === Rating.Hard) {
        score += 0.5;
        reasons.push("최근 애매");
      }
      if (fsrsService.isDue(review, now)) {
        reasons.push("복습 기한 경과");
      }

      return direct || score >= 5 ? { question: candidate, score, reasons } : null;
    })
    .filter((item): item is QuestionRecommendation => item !== null)
    .sort((left, right) => right.score - left.score || left.question.heading.localeCompare(right.question.heading, "ko"))
    .slice(0, limit);
}

export interface ReviewQueueOptions {
  now?: Date;
  random?: () => number;
  management?: StudyManagementSettings;
  includeFuture?: boolean;
}

type RegisteredQuestion = QuestionRecord & { id: string };
export type ReviewQueueExclusion = { id: string; reason: DailyLimitReason | "missing" }
  | { id: string; reason: "not-due"; nextDue: Date };

function shuffle<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [items[index], items[target]] = [items[target]!, items[index]!];
  }
}

export function buildReviewQueue(
  questions: QuestionRecord[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrsService: FsrsService,
  options: ReviewQueueOptions = {},
  onExcluded?: (exclusion: ReviewQueueExclusion) => void,
): RegisteredQuestion[] {
  const now = options.now ?? new Date();
  const registered = questions.filter((question): question is RegisteredQuestion => Boolean(question.id));
  if (options.includeFuture && !options.management) {
    if (options.random) shuffle(registered, options.random);
    return registered;
  }
  const due: RegisteredQuestion[] = [], fresh: RegisteredQuestion[] = [];
  for (const question of registered) {
    const review = reviews[question.id];
    if (fsrsService.isDue(review, now)) due.push(question);
    else if (fsrsService.isNew(review)) fresh.push(question);
    else if (review) onExcluded?.({ id: question.id, reason: "not-due", nextDue: fsrsService.nextReviewAt(review) });
  }
  due.sort((left, right) => fsrsService.compareDue(reviews[left.id], reviews[right.id], now)
    || left.heading.localeCompare(right.heading, "ko"));
  if (options.management) {
    return orderManagedQueue(due, fresh, reviews, options.management, now, options.random ?? Math.random,
      (left, right) => fsrsService.compareDue(reviews[left], reviews[right], now),
      onExcluded && ((id, reason) => onExcluded({ id, reason })));
  }
  if (options.random) {
    // Shuffle each eligibility group once; future reviews never enter either group.
    for (const group of [due, fresh]) shuffle(group, options.random);
  }
  return [...due, ...fresh];
}

export function planSelectedReview(
  questions: QuestionRecord[], ids: Iterable<string>, reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrsService: FsrsService, options: ReviewQueueOptions,
): { queue: RegisteredQuestion[]; exclusions: ReviewQueueExclusion[] } {
  const requested = new Set(ids);
  const scope = questions.filter(question => question.id && requested.has(question.id));
  const found = new Set(scope.map(question => question.id));
  const exclusions: ReviewQueueExclusion[] = [];
  const queue = buildReviewQueue(scope, reviews, fsrsService, options, exclusion => exclusions.push(exclusion));
  for (const id of requested) if (!found.has(id)) exclusions.push({ id, reason: "missing" });
  return { queue, exclusions };
}

export const RecommendationInternals = { normalizeKeyword };

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

function daysOverdue(review: QuestionReviewState | undefined, now: Date): number {
  if (!review) return 0;
  const due = new Date(review.card.due).getTime();
  if (!Number.isFinite(due) || due >= now.getTime()) return 0;
  return (now.getTime() - due) / 86_400_000;
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
      if (candidateTypeIndex > baseTypeIndex && candidateTypeIndex <= baseTypeIndex + 2) {
        score += 1;
        reasons.push(`${candidate.questionType} 흐름`);
      }

      const review = candidate.id ? reviews[candidate.id] : undefined;
      if (review?.lastRating === Rating.Again) {
        score += 2;
        reasons.push("최근 못암기");
      } else if (review?.lastRating === Rating.Hard) {
        score += 1;
        reasons.push("최근 애매");
      }
      if (fsrsService.isDue(review, now)) {
        score += 3 + Math.min(7, daysOverdue(review, now));
        reasons.push("복습 기한 경과");
      }

      return { question: candidate, score, reasons };
    })
    .filter((item): item is QuestionRecommendation => item !== null)
    .sort((left, right) => right.score - left.score || left.question.heading.localeCompare(right.question.heading, "ko"))
    .slice(0, limit);
}

export interface ReviewQueueOptions {
  now?: Date;
}

export function buildReviewQueue(
  questions: QuestionRecord[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrsService: FsrsService,
  options: ReviewQueueOptions = {},
): Array<QuestionRecord & { id: string }> {
  const now = options.now ?? new Date();
  const registered = questions.filter((question): question is QuestionRecord & { id: string } => Boolean(question.id));
  const due = registered
    .filter((question) => fsrsService.isDue(reviews[question.id], now))
    .sort((left, right) => {
      const leftDue = new Date(reviews[left.id]?.card.due ?? 0).getTime();
      const rightDue = new Date(reviews[right.id]?.card.due ?? 0).getTime();
      return leftDue - rightDue;
    });
  const fresh = registered
    .filter((question) => fsrsService.isNew(reviews[question.id]));
  return [...due, ...fresh];
}

export const RecommendationInternals = { normalizeKeyword };

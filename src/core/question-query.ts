import { isLeech } from "./study-automation";
import { Rating, State } from "ts-fsrs";
import { FsrsService } from "./fsrs-service";
import { QuestionRecord, QuestionReviewState, QuestionType } from "./models";

export type ReviewFilter = "all" | "due" | "new" | "again" | "hard" | "good" | "easy" | "weak" | "leech" | "stable" | "today";
export type QuestionSort = "review" | "title" | "subject" | "type" | "created" | "updated" | "weak" | "ambiguous";

export interface QuestionQuery {
  text: string;
  subject: string;
  questionType: "all" | QuestionType;
  review: ReviewFilter;
  keyword: string;
  sort: QuestionSort;
  now?: Date;
}

type RegisteredQuestion = QuestionRecord & { id: string };
const koreanCollator = new Intl.Collator("ko");

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ko");
}

function searchableText(question: QuestionRecord): string {
  return [
    question.heading,
    question.questionMarkdown,
    question.answerMarkdown,
    question.subject,
    question.deck,
    ...question.coreKeywords.flatMap((keyword) => [keyword.label, keyword.target]),
    ...question.subKeywords.flatMap((keyword) => [keyword.label, keyword.target]),
  ].join("\n").toLocaleLowerCase("ko");
}

function keywordText(question: QuestionRecord): string {
  return [...question.coreKeywords, ...question.subKeywords]
    .flatMap((keyword) => [keyword.label, keyword.target])
    .join("\n")
    .toLocaleLowerCase("ko");
}

export function hasWeakRating(review: QuestionReviewState | undefined): boolean {
  return review?.lastRating === Rating.Again || review?.lastRating === Rating.Hard;
}

function matchesReview(
  filter: ReviewFilter,
  review: QuestionReviewState | undefined,
  fsrsService: FsrsService,
  now: Date,
): boolean {
  if (filter === "leech") return isLeech(review);
  if (filter === "all") return true;
  if (filter === "due") return fsrsService.isDue(review, now);
  if (filter === "new") return fsrsService.isNew(review);
  if (filter === "stable") return fsrsService.isStable(review, now);
  if (filter === "today") {
    return fsrsService.isInStudyDay(review?.history.at(-1)?.review, now);
  }
  const rating = review?.lastRating;
  if (filter === "weak") return hasWeakRating(review);
  if (filter === "again") return rating === Rating.Again;
  if (filter === "hard") return rating === Rating.Hard;
  if (filter === "good") return rating === Rating.Good;
  return rating === Rating.Easy;
}

export function weaknessUrgency(review: QuestionReviewState | undefined, now = new Date()): number {
  if (!review || !hasWeakRating(review)) return 0;
  const base = review.lastRating === Rating.Again ? 100 : 60;
  const due = new Date(review.card.due).getTime();
  const overdue = Number.isFinite(due) && due < now.getTime()
    ? Math.min(30, Math.floor((now.getTime() - due) / 86_400_000))
    : 0;
  return base + overdue;
}

function timestamp(question: RegisteredQuestion, key: "createdAt" | "updatedAt"): number {
  const value = question[key];
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function dueTime(due: string | undefined): number {
  const time = due ? new Date(due).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

interface ReviewSortKeys {
  review: QuestionReviewState | undefined;
  priority: number;
  learning: boolean;
  /** 회상 확률은 기존 compareDue처럼 실제로 비교할 때만 계산해 캐시한다. */
  recall?: number;
  due: number;
}

function reviewSortKeys(review: QuestionReviewState | undefined, fsrsService: FsrsService, now: Date): ReviewSortKeys {
  if (!review || !fsrsService.isDue(review, now)) {
    return { review, priority: fsrsService.isNew(review) ? 1 : 2, learning: false, due: dueTime(review?.card.due) };
  }
  const learning = review.card.state === State.Learning || review.card.state === State.Relearning;
  return { review, priority: 0, learning, due: Date.parse(review.card.due) };
}

function compareReviewKeys(left: ReviewSortKeys, right: ReviewSortKeys, fsrsService: FsrsService, now: Date): number {
  const priority = left.priority - right.priority;
  if (priority !== 0) return priority;
  if (left.priority === 0) {
    // fsrsService.compareDue와 같은 규칙: 학습 단계 우선 → 회상 확률 오름차순 → 기한.
    if (left.learning !== right.learning) return left.learning ? -1 : 1;
    if (!left.learning) {
      left.recall ??= fsrsService.retrievability(left.review, now) ?? 1;
      right.recall ??= fsrsService.retrievability(right.review, now) ?? 1;
      const recall = left.recall - right.recall;
      if (recall !== 0) return recall;
    }
  }
  return left.due - right.due;
}

export function queryQuestions(
  questions: RegisteredQuestion[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrsService: FsrsService,
  query: QuestionQuery,
): RegisteredQuestion[] {
  const now = query.now ?? new Date();
  const text = normalize(query.text);
  const keyword = normalize(query.keyword);
  const filtered = questions.filter((question) => {
    if (query.subject !== "all" && question.subject !== query.subject) return false;
    if (query.questionType !== "all" && question.questionType !== query.questionType) return false;
    if (!matchesReview(query.review, reviews[question.id], fsrsService, now)) return false;
    if (text && !searchableText(question).includes(text)) return false;
    if (keyword && !keywordText(question).includes(keyword)) return false;
    return true;
  });

  const compareHeadings = (left: RegisteredQuestion, right: RegisteredQuestion) => koreanCollator.compare(left.heading, right.heading);
  const sort = query.sort;
  if (sort === "title") return filtered.sort(compareHeadings);
  if (sort === "subject" || sort === "type") {
    const field = sort === "subject" ? "subject" : "questionType";
    return filtered.sort((left, right) => koreanCollator.compare(left[field], right[field]) || compareHeadings(left, right));
  }
  if (sort === "created" || sort === "updated") {
    const field = sort === "created" ? "createdAt" : "updatedAt";
    return filtered.map(question => ({ question, time: timestamp(question, field) }))
      .sort((left, right) => right.time - left.time || compareHeadings(left.question, right.question))
      .map(({ question }) => question);
  }
  if (sort === "weak" || sort === "ambiguous") {
    return filtered.map(question => {
      const review = reviews[question.id];
      const priority = sort === "weak" ? -weaknessUrgency(review, now) : Number(review?.lastRating !== Rating.Hard);
      return { question, priority, due: dueTime(review?.card.due) };
    }).sort((left, right) => left.priority - right.priority || left.due - right.due
      || compareHeadings(left.question, right.question))
      .map(({ question }) => question);
  }
  return filtered.map(question => ({ question, keys: reviewSortKeys(reviews[question.id], fsrsService, now) }))
    .sort((left, right) => compareReviewKeys(left.keys, right.keys, fsrsService, now) || compareHeadings(left.question, right.question))
    .map(({ question }) => question);
}

import { Rating } from "ts-fsrs";
import { FsrsService } from "./fsrs-service";
import { QuestionRecord, QuestionReviewState, QuestionType } from "./models";

export type ReviewFilter = "all" | "due" | "new" | "again" | "hard" | "good" | "easy";
export type QuestionSort = "review" | "title" | "subject" | "type";

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

function matchesReview(
  filter: ReviewFilter,
  review: QuestionReviewState | undefined,
  fsrsService: FsrsService,
  now: Date,
): boolean {
  if (filter === "all") return true;
  if (filter === "due") return fsrsService.isDue(review, now);
  if (filter === "new") return fsrsService.isNew(review);
  const rating = review?.lastRating;
  if (filter === "again") return rating === Rating.Again;
  if (filter === "hard") return rating === Rating.Hard;
  if (filter === "good") return rating === Rating.Good;
  return rating === Rating.Easy;
}

function dueTime(question: RegisteredQuestion, reviews: Readonly<Record<string, QuestionReviewState>>): number {
  const due = reviews[question.id]?.card.due;
  const time = due ? new Date(due).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function reviewPriority(
  question: RegisteredQuestion,
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrsService: FsrsService,
  now: Date,
): number {
  const review = reviews[question.id];
  if (fsrsService.isDue(review, now)) return 0;
  if (fsrsService.isNew(review)) return 1;
  return 2;
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

  return filtered.sort((left, right) => {
    if (query.sort === "title") return left.heading.localeCompare(right.heading, "ko");
    if (query.sort === "subject") {
      return left.subject.localeCompare(right.subject, "ko") || left.heading.localeCompare(right.heading, "ko");
    }
    if (query.sort === "type") {
      return left.questionType.localeCompare(right.questionType, "ko") || left.heading.localeCompare(right.heading, "ko");
    }
    const priority = reviewPriority(left, reviews, fsrsService, now) - reviewPriority(right, reviews, fsrsService, now);
    if (priority !== 0) return priority;
    return dueTime(left, reviews) - dueTime(right, reviews) || left.heading.localeCompare(right.heading, "ko");
  });
}


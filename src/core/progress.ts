import { Rating } from "ts-fsrs";
import { FsrsService } from "./fsrs-service";
import { QuestionRecord, QuestionReviewState } from "./models";

type RegisteredQuestion = QuestionRecord & { id: string };

export interface ProgressCounts {
  total: number;
  new: number;
  studied: number;
  due: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface StudyProgress extends ProgressCounts {
  bySubject: Array<{ subject: string; counts: ProgressCounts }>;
}

function emptyCounts(): ProgressCounts {
  return { total: 0, new: 0, studied: 0, due: 0, again: 0, hard: 0, good: 0, easy: 0 };
}

function countQuestion(
  counts: ProgressCounts,
  review: QuestionReviewState | undefined,
  fsrs: FsrsService,
  now: Date,
): void {
  counts.total += 1;
  if (fsrs.isNew(review)) counts.new += 1;
  else counts.studied += 1;
  if (fsrs.isDue(review, now)) counts.due += 1;
  if (review?.lastRating === Rating.Again) counts.again += 1;
  if (review?.lastRating === Rating.Hard) counts.hard += 1;
  if (review?.lastRating === Rating.Good) counts.good += 1;
  if (review?.lastRating === Rating.Easy) counts.easy += 1;
}

export function calculateProgress(
  questions: readonly RegisteredQuestion[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrs: FsrsService,
  now = new Date(),
): StudyProgress {
  const overall = emptyCounts();
  const subjects = new Map<string, ProgressCounts>();
  for (const question of questions) {
    const review = reviews[question.id];
    countQuestion(overall, review, fsrs, now);
    const subject = subjects.get(question.subject) ?? emptyCounts();
    countQuestion(subject, review, fsrs, now);
    subjects.set(question.subject, subject);
  }
  return {
    ...overall,
    bySubject: [...subjects.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "ko"))
      .map(([subject, counts]) => ({ subject, counts })),
  };
}

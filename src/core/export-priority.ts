import { Rating } from "ts-fsrs";
import type { FsrsService } from "./fsrs-service";
import { DEFAULT_SETTINGS, type QuestionRecord, type QuestionReviewState } from "./models";
import { hasWeakRating } from "./question-query";
import { isLeech } from "./study-automation";

export interface SubjectExportOptions {
  scope: "all" | "weak";
  order: "note" | "weak";
}

export function parseSubjectExportOptions(value: unknown): SubjectExportOptions {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { scope: raw.scope === "weak" ? "weak" : "all", order: raw.order === "weak" ? "weak" : "note" };
}

type ReviewChecks = Pick<FsrsService, "isDue" | "isNew">;
type ExportFsrs = ReviewChecks & Pick<FsrsService, "retrievability">;

function classify(review: QuestionReviewState | undefined, fsrs: ReviewChecks, now: Date, recall: number | null, targetRetention: number) {
  const leech = isLeech(review);
  const due = fsrs.isDue(review, now);
  let group = 5;
  const weakRating = hasWeakRating(review);
  if (leech && (due || weakRating || (recall !== null && recall < targetRetention))) group = 0;
  else if (weakRating) group = review?.lastRating === Rating.Again ? 1 : 2;
  else if (due) group = 3;
  else if (fsrs.isNew(review)) group = 4;
  return { group, leech, due };
}

export function isWeakForExport(review: QuestionReviewState | undefined, fsrs: ExportFsrs, now: Date, targetRetention = DEFAULT_SETTINGS.targetRetention): boolean {
  const recall = isLeech(review) ? fsrs.retrievability(review, now) : null;
  return classify(review, fsrs, now, recall, targetRetention).group < 5;
}

const comparePaths = new Intl.Collator("ko", { numeric: true }).compare;
export function compareExportNoteOrder(left: QuestionRecord, right: QuestionRecord): number {
  return comparePaths(left.filePath, right.filePath) || left.location.headingLine - right.location.headingLine;
}

const ratingLabels: Partial<Record<number, string>> = {
  [Rating.Again]: "못 암기",
  [Rating.Hard]: "애매",
  [Rating.Good]: "암기",
  [Rating.Easy]: "너무 쉬움",
};

function statusLine(review: QuestionReviewState | undefined, classification: ReturnType<typeof classify>, recall: number | null): string {
  if (!review || classification.group === 4) return "학습 전";
  const parts: string[] = [];
  if (classification.leech) parts.push("자주 틀림");
  if (classification.due) parts.push("복습할 차례");
  const rating = review.lastRating === null ? undefined : ratingLabels[review.lastRating];
  if (rating) parts.push(`마지막 평가 ${rating}`);
  if (review.card.lapses > 0) parts.push(`잊은 횟수 ${review.card.lapses}회`);
  if (recall !== null) parts.push(`기억 확률 ${Math.round(recall * 100)}%`);
  return parts.join(" · ");
}

function formatLocalMinute(now: Date): string {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function prepareSubjectExport(
  questions: readonly (QuestionRecord & { id: string })[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrs: ExportFsrs,
  options: SubjectExportOptions,
  now: Date,
  targetRetention = DEFAULT_SETTINGS.targetRetention,
) {
  const { scope, order } = options;
  const selected = questions.flatMap((question) => {
    const review = reviews[question.id];
    const recall = fsrs.retrievability(review, now);
    const classification = classify(review, fsrs, now, recall, targetRetention);
    const { group } = classification;
    if (scope === "weak" && group === 5) return [];
    return [{ question, group, lapses: group === 0 ? review?.card.lapses ?? 0 : 0, recall,
      status: statusLine(review, classification, recall) }];
  });
  selected.sort((left, right) => {
    if (order === "weak") {
      const priority = left.group - right.group || right.lapses - left.lapses || (left.recall ?? 1) - (right.recall ?? 1);
      if (priority) return priority;
    }
    return compareExportNoteOrder(left.question, right.question);
  });
  const labels = [scope === "weak" ? "부족한 문제" : "", order === "weak" ? "부족한 순서" : ""].filter(Boolean);
  const count = scope === "weak" ? `부족한 문제 ${selected.length}개 / 전체 ${questions.length}개` : `전체 ${questions.length}개`;
  return {
    questions: selected.map(({ question }) => question),
    presentation: {
      titleSuffix: ` (${labels.join(" · ")})`,
      summary: `출력 기준 ${formatLocalMinute(now)} · ${count}`,
      statusLines: selected.map(({ status }) => status),
    },
  };
}

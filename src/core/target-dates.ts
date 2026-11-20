import type { FsrsService } from "./fsrs-service";
import type { QuestionRecord, QuestionReviewState, TargetDate } from "./models";
import { nextStudyDayStart, studyDayStart } from "./study-management";

export const MAX_TARGET_DATES = 20;
export const MAX_TARGET_LABEL_LENGTH = 40;
const DAY_MS = 86_400_000;

export function isTargetDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseTargetDates(value: unknown): TargetDate[] {
  if (!Array.isArray(value)) return [];
  const result: TargetDate[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (result.length === MAX_TARGET_DATES) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, label, date, subjects } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim() || ids.has(id) || typeof label !== "string" || !isTargetDate(date)) continue;
    const name = label.trim();
    if (!name || name.length > MAX_TARGET_LABEL_LENGTH) continue;
    if (subjects !== undefined && (!Array.isArray(subjects) || !subjects.every(
      (subject): subject is string => typeof subject === "string" && subject.trim().length > 0,
    ))) continue;
    const scope = subjects ? [...new Set(subjects.map(subject => subject.trim()))] : [];
    ids.add(id);
    result.push({ id, label: name, date, ...(scope.length ? { subjects: scope } : {}) });
  }
  return result;
}

type RegisteredQuestion = Pick<QuestionRecord, "subject"> & { id: string };

export interface TargetDateSummary {
  target: TargetDate;
  daysUntil: number;
  total: number;
  unstudied: number;
  averageRecall: number | null;
  risks: Array<{ id: string; recall: number }>;
}

function calendarDate(date: Date): string {
  return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

function targetStart(date: string, hour: number): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const local = new Date(0);
  local.setFullYear(year, month - 1, day);
  local.setHours(23, 59, 59, 999);
  return studyDayStart(local, hour);
}

export function summarizeTargetDates(
  targets: readonly TargetDate[],
  questions: readonly RegisteredQuestion[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrs: FsrsService,
  dayStartsAt: number,
  retention: number,
  now = new Date(),
  upcomingOnly = false,
): TargetDateSummary[] {
  if (!targets.length) return [];
  const today = calendarDate(studyDayStart(now, dayStartsAt));
  const sorted = [...targets].sort((a, b) => a.date.localeCompare(b.date));
  const next = upcomingOnly ? sorted.find(target => target.date >= today) : undefined;
  const selected = upcomingOnly ? next ? [next] : [] : sorted;
  const todayOrdinal = Date.parse(today);
  let date = "";
  let at = now;
  const projected = new Map<string, number | null>();
  return selected.map(target => {
    if (target.date !== date) {
      date = target.date;
      at = targetStart(date, dayStartsAt);
      projected.clear();
    }
    const subjects = new Set(target.subjects);
    const risks: TargetDateSummary["risks"] = [];
    let total = 0, unstudied = 0, sum = 0;
    for (const question of questions) {
      if (subjects.size && !subjects.has(question.subject)) continue;
      total += 1;
      if (!projected.has(question.id)) projected.set(question.id, fsrs.retrievability(reviews[question.id], at));
      const recall = projected.get(question.id) ?? null;
      if (recall === null) unstudied += 1;
      else {
        sum += recall;
        if (recall < retention) risks.push({ id: question.id, recall });
      }
    }
    risks.sort((a, b) => a.recall - b.recall || a.id.localeCompare(b.id));
    return { target, daysUntil: (Date.parse(date) - todayOrdinal) / DAY_MS, total, unstudied,
      averageRecall: total === unstudied ? null : sum / (total - unstudied), risks };
  });
}

export function forecastReviews(
  questions: readonly RegisteredQuestion[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  fsrs: FsrsService,
  dayStartsAt: number,
  now = new Date(),
): Array<{ date: string; count: number }> {
  let day = studyDayStart(now, dayStartsAt);
  const days = Array.from({ length: 30 }, () => {
    const item = { date: calendarDate(day), count: 0 };
    day = nextStudyDayStart(day, dayStartsAt);
    return item;
  });
  const byDate = new Map(days.map(item => [item.date, item]));
  const today = days[0]!;
  for (const question of questions) {
    const review = reviews[question.id];
    if (!review || fsrs.isNew(review)) continue;
    const date = calendarDate(studyDayStart(new Date(review.card.due), dayStartsAt));
    const bucket = date < today.date ? today : byDate.get(date);
    if (bucket) bucket.count += 1;
  }
  return days;
}

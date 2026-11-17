import { Rating } from "ts-fsrs";
import type { StudyGrade } from "../core/fsrs-service";
import type { QuestionReviewState } from "../core/models";
import type { StudyResult } from "./study-result-modal";

/** Pure display/result calculations; no DOM, persistence or scheduling changes. */
export function formatInterval(due: Date, days: number, fixedMinutes?: number, now = new Date()): string {
  if (fixedMinutes !== undefined) {
    if (fixedMinutes % 1440 === 0) return `${fixedMinutes / 1440}일`;
    if (fixedMinutes % 60 === 0) return `${fixedMinutes / 60}시간`;
    return `${fixedMinutes}분`;
  }
  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60_000));
  if (days === 0 || minutes !== days * 1440) {
    return [Math.floor(minutes / 1440) ? `${Math.floor(minutes / 1440)}일` : "", Math.floor(minutes % 1440 / 60) ? `${Math.floor(minutes % 1440 / 60)}시간` : "", minutes % 60 ? `${minutes % 60}분` : ""].filter(Boolean).join(" ");
  }
  if (days < 30) return `${days}일`;
  if (days < 365) return `약 ${Math.round(days / 30)}개월`;
  return `약 ${(days / 365).toFixed(1)}년`;
}

interface SessionResultInput {
  queue: readonly string[];
  grades: ReadonlyMap<string, StudyGrade>;
  skipped: ReadonlySet<string>;
  startedAt: number;
  now(): number;
  reviewFor(id: string): QuestionReviewState | undefined;
}

export function summarizeStudySession({ queue, grades: sessionGrades, skipped, startedAt, reviewFor, now }: SessionResultInput): StudyResult {
  const grades = [...sessionGrades.values()];
  const times = [...sessionGrades.keys()].flatMap(id => {
    const ms = reviewFor(id)?.history.at(-1)?.answer_ms;
    return ms === undefined ? [] : [ms];
  });
  return {
    total: new Set(queue).size,
    again: grades.filter((grade) => grade === Rating.Again).length,
    hard: grades.filter((grade) => grade === Rating.Hard).length,
    good: grades.filter((grade) => grade === Rating.Good).length,
    easy: grades.filter((grade) => grade === Rating.Easy).length,
    skipped: [...skipped].filter((id) => !sessionGrades.has(id)).length,
    ...(times.length ? { averageAnswerMs: times.reduce((sum, ms) => sum + ms, 0) / times.length } : {}),
    durationSeconds: Math.max(0, Math.round((now() - startedAt) / 1000)),
  };
}

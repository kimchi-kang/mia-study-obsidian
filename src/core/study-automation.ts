import type { QuestionReviewState } from "./models";

export const LEECH_LAPSES = 8;
export function isLeech(review: QuestionReviewState | undefined): boolean {
  return (review?.card.lapses ?? 0) >= LEECH_LAPSES;
}
export const AUTO_QUESTION_SECONDS = [0, 5, 10, 15, 20, 30, 45, 60] as const;
export const AUTO_ANSWER_SECONDS = [0, 3, 5, 10, 15, 20, 30] as const;
export interface AutoAdvanceSettings {
  autoQuestionSeconds: typeof AUTO_QUESTION_SECONDS[number];
  autoAnswerSeconds: typeof AUTO_ANSWER_SECONDS[number];
  autoAnswerAction: "skip" | "again";
}
function allowed<T extends number>(values: readonly T[], value: unknown): T | 0 {
  return values.find(item => item === value) ?? 0;
}
export function parseAutoAdvance(raw: Record<string, unknown>): AutoAdvanceSettings {
  return {
    autoQuestionSeconds: allowed(AUTO_QUESTION_SECONDS, raw.autoQuestionSeconds),
    autoAnswerSeconds: allowed(AUTO_ANSWER_SECONDS, raw.autoAnswerSeconds),
    autoAnswerAction: raw.autoAnswerAction === "again" ? "again" : "skip",
  };
}
export function autoRemaining(seconds: number, milliseconds: number): number {
  return Math.max(0, Math.ceil(seconds - milliseconds / 1000));
}

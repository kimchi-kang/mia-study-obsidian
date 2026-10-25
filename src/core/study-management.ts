import { checkParameters, State, type StepUnit } from "ts-fsrs";
import { DEFAULT_STUDY_MANAGEMENT, type QuestionRecord, type QuestionReviewState, type StudyManagementSettings } from "./models";

export function parseSteps(text: string): StepUnit[] | null {
  const parts = text.trim() ? text.trim().split(/\s+/) : [];
  const result: StepUnit[] = [];
  for (const part of parts) {
    if (!/^(?:\d+(?:\.\d+)?)(?:m|h|d)$/.test(part)) return null;
    const amount = Number(part.slice(0, -1));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 36500) return null;
    // FSRS recommends short learning steps, while accepting explicit day steps.
    const unit = part.at(-1);
    if (unit === "m" || unit === "h" || unit === "d") result.push(`${amount}${unit}`);
  }
  return result;
}

export function validParameters(value: unknown): value is number[] {
  if (!Array.isArray(value) || (value.length !== 0 && value.length !== 21)) return false;
  if (!value.every(item => typeof item === "number" && Number.isFinite(item))) return false;
  if (!value.length) return true;
  try { checkParameters(value); return true; } catch { return false; }
}

export function parseStudyManagement(value: unknown): StudyManagementSettings {
  const raw: Record<string, unknown> = typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
  const defaults = DEFAULT_STUDY_MANAGEMENT;
  const integer = (key: "newCardsPerDay" | "reviewsPerDay" | "dayStartsAt", max: number) => {
    const item = raw[key];
    return typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= max ? item : defaults[key];
  };
  const steps = (key: "learningSteps" | "relearningSteps") => Array.isArray(raw[key]) && raw[key].every(item => typeof item === "string")
    ? parseSteps(raw[key].join(" ")) ?? [...defaults[key]] : [...defaults[key]];
  const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T => choices.find(item => item === value) ?? fallback;
  return {
    newCardsPerDay: integer("newCardsPerDay", 9999),
    reviewsPerDay: integer("reviewsPerDay", 9999),
    dayStartsAt: integer("dayStartsAt", 23),
    newCardsIgnoreReviewLimit: typeof raw.newCardsIgnoreReviewLimit === "boolean" ? raw.newCardsIgnoreReviewLimit : defaults.newCardsIgnoreReviewLimit,
    learningSteps: steps("learningSteps"), relearningSteps: steps("relearningSteps"),
    newCardOrder: choice(raw.newCardOrder, ["sequential", "random"], defaults.newCardOrder),
    newReviewOrder: choice(raw.newReviewOrder, ["before", "after", "mix"], defaults.newReviewOrder),
    reviewOrder: choice(raw.reviewOrder, ["due", "retrievability", "random", "interval-ascending", "interval-descending"], defaults.reviewOrder),
    enableFuzz: typeof raw.enableFuzz === "boolean" ? raw.enableFuzz : defaults.enableFuzz,
    fsrsParameters: validParameters(raw.fsrsParameters) ? [...raw.fsrsParameters] : [],
  };
}

/** Local calendar arithmetic preserves a 04:00 boundary across DST transitions. */
export function studyDayStart(now: Date, hour: number): Date {
  const start = new Date(now);
  start.setHours(hour, 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return start;
}

export function dailyStudyCounts(reviews: Readonly<Record<string, QuestionReviewState>>, settings: StudyManagementSettings, now: Date): { fresh: number; review: number } {
  const start = studyDayStart(now, settings.dayStartsAt).getTime();
  let fresh = 0; let review = 0;
  for (const state of Object.values(reviews)) {
    let introduced = false;
    for (const log of state.history) {
      const time = Date.parse(log.review);
      if (time < start || time > now.getTime()) continue;
      if (log.state === State.New) introduced = true;
      // Intraday repetitions never consume the review budget. Interday learning does.
      if (log.state === State.Review || ((log.state === State.Learning || log.state === State.Relearning) && Date.parse(log.due) < start)) review += 1;
    }
    if (introduced) fresh += 1;
  }
  return { fresh, review };
}

export function orderManagedQueue<T extends QuestionRecord & { id: string }>(
  due: T[], fresh: T[], reviews: Readonly<Record<string, QuestionReviewState>>, settings: StudyManagementSettings,
  now: Date, random: () => number, compareRecall: (left: string, right: string) => number,
): T[] {
  const shuffle = (items: T[]) => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const target = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
      [items[i], items[target]] = [items[target]!, items[i]!];
    }
  };
  const start = studyDayStart(now, settings.dayStartsAt).getTime();
  const intraday = (item: T) => {
    const card = reviews[item.id]!.card;
    return (card.state === State.Learning || card.state === State.Relearning) && Date.parse(card.due) >= start;
  };
  const learning = due.filter(intraday).sort((a, b) => Date.parse(reviews[a.id]!.card.due) - Date.parse(reviews[b.id]!.card.due));
  const scheduled = due.filter(item => !intraday(item));
  if (settings.reviewOrder === "random") shuffle(scheduled);
  else scheduled.sort((a, b) => {
    const left = reviews[a.id]!.card; const right = reviews[b.id]!.card;
    if (settings.reviewOrder === "retrievability") return compareRecall(a.id, b.id);
    if (settings.reviewOrder === "interval-ascending") return left.scheduled_days - right.scheduled_days;
    if (settings.reviewOrder === "interval-descending") return right.scheduled_days - left.scheduled_days;
    return Date.parse(left.due) - Date.parse(right.due);
  });
  if (settings.newCardOrder === "random") shuffle(fresh);
  const counts = dailyStudyCounts(reviews, settings, now);
  const remaining = Math.max(0, settings.reviewsPerDay - counts.review - (settings.newCardsIgnoreReviewLimit ? 0 : counts.fresh));
  const selectedReviews = scheduled.slice(0, remaining);
  const newBudget = Math.max(0, Math.min(settings.newCardsPerDay - counts.fresh,
    settings.newCardsIgnoreReviewLimit ? 9999 : remaining - selectedReviews.length));
  const selectedNew = fresh.slice(0, newBudget);
  if (settings.newReviewOrder === "before") return [...learning, ...selectedNew, ...selectedReviews];
  if (settings.newReviewOrder === "after") return [...learning, ...selectedReviews, ...selectedNew];
  // Spread new cards evenly through reviews instead of clustering either group.
  const mixed: T[] = [];
  let n = 0;
  for (let r = 0; r < selectedReviews.length; r += 1) {
    mixed.push(selectedReviews[r]!);
    const target = Math.floor((r + 1) * selectedNew.length / selectedReviews.length);
    while (n < target) mixed.push(selectedNew[n++]!);
  }
  return [...learning, ...mixed, ...selectedNew.slice(n)];
}

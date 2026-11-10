import {
  Card,
  Grade,
  Rating,
  ReviewLog,
  State,
  createEmptyCard,
  date_scheduler,
  fsrs,
  GenSeedStrategyWithCardId,
  StrategyMode,
} from "ts-fsrs";
import {
  DEFAULT_STUDY_MANAGEMENT,
  MiaSettings,
  QuestionReviewState,
  SerializedFsrsCard,
  SerializedReviewLog,
} from "./models";
import { nextStudyDayStart, studyDayStart } from "./study-management";

export type StudyGrade = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;

export interface RatingPreview {
  grade: StudyGrade;
  due: Date;
  scheduledDays: number;
  fixedIntervalMinutes?: number;
}

function serializeCard(card: Card): SerializedFsrsCard {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    ...(card.last_review ? { last_review: card.last_review.toISOString() } : {}),
  };
}

function deserializeCard(card: SerializedFsrsCard): Card {
  const { due, last_review, state, ...rest } = card;
  return {
    ...rest,
    due: new Date(due),
    state: state as State,
    ...(last_review ? { last_review: new Date(last_review) } : {}),
  };
}

function serializeLog(log: ReviewLog): SerializedReviewLog {
  return {
    ...log,
    rating: log.rating,
    state: log.state,
    due: log.due.toISOString(),
    review: log.review.toISOString(),
  };
}

const HOUR_MS = 3600000;

function localOffsetMs(time: number): number {
  return -new Date(time).getTimezoneOffset() * 60000;
}

/**
 * ts-fsrs counts elapsed days by UTC calendar date. Shifting each instant by
 * (local UTC offset - dayStartsAt) makes UTC midnight of the shifted timeline
 * equal the local study-day start. Stored data always stays in real time.
 */
function toStudyTimeline(date: Date, dayStartsAt: number): Date {
  const time = date.getTime();
  return new Date(time + localOffsetMs(time) - dayStartsAt * HOUR_MS);
}

function fromStudyTimeline(date: Date, dayStartsAt: number): Date {
  const shifted = date.getTime();
  let real = shifted + dayStartsAt * HOUR_MS - localOffsetMs(shifted);
  for (let i = 0; i < 3; i += 1) real = shifted + dayStartsAt * HOUR_MS - localOffsetMs(real);
  return new Date(real);
}

export class FsrsService {
  private readonly scheduler;
  private readonly targetRetention: number;
  private readonly maximumIntervalDays: number;
  private readonly gradeIntervalsMinutes: MiaSettings["gradeIntervalsMinutes"];
  private readonly dayStartsAt: number;

  constructor(settings: Pick<MiaSettings, "targetRetention" | "maximumIntervalDays"> & Partial<Pick<MiaSettings, "gradeIntervalsMinutes" | "studyManagement">>) {
    this.targetRetention = settings.targetRetention;
    this.maximumIntervalDays = settings.maximumIntervalDays;
    this.gradeIntervalsMinutes = { ...settings.gradeIntervalsMinutes };
    const management = settings.studyManagement ?? DEFAULT_STUDY_MANAGEMENT;
    this.dayStartsAt = management.dayStartsAt;
    this.scheduler = fsrs({
      request_retention: settings.targetRetention,
      maximum_interval: settings.maximumIntervalDays,
      enable_fuzz: management.enableFuzz,
      learning_steps: management.learningSteps,
      relearning_steps: management.relearningSteps,
      ...(management.fsrsParameters.length ? { w: management.fsrsParameters } : {}),
    }).useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId("questionSeed"));
  }

  createState(now = new Date()): QuestionReviewState {
    return { card: serializeCard(createEmptyCard(now)), history: [], lastRating: null };
  }

  preview(state: QuestionReviewState | undefined, now = new Date(), questionId = ""): RatingPreview[] {
    const current = state ?? this.createState(now);
    const card = { ...this.shiftCard(deserializeCard(current.card), toStudyTimeline), questionSeed: `${questionId}:` };
    const preview = this.scheduler.repeat(card, toStudyTimeline(now, this.dayStartsAt));
    const grades: StudyGrade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
    return grades.map((grade) => {
      const scheduled = this.scheduleInterval(this.unshiftResult(preview[grade].card, now), grade, now);
      return { grade, due: scheduled.due, scheduledDays: scheduled.scheduled_days,
        ...(this.gradeIntervalsMinutes[grade] === undefined ? {} : { fixedIntervalMinutes: (scheduled.due.getTime() - now.getTime()) / 60000 }),
      };
    });
  }

  rate(state: QuestionReviewState | undefined, grade: StudyGrade, now = new Date(), questionId = ""): QuestionReviewState {
    const current = state ?? this.createState(now);
    if (current.card.last_review && Date.parse(current.card.last_review) > now.getTime()) {
      throw new Error("기기 시간이 직전 평가보다 이전입니다. 날짜와 시간을 확인한 뒤 다시 평가하세요.");
    }
    const card = { ...this.shiftCard(deserializeCard(current.card), toStudyTimeline), questionSeed: `${questionId}:` };
    const result = this.scheduler.next(card, toStudyTimeline(now, this.dayStartsAt), grade as Grade);
    const log = { ...result.log, due: fromStudyTimeline(result.log.due, this.dayStartsAt), review: fromStudyTimeline(result.log.review, this.dayStartsAt) };
    return {
      card: serializeCard(this.scheduleInterval(this.unshiftResult(result.card, now), grade, now)),
      history: [...current.history, serializeLog(log)],
      lastRating: grade,
    };
  }

  retrievability(state: QuestionReviewState | undefined, now = new Date()): number | null {
    if (!state || state.card.state === State.New) return null;
    return this.scheduler.get_retrievability(this.shiftCard(deserializeCard(state.card), toStudyTimeline), toStudyTimeline(now, this.dayStartsAt), false);
  }

  /**
   * Like Anki, an interday review is due for its whole study day (from the
   * configured day start), not only after its exact timestamp. Otherwise a
   * card graded at 09:05 is not due at 09:00 a day later and every review
   * slips a day for someone who studies at the same time daily. Learning
   * steps and sub-day fixed intervals keep their exact time.
   */
  isDue(state: QuestionReviewState | undefined, now = new Date()): boolean {
    if (!state || state.card.state === State.New) return false;
    const due = new Date(state.card.due).getTime();
    if (state.card.state === State.Review && state.card.scheduled_days >= 1) {
      return due < nextStudyDayStart(now, this.dayStartsAt).getTime();
    }
    return due <= now.getTime();
  }

  /** True when `reviewedAt` falls in the same study day (from dayStartsAt) as `now`. */
  isInStudyDay(reviewedAt: string | Date | undefined, now: Date): boolean {
    if (!reviewedAt) return false;
    const time = new Date(reviewedAt).getTime();
    return Number.isFinite(time)
      && time >= studyDayStart(now, this.dayStartsAt).getTime()
      && time < nextStudyDayStart(now, this.dayStartsAt).getTime();
  }

  isNew(state: QuestionReviewState | undefined): boolean {
    return !state || state.card.state === State.New;
  }

  isStable(state: QuestionReviewState | undefined, now = new Date()): boolean {
    if (state?.card.state !== State.Review) return false;
    const retrievability = this.retrievability(state, now);
    return retrievability !== null && retrievability >= this.targetRetention;
  }

  /** Due learning steps are time-critical; overdue reviews use ascending recall probability. */
  compareDue(left: QuestionReviewState | undefined, right: QuestionReviewState | undefined, now = new Date()): number {
    if (!left || !right) return Number(!left) - Number(!right);
    const learning = (state: QuestionReviewState) => state.card.state === State.Learning || state.card.state === State.Relearning;
    const leftLearning = learning(left);
    const rightLearning = learning(right);
    if (leftLearning !== rightLearning) return leftLearning ? -1 : 1;
    if (!leftLearning) {
      const recall = (this.retrievability(left, now) ?? 1) - (this.retrievability(right, now) ?? 1);
      if (recall !== 0) return recall;
    }
    return Date.parse(left.card.due) - Date.parse(right.card.due);
  }

  private shiftCard(card: Card, convert: (date: Date, dayStartsAt: number) => Date): Card {
    return {
      ...card,
      due: convert(card.due, this.dayStartsAt),
      ...(card.last_review ? { last_review: convert(card.last_review, this.dayStartsAt) } : {}),
    };
  }

  /**
   * A scheduler result back in real time. The new due keeps the exact duration
   * ts-fsrs scheduled from `now`, so a DST change inside the interval cannot
   * move it by an hour.
   */
  private unshiftResult(card: Card, now: Date): Card {
    const shiftedNow = toStudyTimeline(now, this.dayStartsAt).getTime();
    return {
      ...card,
      due: new Date(now.getTime() + (card.due.getTime() - shiftedNow)),
      ...(card.last_review ? { last_review: fromStudyTimeline(card.last_review, this.dayStartsAt) } : {}),
    };
  }

  private scheduleInterval(card: Card, grade: StudyGrade, now: Date): Card {
    const configured = this.gradeIntervalsMinutes[grade];
    if (configured === undefined) return this.capInterval(card, now);
    const minutes = Math.min(configured, this.maximumIntervalDays * 1440);
    return {
      ...card,
      due: date_scheduler(now, minutes, false),
      scheduled_days: minutes < 1440 ? 0 : minutes / 1440,
    };
  }

  private capInterval(card: Card, now: Date): Card {
    // Grade separation in ts-fsrs can add days after its own maximum-interval clamp.
    // Long learning steps also floor scheduled_days while keeping fractional-day due.
    if (card.scheduled_days <= this.maximumIntervalDays
      && card.due.getTime() - now.getTime() <= this.maximumIntervalDays * 86400000) return card;
    return {
      ...card,
      scheduled_days: this.maximumIntervalDays,
      due: date_scheduler(now, this.maximumIntervalDays, true),
    };
  }
}

export const FsrsSerialization = { serializeCard, deserializeCard, serializeLog };

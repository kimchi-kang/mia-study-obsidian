import {
  Card,
  Grade,
  Rating,
  ReviewLog,
  State,
  createEmptyCard,
  fsrs,
} from "ts-fsrs";
import {
  MiaSettings,
  QuestionReviewState,
  SerializedFsrsCard,
  SerializedReviewLog,
} from "./models";

export type StudyGrade = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;

export interface RatingPreview {
  grade: StudyGrade;
  due: Date;
  scheduledDays: number;
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

function deserializeLog(log: SerializedReviewLog): ReviewLog {
  return {
    ...log,
    rating: log.rating as Rating,
    state: log.state as State,
    due: new Date(log.due),
    review: new Date(log.review),
  };
}

export class FsrsService {
  private readonly scheduler;
  private readonly targetRetention: number;

  constructor(settings: Pick<MiaSettings, "targetRetention" | "maximumIntervalDays">) {
    this.targetRetention = settings.targetRetention;
    this.scheduler = fsrs({
      request_retention: settings.targetRetention,
      maximum_interval: settings.maximumIntervalDays,
      enable_fuzz: false,
    });
  }

  createState(now = new Date()): QuestionReviewState {
    return { card: serializeCard(createEmptyCard(now)), history: [], lastRating: null };
  }

  preview(state: QuestionReviewState | undefined, now = new Date()): RatingPreview[] {
    const current = state ?? this.createState(now);
    const preview = this.scheduler.repeat(deserializeCard(current.card), now);
    const grades: StudyGrade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
    return grades.map((grade) => ({
      grade,
      due: preview[grade].card.due,
      scheduledDays: preview[grade].card.scheduled_days,
    }));
  }

  rate(state: QuestionReviewState | undefined, grade: StudyGrade, now = new Date()): QuestionReviewState {
    const current = state ?? this.createState(now);
    const result = this.scheduler.next(deserializeCard(current.card), now, grade as Grade);
    return {
      card: serializeCard(result.card),
      history: [...current.history, serializeLog(result.log)],
      lastRating: grade,
    };
  }

  undo(state: QuestionReviewState): QuestionReviewState | null {
    const lastLog = state.history.at(-1);
    if (!lastLog) return null;
    const card = this.scheduler.rollback(deserializeCard(state.card), deserializeLog(lastLog));
    const history = state.history.slice(0, -1);
    return {
      card: serializeCard(card),
      history,
      lastRating: history.at(-1)?.rating ?? null,
    };
  }

  retrievability(state: QuestionReviewState | undefined, now = new Date()): number | null {
    if (!state || state.card.state === State.New) return null;
    return this.scheduler.get_retrievability(deserializeCard(state.card), now, false);
  }

  isDue(state: QuestionReviewState | undefined, now = new Date()): boolean {
    if (!state || state.card.state === State.New) return false;
    return new Date(state.card.due).getTime() <= now.getTime();
  }

  isNew(state: QuestionReviewState | undefined): boolean {
    return !state || state.card.state === State.New;
  }

  isStable(state: QuestionReviewState | undefined, now = new Date()): boolean {
    const retrievability = this.retrievability(state, now);
    return retrievability !== null && retrievability >= this.targetRetention;
  }
}

export const FsrsSerialization = { serializeCard, deserializeCard, serializeLog, deserializeLog };

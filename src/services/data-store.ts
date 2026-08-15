import type { Plugin } from "obsidian";
import {
  DEFAULT_PLUGIN_DATA,
  DEFAULT_SETTINGS,
  MiaPluginData,
  MiaSettings,
  QuestionReviewState,
  SerializedFsrsCard,
  SerializedReviewLog,
} from "../core/models";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function configuredPath(value: string, allowInternal = false): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").trim();
  if (!normalized) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (!allowInternal && segments[0]?.toLocaleLowerCase("en") === ".obsidian") return null;
  return normalized;
}

function parseSettings(value: unknown): MiaSettings {
  const raw = isRecord(value) ? value : {};
  const roots = Array.isArray(raw.sourceRoots)
    ? [...new Set(raw.sourceRoots
      .filter((item): item is string => typeof item === "string")
      .map((item) => configuredPath(item, true))
      .filter((item): item is string => item !== null))]
    : DEFAULT_SETTINGS.sourceRoots;
  const retention = finiteNumber(raw.targetRetention, DEFAULT_SETTINGS.targetRetention);
  const keywordFolder = typeof raw.keywordFolder === "string" ? configuredPath(raw.keywordFolder) : null;
  return {
    sourceRoots: roots,
    targetRetention: Math.min(0.99, Math.max(0.7, retention)),
    maximumIntervalDays: positiveInteger(raw.maximumIntervalDays, DEFAULT_SETTINGS.maximumIntervalDays),
    keywordFolder: keywordFolder ?? DEFAULT_SETTINGS.keywordFolder,
  };
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return isNonnegativeNumber(value) && Number.isInteger(value);
}

function isCardState(value: unknown): value is number {
  return isNonnegativeInteger(value) && value <= 3;
}

function isStudyRating(value: unknown): value is number {
  return isNonnegativeInteger(value) && value >= 1 && value <= 4;
}

function parseCard(value: unknown): SerializedFsrsCard | null {
  if (!isRecord(value)) return null;
  if (!isDateString(value.due) || !isNonnegativeNumber(value.stability) || !isNonnegativeNumber(value.difficulty)) return null;
  if (!isNonnegativeNumber(value.elapsed_days) || !isNonnegativeNumber(value.scheduled_days)) return null;
  if (!isNonnegativeInteger(value.learning_steps) || !isNonnegativeInteger(value.reps) || !isNonnegativeInteger(value.lapses)) return null;
  if (!isCardState(value.state)) return null;
  if (value.last_review !== undefined && !isDateString(value.last_review)) return null;

  return {
    due: value.due,
    stability: value.stability,
    difficulty: value.difficulty,
    elapsed_days: value.elapsed_days,
    scheduled_days: value.scheduled_days,
    learning_steps: value.learning_steps,
    reps: value.reps,
    lapses: value.lapses,
    state: value.state,
    ...(value.last_review ? { last_review: value.last_review } : {}),
  };
}

function parseLog(value: unknown): SerializedReviewLog | null {
  if (!isRecord(value) || !isStudyRating(value.rating) || !isCardState(value.state)) return null;
  if (!isDateString(value.due) || !isDateString(value.review)) return null;
  if (!isNonnegativeNumber(value.stability) || !isNonnegativeNumber(value.difficulty)) return null;
  if (!isNonnegativeNumber(value.elapsed_days) || !isNonnegativeNumber(value.last_elapsed_days)) return null;
  if (!isNonnegativeNumber(value.scheduled_days) || !isNonnegativeInteger(value.learning_steps)) return null;
  return {
    rating: value.rating,
    state: value.state,
    due: value.due,
    stability: value.stability,
    difficulty: value.difficulty,
    elapsed_days: value.elapsed_days,
    last_elapsed_days: value.last_elapsed_days,
    scheduled_days: value.scheduled_days,
    learning_steps: value.learning_steps,
    review: value.review,
  };
}

function parseReview(value: unknown): QuestionReviewState | null {
  if (!isRecord(value) || !Array.isArray(value.history)) return null;
  const card = parseCard(value.card);
  if (!card) return null;
  const history: SerializedReviewLog[] = [];
  for (const entry of value.history) {
    const log = parseLog(entry);
    if (!log) return null;
    history.push(log);
  }
  return { card, history, lastRating: history.at(-1)?.rating ?? null };
}

interface ParsedReviews {
  reviews: Record<string, QuestionReviewState>;
  quarantined: Record<string, unknown>;
}

function parseReviews(value: unknown, existingQuarantine: unknown = {}): ParsedReviews {
  const reviews: Record<string, QuestionReviewState> = {};
  const quarantined: Record<string, unknown> = isRecord(existingQuarantine) ? { ...existingQuarantine } : {};
  if (!isRecord(value)) return { reviews, quarantined };
  for (const [id, rawReview] of Object.entries(value)) {
    const review = parseReview(rawReview);
    if (review) {
      reviews[id] = review;
      delete quarantined[id];
    } else {
      quarantined[id] = rawReview;
    }
  }
  return { reviews, quarantined };
}

export class MiaDataStore {
  private data: MiaPluginData = structuredClone(DEFAULT_PLUGIN_DATA);
  private saveChain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  loadWarnings: string[] = [];

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const raw: unknown = await this.plugin.loadData();
    const record = isRecord(raw) ? raw : {};
    const parsedReviews = parseReviews(record.reviews, record.quarantinedReviews);
    const quarantinedCount = Object.keys(parsedReviews.quarantined).length;
    this.loadWarnings = quarantinedCount
      ? [`손상되었거나 호환되지 않는 복습 기록 ${quarantinedCount}개를 격리했습니다.`]
      : [];
    this.data = {
      version: 1,
      settings: parseSettings(record.settings),
      reviews: parsedReviews.reviews,
      quarantinedReviews: parsedReviews.quarantined,
    };
  }

  get settings(): MiaSettings {
    return this.data.settings;
  }

  get reviews(): Readonly<Record<string, QuestionReviewState>> {
    return this.data.reviews;
  }

  getReview(questionId: string): QuestionReviewState | undefined {
    return this.data.reviews[questionId];
  }

  async updateSettings(patch: Partial<MiaSettings>): Promise<void> {
    const previous = this.data.settings;
    this.data.settings = parseSettings({ ...this.data.settings, ...patch });
    try {
      await this.persist();
    } catch (error) {
      this.data.settings = previous;
      throw error;
    }
    this.emit();
  }

  async setReview(questionId: string, state: QuestionReviewState): Promise<void> {
    const previous = this.data.reviews[questionId];
    const quarantined = this.data.quarantinedReviews[questionId];
    this.data.reviews[questionId] = state;
    delete this.data.quarantinedReviews[questionId];
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.data.reviews[questionId] = previous;
      else delete this.data.reviews[questionId];
      if (quarantined !== undefined) this.data.quarantinedReviews[questionId] = quarantined;
      throw error;
    }
    this.emit();
  }

  async removeReview(questionId: string): Promise<void> {
    const previous = this.data.reviews[questionId];
    const quarantined = this.data.quarantinedReviews[questionId];
    delete this.data.reviews[questionId];
    delete this.data.quarantinedReviews[questionId];
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.data.reviews[questionId] = previous;
      if (quarantined !== undefined) this.data.quarantinedReviews[questionId] = quarantined;
      throw error;
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.saveChain = this.saveChain.catch(() => undefined).then(() => this.plugin.saveData(snapshot));
    return this.saveChain;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const DataStoreInternals = { parseSettings, parseReviews, configuredPath };

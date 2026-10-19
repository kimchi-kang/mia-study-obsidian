import { mergeReviewData, nextReviewVersion } from "../core/review-sync";
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

function parseData(raw: unknown): MiaPluginData {
  const record = isRecord(raw) ? raw : {};
  const parsed = parseReviews(record.reviews, record.quarantinedReviews);
  const reviewVersions: Record<string, string> = {};
  if (isRecord(record.reviewVersions)) for (const [id, value] of Object.entries(record.reviewVersions)) {
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z:.+$/.test(value) && Number.isFinite(Date.parse(value.slice(0, 24)))) reviewVersions[id] = value;
  }
  const reviewConflicts: Record<string, QuestionReviewState[]> = {};
  if (isRecord(record.reviewConflicts)) for (const [id, value] of Object.entries(record.reviewConflicts)) {
    if (!Array.isArray(value)) continue;
    const states = value.map(parseReview).filter((review): review is QuestionReviewState => review !== null);
    if (states.length) reviewConflicts[id] = states;
  }
  return { version: 1, settings: parseSettings(record.settings), reviews: parsed.reviews, quarantinedReviews: parsed.quarantined, reviewVersions, reviewConflicts };
}

class ReviewChangedError extends Error {}

export interface ReviewRecovery {
  read(): unknown;
  write(data: MiaPluginData): void;
}

export class MiaDataStore {
  private data: MiaPluginData = structuredClone(DEFAULT_PLUGIN_DATA);
  private saveChain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  loadWarnings: string[] = [];

  constructor(private readonly plugin: Plugin, private readonly recovery?: ReviewRecovery) {}

  async load(): Promise<void> {
    const disk = parseData(await this.plugin.loadData());
    const recovered = this.recovery?.read();
    this.data = recovered ? mergeReviewData(parseData(recovered), disk) : disk;
    const quarantinedCount = Object.keys(this.data.quarantinedReviews).length;
    this.loadWarnings = quarantinedCount ? [`손상되었거나 호환되지 않는 복습 기록 ${quarantinedCount}개를 격리했습니다.`] : [];
  }

  get conflicts(): Readonly<Record<string, QuestionReviewState[]>> { return this.data.reviewConflicts; }

  synchronize(): Promise<void> {
    return this.enqueue(async () => {
      const incoming = parseData(await this.plugin.loadData());
      const merged = mergeReviewData(this.data, incoming);
      if (JSON.stringify(merged) !== JSON.stringify(incoming)) await this.plugin.saveData(merged);
      const changed = JSON.stringify(merged) !== JSON.stringify(this.data);
      this.data = merged;
      this.recovery?.write(merged);
      if (changed) this.emit();
    });
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
    const settings = structuredClone(patch);
    await this.commit((next) => { next.settings = parseSettings({ ...next.settings, ...settings }); });
  }

  async setReview(questionId: string, state: QuestionReviewState, expected?: { state: QuestionReviewState | undefined }): Promise<void> {
    const review = structuredClone(state);
    await this.commit((next) => {
      if (expected && JSON.stringify(next.reviews[questionId]) !== JSON.stringify(expected.state)) throw new ReviewChangedError("다른 기기에서 이 문제의 평가가 변경되었습니다. 최신 기록을 확인한 뒤 다시 평가하세요.");
      next.reviews[questionId] = review;
      next.reviewVersions[questionId] = nextReviewVersion(next.reviewVersions);
      delete next.quarantinedReviews[questionId];
    });
  }

  async removeReview(questionId: string, expected?: { state: QuestionReviewState | undefined }): Promise<void> {
    await this.removeReviews([questionId], expected);
  }

  async removeReviews(questionIds: readonly string[], expected?: { state: QuestionReviewState | undefined }): Promise<void> {
    const ids = [...new Set(questionIds)];
    if (!ids.length) return;
    await this.commit((next) => {
      for (const id of ids) {
        if (expected && JSON.stringify(next.reviews[id]) !== JSON.stringify(expected.state)) throw new ReviewChangedError("다른 기기에서 평가가 변경되어 취소하지 않았습니다.");
        next.reviewVersions[id] = nextReviewVersion(next.reviewVersions);
        delete next.reviews[id];
        delete next.quarantinedReviews[id];
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(change: (next: MiaPluginData) => void): Promise<void> {
    return this.enqueue(async () => {
      // Re-read immediately before a write; another device may have updated a different question.
      const next = mergeReviewData(this.data, parseData(await this.plugin.loadData()));
      try { change(next); }
      catch (error) {
        if (error instanceof ReviewChangedError) { this.data = next; this.emit(); }
        throw error;
      }
      await this.plugin.saveData(next);
      this.data = next;
      this.recovery?.write(next);
      this.emit();
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const write = this.saveChain.then(work);
    this.saveChain = write.catch(() => undefined);
    return write;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const DataStoreInternals = { parseSettings, parseReviews, configuredPath };

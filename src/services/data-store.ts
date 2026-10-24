import { mergeIntoOwnedIncoming, mergeReviewData, nextReviewVersion } from "../core/review-sync";
import type { PluginDataStorage } from "./verified-plugin-storage";
import {
  DEFAULT_PLUGIN_DATA,
  DEFAULT_SETTINGS,
  GradeIntervalsMinutes,
  MAX_GRADE_INTERVAL_MINUTES,
  MiaPluginData,
  MiaSettings,
  QuestionReviewState,
  SerializedFsrsCard,
  SerializedReviewLog,
} from "../core/models";

const RESERVED_REVIEW_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

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
  const gradeIntervalsMinutes: GradeIntervalsMinutes = {};
  if (isRecord(raw.gradeIntervalsMinutes)) {
    for (const grade of [1, 2, 3, 4] as const) {
      const minutes = raw.gradeIntervalsMinutes[grade];
      if (Object.hasOwn(raw.gradeIntervalsMinutes, grade) && typeof minutes === "number"
        && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_GRADE_INTERVAL_MINUTES) gradeIntervalsMinutes[grade] = minutes;
    }
  }
  return {
    sourceRoots: roots,
    targetRetention: Math.min(0.99, Math.max(0.7, retention)),
    maximumIntervalDays: positiveInteger(raw.maximumIntervalDays, DEFAULT_SETTINGS.maximumIntervalDays),
    gradeIntervalsMinutes,
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
    } else {
      if (Object.hasOwn(quarantined, id) && JSON.stringify(quarantined[id]) !== JSON.stringify(rawReview)) {
        throw new InvalidReviewDataError("같은 문제의 격리 원본이 서로 달라 저장을 중단했습니다. 원본들을 백업한 뒤 확인하세요.");
      }
      quarantined[id] = rawReview;
    }
  }
  return { reviews, quarantined };
}

class InvalidReviewDataError extends Error {}

function assertReviewKey(id: string): void {
  if (RESERVED_REVIEW_KEYS.has(id)) {
    throw new InvalidReviewDataError("복습 기록에 안전하게 처리할 수 없는 문제 키가 있습니다. 원본을 덮어쓰지 않았습니다.");
  }
}
class UnsupportedReviewDataVersionError extends InvalidReviewDataError {}

function parseData(raw: unknown): MiaPluginData {
  if (raw === null || raw === undefined) return structuredClone(DEFAULT_PLUGIN_DATA);
  if (!isRecord(raw)) throw new InvalidReviewDataError("복습 기록의 저장 형식이 손상되었습니다. 원본을 덮어쓰지 않았습니다.");
  const record = raw;
  if (record.version !== undefined && record.version !== 1) {
    throw new UnsupportedReviewDataVersionError("이 버전에서 지원하지 않는 복습 기록입니다. 모든 기기의 플러그인 버전을 확인하세요.");
  }
  for (const field of ["settings", "reviews", "quarantinedReviews", "reviewVersions", "reviewConflicts"]) {
    if (record[field] !== undefined && !isRecord(record[field])) {
      throw new InvalidReviewDataError("복습 기록의 저장 형식이 손상되었습니다. 원본을 덮어쓰지 않았습니다.");
    }
    // Reject inherited object keys before plain record maps can reinterpret them.
    if (field !== "settings" && isRecord(record[field])) {
      for (const id of Object.keys(record[field])) assertReviewKey(id);
    }
  }
  const parsed = parseReviews(record.reviews, record.quarantinedReviews);
  const reviewVersions: Record<string, string> = {};
  if (isRecord(record.reviewVersions)) for (const [id, value] of Object.entries(record.reviewVersions)) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z:.+$/.test(value) || !Number.isFinite(Date.parse(value.slice(0, 24)))) {
      throw new InvalidReviewDataError("복습 기록의 수정 번호가 손상되어 저장을 중단했습니다.");
    }
    reviewVersions[id] = value;
  }
  const reviewConflicts: Record<string, QuestionReviewState[]> = {};
  if (isRecord(record.reviewConflicts)) for (const [id, value] of Object.entries(record.reviewConflicts)) {
    if (!Array.isArray(value)) throw new InvalidReviewDataError("보관된 평가 이력이 손상되어 저장을 중단했습니다.");
    const states: QuestionReviewState[] = [];
    for (const entry of value) {
      const state = parseReview(entry);
      if (!state) throw new InvalidReviewDataError("보관된 평가 이력이 손상되어 저장을 중단했습니다.");
      states.push(state);
    }
    if (states.length) reviewConflicts[id] = states;
  }
  return { version: 1, settings: parseSettings(record.settings), reviews: parsed.reviews, quarantinedReviews: parsed.quarantined, reviewVersions, reviewConflicts };
}

class ReviewChangedError extends Error {}

export interface ReviewRecovery {
  read(): unknown;
  write(data: MiaPluginData): void;
  onWarning?(message: string): void;
}

export class MiaDataStore {
  private data: MiaPluginData = structuredClone(DEFAULT_PLUGIN_DATA);
  private saveChain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private recoveryWriteFailed = false;
  private recoveryReadFailed = false;
  loadWarnings: string[] = [];

  constructor(private readonly plugin: PluginDataStorage, private readonly recovery?: ReviewRecovery) {}

  async load(): Promise<void> {
    this.loadWarnings = [];
    this.recoveryReadFailed = false;
    let disk: MiaPluginData | undefined;
    let diskMissing = false;
    let diskError: unknown;
    try {
      const raw = await this.plugin.loadData();
      diskMissing = raw === null || raw === undefined;
      disk = parseData(raw);
    } catch (error) {
      if (error instanceof UnsupportedReviewDataVersionError) throw error;
      diskError = error;
    }
    let recovered: MiaPluginData | undefined;
    try {
      const raw = this.recovery?.read();
      if (raw !== null && raw !== undefined) recovered = parseData(raw);
    }
    catch {
      this.recoveryReadFailed = true;
      this.loadWarnings.push("기기 내 복구 사본을 읽지 못했습니다. 복구 원본을 보존하기 위해 이번 실행에서는 사본을 갱신하지 않습니다. 저장소 상태를 확인한 뒤 다시 시작하세요.");
    }
    if (!disk) {
      if (!recovered) throw diskError;
      this.data = recovered;
      this.loadWarnings.push("보관함의 복습 기록을 읽지 못해 기기 내 복구 사본을 불러왔습니다. 원본 오류가 해결되기 전에는 평가를 저장할 수 없습니다.");
    } else {
      // Both states were freshly parsed above and are owned by this load.
      this.data = recovered ? (diskMissing ? recovered : mergeIntoOwnedIncoming(recovered, disk)) : disk;
    }
    const quarantinedCount = Object.keys(this.data.quarantinedReviews).length;
    if (quarantinedCount) this.loadWarnings.push(`손상되었거나 호환되지 않는 복습 기록 ${quarantinedCount}개를 격리했습니다.`);
  }

  get conflicts(): Readonly<Record<string, QuestionReviewState[]>> { return this.data.reviewConflicts; }

  synchronize(): Promise<void> {
    return this.enqueue(async () => {
      const incoming = parseData(await this.plugin.loadData());
      const merged = mergeReviewData(this.data, incoming);
      let mergedText = JSON.stringify(merged);
      if (mergedText !== JSON.stringify(incoming)) {
        // Release the large snapshot across I/O and compare the post-write value.
        mergedText = "";
        await this.persist(merged);
        mergedText = JSON.stringify(merged);
      }
      const changed = mergedText !== JSON.stringify(this.data);
      this.data = merged;
      this.writeRecovery(merged);
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
    return Object.hasOwn(this.data.reviews, questionId) ? this.data.reviews[questionId] : undefined;
  }

  getReviewVersion(questionId: string): string | null { return Object.hasOwn(this.data.reviewVersions, questionId) ? this.data.reviewVersions[questionId]! : null; }

  async updateSettings(patch: Partial<MiaSettings>): Promise<void> {
    const settings = structuredClone(patch);
    await this.commit((next) => { next.settings = parseSettings({ ...next.settings, ...settings }); });
  }

  async setReview(questionId: string, state: QuestionReviewState, expected?: { state: QuestionReviewState | undefined }): Promise<void> {
    assertReviewKey(questionId);
    const review = structuredClone(state);
    await this.commit((next) => {
      if (expected && JSON.stringify(next.reviews[questionId]) !== JSON.stringify(expected.state)) throw new ReviewChangedError("다른 기기에서 이 문제의 평가가 변경되었습니다. 최신 기록을 확인한 뒤 다시 평가하세요.");
      next.reviews[questionId] = review;
      next.reviewVersions[questionId] = nextReviewVersion(next.reviewVersions);
    });
  }

  async removeReview(questionId: string, expected?: { state: QuestionReviewState | undefined }): Promise<void> {
    await this.removeReviews([questionId], expected);
  }

  async removeReviews(questionIds: readonly string[], expected?: { state: QuestionReviewState | undefined }): Promise<void> {
    const ids = [...new Set(questionIds)];
    if (!ids.length) return;
    for (const id of ids) assertReviewKey(id);
    await this.commit((next) => {
      if (expected) {
        for (const id of ids) {
          if (JSON.stringify(next.reviews[id]) !== JSON.stringify(expected.state)) throw new ReviewChangedError("다른 기기에서 평가가 변경되어 취소하지 않았습니다.");
        }
      }
      const revision = nextReviewVersion(next.reviewVersions);
      for (const id of ids) {
        next.reviewVersions[id] = revision;
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
      const next = mergeIntoOwnedIncoming(this.data, parseData(await this.plugin.loadData()));
      try { change(next); }
      catch (error) {
        if (error instanceof ReviewChangedError) { this.data = next; this.emit(); }
        throw error;
      }
      await this.persist(next);
      this.data = next;
      this.writeRecovery(next);
      this.emit();
    });
  }

  private async persist(data: MiaPluginData): Promise<void> {
    try { await this.plugin.saveData(data); }
    catch (error) {
      // A rejected write may already have reached disk; confirm before reporting failure.
      let persisted: MiaPluginData;
      try { persisted = parseData(await this.plugin.loadData()); }
      catch { throw error; }
      if (JSON.stringify(persisted) !== JSON.stringify(data)) throw error;
    }
  }

  private writeRecovery(data: MiaPluginData): void {
    if (!this.recovery || this.recoveryReadFailed) return;
    try {
      this.recovery.write(data);
      this.recoveryWriteFailed = false;
    } catch {
      const alreadyWarned = this.recoveryWriteFailed;
      this.recoveryWriteFailed = true;
      if (!alreadyWarned) this.recovery.onWarning?.("현재 기록은 반영되었지만 기기 내 복구 사본을 저장하지 못했습니다. 저장 공간과 로컬 저장소 상태를 확인하세요.");
    }
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

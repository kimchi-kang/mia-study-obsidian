import type { App, DataAdapter } from "obsidian";
import { SwipeSensitivity } from "../core/study-swipe";
import { MiaSessionMode, ReviewCheckpoint, parseReviewCheckpoint } from "../core/navigation";
import type { StudyGrade } from "../core/fsrs-service";

export interface StudySessionSummary {
  startedAt: number;
  grades: { id: string; grade: StudyGrade }[];
}

export interface StudyAppearance {
  size: "small" | "medium" | "large";
  density: "compact" | "detailed";
  focus: boolean;
  answerLayout: "stacked" | "split";
  memorizationOrder: "sequential" | "random";
  swipeEnabled: boolean;
  swipeSensitivity: SwipeSensitivity;
}
export interface StudyResume {
  queue: string[];
  seed: string[];
  skipped: string[];
  queueIndex: number;
  answerVisible: boolean;
  sessionMode: MiaSessionMode;
  updatedAt: string;
  scrollTop?: number;
  pageScrollTop?: number;
  conceptsOpen?: boolean;
  reviewCheckpoint?: ReviewCheckpoint;
  sessionSummary?: StudySessionSummary;
}

function parseSessionSummary(value: unknown, queue: string[]): StudySessionSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt) || raw.startedAt < 0 || !Array.isArray(raw.grades)) return undefined;
  const grades: StudySessionSummary["grades"] = [];
  const ids = new Set<string>();
  const scope = new Set(queue);
  for (const entry of raw.grades) {
    if (!entry || typeof entry !== "object") return undefined;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !scope.has(item.id) || ids.has(item.id)
      || (item.grade !== 1 && item.grade !== 2 && item.grade !== 3 && item.grade !== 4)) return undefined;
    ids.add(item.id);
    grades.push({ id: item.id, grade: item.grade });
  }
  return { startedAt: raw.startedAt, grades };
}

export function parseStudyResume(value: unknown): StudyResume | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.queue) || !raw.queue.length || !raw.queue.every((id) => typeof id === "string" && id.length > 0)) return null;
  if (typeof raw.queueIndex !== "number" || !Number.isInteger(raw.queueIndex) || raw.queueIndex < 0 || raw.queueIndex > raw.queue.length) return null;
  if (raw.sessionMode !== "recall" && raw.sessionMode !== "browse") return null;
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) return null;
  const checkpoint = raw.reviewCheckpoint === undefined ? undefined : parseReviewCheckpoint(raw.reviewCheckpoint);
  if (checkpoint === null) return null;
  const seed = Array.isArray(raw.seed) && raw.seed.every((id) => typeof id === "string" && id.length > 0) ? raw.seed : raw.queue;
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter((id): id is string => typeof id === "string") : [];
  const sessionSummary = parseSessionSummary(raw.sessionSummary, raw.queue);
  return { queue: [...raw.queue], seed: [...seed], skipped, queueIndex: raw.queueIndex, answerVisible: raw.answerVisible === true, sessionMode: raw.sessionMode, updatedAt: raw.updatedAt,
    ...(sessionSummary ? { sessionSummary } : {}),
    ...(checkpoint ? { reviewCheckpoint: checkpoint } : {}),
    ...(typeof raw.scrollTop === "number" && Number.isFinite(raw.scrollTop) && raw.scrollTop >= 0 ? { scrollTop: raw.scrollTop } : {}),
    ...(typeof raw.pageScrollTop === "number" && Number.isFinite(raw.pageScrollTop) && raw.pageScrollTop >= 0 ? { pageScrollTop: raw.pageScrollTop } : {}),
    ...(typeof raw.conceptsOpen === "boolean" ? { conceptsOpen: raw.conceptsOpen } : {}),
  };
}

export function parseStudyAppearance(value: unknown): StudyAppearance {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    size: raw.size === "small" || raw.size === "large" ? raw.size : "medium",
    density: raw.density === "compact" ? "compact" : "detailed",
    focus: raw.focus === true,
    answerLayout: raw.answerLayout === "split" ? "split" : "stacked",
    memorizationOrder: raw.memorizationOrder === "sequential" ? "sequential" : "random",
    swipeEnabled: raw.swipeEnabled !== false,
    swipeSensitivity: raw.swipeSensitivity === "light" || raw.swipeSensitivity === "firm" ? raw.swipeSensitivity : "normal",
  };
}

type StudyUiHost = Pick<App, "loadLocalStorage" | "saveLocalStorage"> & { vault: { adapter: Pick<DataAdapter, "exists" | "read" | "write"> } };

// Keep in-flight ordering across plugin module reloads in the same Obsidian App.
const RESUME_WRITES = Symbol.for("mia-study:resume-writes:v1");
interface ResumeWrites { pending: Promise<void>; checkpointRevision: number }
interface ResumeWriteHost { [RESUME_WRITES]?: Map<string, ResumeWrites> }
function resumeWrites(app: StudyUiHost, path: string): ResumeWrites {
  const host: StudyUiHost & ResumeWriteHost = app;
  let paths = host[RESUME_WRITES];
  if (!paths) {
    paths = new Map();
    Object.defineProperty(host, RESUME_WRITES, { value: paths });
  }
  let writes = paths.get(path);
  if (!writes) { writes = { pending: Promise.resolve(), checkpointRevision: 0 }; paths.set(path, writes); }
  return writes;
}

/** Resume travels with the vault; reading preferences remain local to each device. */
export class StudyUiStore {
  private currentResume: StudyResume | null = null;
  private committedResume: StudyResume | null = null;
  private currentAppearance: StudyAppearance;
  private revision = 0;
  private filePresent = false;
  private committedUpdatedAt = "1970-01-01T00:00:00.000Z";
  private readonly resumeKey: string;
  private writes: Promise<void> = Promise.resolve();
  private readonly preferenceKey: string;
  private readonly sharedWrites: ResumeWrites;

  private readonly adapter: Pick<DataAdapter, "exists" | "read" | "write">;

  constructor(private readonly app: StudyUiHost, private readonly path: string, options: { localStatePath?: string; adapter?: Pick<DataAdapter, "exists" | "read" | "write"> } = {}) {
    this.sharedWrites = resumeWrites(app, path);
    const localPath = options.localStatePath ?? path;
    this.adapter = options.adapter ?? app.vault.adapter;
    this.preferenceKey = `mia-study:appearance:${localPath}`;
    this.resumeKey = `mia-study:resume-checkpoint:${localPath}`;
    this.currentAppearance = parseStudyAppearance(app.loadLocalStorage(this.preferenceKey));
  }
  get resume(): StudyResume | null { return this.currentResume ? structuredClone(this.currentResume) : null; }
  get sharedSnapshot(): { version: 1; resume: StudyResume | null; updatedAt: string } {
    return { version: 1, resume: this.resume, updatedAt: this.committedUpdatedAt };
  }
  get appearance(): StudyAppearance { return { ...this.currentAppearance }; }
  get hasResumeFile(): boolean { return this.filePresent; }
  get resumeRevision(): number { return this.sharedWrites.checkpointRevision; }

  async load(): Promise<void> {
    const revision = this.revision;
    // A local move still being saved must finish before checking the synced file.
    await this.writes;
    const adapter = this.adapter;
    const exists = await adapter.exists(this.path);
    const raw: unknown = exists ? JSON.parse(await adapter.read(this.path)) : { version: 1, resume: null };
    if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("resume" in raw)) throw new Error("이어하기 파일 형식을 확인하세요.");
    const resume = parseStudyResume(raw.resume);
    if (raw.resume !== null && !resume) throw new Error("이어하기 정보가 손상되었습니다.");
    const diskTime = "updatedAt" in raw && typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : resume?.updatedAt ?? "1970-01-01T00:00:00.000Z";
    const checkpoint: unknown = this.app.loadLocalStorage(this.resumeKey);
    let chosen = resume, updatedAt = diskTime;
    if (checkpoint && typeof checkpoint === "object" && "resume" in checkpoint && "updatedAt" in checkpoint && typeof checkpoint.updatedAt === "string" && Number.isFinite(Date.parse(checkpoint.updatedAt))) {
      const local = parseStudyResume(checkpoint.resume);
      if ((checkpoint.resume === null || local) && Date.parse(checkpoint.updatedAt) > Date.parse(diskTime)) { chosen = local; updatedAt = checkpoint.updatedAt; }
    }
    if (revision === this.revision) { this.currentResume = chosen; this.committedResume = chosen; this.committedUpdatedAt = updatedAt; this.filePresent = exists; }
  }

  saveResume(resume: StudyResume | null): Promise<void> {
    const revision = ++this.revision;
    this.currentResume = resume ? structuredClone(resume) : null;
    const snapshot = this.currentResume;
    const editTime = snapshot?.updatedAt ?? new Date().toISOString();
    const checkpoint = { version: 1, resume: this.currentResume, updatedAt: editTime };
    // Synchronous device checkpoint survives suspension before an asynchronous cloud write finishes.
    try { this.app.saveLocalStorage(this.resumeKey, checkpoint); }
    catch (error) { this.currentResume = this.committedResume; return Promise.reject(error); }
    const checkpointRevision = ++this.sharedWrites.checkpointRevision;
    const payload = JSON.stringify(checkpoint, null, 2);
    const write = this.sharedWrites.pending.then(async () => {
      const adapter = this.adapter;
      if (await adapter.exists(this.path)) {
        const raw: unknown = JSON.parse(await adapter.read(this.path));
        if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("resume" in raw)) throw new Error("이어하기 파일 형식을 확인하세요.");
        const remote = parseStudyResume(raw.resume);
        if (raw.resume !== null && !remote) throw new Error("이어하기 정보가 손상되었습니다.");
        const remoteTime = "updatedAt" in raw && typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : remote?.updatedAt ?? "1970-01-01T00:00:00.000Z";
        if (Date.parse(remoteTime) > Date.parse(editTime)) {
          this.committedResume = remote; this.committedUpdatedAt = remoteTime;
          throw new Error("다른 기기의 더 최근 이어하기 위치가 있어 덮어쓰지 않았습니다. 시작 화면에서 이어하기를 다시 선택하세요.");
        }
      }
      await adapter.write(this.path, payload);
      this.committedResume = snapshot;
      this.committedUpdatedAt = editTime;
      this.filePresent = true;
    });
    // Keep later saves usable; each caller still receives its own write failure.
    this.writes = write.catch(() => {});
    this.sharedWrites.pending = this.writes;
    return write.catch((error: unknown) => {
      if (revision === this.revision) {
        this.currentResume = this.committedResume;
        if (checkpointRevision === this.sharedWrites.checkpointRevision) {
          this.app.saveLocalStorage(this.resumeKey, { version: 1, resume: this.committedResume, updatedAt: this.committedUpdatedAt });
        }
      }
      throw error;
    });
  }

  updateAppearance(patch: Partial<StudyAppearance>): void {
    const next = parseStudyAppearance({ ...this.currentAppearance, ...patch });
    this.app.saveLocalStorage(this.preferenceKey, next);
    this.currentAppearance = next;
  }
}

import type { App, EventRef, TAbstractFile, TFile } from "obsidian";
import { ParsedQuestionFile, QuestionDiagnostic, QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";

function inSourceRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => {
    const normalized = root.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function subjectForPath(path: string, roots: string[]): string | undefined {
  const normalizedPath = path.replaceAll("\\", "/");
  const matchingRoot = roots
    .map((root) => root.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""))
    .filter((root) => normalizedPath.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (!matchingRoot) return undefined;
  const relativeParts = normalizedPath.slice(matchingRoot.length + 1).split("/").filter(Boolean);
  return relativeParts.length >= 2 ? relativeParts[0] : "미분류";
}

type RegisteredQuestion = QuestionRecord & { id: string };

function registeredQuestions(questions: QuestionRecord[]): RegisteredQuestion[] {
  return questions.filter((question): question is RegisteredQuestion => question.id !== null);
}

function duplicateIdSet(questions: RegisteredQuestion[]): Set<string> {
  const counts = new Map<string, number>();
  for (const question of questions) counts.set(question.id, (counts.get(question.id) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function uniqueRegisteredQuestions(questions: QuestionRecord[]): RegisteredQuestion[] {
  const registered = registeredQuestions(questions);
  const duplicates = duplicateIdSet(registered);
  return registered.filter((question) => !duplicates.has(question.id));
}

/** Questions hidden because the same ID is claimed by more than one file (typically a sync-app copy). */
export interface CrossFileDuplicateSummary {
  /** Distinct question IDs that are hidden from lists and study because of cross-file duplicates. */
  hiddenQuestions: number;
  /** Every file involved, with the other files it shares at least one ID with. Sorted by path. */
  files: Array<{ filePath: string; hiddenQuestions: number; sharesWith: string[] }>;
}

const MAX_NAMED_DUPLICATE_FILES = 3;

function otherFilesLabel(paths: string[]): string {
  const shown = paths.slice(0, MAX_NAMED_DUPLICATE_FILES).join(", ");
  return paths.length > MAX_NAMED_DUPLICATE_FILES ? `${shown} 외 ${paths.length - MAX_NAMED_DUPLICATE_FILES}개` : shown;
}

export class QuestionIndex {
  private readonly byFile = new Map<string, ParsedQuestionFile>();
  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private cachedSnapshot: {
    registered: RegisteredQuestion[];
    byId: Map<string, RegisteredQuestion>;
    candidates: QuestionRecord[];
    diagnostics: QuestionDiagnostic[];
    duplicates: CrossFileDuplicateSummary;
  } | undefined;
  private eventRefs: EventRef[] = [];
  private startPromise: Promise<void> | undefined;
  private refreshTimers = new Map<string, number>();
  private revision = 0;
  private rebuildRevision = 0;
  private lifetime = 0;
  private readonly pathRevisions = new Map<string, number>();

  constructor(
    private readonly app: App,
    private readonly getSourceRoots: () => string[],
    private readonly getManagedRoot?: () => string,
  ) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const lifetime = this.lifetime;
    this.eventRefs.push(this.app.vault.on("create", (file) => this.onCreateOrModify(file)));
    this.eventRefs.push(this.app.vault.on("modify", (file) => this.onCreateOrModify(file)));
    this.eventRefs.push(this.app.vault.on("delete", (file) => this.remove(file.path)));
    this.eventRefs.push(this.app.vault.on("rename", (file, oldPath) => {
      this.remove(oldPath);
      if ("extension" in file) this.onCreateOrModify(file);
      else for (const child of this.app.vault.getMarkdownFiles()) {
        if (child.path.startsWith(`${file.path}/`)) this.onCreateOrModify(child);
      }
    }));
    this.startPromise = this.rebuild().catch((error: unknown) => {
      if (this.lifetime === lifetime) this.stop();
      throw error;
    });
    return this.startPromise;
  }

  stop(): void {
    this.lifetime += 1;
    this.startPromise = undefined;
    this.eventRefs.forEach((eventRef) => this.app.vault.offref(eventRef));
    this.eventRefs = [];
    for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
    this.refreshTimers.clear();
  }

  async rebuild(): Promise<void> {
    const rebuildRevision = ++this.rebuildRevision;
    const revision = ++this.revision;
    const lifetime = this.lifetime;
    const files = this.app.vault.getMarkdownFiles().filter((file) => inSourceRoots(file.path, this.getSourceRoots()));
    // Track even unread files so a folder deletion can invalidate their results.
    for (const file of files) this.pathRevisions.set(file.path, revision);
    const parsed = await Promise.all(files.map(async (file) => this.parse(file)));
    if (lifetime !== this.lifetime || rebuildRevision !== this.rebuildRevision) return;
    for (const path of this.byFile.keys()) {
      if ((this.pathRevisions.get(path) ?? 0) <= revision) this.byFile.delete(path);
    }
    for (const item of parsed) {
      if ((this.pathRevisions.get(item.filePath) ?? 0) <= revision && inSourceRoots(item.filePath, this.getSourceRoots())) this.byFile.set(item.filePath, item);
    }
    this.initialized = true;
    this.emit();
  }

  get isReady(): boolean {
    return this.initialized;
  }

  get registered(): Array<QuestionRecord & { id: string }> {
    return this.snapshot.registered.slice();
  }

  get candidates(): QuestionRecord[] {
    return this.snapshot.candidates.slice();
  }

  get diagnostics(): QuestionDiagnostic[] {
    return this.snapshot.diagnostics.slice();
  }

  /** Cross-file duplicate IDs, grouped by file. Empty when no ID spans two files. */
  get crossFileDuplicates(): CrossFileDuplicateSummary {
    const { hiddenQuestions, files } = this.snapshot.duplicates;
    return { hiddenQuestions, files: files.map(file => ({ ...file, sharesWith: file.sharesWith.slice() })) };
  }

  questionById(id: string): RegisteredQuestion | undefined {
    return this.snapshot.byId.get(id);
  }

  questionsInFile(path: string): QuestionRecord[] {
    return this.byFile.get(path)?.questions ?? [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshFile(file: TFile): Promise<void> {
    const path = file.path;
    if (file.extension !== "md" || !inSourceRoots(path, this.getSourceRoots())) {
      this.remove(path);
      return;
    }
    const revision = ++this.revision;
    const lifetime = this.lifetime;
    this.pathRevisions.set(path, revision);
    const parsed = await this.parse(file);
    if (lifetime !== this.lifetime || this.pathRevisions.get(path) !== revision || file.path !== path || !inSourceRoots(path, this.getSourceRoots())) return;
    this.byFile.set(path, parsed);
    this.emit();
  }

  private get snapshot(): NonNullable<QuestionIndex["cachedSnapshot"]> {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const all = [...this.byFile.values()].flatMap(file => file.questions);
    const registered = uniqueRegisteredQuestions(all);
    const diagnostics = [...this.byFile.values()].flatMap(file => file.diagnostics);
    const locations = new Map<string, RegisteredQuestion[]>();
    for (const question of registeredQuestions(all)) {
      const list = locations.get(question.id) ?? [];
      list.push(question);
      locations.set(question.id, list);
    }
    const perFile = new Map<string, { hidden: number; sharesWith: Set<string> }>();
    const hiddenIds = new Set<string>();
    for (const [id, questions] of locations) {
      if (questions.length < 2) continue;
      const paths = [...new Set(questions.map(question => question.filePath))].sort();
      const crossFile = paths.length > 1;
      if (crossFile) hiddenIds.add(id);
      for (const question of questions) {
        const others = paths.filter(path => path !== question.filePath);
        if (crossFile) {
          const entry = perFile.get(question.filePath) ?? { hidden: 0, sharesWith: new Set<string>() };
          entry.hidden += 1;
          for (const path of others) entry.sharesWith.add(path);
          perFile.set(question.filePath, entry);
        }
        diagnostics.push({
          filePath: question.filePath,
          line: question.location.anchorLine ?? question.location.questionStartLine,
          code: "duplicate-id",
          message: crossFile
            ? `여러 파일에서 중복된 문제 ID: ${id} · 같은 ID가 있는 다른 파일: ${otherFilesLabel(others)}`
            : `여러 파일에서 중복된 문제 ID: ${id}`,
        });
      }
    }
    const duplicates: CrossFileDuplicateSummary = {
      hiddenQuestions: hiddenIds.size,
      files: [...perFile].sort(([left], [right]) => left.localeCompare(right))
        .map(([filePath, entry]) => ({ filePath, hiddenQuestions: entry.hidden, sharesWith: [...entry.sharesWith].sort() })),
    };
    this.cachedSnapshot = {
      registered, byId: new Map(registered.map(question => [question.id, question])),
      candidates: all.filter(question => question.id === null), diagnostics, duplicates,
    };
    return this.cachedSnapshot;
  }

  private async parse(file: TFile): Promise<ParsedQuestionFile> {
    const path = file.path;
    try {
      const roots = this.getSourceRoots();
      const subject = subjectForPath(path, roots.length === 0 && this.getManagedRoot ? [this.getManagedRoot()] : roots);
      return parseQuestionFile(path, await this.app.vault.cachedRead(file), subject ? { subject } : {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        filePath: path,
        questions: [],
        diagnostics: [{
          filePath: path,
          line: 0,
          code: "read-error",
          message: `노트를 읽지 못했습니다: ${reason}`,
        }],
      };
    }
  }

  private onCreateOrModify(file: TAbstractFile): void {
    if (!("extension" in file) || file.extension !== "md") return;
    const markdownFile = file as TFile;
    const previous = this.refreshTimers.get(file.path);
    if (previous !== undefined) window.clearTimeout(previous);
    this.refreshTimers.set(file.path, window.setTimeout(() => {
      this.refreshTimers.delete(file.path);
      void this.refreshFile(markdownFile);
    }, 150));
  }

  private remove(path: string, notify = true): void {
    const revision = ++this.revision;
    const paths = new Set([path, ...this.pathRevisions.keys(), ...this.byFile.keys(), ...this.refreshTimers.keys()]);
    let changed = false;
    for (const candidate of paths) {
      if (candidate !== path && !candidate.startsWith(`${path}/`)) continue;
      this.pathRevisions.set(candidate, revision);
      const timer = this.refreshTimers.get(candidate);
      if (timer !== undefined) window.clearTimeout(timer);
      this.refreshTimers.delete(candidate);
      changed = this.byFile.delete(candidate) || changed;
    }
    if (changed) this.cachedSnapshot = undefined;
    if (notify && changed) this.emit();
  }

  private emit(): void {
    this.cachedSnapshot = undefined;
    for (const listener of this.listeners) listener();
  }
}

export const QuestionIndexInternals = { inSourceRoots, subjectForPath, uniqueRegisteredQuestions };

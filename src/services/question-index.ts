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

export class QuestionIndex {
  private readonly byFile = new Map<string, ParsedQuestionFile>();
  private readonly listeners = new Set<() => void>();
  private eventRefs: EventRef[] = [];
  private refreshTimers = new Map<string, number>();

  constructor(
    private readonly app: App,
    private readonly getSourceRoots: () => string[],
  ) {}

  async start(): Promise<void> {
    await this.rebuild();
    this.eventRefs.push(this.app.vault.on("create", (file) => this.onCreateOrModify(file)));
    this.eventRefs.push(this.app.vault.on("modify", (file) => this.onCreateOrModify(file)));
    this.eventRefs.push(this.app.vault.on("delete", (file) => this.remove(file.path)));
    this.eventRefs.push(this.app.vault.on("rename", (file, oldPath) => {
      this.remove(oldPath, false);
      this.onCreateOrModify(file);
    }));
  }

  stop(): void {
    this.eventRefs.forEach((eventRef) => this.app.vault.offref(eventRef));
    this.eventRefs = [];
    for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
    this.refreshTimers.clear();
  }

  async rebuild(): Promise<void> {
    this.byFile.clear();
    const files = this.app.vault.getMarkdownFiles().filter((file) => inSourceRoots(file.path, this.getSourceRoots()));
    const parsed = await Promise.all(files.map(async (file) => this.parse(file)));
    for (const item of parsed) this.byFile.set(item.filePath, item);
    this.emit();
  }

  get registered(): Array<QuestionRecord & { id: string }> {
    return uniqueRegisteredQuestions(this.allQuestions);
  }

  get candidates(): QuestionRecord[] {
    return this.allQuestions.filter((question) => question.id === null);
  }

  get diagnostics(): QuestionDiagnostic[] {
    const diagnostics = [...this.byFile.values()].flatMap((file) => file.diagnostics);
    const locations = new Map<string, QuestionRecord[]>();
    for (const question of registeredQuestions(this.allQuestions)) {
      const list = locations.get(question.id) ?? [];
      list.push(question);
      locations.set(question.id, list);
    }
    for (const [id, questions] of locations) {
      if (questions.length < 2) continue;
      for (const question of questions) {
        diagnostics.push({
          filePath: question.filePath,
          line: question.location.anchorLine ?? question.location.questionStartLine,
          code: "duplicate-id",
          message: `여러 파일에서 중복된 문제 ID: ${id}`,
        });
      }
    }
    return diagnostics;
  }

  questionById(id: string): (QuestionRecord & { id: string }) | undefined {
    return this.registered.find((question) => question.id === id);
  }

  questionsInFile(path: string): QuestionRecord[] {
    return this.byFile.get(path)?.questions ?? [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshFile(file: TFile): Promise<void> {
    if (file.extension !== "md" || !inSourceRoots(file.path, this.getSourceRoots())) {
      this.remove(file.path);
      return;
    }
    this.byFile.set(file.path, await this.parse(file));
    this.emit();
  }

  private get allQuestions(): QuestionRecord[] {
    return [...this.byFile.values()].flatMap((file) => file.questions);
  }

  private async parse(file: TFile): Promise<ParsedQuestionFile> {
    try {
      const subject = subjectForPath(file.path, this.getSourceRoots());
      return parseQuestionFile(file.path, await this.app.vault.cachedRead(file), subject ? { subject } : {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        filePath: file.path,
        questions: [],
        diagnostics: [{
          filePath: file.path,
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
    const timer = this.refreshTimers.get(path);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.refreshTimers.delete(path);
    }
    if (!this.byFile.delete(path)) return;
    if (notify) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const QuestionIndexInternals = { inSourceRoots, subjectForPath, uniqueRegisteredQuestions };

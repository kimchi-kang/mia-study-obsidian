import { Notice, TFile, normalizePath } from "obsidian";
import { validateKeywordMeaning } from "../core/keyword-note";
import { keywordNotePath } from "../core/keyword-path";
import {
  appendManagedQuestion,
  createSubjectBank,
  deleteCurrentManagedQuestion,
  replaceCurrentManagedQuestion,
  validateManagedQuestionInput,
  validateSubjectName,
  type ManagedQuestionDraft,
} from "../core/managed-question";
import { rebaseMarkdownLinks } from "../core/markdown-links";
import type { QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";
import {
  assertQuestionUnchanged,
  createQuestionId,
  findCurrentQuestion,
  registerQuestion,
  updateQuestionMetadata,
  type QuestionMetadataInput,
} from "../core/question-writer";
import { applyFileChanges, type FileChange } from "./file-change-batch";
import type { FollowUpLinks } from "./follow-up-links";
import type { KeywordOperations } from "./keyword-operations";
import type { MiaHost } from "./mia-host";
import type { SubjectNotes } from "./subject-notes";
import { assertPortablePath, ensureFolder } from "./vault-files";

type RegisteredQuestion = QuestionRecord & { id: string };

/**
 * Writes question blocks in subject banks. The source bank is always written
 * first; derived notes and links are refreshed after, and a failure there is
 * reported without losing the saved question.
 */
export class QuestionOperations {
  constructor(
    private readonly host: MiaHost,
    private readonly notes: SubjectNotes,
    private readonly keywords: KeywordOperations,
    private readonly followUps: FollowUpLinks,
  ) {}

  /** Registers a hand-written question with MIA, or updates its study metadata. */
  async writeMetadata(question: QuestionRecord, metadata: QuestionMetadataInput): Promise<void> {
    const { app } = this.host;
    const file = app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    const id = question.id ?? createQuestionId();
    const now = new Date().toISOString();
    await app.vault.process(file, (content) => {
      const latest = findCurrentQuestion(parseQuestionFile(question.filePath, content).questions, question);
      if (!latest) throw new Error("원문이 바뀌어 문제 위치를 안전하게 찾지 못했습니다. 창을 닫고 다시 등록해 주세요.");
      assertQuestionUnchanged(question, latest);
      const next = { ...metadata, createdAt: latest.createdAt ?? now, updatedAt: now };
      return latest.id ? updateQuestionMetadata(content, latest, next) : registerQuestion(content, latest, next, id);
    });
    await this.host.index.refreshFile(file);
    new Notice(question.id ? "MIA 학습 정보를 저장했습니다." : "문제를 MIA에 등록했습니다.");
  }

  async create(draft: ManagedQuestionDraft, onPersisted?: (question: QuestionRecord) => void): Promise<void> {
    const { app } = this.host;
    const subject = validateSubjectName(draft.subject);
    this.validateDraft(draft);
    const folderPath = normalizePath(`${this.host.managedRoot}/${subject}`);
    await ensureFolder(app, folderPath);
    const filePath = normalizePath(`${folderPath}/문제은행.md`);
    assertPortablePath(app, filePath);
    let file = app.vault.getAbstractFileByPath(filePath);
    if (!file) file = await app.vault.create(filePath, createSubjectBank(subject));
    if (!(file instanceof TFile)) throw new Error("문제은행 경로가 파일이 아닙니다.");
    await this.notes.assertWritable(subject);
    const id = createQuestionId();
    const now = new Date().toISOString();
    let updatedContent = "";
    try {
      await app.vault.process(file, (content) => {
        updatedContent = appendManagedQuestion(content, { ...draft, createdAt: now, updatedAt: now }, id);
        return updatedContent;
      });
    } catch (error) {
      if (!updatedContent || await app.vault.read(file) !== updatedContent) throw error;
    }
    const persisted = parseQuestionFile(filePath, updatedContent, { subject }).questions;
    const saved = persisted.find(question => question.id === id);
    if (!saved) throw new Error("추가한 원본 문제를 확인하지 못했습니다.");
    onPersisted?.(saved);
    // The question is validated and written first; a failed write must not leave keyword notes changed.
    const keywordError = await this.saveKeywordsAfterQuestion(draft, true);
    try {
      await this.host.index.refreshFile(file);
      await this.notes.sync(subject, await this.notes.questions(subject, new Map([[filePath, updatedContent]])));
    } catch (error) {
      throw new Error("원본 질문은 추가됐지만 화면·과목 노트 갱신을 완료하지 못했습니다. 입력을 유지한 채 다시 저장해 갱신을 재시도하세요.", { cause: error });
    }
    if (keywordError) throw keywordError;
    new Notice("질문을 문제은행에 추가했습니다.");
  }

  async update(question: QuestionRecord, draft: ManagedQuestionDraft, onPersisted?: (question: QuestionRecord) => void): Promise<void> {
    const { app } = this.host;
    if (!question.id) throw new Error("등록되지 않은 질문은 GUI에서 전체 수정할 수 없습니다.");
    const nextSubject = validateSubjectName(draft.subject);
    this.validateDraft(draft);
    const file = app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    const latest = await app.vault.read(file);
    const current = findCurrentQuestion(parseQuestionFile(question.filePath, latest).questions, question);
    if (!current) throw new Error("수정할 문제를 찾지 못했습니다. 최신 문제를 다시 확인하세요.");
    assertQuestionUnchanged(question, current);
    await this.notes.assertWritable(question.subject);
    await this.notes.assertWritable(nextSubject);
    if (nextSubject !== question.subject) {
      await this.move(question as RegisteredQuestion, { ...draft, subject: nextSubject }, onPersisted);
      new Notice("질문을 다른 과목으로 옮기고 두 과목 노트를 갱신했습니다.");
      return;
    }
    let updatedContent = "";
    try {
      await app.vault.process(file, (content) => {
        updatedContent = replaceCurrentManagedQuestion(
          content,
          question,
          (latest) => parseQuestionFile(question.filePath, latest).questions,
          { ...draft, createdAt: question.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() },
        );
        return updatedContent;
      });
    } catch (error) {
      // Some adapters reject after committing. Only an exact read-back proves this write completed.
      if (!updatedContent || await app.vault.read(file) !== updatedContent) throw error;
    }
    const persisted = parseQuestionFile(question.filePath, updatedContent, { subject: question.subject }).questions;
    const saved = persisted.find((item) => item.id === question.id);
    if (!saved) throw new Error("저장한 원본 문제를 확인하지 못했습니다.");
    // Keep the editor's optimistic-concurrency baseline current even if a derived note fails.
    onPersisted?.(saved);
    const keywordError = await this.saveKeywordsAfterQuestion(draft);
    try {
      await this.host.index.refreshFile(file);
      await this.notes.sync(question.subject, await this.notes.questions(question.subject, new Map([[question.filePath, updatedContent]])));
      await this.followUps.refreshIncoming([question.id]);
    } catch (error) {
      throw new Error(`원본 문제는 저장됐지만 화면·연결 노트 갱신을 완료하지 못했습니다. 입력 내용은 유지됩니다. 다시 저장해 갱신을 재시도하세요. (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    if (keywordError) throw keywordError;
    new Notice("질문과 학습 정보를 수정했습니다.");
  }

  /**
   * Moves a question to another subject's bank: insert into the destination
   * first, then remove from the source. If the source removal fails, the
   * destination copy is removed again so the question never exists twice or
   * nowhere.
   */
  async move(
    question: RegisteredQuestion,
    draft: ManagedQuestionDraft,
    onPersisted?: (question: QuestionRecord) => void,
  ): Promise<void> {
    const { app } = this.host;
    const oldFile = app.vault.getAbstractFileByPath(question.filePath);
    if (!(oldFile instanceof TFile)) throw new Error("기존 문제 파일을 찾지 못했습니다.");
    const blockOf = (content: string, record: QuestionRecord): string => content.replaceAll("\r\n", "\n").split("\n")
      .slice(record.location.headingLine, record.location.answerEndLine).join("\n").trimEnd();
    const source = await app.vault.read(oldFile);
    const now = new Date().toISOString();
    const edited = replaceCurrentManagedQuestion(
      source, question, (latest) => parseQuestionFile(question.filePath, latest).questions,
      { ...draft, createdAt: question.createdAt ?? now, updatedAt: now },
    );
    const editedQuestion = parseQuestionFile(question.filePath, edited).questions.find(item => item.id === question.id);
    if (!editedQuestion) throw new Error("이동할 문제를 확인하지 못했습니다.");
    const questionBlock = blockOf(edited, editedQuestion);
    const originalQuestion = parseQuestionFile(question.filePath, source).questions.find(item => item.id === question.id);
    if (!originalQuestion) throw new Error("원본 문제를 확인하지 못했습니다.");
    const originalBlock = blockOf(source, originalQuestion);
    const nextFolder = normalizePath(`${this.host.managedRoot}/${draft.subject}`);
    await ensureFolder(app, nextFolder);
    const nextPath = normalizePath(`${nextFolder}/문제은행.md`);
    assertPortablePath(app, nextPath);
    let nextFile = app.vault.getAbstractFileByPath(nextPath);
    if (!nextFile) nextFile = await app.vault.create(nextPath, createSubjectBank(draft.subject));
    if (!(nextFile instanceof TFile)) throw new Error("이동할 문제은행 경로가 파일이 아닙니다.");

    const block = rebaseMarkdownLinks(questionBlock, question.filePath, nextPath);
    let nextContent = "";
    let inserted: QuestionRecord | undefined;
    try {
      await app.vault.process(nextFile, (content) => {
        if (parseQuestionFile(nextPath, content).questions.some((item) => item.id === question.id)) {
          throw new Error("이동할 문제은행에 같은 문제 ID가 이미 있습니다.");
        }
        const newline = content.includes("\r\n") ? "\r\n" : "\n";
        const base = content.replaceAll("\r\n", "\n").trimEnd();
        nextContent = `${base}${base ? "\n\n" : ""}${block}\n`.replaceAll("\n", newline);
        inserted = parseQuestionFile(nextPath, nextContent, { subject: draft.subject }).questions.find(item => item.id === question.id);
        if (!inserted) throw new Error("이동 대상의 문제를 확인하지 못했습니다.");
        return nextContent;
      });
    } catch (error) {
      if (!nextContent || await app.vault.read(nextFile) !== nextContent) throw error;
    }

    let oldContent: string | undefined;
    try {
      await app.vault.process(oldFile, (content) => {
        const current = parseQuestionFile(question.filePath, content).questions.filter(item => item.id === question.id);
        if (current.length !== 1 || !current[0] || blockOf(content, current[0]) !== originalBlock) {
          throw new Error("이동 중 원본 문제 내용이 변경되었습니다. 최신 문제를 다시 확인하세요.");
        }
        oldContent = deleteCurrentManagedQuestion(
          content, question, (latest) => parseQuestionFile(question.filePath, latest).questions,
        );
        return oldContent;
      });
    } catch (error) {
      let actualSource: string;
      try {
        actualSource = await app.vault.read(oldFile);
      } catch (readError) {
        throw new AggregateError([error, readError], "원본 저장 결과를 확인하지 못했습니다. 복구를 위해 원본과 대상 문제은행을 확인하세요.");
      }
      // A rejected write may already have persisted. Never remove the only copy.
      if (oldContent === undefined || actualSource !== oldContent) {
        const remaining = parseQuestionFile(question.filePath, actualSource).questions.filter(item => item.id === question.id);
        if (remaining.length !== 1 || !inserted) {
          throw new AggregateError([error], "원본 문제의 상태를 확인하지 못했습니다. 복구를 위해 두 문제은행을 확인하세요.");
        }
        const rollbackQuestion = inserted;
        try {
          await app.vault.process(nextFile, (content) => {
            const current = parseQuestionFile(nextPath, content).questions.filter(item => item.id === question.id);
            if (current.length !== 1 || !current[0] || blockOf(content, current[0]) !== blockOf(nextContent, rollbackQuestion)) {
              throw new Error("이동 대상이 변경되어 자동 복구를 중단했습니다.");
            }
            return deleteCurrentManagedQuestion(
              content, rollbackQuestion, (latest) => parseQuestionFile(nextPath, latest, { subject: draft.subject }).questions,
            );
          });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "문제 이동을 되돌리지 못했습니다. 원본과 대상 문제은행을 확인해 복구하세요.");
        }
        throw error;
      }
    }
    if (oldContent === undefined) throw new Error("이동 후 원본 내용을 확인하지 못했습니다.");
    if (!inserted) throw new Error("이동한 원본 문제를 확인하지 못했습니다.");
    onPersisted?.(inserted);
    const keywordError = await this.saveKeywordsAfterQuestion(draft);
    await this.host.index.refreshFile(oldFile);
    await this.host.index.refreshFile(nextFile);
    const written = new Map([[question.filePath, oldContent], [nextPath, nextContent]]);
    await this.notes.sync(question.subject, await this.notes.questions(question.subject, written));
    await this.notes.sync(draft.subject, await this.notes.questions(draft.subject, written));
    await this.followUps.refreshIncoming([question.id]);
    if (keywordError) throw keywordError;
  }

  async delete(question: RegisteredQuestion): Promise<void> {
    const { app } = this.host;
    const file = app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    await this.notes.assertWritable(question.subject);
    const review = this.host.store.getReview(question.id);
    const links = this.followUps.removedChanges([question.id]);
    let updatedContent = "";
    const writes: FileChange[] = [{ file, update: content => {
      updatedContent = deleteCurrentManagedQuestion(content, question, latest => parseQuestionFile(question.filePath, latest).questions);
      return updatedContent;
    } }, ...this.followUps.fileChanges(links)];
    await applyFileChanges(app.vault, writes, () => this.host.store.removeReview(question.id, { state: review }));
    await this.host.index.rebuild();
    try {
      await this.notes.sync(question.subject, await this.notes.questions(question.subject, new Map([[question.filePath, updatedContent]])));
    } catch (error) {
      throw new Error("문제와 평가·연결은 삭제했지만 과목 노트 갱신은 완료되지 않았습니다. 과목 노트를 다시 확인하세요.", { cause: error });
    }
    new Notice("질문을 문제은행과 과목 노트에서 삭제했습니다.");
  }

  /** Returns (does not throw) so derived notes are still refreshed after the question is saved. */
  private async saveKeywordsAfterQuestion(draft: ManagedQuestionDraft, preserveExistingWhenEmpty = false): Promise<Error | null> {
    try {
      await this.saveDraftKeywordMeanings(draft, preserveExistingWhenEmpty);
      return null;
    } catch (error) {
      return new Error(`질문은 저장됐지만 키워드 뜻은 저장하지 못했습니다. 입력 내용은 유지됩니다. 다시 저장해 키워드 뜻을 재시도하세요. (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
  }

  private async saveDraftKeywordMeanings(draft: ManagedQuestionDraft, preserveExistingWhenEmpty = false): Promise<void> {
    for (const item of draft.keywordMeanings) {
      await this.keywords.saveReferenceMeaning(item.target, item.label, item.meaning, preserveExistingWhenEmpty || item.preserveExistingWhenEmpty === true);
    }
  }

  private validateDraft(draft: ManagedQuestionDraft): void {
    validateManagedQuestionInput(draft);
    for (const item of draft.keywordMeanings) {
      validateKeywordMeaning(item.meaning);
      keywordNotePath(item.target, item.label, this.host.store.settings.keywordFolder);
    }
  }
}

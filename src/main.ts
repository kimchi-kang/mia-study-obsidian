import { MarkdownView, Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { FsrsService, StudyGrade } from "./core/fsrs-service";
import { planFollowUpChanges, questionBlockLink } from "./core/follow-up";
import {
  createKeywordNote,
  readKeywordMeaning,
  updateKeywordMeaning,
  validateKeywordMeaning,
  validateKeywordName,
} from "./core/keyword-note";
import { keywordNotePath } from "./core/keyword-path";
import {
  appendManagedQuestion,
  createSubjectBank,
  deleteCurrentManagedQuestion,
  followUpLinksIn,
  renameSubjectBank,
  replaceCurrentManagedQuestion,
  validateManagedQuestionInput,
  validateSubjectName,
} from "./core/managed-question";
import { keywordReferenceMatches, removeKeywordReferences, renameKeywordReferences } from "./core/keyword-reference";
import { KeywordReference, MiaSettings, QuestionRecord } from "./core/models";
import { parseQuestionFile } from "./core/question-parser";
import {
  isManagedSubjectNote,
  renderSubjectNote,
  subjectNoteFileName,
} from "./core/subject-note";
import {
  QuestionMetadataInput,
  createQuestionId,
  findCurrentQuestion,
  registerQuestion,
  updateQuestionMetadata,
} from "./core/question-writer";
import { MiaDataStore } from "./services/data-store";
import { QuestionIndex } from "./services/question-index";
import { QuestionMetadataModal } from "./ui/metadata-modal";
import { MiaSettingTab } from "./ui/settings-tab";
import { MIA_VIEW_TYPE, MiaStudyView } from "./ui/study-view";
import { KeywordMeaningModal } from "./ui/keyword-modal";
import { FollowUpModal } from "./ui/follow-up-modal";
import { QuestionDetailModal } from "./ui/question-detail-modal";
import { recommendQuestions } from "./core/recommendation-engine";
import {
  ConfirmDeleteModal,
  KeywordEditorModal,
  ManagedQuestionDraft,
  ManagedQuestionModal,
  SubjectEditorModal,
} from "./ui/manage-modals";

export interface KeywordNoteEntry {
  name: string;
  target: string;
  filePath: string;
}

export default class MiaStudyPlugin extends Plugin {
  store!: MiaDataStore;
  index!: QuestionIndex;
  fsrs!: FsrsService;

  async onload(): Promise<void> {
    this.store = new MiaDataStore(this);
    await this.store.load();
    for (const warning of this.store.loadWarnings) new Notice(`MIA Study: ${warning}`);
    this.fsrs = new FsrsService(this.store.settings);
    this.index = new QuestionIndex(this.app, () => this.store.settings.sourceRoots);

    this.registerView(MIA_VIEW_TYPE, (leaf) => new MiaStudyView(leaf, this));
    this.addRibbonIcon("brain-circuit", "MIA Study 열기", () => this.activateView());
    this.addCommand({ id: "open-mia-study", name: "MIA Study 열기", callback: () => this.activateView() });
    this.addCommand({ id: "add-managed-subject", name: "GUI로 과목 추가", callback: () => this.openSubjectEditor() });
    this.addCommand({ id: "add-managed-question", name: "GUI로 질문 추가", callback: () => void this.openManagedQuestionEditor() });
    this.addCommand({ id: "add-managed-keyword", name: "GUI로 키워드 추가", callback: () => this.openKeywordEditor() });
    this.addCommand({
      id: "sync-managed-subject-notes",
      name: "과목 노트 다시 동기화",
      callback: () => void this.syncAllSubjectNotes(true),
    });
    this.addCommand({
      id: "register-question-at-cursor",
      name: "커서의 문제를 MIA에 등록/편집",
      editorCheckCallback: (checking, editor, view) => {
        if (!view.file) return false;
        const question = this.questionAtLine(view.file.path, editor.getCursor().line);
        if (!question) return false;
        if (!checking) this.editMetadata(question);
        return true;
      },
    });
    this.addCommand({
      id: "study-question-at-cursor",
      name: "커서의 문제만 학습",
      editorCheckCallback: (checking, editor, view) => {
        if (!view.file) return false;
        const question = this.questionAtLine(view.file.path, editor.getCursor().line);
        if (!question?.id) return false;
        if (!checking) void this.activateView([question.id]);
        return true;
      },
    });
    this.addSettingTab(new MiaSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        await this.index.start();
        await this.syncAllSubjectNotes(false);
      })().catch((error) => {
        new Notice(`MIA Study 초기 동기화 실패: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  onunload(): void {
    this.index.stop();
  }

  async updateSettings(patch: Partial<MiaSettings>): Promise<void> {
    await this.store.updateSettings(patch);
    this.fsrs = new FsrsService(this.store.settings);
    await this.index.rebuild();
  }

  async activateView(questionIds?: string[]): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(MIA_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: MIA_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof MiaStudyView) {
      if (questionIds) view.startReview(questionIds);
      else view.showDashboard();
    }
  }

  editMetadata(question: QuestionRecord): void {
    if (!question.questionMarkdown.trim() || !question.answerMarkdown.trim()) {
      new Notice("질문과 풀이가 모두 있어야 MIA에 등록할 수 있습니다. 원문을 먼저 확인하세요.");
      void this.openQuestion(question);
      return;
    }
    new QuestionMetadataModal(
      this.app,
      question,
      this.store.settings.keywordFolder,
      (metadata) => this.writeMetadata(question, metadata),
    ).open();
  }

  showKeywordMeaning(target: string, label: string, sourcePath: string): void {
    new KeywordMeaningModal(this.app, target, label, sourcePath, this.store.settings.keywordFolder).open();
  }

  get managedRoot(): string {
    return this.store.settings.sourceRoots[0] ?? "전공면접대비";
  }

  listSubjects(): string[] {
    const root = this.app.vault.getAbstractFileByPath(this.managedRoot);
    if (!(root instanceof TFolder)) return [];
    const keywordRelative = this.store.settings.keywordFolder.startsWith(`${this.managedRoot}/`)
      ? this.store.settings.keywordFolder.slice(this.managedRoot.length + 1).split("/")[0]
      : null;
    return root.children
      .filter((child): child is TFolder => child instanceof TFolder)
      .map((folder) => folder.name)
      .filter((name) => name !== keywordRelative)
      .sort((left, right) => left.localeCompare(right, "ko"));
  }

  listKeywordNotes(): KeywordNoteEntry[] {
    const folder = normalizePath(this.store.settings.keywordFolder);
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${folder}/`))
      .map((file) => ({
        name: file.basename,
        target: file.path.replace(/\.md$/i, ""),
        filePath: file.path,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }

  openSubjectEditor(current: string | null = null): void {
    new SubjectEditorModal(this.app, current, async (name) => {
      if (current) await this.renameSubject(current, name);
      else await this.createSubject(name);
    }).open();
  }

  confirmDeleteSubject(subject: string): void {
    const count = this.index.registered.filter((question) => question.subject === subject).length;
    new ConfirmDeleteModal(
      this.app,
      `${subject} 과목 삭제`,
      `${subject} 폴더와 질문 ${count}개를 Obsidian 휴지통으로 이동합니다. 해당 질문의 FSRS 복습 기록도 삭제됩니다.`,
      "과목 삭제",
      () => this.deleteSubject(subject),
    ).open();
  }

  async openManagedQuestionEditor(question: QuestionRecord | null = null): Promise<void> {
    const subjects = [...new Set([...(question ? [question.subject] : []), ...this.listSubjects()])];
    if (subjects.length === 0) {
      new Notice("질문을 추가하기 전에 과목을 먼저 만들어 주세요.");
      this.openSubjectEditor();
      return;
    }
    const meanings = question ? await this.loadKeywordMeanings(question) : new Map<string, string>();
    new ManagedQuestionModal(
      this.app,
      subjects,
      this.store.settings.keywordFolder,
      question,
      meanings,
      async (draft) => {
        if (question) await this.updateManagedQuestion(question, draft);
        else await this.createManagedQuestion(draft);
      },
    ).open();
  }

  openKeywordEditor(entry: KeywordNoteEntry | null = null): void {
    void (async () => {
      const meaning = entry ? await this.readKeywordNote(entry.filePath) : "";
      new KeywordEditorModal(this.app, entry ? { name: entry.name, meaning } : null, (name, value) =>
        this.saveKeyword(entry, name, value),
      ).open();
    })().catch((error) => new Notice(`키워드 열기 실패: ${error instanceof Error ? error.message : String(error)}`));
  }

  confirmDeleteKeyword(entry: KeywordNoteEntry): void {
    const linked = this.questionsUsingKeyword([entry.target]);
    new ConfirmDeleteModal(
      this.app,
      `${entry.name} 키워드 삭제`,
      `키워드 노트를 휴지통으로 이동하고 연결된 질문 ${linked.length}개의 핵심·보조 키워드 목록에서도 제거합니다.`,
      "키워드 삭제",
      () => this.deleteKeyword(entry),
    ).open();
  }

  confirmDeleteQuestion(question: QuestionRecord & { id: string }): void {
    new ConfirmDeleteModal(
      this.app,
      "질문 삭제",
      `“${question.heading}”을 문제은행과 ${question.subject} 노트에서 삭제하고 FSRS 복습 기록도 제거합니다.`,
      "질문 삭제",
      () => this.deleteManagedQuestion(question),
    ).open();
  }

  async openQuestion(question: QuestionRecord): Promise<void> {
    await this.openLocation(question.filePath, question.location.headingLine);
  }

  async openLocation(filePath: string, line: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice("원문 파일을 찾지 못했습니다.");
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      view.editor.focus();
    }
  }

  private questionAtLine(path: string, line: number): QuestionRecord | undefined {
    return this.index.questionsInFile(path).find((question) =>
      line >= question.location.headingLine && line < question.location.answerEndLine,
    );
  }

  private async writeMetadata(question: QuestionRecord, metadata: QuestionMetadataInput): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    const id = question.id ?? createQuestionId();
    const now = new Date().toISOString();
    await this.app.vault.process(file, (content) => {
      const latest = findCurrentQuestion(parseQuestionFile(question.filePath, content).questions, question);
      if (!latest) throw new Error("원문이 바뀌어 문제 위치를 안전하게 찾지 못했습니다. 창을 닫고 다시 등록해 주세요.");
      const next = { ...metadata, createdAt: latest.createdAt ?? now, updatedAt: now };
      return latest.id ? updateQuestionMetadata(content, latest, next) : registerQuestion(content, latest, next, id);
    });
    await this.index.refreshFile(file);
    new Notice(question.id ? "MIA 학습 정보를 저장했습니다." : "문제를 MIA에 등록했습니다.");
  }

  private async createSubject(value: string): Promise<void> {
    const subject = validateSubjectName(value);
    const keywordContainer = this.keywordContainerName();
    if (subject === keywordContainer) throw new Error("키워드 보관 폴더와 같은 이름은 사용할 수 없습니다.");
    await this.ensureFolder(this.managedRoot);
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    if (this.app.vault.getAbstractFileByPath(folderPath)) throw new Error("이미 존재하는 과목입니다.");
    await this.app.vault.createFolder(folderPath);
    await this.app.vault.create(normalizePath(`${folderPath}/문제은행.md`), createSubjectBank(subject));
    await this.app.vault.create(this.subjectNotePath(subject), renderSubjectNote(subject, []));
    new Notice(`${subject} 과목을 만들었습니다.`);
  }

  private async renameSubject(current: string, value: string): Promise<void> {
    const next = validateSubjectName(value);
    if (next === current) return;
    if (next === this.keywordContainerName()) throw new Error("키워드 보관 폴더와 같은 이름은 사용할 수 없습니다.");
    const currentPath = normalizePath(`${this.managedRoot}/${current}`);
    const nextPath = normalizePath(`${this.managedRoot}/${next}`);
    const folder = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(folder instanceof TFolder)) throw new Error("기존 과목 폴더를 찾지 못했습니다.");
    if (this.app.vault.getAbstractFileByPath(nextPath)) throw new Error("같은 이름의 과목이 이미 있습니다.");
    const oldNotePath = this.subjectNotePath(current);
    const oldNote = this.app.vault.getAbstractFileByPath(oldNotePath);
    const renameGeneratedNote = oldNote instanceof TFile
      && isManagedSubjectNote(await this.app.vault.cachedRead(oldNote));
    const futureNote = this.app.vault.getAbstractFileByPath(normalizePath(`${currentPath}/${subjectNoteFileName(next)}`));
    if (futureNote && futureNote.path !== oldNotePath) throw new Error("변경할 과목 노트 이름과 같은 파일이 이미 있습니다.");
    await this.app.fileManager.renameFile(folder, nextPath);
    if (renameGeneratedNote) {
      const movedNote = this.app.vault.getAbstractFileByPath(normalizePath(`${nextPath}/${subjectNoteFileName(current)}`));
      if (!(movedNote instanceof TFile)) throw new Error("과목 폴더 변경 후 자동 노트를 찾지 못했습니다.");
      await this.app.fileManager.renameFile(movedNote, this.subjectNotePath(next));
    }
    await this.index.rebuild();
    const bank = this.app.vault.getAbstractFileByPath(normalizePath(`${nextPath}/문제은행.md`));
    if (bank instanceof TFile) {
      await this.app.vault.process(bank, (content) => renameSubjectBank(content, current, next));
      await this.index.refreshFile(bank);
    }
    const questions = bank instanceof TFile
      ? parseQuestionFile(bank.path, await this.app.vault.cachedRead(bank), { subject: next }).questions
      : [];
    await this.syncSubjectNote(next, questions);
    await this.refreshIncomingFollowUpLinks(this.index.registered
      .filter((question) => question.subject === next)
      .map((question) => question.id));
    new Notice(`${current} 과목을 ${next}(으)로 변경했습니다.`);
  }

  private async deleteSubject(subject: string): Promise<void> {
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) throw new Error("과목 폴더를 찾지 못했습니다.");
    const ids = this.index.registered
      .filter((question) => question.subject === subject)
      .map((question) => question.id);
    await this.app.fileManager.trashFile(folder);
    await this.store.removeReviews(ids);
    await this.index.rebuild();
    await this.cleanupFollowUpIds(ids);
    new Notice(`${subject} 과목을 휴지통으로 이동했습니다.`);
  }

  private async createManagedQuestion(draft: ManagedQuestionDraft): Promise<void> {
    const subject = validateSubjectName(draft.subject);
    this.validateManagedDraft(draft);
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    await this.ensureFolder(folderPath);
    const filePath = normalizePath(`${folderPath}/문제은행.md`);
    let file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) file = await this.app.vault.create(filePath, createSubjectBank(subject));
    if (!(file instanceof TFile)) throw new Error("문제은행 경로가 파일이 아닙니다.");
    await this.assertSubjectNoteWritable(subject);
    const id = createQuestionId();
    const now = new Date().toISOString();
    await this.saveDraftKeywordMeanings(draft);
    let updatedContent = "";
    await this.app.vault.process(file, (content) => {
      updatedContent = appendManagedQuestion(content, { ...draft, createdAt: now, updatedAt: now }, id);
      return updatedContent;
    });
    await this.index.refreshFile(file);
    await this.syncSubjectNote(subject, parseQuestionFile(filePath, updatedContent, { subject }).questions);
    new Notice("질문을 문제은행에 추가했습니다.");
  }

  private async updateManagedQuestion(question: QuestionRecord, draft: ManagedQuestionDraft): Promise<void> {
    if (!question.id) throw new Error("등록되지 않은 질문은 GUI에서 전체 수정할 수 없습니다.");
    const nextSubject = validateSubjectName(draft.subject);
    this.validateManagedDraft(draft);
    const file = this.app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    await this.assertSubjectNoteWritable(question.subject);
    await this.assertSubjectNoteWritable(nextSubject);
    await this.saveDraftKeywordMeanings(draft);
    if (nextSubject !== question.subject) {
      await this.moveManagedQuestion(question as QuestionRecord & { id: string }, { ...draft, subject: nextSubject });
      new Notice("질문을 다른 과목으로 옮기고 두 과목 노트를 갱신했습니다.");
      return;
    }
    let updatedContent = "";
    await this.app.vault.process(file, (content) => {
      updatedContent = replaceCurrentManagedQuestion(
        content,
        question,
        (latest) => parseQuestionFile(question.filePath, latest).questions,
        { ...draft, createdAt: question.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() },
      );
      return updatedContent;
    });
    await this.index.refreshFile(file);
    await this.syncSubjectNote(
      question.subject,
      parseQuestionFile(question.filePath, updatedContent, { subject: question.subject }).questions,
    );
    await this.refreshIncomingFollowUpLinks([question.id]);
    new Notice("질문과 학습 정보를 수정했습니다.");
  }

  private async moveManagedQuestion(
    question: QuestionRecord & { id: string },
    draft: ManagedQuestionDraft,
  ): Promise<void> {
    const oldFile = this.app.vault.getAbstractFileByPath(question.filePath);
    if (!(oldFile instanceof TFile)) throw new Error("기존 문제 파일을 찾지 못했습니다.");
    const nextFolder = normalizePath(`${this.managedRoot}/${draft.subject}`);
    await this.ensureFolder(nextFolder);
    const nextPath = normalizePath(`${nextFolder}/문제은행.md`);
    let nextFile = this.app.vault.getAbstractFileByPath(nextPath);
    if (!nextFile) nextFile = await this.app.vault.create(nextPath, createSubjectBank(draft.subject));
    if (!(nextFile instanceof TFile)) throw new Error("이동할 문제은행 경로가 파일이 아닙니다.");

    let nextContent = "";
    await this.app.vault.process(nextFile, (content) => {
      if (parseQuestionFile(nextPath, content).questions.some((item) => item.id === question.id)) {
        throw new Error("이동할 문제은행에 같은 문제 ID가 이미 있습니다.");
      }
      nextContent = appendManagedQuestion(content, {
        ...draft,
        followUpLinks: question.followUpIds
          .map((id) => this.index.questionById(id))
          .filter((target): target is QuestionRecord & { id: string } => Boolean(target))
          .map(questionBlockLink),
        createdAt: question.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, question.id);
      return nextContent;
    });

    let oldContent = "";
    try {
      await this.app.vault.process(oldFile, (content) => {
        oldContent = deleteCurrentManagedQuestion(
          content,
          question,
          (latest) => parseQuestionFile(question.filePath, latest).questions,
        );
        return oldContent;
      });
    } catch (error) {
      await this.app.vault.process(nextFile, (content) => deleteCurrentManagedQuestion(
        content,
        { ...question, filePath: nextPath, subject: draft.subject },
        (latest) => parseQuestionFile(nextPath, latest, { subject: draft.subject }).questions,
      ));
      throw error;
    }
    await this.index.refreshFile(oldFile);
    await this.index.refreshFile(nextFile);
    await this.syncSubjectNote(
      question.subject,
      parseQuestionFile(question.filePath, oldContent, { subject: question.subject }).questions,
    );
    await this.syncSubjectNote(
      draft.subject,
      parseQuestionFile(nextPath, nextContent, { subject: draft.subject }).questions,
    );
    await this.refreshIncomingFollowUpLinks([question.id]);
  }

  private async deleteManagedQuestion(question: QuestionRecord & { id: string }): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    await this.assertSubjectNoteWritable(question.subject);
    let updatedContent = "";
    await this.app.vault.process(file, (content) => {
      updatedContent = deleteCurrentManagedQuestion(
        content,
        question,
        (latest) => parseQuestionFile(question.filePath, latest).questions,
      );
      return updatedContent;
    });
    await this.index.refreshFile(file);
    await this.syncSubjectNote(
      question.subject,
      parseQuestionFile(question.filePath, updatedContent, { subject: question.subject }).questions,
    );
    await this.store.removeReview(question.id);
    await this.cleanupFollowUpIds([question.id]);
    new Notice("질문을 문제은행과 과목 노트에서 삭제했습니다.");
  }

  private async saveDraftKeywordMeanings(draft: ManagedQuestionDraft): Promise<void> {
    for (const item of draft.keywordMeanings) {
      await this.saveKeywordReferenceMeaning(item.target, item.label, item.meaning);
    }
  }

  private validateManagedDraft(draft: ManagedQuestionDraft): void {
    validateManagedQuestionInput(draft);
    for (const item of draft.keywordMeanings) {
      validateKeywordMeaning(item.meaning);
      keywordNotePath(item.target, item.label, this.store.settings.keywordFolder);
    }
  }

  private async saveKeywordReferenceMeaning(target: string, label: string, meaning: string): Promise<void> {
    validateKeywordMeaning(meaning);
    const path = keywordNotePath(target, label, this.store.settings.keywordFolder);
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (content) => updateKeywordMeaning(content, label, meaning));
    } else {
      await this.app.vault.create(path, createKeywordNote(label, meaning));
    }
  }

  private async saveKeywordMeaning(name: string, meaning: string, notify = true): Promise<void> {
    const safeName = validateKeywordName(name);
    validateKeywordMeaning(meaning);
    const path = keywordNotePath(safeName, safeName, this.store.settings.keywordFolder);
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (content) => updateKeywordMeaning(content, safeName, meaning));
    } else {
      await this.app.vault.create(path, createKeywordNote(safeName, meaning));
    }
    if (notify) new Notice(`${safeName} 키워드를 저장했습니다.`);
  }

  private async saveKeyword(current: KeywordNoteEntry | null, value: string, meaning: string): Promise<void> {
    const name = validateKeywordName(value);
    if (!current || current.name === name) {
      await this.saveKeywordMeaning(name, meaning);
      return;
    }
    const source = this.app.vault.getAbstractFileByPath(current.filePath);
    if (!(source instanceof TFile)) throw new Error("기존 키워드 노트를 찾지 못했습니다.");
    const nextPath = keywordNotePath(name, name, this.store.settings.keywordFolder);
    const destination = this.app.vault.getAbstractFileByPath(nextPath);
    if (destination instanceof TFolder) throw new Error("변경할 키워드 경로가 폴더와 겹칩니다.");
    if (destination instanceof TFile) {
      const sourceMeaning = readKeywordMeaning(await this.app.vault.cachedRead(source));
      const destinationMeaning = readKeywordMeaning(await this.app.vault.cachedRead(destination));
      const mergedMeaning = [...new Set([destinationMeaning, sourceMeaning, meaning].map((item) => item.trim()).filter(Boolean))].join("\n\n");
      await this.app.vault.process(destination, (content) => updateKeywordMeaning(content, name, mergedMeaning));
      await this.app.fileManager.trashFile(source);
    } else {
      await this.app.fileManager.renameFile(source, nextPath);
      const renamed = this.app.vault.getAbstractFileByPath(nextPath);
      if (!(renamed instanceof TFile)) throw new Error("키워드 이름을 바꾼 뒤 노트를 찾지 못했습니다.");
      await this.app.vault.process(renamed, (content) => updateKeywordMeaning(content, name, meaning));
    }
    const nextTarget = nextPath.replace(/\.md$/i, "");
    await this.rewriteKeywordReferences(
      [current.target, nextTarget],
      (references) => renameKeywordReferences(references, [current.target, nextTarget], nextTarget, name),
    );
    await this.index.rebuild();
    new Notice(`${current.name} 키워드를 ${name}(으)로 변경했습니다.`);
  }

  private questionsUsingKeyword(targets: readonly string[]): Array<QuestionRecord & { id: string }> {
    return this.index.registered.filter((question) =>
      [...question.coreKeywords, ...question.subKeywords]
        .some((reference) => keywordReferenceMatches(reference, targets)),
    );
  }

  private async rewriteKeywordReferences(
    targets: readonly string[],
    transform: (references: readonly KeywordReference[]) => KeywordReference[],
  ): Promise<void> {
    const byFile = new Map<string, Array<QuestionRecord & { id: string }>>();
    for (const question of this.questionsUsingKeyword(targets)) {
      const questions = byFile.get(question.filePath) ?? [];
      questions.push(question);
      byFile.set(question.filePath, questions);
    }
    for (const [filePath, questions] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) throw new Error(`${filePath} 문제 파일을 찾지 못했습니다.`);
      await this.app.vault.process(file, (content) => {
        let updated = content;
        for (const original of questions) {
          const current = findCurrentQuestion(parseQuestionFile(filePath, updated).questions, original);
          if (!current) throw new Error("키워드가 연결된 문제를 최신 원문에서 찾지 못했습니다.");
          const followUpLinks = followUpLinksIn(updated, current);
          const coreKeywords = transform(current.coreKeywords);
          const subKeywords = transform(current.subKeywords)
            .filter((reference) => !keywordReferenceMatches(reference, coreKeywords.map((keyword) => keyword.target)));
          updated = updateQuestionMetadata(updated, current, {
            questionType: current.questionType,
            coreKeywords,
            subKeywords,
            ...(followUpLinks ? { followUpLinks } : {}),
            createdAt: current.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        return updated;
      });
      await this.index.refreshFile(file);
    }
  }

  private async deleteKeyword(entry: KeywordNoteEntry): Promise<void> {
    await this.rewriteKeywordReferences(
      [entry.target],
      (references) => removeKeywordReferences(references, [entry.target]),
    );
    const file = this.app.vault.getAbstractFileByPath(entry.filePath);
    if (file instanceof TFile) await this.app.fileManager.trashFile(file);
    await this.index.rebuild();
    new Notice(`${entry.name} 키워드를 삭제하고 연결된 문제를 갱신했습니다.`);
  }

  private async loadKeywordMeanings(question: QuestionRecord): Promise<Map<string, string>> {
    const output = new Map<string, string>();
    for (const keyword of [...question.coreKeywords, ...question.subKeywords]) {
      const file = this.app.metadataCache.getFirstLinkpathDest(keyword.target, question.filePath);
      output.set(keyword.target, file ? readKeywordMeaning(await this.app.vault.cachedRead(file)) : "");
    }
    return output;
  }

  openFollowUpEditor(question: QuestionRecord & { id: string }): void {
    const current = this.index.questionById(question.id) ?? question;
    new FollowUpModal(this.app, current, this.index.registered, async (ids, bidirectional) => {
      const changes = planFollowUpChanges(current, ids, this.index.registered, bidirectional);
      await this.applyFollowUpChanges(changes);
      new Notice(`${changes.size}개 질문의 연결을 갱신했습니다.`);
    }).open();
  }

  async openQuestionDetail(question: QuestionRecord & { id: string }): Promise<void> {
    const current = this.index.questionById(question.id) ?? question;
    const meanings = await this.loadKeywordMeanings(current);
    const recommendations = recommendQuestions(current, this.index.registered, this.store.reviews, this.fsrs);
    new QuestionDetailModal(this.app, current, this.store.getReview(current.id), recommendations, meanings, {
      study: () => { void this.activateView([current.id]); },
      edit: () => { void this.openManagedQuestionEditor(current); },
      connections: () => this.openFollowUpEditor(current),
      remove: () => this.confirmDeleteQuestion(current),
      openSource: () => { void this.openQuestion(current); },
      showKeyword: (target, label) => this.showKeywordMeaning(target, label, current.filePath),
      rate: (grade) => this.rateQuestionDirectly(current.id, grade),
      resetReview: () => this.store.removeReview(current.id),
    }).open();
  }

  private async rateQuestionDirectly(id: string, grade: StudyGrade): Promise<void> {
    await this.store.setReview(id, this.fsrs.rate(this.store.getReview(id), grade));
  }

  private async cleanupFollowUpIds(removedIds: readonly string[]): Promise<void> {
    const removed = new Set(removedIds);
    const changes = new Map<string, string[]>();
    for (const question of this.index.registered) {
      if (removed.has(question.id) || !question.followUpIds.some((id) => removed.has(id))) continue;
      changes.set(question.id, question.followUpIds.filter((id) => !removed.has(id)));
    }
    if (changes.size) await this.applyFollowUpChanges(changes);
  }

  private async refreshIncomingFollowUpLinks(targetIds: readonly string[]): Promise<void> {
    const targets = new Set(targetIds);
    const changes = new Map<string, string[]>();
    for (const question of this.index.registered) {
      if (question.followUpIds.some((id) => targets.has(id))) changes.set(question.id, question.followUpIds);
    }
    if (changes.size) await this.applyFollowUpChanges(changes);
  }

  private async applyFollowUpChanges(changes: ReadonlyMap<string, readonly string[]>): Promise<void> {
    const snapshot = new Map(this.index.registered.map((question) => [question.id, question]));
    const byFile = new Map<string, string[]>();
    for (const id of changes.keys()) {
      const question = snapshot.get(id);
      if (!question) continue;
      const ids = byFile.get(question.filePath) ?? [];
      ids.push(id);
      byFile.set(question.filePath, ids);
    }
    const updatedAt = new Date().toISOString();
    for (const [filePath, ids] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) throw new Error(`${filePath} 문제 파일을 찾지 못했습니다.`);
      await this.app.vault.process(file, (content) => {
        let updated = content;
        for (const id of ids) {
          const original = snapshot.get(id);
          if (!original) continue;
          const current = findCurrentQuestion(parseQuestionFile(filePath, updated).questions, original);
          if (!current) throw new Error(`연결을 수정할 질문을 찾지 못했습니다: ${original.heading}`);
          const links = (changes.get(id) ?? [])
            .map((targetId) => snapshot.get(targetId) ?? this.index.questionById(targetId))
            .filter((target): target is QuestionRecord & { id: string } => Boolean(target))
            .map(questionBlockLink);
          updated = updateQuestionMetadata(updated, current, {
            questionType: current.questionType,
            coreKeywords: current.coreKeywords,
            subKeywords: current.subKeywords,
            followUpLinks: links,
            createdAt: current.createdAt ?? updatedAt,
            updatedAt,
          });
        }
        return updated;
      });
      await this.index.refreshFile(file);
    }
  }

  private async readKeywordNote(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return "";
    return readKeywordMeaning(await this.app.vault.cachedRead(file));
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      const current = parts.slice(0, index).join("/");
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`${current} 파일 때문에 폴더를 만들 수 없습니다.`);
      if (!existing) await this.app.vault.createFolder(current);
    }
  }

  private subjectNotePath(subject: string): string {
    return normalizePath(`${this.managedRoot}/${subject}/${subjectNoteFileName(subject)}`);
  }

  private async assertSubjectNoteWritable(subject: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(this.subjectNotePath(subject));
    if (existing instanceof TFolder) throw new Error("과목 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile && !isManagedSubjectNote(await this.app.vault.cachedRead(existing))) {
      throw new Error(`${subjectNoteFileName(subject)} 파일이 이미 있으며 자동 생성 노트가 아닙니다.`);
    }
  }

  private async syncSubjectNote(subject: string, questions: QuestionRecord[]): Promise<void> {
    await this.assertSubjectNoteWritable(subject);
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    await this.ensureFolder(folderPath);
    const path = this.subjectNotePath(subject);
    const content = renderSubjectNote(subject, questions);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.process(existing, () => content);
    else await this.app.vault.create(path, content);
  }

  private async syncAllSubjectNotes(notify: boolean): Promise<void> {
    let count = 0;
    const failures: string[] = [];
    for (const subject of this.listSubjects()) {
      try {
        const bankPath = normalizePath(`${this.managedRoot}/${subject}/문제은행.md`);
        const bank = this.app.vault.getAbstractFileByPath(bankPath);
        const questions = bank instanceof TFile
          ? parseQuestionFile(bankPath, await this.app.vault.cachedRead(bank), { subject }).questions
          : [];
        await this.syncSubjectNote(subject, questions);
        count += 1;
      } catch (error) {
        failures.push(`${subject}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) new Notice(`과목 노트 ${failures.length}개 동기화 실패: ${failures.join(" / ")}`);
    if (notify) new Notice(`과목 노트 ${count}개를 문제은행과 다시 동기화했습니다.`);
  }

  private keywordContainerName(): string | null {
    return this.store.settings.keywordFolder.startsWith(`${this.managedRoot}/`)
      ? this.store.settings.keywordFolder.slice(this.managedRoot.length + 1).split("/")[0] ?? null
      : null;
  }
}

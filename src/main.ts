import { MarkdownView, Notice, Platform, Plugin, TFile, normalizePath } from "obsidian";
import type { ExportImage } from "./core/subject-export";
import { StartupDiagnostics } from "./services/startup-diagnostics";
import type { ExportReceipt } from "./services/export-file";
import { SubjectExportModal } from "./ui/subject-export-modal";
import { FsrsService, StudyGrade } from "./core/fsrs-service";
import { StudyUiStore } from "./services/study-ui-store";
import { QuestionPreviewModal } from "./ui/question-preview-modal";
import { errorMessage } from "./ui/error-message";
import { planFollowUpChanges } from "./core/follow-up";
import { rebaseMarkdownLinks } from "./core/markdown-links";
import type { ManagedQuestionDraft } from "./core/managed-question";
import { MiaSettings, QuestionRecord, QuestionReviewState } from "./core/models";
import { parseQuestionFile } from "./core/question-parser";
import { QuestionMetadataInput, assertQuestionUnchanged } from "./core/question-writer";
import { MiaDataStore } from "./services/data-store";
import { FollowUpLinks } from "./services/follow-up-links";
import { KeywordOperations, type KeywordNoteEntry } from "./services/keyword-operations";
import type { MiaHost } from "./services/mia-host";
import { QuestionOperations } from "./services/question-operations";
import { SubjectNotes } from "./services/subject-notes";
import { SubjectOperations } from "./services/subject-operations";
import { exportSubjectWord, readExportImage } from "./services/subject-word-export";
import { VerifiedPluginStorage, type PluginDataStorage } from "./services/verified-plugin-storage";
import { PORTABLE_RESUME_PATH, preparePortableStudyStorage, selectPortableStudyStorage } from "./services/portable-study-storage";
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
  ManagedQuestionModal,
  SubjectEditorModal,
} from "./ui/manage-modals";

export type { KeywordNoteEntry };

/**
 * Plugin entry point: loading, commands, and wiring modals to the vault
 * services. File-changing work lives in `services/`; the plugin only routes
 * to it, so each operation can be read and tested on its own.
 */
export default class MiaStudyPlugin extends Plugin implements MiaHost {
  store!: MiaDataStore;
  index!: QuestionIndex;
  fsrs!: FsrsService;
  private fsrsKey = "";
  studyUi!: StudyUiStore;
  portableSyncActive = false;
  private legacyStudyStorage!: VerifiedPluginStorage;
  private activeStudyStorage!: PluginDataStorage;
  private legacyResumePath = "";
  private portableSyncKey = "";
  private startupDiagnostics: StartupDiagnostics | null = null;
  private unloadRequested = false;
  // Services read app/store/index from the plugin on each call, so they work
  // whether those are set by Obsidian before load or assigned later.
  private readonly subjectNotes = new SubjectNotes(this);
  private readonly followUps = new FollowUpLinks(this);
  private readonly keywords = new KeywordOperations(this);
  private readonly subjects = new SubjectOperations(this, this.subjectNotes, this.followUps);
  private readonly questions = new QuestionOperations(this, this.subjectNotes, this.keywords, this.followUps);

  async onload(): Promise<void> {
    this.unloadRequested = false;
    this.startupDiagnostics = new StartupDiagnostics(this.app, this.manifest.version);
    this.startupDiagnostics.record("starting");
    try {
      await this.loadMia();
      if (!this.unloadRequested) this.startupDiagnostics.record("loaded");
    } catch (error) {
      if (this.unloadRequested) return;
      this.startupDiagnostics.record("failed", error);
      throw error;
    }
  }

  private async loadMia(): Promise<void> {
    const recoveryKey = `mia-study:review-recovery:${this.app.vault.getName()}:${this.app.vault.configDir}`;
    const dataDirectory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.legacyStudyStorage = new VerifiedPluginStorage(this, this.app.vault.adapter, normalizePath(`${dataDirectory}/data.json`));
    this.legacyResumePath = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/ui-state.json`);
    this.portableSyncKey = `mia-study:portable-sync:${this.app.vault.getName()}:${this.app.vault.configDir}`;
    const portable = await selectPortableStudyStorage(this.app.vault.adapter, this.app.loadLocalStorage(this.portableSyncKey) === true);
    if (this.unloadRequested) return;
    this.activeStudyStorage = portable ?? this.legacyStudyStorage;
    this.portableSyncActive = portable !== null;
    if (portable) this.app.saveLocalStorage(this.portableSyncKey, true);
    const storage: PluginDataStorage = {
      loadData: () => this.activeStudyStorage.loadData(),
      saveData: data => this.activeStudyStorage.saveData(data),
    };
    this.store = new MiaDataStore(storage, {
      readPending: () => this.app.loadLocalStorage(`${recoveryKey}:pending`),
      writePending: data => this.app.saveLocalStorage(`${recoveryKey}:pending`, data),
      read: () => this.app.loadLocalStorage(recoveryKey),
      write: (data) => this.app.saveLocalStorage(recoveryKey, data),
      onWarning: (message) => { new Notice(`MIA Study: ${message}`, 12000); },
    });
    await this.store.load();
    if (this.unloadRequested) return;
    this.studyUi = portable
      ? new StudyUiStore(this.app, PORTABLE_RESUME_PATH, { localStatePath: this.legacyResumePath, adapter: portable.resumeAdapter })
      : new StudyUiStore(this.app, this.legacyResumePath);
    try { await this.studyUi.load(); }
    catch (error) { new Notice(`이어하기 정보 불러오기 실패: ${errorMessage(error)}`); }
    if (this.unloadRequested) return;
    for (const warning of this.store.loadWarnings) new Notice(`MIA Study: ${warning}`);
    this.refreshFsrs();
    this.register(this.store.subscribe(() => this.refreshFsrs()));
    this.index = new QuestionIndex(this.app, () => this.store.settings.sourceRoots);

    this.registerView(MIA_VIEW_TYPE, (leaf) => new MiaStudyView(leaf, this));
    this.addRibbonIcon("brain-circuit", "MIA Study 열기", () => this.activateView());
    this.addCommand({ id: "open-mia-study", name: "MIA Study 열기", callback: () => this.activateView() });
    this.addCommand({ id: "show-startup-status", name: "시작 상태 확인", callback: () => {
      new Notice(this.startupDiagnostics?.summary() ?? "시작 기록이 없습니다.", 12000);
    } });
    this.addCommand({ id: "export-subject-word", name: "과목 질문 답변 Word로 출력", callback: () => this.openSubjectExport() });
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
        if (this.unloadRequested) return;
        await this.index.start();
        if (this.unloadRequested) return;
        await this.syncAllSubjectNotes(false);
      })().catch((error) => {
        new Notice(`MIA Study 초기 동기화 실패: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async synchronizeStudyData(): Promise<void> {
    const roots = JSON.stringify(this.store.settings.sourceRoots);
    const keywordFolder = this.store.settings.keywordFolder;
    await this.store.synchronize();
    if (this.unloadRequested) return;
    if (roots !== JSON.stringify(this.store.settings.sourceRoots) || keywordFolder !== this.store.settings.keywordFolder) {
      await this.index.rebuild();
    }
  }

  async onExternalSettingsChange(): Promise<void> {
    if (this.unloadRequested || !this.store) return;
    try { await this.synchronizeStudyData(); }
    catch (error) { new Notice(`기기 간 복습 기록 확인 실패: ${errorMessage(error)}`); }
  }

  onunload(): void {
    this.unloadRequested = true;
    this.startupDiagnostics?.record("unloaded");
    this.index?.stop();
  }

  async enablePortableSync(): Promise<void> {
    if (this.portableSyncActive) return;
    await this.store.synchronize();
    await this.studyUi.load();
    await preparePortableStudyStorage(this.app.vault.adapter, this.legacyStudyStorage, this.studyUi.sharedSnapshot);
    const portable = await selectPortableStudyStorage(this.app.vault.adapter, true);
    if (!portable) throw new Error("공유 폴더를 확인하지 못했습니다.");
    this.activeStudyStorage = portable;
    await this.store.synchronize();
    this.studyUi = new StudyUiStore(this.app, PORTABLE_RESUME_PATH, { localStatePath: this.legacyResumePath, adapter: portable.resumeAdapter });
    await this.studyUi.load();
    this.app.saveLocalStorage(this.portableSyncKey, true);
    this.portableSyncActive = true;
  }

  /** Rebuilds the scheduler only when a setting it actually uses has changed. */
  private refreshFsrs(): void {
    const { targetRetention, maximumIntervalDays, gradeIntervalsMinutes, studyManagement } = this.store.settings;
    const key = JSON.stringify([targetRetention, maximumIntervalDays, gradeIntervalsMinutes, studyManagement]);
    if (this.fsrs && key === this.fsrsKey) return;
    this.fsrsKey = key;
    this.fsrs = new FsrsService(this.store.settings);
  }

  async updateSettings(patch: Partial<MiaSettings>, expectedBase?: MiaSettings): Promise<void> {
    await this.store.updateSettings(patch, expectedBase);
    this.refreshFsrs();
    // Scheduling options do not change indexed questions. A scan failure after a
    // successful write must not report that these settings failed to save.
    if (patch.sourceRoots !== undefined || patch.keywordFolder !== undefined) await this.index.rebuild();
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
      (id) => this.index.questionById(id),
    ).open();
  }

  showKeywordMeaning(target: string, label: string, sourcePath: string): void {
    new KeywordMeaningModal(this.app, target, label, sourcePath, this.store.settings.keywordFolder).open();
  }

  get managedRoot(): string {
    return this.store.settings.sourceRoots[0] ?? "MIA";
  }

  listSubjects(): string[] {
    return this.subjects.list();
  }

  listKeywordNotes(): KeywordNoteEntry[] {
    return this.keywords.list();
  }

  openSubjectExport(): void {
    const counts = new Map<string, number>();
    for (const subject of this.listSubjects()) counts.set(subject, 0);
    for (const question of this.index.registered) counts.set(question.subject, (counts.get(question.subject) ?? 0) + 1);
    const subjects = [...counts].sort(([a], [b]) => a.localeCompare(b, "ko"))
      .map(([name, count]) => ({ name, count }));
    new SubjectExportModal(this.app, subjects, (subject) => this.exportSubject(subject),
      Platform.isDesktopApp ? "다운로드 폴더" : "보관함의 MIA 출력 폴더").open();
  }

  openSubjectEditor(current: string | null = null): void {
    new SubjectEditorModal(this.app, current, async (name) => {
      if (current) await this.renameSubject(current, name);
      else await this.createSubject(name);
    }).open();
  }

  confirmDeleteSubject(subject: string): void {
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    const count = this.index.registered.filter((question) => question.filePath.startsWith(`${folderPath}/`)).length;
    new ConfirmDeleteModal(
      this.app,
      `${subject} 과목 삭제`,
      `${subject} 폴더와 질문 ${count}개를 Obsidian 휴지통으로 이동합니다. 해당 질문의 FSRS 복습 기록도 삭제됩니다.`,
      "과목 삭제",
      () => this.deleteSubject(subject),
    ).open();
  }

  async openManagedQuestionEditor(question: QuestionRecord | null = null, onClosed?: () => void, onSaved?: () => void, isActive?: () => boolean): Promise<void> {
    if (question) {
      const current = question.id ? this.index.questionById(question.id) : undefined;
      if (!current) throw new Error("원본 문제를 찾을 수 없습니다. 삭제 또는 ID 충돌 여부를 확인하세요.");
      question = current;
    }
    const subjects = [...new Set([...(question ? [question.subject] : []), ...this.listSubjects()])];
    const meanings = question ? await this.loadKeywordMeanings(question) : new Map<string, string>();
    if (isActive && !isActive()) return;
    if (question) {
      const current = question.id ? this.index.questionById(question.id) : undefined;
      if (!current) throw new Error("원본 문제를 찾을 수 없습니다. 삭제 또는 ID 충돌 여부를 확인하세요.");
      assertQuestionUnchanged(question, current);
    }
    let editorPath = question?.filePath;
    const pendingSubjectNotes = new Set<string>();
    const persistedQuestion = (persisted: QuestionRecord) => {
      question = persisted;
      editorPath ??= persisted.filePath;
    };
    new ManagedQuestionModal(
      this.app,
      subjects,
      this.store.settings.keywordFolder,
      question,
      meanings,
      async (draft) => {
        // A move may commit before derived-note refresh fails. The still-open
        // editor's relative links remain authored against its original bank.
        const input = question && editorPath && editorPath !== question.filePath ? {
          ...draft,
          questionMarkdown: rebaseMarkdownLinks(draft.questionMarkdown, editorPath, question.filePath),
          answerMarkdown: rebaseMarkdownLinks(draft.answerMarkdown, editorPath, question.filePath),
        } : draft;
        // Clear any stale source-index entry before resolving incoming links.
        for (const subject of pendingSubjectNotes) {
          const path = normalizePath(`${this.managedRoot}/${subject}/문제은행.md`);
          const bank = this.app.vault.getAbstractFileByPath(path);
          if (!(bank instanceof TFile)) throw new Error("이동 전 문제은행을 찾지 못했습니다. 갱신을 다시 시도하세요.");
          await this.index.refreshFile(bank);
        }
        const previousSubject = question?.subject;
        try {
          if (question) await this.updateManagedQuestion(question, input, persistedQuestion);
          else await this.createManagedQuestion(input, persistedQuestion);
        } catch (error) {
          if (previousSubject && question?.subject !== previousSubject) pendingSubjectNotes.add(previousSubject);
          throw error;
        }
        for (const subject of pendingSubjectNotes) {
          // Every question file in the folder belongs in the note, not just the bank.
          await this.syncSubjectNote(subject, await this.subjectQuestions(subject));
          pendingSubjectNotes.delete(subject);
        }
        onSaved?.();
      },
      this.index.registered,
      onClosed,
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
    const linked = this.keywords.questionsUsing([entry.target]);
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

  openFollowUpEditor(question: QuestionRecord & { id: string }): void {
    const opened = this.index.registered.map(item => structuredClone(item));
    const current = opened.find(item => item.id === question.id);
    if (!current) throw new Error("연결을 편집할 질문을 찾지 못했습니다.");
    const expected = new Map(opened.map(item => [item.id, item]));
    new FollowUpModal(this.app, current, opened, async (ids, bidirectional) => {
      const changes = planFollowUpChanges(current, ids, opened, bidirectional);
      await this.index.rebuild();
      await this.applyFollowUpChanges(changes, expected);
      new Notice(`${changes.size}개 질문의 연결을 갱신했습니다.`);
    }).open();
  }

  openQuestionPreview(question: QuestionRecord & { id: string }, restore: () => void): void {
    const current = this.index.questionById(question.id) ?? question;
    new QuestionPreviewModal(this.app, current, () => void this.openQuestionDetail(current), restore, this.studyUi.appearance).open();
  }

  async openQuestionDetail(question: QuestionRecord & { id: string }): Promise<void> {
    const current = this.index.questionById(question.id) ?? question;
    const meanings = await this.loadKeywordMeanings(current);
    const recommendations = recommendQuestions(current, this.index.registered, this.store.reviews, this.fsrs);
    const review = this.store.getReview(current.id);
    new QuestionDetailModal(this.app, current, review, recommendations, meanings, {
      study: () => { void this.activateView([current.id]); },
      edit: () => { void this.openManagedQuestionEditor(current); },
      connections: () => this.openFollowUpEditor(current),
      remove: () => this.confirmDeleteQuestion(current),
      showKeyword: (target, label) => this.showKeywordMeaning(target, label, current.filePath),
      rate: (grade) => this.rateQuestionDirectly(current.id, grade, review),
      resetReview: () => this.store.removeReview(current.id, { state: review }),
    }).open();
  }

  private questionAtLine(path: string, line: number): QuestionRecord | undefined {
    return this.index.questionsInFile(path).find((question) =>
      line >= question.location.headingLine && line < question.location.answerEndLine,
    );
  }

  private async rateQuestionDirectly(id: string, grade: StudyGrade, baseline: QuestionReviewState | undefined): Promise<void> {
    await this.store.setReview(id, this.fsrs.rate(baseline, grade, new Date(), id), { state: baseline });
  }

  private async syncAllSubjectNotes(notify: boolean): Promise<void> {
    if (this.unloadRequested) return;
    let count = 0;
    const failures: string[] = [];
    for (const subject of this.listSubjects()) {
      if (this.unloadRequested) return;
      try {
        const questions = await this.subjectQuestions(subject);
        if (this.unloadRequested) return;
        await this.syncSubjectNote(subject, questions);
        count += 1;
      } catch (error) {
        failures.push(`${subject}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.unloadRequested) return;
    if (failures.length) new Notice(`과목 노트 ${failures.length}개 동기화 실패: ${failures.join(" / ")}`);
    if (notify) new Notice(`과목 노트 ${count}개를 문제은행과 다시 동기화했습니다.`);
  }

  // Routes to the vault services. Kept as plugin methods so modal callbacks
  // and the file-safety regression tests address one stable surface.
  private exportSubject(subject: string): Promise<ExportReceipt> { return exportSubjectWord(this, subject); }
  private readExportImage(target: string, source: string): Promise<ExportImage | null> { return readExportImage(this.app, target, source); }
  private writeMetadata(question: QuestionRecord, metadata: QuestionMetadataInput): Promise<void> { return this.questions.writeMetadata(question, metadata); }
  private createSubject(value: string): Promise<void> { return this.subjects.create(value); }
  private renameSubject(current: string, value: string): Promise<void> { return this.subjects.rename(current, value); }
  private deleteSubject(subject: string): Promise<void> { return this.subjects.delete(subject); }
  private createManagedQuestion(draft: ManagedQuestionDraft, onPersisted?: (question: QuestionRecord) => void): Promise<void> {
    return this.questions.create(draft, onPersisted);
  }
  private updateManagedQuestion(question: QuestionRecord, draft: ManagedQuestionDraft, onPersisted?: (question: QuestionRecord) => void): Promise<void> {
    return this.questions.update(question, draft, onPersisted);
  }
  private moveManagedQuestion(question: QuestionRecord & { id: string }, draft: ManagedQuestionDraft, onPersisted?: (question: QuestionRecord) => void): Promise<void> {
    return this.questions.move(question, draft, onPersisted);
  }
  private deleteManagedQuestion(question: QuestionRecord & { id: string }): Promise<void> { return this.questions.delete(question); }
  private saveKeywordReferenceMeaning(target: string, label: string, meaning: string, sourcePath: string, preserveExistingWhenEmpty = false): Promise<void> {
    return this.keywords.saveReferenceMeaning(target, label, meaning, sourcePath, preserveExistingWhenEmpty);
  }
  private saveKeywordMeaning(name: string, meaning: string, notify = true): Promise<void> { return this.keywords.saveMeaning(name, meaning, notify); }
  private saveKeyword(current: KeywordNoteEntry | null, value: string, meaning: string): Promise<void> { return this.keywords.save(current, value, meaning); }
  private deleteKeyword(entry: KeywordNoteEntry): Promise<void> { return this.keywords.delete(entry); }
  private loadKeywordMeanings(question: QuestionRecord): Promise<Map<string, string>> { return this.keywords.loadMeanings(question); }
  private readKeywordNote(path: string): Promise<string> { return this.keywords.readMeaning(path); }
  private applyFollowUpChanges(
    changes: ReadonlyMap<string, readonly string[]>,
    expected?: ReadonlyMap<string, QuestionRecord & { id: string }>,
  ): Promise<void> {
    return this.followUps.apply(changes, expected);
  }
  private subjectQuestions(subject: string, written?: ReadonlyMap<string, string>): Promise<QuestionRecord[]> { return this.subjectNotes.questions(subject, written); }
  private syncSubjectNote(subject: string, questions: QuestionRecord[]): Promise<void> { return this.subjectNotes.sync(subject, questions); }
}

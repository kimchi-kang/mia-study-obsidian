import { MarkdownView, Notice, Platform, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type { ExportImage } from "./core/subject-export";
import { StartupDiagnostics } from "./services/startup-diagnostics";
import { downloadsDirectory, openExportFile, revealExportFile, writeExportFile } from "./services/export-file";
import { SubjectExportModal, type ExportReceipt } from "./ui/subject-export-modal";
import { FsrsService, StudyGrade } from "./core/fsrs-service";
import { StudyUiStore } from "./services/study-ui-store";
import { QuestionPreviewModal } from "./ui/question-preview-modal";
import { errorMessage } from "./ui/error-message";
import { planFollowUpChanges, questionBlockLink } from "./core/follow-up";
import {
  assertMergeableKeywordNote,
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
import { KeywordReference, MiaSettings, QuestionRecord, QuestionReviewState } from "./core/models";
import { assertPortablePathSegment, portableNameKey } from "./core/note-name";
import { parseQuestionFile } from "./core/question-parser";
import {
  isManagedSubjectNote,
  renderSubjectNote,
  subjectNoteFileName,
} from "./core/subject-note";
import {
  QuestionMetadataInput,
  createQuestionId,
  assertQuestionUnchanged,
  findCurrentQuestion,
  registerQuestion,
  updateQuestionMetadata,
} from "./core/question-writer";
import { MiaDataStore } from "./services/data-store";
import { applyFileChanges, FileChange } from "./services/file-change-batch";
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
  studyUi!: StudyUiStore;
  portableSyncActive = false;
  private legacyStudyStorage!: VerifiedPluginStorage;
  private activeStudyStorage!: PluginDataStorage;
  private legacyResumePath = "";
  private portableSyncKey = "";
  private startupDiagnostics: StartupDiagnostics | null = null;
  private unloadRequested = false;

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
    this.fsrs = new FsrsService(this.store.settings);
    this.register(this.store.subscribe(() => { this.fsrs = new FsrsService(this.store.settings); }));
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

  async updateSettings(patch: Partial<MiaSettings>, expectedBase?: MiaSettings): Promise<void> {
    await this.store.updateSettings(patch, expectedBase);
    this.fsrs = new FsrsService(this.store.settings);
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

  openSubjectExport(): void {
    const counts = new Map<string, number>();
    for (const subject of this.listSubjects()) counts.set(subject, 0);
    for (const question of this.index.registered) counts.set(question.subject, (counts.get(question.subject) ?? 0) + 1);
    const subjects = [...counts].sort(([a], [b]) => a.localeCompare(b, "ko"))
      .map(([name, count]) => ({ name, count }));
    new SubjectExportModal(this.app, subjects, (subject) => this.exportSubject(subject),
      Platform.isDesktopApp ? "다운로드 폴더" : "보관함의 MIA 출력 폴더").open();
  }

  private async exportSubject(subject: string): Promise<ExportReceipt> {
    await this.index.rebuild();
    const { exportSubjectDocx } = await import("./core/subject-export");
    const result = await exportSubjectDocx(subject, this.index.registered, (target, source) => this.readExportImage(target, source));
    const safeSubject = subject.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_");
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const filename = `${safeSubject} 질문 답변 ${stamp}.docx`;
    if (Platform.isDesktopApp) {
      const path = await writeExportFile(downloadsDirectory(), filename, result.data);
      return { path, count: result.count, warnings: result.warnings,
        openFile: () => openExportFile(path), revealFile: () => revealExportFile(path) };
    }
    const folder = "MIA 출력";
    await this.ensureFolder(folder);
    const stem = `${folder}/${filename.slice(0, -5)}`;
    let path = `${stem}.docx`;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(path); suffix++) path = `${stem} ${suffix}.docx`;
    await this.app.vault.createBinary(path, result.data);
    return { path, count: result.count, warnings: result.warnings };
  }

  private async readExportImage(target: string, source: string): Promise<ExportImage | null> {
    // Resolve vault attachments only; exporting never fetches remote resources.
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) return null;
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch { return null; }
    const file = this.app.metadataCache.getFirstLinkpathDest(decoded, source);
    if (!(file instanceof TFile)) return null;
    const extension = file.extension.toLowerCase();
    if (extension !== "png" && extension !== "jpg" && extension !== "jpeg" && extension !== "gif" && extension !== "bmp") return null;
    const data = await this.app.vault.readBinary(file);
    // Image decoders sniff bytes; the document media type must match those bytes too.
    const header = new Uint8Array(data, 0, Math.min(data.byteLength, 8));
    const startsWith = (signature: readonly number[]): boolean => signature.every((byte, index) => header[index] === byte);
    const type: ExportImage["type"] | null = startsWith([137, 80, 78, 71, 13, 10, 26, 10]) ? "png"
      : startsWith([255, 216, 255]) ? "jpg"
      : startsWith([71, 73, 70, 56, 55, 97]) || startsWith([71, 73, 70, 56, 57, 97]) ? "gif"
      : startsWith([66, 77]) ? "bmp" : null;
    if (!type) throw new Error(`지원하지 않는 이미지 형식입니다: ${file.path}`);
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve(); image.onerror = () => reject(new Error(`이미지를 읽을 수 없습니다: ${file.path}`)); image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error(`이미지 크기를 읽을 수 없습니다: ${file.path}`);
      return { data, type, width: image.naturalWidth, height: image.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
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
    new ManagedQuestionModal(
      this.app,
      subjects,
      this.store.settings.keywordFolder,
      question,
      meanings,
      async (draft) => {
        if (question) await this.updateManagedQuestion(question, draft, (persisted) => { question = persisted; });
        else await this.createManagedQuestion(draft);
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
      assertQuestionUnchanged(question, latest);
      const next = { ...metadata, createdAt: latest.createdAt ?? now, updatedAt: now };
      return latest.id ? updateQuestionMetadata(content, latest, next) : registerQuestion(content, latest, next, id);
    });
    await this.index.refreshFile(file);
    new Notice(question.id ? "MIA 학습 정보를 저장했습니다." : "문제를 MIA에 등록했습니다.");
  }

  private async createSubject(value: string): Promise<void> {
    const subject = validateSubjectName(value);
    const keywordContainer = this.keywordContainerName();
    if (keywordContainer && portableNameKey(subject) === portableNameKey(keywordContainer)) throw new Error("키워드 보관 폴더와 같은 이름은 사용할 수 없습니다.");
    await this.ensureFolder(this.managedRoot);
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    this.assertPortablePath(folderPath);
    if (this.app.vault.getAbstractFileByPath(folderPath)) throw new Error("이미 존재하는 과목입니다.");
    await this.app.vault.createFolder(folderPath);
    await this.app.vault.create(normalizePath(`${folderPath}/문제은행.md`), createSubjectBank(subject));
    await this.app.vault.create(this.subjectNotePath(subject), renderSubjectNote(subject, []));
    new Notice(`${subject} 과목을 만들었습니다.`);
  }

  private async renameSubject(current: string, value: string): Promise<void> {
    const next = validateSubjectName(value);
    if (next === current) return;
    const keywordContainer = this.keywordContainerName();
    if (keywordContainer && portableNameKey(next) === portableNameKey(keywordContainer)) throw new Error("키워드 보관 폴더와 같은 이름은 사용할 수 없습니다.");
    const currentPath = normalizePath(`${this.managedRoot}/${current}`);
    const nextPath = normalizePath(`${this.managedRoot}/${next}`);
    this.assertPortablePath(nextPath);
    const folder = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(folder instanceof TFolder)) throw new Error("기존 과목 폴더를 찾지 못했습니다.");
    if (this.app.vault.getAbstractFileByPath(nextPath)) throw new Error("같은 이름의 과목이 이미 있습니다.");
    const oldNotePath = this.subjectNotePath(current);
    this.assertPortablePath(normalizePath(`${currentPath}/${subjectNoteFileName(next)}`));
    const oldNote = this.app.vault.getAbstractFileByPath(oldNotePath);
    const renameGeneratedNote = oldNote instanceof TFile
      && isManagedSubjectNote(await this.app.vault.cachedRead(oldNote));
    const futureNote = this.app.vault.getAbstractFileByPath(normalizePath(`${currentPath}/${subjectNoteFileName(next)}`));
    if (futureNote && futureNote.path !== oldNotePath) throw new Error("변경할 과목 노트 이름과 같은 파일이 이미 있습니다.");
    let createdNote: { path: string; content: string } | undefined;
    try {
      await this.app.fileManager.renameFile(folder, nextPath);
      if (renameGeneratedNote) {
        const movedNote = this.app.vault.getAbstractFileByPath(normalizePath(`${nextPath}/${subjectNoteFileName(current)}`));
        if (!(movedNote instanceof TFile)) throw new Error("과목 폴더 변경 후 자동 노트를 찾지 못했습니다.");
        await this.app.fileManager.renameFile(movedNote, this.subjectNotePath(next));
      }
      await this.index.rebuild();
      const bank = this.app.vault.getAbstractFileByPath(normalizePath(`${nextPath}/문제은행.md`));
      const writes: FileChange[] = [];
      if (bank instanceof TFile) writes.push({ file: bank, update: content => renameSubjectBank(content, current, next) });
      const generatedNote = this.app.vault.getAbstractFileByPath(this.subjectNotePath(next));
      if (renameGeneratedNote && generatedNote instanceof TFile) {
        const questions = bank instanceof TFile
          ? parseQuestionFile(bank.path, await this.app.vault.read(bank), { subject: next }).questions : [];
        writes.push({ file: generatedNote, update: content => {
          if (!isManagedSubjectNote(content)) throw new Error("과목 노트가 사용자 노트로 변경되어 덮어쓰지 않았습니다.");
          return renderSubjectNote(next, questions);
        } });
      }
      await applyFileChanges(this.app.vault, writes, async () => {
        if (!renameGeneratedNote) {
          const questions = bank instanceof TFile
            ? parseQuestionFile(bank.path, await this.app.vault.read(bank), { subject: next }).questions : [];
          const path = this.subjectNotePath(next);
          if (this.app.vault.getAbstractFileByPath(path)) throw new Error("새 과목 노트 경로에 다른 파일이 생겼습니다.");
          createdNote = { path, content: renderSubjectNote(next, questions) };
          await this.app.vault.create(path, createdNote.content);
        }
        await this.index.rebuild();
        await this.refreshIncomingFollowUpLinks(this.index.registered.filter(question => question.subject === next).map(question => question.id));
      });
    } catch (error) {
      try {
        if (createdNote) {
          const note = this.app.vault.getAbstractFileByPath(createdNote.path);
          if (note instanceof TFile) {
            if (await this.app.vault.read(note) !== createdNote.content) throw new Error("새 과목 노트가 다른 작업에서 변경되어 보존했습니다.");
            await this.trashFileVerified(note);
          } else if (note) throw new Error("새 과목 노트 경로가 변경되어 보존했습니다.");
        }
        if (oldNote instanceof TFile && oldNote.path === this.subjectNotePath(next)) {
          const restoreNotePath = normalizePath(`${nextPath}/${subjectNoteFileName(current)}`);
          if (this.app.vault.getAbstractFileByPath(restoreNotePath)) throw new Error("원래 과목 노트 경로가 사용 중입니다.");
          await this.app.fileManager.renameFile(oldNote, restoreNotePath);
        }
        if (folder.path === nextPath) {
          if (this.app.vault.getAbstractFileByPath(currentPath)) throw new Error("원래 과목 폴더 경로가 사용 중입니다.");
          await this.app.fileManager.renameFile(folder, currentPath);
        }
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "과목 이름 변경을 복구하지 못했습니다. 원래 폴더와 변경 폴더를 확인하세요.");
      } finally {
        await this.index.rebuild();
      }
      throw error;
    }
    await this.index.rebuild();
    new Notice(`${current} 과목을 ${next}(으)로 변경했습니다.`);
  }

  private async deleteSubject(subject: string): Promise<void> {
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) throw new Error("과목 폴더를 찾지 못했습니다.");
    const ids = this.index.registered
      .filter((question) => question.filePath.startsWith(`${folderPath}/`))
      .map((question) => question.id);
    await this.trashFileVerified(folder);
    try {
      await this.index.rebuild();
      const writes = this.followUpFileChanges(this.removedFollowUpChanges(ids));
      await applyFileChanges(this.app.vault, writes, () => this.store.removeReviews(ids));
      await this.index.rebuild();
    } catch (error) {
      await this.index.rebuild();
      throw new Error("과목 폴더는 휴지통으로 이동했지만 평가 또는 연결 정리가 완료되지 않았습니다. 복구하려면 휴지통의 과목 폴더를 확인하세요.", { cause: error });
    }
    new Notice(`${subject} 과목을 휴지통으로 이동했습니다.`);
  }

  private async createManagedQuestion(draft: ManagedQuestionDraft): Promise<void> {
    const subject = validateSubjectName(draft.subject);
    this.validateManagedDraft(draft);
    const folderPath = normalizePath(`${this.managedRoot}/${subject}`);
    await this.ensureFolder(folderPath);
    const filePath = normalizePath(`${folderPath}/문제은행.md`);
    this.assertPortablePath(filePath);
    let file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) file = await this.app.vault.create(filePath, createSubjectBank(subject));
    if (!(file instanceof TFile)) throw new Error("문제은행 경로가 파일이 아닙니다.");
    await this.assertSubjectNoteWritable(subject);
    const id = createQuestionId();
    const now = new Date().toISOString();
    await this.saveDraftKeywordMeanings(draft, true);
    let updatedContent = "";
    await this.app.vault.process(file, (content) => {
      updatedContent = appendManagedQuestion(content, { ...draft, createdAt: now, updatedAt: now }, id);
      return updatedContent;
    });
    await this.index.refreshFile(file);
    await this.syncSubjectNote(subject, parseQuestionFile(filePath, updatedContent, { subject }).questions);
    new Notice("질문을 문제은행에 추가했습니다.");
  }

  private async updateManagedQuestion(question: QuestionRecord, draft: ManagedQuestionDraft, onPersisted?: (question: QuestionRecord) => void): Promise<void> {
    if (!question.id) throw new Error("등록되지 않은 질문은 GUI에서 전체 수정할 수 없습니다.");
    const nextSubject = validateSubjectName(draft.subject);
    this.validateManagedDraft(draft);
    const file = this.app.vault.getAbstractFileByPath(question.filePath);
    if (!(file instanceof TFile)) throw new Error("문제 파일을 찾지 못했습니다.");
    const latest = await this.app.vault.read(file);
    const current = findCurrentQuestion(parseQuestionFile(question.filePath, latest).questions, question);
    if (!current) throw new Error("수정할 문제를 찾지 못했습니다. 최신 문제를 다시 확인하세요.");
    assertQuestionUnchanged(question, current);
    await this.assertSubjectNoteWritable(question.subject);
    await this.assertSubjectNoteWritable(nextSubject);
    await this.saveDraftKeywordMeanings(draft);
    if (nextSubject !== question.subject) {
      await this.moveManagedQuestion(question as QuestionRecord & { id: string }, { ...draft, subject: nextSubject });
      new Notice("질문을 다른 과목으로 옮기고 두 과목 노트를 갱신했습니다.");
      return;
    }
    let updatedContent = "";
    try {
      await this.app.vault.process(file, (content) => {
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
      if (!updatedContent || await this.app.vault.read(file) !== updatedContent) throw error;
    }
    const persisted = parseQuestionFile(question.filePath, updatedContent, { subject: question.subject }).questions;
    const saved = persisted.find((item) => item.id === question.id);
    if (!saved) throw new Error("저장한 원본 문제를 확인하지 못했습니다.");
    // Keep the editor's optimistic-concurrency baseline current even if a derived note fails.
    onPersisted?.(saved);
    try {
      await this.index.refreshFile(file);
      await this.syncSubjectNote(question.subject, persisted);
      await this.refreshIncomingFollowUpLinks([question.id]);
    } catch (error) {
      throw new Error(`원본 문제는 저장됐지만 화면·연결 노트 갱신을 완료하지 못했습니다. 입력 내용은 유지됩니다. 다시 저장해 갱신을 재시도하세요. (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    new Notice("질문과 학습 정보를 수정했습니다.");
  }

  private async moveManagedQuestion(
    question: QuestionRecord & { id: string },
    draft: ManagedQuestionDraft,
  ): Promise<void> {
    const oldFile = this.app.vault.getAbstractFileByPath(question.filePath);
    if (!(oldFile instanceof TFile)) throw new Error("기존 문제 파일을 찾지 못했습니다.");
    const blockOf = (content: string, record: QuestionRecord): string => content.replaceAll("\r\n", "\n").split("\n")
      .slice(record.location.headingLine, record.location.answerEndLine).join("\n").trimEnd();
    const source = await this.app.vault.read(oldFile);
    const now = new Date().toISOString();
    const edited = replaceCurrentManagedQuestion(
      source, question, (latest) => parseQuestionFile(question.filePath, latest).questions,
      { ...draft, createdAt: question.createdAt ?? now, updatedAt: now },
    );
    const editedQuestion = parseQuestionFile(question.filePath, edited).questions.find(item => item.id === question.id);
    if (!editedQuestion) throw new Error("이동할 문제를 확인하지 못했습니다.");
    const { rebaseMarkdownLinks } = await import("./core/markdown-links");
    const questionBlock = blockOf(edited, editedQuestion);
    const originalQuestion = parseQuestionFile(question.filePath, source).questions.find(item => item.id === question.id);
    if (!originalQuestion) throw new Error("원본 문제를 확인하지 못했습니다.");
    const originalBlock = blockOf(source, originalQuestion);
    const nextFolder = normalizePath(`${this.managedRoot}/${draft.subject}`);
    await this.ensureFolder(nextFolder);
    const nextPath = normalizePath(`${nextFolder}/문제은행.md`);
    this.assertPortablePath(nextPath);
    let nextFile = this.app.vault.getAbstractFileByPath(nextPath);
    if (!nextFile) nextFile = await this.app.vault.create(nextPath, createSubjectBank(draft.subject));
    if (!(nextFile instanceof TFile)) throw new Error("이동할 문제은행 경로가 파일이 아닙니다.");

    const block = rebaseMarkdownLinks(questionBlock, question.filePath, nextPath);
    let nextContent = "";
    let inserted: QuestionRecord | undefined;
    await this.app.vault.process(nextFile, (content) => {
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

    let oldContent: string | undefined;
    try {
      await this.app.vault.process(oldFile, (content) => {
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
        actualSource = await this.app.vault.read(oldFile);
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
          await this.app.vault.process(nextFile, (content) => {
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
    const review = this.store.getReview(question.id);
    const links = this.removedFollowUpChanges([question.id]);
    let updatedContent = "";
    const writes: FileChange[] = [{ file, update: content => {
      updatedContent = deleteCurrentManagedQuestion(content, question, latest => parseQuestionFile(question.filePath, latest).questions);
      return updatedContent;
    } }, ...this.followUpFileChanges(links)];
    await applyFileChanges(this.app.vault, writes, () => this.store.removeReview(question.id, { state: review }));
    await this.index.rebuild();
    try {
      await this.syncSubjectNote(question.subject, parseQuestionFile(question.filePath, updatedContent, { subject: question.subject }).questions);
    } catch (error) {
      throw new Error("문제와 평가·연결은 삭제했지만 과목 노트 갱신은 완료되지 않았습니다. 과목 노트를 다시 확인하세요.", { cause: error });
    }
    new Notice("질문을 문제은행과 과목 노트에서 삭제했습니다.");
  }

  private async saveDraftKeywordMeanings(draft: ManagedQuestionDraft, preserveExistingWhenEmpty = false): Promise<void> {
    for (const item of draft.keywordMeanings) {
      await this.saveKeywordReferenceMeaning(item.target, item.label, item.meaning, preserveExistingWhenEmpty);
    }
  }

  private validateManagedDraft(draft: ManagedQuestionDraft): void {
    validateManagedQuestionInput(draft);
    for (const item of draft.keywordMeanings) {
      validateKeywordMeaning(item.meaning);
      keywordNotePath(item.target, item.label, this.store.settings.keywordFolder);
    }
  }

  private async saveKeywordReferenceMeaning(target: string, label: string, meaning: string, preserveExistingWhenEmpty = false): Promise<void> {
    validateKeywordMeaning(meaning);
    const path = keywordNotePath(target, label, this.store.settings.keywordFolder);
    this.assertPortablePath(path);
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile) {
      if (preserveExistingWhenEmpty && !meaning.trim()) return;
      await this.app.vault.process(existing, (content) => updateKeywordMeaning(content, label, meaning));
    } else {
      await this.app.vault.create(path, createKeywordNote(label, meaning));
    }
  }

  private async saveKeywordMeaning(name: string, meaning: string, notify = true): Promise<void> {
    const safeName = validateKeywordName(name);
    validateKeywordMeaning(meaning);
    const path = keywordNotePath(safeName, safeName, this.store.settings.keywordFolder);
    this.assertPortablePath(path);
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
    if (!current) {
      await this.saveKeywordMeaning(name, meaning);
      return;
    }
    if (current.name === name) {
      validateKeywordMeaning(meaning);
      const file = this.app.vault.getAbstractFileByPath(current.filePath);
      if (!(file instanceof TFile)) throw new Error("기존 키워드 노트를 찾지 못했습니다.");
      await this.app.vault.process(file, content => updateKeywordMeaning(content, name, meaning));
      new Notice(`${name} 키워드를 저장했습니다.`);
      return;
    }
    const source = this.app.vault.getAbstractFileByPath(current.filePath);
    if (!(source instanceof TFile)) throw new Error("기존 키워드 노트를 찾지 못했습니다.");
    const nextPath = keywordNotePath(name, name, this.store.settings.keywordFolder);
    this.assertPortablePath(nextPath);
    const destination = this.app.vault.getAbstractFileByPath(nextPath);
    if (destination instanceof TFolder) throw new Error("변경할 키워드 경로가 폴더와 겹칩니다.");
    const nextTarget = nextPath.replace(/\.md$/i, "");
    const references = () => this.keywordReferenceChanges(
      [current.target, nextTarget],
      (items) => renameKeywordReferences(items, [current.target, nextTarget], nextTarget, name),
    );
    if (destination instanceof TFile) {
      const sourceContent = await this.app.vault.read(source);
      assertMergeableKeywordNote(sourceContent);
      const sourceMeaning = readKeywordMeaning(sourceContent);
      await applyFileChanges(this.app.vault, [{ file: destination, update: content => {
        const destinationMeaning = readKeywordMeaning(content);
        const mergedMeaning = [...new Set([destinationMeaning, sourceMeaning, meaning].map(item => item.trim()).filter(Boolean))].join("\n\n");
        return updateKeywordMeaning(content, name, mergedMeaning);
      } }, ...references()], async () => {
        if (await this.app.vault.read(source) !== sourceContent) throw new Error("병합 중 원본 키워드가 변경되어 삭제하지 않았습니다.");
        await this.trashFileVerified(source);
      });
    } else {
      try {
        await this.app.fileManager.renameFile(source, nextPath);
        const renamed = this.app.vault.getAbstractFileByPath(nextPath);
        if (!(renamed instanceof TFile) || renamed !== source) throw new Error("키워드 이름을 바꾼 뒤 노트를 확인하지 못했습니다.");
        await applyFileChanges(this.app.vault, [
          { file: renamed, update: content => updateKeywordMeaning(content, name, meaning) }, ...references(),
        ]);
      } catch (error) {
        try {
          if (source.path === nextPath) {
            if (this.app.vault.getAbstractFileByPath(current.filePath)) throw new Error("원래 경로에 다른 파일이 생겨 덮어쓰지 않았습니다.");
            await this.app.fileManager.renameFile(source, current.filePath);
          }
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "키워드 이름 변경을 복구하지 못했습니다. 원래 경로와 변경 경로를 확인하세요.");
        } finally {
          await this.index.rebuild();
        }
        throw error;
      }
    }
    await this.index.rebuild();
    new Notice(`${current.name} 키워드를 ${name}(으)로 변경했습니다.`);
  }

  private questionsUsingKeyword(targets: readonly string[]): Array<QuestionRecord & { id: string }> {
    return this.index.registered.filter((question) =>
      [...question.coreKeywords, ...question.subKeywords]
        .some((reference) => keywordReferenceMatches(reference, targets)),
    );
  }

  private keywordReferenceChanges(
    targets: readonly string[],
    transform: (references: readonly KeywordReference[]) => KeywordReference[],
  ): FileChange[] {
    const byFile = new Map<string, Array<QuestionRecord & { id: string }>>();
    for (const question of this.questionsUsingKeyword(targets)) {
      const questions = byFile.get(question.filePath) ?? [];
      questions.push(question);
      byFile.set(question.filePath, questions);
    }
    const writes: FileChange[] = [];
    for (const [filePath, questions] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) throw new Error(`${filePath} 문제 파일을 찾지 못했습니다.`);
      writes.push({ file, update: (content) => {
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
      } });
    }
    return writes;
  }

  private async trashFileVerified(file: TFile | TFolder): Promise<void> {
    const path = file.path;
    try {
      await this.app.fileManager.trashFile(file);
    } catch (error) {
      if (this.app.vault.getAbstractFileByPath(path)) throw error;
      // A rejected trash operation can already have moved the entry successfully.
    }
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`${path}: 휴지통 이동을 확인하지 못했습니다.`);
  }

  private async deleteKeyword(entry: KeywordNoteEntry): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(entry.filePath);
    if (!(file instanceof TFile)) throw new Error("삭제할 키워드 노트를 찾지 못했습니다.");
    const writes = this.keywordReferenceChanges([entry.target], references => removeKeywordReferences(references, [entry.target]));
    await applyFileChanges(this.app.vault, writes, () => this.trashFileVerified(file));
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

  private async rateQuestionDirectly(id: string, grade: StudyGrade, baseline: QuestionReviewState | undefined): Promise<void> {
    await this.store.setReview(id, this.fsrs.rate(baseline, grade, new Date(), id), { state: baseline });
  }

  private removedFollowUpChanges(removedIds: readonly string[]): Map<string, string[]> {
    const removed = new Set(removedIds);
    const changes = new Map<string, string[]>();
    for (const question of this.index.registered) {
      if (removed.has(question.id) || !question.followUpIds.some((id) => removed.has(id))) continue;
      changes.set(question.id, question.followUpIds.filter((id) => !removed.has(id)));
    }
    return changes;
  }

  private async refreshIncomingFollowUpLinks(targetIds: readonly string[]): Promise<void> {
    const targets = new Set(targetIds);
    const changes = new Map<string, string[]>();
    for (const question of this.index.registered) {
      if (question.followUpIds.some((id) => targets.has(id))) changes.set(question.id, question.followUpIds);
    }
    if (changes.size) await this.applyFollowUpChanges(changes);
  }

  private followUpFileChanges(
    changes: ReadonlyMap<string, readonly string[]>,
    expected?: ReadonlyMap<string, QuestionRecord & { id: string }>,
  ): FileChange[] {
    const snapshot = new Map(this.index.registered.map((question) => [question.id, question]));
    const baselines = expected ?? snapshot;
    const byFile = new Map<string, string[]>();
    for (const id of changes.keys()) {
      const question = snapshot.get(id);
      if (!question || !baselines.has(id)) throw new Error("연결을 편집할 질문이 변경 또는 삭제되었습니다. 최신 화면을 다시 열어 주세요.");
      for (const targetId of changes.get(id) ?? []) {
        if (!snapshot.has(targetId)) throw new Error("연결할 질문이 변경 또는 삭제되었습니다. 최신 목록을 다시 확인하세요.");
      }
      const ids = byFile.get(question.filePath) ?? [];
      ids.push(id);
      byFile.set(question.filePath, ids);
    }
    const updatedAt = new Date().toISOString();
    const writes: FileChange[] = [];
    for (const [filePath, ids] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) throw new Error(`${filePath} 문제 파일을 찾지 못했습니다.`);
      writes.push({ file, update: (content) => {
        let updated = content;
        for (const id of ids) {
          const original = snapshot.get(id);
          if (!original) continue;
          const current = findCurrentQuestion(parseQuestionFile(filePath, updated).questions, original);
          if (!current) throw new Error(`연결을 수정할 질문을 찾지 못했습니다: ${original.heading}`);
          const baseline = baselines.get(id);
          if (!baseline || JSON.stringify(current.followUpIds) !== JSON.stringify(baseline.followUpIds)) {
            throw new Error("질문 연결이 다른 작업에서 변경되었습니다. 최신 화면을 다시 열어 주세요.");
          }
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
      } });
    }
    return writes;
  }

  private async applyFollowUpChanges(
    changes: ReadonlyMap<string, readonly string[]>,
    expected?: ReadonlyMap<string, QuestionRecord & { id: string }>,
  ): Promise<void> {
    const writes = this.followUpFileChanges(changes, expected);
    await applyFileChanges(this.app.vault, writes);
    for (const { file } of writes) await this.index.refreshFile(file);
  }

  private async readKeywordNote(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return "";
    return readKeywordMeaning(await this.app.vault.cachedRead(file));
  }

  private assertPortablePath(path: string): void {
    const parts = normalizePath(path).split("/");
    let parent: TFolder | undefined = this.app.vault.getRoot();
    for (const part of parts) {
      assertPortablePathSegment(part, "저장 경로");
      const matches: TAbstractFile[] = parent?.children.filter((child) => portableNameKey(child.name) === portableNameKey(part)) ?? [];
      if (matches.some((child) => child.name !== part)) {
        throw new Error("대소문자나 한글 표기만 다른 이름이 이미 있습니다. 기존 이름의 표기를 사용하세요.");
      }
      const child = matches[0];
      parent = child instanceof TFolder ? child : undefined;
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    this.assertPortablePath(normalized);
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
    this.assertPortablePath(this.subjectNotePath(subject));
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
    if (existing instanceof TFile) await this.app.vault.process(existing, latest => {
      if (!isManagedSubjectNote(latest)) throw new Error(`${subjectNoteFileName(subject)} 파일이 사용자 노트로 변경되어 덮어쓰지 않았습니다.`);
      return content;
    });
    else await this.app.vault.create(path, content);
  }

  private async syncAllSubjectNotes(notify: boolean): Promise<void> {
    if (this.unloadRequested) return;
    let count = 0;
    const failures: string[] = [];
    for (const subject of this.listSubjects()) {
      if (this.unloadRequested) return;
      try {
        const bankPath = normalizePath(`${this.managedRoot}/${subject}/문제은행.md`);
        const bank = this.app.vault.getAbstractFileByPath(bankPath);
        const questions = bank instanceof TFile
          ? parseQuestionFile(bankPath, await this.app.vault.cachedRead(bank), { subject }).questions
          : [];
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

  private keywordContainerName(): string | null {
    return this.store.settings.keywordFolder.startsWith(`${this.managedRoot}/`)
      ? this.store.settings.keywordFolder.slice(this.managedRoot.length + 1).split("/")[0] ?? null
      : null;
  }
}

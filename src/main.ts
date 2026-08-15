import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { FsrsService } from "./core/fsrs-service";
import { MiaSettings, QuestionRecord } from "./core/models";
import { parseQuestionFile } from "./core/question-parser";
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
    this.app.workspace.onLayoutReady(() => void this.index.start());
  }

  onunload(): void {
    this.index.stop();
  }

  async updateSettings(patch: Partial<MiaSettings>): Promise<void> {
    await this.store.updateSettings(patch);
    this.fsrs = new FsrsService(this.store.settings);
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
    await this.app.vault.process(file, (content) => {
      const latest = findCurrentQuestion(parseQuestionFile(question.filePath, content).questions, question);
      if (!latest) throw new Error("원문이 바뀌어 문제 위치를 안전하게 찾지 못했습니다. 창을 닫고 다시 등록해 주세요.");
      return latest.id ? updateQuestionMetadata(content, latest, metadata) : registerQuestion(content, latest, metadata, id);
    });
    await this.index.refreshFile(file);
    new Notice(question.id ? "MIA 학습 정보를 저장했습니다." : "문제를 MIA에 등록했습니다.");
  }
}

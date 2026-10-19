import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { QuestionRecord } from "../core/models";
import { StudyAppearance } from "../services/study-ui-store";

/** Read-only peek: opening and closing never changes a study queue or a review. */
export class QuestionPreviewModal extends Modal {
  private renderer: Component | null = null;
  constructor(app: App, private readonly question: QuestionRecord, private readonly details: () => void, private readonly restore: () => void, private readonly appearance: StudyAppearance) { super(app); }
  async onOpen(): Promise<void> {
    this.setTitle("이어볼 문제 미리보기");
    this.modalEl.addClass("mia-preview-modal");
    this.modalEl.dataset.readingSize = this.appearance.size;
    this.renderer = new Component(); this.renderer.load();
    this.contentEl.createEl("p", { text: `${this.question.subject} · ${this.question.questionType}`, cls: "mia-muted" });
    this.contentEl.createEl("h3", { text: this.question.heading });
    const prompt = this.contentEl.createDiv({ cls: "mia-markdown" });
    this.contentEl.createEl("h4", { text: "모범 답안" });
    const answer = this.contentEl.createDiv({ cls: "mia-markdown mia-answer" });
    const actions = this.contentEl.createDiv({ cls: "mia-preview-actions" });
    actions.createEl("button", { text: "전체 상세" }).addEventListener("click", () => { this.close(); this.details(); });
    actions.createEl("button", { text: "닫기", cls: "mod-cta" }).addEventListener("click", () => this.close());
    await Promise.all([
      this.question.questionMarkdown.trim() !== this.question.heading.trim()
        ? MarkdownRenderer.render(this.app, this.question.questionMarkdown, prompt, this.question.filePath, this.renderer) : Promise.resolve(),
      MarkdownRenderer.render(this.app, this.question.answerMarkdown, answer, this.question.filePath, this.renderer),
    ]);
  }
  onClose(): void { this.renderer?.unload(); this.renderer = null; this.contentEl.empty(); this.restore(); }
}

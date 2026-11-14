import { App, Component, Modal } from "obsidian";
import { QuestionReviewState } from "../core/models";
import { QuestionRecommendation } from "../core/recommendation-engine";
import { ModalOpenGuard } from "./modal-open-guard";
import { QuestionDetailActions, QuestionDetailView, RegisteredQuestion } from "./question-detail-view";

export type { QuestionDetailActions } from "./question-detail-view";

/** The question detail as a dialog; the body is shared with the question-list side panel. */
export class QuestionDetailModal extends Modal {
  private renderer: Component | null = null;
  private renderRevision = 0;
  private readonly detail: QuestionDetailView;

  constructor(
    app: App,
    question: RegisteredQuestion,
    review: QuestionReviewState | undefined,
    recommendations: readonly QuestionRecommendation[],
    meanings: ReadonlyMap<string, string>,
    actions: QuestionDetailActions,
    modalOpenGuard = new ModalOpenGuard(),
  ) {
    super(app);
    this.detail = new QuestionDetailView(app, { question, review, recommendations, meanings, actions }, {
      afterAction: () => this.close(),
      afterMutation: () => this.close(),
    }, modalOpenGuard);
    this.setTitle(question.heading);
  }

  async onOpen(): Promise<void> {
    const revision = ++this.renderRevision;
    this.contentEl.empty();
    this.modalEl.addClass("mia-detail-modal");
    this.renderer = new Component();
    this.renderer.load();
    await this.detail.render(this.contentEl, this.titleEl, this.renderer, () => revision === this.renderRevision);
  }

  onClose(): void {
    this.renderRevision += 1;
    this.renderer?.unload();
    this.renderer = null;
    this.modalEl.removeClass("mia-detail-modal");
    this.contentEl.empty();
  }
}

import { App, Component, MarkdownRenderer, Notice } from "obsidian";
import { Rating } from "ts-fsrs";
import { StudyGrade } from "../core/fsrs-service";
import { QuestionRecord, QuestionReviewState } from "../core/models";
import { QuestionRecommendation } from "../core/recommendation-engine";
import { withoutSourceAttribution } from "../core/source-attribution";
import { errorMessage } from "./error-message";
import { ConfirmDeleteModal } from "./manage-modals";
import { renderQuestionTitle } from "./question-title";
import { GRADE_HINTS } from "./study-grades";
import { dialogKey, ModalOpenGuard } from "./modal-open-guard";

export type RegisteredQuestion = QuestionRecord & { id: string };

const RATING_LABELS: Record<number, string> = {
  [Rating.Again]: "못 암기",
  [Rating.Hard]: "애매",
  [Rating.Good]: "암기",
  [Rating.Easy]: "너무 쉬움",
};

export interface QuestionDetailActions {
  study: () => void;
  edit: () => void;
  connections: () => void;
  remove: () => void;
  showKeyword: (target: string, label: string) => void;
  rate: (grade: StudyGrade) => Promise<void>;
  resetReview: () => Promise<void>;
}

/** Everything the detail needs, resolved once so the modal and the side panel show the same thing. */
export interface QuestionDetailSource {
  question: RegisteredQuestion;
  review: QuestionReviewState | undefined;
  recommendations: readonly QuestionRecommendation[];
  meanings: ReadonlyMap<string, string>;
  actions: QuestionDetailActions;
}

/** What the host does once an action ran; the modal closes itself, the panel stays open. */
export interface QuestionDetailHooks {
  /** 학습 / 편집 / 연결 / 삭제 was chosen (called before the action itself). */
  afterAction(): void;
  /** A direct rating or a review reset was saved. */
  afterMutation(): void;
}

/**
 * The question detail body: metadata, question, answer, keywords, direct
 * status change, history, related questions and the action bar. The modal
 * and the question-list side panel both render it, so behaviour cannot drift.
 */
export class QuestionDetailView {
  private saving = false;
  private mutationButtons: HTMLButtonElement[] = [];

  constructor(
    private readonly app: App,
    private readonly source: QuestionDetailSource,
    private readonly hooks: QuestionDetailHooks,
    private readonly modalOpenGuard = new ModalOpenGuard(),
  ) {}

  /**
   * Renders into `parent`, with the title in `titleEl`. `isCurrent` turns false
   * when the host closed or re-rendered, so a slow Markdown render never writes
   * into a stale container.
   */
  async render(parent: HTMLElement, titleEl: HTMLElement, component: Component, isCurrent: () => boolean): Promise<void> {
    const { question, review, recommendations } = this.source;
    this.mutationButtons = [];
    const body = parent.createDiv({ cls: "mia-detail-scroll" });
    const titleRender = renderQuestionTitle(this.app, question.heading, titleEl, question.filePath, component);
    const metadata = body.createDiv({ cls: "mia-detail-meta" });
    metadata.createSpan({ text: question.subject });
    metadata.createSpan({ text: question.questionType });
    if (question.createdAt) metadata.createSpan({ text: `생성 ${new Date(question.createdAt).toLocaleString("ko-KR")}` });
    if (question.updatedAt) metadata.createSpan({ text: `수정 ${new Date(question.updatedAt).toLocaleString("ko-KR")}` });

    body.createEl("h3", { text: "질문" });
    const prompt = body.createDiv({ cls: "mia-markdown" });
    await Promise.all([titleRender, MarkdownRenderer.render(this.app, withoutSourceAttribution(question.questionMarkdown), prompt, question.filePath, component)]);
    if (!isCurrent()) return;
    body.createEl("h3", { text: "정답" });
    const answer = body.createDiv({ cls: "mia-markdown mia-answer" });
    await MarkdownRenderer.render(this.app, withoutSourceAttribution(question.answerMarkdown), answer, question.filePath, component);
    if (!isCurrent()) return;

    this.renderKeywords(body, "핵심 키워드", question.coreKeywords);
    this.renderKeywords(body, "보조 키워드", question.subKeywords);

    body.createEl("h3", { text: "현재 상태 변경" });
    const status = body.createDiv({ cls: "mia-detail-status" });
    const ratings = status.createDiv({ cls: "mia-ratings" });
    for (const grade of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as StudyGrade[]) {
      const button = ratings.createEl("button", { text: RATING_LABELS[grade] ?? String(grade) });
      this.mutationButtons.push(button);
      button.setAttribute("title", GRADE_HINTS[grade]);
      button.dataset.action = `rate-${grade}`;
      button.addEventListener("click", () => void this.perform(() => this.source.actions.rate(grade), "상태를 변경했습니다."));
    }
    const reset = status.createEl("button", { text: "학습 전으로 초기화", cls: "mia-source mia-detail-reset" });
    reset.disabled = !review;
    this.mutationButtons.push(reset);
    reset.dataset.action = "reset";
    reset.addEventListener("click", () => this.confirmReset());

    body.createEl("h3", { text: `복습 기록 ${review?.history.length ?? 0}회` });
    const history = body.createDiv({ cls: "mia-history" });
    for (const entry of [...(review?.history ?? [])].reverse()) {
      // ts-fsrs log.due is last_review || due, not the preceding scheduled due.
      history.createDiv({ text: `${new Date(entry.review).toLocaleString("ko-KR")} · ${RATING_LABELS[entry.rating] ?? entry.rating} · 계산 기준 ${new Date(entry.due).toLocaleString("ko-KR")}` });
    }
    if (!review?.history.length) history.createEl("p", { text: "아직 복습 기록이 없습니다.", cls: "mia-muted" });

    body.createEl("h3", { text: "관련 질문" });
    const related = body.createDiv({ cls: "mia-related" });
    for (const recommendation of recommendations) {
      const row = related.createDiv({ cls: "mia-detail-related-row" });
      const target = recommendation.question;
      void renderQuestionTitle(this.app, target.heading, row.createSpan(), target.filePath, component);
      row.createSpan({ text: ` — ${recommendation.reasons.join(" · ")} (${recommendation.score}점)` });
    }
    if (!recommendations.length) related.createEl("p", { text: "추천할 관련 질문이 없습니다.", cls: "mia-muted" });

    // Same names and places on every screen: 학습 first, 편집 · 연결 in the middle, 삭제 last.
    const controls = parent.createDiv({ cls: "mia-inline-actions mia-detail-actions" });
    this.actionButton(controls, "학습", this.source.actions.study, "study");
    this.actionButton(controls, "편집", this.source.actions.edit, "edit");
    this.actionButton(controls, "연결", this.source.actions.connections, "connections");
    this.actionButton(controls, "삭제", this.source.actions.remove, "remove", "mod-warning");
  }

  private renderKeywords(parent: HTMLElement, title: string, keywords: RegisteredQuestion["coreKeywords"]): void {
    parent.createEl("h3", { text: title });
    const list = parent.createDiv({ cls: "mia-keyword-detail-list" });
    for (const keyword of keywords) {
      const row = list.createEl("button");
      row.createEl("strong", { text: keyword.label });
      row.createEl("small", { text: this.source.meanings.get(keyword.target) || "의미 없음" });
      row.dataset.action = `keyword-${keyword.target}`;
      row.addEventListener("click", () => this.source.actions.showKeyword(keyword.target, keyword.label));
    }
    if (!keywords.length) list.createSpan({ text: "없음", cls: "mia-muted" });
  }

  private confirmReset(): void {
    if (this.saving) return;
    const count = this.source.review?.history.length ?? 0;
    this.modalOpenGuard.open(dialogKey("review-reset-confirmation", this.source.question.id), () => new ConfirmDeleteModal(
      this.app,
      "학습 기록 초기화",
      `이 질문의 복습 기록 ${count}회와 다음 복습 일정이 모두 지워지고 새 문제로 돌아갑니다. 질문·정답·키워드·연결 질문은 그대로입니다. 되돌릴 수 없습니다.`,
      "초기화",
      () => this.perform(this.source.actions.resetReview, "복습 기록을 초기화했습니다."),
      "초기화 실패",
    ));
  }

  private actionButton(parent: HTMLElement, label: string, action: () => void, id: string, cls?: string): void {
    const button = parent.createEl("button", { text: label, ...(cls ? { cls } : {}) });
    button.dataset.action = id;
    this.mutationButtons.push(button);
    button.addEventListener("click", () => { if (!this.saving) { this.hooks.afterAction(); action(); } });
  }

  private async perform(action: () => Promise<void>, success: string): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    const disabled = this.mutationButtons.map((item) => item.disabled);
    this.mutationButtons.forEach((item) => { item.disabled = true; });
    try {
      await action();
      new Notice(success);
      this.hooks.afterMutation();
    } catch (error) {
      new Notice(`변경 실패: ${errorMessage(error)}`);
      this.mutationButtons.forEach((item, index) => { item.disabled = disabled[index] ?? false; });
    } finally {
      this.saving = false;
    }
  }
}

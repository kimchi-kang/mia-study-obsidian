import { renderQuestionTitle } from "./question-title";
import { App, Component, MarkdownRenderer, Modal, Notice } from "obsidian";
import { Rating } from "ts-fsrs";
import { StudyGrade } from "../core/fsrs-service";
import { QuestionRecord, QuestionReviewState } from "../core/models";
import { QuestionRecommendation } from "../core/recommendation-engine";
import { errorMessage } from "./error-message";
import { GRADE_HINTS } from "./study-grades";

type RegisteredQuestion = QuestionRecord & { id: string };

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
  openSource: () => void;
  showKeyword: (target: string, label: string) => void;
  rate: (grade: StudyGrade) => Promise<void>;
  resetReview: () => Promise<void>;
}

export class QuestionDetailModal extends Modal {
  private renderer: Component | null = null;
  private saving = false;
  private mutationButtons: HTMLButtonElement[] = [];
  private renderRevision = 0;

  constructor(
    app: App,
    private readonly question: RegisteredQuestion,
    private readonly review: QuestionReviewState | undefined,
    private readonly recommendations: readonly QuestionRecommendation[],
    private readonly meanings: ReadonlyMap<string, string>,
    private readonly actions: QuestionDetailActions,
  ) {
    super(app);
    this.setTitle(question.heading);
  }

  async onOpen(): Promise<void> {
    const revision = ++this.renderRevision;
    this.contentEl.empty();
    this.mutationButtons = [];
    this.modalEl.addClass("mia-detail-modal");
    this.renderer = new Component();
    this.renderer.load();
    const titleRender = renderQuestionTitle(this.app, this.question.heading, this.titleEl, this.question.filePath, this.renderer);
    const metadata = this.contentEl.createDiv({ cls: "mia-detail-meta" });
    metadata.createSpan({ text: this.question.subject });
    metadata.createSpan({ text: this.question.questionType });
    if (this.question.createdAt) metadata.createSpan({ text: `생성 ${new Date(this.question.createdAt).toLocaleString("ko-KR")}` });
    if (this.question.updatedAt) metadata.createSpan({ text: `수정 ${new Date(this.question.updatedAt).toLocaleString("ko-KR")}` });

    this.contentEl.createEl("h3", { text: "질문" });
    const prompt = this.contentEl.createDiv({ cls: "mia-markdown" });
    await Promise.all([titleRender, MarkdownRenderer.render(this.app, this.question.questionMarkdown, prompt, this.question.filePath, this.renderer)]);
    if (revision !== this.renderRevision) return;
    this.contentEl.createEl("h3", { text: "정답" });
    const answer = this.contentEl.createDiv({ cls: "mia-markdown mia-answer" });
    await MarkdownRenderer.render(this.app, this.question.answerMarkdown, answer, this.question.filePath, this.renderer);
    if (revision !== this.renderRevision) return;

    this.renderKeywords("핵심 키워드", this.question.coreKeywords);
    this.renderKeywords("보조 키워드", this.question.subKeywords);

    this.contentEl.createEl("h3", { text: "현재 상태 변경" });
    const ratings = this.contentEl.createDiv({ cls: "mia-ratings" });
    for (const grade of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as StudyGrade[]) {
      const button = ratings.createEl("button", { text: RATING_LABELS[grade] ?? String(grade) });
      this.mutationButtons.push(button);
      button.setAttribute("title", GRADE_HINTS[grade]);
      button.addEventListener("click", () => void this.perform(() => this.actions.rate(grade), "상태를 변경했습니다."));
    }
    const reset = this.contentEl.createEl("button", { text: "학습 전으로 초기화", cls: "mia-source" });
    reset.disabled = !this.review;
    this.mutationButtons.push(reset);
    reset.addEventListener("click", () => void this.perform(this.actions.resetReview, "복습 기록을 초기화했습니다."));

    this.contentEl.createEl("h3", { text: `복습 기록 ${this.review?.history.length ?? 0}회` });
    const history = this.contentEl.createDiv({ cls: "mia-history" });
    for (const entry of [...(this.review?.history ?? [])].reverse()) {
      history.createDiv({ text: `${new Date(entry.review).toLocaleString("ko-KR")} · ${RATING_LABELS[entry.rating] ?? entry.rating} · 당시 예정 ${new Date(entry.due).toLocaleString("ko-KR")}` });
    }
    if (!this.review?.history.length) history.createEl("p", { text: "아직 복습 기록이 없습니다.", cls: "mia-muted" });

    this.contentEl.createEl("h3", { text: "관련 질문" });
    const related = this.contentEl.createDiv({ cls: "mia-related" });
    for (const recommendation of this.recommendations) {
      const row = related.createDiv();
      const question = recommendation.question;
      void renderQuestionTitle(this.app, question.heading, row.createSpan(), question.filePath, this.renderer);
      row.createSpan({ text: ` — ${recommendation.reasons.join(" · ")} (${recommendation.score}점)` });
    }
    if (!this.recommendations.length) related.createEl("p", { text: "추천할 관련 질문이 없습니다.", cls: "mia-muted" });

    const controls = this.contentEl.createDiv({ cls: "mia-inline-actions mia-detail-actions" });
    this.actionButton(controls, "학습", this.actions.study);
    this.actionButton(controls, "질문 수정", this.actions.edit);
    this.actionButton(controls, "연결 관리", this.actions.connections);
    this.actionButton(controls, "원문", this.actions.openSource);
    this.actionButton(controls, "삭제", this.actions.remove, "mod-warning");
  }

  private renderKeywords(title: string, keywords: RegisteredQuestion["coreKeywords"]): void {
    this.contentEl.createEl("h3", { text: title });
    const list = this.contentEl.createDiv({ cls: "mia-keyword-detail-list" });
    for (const keyword of keywords) {
      const row = list.createEl("button");
      row.createEl("strong", { text: keyword.label });
      row.createEl("small", { text: this.meanings.get(keyword.target) || "의미 없음" });
      row.addEventListener("click", () => this.actions.showKeyword(keyword.target, keyword.label));
    }
    if (!keywords.length) list.createSpan({ text: "없음", cls: "mia-muted" });
  }

  private actionButton(parent: HTMLElement, label: string, action: () => void, cls?: string): void {
    const button = parent.createEl("button", { text: label, ...(cls ? { cls } : {}) });
    this.mutationButtons.push(button);
    button.addEventListener("click", () => { if (!this.saving) { this.close(); action(); } });
  }

  private async perform(action: () => Promise<void>, success: string): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    const disabled = this.mutationButtons.map((item) => item.disabled);
    this.mutationButtons.forEach((item) => { item.disabled = true; });
    try {
      await action();
      new Notice(success);
      this.close();
    } catch (error) {
      new Notice(`변경 실패: ${errorMessage(error)}`);
      this.mutationButtons.forEach((item, index) => { item.disabled = disabled[index] ?? false; });
    } finally {
      this.saving = false;
    }
  }

  onClose(): void {
    this.renderRevision += 1;
    this.renderer?.unload();
    this.renderer = null;
    this.modalEl.removeClass("mia-detail-modal");
    this.contentEl.empty();
  }
}

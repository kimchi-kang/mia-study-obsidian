import { Rating } from "ts-fsrs";
import { queryQuestions, weaknessUrgency } from "../core/question-query";
import { renderQuestionHeading } from "./question-row";
import type { StudyPageContext } from "./study-page-context";

/** Again/Hard questions ordered by urgency, which also weighs how overdue each is. */
export function renderWeakness(ctx: StudyPageContext, root: HTMLElement): void {
  root.createEl("h3", { text: "취약 문제", cls: "mia-page-title" });
  root.createEl("p", { text: "못 암기와 애매 문제를 복습 지연 시간까지 반영한 긴급도 순으로 표시합니다.", cls: "mia-muted" });
  const toolbar = root.createDiv({ cls: "mia-toolbar" });
  const search = toolbar.createEl("input", { type: "search", placeholder: "취약 문제 검색", attr: { "aria-label": "취약 문제 검색" } });
  const start = toolbar.createEl("button", { text: "취약 문제 시험", cls: "mod-cta" });
  const list = root.createDiv({ cls: "mia-list" });
  let query = "";
  let composing = false;
  const renderList = () => {
    list.empty();
    const questions = queryQuestions(ctx.plugin.index.registered, ctx.plugin.store.reviews, ctx.plugin.fsrs, {
      text: query,
      subject: "all",
      questionType: "all",
      review: "weak",
      keyword: "",
      sort: "weak",
    });
    start.disabled = questions.length === 0;
    start.onclick = () => ctx.startReview(questions.map((question) => question.id));
    for (const question of questions.slice(0, 300)) {
      const row = list.createDiv({ cls: "mia-row" });
      const body = row.createDiv({ cls: "mia-row-body" });
      renderQuestionHeading(ctx, body.createEl("strong"), question);
      const review = ctx.plugin.store.getReview(question.id);
      body.createEl("small", { text: `${question.subject} · 긴급도 ${weaknessUrgency(review)}점 · ${review?.lastRating === Rating.Again ? "못 암기" : "애매"}` });
      const actions = row.createDiv({ cls: "mia-row-actions" });
      actions.createEl("button", { text: "학습" }).addEventListener("click", () => ctx.startReview([question.id]));
      actions.createEl("button", { text: "상세" }).addEventListener("click", () => void ctx.plugin.openQuestionDetail(question));
    }
    if (questions.length > 300) list.createEl("p", { text: `${questions.length}개 중 긴급도가 높은 300개만 표시합니다.`, cls: "mia-muted" });
    if (!questions.length) list.createEl("p", { text: "현재 취약 문제가 없습니다.", cls: "mia-empty" });
  };
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; query = search.value; renderList(); });
  search.addEventListener("input", () => { if (!composing) { query = search.value; renderList(); } });
  renderList();
}

import { MarkdownRenderer } from "obsidian";
import { Rating } from "ts-fsrs";
import type { QuestionRecord } from "../core/models";
import type { RegisteredQuestion } from "./question-detail-view";
import { weaknessUrgency } from "../core/question-query";
import { withoutSourceAttribution } from "../core/source-attribution";
import { openEditorWithNotice } from "./editor-notice";
import { renderQuestionTitle } from "./question-title";
import type { StudyPageContext } from "./study-page-context";

export function renderQuestionHeading(ctx: StudyPageContext, element: HTMLElement, question: QuestionRecord, component = ctx.component): void {
  ctx.renders.push(renderQuestionTitle(ctx.app, question.heading, element, question.filePath, component));
}

export interface QuestionRowOptions {
  /** Opens the detail; defaults to the detail dialog. The question list passes its side panel here. */
  openDetail?: (question: RegisteredQuestion) => void;
  selected?: boolean;
  /** Adds the urgency score and last grade, as the former weak-question page did. */
  showWeakness?: boolean;
}

/** One-word review state shown as a coloured dot, so a row can be scanned without opening it. */
function reviewState(ctx: StudyPageContext, question: RegisteredQuestion): { label: string; tone: string } {
  const review = ctx.plugin.store.getReview(question.id);
  if (ctx.plugin.fsrs.isNew(review)) return { label: "학습 전", tone: "total" };
  if (review?.lastRating === Rating.Again || review?.lastRating === Rating.Hard) return { label: "취약", tone: "again" };
  if (ctx.plugin.fsrs.isDue(review)) return { label: "오늘 복습", tone: "review" };
  return { label: "학습함", tone: "good" };
}

/**
 * A question row laid out as table columns: state dot, title and prompt, then
 * 학습 · 상세 · 편집 · 연결 as equal-width buttons and 삭제 as red text at the far right.
 * Pressing the row (outside its own buttons and links) opens the detail too.
 */
export function renderQuestionRow(ctx: StudyPageContext, parent: HTMLElement, question: RegisteredQuestion, component = ctx.component, options: QuestionRowOptions = {}): void {
  const openDetail = options.openDetail ?? ((target: RegisteredQuestion) => void ctx.plugin.openQuestionDetail(target));
  const row = parent.createDiv({ cls: "mia-row" });
  row.dataset.questionId = question.id;
  if (options.selected) { row.addClass("mia-row-selected"); row.setAttr("aria-current", "true"); }
  row.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("button, a, input, select, textarea, summary")) return;
    // Selecting text inside the row is not a request to open it.
    if (row.ownerDocument.getSelection()?.toString()) return;
    openDetail(question);
  });
  const state = reviewState(ctx, question);
  const dot = row.createSpan({ cls: "mia-row-state" });
  dot.dataset.tone = state.tone;
  dot.setAttr("role", "img");
  dot.setAttr("aria-label", state.label);
  dot.setAttr("title", state.label);
  const body = row.createDiv({ cls: "mia-row-body" });
  renderQuestionHeading(ctx, body.createEl("strong"), question, component);
  const prompt = body.createDiv({ cls: "mia-row-prompt mia-markdown" });
  ctx.renders.push(MarkdownRenderer.render(ctx.app, withoutSourceAttribution(question.questionMarkdown), prompt, question.filePath, component));
  body.createEl("small", { text: `${question.subject} · ${question.questionType} · 핵심 ${question.coreKeywords.map((item) => item.label).join(", ") || "없음"} · 보조 ${question.subKeywords.map((item) => item.label).join(", ") || "없음"}` });
  if (options.showWeakness) {
    const review = ctx.plugin.store.getReview(question.id);
    body.createEl("small", { text: `긴급도 ${weaknessUrgency(review)}점 · ${review?.lastRating === Rating.Again ? "못 암기" : "애매"}`, cls: "mia-row-urgency" });
  }
  const actions = row.createDiv({ cls: "mia-row-actions" });
  actions.createEl("button", { text: "학습", attr: { "aria-label": `${question.heading} 학습` } }).addEventListener("click", () => ctx.startReview([question.id]));
  actions.createEl("button", { text: "상세", attr: { "aria-label": `${question.heading} 상세` } }).addEventListener("click", () => openDetail(question));
  actions.createEl("button", { text: "편집", attr: { "aria-label": `${question.heading} 편집` } }).addEventListener("click", () => openEditorWithNotice("문제 편집", () => ctx.plugin.openManagedQuestionEditor(question)));
  actions.createEl("button", { text: "연결", attr: { "aria-label": `${question.heading} 연결` } }).addEventListener("click", () => openEditorWithNotice("문제 연결", () => ctx.plugin.openFollowUpEditor(question)));
  row.createEl("button", { text: "삭제", cls: "mod-warning mia-row-delete", attr: { "aria-label": `${question.heading} 삭제` } }).addEventListener("click", () => {
    ctx.plugin.confirmDeleteQuestion(question);
  });
}

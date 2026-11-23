import { isLeech, LEECH_LAPSES } from "../core/study-automation";
import { reportUiFailure } from "./error-message";
import { MarkdownRenderer } from "obsidian";
import { Rating } from "ts-fsrs";
import type { QuestionRecord } from "../core/models";
import type { RegisteredQuestion } from "./question-detail-view";
import { weaknessUrgency } from "../core/question-query";
import { withoutSourceAttribution } from "../core/source-attribution";
import { renderQuestionTitle } from "./question-title";
import type { StudyPageContext } from "./study-page-context";

export function renderQuestionHeading(ctx: StudyPageContext, element: HTMLElement, question: Pick<QuestionRecord, "heading" | "filePath">, component = ctx.component): void {
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
 * A question row: state dot, title and prompt, and a › mark. The row carries no buttons of its
 * own; pressing it (or its title with Enter/Space) opens the detail, where 학습 · 편집 · 연결 · 삭제 live.
 */
export function renderQuestionRow(ctx: StudyPageContext, parent: HTMLElement, question: RegisteredQuestion, component = ctx.component, options: QuestionRowOptions = {}): void {
  const openDetail = options.openDetail ?? ((target: RegisteredQuestion) => reportUiFailure(ctx.plugin.openQuestionDetail(target)));
  const row = parent.createDiv({ cls: "mia-row" });
  row.dataset.questionId = question.id;
  if (options.selected) { row.addClass("mia-row-selected"); row.setAttr("aria-current", "true"); }
  row.addEventListener("click", (event: MouseEvent) => {
    const target = event?.target as HTMLElement | null | undefined;
    if (target?.closest?.("button, a, input, select, textarea, summary")) return;
    // Selecting text inside the row is not a request to open it.
    if (row.ownerDocument?.getSelection?.()?.toString()) return;
    openDetail(question);
  });
  const state = reviewState(ctx, question);
  const dot = row.createSpan({ cls: "mia-row-state" });
  dot.dataset.tone = state.tone;
  dot.setAttr("role", "img");
  dot.setAttr("aria-label", state.label);
  dot.setAttr("title", state.label);
  const body = row.createDiv({ cls: "mia-row-body" });
  const review = ctx.plugin.store.getReview(question.id);
  const leech = review && isLeech(review);
  const heading = body.createEl("strong", { attr: { role: "button", tabindex: "0", "aria-label": `${question.heading}${leech ? " · 자주 틀림" : ""} 상세 보기` } });
  // 키워드 이름과 같은 방식: Enter는 누를 때, Space는 손을 뗄 때 연다(일반 버튼과 같게).
  heading.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") { event.preventDefault(); openDetail(question); }
    else if (event.key === " ") event.preventDefault();
  });
  heading.addEventListener("keyup", (event: KeyboardEvent) => {
    if (event.key === " ") { event.preventDefault(); openDetail(question); }
  });
  renderQuestionHeading(ctx, leech ? heading.createSpan() : heading, question, component);
  if (leech) {
    const label = `${LEECH_LAPSES}번 이상 잊은 문제 (잊은 횟수 ${review.card.lapses}회)`;
    heading.createSpan({ text: "자주 틀림", cls: "mia-leech", attr: { title: label, "aria-label": label } });
  }
  const prompt = body.createDiv({ cls: "mia-row-prompt mia-markdown" });
  ctx.renders.push(MarkdownRenderer.render(ctx.app, withoutSourceAttribution(question.questionMarkdown), prompt, question.filePath, component));
  const meta = body.createEl("small");
  // 상태 점의 색만으로는 적색 야간 모드·색약 환경에서 구분이 어려워 같은 상태를 글자로도 붙인다.
  meta.createSpan({ text: state.label, cls: "mia-row-tag" }).dataset.tone = state.tone;
  meta.createSpan({ text: `${question.subject} · ${question.questionType} · 핵심 ${question.coreKeywords.map((item) => item.label).join(", ") || "없음"} · 보조 ${question.subKeywords.map((item) => item.label).join(", ") || "없음"}` });
  if (options.showWeakness) {
    const review = ctx.plugin.store.getReview(question.id);
    body.createEl("small", { text: `긴급도 ${weaknessUrgency(review)}점 · ${review?.lastRating === Rating.Again ? "못 암기" : "애매"}`, cls: "mia-row-urgency" });
  }
  row.createSpan({ text: "›", cls: "mia-row-more", attr: { "aria-hidden": "true" } });
}

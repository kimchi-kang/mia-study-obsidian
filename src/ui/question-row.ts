import { MarkdownRenderer } from "obsidian";
import type { QuestionRecord } from "../core/models";
import { withoutSourceAttribution } from "../core/source-attribution";
import { renderQuestionTitle } from "./question-title";
import type { StudyPageContext } from "./study-page-context";

export function renderQuestionHeading(ctx: StudyPageContext, element: HTMLElement, question: QuestionRecord, component = ctx.component): void {
  ctx.renders.push(renderQuestionTitle(ctx.app, question.heading, element, question.filePath, component));
}

export function renderQuestionRow(ctx: StudyPageContext, parent: HTMLElement, question: QuestionRecord & { id: string }, component = ctx.component): void {
  const row = parent.createDiv({ cls: "mia-row" });
  const body = row.createDiv({ cls: "mia-row-body" });
  renderQuestionHeading(ctx, body.createEl("strong"), question, component);
  const prompt = body.createDiv({ cls: "mia-row-prompt mia-markdown" });
  ctx.renders.push(MarkdownRenderer.render(ctx.app, withoutSourceAttribution(question.questionMarkdown), prompt, question.filePath, component));
  body.createEl("small", { text: `${question.subject} · ${question.questionType} · 핵심 ${question.coreKeywords.map((item) => item.label).join(", ") || "없음"} · 보조 ${question.subKeywords.map((item) => item.label).join(", ") || "없음"}` });
  const actions = row.createDiv({ cls: "mia-row-actions" });
  actions.createEl("button", { text: "학습" }).addEventListener("click", () => ctx.startReview([question.id]));
  actions.createEl("button", { text: "상세" }).addEventListener("click", () => void ctx.plugin.openQuestionDetail(question));
  actions.createEl("button", { text: "편집" }).addEventListener("click", () => void ctx.plugin.openManagedQuestionEditor(question));
  actions.createEl("button", { text: "연결" }).addEventListener("click", () => ctx.plugin.openFollowUpEditor(question));
  actions.createEl("button", { text: "삭제", cls: "mod-warning" }).addEventListener("click", () => {
    ctx.plugin.confirmDeleteQuestion(question);
  });
}

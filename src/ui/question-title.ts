import { App, Component, MarkdownRenderer } from "obsidian";

/** Keep ordinary labels literal; pass equation titles through Obsidian's renderer. */
export async function renderQuestionTitle(app: App, text: string, element: HTMLElement, sourcePath: string, component: Component): Promise<void> {
  if (text.trim() === "$$") { element.setText("수식 질문"); return; }
  if (!text.includes("$")) { element.setText(text); return; }
  element.empty();
  element.addClass("mia-question-heading");
  // A numbered question title must remain a label rather than become a Markdown list.
  const markdown = text.replace(/^( {0,3})(\d{1,9})([.)])(?=\s)/u, "$1$2\\$3")
    .replace(/^( {0,3})([#>*+-])(?=\s)/u, "$1\\$2");
  await MarkdownRenderer.render(app, markdown, element, sourcePath, component);
}

import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ MarkdownRenderer: { render: vi.fn(async () => {}) } }));
import { MarkdownRenderer, Component, App } from "obsidian";
import { renderQuestionTitle } from "../src/ui/question-title";

describe("equation question titles", () => {
  it.each(["5. Ordinary question", "# Ordinary question", String.raw`Unit \[C\]`])("keeps non-math titles literal: %s", async text => {
    const setText = vi.fn();
    await renderQuestionTitle({} as App, text, { setText } as Partial<HTMLElement> as HTMLElement, "bank.md", {} as Component);
    expect(setText).toHaveBeenCalledWith(text);
  });
  it.each([["5. $E=mc^2$", String.raw`5\. $E=mc^2$`], ["# $F=qvB$", String.raw`\# $F=qvB$`], ["$E=mc^2$", "$E=mc^2$"]])("renders math without turning the title into a list: %s", async (text, source) => {
    const element = { empty: vi.fn(), addClass: vi.fn() } as Partial<HTMLElement> as HTMLElement;
    const app = {} as App, component = {} as Component;
    await renderQuestionTitle(app, text, element, "nested/bank.md", component);
    expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, source, element, "nested/bank.md", component);
  });
});

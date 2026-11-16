import MarkdownIt from "markdown-it";
const markdown = new MarkdownIt();

// Obsidian boundary only; StudyView, recommendation engine and FSRS remain real.
// Same plugin/store contract as study-session.test.js, with real jsdom elements.
export function obsidianLayoutBoundary() {
  class Component { load() {} unload() {} }
  return {
    Component,
    ItemView: class { constructor(leaf) { this.app = leaf.app; this.leaf = leaf; this.contentEl = document.createElement("div"); } },
    Modal: class {}, Setting: class {}, Notice: class { constructor(message) { throw new Error(message); } },
    Platform: { isMobile: false },
    MarkdownRenderer: { render: async (_app, text, element) => { element.innerHTML = markdown.render(text); } },
  };
}


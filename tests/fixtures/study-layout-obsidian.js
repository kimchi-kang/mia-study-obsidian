import MarkdownIt from "markdown-it";
const markdown = new MarkdownIt();

export class LayoutMenu {
  static shown;
  items = [];
  addItem(build) {
    const item = {
      setTitle(title) { this.title = title; return this; },
      setWarning(warning) { this.warning = warning; return this; },
      onClick(click) { this.click = click; return this; },
    };
    build(item);
    this.items.push(item);
    return this;
  }
  showAtMouseEvent(event) { this.event = event; LayoutMenu.shown = this; return this; }
  showAtPosition(position, doc) { this.position = position; this.doc = doc; LayoutMenu.shown = this; return this; }
}

// Obsidian boundary only; StudyView, recommendation engine and FSRS remain real.
// Same plugin/store contract as study-session.test.js, with real jsdom elements.
export function obsidianLayoutBoundary() {
  class Component { load() {} unload() {} addChild(child) { return child; } removeChild() {} }
  return {
    Component,
    Menu: LayoutMenu,
    setIcon(element, icon) {
      const svg = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-icon", icon);
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      element.appendChild(svg);
    },
    ItemView: class { constructor(leaf) { this.app = leaf.app; this.leaf = leaf; this.contentEl = document.createElement("div"); } },
    Modal: class {}, Setting: class {}, Notice: class { constructor(message) { throw new Error(message); } },
    Platform: { isMobile: false },
    MarkdownRenderer: { render: async (_app, text, element) => { element.innerHTML = markdown.render(text); } },
  };
}


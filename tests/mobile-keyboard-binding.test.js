import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ App: class {}, Modal: class {} }));
import { bindKeyboardViewport } from "../src/ui/mobile-keyboard";

// Replace only browser/Obsidian element boundaries; exercise the actual binding lifecycle.
class Element {
  children = []; parent = null; className = ""; handlers = new Map(); attached = false;
  style = { setProperty() {}, removeProperty() {} };
  constructor(document) { this.ownerDocument = document; }
  get isConnected() { return this.attached || !!this.parent?.isConnected; }
  addClass(...names) { this.className = [...new Set([...this.className.split(" "), ...names])].join(" "); }
  removeClass(...names) { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); }
  hasClass(name) { return this.className.split(" ").includes(name); }
  toggleClass(name, enabled) { if (enabled) this.addClass(name); else this.removeClass(name); }
  append(child) { child.remove(); this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  querySelector(selector) { for (const child of this.children) { if (child.hasClass(selector.slice(1))) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
  contains(child) { return child === this || this.children.some(item => item.contains(child)); }
  setAttribute() {}
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name) { this.handlers.delete(name); }
  getBoundingClientRect() { return { top: 0, height: 120 }; }
}
class Input extends Element {
  value = "11";
  blur() { this.ownerDocument.activeElement = null; }
  scrollIntoView() {}
}
function setup(modal = true, size = { width: 390, height: 844, visual: 534 }) {
  vi.useFakeTimers();
  vi.stubGlobal("HTMLInputElement", Input); vi.stubGlobal("HTMLTextAreaElement", Input);
  const viewport = { height: size.visual, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const window = { innerHeight: size.height, innerWidth: size.width, visualViewport: viewport, setTimeout, clearTimeout, requestAnimationFrame: vi.fn(), cancelAnimationFrame: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const document = { defaultView: window, documentElement: { clientHeight: size.height }, createElement: () => new Element(document), activeElement: null };
  const surface = new Element(document); surface.attached = true;
  if (modal) surface.addClass("mia-keyboard-modal-container");
  const content = new Element(document), actions = new Element(document), input = new Input(document);
  actions.addClass("mia-keyboard-actions"); surface.append(content); content.append(input); content.append(actions); document.activeElement = input;
  const binding = bindKeyboardViewport(surface, content);
  return { binding, surface, content, actions, input, viewport, document, window };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mobile keyboard action lifecycle", () => {
  it("keeps modal dismissal inside the shared footer and blurs without changing the draft", () => {
    const ui = setup();
    const dismiss = ui.actions.querySelector(".mia-keyboard-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss.handlers.get("click")();
    expect(ui.document.activeElement).toBeNull(); expect(ui.input.value).toBe("11");
    ui.binding.destroy(); expect(dismiss.isConnected).toBe(false);
  });
  it("rebinds dismissal after restoring defaults replaces the footer, without duplicates", () => {
    const ui = setup(); ui.actions.remove();
    const replacement = new Element(ui.document); replacement.addClass("mia-keyboard-actions"); ui.content.append(replacement);
    ui.binding.refresh(); ui.binding.refresh();
    expect(replacement.children).toHaveLength(1);
    expect(replacement.children[0].hasClass("mia-keyboard-dismiss")).toBe(true);
    ui.binding.destroy();
  });
  it("reserves the measured footer height before scrolling the focused input", () => {
    const ui = setup();
    const measure = vi.spyOn(ui.content.style, "setProperty"), scroll = vi.spyOn(ui.input, "scrollIntoView");
    vi.advanceTimersByTime(80);
    expect(measure).toHaveBeenCalledWith("--mia-keyboard-actions-height", "120px");
    expect(scroll).toHaveBeenCalledOnce();
    const cleanup = vi.spyOn(ui.content.style, "removeProperty");
    ui.viewport.height = 844; ui.binding.refresh();
    expect(cleanup).toHaveBeenCalledWith("--mia-keyboard-actions-height");
    ui.binding.destroy();
  });
  it("removes the extra action when the keyboard closes and after destruction", () => {
    const ui = setup(); ui.viewport.height = 844; ui.binding.refresh();
    expect(ui.actions.children).toHaveLength(0);
    ui.binding.destroy(); ui.viewport.height = 534; ui.binding.refresh();
    expect(ui.actions.children).toHaveLength(0);
  });
  it("keeps tablet keyboard handling when height loss crosses the aspect ratio, then resets on rotation", () => {
    const ui = setup(true, { width: 768, height: 1024, visual: 1024 });
    ui.window.innerHeight = 714; ui.document.documentElement.clientHeight = 714; ui.viewport.height = 714;
    ui.binding.refresh();
    expect(ui.surface.hasClass("mia-keyboard-open")).toBe(true);
    expect(ui.actions.children).toHaveLength(1);
    ui.window.innerWidth = 1024; ui.window.innerHeight = 768; ui.document.documentElement.clientHeight = 768; ui.viewport.height = 768;
    ui.binding.refresh();
    expect(ui.surface.hasClass("mia-keyboard-open")).toBe(false);
    expect(ui.actions.children).toHaveLength(0);
    ui.binding.destroy();
  });
  it("keeps non-modal settings dismissal outside embedded learning actions", () => {
    const ui = setup(false);
    expect(ui.actions.children).toHaveLength(0);
    expect(ui.content.children.at(-1).hasClass("mia-keyboard-dismiss")).toBe(true);
    ui.binding.destroy();
  });
});

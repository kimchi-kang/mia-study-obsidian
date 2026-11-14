import { App, Modal } from "obsidian";
import { calculateKeyboardViewport } from "../core/mobile-keyboard-metrics";

export interface KeyboardViewportBinding {
  refresh(): void;
  destroy(): void;
}

function editableTarget(value: unknown): value is HTMLInputElement | HTMLTextAreaElement {
  return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement;
}

export function bindKeyboardViewport(surface: HTMLElement, focusRoot = surface): KeyboardViewportBinding {
  const document = surface.ownerDocument;
  const window = document.defaultView;
  if (!window) return { refresh: () => undefined, destroy: () => undefined };
  const viewport = window.visualViewport;
  let frame = 0;
  let focusTimer = 0;
  let destroyed = false;
  let dismissButton: HTMLButtonElement | null = null;
  let layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  let layoutWidth = window.innerWidth;

  surface.addClass("mia-keyboard-surface");
  const keyboardActions = () => surface.hasClass("mia-keyboard-modal-container")
    ? focusRoot.querySelector<HTMLElement>(".mia-keyboard-actions")
    : null;

  const actionScrollInset = () => {
    const actions = keyboardActions();
    const height = actions?.getBoundingClientRect().height ?? 0;
    // Keep room for a 44px input and reading/scrolling space above the actions.
    // Large text and safe-area padding can make a sticky footer consume the sheet.
    const inline = Boolean(actions) && focusRoot.getBoundingClientRect().height - height < 96;
    focusRoot.toggleClass("mia-keyboard-actions-inline", inline);
    return inline ? 0 : height;
  };

  const scrollFocusedControl = (layoutChanged = false) => {
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      const active = document.activeElement;
      const keyboardOpen = surface.hasClass("mia-keyboard-open");
      if ((!layoutChanged && !keyboardOpen) || !editableTarget(active) || !focusRoot.contains(active)) return;
      const actions = keyboardActions();
      if (actions) focusRoot.style.setProperty("--mia-keyboard-actions-height", `${actionScrollInset()}px`);
      active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }, 80);
  };

  const refresh = () => {
    if (destroyed) return;
    const currentLayoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
    const visualHeight = viewport?.height ?? window.innerHeight;
    const offsetTop = viewport?.offsetTop ?? 0;
    // A keyboard can invert the available aspect ratio without rotating the device.
    // Reset the baseline only when the layout width actually changes.
    const currentLayoutWidth = window.innerWidth;
    const layoutChanged = currentLayoutWidth !== layoutWidth;
    if (layoutChanged) {
      layoutHeight = currentLayoutHeight;
      layoutWidth = currentLayoutWidth;
    } else {
      layoutHeight = Math.max(layoutHeight, currentLayoutHeight);
    }
    const metrics = calculateKeyboardViewport(
      layoutHeight,
      visualHeight,
      offsetTop,
      surface.getBoundingClientRect().top,
    );
    surface.style.setProperty("--mia-visible-viewport-height", `${metrics.visibleHeight}px`);
    surface.style.setProperty("--mia-viewport-offset-top", `${metrics.offsetTop}px`);
    surface.style.setProperty("--mia-keyboard-height", `${metrics.keyboardHeight}px`);
    surface.style.setProperty("--mia-keyboard-available-height", `${metrics.availableHeight}px`);
    surface.toggleClass("mia-keyboard-open", metrics.keyboardOpen);
    if (metrics.keyboardOpen && !dismissButton?.isConnected) {
      dismissButton = document.createElement("button");
      dismissButton.className = "mia-keyboard-dismiss";
      dismissButton.type = "button";
      dismissButton.textContent = "키보드 닫기";
      dismissButton.setAttribute("aria-label", "입력을 유지하고 키보드 닫기");
      dismissButton.addEventListener("click", () => {
        const active = document.activeElement;
        if (editableTarget(active) && focusRoot.contains(active)) active.blur();
      });
      // Keep the field focused until click; otherwise the control can disappear before activation.
      dismissButton.addEventListener("pointerdown", event => event.preventDefault());
      // A modal can opt into one footer so two sticky controls never cover each other.
      (keyboardActions() ?? focusRoot).append(dismissButton);
    }
    if (!metrics.keyboardOpen) { dismissButton?.remove(); dismissButton = null; focusRoot.style.removeProperty("--mia-keyboard-actions-height"); layoutHeight = currentLayoutHeight; }
    actionScrollInset();
    if (metrics.keyboardOpen || layoutChanged) scrollFocusedControl(layoutChanged);
  };

  const scheduleRefresh = () => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(refresh);
  };
  const onFocus = (event: FocusEvent) => {
    if (!editableTarget(event.target) || !focusRoot.contains(event.target)) return;
    scheduleRefresh();
    scrollFocusedControl();
  };

  viewport?.addEventListener("resize", scheduleRefresh);
  viewport?.addEventListener("scroll", scheduleRefresh);
  window.addEventListener("resize", scheduleRefresh);
  focusRoot.addEventListener("focusin", onFocus);
  refresh();

  return {
    refresh,
    destroy: () => {
      destroyed = true;
      dismissButton?.remove();
      dismissButton = null;
      viewport?.removeEventListener("resize", scheduleRefresh);
      viewport?.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      focusRoot.removeEventListener("focusin", onFocus);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(focusTimer);
      surface.removeClass("mia-keyboard-surface", "mia-keyboard-open");
      focusRoot.style.removeProperty("--mia-keyboard-actions-height");
      focusRoot.removeClass("mia-keyboard-actions-inline");
      for (const property of [
        "--mia-visible-viewport-height",
        "--mia-viewport-offset-top",
        "--mia-keyboard-height",
        "--mia-keyboard-available-height",
      ]) surface.style.removeProperty(property);
    },
  };
}

export abstract class KeyboardAwareModal extends Modal {
  private keyboardBinding: KeyboardViewportBinding | null = null;

  constructor(app: App, size: "compact" | "medium" | "long" = "medium") {
    super(app);
    this.modalEl.addClass(`mia-editor-modal-${size}`);
  }

  open(): void {
    super.open();
    this.containerEl.addClass("mia-keyboard-modal-container");
    this.modalEl.addClass("mia-keyboard-modal", "mia-setting-controls");
    this.keyboardBinding?.destroy();
    this.keyboardBinding = bindKeyboardViewport(this.containerEl, this.contentEl);
  }

  close(): void {
    this.keyboardBinding?.destroy();
    this.keyboardBinding = null;
    this.containerEl.removeClass("mia-keyboard-modal-container");
    this.modalEl.removeClass("mia-keyboard-modal");
    super.close();
  }
}

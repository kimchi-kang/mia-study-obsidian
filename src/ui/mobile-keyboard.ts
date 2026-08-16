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
  let layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  let wideLayout = window.innerWidth > layoutHeight;

  surface.addClass("mia-keyboard-surface");

  const scrollFocusedControl = () => {
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!surface.hasClass("mia-keyboard-open") || !editableTarget(active) || !focusRoot.contains(active)) return;
      active.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }, 80);
  };

  const refresh = () => {
    if (destroyed) return;
    const currentLayoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
    const visualHeight = viewport?.height ?? window.innerHeight;
    const offsetTop = viewport?.offsetTop ?? 0;
    const currentWideLayout = window.innerWidth > currentLayoutHeight;
    if (currentWideLayout !== wideLayout) {
      layoutHeight = currentLayoutHeight;
      wideLayout = currentWideLayout;
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
    if (!metrics.keyboardOpen) layoutHeight = currentLayoutHeight;
    if (metrics.keyboardOpen) scrollFocusedControl();
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
      viewport?.removeEventListener("resize", scheduleRefresh);
      viewport?.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      focusRoot.removeEventListener("focusin", onFocus);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(focusTimer);
      surface.removeClass("mia-keyboard-surface", "mia-keyboard-open");
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

  constructor(app: App) {
    super(app);
  }

  open(): void {
    super.open();
    this.containerEl.addClass("mia-keyboard-modal-container");
    this.modalEl.addClass("mia-keyboard-modal");
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

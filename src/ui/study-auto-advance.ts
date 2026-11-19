import { AnswerClock } from "../core/answer-time";
import { autoRemaining } from "../core/study-automation";

export function studyTimerBlocked(document: Document | null): boolean {
  return !!document?.hidden || !!document?.body?.querySelector(".modal-container");
}

/** One current phase; the view owns the shared interval and validates every action. */
export class StudyAutoAdvance {
  private key = "";
  private clock: AnswerClock | null = null;
  private seconds = 0;
  private paused = false;
  private suspended = false;
  private el: HTMLElement | null = null;
  private document: Document | null = null;

  render(parent: HTMLElement, key: string, seconds: number): void {
    this.detach();
    this.document = parent.ownerDocument;
    if (key !== this.key) {
      this.key = key;
      this.paused = false;
      this.clock = new AnswerClock(this.document?.hidden ?? false);
    }
    this.seconds = seconds;
    const context = parent.ownerDocument?.createElement("span");
    if (context && parent.firstChild?.nodeType === 3) {
      context.className = "mia-auto-context";
      parent.insertBefore(context, parent.firstChild);
      context.appendChild(context.nextSibling!);
    }
    this.el = parent.createSpan({ cls: "mia-auto-advance", attr: { role: "button", type: "button", tabindex: "0" } });
    const toggle = () => { this.paused = !this.paused; this.sync(); this.update(); };
    this.el.addEventListener("click", toggle);
    this.el.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggle(); }
    });
    this.sync();
    this.update();
  }
  private get blocked(): boolean {
    return this.suspended || this.paused || studyTimerBlocked(this.document);
  }
  sync(): void {
    if (this.blocked) this.clock?.pause();
    else this.clock?.resume(false);
  }
  pause(): void { this.suspended = true; this.clock?.pause(); }
  resume(): void { this.suspended = false; this.sync(); }
  tick(): boolean {
    this.sync();
    this.update();
    return !this.blocked && !!this.clock && autoRemaining(this.seconds, this.clock.milliseconds) === 0;
  }
  private update(): void {
    if (!this.el || !this.clock) return;
    const remaining = autoRemaining(this.seconds, this.clock.milliseconds);
    const text = this.blocked ? "자동 ∥" : `자동 ${remaining}`;
    if (this.el.textContent !== text) this.el.setText(text);
    this.el.setAttr("aria-label", this.blocked ? "자동 진행 일시정지됨, 눌러서 재개" : `자동 진행 ${remaining}초 남음, 눌러서 일시정지`);
  }
  detach(): void { this.el = null; }
  reset(): void {
    this.detach();
    this.clock = null;
    this.key = "";
    this.document = null;
    this.paused = false;
    this.suspended = false;
  }
}

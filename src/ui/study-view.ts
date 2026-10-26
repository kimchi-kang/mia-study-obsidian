import { StudyManagementModal } from "./study-management-modal";
import { renderQuestionTitle } from "./question-title";
import { Component, ItemView, MarkdownRenderer, Notice, Platform, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { Rating } from "ts-fsrs";
import type MiaStudyPlugin from "../main";
import { StudyGrade } from "../core/fsrs-service";
import { planLearningQueue } from "../core/learning-queue";
import { QUESTION_TYPES, KeywordReference, QuestionRecord, QuestionReviewState } from "../core/models";
import { MiaRoute, MiaSessionMode, ReviewCheckpoint, parseMiaNavigationState } from "../core/navigation";
import { calculateProgress } from "../core/progress";
import { QuestionSort, ReviewFilter, queryQuestions, weaknessUrgency } from "../core/question-query";
import { buildReviewQueue, recommendQuestions } from "../core/recommendation-engine";
import { errorMessage } from "./error-message";
import { bindKeyboardViewport, KeyboardViewportBinding } from "./mobile-keyboard";
import { StudyResult, StudyResultModal } from "./study-result-modal";
import { GRADE_LABELS, GRADE_HINTS } from "./study-grades";
import { bindStudyGestures, StudyGestureBinding } from "./study-gestures";
import { bindAdaptiveLayout } from "./adaptive-layout";
import { bindRatingTapGuard } from "./rating-tap-guard";
import { StudyControlsModal } from "./study-controls-modal";
import { ReviewConflictModal } from "./review-conflict-modal";
import { StudyAppearanceModal } from "./study-appearance-modal";

export const MIA_VIEW_TYPE = "mia-study-view";

function formatInterval(due: Date, days: number, fixedMinutes?: number, now = new Date()): string {
  if (fixedMinutes !== undefined) {
    if (fixedMinutes % 1440 === 0) return `${fixedMinutes / 1440}일`;
    if (fixedMinutes % 60 === 0) return `${fixedMinutes / 60}시간`;
    return `${fixedMinutes}분`;
  }
  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60_000));
  if (days === 0 && minutes < 60) return `${minutes}분`;
  if (days === 0) return `${Math.max(1, Math.round(minutes / 60))}시간`;
  if (days < 30) return `${days}일`;
  if (days < 365) return `${Math.round(days / 30)}개월`;
  return `${(days / 365).toFixed(1)}년`;
}

function keywordKey(keyword: KeywordReference): string {
  const path = keyword.target.split("#")[0]?.replace(/\.md$/i, "").replaceAll("\\", "/") ?? keyword.label;
  return (path.split("/").at(-1) ?? path).trim().toLocaleLowerCase("ko");
}

export class MiaStudyView extends ItemView {
  private route: MiaRoute = "dashboard";
  private queue: string[] = [];
  private queueIndex = 0;
  private answerVisible = false;
  private sessionMode: MiaSessionMode = "recall";
  private lastRated: { id: string; queueIndex: number; queueBefore: string[]; savedState: QuestionReviewState } | null = null;
  private isMutatingReview = false;
  private questionText = "";
  private questionSubject = "all";
  private questionType: "all" | QuestionRecord["questionType"] = "all";
  private questionReview: ReviewFilter = "all";
  private questionKeyword = "";
  private questionSort: QuestionSort = "review";
  private questionPage = 0;
  private candidateLimit = 100;
  private sessionSeed: string[] = [];
  private sessionOrigin: MiaRoute = "dashboard";
  private sessionStartedAt = Date.now();
  private sessionBaselines = new Map<number, QuestionReviewState | undefined>();
  private stateRestored = false;
  private savingReviewCheckpoint: ReviewCheckpoint | undefined;
  private sessionAttempts = new Map<number, { id: string; grade: StudyGrade }>();
  private sessionGrades = new Map<string, StudyGrade>();
  private sessionSkipped = new Set<string>();
  private resultShown = false;
  private renderComponent: Component | null = null;
  private keyboardViewport: KeyboardViewportBinding | null = null;
  private unsubscribers: Array<() => void> = [];
  private learningTimer: number | null = null;
  private resultTimer: number | null = null;
  private resultModal: StudyResultModal | null = null;
  private closed = false;
  private studyShortcuts = new Map<string, HTMLButtonElement>();
  private renderedPosition = "";
  private gestures: StudyGestureBinding | null = null;
  private hintVisible = false;
  private readingPosition = { key: "", scrollTop: 0, pageScrollTop: 0, conceptsOpen: false };
  private readingRenders: Promise<void>[] = [];
  private readingRestorePending = false;
  private sessionSavedStates = new Map<string, QuestionReviewState>();
  private readingTimer: number | null = null;
  private undoFeedbackTimer: number | null = null;
  private undoFeedback = "";
  private reviewSaveMessage = "";
  private refreshingAfterReturn = false;
  private adaptiveLayout: ReturnType<typeof bindAdaptiveLayout> | null = null;
  private ratingTapGuard: ReturnType<typeof bindRatingTapGuard> | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MiaStudyPlugin) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string { return MIA_VIEW_TYPE; }
  getDisplayText(): string { return "Major Study"; }
  getIcon(): string { return "brain-circuit"; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.tabIndex = -1;
    // Obsidian's mobile drawer recognizer skips ancestors marked with this attribute.
    if (Platform.isMobile) this.contentEl.dataset.ignoreSwipe = "true";
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.handleStudyShortcut(event));
    this.gestures = bindStudyGestures(
      this.contentEl,
      () => this.route === "study" && !this.isMutatingReview && !this.closed && this.plugin.studyUi.appearance.swipeEnabled,
      () => this.returnToSessionOrigin(),
      () => this.plugin.studyUi.appearance.swipeSensitivity,
    );
    this.ratingTapGuard = bindRatingTapGuard(this.contentEl);
    this.keyboardViewport = bindKeyboardViewport(this.contentEl);
    this.unsubscribers = [
      this.plugin.index.subscribe(() => this.render()),
      this.plugin.store.subscribe(() => {
        if (!this.isMutatingReview) {
          for (const [id, saved] of this.sessionSavedStates) {
            if (JSON.stringify(saved) === JSON.stringify(this.plugin.store.getReview(id))) continue;
            for (const [index, attempt] of this.sessionAttempts) if (attempt.id === id) { this.sessionAttempts.delete(index); this.sessionBaselines.delete(index); }
            this.sessionSavedStates.delete(id); this.sessionGrades.delete(id);
          }
          if (this.lastRated && JSON.stringify(this.plugin.store.getReview(this.lastRated.id)) !== JSON.stringify(this.lastRated.savedState)) this.lastRated = null;
          this.render();
        }
      }),
    ];
    this.render();
    this.adaptiveLayout = bindAdaptiveLayout(this.contentEl);
    this.registerDomEvent(this.contentEl.ownerDocument, "visibilitychange", () => {
      if (this.contentEl.ownerDocument.hidden) this.flushReadingPosition();
      else void this.refreshAfterReturn();
    });
    this.registerDomEvent(window, "focus", () => void this.refreshAfterReturn(false));
    this.registerDomEvent(window, "pagehide", () => this.flushReadingPosition());
    this.registerInterval(window.setInterval(() => {
      if (this.route === "dashboard" || this.route === "progress") this.render();
    }, 30_000));
  }

  async onClose(): Promise<void> {
    if (this.closed) return;
    this.flushReadingPosition();
    if (this.undoFeedbackTimer !== null) window.clearTimeout(this.undoFeedbackTimer);
    this.closed = true;
    this.contentEl.setAttr("aria-busy", "false");
    this.contentEl.querySelector(".mia-save-status")?.remove();
    this.undoFeedbackTimer = null;
    this.contentEl.onscroll = null;
    delete this.contentEl.dataset.ignoreSwipe;
    this.adaptiveLayout?.destroy();
    this.adaptiveLayout = null;
    this.gestures?.destroy();
    this.gestures = null;
    this.ratingTapGuard?.destroy();
    this.ratingTapGuard = null;
    this.clearResultPopup();
    if (this.learningTimer !== null) window.clearTimeout(this.learningTimer);
    this.learningTimer = null;
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.readingRenders = [];
  }

  showDashboard(): void {
    this.navigate("dashboard");
  }

  startReview(questionIds?: string[], mode: MiaSessionMode = "recall"): void {
    if (this.reviewSavePending()) return;
    this.clearResultPopup();
    if (this.readingTimer !== null) { window.clearTimeout(this.readingTimer); this.readingTimer = null; }
    this.sessionSavedStates.clear();
    this.readingPosition = { key: "", scrollTop: 0, pageScrollTop: 0, conceptsOpen: false };
    this.undoFeedback = "";
    this.stateRestored = true;
    const questions = this.plugin.index.registered;
    const requestedIds = questionIds ? new Set(questionIds) : null;
    const scope = requestedIds ? questions.filter((question) => requestedIds.has(question.id)) : questions;
    const sequential = mode === "browse" && this.plugin.studyUi.appearance.memorizationOrder === "sequential";
    const eligible = buildReviewQueue(scope, this.plugin.store.reviews, this.plugin.fsrs, mode === "browse" ? (sequential ? {} : { random: Math.random }) : { management: this.plugin.store.settings.studyManagement });
    const eligibleIds = new Set(eligible.map((question) => question.id));
    this.queue = (sequential ? scope.filter((question) => question.id && eligibleIds.has(question.id)) : eligible)
      .map((question) => question.id);
    this.sessionSeed = [...this.queue];
    if (this.route !== "study") this.sessionOrigin = this.route;
    this.queueIndex = 0;
    this.sessionMode = mode;
    this.answerVisible = mode === "browse";
    this.lastRated = null;
    this.sessionStartedAt = Date.now();
    this.sessionBaselines.clear();
    this.sessionAttempts.clear();
    this.sessionGrades.clear();
    this.sessionSkipped.clear();
    this.resultShown = false;
    this.saveStudyPosition();
    this.navigate("study");
  }

  getState(): Record<string, unknown> {
    return {
      route: this.route,
      queue: [...this.queue],
      queueIndex: this.queueIndex,
      answerVisible: this.answerVisible,
      sessionMode: this.sessionMode,
      ...this.reviewCheckpoint(),
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (this.reviewSavePending()) return;
    this.flushReadingPosition();
    const next = parseMiaNavigationState(state);
    if (!this.stateRestored && next.route === "study") {
      const index = this.restoredQueueIndex(next.queue, next.queueIndex, next.reviewCheckpoint);
      if (index !== next.queueIndex) next.answerVisible = next.sessionMode === "browse";
      next.queueIndex = index;
    }
    this.stateRestored = true;
    const sessionChanged = next.sessionMode !== this.sessionMode || next.queue.length !== this.queue.length
      || next.queue.some((id, index) => id !== this.queue[index]);
    if (sessionChanged) {
      // Workspace history can restore a different queue into the same view.
      // Position-based baselines and undo belong only to their original session.
      this.clearResultPopup();
      this.lastRated = null;
      this.sessionSavedStates.clear();
      this.sessionBaselines.clear();
      this.sessionAttempts.clear();
      this.sessionGrades.clear();
      this.sessionSkipped.clear();
      this.sessionSeed = [...new Set(next.queue)];
      this.sessionStartedAt = Date.now();
      this.resultShown = false;
      this.hintVisible = false;
    }
    if (next.route !== "study") this.clearResultPopup();
    result.history = next.route !== this.route;
    this.route = next.route;
    this.queue = next.queue;
    if (!this.sessionSeed.length) this.sessionSeed = [...new Set(next.queue)];
    this.queueIndex = next.queueIndex;
    this.answerVisible = next.answerVisible;
    this.sessionMode = next.sessionMode;
    this.render();
    if (this.route === "study") this.contentEl.focus({ preventScroll: true });
  }

  private clearResultPopup(): void {
    if (this.resultTimer !== null) window.clearTimeout(this.resultTimer);
    this.resultTimer = null;
    this.resultModal?.close();
    this.resultModal = null;
  }

  private reviewSavePending(): boolean {
    if (!this.isMutatingReview) return false;
    new Notice("복습 기록을 저장 중입니다. 잠시 후 다시 이동하세요.");
    return true;
  }

  private navigate(route: MiaRoute): void {
    if (this.reviewSavePending()) return;
    if (route !== "study") this.flushReadingPosition();
    void this.leaf.setViewState({
      type: MIA_VIEW_TYPE,
      active: true,
      state: { ...this.getState(), route },
    });
    if (route === "dashboard") {
      void this.plugin.studyUi.load().then(() => {
        if (this.route === "dashboard" && !this.closed) {
          // Import the pre-update workspace only when no synced session file exists.
          if (!this.plugin.studyUi.hasResumeFile && !this.plugin.studyUi.resume && this.queue.length) this.saveStudyPosition();
          this.render();
        }
      }).catch((error: unknown) => new Notice(`이어하기 정보 불러오기 실패: ${errorMessage(error)}`));
    }
  }

  private readingKey(): string { return `${this.route}:${this.queueIndex}:${this.queue[this.queueIndex] ?? ""}`; }

  private captureReadingPosition(): void {
    if (this.readingRestorePending || this.route !== "study" || this.renderedPosition !== this.readingKey()) return;
    const layout = this.contentEl.querySelector<HTMLElement>(".mia-study-layout");
    if (!layout) return;
    this.readingPosition = { key: this.readingKey(), scrollTop: layout.scrollTop, pageScrollTop: this.contentEl.scrollTop,
      conceptsOpen: this.contentEl.querySelector<HTMLDetailsElement>(".mia-study-concepts")?.open ?? false };
  }

  private flushReadingPosition(): void {
    if (this.readingTimer === null) return;
    window.clearTimeout(this.readingTimer); this.readingTimer = null;
    if (this.route !== "study" || this.isMutatingReview || this.closed) return;
    this.captureReadingPosition(); this.saveStudyPosition(); this.app.workspace.requestSaveLayout();
  }

  private scheduleReadingSave(): void {
    if (this.readingTimer !== null) window.clearTimeout(this.readingTimer);
    this.readingTimer = window.setTimeout(() => this.flushReadingPosition(), 400);
  }

  private async refreshAfterReturn(refreshTime = true): Promise<void> {
    if (this.closed || this.refreshingAfterReturn || this.isMutatingReview) return;
    this.refreshingAfterReturn = true;
    const previousResume = JSON.stringify(this.plugin.studyUi.resume);
    try {
      await this.plugin.store.synchronize();
      if (this.closed) return;
      await this.plugin.studyUi.load();
      // A focus event can occur between pointerdown and click. Replacing unchanged
      // controls here drops that first tap; visibility changes still refresh timers.
      const resumeChanged = previousResume !== JSON.stringify(this.plugin.studyUi.resume);
      if (!this.closed && ((refreshTime && (this.route === "study" || this.route === "dashboard"))
        || (resumeChanged && this.route === "dashboard"))) this.render();
    } catch (error) { new Notice(`앱 복귀 후 기록 확인 실패: ${errorMessage(error)}`); }
    finally { this.refreshingAfterReturn = false; }
  }

  private restoreReadingPosition(key: string, component: Component): void {
    if (this.closed || this.renderComponent !== component || this.readingPosition.key !== key || this.readingKey() !== key) return;
    const layout = this.contentEl.querySelector<HTMLElement>(".mia-study-layout");
    const concepts = this.contentEl.querySelector<HTMLDetailsElement>(".mia-study-concepts");
    if (concepts) concepts.open = this.readingPosition.conceptsOpen;
    if (layout) layout.scrollTop = this.readingPosition.scrollTop;
    this.contentEl.scrollTop = this.readingPosition.pageScrollTop;
  }

  private showUndoFeedback(label: string): void {
    if (this.closed) return;
    if (this.undoFeedbackTimer !== null) window.clearTimeout(this.undoFeedbackTimer);
    this.undoFeedback = `${label} 평가 저장됨`;
    this.undoFeedbackTimer = window.setTimeout(() => {
      this.undoFeedback = ""; this.undoFeedbackTimer = null;
      // Update only the banner so reading and keyboard focus do not jump.
      this.contentEl.querySelector(".mia-undo-feedback")?.remove();
    }, 8000);
  }

  private reviewCheckpoint(): { reviewCheckpoint?: ReviewCheckpoint } {
    const id = this.queue[this.queueIndex];
    return id ? { reviewCheckpoint: this.isMutatingReview && this.savingReviewCheckpoint?.id === id
      ? this.savingReviewCheckpoint : { id, version: this.plugin.store.getReviewVersion(id) } } : {};
  }

  private restoredQueueIndex(queue: readonly string[], index: number, checkpoint?: ReviewCheckpoint): number {
    const id = queue[index];
    if (checkpoint && id === checkpoint.id && this.plugin.store.getReview(id)
      && this.plugin.store.getReviewVersion(id) !== checkpoint.version) {
      new Notice("이미 저장된 평가를 확인해 다음 학습 위치로 이어갑니다.");
      return index + 1;
    }
    return index;
  }

  private saveStudyPosition(expectedResume?: string, expectedRevision?: number): void {
    if (expectedRevision !== undefined && this.plugin.studyUi.resumeRevision !== expectedRevision) return;
    if (expectedResume !== undefined && JSON.stringify(this.plugin.studyUi.resume) !== expectedResume) return;
    if (!this.closed) this.captureReadingPosition();
    const reading = this.readingPosition.key === this.readingKey() ? this.readingPosition : { scrollTop: 0, pageScrollTop: 0, conceptsOpen: false };
    const plan = planLearningQueue(this.queue, this.queueIndex, this.sessionSeed, this.plugin.store.reviews, this.sessionSkipped);
    const complete = !this.queue.length || (this.queueIndex >= this.queue.length && !plan.nextDue && plan.queue.length <= this.queueIndex);
    void this.plugin.studyUi.saveResume(complete ? null : {
      queue: [...this.queue], seed: [...this.sessionSeed], skipped: [...this.sessionSkipped], queueIndex: this.queueIndex,
      answerVisible: this.answerVisible, sessionMode: this.sessionMode, updatedAt: new Date().toISOString(),
      scrollTop: reading.scrollTop, pageScrollTop: reading.pageScrollTop, conceptsOpen: reading.conceptsOpen,
      ...this.reviewCheckpoint(),
    }).catch((error: unknown) => new Notice(`이어하기 위치 저장 실패: ${errorMessage(error)}`));
  }

  private async resumeStudy(): Promise<void> {
    try {
      await this.plugin.studyUi.load();
      if (this.closed || this.reviewSavePending()) return;
      const saved = this.plugin.studyUi.resume;
      if (!saved) { new Notice("이어갈 학습이 없습니다."); this.render(); return; }
      const exists = (id: string) => Boolean(this.plugin.index.questionById(id));
      const queue = saved.queue.filter(exists);
      if (!queue.length) {
        await this.plugin.studyUi.saveResume(null);
        new Notice("저장된 학습의 문제를 찾을 수 없습니다."); this.render(); return;
      }
      const originalIndex = saved.queue.slice(0, saved.queueIndex).filter(exists).length;
      const index = this.restoredQueueIndex(queue, originalIndex, saved.reviewCheckpoint);
      const advanced = index !== originalIndex;
      const sameSession = this.queueIndex === index && this.sessionMode === saved.sessionMode && this.queue.length === queue.length && this.queue.every((id, position) => id === queue[position]);
      if (!sameSession) {
        this.lastRated = null; this.sessionBaselines.clear(); this.sessionAttempts.clear();
        this.sessionGrades.clear(); this.sessionSkipped.clear(); this.sessionStartedAt = Date.now();
        this.sessionSkipped = new Set(saved.skipped.filter(exists));
      }
      this.queue = queue; this.queueIndex = index; this.sessionSeed = saved.seed.filter(exists);
      this.readingPosition = { key: `study:${index}:${queue[index] ?? ""}`, scrollTop: advanced ? 0 : saved.scrollTop ?? 0, pageScrollTop: advanced ? 0 : saved.pageScrollTop ?? 0, conceptsOpen: advanced ? false : saved.conceptsOpen ?? false };
      this.answerVisible = advanced ? saved.sessionMode === "browse" : saved.answerVisible; this.sessionMode = saved.sessionMode; this.resultShown = false;
      this.stateRestored = true;
      if (advanced) this.saveStudyPosition();
      this.navigate("study");
    } catch (error) { new Notice(`이어하기 실패: ${errorMessage(error)}`); }
  }

  private refreshAppearance(): void {
    this.gestures?.reset();
    this.ratingTapGuard?.reset();
    this.contentEl.dataset.readingSize = this.plugin.studyUi.appearance.size;
    this.contentEl.dataset.density = this.plugin.studyUi.appearance.density;
    this.contentEl.dataset.focus = String(this.plugin.studyUi.appearance.focus);
    this.contentEl.dataset.answerLayout = this.plugin.studyUi.appearance.answerLayout;
    this.contentEl.dataset.swipeEnabled = String(this.plugin.studyUi.appearance.swipeEnabled);
  }

  private render(): void {
    if (this.closed) return;
    this.captureReadingPosition();
    this.readingRenders = [];
    this.gestures?.reset();
    this.ratingTapGuard?.reset();
    this.studyShortcuts.clear();
    if (this.resultTimer !== null) window.clearTimeout(this.resultTimer);
    this.resultTimer = null;
    if (this.learningTimer !== null) window.clearTimeout(this.learningTimer);
    this.learningTimer = null;
    this.renderComponent?.unload();
    this.renderComponent = new Component();
    this.renderComponent.load();
    const root = this.contentEl;
    const sameRoute = this.renderedPosition.startsWith(`${this.route}:`);
    const filtersOpen = sameRoute ? root.querySelector<HTMLDetailsElement>(".mia-filter-panel")?.open : undefined;
    const active = root.ownerDocument?.activeElement;
    const editing = active && root.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") ? active as HTMLInputElement | HTMLTextAreaElement : null;
    const editingLabel = sameRoute ? editing?.getAttribute("aria-label") : null;
    const selection = editing ? [editing.selectionStart, editing.selectionEnd] : null;
    root.dataset.device = Platform.isPhone ? "phone" : Platform.isTablet ? "tablet" : "desktop";
    root.dataset.readingSize = this.plugin.studyUi.appearance.size;
    root.dataset.density = this.plugin.studyUi.appearance.density;
    root.dataset.focus = String(this.plugin.studyUi.appearance.focus);
    root.dataset.answerLayout = this.plugin.studyUi.appearance.answerLayout;
    root.dataset.swipeEnabled = String(this.plugin.studyUi.appearance.swipeEnabled);
    root.empty();
    root.setAttr("aria-busy", String(this.isMutatingReview));
    if (this.isMutatingReview) this.renderReviewSaveStatus();
    const position = `${this.route}:${this.queueIndex}:${this.queue[this.queueIndex] ?? ""}`;
    if (position !== this.renderedPosition) { root.scrollTop = 0; this.hintVisible = false; }
    this.renderedPosition = position;
    root.removeClass("mia-route-dashboard", "mia-route-progress", "mia-route-questions", "mia-route-weakness", "mia-route-keywords", "mia-route-study");
    root.addClass("mia-view");
    root.addClass(`mia-route-${this.route}`);
    this.renderHeader(root);
    if (!this.plugin.index.isReady) {
      root.createEl("p", { text: "문제를 불러오는 중입니다…", cls: "mia-muted" });
      return;
    }
    if (this.route === "dashboard") this.renderDashboard(root);
    if (this.route === "progress") this.renderProgress(root);
    if (this.route === "questions") this.renderQuestions(root);
    if (this.route === "weakness") this.renderWeakness(root);
    if (this.route === "keywords") this.renderKeywords(root);
    if (this.route === "study") {
      this.renderStudy(root);
      const current = this.plugin.index.questionById(this.queue[this.queueIndex] ?? "");
      const announcement = root.createEl("span", { cls: "mia-sr-only", text: current ? `${this.queueIndex + 1}번 문제, ${current.heading}. ${this.answerVisible ? "정답 표시됨" : "정답 숨김"}` : "학습 결과" });
      announcement.setAttr("role", "status"); announcement.setAttr("aria-live", "polite"); announcement.setAttr("aria-atomic", "true");
      const component = this.renderComponent, key = this.readingKey();
      const layout = root.querySelector<HTMLElement>(".mia-study-layout");
      layout?.addEventListener("scroll", () => this.scheduleReadingSave(), { passive: true });
      root.onscroll = () => this.scheduleReadingSave();
      root.querySelector(".mia-study-concepts")?.addEventListener("toggle", () => this.scheduleReadingSave());
      this.readingRestorePending = true;
      void Promise.all(this.readingRenders).then(() => this.restoreReadingPosition(key, component))
        .catch((error: unknown) => new Notice(`학습 화면 표시 실패: ${errorMessage(error)}`))
        .finally(() => { if (this.renderComponent === component) this.readingRestorePending = false; });
    } else root.onscroll = null;
    const filterPanel = root.querySelector<HTMLDetailsElement>(".mia-filter-panel");
    if (filterPanel && filtersOpen !== undefined) filterPanel.open = filtersOpen;
    if (editingLabel) {
      const replacement = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].find(input => input.getAttribute("aria-label") === editingLabel);
      replacement?.focus({ preventScroll: true });
      if (replacement && selection?.[0] !== null && selection?.[1] !== null && selection?.[0] !== undefined && selection?.[1] !== undefined) replacement.setSelectionRange(selection[0], selection[1]);
      this.keyboardViewport?.refresh();
    }
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "mia-header" });
    const title = header.createDiv();
    const brand = title.createEl("h2", { cls: "mia-brand" });
    const home = brand.createEl("button", { text: "Major Study", cls: "mia-home-button" });
    home.setAttr("type", "button");
    home.setAttr("aria-label", "Major Study 초기 화면으로 이동");
    home.addEventListener("click", () => this.showDashboard());
    const version = brand.createEl("span", { text: `v${this.plugin.manifest.version}`, cls: "mia-version" });
    version.setAttr("aria-label", `실행 중인 MIA Study 버전 ${this.plugin.manifest.version}`);
    title.createEl("span", { text: "FSRS-6", cls: "mia-badge" });
    const settingsButtons = title.createDiv({ cls: "mia-settings-buttons" });
    settingsButtons.createEl("button", { text: "학습 설정", cls: "mia-learning-button" }).addEventListener("click", () => new StudyManagementModal(this.app, this.plugin, () => this.render()).open());
    const appearance = settingsButtons.createEl("button", { text: "보기 설정", cls: "mia-appearance-button" });
    appearance.addEventListener("click", () => new StudyAppearanceModal(this.app, this.plugin.studyUi, () => this.refreshAppearance()).open());
    if (this.route === "study") title.createEl("button", { text: "학습 나가기", cls: "mia-focus-exit" }).addEventListener("click", () => this.navigate("dashboard"));
    const nav = header.createDiv({ cls: "mia-nav" });
    this.navButton(nav, "대시보드", "dashboard");
    this.navButton(nav, "학습현황", "progress");
    this.navButton(nav, "문제", "questions");
    this.navButton(nav, "취약 문제", "weakness");
    this.navButton(nav, "키워드", "keywords");
  }

  private navButton(parent: HTMLElement, label: string, route: MiaRoute): void {
    const button = parent.createEl("button", { text: label, cls: this.route === route ? "mod-cta" : "" });
    const shortLabels: Record<Exclude<MiaRoute, "study">, string> = {
      dashboard: "홈",
      progress: "현황",
      questions: "문제",
      weakness: "취약",
      keywords: "키워드",
    };
    if (route !== "study") button.dataset.shortLabel = shortLabels[route];
    button.setAttr("aria-label", label);
    button.addEventListener("click", () => this.navigate(route));
  }

  private renderDashboard(root: HTMLElement): void {
    const conflicts = this.plugin.store.conflicts;
    if (conflicts && Object.keys(conflicts).length) {
      const warning = root.createDiv({ cls: "mia-sync-warning" });
      warning.createEl("p", { text: `기기 간 평가가 달랐던 문제 ${Object.keys(conflicts).length}개 · 이전 이력도 보관했습니다.` });
      warning.createEl("button", { text: "보관된 평가 확인" }).addEventListener("click", () => new ReviewConflictModal(this.app, conflicts, id => this.plugin.index.questionById(id)?.heading ?? id).open());
    }
    const questions = this.plugin.index.registered;
    const progress = calculateProgress(questions, this.plugin.store.reviews, this.plugin.fsrs);
    const due = progress.due;
    const fresh = progress.new;
    const available = buildReviewQueue(questions, this.plugin.store.reviews, this.plugin.fsrs, { management: this.plugin.store.settings.studyManagement });
    const availableNew = available.filter(question => this.plugin.fsrs.isNew(this.plugin.store.getReview(question.id))).length;
    const availableDue = available.length - availableNew;
    const action = root.createDiv({ cls: "mia-primary-card" });
    action.createEl("h3", { text: available.length > 0 ? "오늘 학습을 시작할까요?" : "오늘 학습을 마쳤습니다" });
    action.createEl("p", { text: `오늘 출제: 복습 ${availableDue}개 · 새 문제 ${availableNew}개 · 전체 대기: 복습 ${due}개 · 새 문제 ${fresh}개` });
    const actions = action.createDiv({ cls: "mia-inline-actions" });
    const start = actions.createEl("button", { text: "시험 모드 시작", cls: "mod-cta" });
    start.disabled = available.length === 0;
    start.addEventListener("click", () => this.startReview());
    const browse = actions.createEl("button", { text: "전체 암기 모드" });
    browse.disabled = due + fresh === 0;
    browse.addEventListener("click", () => this.startReview(questions.map((question) => question.id), "browse"));
    const saved = this.plugin.studyUi.resume;
    if (saved) {
      const current = this.plugin.index.questionById(saved.queue[saved.queueIndex] ?? saved.seed[0] ?? "");
      const resume = root.createDiv({ cls: "mia-resume-card" });
      resume.createEl("span", { text: "마지막 학습", cls: "mia-card-label" });
      const heading = resume.createEl("h3");
      if (current) this.renderQuestionHeading(heading, current);
      else heading.setText("저장된 학습");
      resume.createEl("p", { text: `${current?.subject ?? ""} · ${saved.sessionMode === "recall" ? "시험" : "암기"} · ${Math.min(saved.queueIndex + 1, saved.queue.length)} / ${saved.queue.length}${saved.queueIndex >= saved.queue.length ? " · 다음 복습 대기" : ""}` });
      resume.createEl("small", { text: `${new Date(saved.updatedAt).toLocaleString("ko-KR")} 저장`, cls: "mia-muted" });
      resume.createEl("button", { text: "이어하기", cls: "mod-cta" }).addEventListener("click", () => this.resumeStudy());
    }
    const grid = root.createDiv({ cls: "mia-stats" });
    this.progressStat(grid, "등록 문제", questions.length, "all");
    const stableRatio = progress.total ? Math.round((progress.stable / progress.total) * 100) : 0;
    const stable = grid.createEl("button", { cls: "mia-stat mia-progress-stat mia-stability-stat" });
    stable.style.setProperty("--mia-stable-ratio", `${stableRatio * 3.6}deg`);
    stable.createEl("strong", { text: `${stableRatio}%` });
    stable.createEl("span", { text: "기억 안정 비율" });
    stable.addEventListener("click", () => this.showQuestions("stable"));
    this.progressStat(grid, "최근 너무 쉬움", progress.easy, "easy");
    this.progressStat(grid, "오늘 평가", progress.today, "today");
    this.progressStat(grid, "오늘 복습", due, "due");
    this.progressStat(grid, "개선 필요", progress.again + progress.hard, "weak");
    const manage = root.createDiv({ cls: "mia-manage-actions" });
    manage.createEl("button", { text: "과목 추가" }).addEventListener("click", () => this.plugin.openSubjectEditor());
    manage.createEl("button", { text: "질문 추가", cls: "mod-cta" }).addEventListener("click", () => void this.plugin.openManagedQuestionEditor());
    manage.createEl("button", { text: "키워드 추가" }).addEventListener("click", () => this.plugin.openKeywordEditor());
    manage.createEl("button", { text: "출력" }).addEventListener("click", () => this.plugin.openSubjectExport());
    if (this.plugin.index.diagnostics.length) {
      root.createEl("p", { text: `검사 필요 ${this.plugin.index.diagnostics.length}건 — 문제 목록에서 확인하세요.`, cls: "mia-warning" });
    }

    const subjects = new Map<string, Array<QuestionRecord & { id: string }>>();
    for (const subject of this.plugin.listSubjects()) subjects.set(subject, []);
    for (const question of questions) {
      const items = subjects.get(question.subject) ?? [];
      items.push(question);
      subjects.set(question.subject, items);
    }
    if (subjects.size) {
      root.createEl("h3", { text: "과목별 학습", cls: "mia-section-title" });
      const subjectGrid = root.createDiv({ cls: "mia-subject-grid" });
      for (const [subject, items] of [...subjects].sort(([left], [right]) => left.localeCompare(right, "ko"))) {
        const subjectDue = items.filter((question) => this.plugin.fsrs.isDue(this.plugin.store.getReview(question.id))).length;
        const subjectNew = items.filter((question) => this.plugin.fsrs.isNew(this.plugin.store.getReview(question.id))).length;
        const card = subjectGrid.createDiv({ cls: "mia-subject-card" });
        card.createEl("strong", { text: subject });
        card.createEl("span", { text: `${items.length}문제 · 복습 ${subjectDue} · 새 문제 ${subjectNew}` });
        const subjectActions = card.createDiv({ cls: "mia-inline-actions" });
        const reviewIds = buildReviewQueue(items, this.plugin.store.reviews, this.plugin.fsrs, { management: this.plugin.store.settings.studyManagement }).map((question) => question.id);
        const review = subjectActions.createEl("button", { text: "시험" });
        review.disabled = reviewIds.length === 0;
        review.addEventListener("click", () => this.startReview(reviewIds));
        const memorize = subjectActions.createEl("button", { text: "암기" });
        memorize.disabled = subjectDue + subjectNew === 0;
        memorize.addEventListener("click", () => {
          this.startReview(items.map((question) => question.id), "browse");
        });
        subjectActions.createEl("button", { text: "이름 수정" }).addEventListener("click", () => {
          this.plugin.openSubjectEditor(subject);
        });
        subjectActions.createEl("button", { text: "삭제", cls: "mod-warning" }).addEventListener("click", () => {
          this.plugin.confirmDeleteSubject(subject);
        });
      }
    }
  }

  private renderProgress(root: HTMLElement): void {
    const questions = this.plugin.index.registered;
    const progress = calculateProgress(questions, this.plugin.store.reviews, this.plugin.fsrs);
    root.createEl("h3", { text: "전체 학습현황", cls: "mia-page-title" });
    const totals = root.createDiv({ cls: "mia-stats" });
    this.progressStat(totals, "전체 문제", progress.total, "all");
    this.progressStat(totals, "학습 전", progress.new, "new");
    this.progressStat(totals, "오늘 복습", progress.due, "due");
    this.progressStat(totals, "1회 이상 학습", progress.studied, null);
    this.progressStat(totals, "기억 안정", progress.stable, "stable");
    this.progressStat(totals, "오늘 평가", progress.today, "today");

    root.createEl("h3", { text: "최근 평가", cls: "mia-section-title" });
    const ratings = root.createDiv({ cls: "mia-progress-ratings" });
    this.progressStat(ratings, "못 암기", progress.again, "again");
    this.progressStat(ratings, "애매", progress.hard, "hard");
    this.progressStat(ratings, "암기", progress.good, "good");
    this.progressStat(ratings, "너무 쉬움", progress.easy, "easy");

    root.createEl("h3", { text: "과목별 현황", cls: "mia-section-title" });
    const subjectProgress = new Map(progress.bySubject.map((item) => [item.subject, item.counts]));
    for (const subject of this.plugin.listSubjects()) {
      if (!subjectProgress.has(subject)) {
        subjectProgress.set(subject, { total: 0, new: 0, studied: 0, due: 0, again: 0, hard: 0, good: 0, easy: 0, stable: 0, today: 0 });
      }
    }
    const subjectGrid = root.createDiv({ cls: "mia-progress-subjects" });
    for (const [subject, counts] of [...subjectProgress].sort(([left], [right]) => left.localeCompare(right, "ko"))) {
      const card = subjectGrid.createDiv({ cls: "mia-progress-subject" });
      const heading = card.createDiv({ cls: "mia-progress-subject-heading" });
      heading.createEl("strong", { text: subject });
      heading.createEl("span", { text: `${counts.studied}/${counts.total} 학습` });
      const values = card.createDiv({ cls: "mia-progress-subject-values" });
      this.progressLink(values, `학습 전 ${counts.new}`, "new", subject);
      this.progressLink(values, `오늘 복습 ${counts.due}`, "due", subject);
      this.progressLink(values, `못 암기 ${counts.again}`, "again", subject);
      this.progressLink(values, `애매 ${counts.hard}`, "hard", subject);
      this.progressLink(values, `암기 ${counts.good}`, "good", subject);
      this.progressLink(values, `너무 쉬움 ${counts.easy}`, "easy", subject);
      const actions = card.createDiv({ cls: "mia-inline-actions" });
      const subjectQuestions = questions.filter((question) => question.subject === subject);
      const reviewIds = buildReviewQueue(subjectQuestions, this.plugin.store.reviews, this.plugin.fsrs, { management: this.plugin.store.settings.studyManagement })
        .map((question) => question.id);
      const start = actions.createEl("button", { text: "복습 시작", cls: "mod-cta" });
      start.disabled = reviewIds.length === 0;
      start.addEventListener("click", () => this.startReview(reviewIds));
      actions.createEl("button", { text: "전체 문제" }).addEventListener("click", () => this.showQuestions("all", subject));
    }
    if (subjectProgress.size === 0) root.createEl("p", { text: "과목과 질문을 추가하면 학습현황이 표시됩니다.", cls: "mia-empty" });
  }

  private progressStat(
    parent: HTMLElement,
    label: string,
    value: number,
    review: ReviewFilter | null,
  ): void {
    const card = review
      ? parent.createEl("button", { cls: "mia-stat mia-progress-stat" })
      : parent.createDiv({ cls: "mia-stat mia-progress-stat" });
    card.createEl("strong", { text: String(value) });
    card.createEl("span", { text: label });
    if (review) card.addEventListener("click", () => this.showQuestions(review));
  }

  private progressLink(parent: HTMLElement, label: string, review: ReviewFilter, subject: string): void {
    const button = parent.createEl("button", { text: label });
    button.addEventListener("click", () => this.showQuestions(review, subject));
  }

  private showQuestions(review: ReviewFilter, subject = "all"): void {
    this.questionText = "";
    this.questionKeyword = "";
    this.questionType = "all";
    this.questionSort = "review";
    this.questionReview = review;
    this.questionSubject = subject;
    this.navigate("questions");
  }

  private stat(parent: HTMLElement, label: string, value: number): void {
    const card = parent.createDiv({ cls: "mia-stat" });
    card.createEl("strong", { text: String(value) });
    card.createEl("span", { text: label });
  }

  private renderQuestions(root: HTMLElement): void {
    const pageActions = root.createDiv({ cls: "mia-page-actions" });
    pageActions.createEl("button", { text: "질문 추가", cls: "mod-cta" }).addEventListener("click", () => {
      void this.plugin.openManagedQuestionEditor();
    });
    const filterPanel = root.createEl("details", { cls: "mia-filter-panel" });
    filterPanel.open = !Platform.isMobile;
    filterPanel.createEl("summary", { text: "검색·필터·정렬" });
    const toolbar = filterPanel.createDiv({ cls: "mia-toolbar mia-filter-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "질문, 정답, 과목, 키워드 검색", attr: { "aria-label": "질문 검색" } });
    search.value = this.questionText;
    const subject = toolbar.createEl("select", { attr: { "aria-label": "과목 필터" } });
    subject.createEl("option", { text: "전체 과목", value: "all" });
    const subjects = [...new Set([
      ...this.plugin.listSubjects(),
      ...this.plugin.index.registered.map((question) => question.subject),
    ])].sort((a, b) => a.localeCompare(b, "ko"));
    subjects.forEach((item) => subject.createEl("option", { text: item, value: item }));
    subject.value = this.questionSubject;
    const type = toolbar.createEl("select", { attr: { "aria-label": "문제 유형 필터" } });
    type.createEl("option", { text: "전체 유형", value: "all" });
    QUESTION_TYPES.forEach((item) => type.createEl("option", { text: item, value: item }));
    type.value = this.questionType;
    const review = toolbar.createEl("select", { attr: { "aria-label": "복습 상태 필터" } });
    const reviewOptions: Array<[ReviewFilter, string]> = [
      ["all", "전체 상태"], ["due", "복습 예정"], ["new", "새 문제"],
      ["again", "못 암기"], ["hard", "애매"], ["good", "암기"], ["easy", "너무 쉬움"],
      ["weak", "취약 문제"], ["stable", "기억 안정"], ["today", "오늘 평가"],
    ];
    reviewOptions.forEach(([value, label]) => review.createEl("option", { text: label, value }));
    review.value = this.questionReview;
    const keyword = toolbar.createEl("input", { type: "search", placeholder: "키워드만 필터", attr: { "aria-label": "키워드 필터" } });
    keyword.value = this.questionKeyword;
    const sort = toolbar.createEl("select", { attr: { "aria-label": "정렬" } });
    const sortOptions: Array<[QuestionSort, string]> = [
      ["review", "복습 우선"], ["title", "문제명"], ["subject", "과목별"], ["type", "유형별"],
      ["created", "최근 생성"], ["updated", "최근 수정"], ["weak", "못 암기 우선"], ["ambiguous", "애매 우선"],
    ];
    sortOptions.forEach(([value, label]) => sort.createEl("option", { text: label, value }));
    sort.value = this.questionSort;

    const chips = root.createDiv({ cls: "mia-filter-chips" });
    const resultBar = root.createDiv({ cls: "mia-result-bar" });
    const resultCount = resultBar.createSpan();
    const resultActions = resultBar.createDiv({ cls: "mia-inline-actions" });
    const testResults = resultActions.createEl("button", { text: "검색 결과 시험" });
    const browseResults = resultActions.createEl("button", { text: "검색 결과 암기" });
    const list = root.createDiv({ cls: "mia-list" });
    const pagination = root.createDiv({ cls: "mia-pagination" });
    const renderChips = () => {
      chips.empty();
      const active: Array<[string, () => void]> = [];
      if (this.questionText) active.push([`검색: ${this.questionText}`, () => { this.questionText = ""; search.value = ""; }]);
      if (this.questionSubject !== "all") active.push([`과목: ${this.questionSubject}`, () => { this.questionSubject = "all"; subject.value = "all"; }]);
      if (this.questionType !== "all") active.push([`유형: ${this.questionType}`, () => { this.questionType = "all"; type.value = "all"; }]);
      if (this.questionReview !== "all") active.push([`상태: ${reviewOptions.find(([value]) => value === this.questionReview)?.[1] ?? this.questionReview}`, () => { this.questionReview = "all"; review.value = "all"; }]);
      if (this.questionKeyword) active.push([`키워드: ${this.questionKeyword}`, () => { this.questionKeyword = ""; keyword.value = ""; }]);
      for (const [label, clear] of active) {
        const chip = chips.createEl("button", { text: `${label} ×` });
        chip.addEventListener("click", () => { clear(); this.questionPage = 0; renderList(); });
      }
      if (active.length > 1) {
        const reset = chips.createEl("button", { text: "필터 전체 해제", cls: "mod-warning" });
        reset.addEventListener("click", () => {
          this.questionText = ""; this.questionSubject = "all"; this.questionType = "all";
          this.questionReview = "all"; this.questionKeyword = ""; this.questionPage = 0;
          search.value = ""; subject.value = "all"; type.value = "all"; review.value = "all"; keyword.value = "";
          renderList();
        });
      }
    };
    const renderList = () => {
      list.empty();
      pagination.empty();
      const questions = queryQuestions(this.plugin.index.registered, this.plugin.store.reviews, this.plugin.fsrs, {
        text: this.questionText,
        subject: this.questionSubject,
        questionType: this.questionType,
        review: this.questionReview,
        keyword: this.questionKeyword,
        sort: this.questionSort,
      });
      resultCount.setText(`${questions.length}개`);
      testResults.disabled = questions.length === 0;
      browseResults.disabled = questions.length === 0;
      testResults.onclick = () => this.startReview(questions.map((question) => question.id));
      browseResults.onclick = () => this.startReview(questions.map((question) => question.id), "browse");
      const pageCount = Math.max(1, Math.ceil(questions.length / 300));
      this.questionPage = Math.min(this.questionPage, pageCount - 1);
      const visible = questions.slice(this.questionPage * 300, (this.questionPage + 1) * 300);
      for (const question of visible) this.renderQuestionRow(list, question);
      if (pageCount > 1) {
        const previous = pagination.createEl("button", { text: "이전 300개" });
        previous.disabled = this.questionPage === 0;
        previous.addEventListener("click", () => { this.questionPage -= 1; renderList(); root.scrollTo({ top: 0, behavior: "smooth" }); });
        pagination.createSpan({ text: `${this.questionPage + 1} / ${pageCount}` });
        const next = pagination.createEl("button", { text: "다음 300개" });
        next.disabled = this.questionPage >= pageCount - 1;
        next.addEventListener("click", () => { this.questionPage += 1; renderList(); root.scrollTo({ top: 0, behavior: "smooth" }); });
      }
      if (!questions.length) list.createEl("p", {
        text: this.plugin.index.registered.length ? "검색·필터 조건에 맞는 문제가 없습니다." : "등록된 문제가 없습니다.",
        cls: "mia-empty",
      });
      renderChips();
    };
    let searchComposing = false;
    let keywordComposing = false;
    search.addEventListener("compositionstart", () => { searchComposing = true; });
    search.addEventListener("compositionend", () => { searchComposing = false; this.questionText = search.value; this.questionPage = 0; renderList(); });
    search.addEventListener("input", () => { if (!searchComposing) { this.questionText = search.value; this.questionPage = 0; renderList(); } });
    keyword.addEventListener("compositionstart", () => { keywordComposing = true; });
    keyword.addEventListener("compositionend", () => { keywordComposing = false; this.questionKeyword = keyword.value; this.questionPage = 0; renderList(); });
    keyword.addEventListener("input", () => { if (!keywordComposing) { this.questionKeyword = keyword.value; this.questionPage = 0; renderList(); } });
    subject.addEventListener("change", () => { this.questionSubject = subject.value; this.questionPage = 0; renderList(); });
    type.addEventListener("change", () => { this.questionType = type.value as typeof this.questionType; this.questionPage = 0; renderList(); });
    review.addEventListener("change", () => { this.questionReview = review.value as ReviewFilter; this.questionPage = 0; renderList(); });
    sort.addEventListener("change", () => { this.questionSort = sort.value as QuestionSort; this.questionPage = 0; renderList(); });
    renderList();

    const diagnostics = this.plugin.index.diagnostics;
    if (diagnostics.length) {
      const details = root.createEl("details", { cls: "mia-candidates" });
      details.createEl("summary", { text: `검사 필요 ${diagnostics.length}건` });
      for (const diagnostic of diagnostics) {
        const row = details.createDiv({ cls: "mia-candidate" });
        row.createSpan({ text: `${diagnostic.message} · ${diagnostic.filePath}:${diagnostic.line + 1}` });
        row.createEl("button", { text: "원문" }).addEventListener("click", () => {
          void this.plugin.openLocation(diagnostic.filePath, diagnostic.line);
        });
      }
    }
    if (this.plugin.index.candidates.length) {
      const details = root.createEl("details", { cls: "mia-candidates" });
      details.createEl("summary", { text: `등록하지 않은 문제 후보 ${this.plugin.index.candidates.length}개` });
      const candidateSearch = details.createEl("input", { type: "search", placeholder: "등록 후보 검색", attr: { "aria-label": "등록 후보 검색" }, cls: "mia-candidate-search" });
      const candidateList = details.createDiv();
      const renderCandidates = () => {
        candidateList.empty();
        const candidateQuery = candidateSearch.value.trim().toLocaleLowerCase("ko");
        const matches = this.plugin.index.candidates.filter((question) =>
          !candidateQuery || [question.heading, question.questionMarkdown, question.filePath]
            .join("\n").toLocaleLowerCase("ko").includes(candidateQuery),
        );
        for (const question of matches.slice(0, this.candidateLimit)) {
          const row = candidateList.createDiv({ cls: "mia-candidate" });
          const label = row.createDiv({ cls: "mia-candidate-label" });
          this.renderQuestionHeading(label.createEl("strong"), question);
          label.createEl("small", { text: question.filePath });
          const candidateActions = row.createDiv({ cls: "mia-inline-actions" });
          candidateActions.createEl("button", { text: "등록" }).addEventListener("click", () => this.plugin.editMetadata(question));
          candidateActions.createEl("button", { text: "원문" }).addEventListener("click", () => void this.plugin.openQuestion(question));
        }
        if (matches.length > this.candidateLimit) {
          const more = candidateList.createEl("button", { text: `${Math.min(100, matches.length - this.candidateLimit)}개 더 보기`, cls: "mia-load-more" });
          more.addEventListener("click", () => { this.candidateLimit += 100; renderCandidates(); });
        }
        if (!matches.length) candidateList.createEl("p", { text: "검색 조건에 맞는 후보가 없습니다.", cls: "mia-empty" });
      };
      candidateSearch.addEventListener("input", () => { this.candidateLimit = 100; renderCandidates(); });
      renderCandidates();
    }
  }

  private renderQuestionHeading(element: HTMLElement, question: QuestionRecord): void {
    this.readingRenders.push(renderQuestionTitle(this.app, question.heading, element, question.filePath, this.renderComponent ?? this));
  }

  private renderQuestionRow(parent: HTMLElement, question: QuestionRecord & { id: string }): void {
    const row = parent.createDiv({ cls: "mia-row" });
    const body = row.createDiv({ cls: "mia-row-body" });
    this.renderQuestionHeading(body.createEl("strong"), question);
    const prompt = body.createDiv({ cls: "mia-row-prompt mia-markdown" });
    this.readingRenders.push(MarkdownRenderer.render(this.app, question.questionMarkdown, prompt, question.filePath, this.renderComponent ?? this));
    body.createEl("small", { text: `${question.subject} · ${question.questionType} · 핵심 ${question.coreKeywords.map((item) => item.label).join(", ") || "없음"} · 보조 ${question.subKeywords.map((item) => item.label).join(", ") || "없음"}` });
    const actions = row.createDiv({ cls: "mia-row-actions" });
    actions.createEl("button", { text: "학습" }).addEventListener("click", () => this.startReview([question.id]));
    actions.createEl("button", { text: "상세" }).addEventListener("click", () => void this.plugin.openQuestionDetail(question));
    actions.createEl("button", { text: "편집" }).addEventListener("click", () => void this.plugin.openManagedQuestionEditor(question));
    actions.createEl("button", { text: "연결" }).addEventListener("click", () => this.plugin.openFollowUpEditor(question));
    actions.createEl("button", { text: "삭제", cls: "mod-warning" }).addEventListener("click", () => {
      this.plugin.confirmDeleteQuestion(question);
    });
  }

  private renderWeakness(root: HTMLElement): void {
    root.createEl("h3", { text: "취약 문제", cls: "mia-page-title" });
    root.createEl("p", { text: "못 암기와 애매 문제를 복습 지연 시간까지 반영한 긴급도 순으로 표시합니다.", cls: "mia-muted" });
    const toolbar = root.createDiv({ cls: "mia-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "취약 문제 검색", attr: { "aria-label": "취약 문제 검색" } });
    const start = toolbar.createEl("button", { text: "취약 문제 시험", cls: "mod-cta" });
    const list = root.createDiv({ cls: "mia-list" });
    let query = "";
    let composing = false;
    const renderList = () => {
      list.empty();
      const questions = queryQuestions(this.plugin.index.registered, this.plugin.store.reviews, this.plugin.fsrs, {
        text: query,
        subject: "all",
        questionType: "all",
        review: "weak",
        keyword: "",
        sort: "weak",
      });
      start.disabled = questions.length === 0;
      start.onclick = () => this.startReview(questions.map((question) => question.id));
      for (const question of questions.slice(0, 300)) {
        const row = list.createDiv({ cls: "mia-row" });
        const body = row.createDiv({ cls: "mia-row-body" });
        this.renderQuestionHeading(body.createEl("strong"), question);
        const review = this.plugin.store.getReview(question.id);
        body.createEl("small", { text: `${question.subject} · 긴급도 ${weaknessUrgency(review)}점 · ${review?.lastRating === Rating.Again ? "못 암기" : "애매"}` });
        const actions = row.createDiv({ cls: "mia-row-actions" });
        actions.createEl("button", { text: "학습" }).addEventListener("click", () => this.startReview([question.id]));
        actions.createEl("button", { text: "상세" }).addEventListener("click", () => void this.plugin.openQuestionDetail(question));
      }
      if (questions.length > 300) list.createEl("p", { text: `${questions.length}개 중 긴급도가 높은 300개만 표시합니다.`, cls: "mia-muted" });
      if (!questions.length) list.createEl("p", { text: "현재 취약 문제가 없습니다.", cls: "mia-empty" });
    };
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; query = search.value; renderList(); });
    search.addEventListener("input", () => { if (!composing) { query = search.value; renderList(); } });
    renderList();
  }

  private renderKeywords(root: HTMLElement): void {
    const pageActions = root.createDiv({ cls: "mia-page-actions" });
    pageActions.createEl("button", { text: "키워드 추가", cls: "mod-cta" }).addEventListener("click", () => {
      this.plugin.openKeywordEditor();
    });
    const toolbar = root.createDiv({ cls: "mia-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "키워드 검색", attr: { "aria-label": "키워드 검색" } });
    const keywords = new Map<string, {
      keyword: KeywordReference;
      questions: Map<string, QuestionRecord & { id: string }>;
      entry?: ReturnType<MiaStudyPlugin["listKeywordNotes"]>[number];
    }>();
    for (const entry of this.plugin.listKeywordNotes()) {
      const keyword = { target: entry.target, label: entry.name, raw: `[[${entry.target}|${entry.name}]]` };
      keywords.set(keywordKey(keyword), { keyword, questions: new Map(), entry });
    }
    for (const question of this.plugin.index.registered) {
      for (const keyword of [...question.coreKeywords, ...question.subKeywords]) {
        const key = keywordKey(keyword);
        const item = keywords.get(key) ?? { keyword, questions: new Map() };
        item.questions.set(question.id, question);
        keywords.set(key, item);
      }
    }
    const grid = root.createDiv({ cls: "mia-keyword-grid" });
    const renderGrid = () => {
      grid.empty();
      const query = search.value.trim().toLocaleLowerCase("ko");
      const items = [...keywords.values()]
        .filter((item) => !query || `${item.keyword.label}\n${item.keyword.target}`.toLocaleLowerCase("ko").includes(query))
        .sort((a, b) => b.questions.size - a.questions.size || a.keyword.label.localeCompare(b.keyword.label, "ko"));
      for (const item of items) {
        const questions = [...item.questions.values()];
        const coreCount = questions.filter((question) => question.coreKeywords.some((keyword) => keywordKey(keyword) === keywordKey(item.keyword))).length;
        const subCount = questions.filter((question) => question.subKeywords.some((keyword) => keywordKey(keyword) === keywordKey(item.keyword))).length;
        const card = grid.createDiv({ cls: "mia-keyword" });
        card.createEl("strong", { text: item.keyword.label });
        card.createEl("span", { text: `${questions.length}문제 · 핵심 ${coreCount} · 보조 ${subCount}` });
        const reference = questions[0];
        card.addEventListener("click", () => {
          const sourcePath = reference?.filePath ?? item.entry?.filePath;
          if (sourcePath) this.plugin.showKeywordMeaning(item.keyword.target, item.keyword.label, sourcePath);
        });
        const editEntry = item.entry ?? {
          name: item.keyword.label,
          target: item.keyword.target,
          filePath: `${item.keyword.target}.md`,
        };
        const edit = card.createEl("button", { text: "키워드 수정" });
        edit.addEventListener("click", (event) => {
          event.stopPropagation();
          this.plugin.openKeywordEditor(editEntry);
        });
        const review = card.createEl("button", { text: "연결 문제 시험" });
        review.disabled = questions.length === 0;
        review.addEventListener("click", (event) => {
          event.stopPropagation();
          this.startReview(questions.map((question) => question.id));
        });
        const browse = card.createEl("button", { text: "연결 문제 암기" });
        browse.disabled = questions.length === 0;
        browse.addEventListener("click", (event) => {
          event.stopPropagation();
          this.startReview(questions.map((question) => question.id), "browse");
        });
        if (questions.length) {
          const details = card.createEl("details", { cls: "mia-keyword-questions" });
          details.addEventListener("click", (event) => event.stopPropagation());
          details.createEl("summary", { text: "연결 질문 보기" });
          for (const question of questions.slice(0, 300)) {
            const questionButton = details.createEl("button");
            this.renderQuestionHeading(questionButton, question);
            questionButton.addEventListener("click", () => void this.plugin.openQuestionDetail(question));
          }
        }
        const remove = card.createEl("button", { text: "키워드 삭제", cls: "mod-warning" });
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          this.plugin.confirmDeleteKeyword(editEntry);
        });
      }
      if (!items.length) grid.createEl("p", {
        text: keywords.size ? "검색 조건에 맞는 키워드가 없습니다." : "키워드를 추가하거나 질문에 핵심/보조 키워드를 연결하면 여기에 나타납니다.",
        cls: "mia-empty",
      });
    };
    let composing = false;
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; renderGrid(); });
    search.addEventListener("input", () => { if (!composing) renderGrid(); });
    renderGrid();
  }

  private renderStudy(root: HTMLElement): void {
    // A deleted current question must reach the learning check before completion.
    while (this.queueIndex < this.queue.length && !this.plugin.index.questionById(this.queue[this.queueIndex]!)) {
      this.queueIndex += 1;
    }
    if (this.queueIndex >= this.queue.length) {
      const nextDue = this.refreshLearningQueue();
      if (this.queueIndex >= this.queue.length && nextDue) {
        const waiting = root.createDiv({ cls: "mia-primary-card" });
        waiting.createEl("h3", { text: "다음 복습 대기 중" });
        waiting.createEl("p", { text: `다음 학습 단계까지 ${formatInterval(nextDue, 0)} · ${nextDue.toLocaleTimeString()}에 자동으로 다시 출제합니다.` });
        if (this.lastRated) this.renderUndoButton(waiting);
        waiting.createEl("button", { text: "학습 전 화면으로" }).addEventListener("click", () => this.returnToSessionOrigin());
        this.learningTimer = window.setTimeout(() => this.render(), Math.min(60_000, Math.max(1, nextDue.getTime() - Date.now())));
        return;
      }
    }
    const id = this.queue[this.queueIndex];
    const question = id ? this.plugin.index.questionById(id) : undefined;
    if (!question || !question.id) {
      const result = this.studyResult();
      const done = root.createDiv({ cls: "mia-primary-card" });
      done.createEl("h3", { text: this.queue.length ? "학습 완료" : "학습할 문제가 없습니다" });
      done.createEl("p", { text: this.queue.length
        ? `${result.total}문제 · 못 암기 ${result.again} · 애매 ${result.hard} · 암기 ${result.good} · 너무 쉬움 ${result.easy} · 건너뜀 ${result.skipped}`
        : "문제를 등록하거나 다음 복습 시각에 다시 확인하세요." });
      if (this.lastRated) {
        this.renderUndoButton(done);
      }
      if (this.queue.length) {
        done.createEl("button", { text: "같은 범위 다시 학습", cls: "mod-cta" }).addEventListener("click", () => this.restartSession());
      }
      done.createEl("button", { text: "학습 전 화면으로" }).addEventListener("click", () => this.returnToSessionOrigin());
      if (this.queue.length && !this.resultShown) {
        this.resultTimer = window.setTimeout(() => {
          this.resultTimer = null;
          this.resultShown = true;
          this.resultModal = new StudyResultModal(
            this.app,
            result,
            () => this.restartSession(),
            () => this.returnToSessionOrigin(),
            this.lastRated ? () => void this.undoLastRating() : undefined,
          );
          this.resultModal.open();
        }, 0);
      }
      return;
    }
    const navigation = root.createDiv({ cls: "mia-study-navigation" });
    const previous = navigation.createEl("button", { text: "← 이전 문제" });
    previous.disabled = this.queueIndex === 0;
    previous.addEventListener("click", () => this.moveToQuestion(this.queueIndex - 1));
    this.studyShortcuts.set("ArrowLeft", previous);
    navigation.createEl("div", { text: `${this.sessionMode === "recall" ? "시험 모드" : "암기 모드"} · ${this.queueIndex + 1} / ${this.queue.length} · ${question.subject} · ${question.questionType}`, cls: "mia-progress" });
    const next = navigation.createEl("button", { text: "다음 문제 →" });
    next.addEventListener("click", () => {
      if (this.isMutatingReview) return;
      // Walking through rated history must not cancel its upcoming learning step.
      if (!this.sessionAttempts.has(this.queueIndex)) this.sessionSkipped.add(question.id);
      this.moveToQuestion(this.queueIndex + 1);
    });
    this.studyShortcuts.set("ArrowRight", next);
    const meter = root.createDiv({ cls: "mia-session-meter" });
    meter.setAttr("role", "progressbar");
    meter.setAttr("aria-label", "학습 진행");
    meter.setAttr("aria-valuemin", "0");
    meter.setAttr("aria-valuemax", String(this.queue.length));
    meter.setAttr("aria-valuenow", String(this.queueIndex));
    meter.createDiv({ cls: "mia-session-meter-fill" }).style.setProperty("width", `${this.queueIndex / this.queue.length * 100}%`);
    const layout = root.createDiv({ cls: "mia-study-layout" });
    layout.tabIndex = 0;
    layout.setAttr("aria-label", "질문과 정답 영역");
    const card = layout.createDiv({ cls: "mia-study-card" });
    card.createDiv({ text: `${question.subject} / ${question.questionType}`, cls: "mia-card-context" });
    const questionSection = card.createDiv({ cls: "mia-question-section" });
    questionSection.createDiv({ text: "질문", cls: "mia-card-label" });
    const heading = questionSection.createEl("h2");
    const headingIsPrompt = question.questionMarkdown.trim() === question.heading.trim();
    this.renderQuestionHeading(heading, question);
    const sessionGrade = this.sessionAttempts.get(this.queueIndex)?.grade;
    if (sessionGrade) questionSection.createEl("p", { text: `이번 학습 평가: ${GRADE_LABELS[sessionGrade]} · 다른 평가를 누르면 기존 기록을 대체합니다.`, cls: "mia-session-rating" });
    if (!headingIsPrompt) {
      const prompt = questionSection.createDiv({ cls: "mia-markdown" });
      this.readingRenders.push(MarkdownRenderer.render(this.app, question.questionMarkdown, prompt, question.filePath, this.renderComponent ?? this));
    }
    if (!this.answerVisible) {
      questionSection.createEl("p", { text: "답을 먼저 떠올린 뒤 정답을 확인해 보세요.", cls: "mia-recall-prompt" });
      if (question.coreKeywords.length) {
        const hint = questionSection.createEl("button", { text: this.hintVisible ? "키워드 힌트 접기" : "키워드 힌트", cls: "mia-hint-button" });
        hint.setAttr("aria-expanded", String(this.hintVisible));
        hint.addEventListener("click", () => { this.hintVisible = !this.hintVisible; this.render(); this.contentEl.focus({ preventScroll: true }); });
        if (this.hintVisible) this.renderKeywordSection(questionSection, "핵심 키워드", question.coreKeywords, question.filePath);
      }
      const dock = root.createDiv({ cls: "mia-study-dock" });
      const actions = dock.createDiv({ cls: "mia-study-actions" });
      const reveal = actions.createEl("button", { text: "정답 보기", cls: "mod-cta mia-reveal" });
      reveal.setAttr("aria-keyshortcuts", "Space");
      reveal.addEventListener("click", () => {
        if (this.isMutatingReview) return;
        this.answerVisible = true;
        this.app.workspace.requestSaveLayout();
        this.saveStudyPosition();
        this.render();
        this.contentEl.focus({ preventScroll: true });
      });
      this.studyShortcuts.set(" ", reveal);
      this.renderStudyUtilities(dock, previous, next);
      return;
    }
    const answerSection = card.createDiv({ cls: "mia-answer-section" });
    answerSection.createDiv({ text: "모범 답안", cls: "mia-card-label" });
    const answer = answerSection.createDiv({ cls: "mia-markdown mia-answer" });
    this.readingRenders.push(MarkdownRenderer.render(this.app, question.answerMarkdown, answer, question.filePath, this.renderComponent ?? this));
    const concepts = card.createEl("details", { cls: "mia-study-concepts" });
    concepts.createEl("summary", { text: `핵심 개념 확인 · ${question.coreKeywords.length + question.subKeywords.length}개` });
    this.renderKeywordSection(concepts, "핵심 키워드", question.coreKeywords, question.filePath);
    this.renderKeywordSection(concepts, "보조 키워드", question.subKeywords, question.filePath);
    card.createEl("button", { text: "원문 열기", cls: "mia-source" }).addEventListener("click", () => this.plugin.openQuestion(question));
    const recommendations = recommendQuestions(question, this.plugin.index.registered, this.plugin.store.reviews, this.plugin.fsrs);
    if (recommendations.length) {
      const related = layout.createDiv({ cls: "mia-related" });
      related.createEl("h3", { text: "이어볼 문제" });
      related.createEl("p", { text: "문제 제목을 누르면 질문과 정답을 볼 수 있습니다.", cls: "mia-muted" });
      for (const item of recommendations) {
        const target = item.question;
        if (!target.id) continue;
        const registered = { ...target, id: target.id };
        const row = related.createDiv({ cls: "mia-related-item" });
        const open = row.createEl("button", { cls: "mia-related-open" });
        open.setAttr("aria-label", `${target.heading} 질문과 정답 미리보기`);
        this.renderQuestionHeading(open.createEl("strong"), target);
        open.createEl("small", { text: item.reasons.join(" · ") });
        open.addEventListener("click", () => {
          if (this.reviewSavePending()) return;
          const position = this.queueIndex;
          const layout = this.contentEl.querySelector<HTMLElement>(".mia-study-layout");
          const top = layout?.scrollTop ?? 0;
          this.plugin.openQuestionPreview(registered, () => {
            if (this.route !== "study" || this.queueIndex !== position) return;
            const currentLayout = this.contentEl.querySelector<HTMLElement>(".mia-study-layout");
            if (currentLayout) currentLayout.scrollTop = top;
          });
        });
        const included = this.queue.includes(registered.id);
        const reviewingHistory = [...this.sessionAttempts.keys()].some((index) => index > this.queueIndex);
        const add = row.createEl("button", { text: included ? "이미 학습에 포함됨" : reviewingHistory ? "학습 끝에 추가" : "다음 순서에 추가" });
        add.disabled = included;
        add.addEventListener("click", () => {
          if (this.reviewSavePending() || this.queue.includes(registered.id)) return;
          const insertionIndex = reviewingHistory ? this.queue.length : this.queueIndex + 1;
          this.queue.splice(insertionIndex, 0, registered.id);
          if (this.lastRated) {
            // Undo restores the rating, while an explicitly added question stays in its chosen order.
            const snapshot = this.lastRated.queueBefore;
            const nextAnchor = this.queue.slice(insertionIndex + 1).find((id) => snapshot.includes(id));
            snapshot.splice(nextAnchor === undefined ? snapshot.length : snapshot.indexOf(nextAnchor), 0, registered.id);
          }
          this.sessionSeed = [...new Set([...this.sessionSeed, registered.id])];
          this.app.workspace.requestSaveLayout();
          this.saveStudyPosition();
          new Notice(reviewingHistory ? "추천 문제를 현재 학습의 마지막 순서에 추가했습니다." : "추천 문제를 현재 학습의 다음 순서에 추가했습니다.");
          this.render();
        });
      }
    }
    const dock = root.createDiv({ cls: "mia-study-dock" });
    this.renderRatings(dock, question);
    this.renderStudyUtilities(dock, previous, next);
  }

  private renderStudyUtilities(dock: HTMLElement, previous: HTMLButtonElement, next: HTMLButtonElement): void {
    if (this.undoFeedback && this.lastRated) {
      const feedback = dock.createDiv({ cls: "mia-undo-feedback" });
      const status = feedback.createEl("span", { text: this.undoFeedback });
      status.setAttr("role", "status"); status.setAttr("aria-live", "polite");
      this.renderUndoButton(feedback, "mia-quick-undo");
    }
    const utility = dock.createDiv({ cls: "mia-dock-utility mia-thumb-navigation" });
    const back = utility.createEl("button", { text: "← 이전", cls: "mia-thumb-previous" });
    back.disabled = previous.disabled;
    back.addEventListener("click", () => previous.click());
    if (this.lastRated) {
      this.renderUndoButton(utility, "mia-dock-undo");
    } else {
      const help = utility.createEl("button", { text: "조작 안내", cls: "mia-controls-help" });
      help.addEventListener("click", () => new StudyControlsModal(this.app).open());
    }
    const forward = utility.createEl("button", { text: "다음 →", cls: "mia-thumb-next" });
    forward.setAttr("aria-label", "평가 없이 다음 문제");
    forward.addEventListener("click", () => next.click());
    dock.createEl("p", { text: "Space 정답 · 1–4 평가 · ← → 이동 · U 취소", cls: "mia-shortcut-hint" });
    dock.createEl("p", { text: "화면 왼쪽에서 오른쪽으로 쓸면 뒤로가기 · 문제 이동은 버튼으로", cls: "mia-touch-hint" });
  }

  private renderUndoButton(parent: HTMLElement, cls?: string): void {
    const undo = parent.createEl("button", { text: "직전 평가 취소", ...(cls ? { cls } : {}) });
    undo.disabled = this.isMutatingReview;
    undo.setAttr("aria-keyshortcuts", "U");
    undo.setAttr("aria-label", "직전 평가 취소. 저장 전 복습 기록으로 되돌리기");
    undo.addEventListener("click", () => void this.undoLastRating());
    this.studyShortcuts.set("u", undo);
  }

  private handleStudyShortcut(event: KeyboardEvent): void {
    if (this.route !== "study" || this.isMutatingReview || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), a")) return;
    if (event.key === " " && target?.closest?.("button, summary")) return;
    // Korean input sends "ㅕ" for U; retain the shortcut across keyboard layouts.
    const key = event.code === "KeyU" ? "u" : event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const button = this.studyShortcuts.get(key);
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  }

  private renderKeywordSection(
    parent: HTMLElement,
    title: string,
    keywords: KeywordReference[],
    sourcePath: string,
  ): void {
    const section = parent.createDiv({ cls: "mia-keyword-section" });
    section.createEl("h3", { text: title });
    const list = section.createDiv({ cls: "mia-keyword-chips" });
    if (!keywords.length) {
      list.createSpan({ text: "없음", cls: "mia-muted" });
      return;
    }
    for (const keyword of keywords) {
      const button = list.createEl("button", { text: keyword.label });
      button.setAttr("aria-label", `${keyword.label} 의미 보기`);
      button.addEventListener("click", () => this.plugin.showKeywordMeaning(keyword.target, keyword.label, sourcePath));
    }
  }

  private skipQuestion(): void {
    if (this.isMutatingReview) return;
    const id = this.queue[this.queueIndex];
    if (id && !this.sessionAttempts.has(this.queueIndex)) this.sessionSkipped.add(id);
    this.queueIndex += 1;
    this.answerVisible = this.sessionMode === "browse";
    this.refreshLearningQueue();
    this.app.workspace.requestSaveLayout();
    this.saveStudyPosition();
    this.render();
    this.contentEl.focus({ preventScroll: true });
  }

  private renderReviewSaveStatus(): void {
    const status = this.contentEl.createEl("p", { text: this.reviewSaveMessage, cls: "mia-muted mia-save-status" });
    status.setAttr("role", "status");
    status.setAttr("aria-live", "polite");
  }

  private beginReviewSave(message: string): void {
    this.savingReviewCheckpoint = this.reviewCheckpoint().reviewCheckpoint;
    this.isMutatingReview = true;
    this.reviewSaveMessage = message;
    this.contentEl.setAttr("aria-busy", "true");
    this.renderReviewSaveStatus();
  }

  private endReviewSave(): void {
    this.savingReviewCheckpoint = undefined;
    this.isMutatingReview = false;
    this.reviewSaveMessage = "";
    if (!this.closed) {
      this.contentEl.setAttr("aria-busy", "false");
      this.contentEl.querySelector(".mia-save-status")?.remove();
    }
  }

  private renderRatings(parent: HTMLElement, question: QuestionRecord & { id: string }): void {
    const ratings = parent.createDiv({ cls: "mia-ratings" });
    const buttons: HTMLButtonElement[] = [];
    const renderedIndex = this.queueIndex;
    const expected = this.sessionSavedStates.has(question.id)
      ? this.sessionSavedStates.get(question.id)
      : this.plugin.store.getReview(question.id);
    const baseline = this.sessionBaselines.has(this.queueIndex)
      ? this.sessionBaselines.get(this.queueIndex)
      : this.plugin.store.getReview(question.id);
    const hasLaterAttempt = [...this.sessionAttempts].some(([index, attempt]) => index > this.queueIndex && attempt.id === question.id);
    for (const preview of this.plugin.fsrs.preview(baseline, new Date(), question.id)) {
      const button = ratings.createEl("button");
      button.dataset.grade = String(preview.grade);
      button.setAttr("aria-keyshortcuts", String(preview.grade));
      this.studyShortcuts.set(String(preview.grade), button);
      const interval = formatInterval(preview.due, preview.scheduledDays, preview.fixedIntervalMinutes);
      button.setAttr("aria-label", `${GRADE_LABELS[preview.grade]} · 다음 복습 ${interval} · ${GRADE_HINTS[preview.grade]}`);
      button.setAttr("title", GRADE_HINTS[preview.grade]);
      buttons.push(button);
      button.disabled = hasLaterAttempt || this.isMutatingReview;
      button.createEl("strong", { text: GRADE_LABELS[preview.grade] });
      button.createEl("small", { text: interval });
      button.createEl("kbd", { text: String(preview.grade), cls: "mia-grade-key" }).setAttr("aria-hidden", "true");
      button.addEventListener("click", async () => {
        if (this.isMutatingReview || hasLaterAttempt || this.closed
          || this.queueIndex !== renderedIndex || this.queue[this.queueIndex] !== question.id) return;
        buttons.forEach((item) => { item.disabled = true; });
        const ratedIndex = this.queueIndex;
        const queueBefore = [...this.queue];
        const expectedResume = JSON.stringify(this.plugin.studyUi.resume);
        const expectedResumeRevision = this.plugin.studyUi.resumeRevision;
        this.beginReviewSave("평가 저장 중…");
        try {
          const now = new Date();
          if (expected?.card.last_review && Date.parse(expected.card.last_review) > now.getTime()) {
            throw new Error("기기 시간이 직전 평가보다 이전입니다. 날짜와 시간을 확인한 뒤 다시 평가하세요.");
          }
          const state = this.plugin.fsrs.rate(baseline, preview.grade, now, question.id);
          await this.plugin.store.setReview(question.id, state, { state: expected });
          if (!this.sessionBaselines.has(ratedIndex)) this.sessionBaselines.set(ratedIndex, baseline);
          this.sessionSavedStates.set(question.id, state);
          this.sessionGrades.set(question.id, preview.grade);
          this.sessionAttempts.set(ratedIndex, { id: question.id, grade: preview.grade });
          this.sessionSkipped.delete(question.id);
          this.lastRated = { id: question.id, queueIndex: ratedIndex, queueBefore, savedState: state };
          this.showUndoFeedback(GRADE_LABELS[preview.grade]);
          this.queueIndex = ratedIndex + 1;
          this.answerVisible = this.sessionMode === "browse";
          this.endReviewSave();
          this.refreshLearningQueue();
          if (!this.closed) this.app.workspace.requestSaveLayout();
          this.saveStudyPosition(expectedResume, expectedResumeRevision);
          if (!this.closed) {
            this.render();
            this.contentEl.focus({ preventScroll: true });
          }
        } catch (error) {
          this.endReviewSave();
          new Notice(`복습 기록 저장 실패: ${errorMessage(error)}`);
          this.render();
        }
      });
    }
    if (hasLaterAttempt) parent.createEl("p", { text: "이 문제는 이후 학습 단계에서 다시 평가했습니다. 최신 평가를 취소한 뒤 수정할 수 있습니다.", cls: "mia-muted" });
  }

  private async undoLastRating(): Promise<void> {
    const lastRated = this.lastRated;
    if (!lastRated || this.isMutatingReview || this.closed) return;
    const expectedResume = JSON.stringify(this.plugin.studyUi.resume);
    const expectedResumeRevision = this.plugin.studyUi.resumeRevision;
    this.beginReviewSave("평가 취소 중…");
    this.clearResultPopup();
    try {
      const baseline = this.sessionBaselines.get(lastRated.queueIndex);
      if (baseline) await this.plugin.store.setReview(lastRated.id, baseline, { state: lastRated.savedState });
      else await this.plugin.store.removeReview(lastRated.id, { state: lastRated.savedState });
      if (baseline) this.sessionSavedStates.set(lastRated.id, baseline); else this.sessionSavedStates.delete(lastRated.id);
      this.sessionBaselines.delete(lastRated.queueIndex);
      this.sessionAttempts.delete(lastRated.queueIndex);
      this.sessionGrades.delete(lastRated.id);
      const prior = [...this.sessionAttempts].sort(([left], [right]) => left - right).filter(([, attempt]) => attempt.id === lastRated.id).at(-1)?.[1];
      if (prior) this.sessionGrades.set(lastRated.id, prior.grade);
      this.sessionSkipped.delete(lastRated.id);
      this.queueIndex = lastRated.queueIndex;
      this.queue = lastRated.queueBefore;
      this.answerVisible = true;
      this.lastRated = null;
      this.undoFeedback = "";
      this.resultShown = false;
      this.endReviewSave();
      if (!this.closed) this.app.workspace.requestSaveLayout();
      this.saveStudyPosition(expectedResume, expectedResumeRevision);
      new Notice("직전 평가를 취소했습니다.");
      if (!this.closed) {
        this.render();
        this.contentEl.focus({ preventScroll: true });
      }
    } catch (error) {
      this.endReviewSave();
      new Notice(`평가 취소 저장 실패: ${errorMessage(error)}`);
    }
  }

  private moveToQuestion(index: number): void {
    if (this.isMutatingReview) return;
    const forward = index > this.queueIndex;
    this.queueIndex = Math.max(0, Math.min(index, this.queue.length));
    this.answerVisible = this.sessionMode === "browse" || this.sessionAttempts.has(this.queueIndex);
    if (forward) this.refreshLearningQueue();
    this.app.workspace.requestSaveLayout();
    this.saveStudyPosition();
    this.render();
    this.contentEl.focus({ preventScroll: true });
  }

  private refreshLearningQueue(): Date | null {
    const scope = [...new Set([...this.sessionSeed, ...this.queue])].filter((id) => this.plugin.index.questionById(id));
    const plan = planLearningQueue(this.queue, this.queueIndex, scope, this.plugin.store.reviews, this.sessionSkipped);
    // Revisiting history must not shift the positions of recorded attempts.
    if (![...this.sessionAttempts.keys()].some((index) => index >= this.queueIndex)) this.queue = plan.queue;
    return plan.nextDue;
  }

  private studyResult(): StudyResult {
    const grades = [...this.sessionGrades.values()];
    return {
      total: new Set(this.queue).size,
      again: grades.filter((grade) => grade === Rating.Again).length,
      hard: grades.filter((grade) => grade === Rating.Hard).length,
      good: grades.filter((grade) => grade === Rating.Good).length,
      easy: grades.filter((grade) => grade === Rating.Easy).length,
      skipped: [...this.sessionSkipped].filter((id) => !this.sessionGrades.has(id)).length,
      durationSeconds: Math.max(0, Math.round((Date.now() - this.sessionStartedAt) / 1000)),
    };
  }

  private restartSession(): void {
    const seed = [...this.sessionSeed];
    const mode = this.sessionMode;
    this.startReview(seed, mode);
  }

  private returnToSessionOrigin(): void {
    this.navigate(this.sessionOrigin === "study" ? "dashboard" : this.sessionOrigin);
  }
}

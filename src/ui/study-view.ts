import { withoutSourceAttribution } from "../core/source-attribution";
import { StudyManagementModal } from "./study-management-modal";
import { Component, ItemView, MarkdownRenderer, Notice, Platform, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { Rating } from "ts-fsrs";
import type MiaStudyPlugin from "../main";
import { StudyGrade } from "../core/fsrs-service";
import { planLearningQueue } from "../core/learning-queue";
import { KeywordReference, QuestionRecord, QuestionReviewState } from "../core/models";
import { DEFAULT_MIA_NAVIGATION_STATE, MiaRoute, MiaSessionMode, ReviewCheckpoint, parseMiaNavigationState } from "../core/navigation";
import type { ReviewFilter } from "../core/question-query";
import { buildReviewQueue, planSelectedReview, recommendQuestions, type ReviewQueueExclusion, type ReviewQueueOptions } from "../core/recommendation-engine";
import { errorMessage } from "./error-message";
import { bindKeyboardViewport, KeyboardViewportBinding } from "./mobile-keyboard";
import { StudyResult, StudyResultModal } from "./study-result-modal";
import { GRADE_LABELS, GRADE_HINTS } from "./study-grades";
import { bindStudyGestures, StudyGestureBinding } from "./study-gestures";
import { bindAdaptiveLayout } from "./adaptive-layout";
import { bindRatingTapGuard } from "./rating-tap-guard";
import { StudyControlsModal } from "./study-controls-modal";
import { StudyAppearanceModal } from "./study-appearance-modal";
import type { StudySessionSummary } from "../services/study-ui-store";
import { renderKeywords } from "./keywords-page";
import { renderDashboard, renderProgress } from "./progress-pages";
import { QuestionListState, renderQuestionsPage } from "./question-list-page";
import { renderQuestionHeading } from "./question-row";
import type { StudyPageContext } from "./study-page-context";
import { renderWeakness } from "./weakness-page";

export const MIA_VIEW_TYPE = "mia-study-view";

interface BlockedSelection {
  ids: string[];
  exclusions: ReviewQueueExclusion[];
}

function formatInterval(due: Date, days: number, fixedMinutes?: number, now = new Date()): string {
  if (fixedMinutes !== undefined) {
    if (fixedMinutes % 1440 === 0) return `${fixedMinutes / 1440}일`;
    if (fixedMinutes % 60 === 0) return `${fixedMinutes / 60}시간`;
    return `${fixedMinutes}분`;
  }
  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60_000));
  if (days === 0 || minutes !== days * 1440) {
    return [Math.floor(minutes / 1440) ? `${Math.floor(minutes / 1440)}일` : "", Math.floor(minutes % 1440 / 60) ? `${Math.floor(minutes % 1440 / 60)}시간` : "", minutes % 60 ? `${minutes % 60}분` : ""].filter(Boolean).join(" ");
  }
  if (days < 30) return `${days}일`;
  if (days < 365) return `약 ${Math.round(days / 30)}개월`;
  return `약 ${(days / 365).toFixed(1)}년`;
}

/**
 * The MIA tab. Owns navigation and the study session (queue, ratings, undo,
 * resume, reading position); the read-only pages render from their own modules.
 */
export class MiaStudyView extends ItemView {
  private route: MiaRoute = "dashboard";
  private editingSessionQuestion: string | null = null;
  private sessionEditGeneration = 0;
  private editedSessionQuestion: string | null = null;
  private focusEditTarget = false;
  private readonly changedGradedAnswers = new Set<string>();
  private queue: string[] = [];
  private queueIndex = 0;
  private answerVisible = false;
  private sessionMode: MiaSessionMode = "recall";
  private blockedSelection: BlockedSelection | null = null;
  private readOnlyBrowse = false;
  private lastRated: { id: string; queueIndex: number; queueBefore: string[]; savedState: QuestionReviewState } | null = null;
  private isMutatingReview = false;
  private readonly questionList = new QuestionListState();
  private readonly pages: StudyPageContext = this.createPageContext();
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
      if (!this.contentEl.ownerDocument.hidden && (this.route === "dashboard" || this.route === "progress")) void this.refreshAfterReturn();
    }, 30_000));
  }

  async onClose(): Promise<void> {
    if (this.closed) return;
    this.flushReadingPosition();
    if (this.undoFeedbackTimer !== null) window.clearTimeout(this.undoFeedbackTimer);
    this.closed = true;
    this.sessionEditGeneration += 1;
    this.editingSessionQuestion = null;
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

  startReview(questionIds?: string[], mode: MiaSessionMode = "recall", withoutGrading = false): void {
    if (this.reviewSavePending()) return;
    this.clearResultPopup();
    if (this.readingTimer !== null) { window.clearTimeout(this.readingTimer); this.readingTimer = null; }
    this.sessionSavedStates.clear();
    this.editingSessionQuestion = null;
    this.sessionEditGeneration += 1;
    this.editedSessionQuestion = null;
    this.changedGradedAnswers.clear();
    this.readingPosition = { key: "", scrollTop: 0, pageScrollTop: 0, conceptsOpen: false };
    this.undoFeedback = "";
    this.stateRestored = true;
    const questions = this.plugin.index.registered;
    const { reviews } = this.plugin.store;
    const fsrs = this.plugin.fsrs;
    const requestedIds = questionIds ? new Set(questionIds) : null;
    const scope = requestedIds ? questions.filter((question) => requestedIds.has(question.id)) : questions;
    const sequential = mode === "browse" && this.plugin.studyUi.appearance.memorizationOrder === "sequential";
    this.readOnlyBrowse = mode === "browse" && withoutGrading;
    const options: ReviewQueueOptions = { now: new Date() };
    if (mode === "recall") options.management = this.plugin.store.settings.studyManagement;
    else {
      if (!sequential) options.random = Math.random;
      if (this.readOnlyBrowse) options.includeFuture = true;
    }
    const selected = mode === "recall" && requestedIds?.size ? planSelectedReview(questions, requestedIds, reviews, fsrs, options) : null;
    const eligible = selected?.queue ?? buildReviewQueue(scope, reviews, fsrs, options);
    this.blockedSelection = selected && !eligible.length && requestedIds ? { ids: [...requestedIds], exclusions: selected.exclusions } : null;
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
    // The fallback is read-only and must not restore as a gradable browse session.
    if (this.readOnlyBrowse) return { ...DEFAULT_MIA_NAVIGATION_STATE, route: this.route === "study" ? this.sessionOrigin : this.route };
    return this.navigationState();
  }

  private navigationState(): Record<string, unknown> {
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
    const initialRestore = !this.stateRestored;
    this.flushReadingPosition();
    const next = parseMiaNavigationState(state);
    // Workspace navigation supersedes any editor that is still loading.
    if (this.editingSessionQuestion) {
      this.editingSessionQuestion = null;
      this.sessionEditGeneration += 1;
    }
    let recoveredRatingId: string | undefined;
    if (!this.stateRestored && next.route === "study") {
      const index = this.restoredQueueIndex(next.queue, next.queueIndex, next.reviewCheckpoint);
      if (index !== next.queueIndex) {
        recoveredRatingId = next.queue[next.queueIndex];
        next.answerVisible = next.sessionMode === "browse";
      }
      next.queueIndex = index;
    }
    this.stateRestored = true;
    const sessionChanged = next.sessionMode !== this.sessionMode || next.queue.length !== this.queue.length
      || next.queue.some((id, index) => id !== this.queue[index]);
    if (sessionChanged) {
      this.blockedSelection = null;
      this.readOnlyBrowse = false;
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
      const saved = this.plugin.studyUi.resume;
      if (saved?.sessionMode === next.sessionMode && saved.queue.length === next.queue.length
        && saved.queue.every((id, index) => id === next.queue[index])) {
        this.restoreSessionSummary(saved.sessionSummary, next.queue);
        if (initialRestore) {
          // Workspace hydration can precede the first question-index scan.
          // Keep persisted IDs until render can reconcile a ready index.
          this.sessionSeed = [...saved.seed];
          this.sessionSkipped = new Set(saved.skipped);
          if (!recoveredRatingId && saved.queueIndex === next.queueIndex) {
            this.readingPosition = { key: `study:${next.queueIndex}:${next.queue[next.queueIndex] ?? ""}`,
              scrollTop: saved.scrollTop ?? 0, pageScrollTop: saved.pageScrollTop ?? 0, conceptsOpen: saved.conceptsOpen ?? false };
          }
        }
      }
      this.resultShown = false;
      this.hintVisible = false;
    }
    if (recoveredRatingId) this.restoreCommittedSessionGrade(recoveredRatingId);
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
      state: { ...this.navigationState(), route },
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

  private async refreshAfterReturn(refreshTime = true, notify = false): Promise<void> {
    if (this.closed || this.refreshingAfterReturn || this.isMutatingReview) return;
    this.refreshingAfterReturn = true;
    const previousResume = JSON.stringify(this.plugin.studyUi.resume);
    try {
      await this.plugin.synchronizeStudyData();
      if (this.closed) return;
      await this.plugin.studyUi.load();
      // A focus event can occur between pointerdown and click. Replacing unchanged
      // controls here drops that first tap; visibility changes still refresh timers.
      const pruned = this.route === "study" && !this.isMutatingReview && this.pruneExternallyRated(false);
      if (pruned) this.saveStudyPosition();
      const resumeChanged = previousResume !== JSON.stringify(this.plugin.studyUi.resume);
      if (!this.closed && ((pruned || refreshTime && (this.route === "study" || this.route === "dashboard" || this.route === "progress"))
        || (resumeChanged && this.route === "dashboard"))) this.render();
      if (!this.closed && notify) new Notice("보관함에 도착한 학습 기록과 이어하기 위치를 확인했습니다.");
    } catch (error) { new Notice(`학습 기록 확인 실패: ${errorMessage(error)}`); }
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
    if (this.readOnlyBrowse || this.blockedSelection) return;
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
      sessionSummary: { startedAt: this.sessionStartedAt, grades: [...this.sessionGrades].map(([id, grade]) => ({ id, grade })) },
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
      const sameSession = !this.readOnlyBrowse && this.queueIndex === index && this.sessionMode === saved.sessionMode && this.queue.length === queue.length && this.queue.every((id, position) => id === queue[position]);
      this.readOnlyBrowse = false;
      this.blockedSelection = null;
      if (!sameSession) {
        this.lastRated = null; this.sessionBaselines.clear(); this.sessionAttempts.clear();
        this.sessionGrades.clear(); this.sessionSkipped.clear(); this.sessionStartedAt = Date.now();
        this.restoreSessionSummary(saved.sessionSummary, queue);
        this.sessionSkipped = new Set(saved.skipped.filter(exists));
      }
      if (advanced) this.restoreCommittedSessionGrade(queue[originalIndex]);
      this.queue = queue; this.queueIndex = index; this.sessionSeed = saved.seed.filter(exists);
      this.sessionMode = saved.sessionMode;
      // Cards rated on another device since this session started must not come back.
      const currentBefore = queue[index];
      const pruned = this.pruneExternallyRated(true);
      const moved = advanced || (pruned && this.queue[index] !== currentBefore);
      this.readingPosition = { key: `study:${index}:${this.queue[index] ?? ""}`, scrollTop: moved ? 0 : saved.scrollTop ?? 0, pageScrollTop: moved ? 0 : saved.pageScrollTop ?? 0, conceptsOpen: moved ? false : saved.conceptsOpen ?? false };
      this.answerVisible = moved ? saved.sessionMode === "browse" : saved.answerVisible; this.resultShown = false;
      this.stateRestored = true;
      if (advanced || pruned) this.saveStudyPosition();
      this.navigate("study");
    } catch (error) { new Notice(`이어하기 실패: ${errorMessage(error)}`); }
  }

  /**
   * In recall mode, drops not-yet-reached cards whose newest review came after
   * this session started and that this session did not grade itself (for example
   * a review synced in from another device). Browse mode is never changed.
   */
  private pruneExternallyRated(includeCurrent: boolean): boolean {
    if (this.sessionMode !== "recall" || !this.queue.length) return false;
    if ([...this.sessionAttempts.keys()].some((position) => position >= this.queueIndex)) return false;
    const own = new Set([...this.sessionGrades.keys(), ...[...this.sessionAttempts.values()].map((attempt) => attempt.id)]);
    const from = includeCurrent ? this.queueIndex : this.queueIndex + 1;
    const external = (id: string) => {
      if (own.has(id)) return false;
      const reviewedAt = Date.parse(this.plugin.store.getReview(id)?.history.at(-1)?.review ?? "");
      return Number.isFinite(reviewedAt) && reviewedAt > this.sessionStartedAt;
    };
    const dropped = new Set(this.queue.slice(from).filter(external));
    if (!dropped.size) return false;
    this.queue = this.queue.filter((id, position) => position < from || !dropped.has(id));
    this.sessionSeed = this.sessionSeed.filter((id) => !dropped.has(id));
    return true;
  }

  private restoreSessionSummary(summary: StudySessionSummary | undefined, queue: string[]): void {
    if (!summary) return;
    // These values describe the result only. Undo/regrading baselines stay local
    // so a resumed snapshot cannot overwrite a newer durable review.
    this.sessionStartedAt = summary.startedAt;
    const scope = new Set(queue);
    this.sessionGrades = new Map(summary.grades.filter(item => scope.has(item.id)).map(item => [item.id, item.grade]));
  }

  private restoreCommittedSessionGrade(id: string | undefined): void {
    if (!id) return;
    const review = this.plugin.store.getReview(id);
    const reviewedAt = Date.parse(review?.history.at(-1)?.review ?? "");
    // A version change can also come from an older external/imported record.
    // Recover only result metadata from this session, never undo/regrade baselines.
    if (!Number.isFinite(reviewedAt) || reviewedAt < this.sessionStartedAt) return;
    const grade = review?.lastRating;
    if (grade === Rating.Again || grade === Rating.Hard || grade === Rating.Good || grade === Rating.Easy) {
      this.sessionGrades.set(id, grade);
      this.sessionSkipped.delete(id);
    }
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
    const settingsFocus = active && sameRoute ? [".mia-learning-button", ".mia-appearance-button"].find(selector => active === root.querySelector(selector)) : undefined;
    const restoreEditFocus = this.renderedPosition === this.readingKey() && active && active === root.querySelector(".mia-session-edit-actions button");
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
    if (this.route === "dashboard") renderDashboard(this.pages, root);
    if (this.route === "progress") renderProgress(this.pages, root);
    if (this.route === "questions") this.renderQuestionsRoute(root);
    if (this.route === "weakness") renderWeakness(this.pages, root);
    if (this.route === "keywords") renderKeywords(this.pages, root);
    if (this.route === "study") {
      this.renderStudy(root);
      const current = this.plugin.index.questionById(this.queue[this.queueIndex] ?? "");
      const announcement = root.createEl("span", { cls: "mia-sr-only", text: current ? `${this.queueIndex + 1}번 문제, ${current.heading}. ${this.answerVisible ? "정답 표시됨" : "정답 숨김"}` : this.editedSessionQuestion === this.queue[this.queueIndex] ? "원본 문제를 찾을 수 없습니다. 현재 위치는 유지됩니다." : "학습 결과" });
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
    } else if (restoreEditFocus) {
      root.querySelector<HTMLButtonElement>(".mia-session-edit-actions button")?.focus({ preventScroll: true });
    } else if (settingsFocus) {
      this.restoreSettingsFocus(settingsFocus);
    }
  }

  private restoreSettingsFocus(selector: string): void {
    if (!this.closed) this.contentEl.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
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
    settingsButtons.createEl("button", { text: "학습 설정", cls: "mia-learning-button" }).addEventListener("click", () => this.openStudySettings());
    const appearance = settingsButtons.createEl("button", { text: "보기 설정", cls: "mia-appearance-button" });
    appearance.addEventListener("click", () => new StudyAppearanceModal(this.app, this.plugin.studyUi, () => this.refreshAppearance(), () => this.restoreSettingsFocus(".mia-appearance-button")).open());
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

  private openStudySettings(): void {
    new StudyManagementModal(this.app, this.plugin, () => this.render(), () => this.restoreSettingsFocus(".mia-learning-button")).open();
  }

  private showQuestions(review: ReviewFilter, subject = "all"): void {
    this.questionList.show(review, subject);
    this.navigate("questions");
  }

  private createPageContext(): StudyPageContext {
    const view = this; // The getters below need the view, not the context object.
    return {
      get app() { return view.app; },
      get plugin() { return view.plugin; },
      get component() { return view.renderComponent ?? view; },
      get renders() { return view.readingRenders; },
      startReview: (questionIds, mode) => view.startReview(questionIds, mode),
      resumeStudy: () => view.resumeStudy(),
      navigate: (route) => view.navigate(route),
      showDashboard: () => view.showDashboard(),
      showQuestions: (review, subject) => view.showQuestions(review, subject),
      openStudySettings: () => view.openStudySettings(),
      refreshRecords: () => view.refreshAfterReturn(true, true),
    };
  }

  private renderQuestionsRoute(root: HTMLElement): void {
    const editing = this.editingSessionQuestion;
    const editTarget = editing ? { id: editing, focus: this.focusEditTarget, returnToStudy: () => this.returnFromQuestionEditor() } : null;
    if (editTarget) this.focusEditTarget = false;
    renderQuestionsPage(this.pages, root, this.questionList, editTarget);
  }

  private renderQuestionHeading(element: HTMLElement, question: QuestionRecord): void {
    renderQuestionHeading(this.pages, element, question);
  }

  private returnFromQuestionEditor(): void {
    if (!this.editingSessionQuestion) return;
    this.editingSessionQuestion = null;
    this.sessionEditGeneration += 1;
    if (this.closed) return;
    this.route = "study";
    this.render();
    const editButton = this.contentEl.querySelector<HTMLButtonElement>(".mia-session-edit-actions button");
    (editButton ?? this.contentEl).focus({ preventScroll: true });
  }

  private async editSessionQuestion(id: string): Promise<void> {
    if (this.isMutatingReview || this.editingSessionQuestion) return;
    const current = this.plugin.index.questionById(id);
    if (!current) { new Notice("원본 문제를 찾을 수 없습니다. 삭제 또는 ID 충돌 여부를 확인하세요."); return; }
    this.flushReadingPosition();
    const generation = ++this.sessionEditGeneration;
    const active = () => !this.closed && generation === this.sessionEditGeneration && this.editingSessionQuestion === id;
    this.editingSessionQuestion = id;
    this.editedSessionQuestion = id;
    this.focusEditTarget = true;
    this.route = "questions";
    this.render();
    try {
      await this.plugin.openManagedQuestionEditor(current, () => { if (active()) this.returnFromQuestionEditor(); }, () => {
        if (!active()) return;
        const updated = this.plugin.index.questionById(id);
        if (updated && updated.answerMarkdown !== current.answerMarkdown && (this.plugin.store.getReview(id) || [...this.sessionAttempts.values()].some(attempt => attempt.id === id))) {
          this.changedGradedAnswers.add(id);
          new Notice("정답이 수정되었습니다. 기존 평가는 유지됩니다. 자동 재채점하지 않으므로 답안을 확인한 뒤 필요하면 직접 다시 평가하세요.");
        }
      }, active);
    } catch (error) {
      if (!active()) return;
      new Notice(`문제 편집 열기 실패: ${errorMessage(error)}`);
      this.returnFromQuestionEditor();
    }
  }

  private renderStudy(root: HTMLElement): void {
    if (this.editedSessionQuestion === this.queue[this.queueIndex] && !this.plugin.index.questionById(this.editedSessionQuestion)) {
      const missing = root.createDiv({ cls: "mia-primary-card" });
      missing.createEl("p", { text: "편집하던 원본 문제가 삭제되었거나 찾을 수 없습니다. 현재 위치는 유지됩니다.", cls: "mia-warning" });
      missing.createEl("button", { text: "다음 문제로 이동" }).addEventListener("click", () => this.moveToQuestion(this.queueIndex + 1));
      missing.createEl("button", { text: "학습 전 화면으로" }).addEventListener("click", () => this.returnToSessionOrigin());
      return;
    }

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
      if (this.blockedSelection && !this.queue.length) this.renderBlockedSelection(done, this.blockedSelection);
      else done.createEl("p", { text: this.queue.length
        ? `${result.total}문제 · 못 암기 ${result.again} · 애매 ${result.hard} · 암기 ${result.good} · 너무 쉬움 ${result.easy} · 건너뜀 ${result.skipped}`
        : "문제를 등록하거나 다음 복습 시각에 다시 확인하세요." });
      if (this.lastRated) {
        this.renderUndoButton(done);
      }
      if (this.queue.length) {
        done.createEl("button", { text: "같은 범위 다시 학습", cls: "mod-cta" }).addEventListener("click", () => this.restartSession());
      }
      done.createEl("button", { text: "학습 전 화면으로" }).addEventListener("click", () => this.returnToSessionOrigin());
      if (this.queue.length && !this.resultShown && !this.readOnlyBrowse) {
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
    const editActions = questionSection.createDiv({ cls: "mia-session-edit-actions" });
    const edit = editActions.createEl("button", { text: "문제 편집" });
    edit.disabled = this.isMutatingReview;
    edit.addEventListener("click", () => void this.editSessionQuestion(question.id));
    if (this.changedGradedAnswers.has(question.id)) questionSection.createEl("p", { text: "정답 수정 후에도 기존 평가는 유지됩니다. 자동 재채점되지 않습니다. 확인 후 필요하면 직접 다시 평가하세요.", cls: "mia-warning" });
    const sessionGrade = this.sessionAttempts.get(this.queueIndex)?.grade;
    if (sessionGrade) questionSection.createEl("p", { text: `이번 학습 평가: ${GRADE_LABELS[sessionGrade]} · 다른 평가를 누르면 기존 기록을 대체합니다.`, cls: "mia-session-rating" });
    if (!headingIsPrompt) {
      const prompt = questionSection.createDiv({ cls: "mia-markdown" });
      this.readingRenders.push(MarkdownRenderer.render(this.app, withoutSourceAttribution(question.questionMarkdown), prompt, question.filePath, this.renderComponent ?? this));
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
    this.readingRenders.push(MarkdownRenderer.render(this.app, withoutSourceAttribution(question.answerMarkdown), answer, question.filePath, this.renderComponent ?? this));
    const concepts = card.createEl("details", { cls: "mia-study-concepts" });
    concepts.createEl("summary", { text: `핵심 개념 확인 · ${question.coreKeywords.length + question.subKeywords.length}개` });
    this.renderKeywordSection(concepts, "핵심 키워드", question.coreKeywords, question.filePath);
    this.renderKeywordSection(concepts, "보조 키워드", question.subKeywords, question.filePath);
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
    if (!this.readOnlyBrowse) this.renderRatings(dock, question);
    this.renderStudyUtilities(dock, previous, next);
  }

  private renderBlockedSelection(parent: HTMLElement, { ids, exclusions }: BlockedSelection): void {
    const reasons = [
      ["not-due", "복습 기한 전"], ["new-limit", "오늘 새 문제 한도 도달"],
      ["review-limit", "오늘 복습 한도 도달"], ["missing", "지정한 문제를 찾을 수 없음"],
    ] as const;
    for (const [reason, label] of reasons) {
      const matching = exclusions.filter(item => item.reason === reason);
      if (!matching.length) continue;
      const nextDue = matching.flatMap(item => item.reason === "not-due" ? [item.nextDue] : [])
        .sort((left, right) => left.getTime() - right.getTime())[0];
      const time = nextDue ? ` · 가장 이른 다음 복습 ${nextDue.toLocaleString("ko-KR")}` : "";
      parent.createEl("p", { text: `${label} · ${matching.length}개${time}`, cls: "mia-muted" });
    }
    const browse = parent.createEl("button", { text: "암기 모드로 보기", cls: "mod-cta" });
    browse.disabled = !ids.some(id => this.plugin.index.questionById(id));
    browse.addEventListener("click", () => this.startReview(ids, "browse", true));
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
    } else if (!this.readOnlyBrowse) {
      const help = utility.createEl("button", { text: "조작 안내", cls: "mia-controls-help" });
      help.addEventListener("click", () => new StudyControlsModal(this.app).open());
    }
    const forward = utility.createEl("button", { text: "다음 →", cls: "mia-thumb-next" });
    forward.setAttr("aria-label", "평가 없이 다음 문제");
    forward.addEventListener("click", () => next.click());
    dock.createEl("p", { text: this.readOnlyBrowse ? "평가 없이 보기 · ← → 이동" : "Space 정답 · 1–4 평가 · ← → 이동 · U 취소", cls: "mia-shortcut-hint" });
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
    const scheduler = this.plugin.fsrs;
    const previewAt = new Date();
    for (const preview of scheduler.preview(baseline, previewAt, question.id)) {
      const button = ratings.createEl("button");
      button.dataset.grade = String(preview.grade);
      button.setAttr("aria-keyshortcuts", String(preview.grade));
      this.studyShortcuts.set(String(preview.grade), button);
      const interval = formatInterval(preview.due, preview.scheduledDays, preview.fixedIntervalMinutes, previewAt);
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
          const due = new Date(state.card.due);
          const currentInterval = formatInterval(due, state.card.scheduled_days,
            preview.fixedIntervalMinutes === undefined ? undefined : (due.getTime() - now.getTime()) / 60000, now);
          if (this.plugin.fsrs === scheduler && currentInterval !== interval) {
            this.endReviewSave();
            this.render();
            new Notice("시간 경과로 다음 복습 간격이 바뀌었습니다. 새 간격을 확인한 뒤 다시 평가해 주세요.");
            return;
          }
          await this.plugin.store.setReview(question.id, state, { state: expected });
          if (!this.sessionBaselines.has(ratedIndex)) this.sessionBaselines.set(ratedIndex, baseline);
          this.sessionSavedStates.set(question.id, state);
          this.changedGradedAnswers.delete(question.id);
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
    if (this.readOnlyBrowse) return null;
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
    this.startReview(seed, mode, this.readOnlyBrowse);
  }

  private returnToSessionOrigin(): void {
    this.navigate(this.sessionOrigin === "study" ? "dashboard" : this.sessionOrigin);
  }
}

import { Component, ItemView, MarkdownRenderer, Notice, Platform, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { Rating } from "ts-fsrs";
import type MiaStudyPlugin from "../main";
import { StudyGrade } from "../core/fsrs-service";
import { QUESTION_TYPES, KeywordReference, QuestionRecord, QuestionReviewState } from "../core/models";
import { MiaRoute, MiaSessionMode, parseMiaNavigationState } from "../core/navigation";
import { calculateProgress } from "../core/progress";
import { QuestionSort, ReviewFilter, queryQuestions, weaknessUrgency } from "../core/question-query";
import { buildReviewQueue, recommendQuestions } from "../core/recommendation-engine";
import { errorMessage } from "./error-message";
import { bindKeyboardViewport, KeyboardViewportBinding } from "./mobile-keyboard";
import { StudyResult, StudyResultModal } from "./study-result-modal";

export const MIA_VIEW_TYPE = "mia-study-view";

const GRADE_LABELS: Record<StudyGrade, string> = {
  [Rating.Again]: "못 암기",
  [Rating.Hard]: "애매",
  [Rating.Good]: "암기",
  [Rating.Easy]: "너무 쉬움",
};

function formatInterval(due: Date, days: number, now = new Date()): string {
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
  private lastRated: { id: string; queueIndex: number } | null = null;
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
  private sessionBaselines = new Map<string, QuestionReviewState | undefined>();
  private sessionGrades = new Map<string, StudyGrade>();
  private sessionSkipped = new Set<string>();
  private resultShown = false;
  private renderComponent: Component | null = null;
  private keyboardViewport: KeyboardViewportBinding | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MiaStudyPlugin) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string { return MIA_VIEW_TYPE; }
  getDisplayText(): string { return "MIA Study"; }
  getIcon(): string { return "brain-circuit"; }

  async onOpen(): Promise<void> {
    this.keyboardViewport = bindKeyboardViewport(this.contentEl);
    this.unsubscribers = [
      this.plugin.index.subscribe(() => this.render()),
      this.plugin.store.subscribe(() => { if (!this.isMutatingReview) this.render(); }),
    ];
    this.render();
  }

  async onClose(): Promise<void> {
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.renderComponent?.unload();
  }

  showDashboard(): void {
    this.navigate("dashboard");
  }

  startReview(questionIds?: string[], mode: MiaSessionMode = "recall"): void {
    const questions = this.plugin.index.registered;
    const validIds = new Set(questions.map((question) => question.id));
    const requested = questionIds ?? buildReviewQueue(questions, this.plugin.store.reviews, this.plugin.fsrs)
      .map((question) => question.id);
    this.queue = [...new Set(requested.filter((id) => validIds.has(id)))];
    this.sessionSeed = [...this.queue];
    if (this.route !== "study") this.sessionOrigin = this.route;
    this.queueIndex = 0;
    this.sessionMode = mode;
    this.answerVisible = mode === "browse";
    this.lastRated = null;
    this.sessionStartedAt = Date.now();
    this.sessionBaselines.clear();
    this.sessionGrades.clear();
    this.sessionSkipped.clear();
    this.resultShown = false;
    this.navigate("study");
  }

  getState(): Record<string, unknown> {
    return {
      route: this.route,
      queue: [...this.queue],
      queueIndex: this.queueIndex,
      answerVisible: this.answerVisible,
      sessionMode: this.sessionMode,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const next = parseMiaNavigationState(state);
    result.history = next.route !== this.route;
    this.route = next.route;
    this.queue = next.queue;
    this.queueIndex = next.queueIndex;
    this.answerVisible = next.answerVisible;
    this.sessionMode = next.sessionMode;
    this.render();
  }

  private navigate(route: MiaRoute): void {
    void this.leaf.setViewState({
      type: MIA_VIEW_TYPE,
      active: true,
      state: { ...this.getState(), route },
    });
  }

  private render(): void {
    this.renderComponent?.unload();
    this.renderComponent = new Component();
    this.renderComponent.load();
    const root = this.contentEl;
    root.empty();
    root.removeClass("mia-route-dashboard", "mia-route-progress", "mia-route-questions", "mia-route-weakness", "mia-route-keywords", "mia-route-study");
    root.addClass("mia-view");
    root.addClass(`mia-route-${this.route}`);
    this.renderHeader(root);
    if (this.route === "dashboard") this.renderDashboard(root);
    if (this.route === "progress") this.renderProgress(root);
    if (this.route === "questions") this.renderQuestions(root);
    if (this.route === "weakness") this.renderWeakness(root);
    if (this.route === "keywords") this.renderKeywords(root);
    if (this.route === "study") this.renderStudy(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "mia-header" });
    const title = header.createDiv();
    title.createEl("h2", { text: "MIA Study" });
    title.createEl("span", { text: "FSRS-6", cls: "mia-badge" });
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
    const questions = this.plugin.index.registered;
    const progress = calculateProgress(questions, this.plugin.store.reviews, this.plugin.fsrs);
    const due = progress.due;
    const fresh = progress.new;
    const grid = root.createDiv({ cls: "mia-stats" });
    this.progressStat(grid, "등록 문제", questions.length, "all");
    const stableRatio = progress.total ? Math.round((progress.stable / progress.total) * 100) : 0;
    const stable = grid.createEl("button", { cls: "mia-stat mia-progress-stat mia-stability-stat" });
    stable.style.setProperty("--mia-stable-ratio", `${stableRatio * 3.6}deg`);
    stable.createEl("strong", { text: `${stableRatio}%` });
    stable.createEl("span", { text: "기억 안정 비율" });
    stable.addEventListener("click", () => this.showQuestions("stable"));
    this.progressStat(grid, "완전 암기", progress.easy, "easy");
    this.progressStat(grid, "오늘 평가", progress.today, "today");
    this.progressStat(grid, "오늘 복습", due, "due");
    this.progressStat(grid, "개선 필요", progress.again + progress.hard, "weak");
    const manage = root.createDiv({ cls: "mia-manage-actions" });
    manage.createEl("button", { text: "과목 추가" }).addEventListener("click", () => this.plugin.openSubjectEditor());
    manage.createEl("button", { text: "질문 추가", cls: "mod-cta" }).addEventListener("click", () => void this.plugin.openManagedQuestionEditor());
    manage.createEl("button", { text: "키워드 추가" }).addEventListener("click", () => this.plugin.openKeywordEditor());
    const action = root.createDiv({ cls: "mia-primary-card" });
    action.createEl("h3", { text: due + fresh > 0 ? "오늘 학습을 시작할까요?" : "오늘 예정된 복습이 없습니다" });
    action.createEl("p", { text: `복습 ${due}개 · 새 문제 ${fresh}개 · 학습 상한 없음` });
    const actions = action.createDiv({ cls: "mia-inline-actions" });
    const start = actions.createEl("button", { text: "시험 모드 시작", cls: "mod-cta" });
    start.disabled = questions.length === 0;
    start.addEventListener("click", () => this.startReview());
    const browse = actions.createEl("button", { text: "전체 암기 모드" });
    browse.disabled = questions.length === 0;
    browse.addEventListener("click", () => this.startReview(questions.map((question) => question.id), "browse"));
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
        const reviewIds = buildReviewQueue(items, this.plugin.store.reviews, this.plugin.fsrs).map((question) => question.id);
        const review = subjectActions.createEl("button", { text: "시험" });
        review.disabled = reviewIds.length === 0;
        review.addEventListener("click", () => this.startReview(reviewIds));
        const memorize = subjectActions.createEl("button", { text: "암기" });
        memorize.disabled = items.length === 0;
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
      const reviewIds = buildReviewQueue(subjectQuestions, this.plugin.store.reviews, this.plugin.fsrs)
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
    const search = toolbar.createEl("input", { type: "search", placeholder: "질문, 정답, 과목, 키워드 검색" });
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
    const keyword = toolbar.createEl("input", { type: "search", placeholder: "키워드만 필터" });
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
      if (!questions.length) list.createEl("p", { text: "등록된 문제가 없습니다.", cls: "mia-empty" });
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
      const candidateSearch = details.createEl("input", { type: "search", placeholder: "등록 후보 검색", cls: "mia-candidate-search" });
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
          label.createEl("strong", { text: question.heading });
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

  private renderQuestionRow(parent: HTMLElement, question: QuestionRecord & { id: string }): void {
    const row = parent.createDiv({ cls: "mia-row" });
    const body = row.createDiv({ cls: "mia-row-body" });
    body.createEl("strong", { text: question.heading });
    const prompt = body.createDiv({ cls: "mia-row-prompt mia-markdown" });
    void MarkdownRenderer.render(this.app, question.questionMarkdown, prompt, question.filePath, this.renderComponent ?? this);
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
    const search = toolbar.createEl("input", { type: "search", placeholder: "취약 문제 검색" });
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
        body.createEl("strong", { text: question.heading });
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
    const search = toolbar.createEl("input", { type: "search", placeholder: "키워드 검색" });
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
            const questionButton = details.createEl("button", { text: question.heading });
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
    let id = this.queue[this.queueIndex];
    let question = id ? this.plugin.index.questionById(id) : undefined;
    while (!question && this.queueIndex < this.queue.length) {
      this.queueIndex += 1;
      id = this.queue[this.queueIndex];
      question = id ? this.plugin.index.questionById(id) : undefined;
    }
    if (!question || !question.id) {
      const result = this.studyResult();
      const done = root.createDiv({ cls: "mia-primary-card" });
      done.createEl("h3", { text: this.queue.length ? "학습 완료" : "학습할 문제가 없습니다" });
      done.createEl("p", { text: this.queue.length
        ? `${this.queue.length}문제 · 못 암기 ${result.again} · 애매 ${result.hard} · 암기 ${result.good} · 너무 쉬움 ${result.easy} · 건너뜀 ${result.skipped}`
        : "문제를 등록하거나 다음 복습 시각에 다시 확인하세요." });
      if (this.lastRated) {
        done.createEl("button", { text: "직전 평가 취소" }).addEventListener("click", () => void this.undoLastRating());
      }
      if (this.queue.length) {
        done.createEl("button", { text: "같은 범위 다시 학습", cls: "mod-cta" }).addEventListener("click", () => this.restartSession());
      }
      done.createEl("button", { text: "시작 화면으로 돌아가기" }).addEventListener("click", () => this.returnToSessionOrigin());
      if (this.queue.length && !this.resultShown) {
        this.resultShown = true;
        window.setTimeout(() => new StudyResultModal(
          this.app,
          result,
          () => this.restartSession(),
          () => this.returnToSessionOrigin(),
        ).open(), 0);
      }
      return;
    }
    const navigation = root.createDiv({ cls: "mia-study-navigation" });
    const previous = navigation.createEl("button", { text: "← 이전 문제" });
    previous.disabled = this.queueIndex === 0;
    previous.addEventListener("click", () => this.moveToQuestion(this.queueIndex - 1));
    navigation.createEl("div", { text: `${this.sessionMode === "recall" ? "시험 모드" : "암기 모드"} · ${this.queueIndex + 1} / ${this.queue.length} · ${question.subject} · ${question.questionType}`, cls: "mia-progress" });
    const next = navigation.createEl("button", { text: "다음 문제 →" });
    next.addEventListener("click", () => {
      if (!this.sessionGrades.has(question.id)) this.sessionSkipped.add(question.id);
      this.moveToQuestion(this.queueIndex + 1);
    });
    if (this.lastRated) {
      const undo = root.createEl("button", { text: "직전 평가 취소", cls: "mia-undo" });
      undo.addEventListener("click", () => void this.undoLastRating());
    }
    const card = root.createDiv({ cls: "mia-study-card" });
    card.createEl("h2", { text: question.heading });
    const sessionGrade = this.sessionGrades.get(question.id);
    if (sessionGrade) card.createEl("p", { text: `이번 학습 평가: ${GRADE_LABELS[sessionGrade]} · 다른 평가를 누르면 기존 기록을 대체합니다.`, cls: "mia-session-rating" });
    const prompt = card.createDiv({ cls: "mia-markdown" });
    void MarkdownRenderer.render(this.app, question.questionMarkdown, prompt, question.filePath, this.renderComponent ?? this);
    if (!this.answerVisible) {
      const actions = card.createDiv({ cls: "mia-study-actions" });
      actions.createEl("button", { text: "정답 보기", cls: "mod-cta mia-reveal" }).addEventListener("click", () => { this.answerVisible = true; this.render(); });
      actions.createEl("button", { text: "건너뛰기" }).addEventListener("click", () => this.skipQuestion());
      return;
    }
    card.createEl("hr");
    const answer = card.createDiv({ cls: "mia-markdown mia-answer" });
    void MarkdownRenderer.render(this.app, question.answerMarkdown, answer, question.filePath, this.renderComponent ?? this);
    this.renderKeywordSection(card, "핵심 키워드", question.coreKeywords, question.filePath);
    this.renderKeywordSection(card, "보조 키워드", question.subKeywords, question.filePath);
    this.renderRatings(card, question);
    card.createEl("button", { text: "평가 없이 건너뛰기", cls: "mia-skip" }).addEventListener("click", () => this.skipQuestion());
    const recommendations = recommendQuestions(question, this.plugin.index.registered, this.plugin.store.reviews, this.plugin.fsrs);
    if (recommendations.length) {
      const related = root.createDiv({ cls: "mia-related" });
      related.createEl("h3", { text: "이어볼 문제" });
      for (const item of recommendations) {
        const button = related.createEl("button", { text: `${item.question.heading} — ${item.reasons.join(" · ")} · 시험에 추가` });
        button.disabled = !item.question.id || this.queue.includes(item.question.id);
        button.addEventListener("click", () => {
          if (!item.question.id || this.queue.includes(item.question.id)) return;
          this.queue.splice(this.queueIndex + 1, 0, item.question.id);
          this.sessionSeed = [...this.queue];
          new Notice("추천 문제를 현재 시험의 다음 순서에 추가했습니다.");
          this.render();
        });
      }
    }
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
    const id = this.queue[this.queueIndex];
    if (id && !this.sessionGrades.has(id)) this.sessionSkipped.add(id);
    this.queueIndex += 1;
    this.answerVisible = this.sessionMode === "browse";
    this.render();
  }

  private renderRatings(parent: HTMLElement, question: QuestionRecord & { id: string }): void {
    const ratings = parent.createDiv({ cls: "mia-ratings" });
    const buttons: HTMLButtonElement[] = [];
    const baseline = this.sessionBaselines.has(question.id)
      ? this.sessionBaselines.get(question.id)
      : this.plugin.store.getReview(question.id);
    for (const preview of this.plugin.fsrs.preview(baseline)) {
      const button = ratings.createEl("button");
      buttons.push(button);
      button.createEl("strong", { text: GRADE_LABELS[preview.grade] });
      button.createEl("small", { text: formatInterval(preview.due, preview.scheduledDays) });
      button.addEventListener("click", async () => {
        buttons.forEach((item) => { item.disabled = true; });
        const ratedIndex = this.queueIndex;
        this.isMutatingReview = true;
        try {
          if (!this.sessionBaselines.has(question.id)) {
            this.sessionBaselines.set(question.id, this.plugin.store.getReview(question.id));
          }
          const original = this.sessionBaselines.get(question.id);
          const state = this.plugin.fsrs.rate(original, preview.grade);
          await this.plugin.store.setReview(question.id, state);
          this.sessionGrades.set(question.id, preview.grade);
          this.sessionSkipped.delete(question.id);
          this.lastRated = { id: question.id, queueIndex: ratedIndex };
          this.queueIndex = ratedIndex + 1;
          this.answerVisible = this.sessionMode === "browse";
          this.isMutatingReview = false;
          this.render();
        } catch (error) {
          this.isMutatingReview = false;
          new Notice(`복습 기록 저장 실패: ${errorMessage(error)}`);
          buttons.forEach((item) => { item.disabled = false; });
        }
      });
    }
    parent.createEl("button", { text: "원문 열기", cls: "mia-source" }).addEventListener("click", () => this.plugin.openQuestion(question));
  }

  private async undoLastRating(): Promise<void> {
    const lastRated = this.lastRated;
    if (!lastRated) return;
    this.isMutatingReview = true;
    try {
      const baseline = this.sessionBaselines.get(lastRated.id);
      if (baseline) await this.plugin.store.setReview(lastRated.id, baseline);
      else await this.plugin.store.removeReview(lastRated.id);
      this.sessionBaselines.delete(lastRated.id);
      this.sessionGrades.delete(lastRated.id);
      this.sessionSkipped.delete(lastRated.id);
      this.queueIndex = lastRated.queueIndex;
      this.answerVisible = true;
      this.lastRated = null;
      this.resultShown = false;
      this.isMutatingReview = false;
      new Notice("직전 평가를 취소했습니다.");
      this.render();
    } catch (error) {
      this.isMutatingReview = false;
      new Notice(`평가 취소 저장 실패: ${errorMessage(error)}`);
    }
  }

  private moveToQuestion(index: number): void {
    this.queueIndex = Math.max(0, Math.min(index, this.queue.length));
    const id = this.queue[this.queueIndex];
    this.answerVisible = this.sessionMode === "browse" || Boolean(id && this.sessionGrades.has(id));
    this.render();
  }

  private studyResult(): StudyResult {
    const grades = [...this.sessionGrades.values()];
    return {
      total: this.queue.length,
      again: grades.filter((grade) => grade === Rating.Again).length,
      hard: grades.filter((grade) => grade === Rating.Hard).length,
      good: grades.filter((grade) => grade === Rating.Good).length,
      easy: grades.filter((grade) => grade === Rating.Easy).length,
      skipped: this.sessionSkipped.size,
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

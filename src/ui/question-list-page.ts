import { Component, Platform } from "obsidian";
import { QUESTION_TYPES, type QuestionType } from "../core/models";
import { type QuestionSort, type ReviewFilter, queryQuestions } from "../core/question-query";
import { openEditorWithNotice } from "./editor-notice";
import { errorMessage } from "./error-message";
import { QuestionDetailView, type RegisteredQuestion } from "./question-detail-view";
import { renderQuestionHeading, renderQuestionRow } from "./question-row";
import type { StudyPageContext } from "./study-page-context";

const QUESTION_PAGE_SIZE = 50;

/** Quick state filters above the list. They set the same review filter as the dropdown below. */
const STATUS_CHIPS: ReadonlyArray<{ review: ReviewFilter; label: string }> = [
  { review: "all", label: "전체" },
  { review: "due", label: "오늘 복습" },
  { review: "new", label: "학습 전" },
  { review: "weak", label: "▲ 취약" },
];

const WEAK_SORT_NOTE = "못 암기와 애매 문제를 복습 지연 시간까지 반영한 긴급도 순으로 표시합니다.";

/** Search, filter and paging choices; kept across visits to the page. */
export class QuestionListState {
  text = "";
  subject = "all";
  type: "all" | QuestionType = "all";
  review: ReviewFilter = "all";
  keyword = "";
  sort: QuestionSort = "review";
  page = 0;
  candidateLimit = 100;
  /** The question open in the side panel (wide panes only). */
  selectedId: string | null = null;
  /** The panel control last used, by its `data-action` (or "title"); kept across re-renders and dialogs. */
  panelFocus: string | null = null;
  /** The panel body's scroll position for the selected question; reset when the selection changes. */
  panelScroll: { id: string; top: number } | null = null;

  /** Opens the list on one review state; clears the other filters but keeps the page. */
  show(review: ReviewFilter, subject = "all"): void {
    this.text = "";
    this.keyword = "";
    this.type = "all";
    // Weak questions come most-urgent first, the order the former weak-question page used.
    this.sort = review === "weak" ? "weak" : "review";
    this.review = review;
    this.subject = subject;
    this.selectedId = null;
  }
}

export interface SessionEditTarget {
  id: string;
  /** Scroll to and focus the target on this render. */
  focus: boolean;
  returnToStudy(): void;
}

/**
 * The question library page. The editing target, when present, is the
 * question the learner opened for editing from an active session.
 */
export function renderQuestionsPage(ctx: StudyPageContext, scroller: HTMLElement, state: QuestionListState, editTarget: SessionEditTarget | null): void {
  // The list column and the detail side panel sit side by side on wide panes.
  const layout = scroller.createDiv({ cls: "mia-questions-layout" });
  const root = layout.createDiv({ cls: "mia-questions-main" });
  const panel = layout.createEl("aside", { cls: "mia-detail-panel", attr: { "aria-label": "문제 상세" } });
  if (editTarget) {
    const selected = root.createDiv({ cls: "mia-session-edit-target" });
    selected.dataset.questionId = editTarget.id;
    selected.setAttr("role", "region");
    selected.setAttr("aria-label", "학습 중인 원본 문제 편집");
    selected.createEl("p", { text: "현재 학습 문제 · 기존 검색·필터·정렬은 유지됩니다. 이 항목만 필터와 관계없이 표시합니다." });
    selected.createEl("button", { text: "진행 중인 학습으로 돌아가기" }).addEventListener("click", () => editTarget.returnToStudy());
    const current = ctx.plugin.index.questionById(editTarget.id);
    if (current) renderQuestionRow(ctx, selected, current);
    else selected.createEl("p", { text: "원본 문제를 찾을 수 없습니다. 삭제 또는 ID 충돌 여부를 확인하세요.", cls: "mia-warning" });
    selected.tabIndex = -1;
    if (editTarget.focus) {
      selected.scrollIntoView({ block: "start" });
      selected.focus({ preventScroll: true });
    }
  }
  const pageActions = root.createDiv({ cls: "mia-page-actions" });
  pageActions.createEl("button", { text: "질문 추가", cls: "mod-cta" }).addEventListener("click", () =>
    openEditorWithNotice("질문 추가", () => ctx.plugin.openManagedQuestionEditor()));
  const statusChips = root.createDiv({ cls: "mia-status-chips" });
  const filterPanel = root.createEl("details", { cls: "mia-filter-panel" });
  filterPanel.open = !Platform.isMobile;
  filterPanel.createEl("summary", { text: "검색·필터·정렬" });
  const toolbar = filterPanel.createDiv({ cls: "mia-toolbar mia-filter-toolbar" });
  const search = toolbar.createEl("input", { type: "search", placeholder: "질문, 정답, 과목, 키워드 검색", attr: { "aria-label": "질문 검색" } });
  search.value = state.text;
  const subject = toolbar.createEl("select", { attr: { "aria-label": "과목 필터" } });
  subject.createEl("option", { text: "전체 과목", value: "all" });
  const subjects = [...new Set([
    ...ctx.plugin.listSubjects(),
    ...ctx.plugin.index.registered.map((question) => question.subject),
  ])].sort((a, b) => a.localeCompare(b, "ko"));
  subjects.forEach((item) => subject.createEl("option", { text: item, value: item }));
  subject.value = state.subject;
  const type = toolbar.createEl("select", { attr: { "aria-label": "문제 유형 필터" } });
  type.createEl("option", { text: "전체 유형", value: "all" });
  QUESTION_TYPES.forEach((item) => type.createEl("option", { text: item, value: item }));
  type.value = state.type;
  const review = toolbar.createEl("select", { attr: { "aria-label": "복습 상태 필터" } });
  const reviewOptions: Array<[ReviewFilter, string]> = [
    ["all", "전체 상태"], ["due", "복습 예정"], ["new", "새 문제"],
    ["again", "못 암기"], ["hard", "애매"], ["good", "암기"], ["easy", "너무 쉬움"],
    ["weak", "취약 문제"], ["stable", "기억 안정"], ["today", "오늘 평가"],
  ];
  reviewOptions.forEach(([value, label]) => review.createEl("option", { text: label, value }));
  review.value = state.review;
  const keyword = toolbar.createEl("input", { type: "search", placeholder: "키워드만 필터", attr: { "aria-label": "키워드 필터" } });
  keyword.value = state.keyword;
  const sort = toolbar.createEl("select", { attr: { "aria-label": "정렬" } });
  const sortOptions: Array<[QuestionSort, string]> = [
    ["review", "복습 우선"], ["title", "문제명"], ["subject", "과목별"], ["type", "유형별"],
    ["created", "최근 생성"], ["updated", "최근 수정"], ["weak", "못 암기 우선"], ["ambiguous", "애매 우선"],
  ];
  sortOptions.forEach(([value, label]) => sort.createEl("option", { text: label, value }));
  sort.value = state.sort;

  const chips = root.createDiv({ cls: "mia-filter-chips" });
  const registered = ctx.plugin.index.registered;
  const countFor = (filter: ReviewFilter): number => filter === "all" ? registered.length
    : queryQuestions(registered, ctx.plugin.store.reviews, ctx.plugin.fsrs, { text: "", subject: "all", questionType: "all", review: filter, keyword: "", sort: "title" }).length;
  const chipCounts = new Map(STATUS_CHIPS.map(({ review: filter }) => [filter, countFor(filter)]));
  /** One rule for the chips and the dropdown: weak reads most-urgent first, leaving it restores the default order. */
  const applyReview = (filter: ReviewFilter) => {
    state.review = filter;
    if (filter === "weak") state.sort = "weak";
    else if (state.sort === "weak") state.sort = "review";
    review.value = filter;
    sort.value = state.sort;
  };
  const setReviewFilter = (filter: ReviewFilter) => {
    applyReview(filter);
    state.page = 0;
    renderList();
  };
  // Created once so a chip keeps keyboard focus (and its element) when the list re-renders.
  const statusChipButtons = STATUS_CHIPS.map(({ review: filter, label }) => {
    const chip = statusChips.createEl("button", { text: `${label} ${chipCounts.get(filter) ?? 0}`, cls: filter === "weak" ? "mia-chip-weak" : "" });
    chip.addEventListener("click", () => setReviewFilter(filter));
    return { filter, chip };
  });
  const renderStatusChips = () => {
    for (const { filter, chip } of statusChipButtons) chip.setAttr("aria-pressed", String(state.review === filter));
  };
  const weakNote = root.createEl("p", { cls: "mia-muted mia-weak-note" });
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
    if (state.text) active.push([`검색: ${state.text}`, () => { state.text = ""; search.value = ""; }]);
    if (state.subject !== "all") active.push([`과목: ${state.subject}`, () => { state.subject = "all"; subject.value = "all"; }]);
    if (state.type !== "all") active.push([`유형: ${state.type}`, () => { state.type = "all"; type.value = "all"; }]);
    if (state.review !== "all") active.push([`상태: ${reviewOptions.find(([value]) => value === state.review)?.[1] ?? state.review}`, () => applyReview("all")]);
    if (state.keyword) active.push([`키워드: ${state.keyword}`, () => { state.keyword = ""; keyword.value = ""; }]);
    for (const [label, clear] of active) {
      const chip = chips.createEl("button", { text: `${label} ×` });
      chip.addEventListener("click", () => { clear(); state.page = 0; renderList(); (chips.querySelector<HTMLElement>("button") ?? search).focus({ preventScroll: true }); });
    }
    if (active.length > 1) {
      const reset = chips.createEl("button", { text: "필터 전체 해제", cls: "mod-warning" });
      reset.addEventListener("click", () => {
        state.text = ""; state.subject = "all"; state.type = "all";
        state.keyword = ""; state.page = 0;
        applyReview("all");
        search.value = ""; subject.value = "all"; type.value = "all"; keyword.value = "";
        renderList();
        search.focus({ preventScroll: true });
      });
    }
  };
  const listOwner = ctx.component;
  const fixedRenderCount = ctx.renders.length;
  let listComponent: Component | null = null;
  let panelComponent: Component | null = null;
  let panelRevision = 0;
  const markSelected = () => {
    for (const row of Array.from(list.children) as HTMLElement[]) {
      const selected = row.dataset.questionId === state.selectedId;
      row.toggleClass("mia-row-selected", selected);
      if (selected) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
    }
  };
  const clearPanel = () => {
    panelRevision += 1;
    if (panelComponent) listOwner.removeChild(panelComponent);
    panelComponent = null;
    panel.empty();
  };
  const panelButtons = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>("button"));
  const actionOf = (target: EventTarget | null): string | null => {
    const element = target as HTMLElement | null;
    if (!element || !panel.contains(element)) return null;
    return element.closest?.<HTMLElement>("button")?.dataset.action ?? "title";
  };
  /**
   * Puts focus back on the control last used, even after a re-render replaced it. A control that is
   * disabled now (a reset with nothing left to reset) hands focus to the nearest enabled one; the title is the fallback.
   */
  const restorePanelFocus = (title: HTMLElement) => {
    const wanted = state.panelFocus;
    if (wanted === null) return;
    // Never take focus from somewhere else: a dialog that is open, or an element outside this view (another pane's editor).
    const doc = panel.ownerDocument;
    const active = doc?.activeElement;
    if (doc?.querySelector?.(".modal-container")) return;
    if (active && active !== doc.body && !scroller.contains(active)) return;
    const buttons = panelButtons();
    // Still loading (no controls yet): the render that finishes will restore focus itself.
    if (!buttons.length) return;
    const target = buttons.find((button) => button.dataset.action === wanted);
    if (!target) { title.focus({ preventScroll: true }); return; }
    if (!(target as HTMLButtonElement).disabled) { target.focus({ preventScroll: true }); return; }
    const at = buttons.indexOf(target);
    const nearest = buttons.map((button, index) => ({ button, distance: Math.abs(index - at) }))
      .filter(({ button }) => !(button as HTMLButtonElement).disabled)
      .sort((left, right) => left.distance - right.distance)[0]?.button;
    (nearest ?? title).focus({ preventScroll: true });
  };
  const rememberFocus = (event: Event) => { const action = actionOf(event.target); if (action) state.panelFocus = action; };
  panel.addEventListener("focusin", rememberFocus);
  panel.addEventListener("pointerdown", rememberFocus);
  panel.addEventListener("scroll", (event: Event) => {
    const target = event.target as HTMLElement;
    if (state.selectedId && target.classList?.contains("mia-detail-scroll")) state.panelScroll = { id: state.selectedId, top: target.scrollTop };
  }, true);
  // On the page's own layout element (rebuilt every render), not the long-lived view root, so no stale listeners pile up.
  layout.addEventListener("focusin", (event: FocusEvent) => {
    if (!panel.contains(event.target as Node)) state.panelFocus = null;
  });
  /**
   * Obsidian's dialogs hand focus back to their opener when they close and the opener still exists. If the page was
   * re-rendered while a dialog was open (so the opener is gone), wait for that dialog to close, then restore once.
   */
  const restoreAfterDialog = (component: Component) => {
    const document = panel.ownerDocument;
    const view = document?.defaultView;
    if (!view?.MutationObserver || !document.querySelector(".modal-container")) return;
    const observer = new view.MutationObserver(() => {
      if (document.querySelector(".modal-container")) return;
      observer.disconnect();
      const title = panel.querySelector<HTMLElement>(".mia-detail-title");
      if (panel.isConnected && title) restorePanelFocus(title);
    });
    observer.observe(document.body, { childList: true });
    component.register?.(() => observer.disconnect());
  };
  /** Fills the side panel with the shared detail body; the same actions and reset confirmation as the dialog. */
  const showPanel = async (question: RegisteredQuestion): Promise<void> => {
    const revision = ++panelRevision;
    if (panelComponent) listOwner.removeChild(panelComponent);
    const component = listOwner.addChild(new Component());
    panelComponent = component;
    panel.empty();
    panel.createEl("p", { text: "상세를 불러오는 중입니다…", cls: "mia-muted" });
    try {
      const source = await ctx.plugin.questionDetailSource(question);
      if (revision !== panelRevision) return;
      panel.empty();
      const title = panel.createEl("h2", { cls: "mia-detail-title" });
      title.tabIndex = -1;
      const detail = new QuestionDetailView(ctx.app, source, {
        afterAction: () => {},
        // A saved rating or reset changes the store, which re-renders this page and rebuilds the panel
        // from `selectedId`; refetching here would run against the DOM that render is about to replace.
        afterMutation: () => {},
      }, ctx.plugin.modalOpenGuard);
      await detail.render(panel, title, component, () => revision === panelRevision);
      if (revision !== panelRevision) return;
      const body = panel.querySelector<HTMLElement>(".mia-detail-scroll");
      if (body && state.panelScroll?.id === question.id) body.scrollTop = state.panelScroll.top;
      restorePanelFocus(title);
      restoreAfterDialog(component);
    } catch (error) {
      if (revision !== panelRevision) return;
      panel.empty();
      panel.createEl("p", { text: `상세를 열 수 없습니다: ${errorMessage(error)}`, cls: "mia-warning" });
    }
  };
  const showPanelPlaceholder = () => {
    clearPanel();
    panel.createEl("p", { text: "문제를 누르면 여기에 상세가 열립니다.", cls: "mia-detail-placeholder mia-muted" });
  };
  /** The stylesheet decides whether the panel is shown (wide pane, not a phone), so this follows it. */
  const panelVisible = (): boolean => !Platform.isPhone && panel.isConnected
    && panel.ownerDocument?.defaultView?.getComputedStyle(panel).display !== "none";
  /** Wide panes open the detail beside the list, moving focus to its title; narrow ones and phones keep the dialog. */
  const openDetail = (question: RegisteredQuestion): void => {
    if (!panelVisible()) { void ctx.plugin.openQuestionDetail(question); return; }
    state.panelFocus = "title";
    if (state.selectedId !== question.id) state.panelScroll = null;
    state.selectedId = question.id;
    markSelected();
    void showPanel(question);
  };
  const renderList = () => {
    // Results own their Markdown resources; replacing a page must release the old ones.
    if (listComponent) listOwner.removeChild(listComponent);
    listComponent = listOwner.addChild(new Component());
    ctx.renders.length = fixedRenderCount;
    list.empty();
    pagination.empty();
    const questions = queryQuestions(ctx.plugin.index.registered, ctx.plugin.store.reviews, ctx.plugin.fsrs, {
      text: state.text,
      subject: state.subject,
      questionType: state.type,
      review: state.review,
      keyword: state.keyword,
      sort: state.sort,
    });
    resultCount.setText(`${questions.length}개`);
    renderStatusChips();
    weakNote.setText(state.review === "weak" && state.sort === "weak" ? WEAK_SORT_NOTE : "");
    testResults.disabled = questions.length === 0;
    browseResults.disabled = questions.length === 0;
    testResults.onclick = () => ctx.startReview(questions.map((question) => question.id));
    browseResults.onclick = () => ctx.startReview(questions.map((question) => question.id), "browse");
    const pageCount = Math.max(1, Math.ceil(questions.length / QUESTION_PAGE_SIZE));
    state.page = Math.min(state.page, pageCount - 1);
    const visible = questions.slice(state.page * QUESTION_PAGE_SIZE, (state.page + 1) * QUESTION_PAGE_SIZE);
    for (const question of visible) {
      renderQuestionRow(ctx, list, question, listComponent, { openDetail, selected: question.id === state.selectedId, showWeakness: state.review === "weak" });
    }
    if (pageCount > 1) {
      const previous = pagination.createEl("button", { text: `이전 ${QUESTION_PAGE_SIZE}개` });
      previous.disabled = state.page === 0;
      previous.addEventListener("click", () => { state.page -= 1; renderList(); scroller.scrollTo({ top: 0, behavior: "smooth" }); pagination.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true }); });
      pagination.createSpan({ text: `${state.page + 1} / ${pageCount}` });
      const next = pagination.createEl("button", { text: `다음 ${QUESTION_PAGE_SIZE}개` });
      next.disabled = state.page >= pageCount - 1;
      next.addEventListener("click", () => { state.page += 1; renderList(); scroller.scrollTo({ top: 0, behavior: "smooth" }); pagination.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true }); });
    }
    if (!questions.length) list.createEl("p", {
      text: ctx.plugin.index.registered.length ? "검색·필터 조건에 맞는 문제가 없습니다." : "등록된 문제가 없습니다.",
      cls: "mia-empty",
    });
    renderChips();
  };
  let searchComposing = false;
  let keywordComposing = false;
  search.addEventListener("compositionstart", () => { searchComposing = true; });
  search.addEventListener("compositionend", () => { searchComposing = false; state.text = search.value; state.page = 0; renderList(); });
  search.addEventListener("input", () => { if (!searchComposing) { state.text = search.value; state.page = 0; renderList(); } });
  keyword.addEventListener("compositionstart", () => { keywordComposing = true; });
  keyword.addEventListener("compositionend", () => { keywordComposing = false; state.keyword = keyword.value; state.page = 0; renderList(); });
  keyword.addEventListener("input", () => { if (!keywordComposing) { state.keyword = keyword.value; state.page = 0; renderList(); } });
  subject.addEventListener("change", () => { state.subject = subject.value; state.page = 0; renderList(); });
  type.addEventListener("change", () => { state.type = type.value as QuestionListState["type"]; state.page = 0; renderList(); });
  review.addEventListener("change", () => setReviewFilter(review.value as ReviewFilter));
  sort.addEventListener("change", () => { state.sort = sort.value as QuestionSort; state.page = 0; renderList(); });
  renderList();
  const selected = state.selectedId ? ctx.plugin.index.questionById(state.selectedId) : undefined;
  if (selected) void showPanel(selected);
  else { state.selectedId = null; showPanelPlaceholder(); }

  const diagnostics = ctx.plugin.index.diagnostics;
  if (diagnostics.length) {
    const details = root.createEl("details", { cls: "mia-candidates" });
    details.createEl("summary", { text: `검사 필요 ${diagnostics.length}건` });
    for (const diagnostic of diagnostics) {
      const row = details.createDiv({ cls: "mia-candidate" });
      row.createSpan({ text: `${diagnostic.message} · ${diagnostic.filePath}:${diagnostic.line + 1}` });
      row.createEl("button", { text: "원문" }).addEventListener("click", () => {
        void ctx.plugin.openLocation(diagnostic.filePath, diagnostic.line);
      });
    }
  }
  if (ctx.plugin.index.candidates.length) {
    const details = root.createEl("details", { cls: "mia-candidates" });
    details.createEl("summary", { text: `등록하지 않은 문제 후보 ${ctx.plugin.index.candidates.length}개` });
    const candidateSearch = details.createEl("input", { type: "search", placeholder: "등록 후보 검색", attr: { "aria-label": "등록 후보 검색" }, cls: "mia-candidate-search" });
    const candidateList = details.createDiv();
    const renderCandidates = () => {
      candidateList.empty();
      const candidateQuery = candidateSearch.value.trim().toLocaleLowerCase("ko");
      const matches = ctx.plugin.index.candidates.filter((question) =>
        !candidateQuery || [question.heading, question.questionMarkdown, question.filePath]
          .join("\n").toLocaleLowerCase("ko").includes(candidateQuery),
      );
      for (const question of matches.slice(0, state.candidateLimit)) {
        const row = candidateList.createDiv({ cls: "mia-candidate" });
        const label = row.createDiv({ cls: "mia-candidate-label" });
        renderQuestionHeading(ctx, label.createEl("strong"), question);
        label.createEl("small", { text: question.filePath });
        const candidateActions = row.createDiv({ cls: "mia-inline-actions" });
        candidateActions.createEl("button", { text: "등록" }).addEventListener("click", () => ctx.plugin.editMetadata(question));
        candidateActions.createEl("button", { text: "원문" }).addEventListener("click", () => void ctx.plugin.openQuestion(question));
      }
      if (matches.length > state.candidateLimit) {
        const more = candidateList.createEl("button", { text: `${Math.min(100, matches.length - state.candidateLimit)}개 더 보기`, cls: "mia-load-more" });
        more.addEventListener("click", () => { state.candidateLimit += 100; renderCandidates(); });
      }
      if (!matches.length) candidateList.createEl("p", { text: "검색 조건에 맞는 후보가 없습니다.", cls: "mia-empty" });
    };
    candidateSearch.addEventListener("input", () => { state.candidateLimit = 100; renderCandidates(); });
    renderCandidates();
  }
}

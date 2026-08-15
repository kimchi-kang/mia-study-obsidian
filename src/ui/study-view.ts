import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import { Rating } from "ts-fsrs";
import type MiaStudyPlugin from "../main";
import { StudyGrade } from "../core/fsrs-service";
import { QUESTION_TYPES, KeywordReference, QuestionRecord } from "../core/models";
import { QuestionSort, ReviewFilter, queryQuestions } from "../core/question-query";
import { buildReviewQueue, recommendQuestions } from "../core/recommendation-engine";
import { errorMessage } from "./error-message";

export const MIA_VIEW_TYPE = "mia-study-view";
type Route = "dashboard" | "questions" | "keywords" | "study";
type SessionMode = "recall" | "browse";

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
  private route: Route = "dashboard";
  private queue: string[] = [];
  private queueIndex = 0;
  private answerVisible = false;
  private sessionMode: SessionMode = "recall";
  private lastRated: { id: string; queueIndex: number } | null = null;
  private isMutatingReview = false;
  private questionText = "";
  private questionSubject = "all";
  private questionType: "all" | QuestionRecord["questionType"] = "all";
  private questionReview: ReviewFilter = "all";
  private questionKeyword = "";
  private questionSort: QuestionSort = "review";
  private candidateLimit = 100;
  private renderComponent: Component | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MiaStudyPlugin) {
    super(leaf);
  }

  getViewType(): string { return MIA_VIEW_TYPE; }
  getDisplayText(): string { return "MIA Study"; }
  getIcon(): string { return "brain-circuit"; }

  async onOpen(): Promise<void> {
    this.unsubscribers = [
      this.plugin.index.subscribe(() => this.render()),
      this.plugin.store.subscribe(() => { if (!this.isMutatingReview) this.render(); }),
    ];
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.renderComponent?.unload();
  }

  showDashboard(): void {
    this.route = "dashboard";
    this.render();
  }

  startReview(questionIds?: string[], mode: SessionMode = "recall"): void {
    const questions = this.plugin.index.registered;
    const validIds = new Set(questions.map((question) => question.id));
    const requested = questionIds ?? buildReviewQueue(questions, this.plugin.store.reviews, this.plugin.fsrs)
      .map((question) => question.id);
    this.queue = [...new Set(requested.filter((id) => validIds.has(id)))];
    this.queueIndex = 0;
    this.sessionMode = mode;
    this.answerVisible = mode === "browse";
    this.lastRated = null;
    this.route = "study";
    this.render();
  }

  private render(): void {
    this.renderComponent?.unload();
    this.renderComponent = new Component();
    this.renderComponent.load();
    const root = this.contentEl;
    root.empty();
    root.addClass("mia-view");
    this.renderHeader(root);
    if (this.route === "dashboard") this.renderDashboard(root);
    if (this.route === "questions") this.renderQuestions(root);
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
    this.navButton(nav, "문제", "questions");
    this.navButton(nav, "키워드", "keywords");
  }

  private navButton(parent: HTMLElement, label: string, route: Route): void {
    const button = parent.createEl("button", { text: label, cls: this.route === route ? "mod-cta" : "" });
    button.addEventListener("click", () => { this.route = route; this.render(); });
  }

  private renderDashboard(root: HTMLElement): void {
    const questions = this.plugin.index.registered;
    const due = questions.filter((question) => this.plugin.fsrs.isDue(this.plugin.store.getReview(question.id))).length;
    const fresh = questions.filter((question) => this.plugin.fsrs.isNew(this.plugin.store.getReview(question.id))).length;
    const grid = root.createDiv({ cls: "mia-stats" });
    this.stat(grid, "등록 문제", questions.length);
    this.stat(grid, "오늘 복습", due);
    this.stat(grid, "새 문제", fresh);
    this.stat(grid, "등록 후보", this.plugin.index.candidates.length);
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
      }
    }
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
    const toolbar = root.createDiv({ cls: "mia-toolbar mia-filter-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "질문, 정답, 과목, 키워드 검색" });
    search.value = this.questionText;
    const subject = toolbar.createEl("select", { attr: { "aria-label": "과목 필터" } });
    subject.createEl("option", { text: "전체 과목", value: "all" });
    const subjects = [...new Set(this.plugin.index.registered.map((question) => question.subject))].sort((a, b) => a.localeCompare(b, "ko"));
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
    ];
    reviewOptions.forEach(([value, label]) => review.createEl("option", { text: label, value }));
    review.value = this.questionReview;
    const keyword = toolbar.createEl("input", { type: "search", placeholder: "키워드만 필터" });
    keyword.value = this.questionKeyword;
    const sort = toolbar.createEl("select", { attr: { "aria-label": "정렬" } });
    const sortOptions: Array<[QuestionSort, string]> = [
      ["review", "복습 우선"], ["title", "문제명"], ["subject", "과목별"], ["type", "유형별"],
    ];
    sortOptions.forEach(([value, label]) => sort.createEl("option", { text: label, value }));
    sort.value = this.questionSort;

    const resultBar = root.createDiv({ cls: "mia-result-bar" });
    const resultCount = resultBar.createSpan();
    const resultActions = resultBar.createDiv({ cls: "mia-inline-actions" });
    const testResults = resultActions.createEl("button", { text: "검색 결과 시험" });
    const browseResults = resultActions.createEl("button", { text: "검색 결과 암기" });
    const list = root.createDiv({ cls: "mia-list" });
    const renderList = () => {
      list.empty();
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
      for (const question of questions) this.renderQuestionRow(list, question);
      if (!questions.length) list.createEl("p", { text: "등록된 문제가 없습니다.", cls: "mia-empty" });
    };
    search.addEventListener("input", () => { this.questionText = search.value; renderList(); });
    subject.addEventListener("change", () => { this.questionSubject = subject.value; renderList(); });
    type.addEventListener("change", () => { this.questionType = type.value as typeof this.questionType; renderList(); });
    review.addEventListener("change", () => { this.questionReview = review.value as ReviewFilter; renderList(); });
    keyword.addEventListener("input", () => { this.questionKeyword = keyword.value; renderList(); });
    sort.addEventListener("change", () => { this.questionSort = sort.value as QuestionSort; renderList(); });
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
    actions.createEl("button", { text: "편집" }).addEventListener("click", () => void this.plugin.openManagedQuestionEditor(question));
    actions.createEl("button", { text: "원문" }).addEventListener("click", () => this.plugin.openQuestion(question));
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
        const card = grid.createDiv({ cls: "mia-keyword" });
        card.createEl("strong", { text: item.keyword.label });
        card.createEl("span", { text: `${questions.length}문제` });
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
      }
      if (!items.length) grid.createEl("p", {
        text: keywords.size ? "검색 조건에 맞는 키워드가 없습니다." : "키워드를 추가하거나 질문에 핵심/보조 키워드를 연결하면 여기에 나타납니다.",
        cls: "mia-empty",
      });
    };
    search.addEventListener("input", renderGrid);
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
      const done = root.createDiv({ cls: "mia-primary-card" });
      done.createEl("h3", { text: this.queue.length ? "학습 완료" : "학습할 문제가 없습니다" });
      done.createEl("p", { text: this.queue.length ? `${this.queue.length}문제를 확인했습니다.` : "문제를 등록하거나 다음 복습 시각에 다시 확인하세요." });
      if (this.lastRated) {
        done.createEl("button", { text: "직전 평가 취소" }).addEventListener("click", () => void this.undoLastRating());
      }
      done.createEl("button", { text: "대시보드로" }).addEventListener("click", () => this.showDashboard());
      return;
    }
    root.createEl("div", { text: `${this.sessionMode === "recall" ? "시험 모드" : "암기 모드"} · ${this.queueIndex + 1} / ${this.queue.length} · ${question.subject} · ${question.questionType}`, cls: "mia-progress" });
    if (this.lastRated) {
      const undo = root.createEl("button", { text: "직전 평가 취소", cls: "mia-undo" });
      undo.addEventListener("click", () => void this.undoLastRating());
    }
    const card = root.createDiv({ cls: "mia-study-card" });
    card.createEl("h2", { text: question.heading });
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
        const button = related.createEl("button", { text: `${item.question.heading} — ${item.reasons.join(" · ")}` });
        button.addEventListener("click", () => item.question.id && this.startReview([item.question.id]));
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
    this.queueIndex += 1;
    this.answerVisible = this.sessionMode === "browse";
    this.render();
  }

  private renderRatings(parent: HTMLElement, question: QuestionRecord & { id: string }): void {
    const ratings = parent.createDiv({ cls: "mia-ratings" });
    const buttons: HTMLButtonElement[] = [];
    for (const preview of this.plugin.fsrs.preview(this.plugin.store.getReview(question.id))) {
      const button = ratings.createEl("button");
      buttons.push(button);
      button.createEl("strong", { text: GRADE_LABELS[preview.grade] });
      button.createEl("small", { text: formatInterval(preview.due, preview.scheduledDays) });
      button.addEventListener("click", async () => {
        buttons.forEach((item) => { item.disabled = true; });
        const ratedIndex = this.queueIndex;
        this.isMutatingReview = true;
        try {
          const state = this.plugin.fsrs.rate(this.plugin.store.getReview(question.id), preview.grade);
          await this.plugin.store.setReview(question.id, state);
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
      const current = this.plugin.store.getReview(lastRated.id);
      const previous = current ? this.plugin.fsrs.undo(current) : null;
      if (previous?.history.length) await this.plugin.store.setReview(lastRated.id, previous);
      else await this.plugin.store.removeReview(lastRated.id);
      this.queueIndex = lastRated.queueIndex;
      this.answerVisible = true;
      this.lastRated = null;
      this.isMutatingReview = false;
      new Notice("직전 평가를 취소했습니다.");
      this.render();
    } catch (error) {
      this.isMutatingReview = false;
      new Notice(`평가 취소 저장 실패: ${errorMessage(error)}`);
    }
  }
}

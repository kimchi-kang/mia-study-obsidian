import { Modal, Notice } from "obsidian";
import { calculateProgress, type ProgressCounts } from "../core/progress";
import type { QuestionRecord } from "../core/models";
import { queryQuestions, type ReviewFilter } from "../core/question-query";
import { buildReviewQueue, type ReviewQueueOptions } from "../core/recommendation-engine";
import { dailyStudyCounts, studyDayStart } from "../core/study-management";
import { summarizeStudyHistory, type StudyHistory } from "../core/study-history";
import { errorMessage } from "./error-message";
import { openEditorWithNotice } from "./editor-notice";
import { renderQuestionHeading } from "./question-row";
import { ReviewConflictModal } from "./review-conflict-modal";
import { SettingsConflictModal } from "./settings-conflict-modal";
import type { StudyPageContext } from "./study-page-context";
import { progressGuidance } from "./study-policy";
import { dialogKey } from "./modal-open-guard";
import { forecastReviews, type TargetDateSummary } from "../core/target-dates";
import { readTargetDates, renderReviewForecast, renderTargetDates, renderUpcomingTarget, targetRecallLabel } from "./target-date-panels";
import { renderStudyHistory } from "./study-history-panel";
import { renderCardManagementMenu } from "./card-management-menu";

// The dashboard and progress pages: counts, start buttons and per-subject cards.

const MAX_LISTED_DUPLICATE_FILES = 8;

type RegisteredQuestion = QuestionRecord & { id: string };
type OverviewRoute = "dashboard" | "progress";

function reviewQueue(ctx: StudyPageContext, questions: RegisteredQuestion[], now = new Date(), dailyCounts?: ReviewQueueOptions["dailyCounts"]) {
  return buildReviewQueue(questions, ctx.plugin.store.reviews, ctx.plugin.fsrs, {
    management: ctx.plugin.store.settings.studyManagement, now,
    ...(dailyCounts ? { dailyCounts } : {}),
  });
}

function subjectQuestions(ctx: StudyPageContext, subject: string): RegisteredQuestion[] {
  return ctx.plugin.index.registered.filter(question => question.subject === subject);
}

export function readOverview(ctx: StudyPageContext, route: OverviewRoute): OverviewSnapshot {
  const { store, index, fsrs, studyUi } = ctx.plugin;
  const now = new Date();
  const questions = index.registered;
  const dayStartsAt = store.settings.studyManagement.dayStartsAt;
  const dailyCounts = dailyStudyCounts(store.reviews, store.settings.studyManagement, now);
  const day = studyDayStart(now, dayStartsAt).getTime();
  const { bySubject, ...counts } = calculateProgress(questions, store.reviews, fsrs, now);
  const subjects = new Map(ctx.plugin.listSubjects().map(subject => [subject, [] as RegisteredQuestion[]]));
  for (const question of questions) {
    const items = subjects.get(question.subject) ?? [];
    items.push(question);
    subjects.set(question.subject, items);
  }
  const byName = new Map(bySubject.map(({ subject, counts }) => [subject, counts]));
  const cards = [...subjects].sort(([a], [b]) => a.localeCompare(b, "ko")).map(([subject, items]) => {
    const stats = byName.get(subject);
    return { subject, total: stats?.total ?? 0, studied: stats?.studied ?? 0, fresh: stats?.new ?? 0,
      due: stats?.due ?? 0, again: stats?.again ?? 0, hard: stats?.hard ?? 0, good: stats?.good ?? 0, easy: stats?.easy ?? 0,
      canStart: reviewQueue(ctx, items, now, dailyCounts).length > 0 };
  });
  const common = { dayStartsAt, day, reviewConflictCount: Object.keys(store.conflicts ?? {}).length };
  if (route === "progress") return {
    ...common, counts, cards, targets: readTargetDates(ctx, now, false, questions),
    history: summarizeStudyHistory(store.reviews, dayStartsAt, now),
    forecast: forecastReviews(questions, store.reviews, fsrs, dayStartsAt, now), retention: store.settings.targetRetention,
  };
  const available = reviewQueue(ctx, questions, now, dailyCounts);
  const availableNew = available.filter(question => fsrs.isNew(store.getReview(question.id))).length;
  const saved = studyUi.resume;
  const current = saved ? index.questionById(saved.queue[saved.queueIndex] ?? saved.seed[0] ?? "") : undefined;
  const crossFileDuplicates = index.crossFileDuplicates;
  return {
    ...common, target: readTargetDates(ctx, now, true, questions)[0] ?? null, streak: summarizeStudyHistory(store.reviews, dayStartsAt, now).streak, total: counts.total, due: counts.due, fresh: counts.new, easy: counts.easy, today: counts.today,
    stableRatio: counts.total ? Math.round(counts.stable / counts.total * 100) : 0,
    weak: counts.again + counts.hard, availableNew, availableDue: available.length - availableNew,
    // 오늘 할 일이 있는 과목이 위로 오게 복습 많은 순으로 두고, 같으면 기존 이름순을 지킨다(안정 정렬).
    cards: cards.map(({ again, hard, good, easy, ...card }) => ({ ...card, weak: again + hard })).sort((a, b) => b.due - a.due),
    resume: saved ? { current: current ? { heading: current.heading, filePath: current.filePath, subject: current.subject } : undefined,
      mode: saved.sessionMode, position: Math.min(saved.queueIndex + 1, saved.queue.length), length: saved.queue.length,
      waiting: saved.queueIndex >= saved.queue.length && saved.sessionMode === "recall", updatedAt: saved.updatedAt } : null,
    pending: store.hasPendingRecovery, settingsConflicts: store.settingsConflicts?.length ?? 0,
    duplicateFiles: crossFileDuplicates?.files.length ? {
      hiddenQuestions: crossFileDuplicates.hiddenQuestions, count: crossFileDuplicates.files.length,
      paths: crossFileDuplicates.files.slice(0, MAX_LISTED_DUPLICATE_FILES).map(file => file.filePath),
    } : null,
    hasCandidates: !counts.total && index.candidates.length > 0, diagnostics: index.diagnostics.length,
  };
}

type OverviewCommon = { dayStartsAt: number; day: number; reviewConflictCount: number };
type SubjectCard = { subject: string; total: number; studied: number; fresh: number; due: number; canStart: boolean };
type ProgressOverview = OverviewCommon & {
  targets: TargetDateSummary[];
  history: StudyHistory;
  forecast: ReturnType<typeof forecastReviews>;
  retention: number;
  counts: ProgressCounts;
  cards: Array<SubjectCard & { again: number; hard: number; good: number; easy: number }>;
};
type DashboardOverview = OverviewCommon & {
  target: TargetDateSummary | null;
  streak: number;
  total: number; due: number; fresh: number; easy: number; today: number; stableRatio: number; weak: number;
  availableNew: number; availableDue: number;
  cards: Array<SubjectCard & { weak: number }>;
  resume: { current: Pick<QuestionRecord, "heading" | "filePath" | "subject"> | undefined; mode: string;
    position: number; length: number; waiting: boolean; updatedAt: string } | null;
  pending: boolean; settingsConflicts: number;
  duplicateFiles: { hiddenQuestions: number; count: number; paths: string[] } | null;
  hasCandidates: boolean; diagnostics: number;
};

export type OverviewSnapshot = DashboardOverview | ProgressOverview;

export function overviewSignature(route: OverviewRoute, snapshot: OverviewSnapshot | null): string {
  if (!snapshot) return JSON.stringify([route, null]);
  if ("targets" in snapshot) {
    const { targets, retention, ...rest } = snapshot;
    return JSON.stringify([route, rest, targets.length ? Math.round(retention * 100) : null, targets.map(
      ({ target, daysUntil, total, unstudied, averageRecall, risks }) =>
        [target, Math.max(-1, daysUntil), total, unstudied, targetRecallLabel(averageRecall), risks.length],
    )]);
  }
  const { target, ...rest } = snapshot;
  return JSON.stringify([route, rest, target && [target.target.label, target.daysUntil, target.risks.length]]);
}

/** Explains why questions vanished when a sync app left a copy of a question file. */
function renderDuplicateFileWarning(root: HTMLElement, duplicates: DashboardOverview["duplicateFiles"]): void {
  if (!duplicates) return;
  const card = root.createDiv({ cls: "mia-primary-card" });
  card.createEl("p", { text: `같은 문제가 둘 이상의 파일에 들어 있어 문제 ${duplicates.hiddenQuestions}개가 목록과 학습에서 숨겨져 있습니다.`, cls: "mia-warning" });
  card.createEl("p", { text: "동기화 앱이 파일의 사본을 만들었을 때 흔히 생깁니다. 학습 기록은 그대로 보관되어 있으며, 불필요한 사본 파일을 삭제하거나 문제 폴더 밖으로 옮기면 문제가 다시 나타납니다.", cls: "mia-muted" });
  const list = card.createEl("ul");
  for (const path of duplicates.paths) list.createEl("li", { text: path });
  const more = duplicates.count - duplicates.paths.length;
  if (more > 0) card.createEl("p", { text: `외 ${more}개 파일`, cls: "mia-muted" });
}

function renderReviewConflictWarning(ctx: StudyPageContext, root: HTMLElement, count: number): void {
  if (count) {
    const warning = root.createDiv({ cls: "mia-sync-warning" });
    warning.createEl("p", { text: `기기 간 평가가 달랐던 문제 ${count}개 · 이전 이력도 보관했습니다.` });
    warning.createEl("button", { text: "보관된 평가 확인" }).addEventListener("click", () => ctx.plugin.modalOpenGuard.open(dialogKey("review-conflicts"), () => new ReviewConflictModal(ctx.app, ctx.plugin.store.conflicts, id => ctx.plugin.index.questionById(id)?.heading ?? id,
      (expected, all) => ctx.plugin.store.dismissReviewConflicts(expected, all))));
  }
}

export function renderDashboard(ctx: StudyPageContext, root: HTMLElement, overview: DashboardOverview): void {
  if (overview.pending) {
    const warning = root.createDiv({ cls: "mia-storage-warning" });
    warning.createEl("p", { text: "완료를 확인하지 못한 저장 사본이 있습니다. 새 평가 전에 확인하세요." });
    warning.createEl("button", { text: "미완료 저장 확인" }).addEventListener("click", () => {
      const pendingRecovery = ctx.plugin.store.pendingRecovery;
      if (!pendingRecovery) return;
      ctx.plugin.modalOpenGuard.open(dialogKey("pending-recovery"), () => {
        const modal = new Modal(ctx.app);
        modal.setTitle("미완료 저장 확인");
        modal.modalEl.addClass("mia-preview-modal", "mia-recovery-modal");
        modal.contentEl.createEl("p", { text: "이 사본은 저장 완료가 확인되지 않은 요청입니다. 아래 원본을 복사해 별도로 보관할 수 있습니다. 재시도는 최신 파일과 사본을 기존 충돌 규칙으로 비교하며, 평가를 다시 계산하거나 이력을 합산하지 않습니다. 설정·평가 차이가 있으면 별도 보관됩니다." });
        const original = modal.contentEl.createEl("textarea", { attr: { readonly: "true", rows: "10", "aria-label": "미완료 저장 복구용 JSON" } });
        original.value = JSON.stringify(pendingRecovery, null, 2);
        original.style.width = "100%";
        const retry = modal.contentEl.createEl("button", { text: "최신 파일과 확인 후 저장 재시도" });
        retry.addEventListener("click", async () => {
          retry.disabled = true;
          try { await ctx.plugin.store.retryPending(); await ctx.plugin.index.rebuild(); modal.close(); ctx.showDashboard(); }
          catch (error) { new Notice(`저장 재시도 실패: ${errorMessage(error)}`); retry.disabled = false; }
        });
        modal.contentEl.createEl("button", { text: "닫기" }).addEventListener("click", () => modal.close());
        return modal;
      });
    });
  }
  if (overview.settingsConflicts) {
    const warning = root.createDiv({ cls: "mia-storage-warning" });
    warning.createEl("p", { text: `기기 간 설정 차이 ${overview.settingsConflicts}개를 보관했습니다. 현재 설정은 학습 설정에서 확인하세요.` });
    warning.createEl("button", { text: "보관된 설정 확인" }).addEventListener("click", () => ctx.plugin.modalOpenGuard.open(dialogKey("settings-conflicts"), () => new SettingsConflictModal(ctx.app, ctx.plugin.store.settings, ctx.plugin.store.settingsConflicts, async id => {
      await ctx.plugin.store.restoreSettingsConflict(id);
      await ctx.plugin.index.rebuild();
      ctx.showDashboard();
    }, item => ctx.plugin.store.dismissSettingsConflict(item))));
  }
  renderReviewConflictWarning(ctx, root, overview.reviewConflictCount);
  renderDuplicateFileWarning(root, overview.duplicateFiles);
  const { due, fresh, availableNew, availableDue, total } = overview;
  const hasAvailable = availableNew + availableDue > 0;
  const empty = total === 0;
  const limited = !empty && !hasAvailable && due + fresh > 0;
  const hero = root.createDiv({ cls: "mia-primary-card mia-hero" });
  // Today's two numbers lead as large colour blocks; the start panel follows.
  if (!empty) {
    const counts = hero.createDiv({ cls: "mia-hero-counts" });
    heroCount(counts, "복습", availableDue, `대기 ${due}`, "review");
    heroCount(counts, "새 문제", availableNew, `대기 ${fresh}`, "new");
  }
  const action = hero.createDiv({ cls: "mia-hero-main" });
  // The study day starts at the configured hour, so 02:00 still belongs to yesterday.
  const studyDay = new Date(overview.day);
  const chips = action.createDiv({ cls: "mia-hero-chips" });
  chips.createEl("span", { text: studyDay.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" }), cls: "mia-hero-date" });
  // 연속 학습일은 학습현황의 학습 기록과 같은 기준(학습 하루 경계, 평가 1~4)으로 센다.
  if (overview.streak > 0) chips.createEl("span", { text: `연속 ${overview.streak}일`, cls: "mia-hero-date mia-hero-streak", attr: { "aria-label": `연속 학습일 ${overview.streak}일` } });
  // 자주 누르는 버튼이 아니므로 시작 버튼 줄에서 빼 날짜 줄 오른쪽 끝에 작게 둔다.
  const refresh = chips.createEl("button", { text: "기록 새로고침", cls: "mia-hero-refresh" });
  refresh.setAttr("title", "다른 기기에서 이 보관함으로 도착한 복습 기록과 이어하기 위치를 확인합니다.");
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    try { await ctx.refreshRecords(); }
    finally { refresh.disabled = false; }
  });
  action.createEl("h3", { text: empty ? "첫 질문을 추가해 보세요" : hasAvailable ? "오늘 학습을 시작할까요?" : limited ? "오늘 출제할 문제가 없습니다" : "지금 복습할 문제가 없습니다" });
  if (empty) action.createEl("p", { text: "과목 이름, 질문, 정답, 핵심 키워드를 입력하면 바로 학습할 수 있습니다. 과목과 키워드는 함께 만들어집니다." });
  // 왼쪽 숫자 카드와 같은 값이면 되풀이하지 않고, 하루 상한으로 일부만 출제될 때만 차이를 보여 준다.
  else if (availableDue !== due || availableNew !== fresh) action.createEl("p", { text: `오늘 출제: 복습 ${availableDue}개 · 새 문제 ${availableNew}개 · 전체 대기: 복습 ${due}개 · 새 문제 ${fresh}개` });
  const deferredDue = Math.max(0, due - availableDue);
  if (deferredDue > 0) action.createEl("p", { text: `하루 상한으로 복습 ${deferredDue}개를 이번 출제에서 제외했습니다. 문제와 복습일은 유지되며 이후 학습에서 다시 확인할 수 있습니다.`, cls: "mia-muted mia-deferred-reviews" });
  if (limited) action.createEl("p", { text: "대기 중인 문제는 있지만 하루 학습량 제한으로 시험(일반복습)모드에 나오지 않습니다. 학습 설정에서 하루에 새로 배울 문제 수·하루 복습량을 확인하세요.", cls: "mia-muted" });
  const actions = action.createDiv({ cls: "mia-inline-actions" });
  if (empty) {
    actions.createEl("button", { text: "첫 질문 추가", cls: "mod-cta" }).addEventListener("click", () =>
      openEditorWithNotice("질문 추가", () => ctx.plugin.openManagedQuestionEditor()));
    if (overview.hasCandidates) actions.createEl("button", { text: "등록할 질문 확인" }).addEventListener("click", () => ctx.navigate("questions"));
  } else {
    const start = actions.createEl("button", { text: "시험(일반복습)모드 시작", cls: "mod-cta" });
    start.disabled = !hasAvailable;
    start.addEventListener("click", () => ctx.startReview());
    const browse = actions.createEl("button", { text: "전체 암기 모드" });
    browse.disabled = empty;
    browse.addEventListener("click", () => ctx.startReview(ctx.plugin.index.registered.map(question => question.id), "browse"));
  }
  const saved = overview.resume;
  if (saved) {
    // 이어하기 sits with the start actions, not in a card of its own.
    const current = saved.current;
    const resume = action.createDiv({ cls: "mia-resume-card" });
    resume.createEl("span", { text: "마지막 학습", cls: "mia-card-label" });
    const heading = resume.createEl("h3");
    if (current) renderQuestionHeading(ctx, heading, current);
    else heading.setText("저장된 학습");
    resume.createEl("p", { text: `${current?.subject ?? ""} · ${saved.mode === "recall" ? "시험" : "암기"} · ${saved.position} / ${saved.length}${saved.waiting ? " · 다음 복습 대기" : ""}` });
    resume.createEl("small", { text: `${new Date(saved.updatedAt).toLocaleString("ko-KR")} 저장`, cls: "mia-muted" });
    resume.createEl("button", { text: "이어하기", cls: "mia-secondary-action" }).addEventListener("click", () => ctx.resumeStudy());
  }
  if (limited) actions.createEl("button", { text: "학습량 확인" }).addEventListener("click", () => ctx.openStudySettings());
  const grid = root.createDiv({ cls: "mia-stats" });
  progressStat(ctx, grid, "등록 문제", total, "all", "total");
  const { stableRatio } = overview;
  const stable = grid.createEl("button", { cls: "mia-stat mia-progress-stat mia-stability-stat" });
  stable.style.setProperty("--mia-stable-ratio", `${stableRatio * 3.6}deg`);
  stable.createEl("strong", { text: `${stableRatio}%` });
  stable.createEl("span", { text: "기억 안정 비율" });
  stable.addEventListener("click", () => ctx.showQuestions("stable"));
  progressStat(ctx, grid, "최근 너무 쉬움", overview.easy, "easy", "easy");
  progressStat(ctx, grid, "오늘 평가", overview.today, "today", "good");
  progressStat(ctx, grid, "오늘 복습", due, "due", "review");
  progressStat(ctx, grid, "개선 필요", overview.weak, "weak", "again");
  renderProgressGuidance(root, overview.dayStartsAt, [
    "암기 모드는 평가 없이 질문과 정답을 넘겨 보는 모드입니다. 복습일은 바뀌지 않습니다.",
    "같은 보관함을 동기화하면 내 기기 사이에서 복습 기록·학습 설정·이어하기를 함께 씁니다.",
  ]);
  if (overview.target) renderUpcomingTarget(ctx, root, overview.target);
  if (!empty) renderWeaknessStrip(ctx, root, overview.weak);
  const manage = root.createDiv({ cls: "mia-manage-actions" });
  manage.createEl("button", { text: "과목 추가" }).addEventListener("click", () => ctx.plugin.openSubjectEditor());
  manage.createEl("button", { text: "질문 추가", cls: "mia-secondary-action" }).addEventListener("click", () =>
    openEditorWithNotice("질문 추가", () => ctx.plugin.openManagedQuestionEditor()));
  manage.createEl("button", { text: "키워드 추가" }).addEventListener("click", () => ctx.plugin.openKeywordEditor());
  manage.createEl("button", { text: "출력" }).addEventListener("click", () => ctx.plugin.openSubjectExport());
  if (overview.diagnostics) {
    root.createEl("p", { text: `검사 필요 ${overview.diagnostics}건 — 문제 목록에서 확인하세요.`, cls: "mia-warning" });
  }

  if (overview.cards.length) {
    root.createEl("h3", { text: "과목별 학습", cls: "mia-section-title" });
    const subjectGrid = root.createDiv({ cls: "mia-subject-grid" });
    for (const { subject, due: subjectDue, fresh: subjectNew, weak: subjectWeak, studied, total, canStart } of overview.cards) {
      const card = subjectGrid.createDiv({ cls: "mia-subject-card" });
      // 과목 이름 줄을 누르면 그 과목 문제 목록을 바로 연다.
      const titleRow = card.createDiv({ cls: "mia-card-title-row" });
      const heading = titleRow.createEl("button", {
        cls: "mia-subject-heading mia-subject-open",
        attr: { type: "button", "aria-label": `${subject} 문제 ${total}개 목록 보기` },
      });
      heading.createEl("strong", { text: subject });
      heading.createEl("span", { text: `${total}문제`, cls: "mia-subject-total" });
      heading.addEventListener("click", () => ctx.showQuestions("all", subject));
      renderCardManagementMenu(titleRow, subject, "이름 수정",
        () => ctx.plugin.openSubjectEditor(subject),
        () => ctx.plugin.confirmDeleteSubject(subject));
      renderMeter(card, studied, total, "학습");
      const chips = card.createDiv({ cls: "mia-subject-chips" });
      // 학습 막대가 무엇을 세는지 화면에서도 읽히게 같은 값을 칩으로 보여 준다.
      chips.createEl("span", { text: `학습 ${studied}/${total}`, cls: "mia-count-chip" }).dataset.tone = "idle";
      const dueChip = chips.createEl("span", { text: `복습 ${subjectDue}`, cls: "mia-count-chip" });
      dueChip.dataset.tone = subjectDue > 0 ? "review" : "idle";
      const newChip = chips.createEl("span", { text: `새 문제 ${subjectNew}`, cls: "mia-count-chip" });
      newChip.dataset.tone = subjectNew > 0 ? "new" : "idle";
      const weakChip = chips.createEl("span", { text: `취약 ${subjectWeak}`, cls: "mia-count-chip" });
      weakChip.dataset.tone = subjectWeak > 0 ? "again" : "idle";
      const subjectActions = card.createDiv({ cls: "mia-inline-actions" });
      const review = subjectActions.createEl("button", { text: "시험", cls: "mia-secondary-action" });
      review.disabled = !canStart;
      review.addEventListener("click", () => ctx.startReview(reviewQueue(ctx, subjectQuestions(ctx, subject)).map(question => question.id)));
      const memorize = subjectActions.createEl("button", { text: "암기" });
      memorize.disabled = total === 0;
      memorize.addEventListener("click", () => {
        ctx.startReview(subjectQuestions(ctx, subject).map(question => question.id), "browse");
      });
    }
  }
}

/** Again/Hard questions, most urgent first (the order the weak-question study uses). */
function weakQuestions(ctx: StudyPageContext, questions: Array<QuestionRecord & { id: string }>): Array<QuestionRecord & { id: string }> {
  return queryQuestions(questions, ctx.plugin.store.reviews, ctx.plugin.fsrs, {
    text: "", subject: "all", questionType: "all", review: "weak", keyword: "", sort: "weak",
  });
}

/**
 * The weak-question strip. It carries what the former 취약 문제 tab offered:
 * the study action for every weak question and the way into the ordered list.
 */
function renderWeaknessStrip(ctx: StudyPageContext, root: HTMLElement, count: number): void {
  const strip = root.createDiv({ cls: "mia-weak-strip" });
  strip.createEl("strong", { text: `취약 문제 ${count}개` });
  strip.createEl("span", { text: "못 암기와 애매 문제만 모아 시험합니다. 출제 순서는 학습 설정을 따릅니다.", cls: "mia-muted mia-weak-hint" });
  const actions = strip.createDiv({ cls: "mia-inline-actions" });
  const start = actions.createEl("button", { text: "취약 문제 시험", cls: "mia-secondary-action" });
  start.disabled = count === 0;
  start.addEventListener("click", () => ctx.startReview(weakQuestions(ctx, ctx.plugin.index.registered).map(question => question.id)));
  actions.createEl("button", { text: "목록 보기" }).addEventListener("click", () => ctx.showQuestions("weak"));
}

export function renderProgress(ctx: StudyPageContext, root: HTMLElement, overview: ProgressOverview): void {
  const progress = overview.counts;
  renderTargetDates(ctx, root, overview.targets, overview.retention);
  renderStudyHistory(root, overview.history);
  renderReviewForecast(root, overview.forecast, overview.targets);
  root.createEl("h3", { text: "전체 학습현황", cls: "mia-page-title" });
  renderReviewConflictWarning(ctx, root, overview.reviewConflictCount);
  const totals = root.createDiv({ cls: "mia-stats" });
  progressStat(ctx, totals, "전체 문제", progress.total, "all", "total");
  progressStat(ctx, totals, "학습 전", progress.new, "new", "new");
  progressStat(ctx, totals, "오늘 복습", progress.due, "due", "review");
  progressStat(ctx, totals, "1회 이상 학습", progress.studied, null, "total");
  progressStat(ctx, totals, "기억 안정", progress.stable, "stable", "good");
  progressStat(ctx, totals, "오늘 평가", progress.today, "today", "good");
  renderProgressGuidance(root, overview.dayStartsAt);

  root.createEl("h3", { text: "최근 평가", cls: "mia-section-title" });
  renderRatingBar(root, progress);
  const ratings = root.createDiv({ cls: "mia-progress-ratings" });
  progressStat(ctx, ratings, "못 암기", progress.again, "again");
  progressStat(ctx, ratings, "애매", progress.hard, "hard");
  progressStat(ctx, ratings, "암기", progress.good, "good");
  progressStat(ctx, ratings, "너무 쉬움", progress.easy, "easy");

  root.createEl("h3", { text: "과목별 현황", cls: "mia-section-title" });
  const subjectGrid = root.createDiv({ cls: "mia-progress-subjects" });
  for (const counts of overview.cards) {
    const { subject, canStart } = counts;
    const card = subjectGrid.createDiv({ cls: "mia-progress-subject" });
    const heading = card.createDiv({ cls: "mia-progress-subject-heading" });
    heading.createEl("strong", { text: subject });
    heading.createEl("span", { text: `${counts.studied}/${counts.total} 학습` });
    renderMeter(card, counts.studied, counts.total, "학습");
    const values = card.createDiv({ cls: "mia-progress-subject-values" });
    progressLink(ctx, values, `학습 전 ${counts.fresh}`, "new", subject, counts.fresh);
    progressLink(ctx, values, `오늘 복습 ${counts.due}`, "due", subject, counts.due);
    progressLink(ctx, values, `못 암기 ${counts.again}`, "again", subject, counts.again);
    progressLink(ctx, values, `애매 ${counts.hard}`, "hard", subject, counts.hard);
    progressLink(ctx, values, `암기 ${counts.good}`, "good", subject, counts.good);
    progressLink(ctx, values, `너무 쉬움 ${counts.easy}`, "easy", subject, counts.easy);
    const actions = card.createDiv({ cls: "mia-inline-actions" });
    const start = actions.createEl("button", { text: "시험", cls: "mia-secondary-action" });
    start.disabled = !canStart;
    start.addEventListener("click", () => ctx.startReview(reviewQueue(ctx, subjectQuestions(ctx, subject)).map(question => question.id)));
    actions.createEl("button", { text: "전체 문제" }).addEventListener("click", () => ctx.showQuestions("all", subject));
  }
  if (overview.cards.length === 0) root.createEl("p", { text: "과목과 질문을 추가하면 학습현황이 표시됩니다.", cls: "mia-empty" });
}

function renderProgressGuidance(root: HTMLElement, dayStartsAt: number, extra: string[] = []): void {
  const help = root.createEl("details", { cls: "mia-stat-guidance" });
  help.createEl("summary", { text: "통계와 출제량 안내" });
  help.createEl("p", { text: progressGuidance(dayStartsAt), cls: "mia-muted" });
  for (const text of extra) help.createEl("p", { text, cls: "mia-muted" });
}

function progressStat(
  ctx: StudyPageContext,
  parent: HTMLElement,
  label: string,
  value: number,
  review: ReviewFilter | null,
  tone?: string,
): void {
  const card = review
    ? parent.createEl("button", { cls: "mia-stat mia-progress-stat" })
    : parent.createDiv({ cls: "mia-stat mia-progress-stat" });
  if (tone) card.dataset.tone = tone;
  card.createEl("strong", { text: String(value) });
  card.createEl("span", { text: label });
  if (review) card.addEventListener("click", () => ctx.showQuestions(review));
}

function progressLink(ctx: StudyPageContext, parent: HTMLElement, label: string, review: ReviewFilter, subject: string, count: number): void {
  const button = parent.createEl("button", { text: label });
  // 0건이면 눌러도 빈 목록이라 누를 수 없게 옅게 둔다(숫자와 자리는 그대로).
  button.disabled = count === 0;
  button.addEventListener("click", () => ctx.showQuestions(review, subject));
}

function heroCount(parent: HTMLElement, label: string, value: number, detail: string, tone: string): void {
  const item = parent.createDiv({ cls: "mia-hero-count" });
  item.dataset.tone = tone;
  item.createEl("strong", { text: String(value) });
  item.createEl("span", { text: label });
  item.createEl("small", { text: detail });
}

/** A labelled bar; the text stays readable for screen readers and narrow panes. */
function renderMeter(parent: HTMLElement, value: number, total: number, label: string): void {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  const meter = parent.createDiv({ cls: "mia-meter" });
  meter.setAttr("role", "img");
  meter.setAttr("aria-label", `${label} ${value}/${total}`);
  meter.createDiv({ cls: "mia-meter-fill" }).style.setProperty("width", `${Math.round(ratio * 100)}%`);
}

function renderRatingBar(root: HTMLElement, counts: ProgressCounts): void {
  const parts: Array<[string, number, string]> = [["못 암기", counts.again, "again"], ["애매", counts.hard, "hard"], ["암기", counts.good, "good"], ["너무 쉬움", counts.easy, "easy"]];
  const total = parts.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return;
  const bar = root.createDiv({ cls: "mia-rating-bar" });
  bar.setAttr("role", "img");
  bar.setAttr("aria-label", parts.map(([label, value]) => `${label} ${value}`).join(", "));
  for (const [, value, tone] of parts) {
    if (!value) continue;
    const segment = bar.createDiv({ cls: "mia-rating-bar-part" });
    segment.dataset.tone = tone;
    segment.style.setProperty("flex-grow", String(value));
  }
}

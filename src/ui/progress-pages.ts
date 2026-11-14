import { Modal, Notice } from "obsidian";
import { calculateProgress, type ProgressCounts } from "../core/progress";
import type { QuestionRecord } from "../core/models";
import { queryQuestions, type ReviewFilter } from "../core/question-query";
import { buildReviewQueue } from "../core/recommendation-engine";
import { studyDayStart } from "../core/study-management";
import { errorMessage } from "./error-message";
import { openEditorWithNotice } from "./editor-notice";
import { renderQuestionHeading } from "./question-row";
import { ReviewConflictModal } from "./review-conflict-modal";
import { SettingsConflictModal } from "./settings-conflict-modal";
import type { StudyPageContext } from "./study-page-context";
import { progressGuidance } from "./study-policy";
import { dialogKey } from "./modal-open-guard";

// The dashboard and progress pages: counts, start buttons and per-subject cards.

const MAX_LISTED_DUPLICATE_FILES = 8;

/** Explains why questions vanished when a sync app left a copy of a question file. */
function renderDuplicateFileWarning(ctx: StudyPageContext, root: HTMLElement): void {
  const duplicates = ctx.plugin.index.crossFileDuplicates;
  if (!duplicates?.files.length) return;
  const card = root.createDiv({ cls: "mia-primary-card" });
  card.createEl("p", { text: `같은 문제가 둘 이상의 파일에 들어 있어 문제 ${duplicates.hiddenQuestions}개가 목록과 학습에서 숨겨져 있습니다.`, cls: "mia-warning" });
  card.createEl("p", { text: "동기화 앱이 파일의 사본을 만들었을 때 흔히 생깁니다. 학습 기록은 그대로 보관되어 있으며, 불필요한 사본 파일을 삭제하거나 문제 폴더 밖으로 옮기면 문제가 다시 나타납니다.", cls: "mia-muted" });
  const list = card.createEl("ul");
  for (const file of duplicates.files.slice(0, MAX_LISTED_DUPLICATE_FILES)) list.createEl("li", { text: file.filePath });
  const more = duplicates.files.length - MAX_LISTED_DUPLICATE_FILES;
  if (more > 0) card.createEl("p", { text: `외 ${more}개 파일`, cls: "mia-muted" });
}

export function renderDashboard(ctx: StudyPageContext, root: HTMLElement): void {
  const pendingRecovery = ctx.plugin.store.pendingRecovery;
  if (pendingRecovery) {
    const warning = root.createDiv({ cls: "mia-storage-warning" });
    warning.createEl("p", { text: "완료를 확인하지 못한 저장 사본이 있습니다. 새 평가 전에 확인하세요." });
    warning.createEl("button", { text: "미완료 저장 확인" }).addEventListener("click", () => {
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
  const settingsConflicts = ctx.plugin.store.settingsConflicts;
  if (settingsConflicts?.length) {
    const warning = root.createDiv({ cls: "mia-storage-warning" });
    warning.createEl("p", { text: `기기 간 설정 차이 ${settingsConflicts.length}개를 보관했습니다. 현재 설정은 학습 설정에서 확인하세요.` });
    warning.createEl("button", { text: "보관된 설정 확인" }).addEventListener("click", () => ctx.plugin.modalOpenGuard.open(dialogKey("settings-conflicts"), () => new SettingsConflictModal(ctx.app, ctx.plugin.store.settings, settingsConflicts, async id => {
      await ctx.plugin.store.restoreSettingsConflict(id);
      await ctx.plugin.index.rebuild();
      ctx.showDashboard();
    })));
  }
  const conflicts = ctx.plugin.store.conflicts;
  if (conflicts && Object.keys(conflicts).length) {
    const warning = root.createDiv({ cls: "mia-sync-warning" });
    warning.createEl("p", { text: `기기 간 평가가 달랐던 문제 ${Object.keys(conflicts).length}개 · 이전 이력도 보관했습니다.` });
    warning.createEl("button", { text: "보관된 평가 확인" }).addEventListener("click", () => ctx.plugin.modalOpenGuard.open(dialogKey("review-conflicts"), () => new ReviewConflictModal(ctx.app, conflicts, id => ctx.plugin.index.questionById(id)?.heading ?? id)));
  }
  renderDuplicateFileWarning(ctx, root);
  const questions = ctx.plugin.index.registered;
  const progress = calculateProgress(questions, ctx.plugin.store.reviews, ctx.plugin.fsrs);
  const due = progress.due;
  const fresh = progress.new;
  const available = buildReviewQueue(questions, ctx.plugin.store.reviews, ctx.plugin.fsrs, { management: ctx.plugin.store.settings.studyManagement });
  const availableNew = available.filter(question => ctx.plugin.fsrs.isNew(ctx.plugin.store.getReview(question.id))).length;
  const availableDue = available.length - availableNew;
  const empty = questions.length === 0;
  const limited = !empty && available.length === 0 && due + fresh > 0;
  const hero = root.createDiv({ cls: "mia-primary-card mia-hero" });
  // Today's two numbers lead as large colour blocks; the start panel follows.
  if (!empty) {
    const counts = hero.createDiv({ cls: "mia-hero-counts" });
    heroCount(counts, "복습", availableDue, `대기 ${due}`, "review");
    heroCount(counts, "새 문제", availableNew, `대기 ${fresh}`, "new");
  }
  const action = hero.createDiv({ cls: "mia-hero-main" });
  // The study day starts at the configured hour, so 02:00 still belongs to yesterday.
  const studyDay = studyDayStart(new Date(), ctx.plugin.store.settings.studyManagement.dayStartsAt);
  action.createEl("span", { text: studyDay.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" }), cls: "mia-hero-date" });
  action.createEl("h3", { text: empty ? "첫 질문을 추가해 보세요" : available.length > 0 ? "오늘 학습을 시작할까요?" : limited ? "오늘 출제할 문제가 없습니다" : "지금 복습할 문제가 없습니다" });
  action.createEl("p", { text: empty
    ? "과목 이름, 질문, 정답, 핵심 키워드를 입력하면 바로 학습할 수 있습니다. 과목과 키워드는 함께 만들어집니다."
    : `오늘 출제: 복습 ${availableDue}개 · 새 문제 ${availableNew}개 · 전체 대기: 복습 ${due}개 · 새 문제 ${fresh}개` });
  const deferredDue = Math.max(0, due - availableDue);
  if (deferredDue > 0) action.createEl("p", { text: `하루 상한으로 복습 ${deferredDue}개를 이번 출제에서 제외했습니다. 문제와 복습일은 유지되며 이후 학습에서 다시 확인할 수 있습니다.`, cls: "mia-muted mia-deferred-reviews" });
  if (limited) action.createEl("p", { text: "대기 중인 문제는 있지만 하루 학습량 제한으로 시험 모드에 나오지 않습니다. 학습 설정에서 하루에 새로 배울 문제 수·하루 복습량을 확인하세요.", cls: "mia-muted" });
  const actions = action.createDiv({ cls: "mia-inline-actions" });
  if (empty) {
    actions.createEl("button", { text: "첫 질문 추가", cls: "mod-cta" }).addEventListener("click", () =>
      openEditorWithNotice("질문 추가", () => ctx.plugin.openManagedQuestionEditor()));
    if (ctx.plugin.index.candidates.length) actions.createEl("button", { text: "등록할 질문 확인" }).addEventListener("click", () => ctx.navigate("questions"));
  } else {
    const start = actions.createEl("button", { text: "시험 모드 시작", cls: "mod-cta" });
    start.disabled = available.length === 0;
    start.addEventListener("click", () => ctx.startReview());
    const browse = actions.createEl("button", { text: "전체 암기 모드" });
    browse.disabled = due + fresh === 0;
    browse.addEventListener("click", () => ctx.startReview(questions.map((question) => question.id), "browse"));
  }
  const saved = ctx.plugin.studyUi.resume;
  if (saved) {
    // 이어하기 sits with the start actions, not in a card of its own.
    const current = ctx.plugin.index.questionById(saved.queue[saved.queueIndex] ?? saved.seed[0] ?? "");
    const resume = action.createDiv({ cls: "mia-resume-card" });
    resume.createEl("span", { text: "마지막 학습", cls: "mia-card-label" });
    const heading = resume.createEl("h3");
    if (current) renderQuestionHeading(ctx, heading, current);
    else heading.setText("저장된 학습");
    resume.createEl("p", { text: `${current?.subject ?? ""} · ${saved.sessionMode === "recall" ? "시험" : "암기"} · ${Math.min(saved.queueIndex + 1, saved.queue.length)} / ${saved.queue.length}${saved.queueIndex >= saved.queue.length ? " · 다음 복습 대기" : ""}` });
    resume.createEl("small", { text: `${new Date(saved.updatedAt).toLocaleString("ko-KR")} 저장`, cls: "mia-muted" });
    resume.createEl("button", { text: "이어하기", cls: "mod-cta" }).addEventListener("click", () => ctx.resumeStudy());
  }
  if (limited) actions.createEl("button", { text: "학습량 확인" }).addEventListener("click", () => ctx.openStudySettings());
  const refresh = actions.createEl("button", { text: "기록 새로고침" });
  refresh.setAttr("title", "다른 기기에서 이 보관함으로 도착한 복습 기록과 이어하기 위치를 확인합니다.");
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    try { await ctx.refreshRecords(); }
    finally { refresh.disabled = false; }
  });
  action.createEl("p", { text: "같은 보관함을 동기화하면 내 기기 사이에서 복습 기록·학습 설정·이어하기를 함께 씁니다.", cls: "mia-muted mia-device-sync-hint" });
  const grid = root.createDiv({ cls: "mia-stats" });
  progressStat(ctx, grid, "등록 문제", questions.length, "all", "total");
  const stableRatio = progress.total ? Math.round((progress.stable / progress.total) * 100) : 0;
  const stable = grid.createEl("button", { cls: "mia-stat mia-progress-stat mia-stability-stat" });
  stable.style.setProperty("--mia-stable-ratio", `${stableRatio * 3.6}deg`);
  stable.createEl("strong", { text: `${stableRatio}%` });
  stable.createEl("span", { text: "기억 안정 비율" });
  stable.addEventListener("click", () => ctx.showQuestions("stable"));
  progressStat(ctx, grid, "최근 너무 쉬움", progress.easy, "easy", "easy");
  progressStat(ctx, grid, "오늘 평가", progress.today, "today", "good");
  progressStat(ctx, grid, "오늘 복습", due, "due", "review");
  progressStat(ctx, grid, "개선 필요", progress.again + progress.hard, "weak", "again");
  renderProgressGuidance(ctx, root);
  if (!empty) renderWeaknessStrip(ctx, root, questions);
  const manage = root.createDiv({ cls: "mia-manage-actions" });
  manage.createEl("button", { text: "과목 추가" }).addEventListener("click", () => ctx.plugin.openSubjectEditor());
  manage.createEl("button", { text: "질문 추가", cls: "mod-cta" }).addEventListener("click", () =>
    openEditorWithNotice("질문 추가", () => ctx.plugin.openManagedQuestionEditor()));
  manage.createEl("button", { text: "키워드 추가" }).addEventListener("click", () => ctx.plugin.openKeywordEditor());
  manage.createEl("button", { text: "출력" }).addEventListener("click", () => ctx.plugin.openSubjectExport());
  if (ctx.plugin.index.diagnostics.length) {
    root.createEl("p", { text: `검사 필요 ${ctx.plugin.index.diagnostics.length}건 — 문제 목록에서 확인하세요.`, cls: "mia-warning" });
  }

  const subjects = new Map<string, Array<QuestionRecord & { id: string }>>();
  for (const subject of ctx.plugin.listSubjects()) subjects.set(subject, []);
  for (const question of questions) {
    const items = subjects.get(question.subject) ?? [];
    items.push(question);
    subjects.set(question.subject, items);
  }
  const subjectCounts = new Map(progress.bySubject.map((item) => [item.subject, item.counts]));
  if (subjects.size) {
    root.createEl("h3", { text: "과목별 학습", cls: "mia-section-title" });
    const subjectGrid = root.createDiv({ cls: "mia-subject-grid" });
    for (const [subject, items] of [...subjects].sort(([left], [right]) => left.localeCompare(right, "ko"))) {
      const subjectDue = items.filter((question) => ctx.plugin.fsrs.isDue(ctx.plugin.store.getReview(question.id))).length;
      const subjectNew = items.filter((question) => ctx.plugin.fsrs.isNew(ctx.plugin.store.getReview(question.id))).length;
      const card = subjectGrid.createDiv({ cls: "mia-subject-card" });
      const heading = card.createDiv({ cls: "mia-subject-heading" });
      heading.createEl("strong", { text: subject });
      heading.createEl("span", { text: `${items.length}문제`, cls: "mia-subject-total" });
      renderMeter(card, subjectCounts.get(subject)?.studied ?? 0, items.length, "학습");
      const chips = card.createDiv({ cls: "mia-subject-chips" });
      const dueChip = chips.createEl("span", { text: `복습 ${subjectDue}`, cls: "mia-count-chip" });
      dueChip.dataset.tone = subjectDue > 0 ? "review" : "idle";
      const newChip = chips.createEl("span", { text: `새 문제 ${subjectNew}`, cls: "mia-count-chip" });
      newChip.dataset.tone = subjectNew > 0 ? "new" : "idle";
      const subjectWeak = weakQuestions(ctx, items).length;
      const weakChip = chips.createEl("span", { text: `취약 ${subjectWeak}`, cls: "mia-count-chip" });
      weakChip.dataset.tone = subjectWeak > 0 ? "again" : "idle";
      const subjectActions = card.createDiv({ cls: "mia-inline-actions" });
      const reviewIds = buildReviewQueue(items, ctx.plugin.store.reviews, ctx.plugin.fsrs, { management: ctx.plugin.store.settings.studyManagement }).map((question) => question.id);
      const review = subjectActions.createEl("button", { text: "시험" });
      review.disabled = reviewIds.length === 0;
      review.addEventListener("click", () => ctx.startReview(reviewIds));
      const memorize = subjectActions.createEl("button", { text: "암기" });
      memorize.disabled = subjectDue + subjectNew === 0;
      memorize.addEventListener("click", () => {
        ctx.startReview(items.map((question) => question.id), "browse");
      });
      subjectActions.createEl("button", { text: "이름 수정" }).addEventListener("click", () => {
        ctx.plugin.openSubjectEditor(subject);
      });
      subjectActions.createEl("button", { text: "삭제", cls: "mod-warning" }).addEventListener("click", () => {
        ctx.plugin.confirmDeleteSubject(subject);
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
function renderWeaknessStrip(ctx: StudyPageContext, root: HTMLElement, questions: Array<QuestionRecord & { id: string }>): void {
  const weak = weakQuestions(ctx, questions);
  const strip = root.createDiv({ cls: "mia-weak-strip" });
  strip.createSpan({ cls: "mia-weak-mark" }).setAttr("aria-hidden", "true");
  strip.createEl("strong", { text: `취약 문제 ${weak.length}개` });
  strip.createEl("span", { text: "못 암기와 애매 문제를 복습 지연 시간까지 반영한 긴급도 순으로 시험합니다.", cls: "mia-muted mia-weak-hint" });
  const actions = strip.createDiv({ cls: "mia-inline-actions" });
  const start = actions.createEl("button", { text: "취약 문제 시험", cls: "mod-cta" });
  start.disabled = weak.length === 0;
  start.addEventListener("click", () => ctx.startReview(weak.map((question) => question.id)));
  actions.createEl("button", { text: "목록 보기" }).addEventListener("click", () => ctx.showQuestions("weak"));
}

export function renderProgress(ctx: StudyPageContext, root: HTMLElement): void {
  const questions = ctx.plugin.index.registered;
  const progress = calculateProgress(questions, ctx.plugin.store.reviews, ctx.plugin.fsrs);
  root.createEl("h3", { text: "전체 학습현황", cls: "mia-page-title" });
  const totals = root.createDiv({ cls: "mia-stats" });
  progressStat(ctx, totals, "전체 문제", progress.total, "all", "total");
  progressStat(ctx, totals, "학습 전", progress.new, "new", "new");
  progressStat(ctx, totals, "오늘 복습", progress.due, "due", "review");
  progressStat(ctx, totals, "1회 이상 학습", progress.studied, null, "total");
  progressStat(ctx, totals, "기억 안정", progress.stable, "stable", "good");
  progressStat(ctx, totals, "오늘 평가", progress.today, "today", "good");
  renderProgressGuidance(ctx, root);

  root.createEl("h3", { text: "최근 평가", cls: "mia-section-title" });
  renderRatingBar(root, progress);
  const ratings = root.createDiv({ cls: "mia-progress-ratings" });
  progressStat(ctx, ratings, "못 암기", progress.again, "again");
  progressStat(ctx, ratings, "애매", progress.hard, "hard");
  progressStat(ctx, ratings, "암기", progress.good, "good");
  progressStat(ctx, ratings, "너무 쉬움", progress.easy, "easy");

  root.createEl("h3", { text: "과목별 현황", cls: "mia-section-title" });
  const subjectProgress = new Map(progress.bySubject.map((item) => [item.subject, item.counts]));
  for (const subject of ctx.plugin.listSubjects()) {
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
    renderMeter(card, counts.studied, counts.total, "학습");
    const values = card.createDiv({ cls: "mia-progress-subject-values" });
    progressLink(ctx, values, `학습 전 ${counts.new}`, "new", subject);
    progressLink(ctx, values, `오늘 복습 ${counts.due}`, "due", subject);
    progressLink(ctx, values, `못 암기 ${counts.again}`, "again", subject);
    progressLink(ctx, values, `애매 ${counts.hard}`, "hard", subject);
    progressLink(ctx, values, `암기 ${counts.good}`, "good", subject);
    progressLink(ctx, values, `너무 쉬움 ${counts.easy}`, "easy", subject);
    const actions = card.createDiv({ cls: "mia-inline-actions" });
    const subjectQuestions = questions.filter((question) => question.subject === subject);
    const reviewIds = buildReviewQueue(subjectQuestions, ctx.plugin.store.reviews, ctx.plugin.fsrs, { management: ctx.plugin.store.settings.studyManagement })
      .map((question) => question.id);
    const start = actions.createEl("button", { text: "복습 시작", cls: "mod-cta" });
    start.disabled = reviewIds.length === 0;
    start.addEventListener("click", () => ctx.startReview(reviewIds));
    actions.createEl("button", { text: "전체 문제" }).addEventListener("click", () => ctx.showQuestions("all", subject));
  }
  if (subjectProgress.size === 0) root.createEl("p", { text: "과목과 질문을 추가하면 학습현황이 표시됩니다.", cls: "mia-empty" });
}

function renderProgressGuidance(ctx: StudyPageContext, root: HTMLElement): void {
  const help = root.createEl("details", { cls: "mia-stat-guidance" });
  help.createEl("summary", { text: "통계와 출제량 안내" });
  help.createEl("p", { text: progressGuidance(ctx.plugin.store.settings.studyManagement.dayStartsAt), cls: "mia-muted" });
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

function progressLink(ctx: StudyPageContext, parent: HTMLElement, label: string, review: ReviewFilter, subject: string): void {
  const button = parent.createEl("button", { text: label });
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

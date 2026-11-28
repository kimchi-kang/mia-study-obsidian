import { renderCardManagementMenu } from "./card-management-menu";
import type { TargetDate } from "../core/models";
import { forecastReviews, MAX_TARGET_DATES, summarizeTargetDates, type TargetDateSummary } from "../core/target-dates";
import { ConfirmDeleteModal } from "./manage-modals";
import { dialogKey } from "./modal-open-guard";
import type { StudyPageContext } from "./study-page-context";
import { TargetDateModal } from "./target-date-modal";

export function readTargetDates(ctx: StudyPageContext, now: Date, upcomingOnly = false, questions = ctx.plugin.index.registered): TargetDateSummary[] {
  const { store, fsrs } = ctx.plugin;
  return summarizeTargetDates(store.settings.targetDates ?? [], questions, store.reviews,
    fsrs, store.settings.studyManagement.dayStartsAt, store.settings.targetRetention, now, upcomingOnly);
}

function daysLabel(days: number): string {
  return days < 0 ? "지남" : `D-${days}`;
}

export function targetRecallLabel(recall: number | null): string {
  return recall === null ? "기록 없음" : `${Math.round(recall * 100)}%`;
}

function riskButton(ctx: StudyPageContext, root: HTMLElement, item: TargetDateSummary, upcomingOnly = false): void {
  const button = root.createEl("button", { text: "위험 문제 학습", cls: "mia-target-review" });
  button.disabled = item.risks.length === 0;
  button.addEventListener("click", () => {
    const targets = readTargetDates(ctx, new Date(), upcomingOnly);
    const current = upcomingOnly ? targets[0] : targets.find(row => row.target.id === item.target.id);
    if (current?.risks.length) ctx.startFocusedReview(current.risks.map(risk => risk.id));
  });
}

export function renderUpcomingTarget(ctx: StudyPageContext, root: HTMLElement, item: TargetDateSummary): void {
  const strip = root.createDiv({ cls: "mia-target-strip" });
  strip.createEl("strong", { text: `${daysLabel(item.daysUntil)} ${item.target.label} · 위험 문제 ${item.risks.length}개` });
  riskButton(ctx, strip, item, true);
}

function openTargetEditor(ctx: StudyPageContext, target?: TargetDate): void {
  const { modalOpenGuard, store } = ctx.plugin;
  const baseline = structuredClone(store.settings);
  const list = baseline.targetDates ?? [];
  const current = target && list.find(item => item.id === target.id);
  if ((target && !current) || (!target && list.length >= MAX_TARGET_DATES)) return;
  modalOpenGuard.open(dialogKey("target-date-editor", current?.id), () =>
    new TargetDateModal(ctx.app, current, ctx.plugin.listSubjects(), async item => {
      const targetDates = current ? list.map(row => row.id === current.id ? item : row) : [...list, item];
      await store.updateSettings({ targetDates }, baseline);
    }));
}

function confirmTargetRemoval(ctx: StudyPageContext, target: TargetDate): void {
  const { modalOpenGuard, store } = ctx.plugin;
  const baseline = structuredClone(store.settings);
  const list = baseline.targetDates ?? [];
  const current = list.find(item => item.id === target.id);
  if (!current) return;
  modalOpenGuard.open(dialogKey("target-date-delete", target.id), () => {
    const modal = new ConfirmDeleteModal(
      ctx.app, "목표일 삭제", `‘${current.label}’ 목표일을 삭제할까요?`, "삭제",
      () => store.updateSettings({ targetDates: list.filter(item => item.id !== current.id) }, baseline),
      "목표일 삭제 실패",
    );
    modal.modalEl.addClass("mia-target-delete-modal");
    return modal;
  });
}

function renderTargetCard(ctx: StudyPageContext, root: HTMLElement, item: TargetDateSummary): void {
  const { target } = item;
  const card = root.createEl("article", { cls: "mia-target-card" });
  // 과목·키워드 카드처럼 편집·삭제는 제목 줄의 ⋯ 메뉴에 둔다.
  const titleRow = card.createDiv({ cls: "mia-card-title-row" });
  titleRow.createEl("h4", { text: target.label });
  renderCardManagementMenu(titleRow, target.label, "편집", () => openTargetEditor(ctx, target), () => confirmTargetRemoval(ctx, target));
  card.createEl("p", { text: `${target.date} · ${daysLabel(item.daysUntil)} · ${target.subjects?.join(", ") || "전체 과목"} · ${item.total}문제` });
  card.createEl("p", { text: `예상 평균 기억률\u00a0${targetRecallLabel(item.averageRecall)} · 위험 문제\u00a0${item.risks.length}개 · 학습\u00a0전\u00a0${item.unstudied}개` });
  const actions = card.createDiv({ cls: "mia-inline-actions" });
  riskButton(ctx, actions, item);
}

export function renderTargetDates(ctx: StudyPageContext, root: HTMLElement, items: TargetDateSummary[], retention: number): void {
  const section = root.createEl("section", { cls: "mia-target-dates" });
  const heading = section.createDiv({ cls: "mia-target-heading" });
  heading.createEl("h3", { text: "목표일", cls: "mia-section-title" });
  const add = heading.createEl("button", { text: "목표일 추가" });
  add.disabled = items.length >= MAX_TARGET_DATES;
  add.addEventListener("click", () => openTargetEditor(ctx));
  if (!items.length) return;
  section.createEl("p", { text: `목표일의 예상 기억률이 목표 기억률 ${Math.round(retention * 100)}%보다 낮은 문제를 위험 문제로 표시합니다.`, cls: "mia-muted" });
  for (const item of items.filter(item => item.daysUntil >= 0)) renderTargetCard(ctx, section, item);
  const past = items.filter(item => item.daysUntil < 0);
  if (past.length) {
    const details = section.createEl("details", { cls: "mia-target-past" });
    details.createEl("summary", { text: "지난 목표일" });
    for (const item of past.reverse()) renderTargetCard(ctx, details, item);
  }
}

export function renderReviewForecast(root: HTMLElement, days: ReturnType<typeof forecastReviews>, targets: readonly TargetDateSummary[]): void {
  const section = root.createEl("section", { cls: "mia-review-forecast" });
  section.createEl("h3", { text: "향후 30일 복습량" });
  section.createEl("p", { text: "하루 복습 상한 적용 전 수치입니다. 지난 복습은 오늘에 더했습니다.", cls: "mia-muted" });
  const markers = new Map<string, string[]>();
  const visibleDates = new Set(days.map(day => day.date));
  for (const { target } of targets) {
    if (!visibleDates.has(target.date)) continue;
    markers.set(target.date, [...markers.get(target.date) ?? [], target.label]);
  }
  const highest = Math.max(0, ...days.map(day => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const bars = section.createDiv({ cls: "mia-forecast-bars", attr: { "aria-hidden": "true" } });
  const labels = days.map(({ date, count }) => {
    const names = markers.get(date);
    const label = `${date} · ${count}문제${names ? ` · ${names.join(", ")}` : ""}`;
    const column = bars.createDiv({ cls: "mia-forecast-column", attr: { title: label } });
    if (names) column.createSpan({ cls: "mia-forecast-marker" });
    const bar = column.createSpan({ cls: count > 0 ? "mia-forecast-bar mia-forecast-bar-positive" : "mia-forecast-bar" });
    bar.style.setProperty("--mia-forecast-height", `${count / Math.max(1, highest) * 100}%`);
    return label;
  });
  const axis = section.createDiv({ cls: "mia-forecast-axis mia-muted" });
  axis.createSpan({ text: `오늘 ${days[0]?.date.slice(5)}` });
  axis.createSpan({ cls: "mia-forecast-summary", text: `최대 ${highest}문제 · 30일 합계 ${total}문제` });
  axis.createSpan({ text: days.at(-1)?.date.slice(5) ?? "" });
  for (const [date, names] of markers) {
    section.createEl("p", { cls: "mia-forecast-key", text: `● ${date.slice(5)} ${names.join(", ")}` });
  }
  const details = section.createEl("details", { cls: "mia-forecast-details" });
  details.createEl("summary", { text: "날짜별 복습량 보기" });
  const list = details.createEl("ul");
  for (const label of labels) list.createEl("li", { text: label });
}

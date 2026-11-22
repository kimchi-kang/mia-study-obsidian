import { formatTotalAnswerDuration } from "../core/answer-time";
import type { StudyHistory } from "../core/study-history";

function dateLabel(date: string): string {
  return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
}

function recallLabel(answerMs: number): string {
  return `떠올린 시간 ${formatTotalAnswerDuration(answerMs)}`;
}

/** 열(주)마다 그 주 월요일의 달. 달이 바뀌는 열에만 이름을 단다(첫 열은 다음 열과 달이 같을 때만). */
function monthLabels(days: StudyHistory["days"]): Array<string | null> {
  const months = Array.from({ length: days.length / 7 }, (_, column) => Number(days[column * 7]!.date.slice(5, 7)));
  return months.map((month, column) => {
    if (column === 0) return months[1] === month ? `${month}월` : null;
    return months[column - 1] !== month ? `${month}월` : null;
  });
}

export function renderStudyHistory(root: HTMLElement, history: StudyHistory): void {
  const { days, streak, longestStreak, today, week, activeDays, total } = history;
  const section = root.createEl("section", { cls: "mia-study-history" });
  section.createEl("h3", { cls: "mia-section-title", text: "학습 기록" });
  const tiles = section.createDiv({ cls: "mia-history-tiles" });
  for (const { label, value, note } of [
    { label: "연속 학습일", value: `${streak}일`, note: streak === 0 ? (total > 0 ? "오늘 학습하면 1일째" : "") : longestStreak > streak ? `최장 ${longestStreak}일` : "" },
    { label: "오늘", value: `${today.count}문제`, note: today.answerMs > 0 ? recallLabel(today.answerMs) : "" },
    { label: "최근 7일", value: `${week.count}문제`, note: week.answerMs > 0 ? recallLabel(week.answerMs) : "" },
  ]) {
    const tile = tiles.createDiv({ cls: "mia-history-tile" });
    tile.createSpan({ cls: "mia-muted", text: label });
    tile.createEl("strong", { text: value });
    if (note) tile.createEl("small", { cls: "mia-muted", text: note });
  }
  if (!total) {
    section.createEl("p", { cls: "mia-muted", text: "아직 학습 기록이 없습니다. 복습을 평가하면 여기에 날마다 쌓입니다." });
    return;
  }

  const weeks = days.length / 7;
  const calendar = section.createDiv({ cls: "mia-history-calendar" });
  const months = calendar.createDiv({ cls: "mia-history-months mia-muted", attr: { "aria-hidden": "true" } });
  monthLabels(days).forEach((label, column) => {
    if (label) months.createSpan({ text: label }).style.setProperty("--mia-month-column", String(column + 2));
  });
  const grid = calendar.createDiv({ cls: "mia-history-grid", attr: {
    role: "img", "aria-label": `최근 ${weeks}주 학습 기록: ${activeDays}일 동안 ${total}문제`,
  } });
  for (const text of ["월", "", "수", "", "금", "", ""]) {
    grid.createSpan({ cls: "mia-history-weekday mia-muted", text });
  }
  const todayIndex = days.reduce((last, day, index) => day.future ? last : index, -1);
  days.forEach(({ date, count, level, future }, index) => {
    const cls = ["mia-history-cell", future ? "mia-history-future" : "", index === todayIndex ? "mia-history-today" : ""].filter(Boolean).join(" ");
    grid.createSpan({ cls, attr: { "data-level": String(level), "data-index": String(index), title: `${dateLabel(date)} · ${count ? `${count}문제` : "기록 없음"}` } });
  });

  // 휴대폰은 마우스를 올릴 수 없으므로, 칸을 누르면 그날 기록을 격자 아래 한 줄로 보여 준다.
  const readout = calendar.createEl("p", { cls: "mia-history-readout mia-muted", text: "칸을 누르면 그날 기록이 보입니다.", attr: { "aria-live": "polite" } });
  grid.addEventListener("click", (event) => {
    const cell = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(".mia-history-cell:not(.mia-history-future)");
    if (!cell || !grid.contains(cell)) return;
    const day = days[Number(cell.dataset.index)];
    if (!day) return;
    grid.querySelector(".mia-history-selected")?.removeClass("mia-history-selected");
    cell.addClass("mia-history-selected");
    readout.setText(`${dateLabel(day.date)} · ${day.count ? `${day.count}문제${day.answerMs > 0 ? ` · ${recallLabel(day.answerMs)}` : ""}` : "기록 없음"}`);
  });

  const footer = calendar.createDiv({ cls: "mia-history-footer mia-muted" });
  const legend = footer.createDiv({ cls: "mia-history-legend" });
  legend.createSpan({ text: "적음" });
  for (const level of [1, 2, 3, 4]) {
    legend.createSpan({ cls: "mia-history-cell", attr: { "data-level": String(level), "aria-hidden": "true" } });
  }
  legend.createSpan({ text: "많음" });
  footer.createSpan({ text: `${weeks}주 합계 ${total}문제 · ${activeDays}일 학습` });

  const details = section.createEl("details", { cls: "mia-forecast-details" });
  details.createEl("summary", { text: "날짜별 학습량 보기" });
  const list = details.createEl("ul");
  for (const { date, count, answerMs } of days.filter(day => day.count > 0).reverse()) {
    list.createEl("li", { text: `${dateLabel(date)} · ${count}문제${answerMs > 0 ? ` · ${recallLabel(answerMs)}` : ""}` });
  }
}

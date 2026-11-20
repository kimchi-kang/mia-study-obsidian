import { App, Notice } from "obsidian";
import type { TargetDate } from "../core/models";
import { MAX_TARGET_LABEL_LENGTH, isTargetDate } from "../core/target-dates";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";

export class TargetDateModal extends KeyboardAwareModal {
  constructor(
    app: App,
    private readonly target: TargetDate | undefined,
    private readonly subjects: string[],
    private readonly save: (target: TargetDate) => Promise<void>,
  ) {
    super(app, "medium");
    this.modalEl.addClass("mia-target-date-modal");
    this.setTitle(target ? "목표일 편집" : "목표일 추가");
  }

  onOpen(): void {
    const form = this.contentEl.createEl("form", { cls: "mia-target-date-form" });
    const nameLabel = form.createEl("label", { text: "이름" });
    const name = nameLabel.createEl("input", { attr: { type: "text", required: "", placeholder: "예: 1차 면접" } });
    name.value = this.target?.label ?? "";
    const dateLabel = form.createEl("label", { text: "날짜" });
    const date = dateLabel.createEl("input", { attr: { type: "date", required: "" } });
    date.value = this.target?.date ?? "";
    const range = form.createEl("fieldset");
    range.createEl("legend", { text: "범위 과목" });
    range.createEl("p", { text: "과목을 선택하지 않으면 전체 과목을 포함합니다.", cls: "mia-muted" });
    const initial = new Set(this.target?.subjects);
    const choices = [...new Set([...this.subjects, ...initial])].map(subject => {
      const row = range.createEl("label", { cls: "mia-target-subject" });
      const input = row.createEl("input", { attr: { type: "checkbox" } });
      input.checked = initial.has(subject);
      row.createSpan({ text: subject });
      return { subject, input };
    });
    const actions = form.createDiv({ cls: "mia-inline-actions mia-keyboard-actions mia-target-actions" });
    actions.createEl("button", { text: "취소", attr: { type: "button" } }).onclick = () => this.close();
    const submit = actions.createEl("button", { text: "저장", attr: { type: "submit" } });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      const label = name.value.trim();
      if (!label || label.length > MAX_TARGET_LABEL_LENGTH || !isTargetDate(date.value)) {
        new Notice("이름을 1~40자로 입력하고 유효한 날짜를 선택하세요.");
        return;
      }
      const subjects = choices.filter(choice => choice.input.checked).map(choice => choice.subject);
      submit.disabled = true;
      try {
        await this.save({ id: this.target?.id ?? crypto.randomUUID(), label, date: date.value, ...(subjects.length ? { subjects } : {}) });
        this.close();
      } catch (error) {
        new Notice(`목표일 저장 실패: ${errorMessage(error)}`);
        submit.disabled = false;
      }
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

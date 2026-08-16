import { App, Notice, Setting } from "obsidian";
import { MAX_FOLLOW_UPS, normalizeFollowUpIds } from "../core/follow-up";
import { QuestionRecord } from "../core/models";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";

type RegisteredQuestion = QuestionRecord & { id: string };

export class FollowUpModal extends KeyboardAwareModal {
  private readonly selected: Set<string>;
  private bidirectional = false;
  private query = "";
  private subject = "all";

  constructor(
    app: App,
    private readonly base: RegisteredQuestion,
    private readonly questions: readonly RegisteredQuestion[],
    private readonly onSubmit: (ids: string[], bidirectional: boolean) => Promise<void>,
  ) {
    super(app);
    this.selected = new Set(normalizeFollowUpIds(base.id, base.followUpIds));
    this.setTitle("이어볼 질문 관리");
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: this.base.heading, cls: "mia-muted" });
    const toolbar = this.contentEl.createDiv({ cls: "mia-toolbar mia-filter-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "질문·답·키워드 검색" });
    const subject = toolbar.createEl("select", { attr: { "aria-label": "과목 필터" } });
    subject.createEl("option", { text: "전체 과목", value: "all" });
    [...new Set(this.questions.map((question) => question.subject))]
      .sort((left, right) => left.localeCompare(right, "ko"))
      .forEach((item) => subject.createEl("option", { text: item, value: item }));
    const counter = this.contentEl.createEl("p", { cls: "mia-muted" });
    new Setting(this.contentEl)
      .setName("양방향 연결")
      .setDesc("선택한 질문에도 현재 질문을 자동 연결하고, 해제한 양방향 연결은 함께 제거합니다.")
      .addToggle((toggle) => toggle.onChange((value) => { this.bidirectional = value; }));
    const list = this.contentEl.createDiv({ cls: "mia-followup-list" });
    let composing = false;

    const render = () => {
      list.empty();
      counter.setText(`${this.selected.size}/${MAX_FOLLOW_UPS}개 선택`);
      const needle = this.query.trim().toLocaleLowerCase("ko");
      const matches = this.questions.filter((question) => {
        if (question.id === this.base.id) return false;
        if (this.subject !== "all" && question.subject !== this.subject) return false;
        const text = [question.heading, question.questionMarkdown, question.answerMarkdown,
          ...question.coreKeywords.map((item) => item.label), ...question.subKeywords.map((item) => item.label)]
          .join("\n").toLocaleLowerCase("ko");
        return !needle || text.includes(needle);
      });
      for (const question of matches.slice(0, 300)) {
        const label = list.createEl("label", { cls: "mia-followup-option" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selected.has(question.id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked && this.selected.size >= MAX_FOLLOW_UPS) {
            checkbox.checked = false;
            new Notice(`이어볼 질문은 최대 ${MAX_FOLLOW_UPS}개까지 선택할 수 있습니다.`);
            return;
          }
          if (checkbox.checked) this.selected.add(question.id);
          else this.selected.delete(question.id);
          counter.setText(`${this.selected.size}/${MAX_FOLLOW_UPS}개 선택`);
        });
        const body = label.createSpan();
        body.createEl("strong", { text: question.heading });
        body.createEl("small", { text: `${question.subject} · ${question.questionType}` });
      }
      if (matches.length > 300) list.createEl("p", { text: `검색 결과 ${matches.length}개 중 300개만 표시합니다. 검색어를 더 구체적으로 입력하세요.`, cls: "mia-muted" });
      if (!matches.length) list.createEl("p", { text: "연결할 수 있는 질문이 없습니다.", cls: "mia-empty" });
    };

    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; this.query = search.value; render(); });
    search.addEventListener("input", () => { if (!composing) { this.query = search.value; render(); } });
    subject.addEventListener("change", () => { this.subject = subject.value; render(); });
    render();

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("취소").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("연결 저장").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.onSubmit([...this.selected], this.bidirectional);
          this.close();
        } catch (error) {
          new Notice(`질문 연결 저장 실패: ${errorMessage(error)}`);
          button.setDisabled(false);
        }
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}

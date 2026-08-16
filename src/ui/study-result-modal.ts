import { App, Modal } from "obsidian";

export interface StudyResult {
  total: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  skipped: number;
  durationSeconds: number;
}

export class StudyResultModal extends Modal {
  constructor(
    app: App,
    private readonly result: StudyResult,
    private readonly onRestart: () => void,
    private readonly onReturn: () => void,
  ) {
    super(app);
    this.setTitle("학습 완료");
  }

  onOpen(): void {
    this.modalEl.addClass("mia-result-modal");
    const grid = this.contentEl.createDiv({ cls: "mia-stats" });
    const values: Array<[string, number | string]> = [
      ["전체", this.result.total], ["못 암기", this.result.again], ["애매", this.result.hard],
      ["암기", this.result.good], ["너무 쉬움", this.result.easy], ["건너뜀", this.result.skipped],
      ["소요 시간", `${Math.floor(this.result.durationSeconds / 60)}분 ${this.result.durationSeconds % 60}초`],
    ];
    for (const [label, value] of values) {
      const card = grid.createDiv({ cls: "mia-stat" });
      card.createEl("strong", { text: String(value) });
      card.createEl("span", { text: label });
    }
    const actions = this.contentEl.createDiv({ cls: "mia-inline-actions mia-result-actions" });
    actions.createEl("button", { text: "같은 범위 다시 학습", cls: "mod-cta" }).addEventListener("click", () => {
      this.close();
      this.onRestart();
    });
    actions.createEl("button", { text: "시작 화면으로 돌아가기" }).addEventListener("click", () => {
      this.close();
      this.onReturn();
    });
  }

  onClose(): void {
    this.modalEl.removeClass("mia-result-modal");
    this.contentEl.empty();
  }
}

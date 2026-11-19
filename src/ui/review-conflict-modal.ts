import { App, Modal } from "obsidian";
import type { QuestionReviewState } from "../core/models";
import { confirmConflictDeletion } from "./conflict-delete-confirmation";

type ReviewArchives = Readonly<Record<string, QuestionReviewState[]>>;
const deletionDescription = "현재 평가 기록은 그대로 두고, 보관된 다른 기기 이력만 지웁니다. 되돌릴 수 없습니다.";

export class ReviewConflictModal extends Modal {
  private busy = false;

  constructor(
    app: App, private readonly conflicts: ReviewArchives, private readonly titleFor: (id: string) => string,
    private readonly dismiss: (expected: ReviewArchives, all: boolean) => Promise<void>,
  ) { super(app); }
  onOpen(): void {
    this.setTitle("기기 간 평가 차이");
    this.modalEl.classList.add("mia-preview-modal", "mia-recovery-modal");
    this.contentEl.createEl("p", { text: "문제별로 마지막 수정 기록을 적용했습니다. 서로 다른 평가 이력은 아래에 별도로 보관하며, 자동으로 섞지 않습니다. 취소·초기화 뒤 늦게 도착한 이력도 보관되며 현재 평가로 되살리지 않습니다. 기기의 시계가 다르면 마지막 수정 판단에 영향을 줄 수 있습니다." });
    for (const [id, reviews] of Object.entries(this.conflicts)) {
      this.contentEl.createEl("h3", { text: this.titleFor(id) });
      for (const review of reviews) {
        const detail = this.contentEl.createEl("details");
        detail.createEl("summary", { text: `${review.card.last_review ? new Date(review.card.last_review).toLocaleString("ko-KR") : "이전 기록"} · 평가 ${review.history.length}회 · 복습 ${new Date(review.card.due).toLocaleString("ko-KR")}` });
        const list = detail.createEl("ol");
        for (const entry of review.history) list.createEl("li", { text: `${new Date(entry.review).toLocaleString("ko-KR")} · ${["", "못 암기", "애매", "암기", "너무 쉬움"][entry.rating] ?? "평가"}` });
      }
      const actions = this.contentEl.createDiv({ cls: "mia-inline-actions" });
      this.addDeleteButton(actions, "이 보관 기록 지우기", { [id]: reviews }, false);
    }
    const actions = this.contentEl.createDiv({ cls: "mia-inline-actions" });
    this.addDeleteButton(actions, "보관 기록 모두 지우기", this.conflicts, true);
    actions.createEl("button", { text: "닫기" }).addEventListener("click", () => this.close());
  }

  private addDeleteButton(parent: HTMLElement, label: string, expected: ReviewArchives, all: boolean): void {
    parent.createEl("button", { text: label, cls: "mod-warning" }).addEventListener("click", () => {
      if (this.busy) return;
      confirmConflictDeletion(this.app, label, deletionDescription, async () => {
        await this.dismiss(expected, all);
        this.close();
      }, busy => {
        this.busy = busy;
        for (const button of this.contentEl.querySelectorAll("button")) button.disabled = busy;
      });
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

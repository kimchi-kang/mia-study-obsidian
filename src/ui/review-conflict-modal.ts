import { App, Modal } from "obsidian";
import { QuestionReviewState } from "../core/models";

export class ReviewConflictModal extends Modal {
  constructor(app: App, private readonly conflicts: Readonly<Record<string, QuestionReviewState[]>>, private readonly titleFor: (id: string) => string) { super(app); }
  onOpen(): void {
    this.setTitle("기기 간 평가 차이");
    this.modalEl.addClass("mia-preview-modal");
    this.contentEl.createEl("p", { text: "문제별로 마지막 수정 기록을 적용했습니다. 서로 다른 평가 이력은 아래에 별도로 보관하며, 자동으로 섞지 않습니다. 기기의 시계가 다르면 마지막 수정 판단에 영향을 줄 수 있습니다." });
    for (const [id, reviews] of Object.entries(this.conflicts)) {
      this.contentEl.createEl("h3", { text: this.titleFor(id) });
      for (const review of reviews) {
        const detail = this.contentEl.createEl("details");
        detail.createEl("summary", { text: `${review.card.last_review ? new Date(review.card.last_review).toLocaleString("ko-KR") : "이전 기록"} · 평가 ${review.history.length}회 · 복습 ${new Date(review.card.due).toLocaleString("ko-KR")}` });
        const list = detail.createEl("ol");
        for (const entry of review.history) list.createEl("li", { text: `${new Date(entry.review).toLocaleString("ko-KR")} · ${["", "못 암기", "애매", "암기", "너무 쉬움"][entry.rating] ?? "평가"}` });
      }
    }
    this.contentEl.createEl("button", { text: "닫기" }).addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

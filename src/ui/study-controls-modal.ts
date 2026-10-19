import { Modal } from "obsidian";

export class StudyControlsModal extends Modal {
  onOpen(): void {
    this.setTitle("학습 조작 안내");
    this.modalEl.addClass("mia-controls-modal");
    this.contentEl.createEl("h3", { text: "맥 · 키보드와 트랙패드" });
    this.contentEl.createEl("p", { text: "Space 정답 보기 · 1–4 평가 · ← → 문제 이동 · U 직전 평가 취소. 긴 답안은 트랙패드로 스크롤하세요." });
    this.contentEl.createEl("h3", { text: "폰 · 패드" });
    this.contentEl.createEl("p", { text: "질문 카드 가운데를 왼쪽으로 밀면 다음 문제, 오른쪽으로 밀면 이전 문제입니다. 평가하지 않고 이동하며, 하단 이전·다음 버튼으로도 같은 조작을 할 수 있습니다." });
    this.contentEl.createEl("p", { text: "위아래 스크롤·두 손가락 확대·글자 선택은 그대로 사용할 수 있습니다. 버튼·링크·수식·그림 위와 화면 가장자리에서는 문제 이동을 시작하지 않습니다." });
    this.contentEl.createEl("p", { text: "패드는 가로·세로·분할 화면의 실제 창 너비에 맞춰 배치됩니다. 키보드를 연결하면 맥과 같은 단축키를 사용할 수 있습니다." });
    this.contentEl.createEl("button", { text: "확인", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

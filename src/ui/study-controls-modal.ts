import { Modal } from "obsidian";

export class StudyControlsModal extends Modal {
  onOpen(): void {
    this.setTitle("학습 조작 안내");
    this.modalEl.addClass("mia-controls-modal");
    this.contentEl.createEl("h3", { text: "맥 · 키보드와 트랙패드" });
    this.contentEl.createEl("p", { text: "Space 정답 보기 · 1–4 평가 · ← → 문제 이동 · U 직전 평가 취소. 긴 답안은 트랙패드로 스크롤하세요." });
    this.contentEl.createEl("h3", { text: "폰 · 패드" });
    this.contentEl.createEl("p", { text: "화면 왼쪽 가장자리에서 중앙 방향으로 쓸면 학습을 시작한 화면으로 돌아갑니다. 문제 이동은 하단 이전·다음 버튼을 사용하세요. 이동만으로 평가를 저장하지는 않습니다." });
    this.contentEl.createEl("p", { text: "위아래 스크롤·두 손가락 확대·글자 선택은 그대로 사용할 수 있습니다. 버튼·링크·수식·표·코드·그림 위에서는 뒤로가기를 시작하지 않습니다. 보기 설정에서 뒤로가기 제스처와 민감도를 조정할 수 있습니다." });
    this.contentEl.createEl("p", { text: "패드는 가로·세로·분할 화면의 실제 창 너비에 맞춰 배치됩니다. 키보드를 연결하면 맥과 같은 단축키를 사용할 수 있습니다." });
    this.contentEl.createEl("h3", { text: "평가와 다음 학습" });
    this.contentEl.createEl("p", { text: "애매는 기억했지만 어려웠을 때 선택합니다. 기본 학습 간격 1분·10분에서는 두 번째 단계에서도 6분 후 반복합니다. 단계를 바꾸거나 평가별 고정 간격을 지정하면 달라집니다. 정확한 다음 간격은 평가 버튼에 표시됩니다." });
    this.contentEl.createEl("p", { text: "24시간 이상인 학습 단계가 선택되면 복습 상태로 전환됩니다. 학습 설정에서 단계별 안내를 확인하세요. 정답 보기와 문제 이동만으로는 복습일이 바뀌지 않고, 두 학습 모드 모두 평가 버튼을 누르면 저장합니다." });
    this.contentEl.createEl("button", { text: "확인", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

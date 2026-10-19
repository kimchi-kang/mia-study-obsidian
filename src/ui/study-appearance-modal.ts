import { Modal, Notice, Setting } from "obsidian";
import { StudyAppearance, StudyUiStore } from "../services/study-ui-store";
import { errorMessage } from "./error-message";

export class StudyAppearanceModal extends Modal {
  constructor(app: Modal["app"], private readonly store: StudyUiStore, private readonly onChange: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.setTitle("보기 설정");
    this.modalEl.addClass("mia-appearance-modal");
    this.contentEl.createEl("p", { text: "이 기기에서만 기억합니다. 다른 기기의 보기 설정은 바뀌지 않습니다.", cls: "mia-muted" });
    new Setting(this.contentEl).setName("글자 크기").addDropdown((dropdown) => {
      dropdown.addOption("small", "작게").addOption("medium", "보통").addOption("large", "크게").setValue(this.store.appearance.size);
      dropdown.onChange((value) => { if (value === "small" || value === "medium" || value === "large") this.apply({ size: value }); });
    });
    new Setting(this.contentEl).setName("정보량").setDesc("간결하게: 질문·답안에 집중합니다. 자세하게: 키워드와 이어볼 문제도 함께 표시합니다.").addDropdown((dropdown) => {
      dropdown.addOption("compact", "간결하게").addOption("detailed", "자세하게").setValue(this.store.appearance.density);
      dropdown.onChange((value) => { if (value === "compact" || value === "detailed") this.apply({ density: value }); });
    });
    new Setting(this.contentEl).setName("집중 모드").setDesc("학습 중 상단 메뉴를 접어 읽는 공간을 넓힙니다.").addToggle((toggle) => {
      toggle.setValue(this.store.appearance.focus).onChange((value) => this.apply({ focus: value }));
    });
    new Setting(this.contentEl).setName("답안 배치").setDesc("나란히 보기는 넓은 창에서 적용됩니다. 좁아지면 자동으로 한 열로 돌아옵니다.").addDropdown((dropdown) => {
      dropdown.addOption("stacked", "위아래로").addOption("split", "나란히").setValue(this.store.appearance.answerLayout);
      dropdown.onChange((value) => { if (value === "stacked" || value === "split") this.apply({ answerLayout: value }); });
    });
    new Setting(this.contentEl).setName("쓸어넘겨 문제 이동").addToggle((toggle) => {
      toggle.setValue(this.store.appearance.swipeEnabled).onChange((value) => this.apply({ swipeEnabled: value }));
    });
    new Setting(this.contentEl).setName("쓸어넘기기 민감도").addDropdown((dropdown) => {
      dropdown.addOption("light", "가볍게").addOption("normal", "기본").addOption("firm", "확실하게").setValue(this.store.appearance.swipeSensitivity);
      dropdown.onChange((value) => { if (value === "light" || value === "normal" || value === "firm") this.apply({ swipeSensitivity: value }); });
    });
    this.contentEl.createEl("button", { text: "닫기", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }
  private apply(patch: Partial<StudyAppearance>): void {
    try { this.store.updateAppearance(patch); this.onChange(); }
    catch (error) { this.onOpen(); new Notice(`보기 설정 저장 실패: ${errorMessage(error)}`); }
  }
  onClose(): void { this.contentEl.empty(); }
}

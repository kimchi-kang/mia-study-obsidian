import { Modal, Notice, Setting } from "obsidian";
import { StudyAppearance, StudyUiStore } from "../services/study-ui-store";
import { errorMessage } from "./error-message";

export class StudyAppearanceModal extends Modal {
  private draft!: StudyAppearance;
  private initial = "";
  private saveButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;

  open(): void {
    super.open();
    // Opening a dialog must not make the first option look newly selected.
    this.modalEl.tabIndex = -1;
    this.modalEl.focus({ preventScroll: true });
  }

  constructor(app: Modal["app"], private readonly store: StudyUiStore, private readonly onChange: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.draft = this.store.appearance;
    this.initial = JSON.stringify(this.draft);
    this.setTitle("보기 설정");
    this.modalEl.addClass("mia-appearance-modal");
    this.contentEl.createEl("p", { text: "현재 저장된 값을 보여줍니다. 변경 후 저장하면 이 기기에만 적용됩니다.", cls: "mia-muted" });
    new Setting(this.contentEl).setName("글자 크기").addDropdown((dropdown) => {
      dropdown.addOption("small", "작게").addOption("medium", "보통").addOption("large", "크게").setValue(this.draft.size);
      dropdown.onChange((value) => { if (value === "small" || value === "medium" || value === "large") this.change({ size: value }); });
    });
    new Setting(this.contentEl).setName("정보량").setDesc("간결하게: 질문·답안에 집중합니다. 자세하게: 키워드와 이어볼 문제도 함께 표시합니다.").addDropdown((dropdown) => {
      dropdown.addOption("compact", "간결하게").addOption("detailed", "자세하게").setValue(this.draft.density);
      dropdown.onChange((value) => { if (value === "compact" || value === "detailed") this.change({ density: value }); });
    });
    this.toggle("focus", "집중 모드", "학습 중 상단 메뉴를 접습니다. 기본값은 꺼짐입니다.");
    new Setting(this.contentEl).setName("답안 배치").setDesc("나란히 보기는 넓은 창에서 적용됩니다. 좁아지면 자동으로 한 열로 돌아옵니다.").addDropdown((dropdown) => {
      dropdown.addOption("stacked", "위아래로").addOption("split", "나란히").setValue(this.draft.answerLayout);
      dropdown.onChange((value) => { if (value === "stacked" || value === "split") this.change({ answerLayout: value }); });
    });
    new Setting(this.contentEl).setName("암기 모드 순서").setDesc("새 학습부터 적용합니다. 순서대로는 문제 목록 순서를 따릅니다.").addDropdown((dropdown) => {
      dropdown.addOption("sequential", "순서대로").addOption("random", "랜덤").setValue(this.draft.memorizationOrder);
      dropdown.onChange((value) => { if (value === "sequential" || value === "random") this.change({ memorizationOrder: value }); });
    });
    this.toggle("swipeEnabled", "쓸어서 뒤로가기", "터치 화면에서 왼쪽 가장자리를 쓸면 돌아갑니다. 기본값은 켜짐입니다.");
    new Setting(this.contentEl).setName("쓸어넘기기 민감도").addDropdown((dropdown) => {
      dropdown.addOption("light", "가볍게").addOption("normal", "기본").addOption("firm", "확실하게").setValue(this.draft.swipeSensitivity);
      dropdown.onChange((value) => { if (value === "light" || value === "normal" || value === "firm") this.change({ swipeSensitivity: value }); });
    });
    this.status = this.contentEl.createEl("p", { text: "변경한 내용이 없습니다.", cls: "mia-muted mia-appearance-status" });
    this.status.setAttribute("role", "status");
    const actions = this.contentEl.createDiv({ cls: "mia-appearance-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    this.saveButton = actions.createEl("button", { text: "보기 설정 저장", cls: "mod-cta" });
    this.saveButton.disabled = true;
    this.saveButton.addEventListener("click", () => {
      try { this.store.updateAppearance(this.draft); }
      catch (error) { new Notice(`보기 설정 저장 실패: ${errorMessage(error)}`); return; }
      this.onChange();
      this.close();
    });
  }

  private toggle(key: "focus" | "swipeEnabled", name: string, description: string): void {
    const row = new Setting(this.contentEl).setName(name).setDesc(description);
    const state = row.controlEl.createSpan({ cls: "mia-toggle-state", text: this.draft[key] ? "켜짐" : "꺼짐" });
    state.setAttribute("aria-hidden", "true");
    row.addToggle(toggle => {
      toggle.setValue(this.draft[key]).onChange(value => {
        this.change({ [key]: value });
        state.setText(value ? "켜짐" : "꺼짐");
      });
    });
  }

  private change(patch: Partial<StudyAppearance>): void {
    this.draft = { ...this.draft, ...patch };
    const dirty = this.initial !== JSON.stringify(this.draft);
    if (this.saveButton) this.saveButton.disabled = !dirty;
    this.status?.setText(dirty ? "아직 저장하지 않은 변경사항이 있습니다." : "변경한 내용이 없습니다.");
  }
  onClose(): void { this.saveButton = null; this.status = null; this.contentEl.empty(); }
}

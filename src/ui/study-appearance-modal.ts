import { AUTO_QUESTION_SECONDS, AUTO_ANSWER_SECONDS, parseAutoAdvance } from "../core/study-automation";
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

  constructor(app: Modal["app"], private readonly store: StudyUiStore, private readonly onChange: () => void, private readonly onClosed?: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.draft = this.store.appearance;
    this.initial = JSON.stringify(this.draft);
    this.setTitle("보기 설정");
    this.modalEl.addClass("mia-appearance-modal", "mia-setting-controls");
    this.contentEl.createEl("p", { text: "현재 저장된 값을 보여줍니다. 변경 후 저장하면 이 기기에만 적용됩니다.", cls: "mia-muted" });
    const screen = this.group("학습 화면");
    new Setting(screen).setName("글자 크기").addDropdown((dropdown) => {
      dropdown.addOption("small", "작게").addOption("medium", "보통").addOption("large", "크게").setValue(this.draft.size);
      dropdown.onChange((value) => { if (value === "small" || value === "medium" || value === "large") this.change({ size: value }); });
    });
    new Setting(screen).setName("정보량").setDesc("시험(일반복습)모드에만 적용합니다. 암기 모드는 항상 간결하게 표시합니다. 간결하게: 질문·답안에 집중합니다. 자세하게: 키워드와 이어볼 문제도 함께 표시합니다.").addDropdown((dropdown) => {
      dropdown.addOption("compact", "간결하게").addOption("detailed", "자세하게").setValue(this.draft.density);
      dropdown.onChange((value) => { if (value === "compact" || value === "detailed") this.change({ density: value }); });
    });
    this.toggle(screen, "focus", "집중 모드", "학습 중 상단 메뉴를 접습니다. 기본값은 꺼짐입니다.");
    this.toggle(screen, "answerTimer", "답변 타이머", "시험(일반복습)모드에서 정답을 볼 때까지 걸린 시간을 보여줍니다. 꺼도 시간은 기록됩니다. 기본값은 켜짐입니다.");
    new Setting(screen).setName("답안 배치").setDesc("나란히 보기는 넓은 창에서 적용됩니다. 좁아지면 자동으로 한 열로 돌아옵니다.").addDropdown((dropdown) => {
      dropdown.addOption("stacked", "위아래로").addOption("split", "나란히").setValue(this.draft.answerLayout);
      dropdown.onChange((value) => { if (value === "stacked" || value === "split") this.change({ answerLayout: value }); });
    });
    new Setting(this.group("암기 모드")).setName("암기 모드 순서").setDesc("새 학습부터 적용합니다. 순서대로는 문제 목록 순서를 따릅니다.").addDropdown((dropdown) => {
      dropdown.addOption("sequential", "순서대로").addOption("random", "랜덤").setValue(this.draft.memorizationOrder);
      dropdown.onChange((value) => { if (value === "sequential" || value === "random") this.change({ memorizationOrder: value }); });
    });
    const touch = this.group("터치 조작");
    this.toggle(touch, "swipeEnabled", "쓸어서 뒤로가기", "터치 화면에서 왼쪽 가장자리를 쓸면 돌아갑니다. 기본값은 켜짐입니다.");
    new Setting(touch).setName("쓸어넘기기 민감도").addDropdown((dropdown) => {
      dropdown.addOption("light", "가볍게").addOption("normal", "기본").addOption("firm", "확실하게").setValue(this.draft.swipeSensitivity);
      dropdown.onChange((value) => { if (value === "light" || value === "normal" || value === "firm") this.change({ swipeSensitivity: value }); });
    });
    const auto = this.group("자동 진행");
    for (const [key, name, description, values] of [
      ["autoQuestionSeconds", "질문 시간", "시험(일반복습)모드에서 이 시간이 지나면 정답을 자동으로 보여줍니다. 기본값은 끔입니다.", AUTO_QUESTION_SECONDS],
      ["autoAnswerSeconds", "정답 시간", "정답을 본 뒤 이 시간이 지나면 아래 동작을 하고 다음 문제로 넘어갑니다. 기본값은 끔입니다.", AUTO_ANSWER_SECONDS],
    ] as const) {
      new Setting(auto).setName(name).setDesc(description).addDropdown(dropdown => {
        for (const seconds of values) dropdown.addOption(String(seconds), seconds ? `${seconds}초` : "끔");
        dropdown.setValue(String(this.draft[key] ?? 0)).onChange(value => this.change(parseAutoAdvance({ ...this.draft, [key]: Number(value) })));
      });
    }
    new Setting(auto).setName("정답 후 동작").setDesc("평가 없이 넘어가면 다음 복습 일정이 바뀌지 않습니다.").addDropdown(dropdown => {
      dropdown.addOption("skip", "건너뛰기").addOption("again", "못 암기로 평가").setValue(this.draft.autoAnswerAction ?? "skip");
      dropdown.onChange(value => this.change({ autoAnswerAction: value === "again" ? "again" : "skip" }));
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
      this.close();
      this.onChange();
    });
  }

  /** A titled card that holds related rows. */
  private group(title: string): HTMLElement {
    const section = this.contentEl.createDiv({ cls: "mia-settings-group" });
    section.createEl("h4", { text: title, cls: "mia-settings-group-title" });
    return section.createDiv({ cls: "mia-settings-list" });
  }

  private toggle(parent: HTMLElement, key: "focus" | "swipeEnabled" | "answerTimer", name: string, description: string): void {
    const row = new Setting(parent).setName(name).setDesc(description);
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
  close(): void {
    super.close();
    this.onClosed?.();
  }
}

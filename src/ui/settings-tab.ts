import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { MiaSettings } from "../core/models";
import type MiaStudyPlugin from "../main";
import { configuredPath, parseSettings } from "../services/data-store";
import { errorMessage } from "./error-message";
import { bindKeyboardViewport, KeyboardViewportBinding } from "./mobile-keyboard";
import { dialogKey } from "./modal-open-guard";
import { requestPluginUpdate } from "./plugin-update";
import { StudyManagementModal } from "./study-management-modal";
import { PORTABLE_SYNC_INCOMPLETE_WARNING } from "../services/portable-study-storage";

export class MiaSettingTab extends PluginSettingTab {
  private settingsWrites: Promise<void> = Promise.resolve();
  private keyboardViewport: KeyboardViewportBinding | null = null;
  private folderCommits: Array<() => void> = [];
  private studyModal: StudyManagementModal | null = null;
  private openStudyButton: HTMLElement | null = null;

  constructor(app: App, private readonly miaPlugin: MiaStudyPlugin) {
    super(app, miaPlugin);
  }

  display(): void {
    const { containerEl } = this;
    let settings = structuredClone(this.miaPlugin.store.settings);
    this.folderCommits = [];
    const bindFolder = (input: HTMLInputElement | HTMLTextAreaElement, key: "sourceRoots" | "keywordFolder", label: string) => {
      const displayValue = (value: MiaSettings) => key === "sourceRoots" ? value.sourceRoots.join("\n") : value.keywordFolder;
      let submitted = input.value;
      const commit = () => {
        const raw = input.value;
        if (raw === submitted) return;
        submitted = raw;
        return this.save(async () => {
          const store = this.miaPlugin.store;
          const before = displayValue(store.settings);
          try {
            const roots = key === "sourceRoots" ? raw.split("\n").map(line => line.trim()) : [];
            const invalid = key === "sourceRoots"
              ? roots.find(line => line && configuredPath(line, true) === null)
              : raw.trim() && configuredPath(raw) === null ? raw : undefined;
            if (invalid) {
              new Notice(`“${invalid}”은(는) 사용할 수 없는 폴더라 이전 값 “${before}”을 유지합니다.`);
              return;
            }
            const patch = key === "sourceRoots" ? { sourceRoots: roots } : { keywordFolder: raw };
            if (displayValue(parseSettings({ ...settings, ...patch })) !== before) {
              try { await store.updateSettings(patch, settings); }
              finally { settings = structuredClone(store.settings); }
            }
            const saved = displayValue(store.settings);
            if (raw !== saved) new Notice(`${label}에 입력한 “${raw || "(비어 있음)"}” 대신 “${saved || "(비어 있음)"}”을 사용합니다.`);
            if (key === "sourceRoots" && before !== saved) await this.miaPlugin.index.rebuild();
          } finally {
            if (input.value === raw && submitted === raw) input.value = submitted = displayValue(store.settings);
          }
        }, false);
      };
      input.addEventListener("change", commit);
      this.folderCommits.push(commit);
    };
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    containerEl.empty();
    containerEl.addClass("mia-keyboard-settings", "mia-setting-controls");
    containerEl.createEl("h2", { text: "Major Study" });
    containerEl.createEl("p", { text: "노트 내용과 FSRS 복습 기록은 분리됩니다. 등록 명령을 실행하기 전에는 원문을 수정하지 않습니다.", cls: "setting-item-description" });

    // 보관함 폴더: 입력을 마치면 바로 저장한다. 폴더 행은 설정 탭 바로 아래 줄에 둔다.
    containerEl.createEl("h3", { text: "보관함 폴더" });
    containerEl.createEl("p", { text: "입력을 마치면 바로 저장됩니다.", cls: "setting-item-description" });
    new Setting(containerEl).setName("문제 폴더").setDesc("한 줄에 하나. 비워 두면 보관함 전체에서 [!question]을 찾습니다.").addTextArea((text) => {
      text.setPlaceholder("지리학\n통계이론").setValue(settings.sourceRoots.join("\n"));
      text.inputEl.setAttr("aria-label", "문제 폴더");
      bindFolder(text.inputEl, "sourceRoots", "문제 폴더");
    });
    new Setting(containerEl).setName("키워드 노트 폴더").setDesc("키워드 링크를 만들 때 기준으로 표시할 폴더입니다.").addText((text) => {
      text.setValue(settings.keywordFolder);
      text.inputEl.setAttr("aria-label", "키워드 노트 폴더");
      bindFolder(text.inputEl, "keywordFolder", "키워드 노트 폴더");
    });

    // 학습 설정·동기화: 학습 화면의 '학습 설정'과 같은 창을 연다. 저장은 그 창 안에서만 한다.
    containerEl.createEl("h3", { text: "학습 설정 · 기기 동기화" });
    const management = settings.studyManagement;
    const sync = this.miaPlugin.portableSyncActive ? "일반 보관함 폴더 사용 중" : "기존 플러그인 폴더 사용 중";
    new Setting(containerEl).setName("학습 설정")
      .setDesc(`하루 새 문제 ${management.newCardsPerDay}개 · 복습 ${management.reviewsPerDay}회 · 목표 기억률 ${Number((settings.targetRetention * 100).toFixed(10))}% · 최대 복습 간격 ${settings.maximumIntervalDays}일 · 동기화: ${sync}. 학습 화면의 ‘학습 설정’과 같은 창이 열리며, 내 기기 간 동기화도 그 창 맨 아래에 있습니다.`)
      .addButton((button) => {
        button.setButtonText("학습 설정 열기").setCta().onClick(() => this.openStudySettings());
        this.openStudyButton = button.buttonEl ?? null;
      });
    if (this.miaPlugin.portableSyncIncomplete) containerEl.createEl("p", { text: PORTABLE_SYNC_INCOMPLETE_WARNING, cls: "mia-warning", attr: { role: "alert" } });
    containerEl.createEl("p", { text: "글자 크기·암기 모드 순서 같은 보기 설정은 학습 화면의 ‘보기 설정’에서 바꿉니다.", cls: "setting-item-description" });

    containerEl.createEl("h3", { text: "플러그인 정보" });
    new Setting(containerEl).setName("업데이트 확인").setDesc(`현재 버전 ${this.miaPlugin.manifest.version}. BRAT으로 새 버전을 확인하고 설치합니다. BRAT이 없으면 설치 안내의 수동 업데이트를 따르세요.`).addButton((button) => {
      button.setButtonText("업데이트 확인").onClick(() => { requestPluginUpdate(this.app); });
    });
    this.keyboardViewport = bindKeyboardViewport(containerEl);
  }

  /**
   * 학습 화면과 같은 키를 써서 두 곳에서 동시에 열리지 않게 한다.
   * 저장하지 않고 닫아도 동기화 폴더는 이미 바뀌었을 수 있으므로, 닫힐 때마다 요약을 다시 그리고 버튼으로 초점을 돌려준다.
   */
  private openStudySettings(): void {
    this.miaPlugin.modalOpenGuard.open(dialogKey("study-management-settings"), () => {
      const modal = new StudyManagementModal(this.app, this.miaPlugin, () => undefined, () => {
        if (this.studyModal !== modal) return;
        this.studyModal = null;
        this.display();
        this.openStudyButton?.focus({ preventScroll: true });
      });
      this.studyModal = modal;
      return modal;
    });
  }

  hide(): void {
    // 설정 창을 닫으면 여기서 연 학습 설정 창도 닫아 진행 중인 최적화를 멈춘다.
    // 먼저 참조를 비워 닫힘 콜백이 숨겨지는 탭을 다시 그리지 않게 한다.
    const modal = this.studyModal;
    this.studyModal = null;
    modal?.close();
    this.folderCommits.forEach(commit => commit());
    this.folderCommits = [];
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    this.containerEl.removeClass("mia-keyboard-settings");
    super.hide();
  }

  private save(action: () => Promise<void>, refreshOnFailure = true): Promise<void> {
    const write = this.settingsWrites.then(async () => {
      try { await action(); }
      catch (error) {
        new Notice(`Major Study 설정 저장 실패: ${errorMessage(error)}`);
        if (refreshOnFailure) this.display();
      }
    });
    this.settingsWrites = write.catch(() => undefined);
    return write;
  }
}

import { Notice } from "obsidian";
import type MiaStudyPlugin from "../main";
import { PORTABLE_STUDY_FOLDER } from "../services/portable-study-storage";
import { errorMessage } from "./error-message";

export function renderDeviceSyncSettings(container: HTMLElement, plugin: MiaStudyPlugin): void {
  const section = container.createDiv({ cls: "mia-device-sync-settings" });
  section.createEl("h3", { text: "내 기기 간 동기화" });
  section.createEl("p", { text: `Windows·Android 등에서도 학습 기록을 함께 쓰려면 ${PORTABLE_STUDY_FOLDER} 폴더를 사용할 수 있습니다. 숨김 설정 폴더 대신 일반 노트와 함께 동기화됩니다.`, cls: "setting-item-description" });
  section.createEl("p", { text: "모든 기기에서 같은 최신 MIA를 사용하고, 같은 보관함을 동기화하세요. 폴더를 만든 뒤 다른 기기에서는 파일 수신을 마치고 MIA를 다시 시작하세요. 동기화 서비스 연결은 별도로 필요합니다. 학습 설정을 수정 중이면 먼저 저장하세요.", cls: "setting-item-description" });
  const status = section.createEl("p", { text: plugin.portableSyncActive ? "일반 보관함 폴더 사용 중" : "현재는 기존 플러그인 폴더를 사용 중입니다.", cls: "mia-muted" });
  status.setAttribute("role", "status");
  const button = section.createEl("button", { text: "범용 동기화 폴더 사용", attr: { type: "button" } });
  button.disabled = plugin.portableSyncActive;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await plugin.enablePortableSync();
      status.setText("일반 보관함 폴더 사용 중 · 기존 파일은 보존했습니다.");
      new Notice("범용 동기화 폴더를 준비했습니다. 다른 기기에도 이 폴더를 동기화하세요.");
    } catch (error) {
      status.setText(`동기화 폴더 준비 실패: ${errorMessage(error)}`);
      new Notice(status.textContent ?? "동기화 폴더 준비 실패");
      button.disabled = false;
    }
  });
}

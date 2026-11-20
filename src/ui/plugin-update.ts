import { App, Notice } from "obsidian";

/** BRAT(obsidian42-brat)의 "모든 베타 플러그인 업데이트 확인 후 설치" 명령 ID. 실제 다운로드·설치는 BRAT이 맡는다. */
export const BRAT_UPDATE_COMMAND = "obsidian42-brat:checkForUpdatesAndUpdate";

interface CommandRegistry { executeCommandById?: (id: string) => boolean }

/** BRAT 업데이트 명령을 실행한다. BRAT이 없거나 꺼져 있으면 안내만 하고 false를 돌려준다. */
export function requestPluginUpdate(app: App): boolean {
  const commands = (app as unknown as { commands?: CommandRegistry }).commands;
  let started = false;
  try { started = commands?.executeCommandById?.(BRAT_UPDATE_COMMAND) === true; }
  catch { started = false; }
  if (!started) {
    new Notice("BRAT이 설치·활성화되어 있지 않아 업데이트를 확인할 수 없습니다. BRAT을 켜거나 설치 안내의 수동 업데이트를 따라 주세요.", 10000);
    return false;
  }
  new Notice("BRAT으로 업데이트를 확인합니다. 새 버전을 설치하면 BRAT이 결과를 알려 줍니다.");
  return true;
}

import { describe, expect, it, vi } from "vitest";

const notices = [];
vi.mock("obsidian", () => ({ Notice: class { constructor(text) { notices.push(text); } } }));
const { BRAT_UPDATE_COMMAND, requestPluginUpdate } = await import("../src/ui/plugin-update");

describe("BRAT 업데이트 버튼", () => {
  it("BRAT 업데이트 명령을 실행하고 안내한다", () => {
    notices.length = 0;
    const executeCommandById = vi.fn(() => true);
    expect(requestPluginUpdate({ commands: { executeCommandById } })).toBe(true);
    expect(executeCommandById).toHaveBeenCalledWith(BRAT_UPDATE_COMMAND);
    expect(BRAT_UPDATE_COMMAND).toBe("obsidian42-brat:checkForUpdatesAndUpdate");
    expect(notices.at(-1)).toContain("BRAT으로 업데이트를 확인합니다");
  });

  it.each([
    ["명령이 없음(BRAT 꺼짐)", { commands: { executeCommandById: () => false } }],
    ["명령 레지스트리 없음", {}],
    ["명령 실행 오류", { commands: { executeCommandById: () => { throw new Error("x"); } } }],
  ])("%s이면 실패 안내만 한다", (_name, app) => {
    notices.length = 0;
    expect(requestPluginUpdate(app)).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("BRAT이 설치·활성화되어 있지 않아");
  });
});

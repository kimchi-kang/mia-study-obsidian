import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => ({
  ...(await import("./fixtures/slim-layout-obsidian")).slimLayoutBoundary(),
  Notice: class { constructor(message) { notices.push(message); } },
}));
import { createLayoutDom, renderLayoutCase } from "./fixtures/study-layout-render";
import { ModalOpenGuard } from "../src/ui/modal-open-guard";
import { DEFAULT_PLUGIN_DATA, DEFAULT_SETTINGS } from "../src/core/models";
import { ReviewConflictModal } from "../src/ui/review-conflict-modal";
import { SettingsConflictModal } from "../src/ui/settings-conflict-modal";
import { MiaDataStore } from "../src/services/data-store";
import { FsrsService } from "../src/core/fsrs-service";

let dom;
const notices = [];
const review = new FsrsService(DEFAULT_SETTINGS).rate(undefined, 1, new Date("2026-11-14T00:00:00Z"));
const alternate = { id: "older", ancestors: [], settings: { ...DEFAULT_SETTINGS, targetRetention: .8 } };
const action = (root, text) => [...root.querySelectorAll("button")].find(button => button.textContent === text);
const confirmation = () => document.querySelector(".mia-confirm-modal");

beforeEach(() => {
  dom = createLayoutDom();
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  notices.length = 0;
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it("cancels a question deletion, then confirms once and blocks duplicate actions while saving", async () => {
  let finish;
  const dismiss = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const modal = new ReviewConflictModal({}, { one: [review], two: [review] }, id => id, dismiss);
  modal.open();
  const remove = action(modal.contentEl, "이 보관 기록 지우기");
  remove.click();
  expect(confirmation().textContent).toContain("현재 평가 기록은 그대로 두고, 보관된 다른 기기 이력만 지웁니다. 되돌릴 수 없습니다.");
  action(confirmation(), "취소").click();
  expect(dismiss).not.toHaveBeenCalled();
  expect(remove.disabled).toBe(false);
  remove.click();
  const confirm = action(confirmation(), "지우기");
  confirm.click();
  confirm.dispatchEvent(new dom.window.Event("click")); // Even programmatic duplicate events are ignored.
  action(modal.contentEl, "보관 기록 모두 지우기").click();
  expect(dismiss).toHaveBeenCalledExactlyOnceWith({ one: [review] }, false);
  expect(remove.disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect(confirmation()).toBeNull());
});

it("reports failure, preserves the review modal, and allows retrying the confirmed action", async () => {
  const conflicts = { one: [review], two: [review] };
  const dismiss = vi.fn().mockRejectedValueOnce(new Error("저장 공간 부족")).mockResolvedValueOnce(undefined);
  const modal = new ReviewConflictModal({}, conflicts, id => id, dismiss);
  modal.open();
  action(modal.contentEl, "보관 기록 모두 지우기").click();
  const confirm = action(confirmation(), "지우기");
  confirm.click();
  await vi.waitFor(() => expect(notices.at(-1)).toContain("저장 공간 부족"));
  expect(modal.contentEl.querySelectorAll("details")).toHaveLength(2);
  expect(confirm.disabled).toBe(false);
  confirm.click();
  await vi.waitFor(() => expect(document.querySelector(".mia-recovery-modal")).toBeNull());
  expect(dismiss).toHaveBeenLastCalledWith(conflicts, true);
});

it("requires one confirmation for a settings copy and does not apply it", async () => {
  const apply = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(undefined);
  const modal = new SettingsConflictModal({}, DEFAULT_SETTINGS, [alternate], apply, dismiss);
  modal.open();
  const remove = action(modal.contentEl, "이 보관 사본 지우기");
  remove.click();
  action(confirmation(), "취소").click();
  expect(dismiss).not.toHaveBeenCalled();
  remove.click();
  action(confirmation(), "지우기").click();
  await vi.waitFor(() => expect(confirmation()).toBeNull());
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(alternate);
  expect(apply).not.toHaveBeenCalled();
});

it.each(["dashboard", "progress"])("clears the warning on %s after confirming all deletions", async route => {
  const { view, root } = await renderLayoutCase({ route });
  let disk = { ...structuredClone(DEFAULT_PLUGIN_DATA), reviewConflicts: { q: [review] } };
  const store = new MiaDataStore({ loadData: async () => structuredClone(disk), saveData: async value => { disk = structuredClone(value); } });
  await store.load();
  view.plugin.store = store;
  view.plugin.modalOpenGuard = new ModalOpenGuard();
  const unsubscribe = store.subscribe(() => view.renderAfterDataChange());
  view.render();
  expect(root.querySelector(".mia-sync-warning")).not.toBeNull();
  action(root, "보관된 평가 확인").click();
  action(document.querySelector(".mia-recovery-modal"), "보관 기록 모두 지우기").click();
  action(confirmation(), "지우기").click();
  await vi.waitFor(() => expect(root.querySelector(".mia-sync-warning")).toBeNull());
  expect(disk.reviewConflicts).toEqual({});
  unsubscribe();
  await view.onClose();
});

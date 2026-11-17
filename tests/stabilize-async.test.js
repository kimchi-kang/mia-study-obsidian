import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => {
  const { obsidianLayoutBoundary } = await import("./fixtures/study-layout-obsidian");
  return obsidianLayoutBoundary();
});
import { StudyUiStore } from "../src/services/study-ui-store";
import { createLayoutDom, renderLayoutCase } from "./fixtures/study-layout-render";
const saved = { queue: ["one", "two"], seed: ["one", "two"], skipped: [], queueIndex: 0, answerVisible: false, sessionMode: "recall", updatedAt: "2026-10-17T00:00:00Z" };
const envelope = resume => JSON.stringify({ version: 1, resume, updatedAt: resume.updatedAt });
let dom;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("resume read ordering", () => {
  it("keeps the latest read when an earlier cloud read completes last, including rollback after a failed save", async () => {
    const reads = [];
    const adapter = { exists: async () => true, read: () => new Promise(resolve => reads.push(resolve)), write: async () => { throw Error("disk full"); } };
    const store = new StudyUiStore({ vault: { adapter }, loadLocalStorage: () => null, saveLocalStorage() {} }, "ui-state.json");
    const first = store.load();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    const second = store.load();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    const latest = { ...saved, queueIndex: 1, updatedAt: "2026-10-18T00:00:00Z" };
    reads[1](envelope(latest)); await second;
    reads[0](envelope(saved)); await first;
    expect(store.resume).toEqual(latest);
    // A failed write must roll back to the latest committed read as well.
    adapter.read = async () => envelope(latest);
    await expect(store.saveResume({ ...latest, updatedAt: "2026-10-19T00:00:00Z" })).rejects.toThrow("disk full");
    expect(store.resume).toEqual(latest);
    expect(store.sharedSnapshot.updatedAt).toBe(latest.updatedAt);
  });
});

it.each(["closed", "rating"])("does not prune or save after refresh is interrupted by %s", async interruption => {
  dom = createLayoutDom(); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("window", dom.window);
  const { view } = await renderLayoutCase({ revealed: false });
  let finish;
  const loading = new Promise(resolve => { finish = resolve; });
  view.plugin.synchronizeStudyData = async () => {};
  view.plugin.studyUi.load = vi.fn(() => loading);
  const prune = vi.spyOn(view, "pruneExternallyRated").mockReturnValue(true);
  const save = vi.spyOn(view, "saveStudyPosition");
  const refresh = view.refreshAfterReturn();
  await Promise.resolve(); expect(view.plugin.studyUi.load).toHaveBeenCalledOnce();
  if (interruption === "closed") await view.onClose(); else view.isMutatingReview = true;
  finish(); await refresh;
  expect(prune).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(view.refreshingAfterReturn).toBe(false);
  if (interruption !== "closed") { view.isMutatingReview = false; await view.onClose(); }
});

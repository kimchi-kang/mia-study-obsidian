import { describe, expect, it, vi } from "vitest";
import { dialogKey, ModalOpenGuard, type OpenableModal } from "../src/ui/modal-open-guard";

function fakeModal(open = vi.fn()): OpenableModal {
  return { open, onClose: vi.fn() };
}

describe("modal re-entrancy guard", () => {
  it.each([
    ["question-add", dialogKey("managed-question-editor", "new")],
    ["question-edit", dialogKey("managed-question-editor", "mia-q-1")],
    ["connections", dialogKey("question-connections", "mia-q-1")],
    ["delete-confirmation", dialogKey("question-delete", "mia-q-1")],
  ])("opens one %s dialog for repeated calls, then allows it after close", (_label, key) => {
    const guard = new ModalOpenGuard();
    const modal = fakeModal();
    expect(guard.open(key, () => modal)).toBe(true);
    expect(guard.open(key, () => fakeModal())).toBe(false);
    expect(modal.open).toHaveBeenCalledOnce();

    modal.onClose?.();
    const reopened = fakeModal();
    expect(guard.open(key, () => reopened)).toBe(true);
    expect(reopened.open).toHaveBeenCalledOnce();
  });

  it("releases its key if opening throws", () => {
    const guard = new ModalOpenGuard();
    const failure = new Error("open failed");
    expect(() => guard.open(dialogKey("question-delete", "mia-q-1"), () => fakeModal(vi.fn(() => { throw failure; }))))
      .toThrow(failure);

    const reopened = fakeModal();
    expect(guard.open(dialogKey("question-delete", "mia-q-1"), () => reopened)).toBe(true);
    expect(reopened.open).toHaveBeenCalledOnce();
  });

  it("releases its key if asynchronous construction rejects", async () => {
    const guard = new ModalOpenGuard();
    const key = dialogKey("managed-question-editor", "new");
    await expect(guard.openAsync(key, async () => { throw new Error("construction failed"); })).rejects.toThrow("construction failed");
    const reopened = fakeModal();
    await expect(guard.openAsync(key, () => reopened)).resolves.toBe(true);
    expect(reopened.open).toHaveBeenCalledOnce();
  });
});

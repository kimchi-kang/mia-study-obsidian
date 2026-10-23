import { describe, expect, it, vi } from "vitest";
import { bindStudyGestures } from "../src/ui/study-gestures";

function setup() {
  const listeners = new Map(); const properties = new Map();
  const state = { enabled: true, selected: false, blocked: false };
  const card = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) }, getBoundingClientRect: () => ({ left: 20, right: 380, width: 360 }) };
  const target = { closest: selector => selector === ".mia-study-card" ? card : state.blocked ? {} : null };
  const root = { ownerDocument: { defaultView: { innerWidth: 400 }, getSelection: () => ({ isCollapsed: !state.selected }) }, dataset: card.dataset, style: card.style, getBoundingClientRect: card.getBoundingClientRect, contains: item => item === card, addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type) };
  const navigate = vi.fn();
  const binding = bindStudyGestures(root, () => state.enabled, navigate);
  const emit = (type, values = {}) => listeners.get(type)?.({ pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 30, clientY: 200, timeStamp: 0, target, ...values });
  const finish = () => emit("pointerup", { clientX: 160, timeStamp: 300 });
  return { state, card, properties, binding, navigate, emit, finish, listeners };
}

describe("touch gesture UI boundary", () => {
  it("shows direction feedback then navigates once and clears it on release", () => {
    const ui = setup(); ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 160, timeStamp: 200 });
    expect(ui.card.dataset.swipeLabel).toBe("뒤로가기 →");
    expect(ui.properties.get("--mia-swipe-progress")).toBe("1");
    ui.finish(); ui.finish();
    expect(ui.navigate).toHaveBeenCalledExactlyOnceWith("back");
    expect(ui.properties.size).toBe(0);
    expect(ui.card.dataset.swipeLabel).toBeUndefined();
  });
  it.each(["blocked", "selected"])("leaves %s interactions alone", key => {
    const ui = setup(); ui.state[key] = true; ui.emit("pointerdown"); ui.finish();
    expect(ui.navigate).not.toHaveBeenCalled();
  });
  it.each(["mouse", "pen"])("does not reinterpret %s dragging", pointerType => {
    const ui = setup(); ui.emit("pointerdown", { pointerType }); ui.finish();
    expect(ui.navigate).not.toHaveBeenCalled();
  });
  it.each([0, 90, 200, 375])("rejects a stroke outside the left edge at x=%s", clientX => {
    const ui = setup(); ui.emit("pointerdown", { clientX }); ui.emit("pointerup", { clientX: 200, timeStamp: 300 });
    expect(ui.navigate).not.toHaveBeenCalled();
  });
  it("never navigates on a leftward stroke", () => {
    const ui = setup(); ui.emit("pointerdown"); ui.emit("pointerup", { clientX: -80, timeStamp: 300 });
    expect(ui.navigate).not.toHaveBeenCalled();
  });
  it("preserves pinch zoom when a second finger appears", () => {
    const ui = setup(); ui.emit("pointerdown"); ui.emit("pointerdown", { pointerId: 2, isPrimary: false }); ui.finish();
    expect(ui.navigate).not.toHaveBeenCalled();
  });
  it.each(["selection", "saving", "cancel", "rerender"])("cancels the stroke on %s", action => {
    const ui = setup(); ui.emit("pointerdown");
    if (action === "selection") ui.state.selected = true;
    if (action === "saving") ui.state.enabled = false;
    if (action === "cancel") ui.emit("pointercancel");
    if (action === "rerender") ui.binding.reset();
    ui.finish(); expect(ui.navigate).not.toHaveBeenCalled();
  });
  it("removes all listeners on tab close", () => {
    const ui = setup(); ui.emit("pointerdown"); ui.binding.destroy();
    expect(ui.listeners.size).toBe(0); ui.finish(); expect(ui.navigate).not.toHaveBeenCalled();
  });
});

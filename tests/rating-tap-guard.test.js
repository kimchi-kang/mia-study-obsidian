import { describe, expect, it, vi } from "vitest";
import { bindRatingTapGuard } from "../src/ui/rating-tap-guard";

function setup() {
  const listeners = new Map();
  const buttons = [0, 1].map(() => ({ closest: selector => selector === ".mia-ratings button" ? buttons[0] : null }));
  const surface = { contains: el => buttons.includes(el), addEventListener: (type, fn, capture) => { expect(capture).toBe(true); listeners.set(type, fn); }, removeEventListener: type => listeners.delete(type), remove() {} };
  const rated = vi.fn();
  const binding = bindRatingTapGuard(surface);
  const pointer = (type, x, y = 100, overrides = {}) => listeners.get(type)?.({ target: buttons[0], timeStamp: 100, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, ...overrides });
  const click = (index = 1, detail = 1) => {
    const event = { target: buttons[index], timeStamp: 101, detail, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    listeners.get("click")?.(event);
    if (!event.stopImmediatePropagation.mock.calls.length) rated();
  };
  return { surface, binding, rated, pointer, click, listeners };
}

describe("rating tap guard", () => {
  it("rejects a cross-button touch click even when pointermove is missing", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 130); ui.click();
    expect(ui.rated).not.toHaveBeenCalled(); ui.binding.destroy(); ui.surface.remove();
  });
  it("rejects a drag that moves away then returns to its starting point", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointermove", 130); ui.pointer("pointerup", 240); ui.click(0);
    expect(ui.rated).not.toHaveBeenCalled(); ui.binding.destroy(); ui.surface.remove();
  });
  it("allows ordinary taps and a fresh tap immediately after a cancelled drag", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 130); ui.click();
    ui.pointer("pointerdown", 240); ui.pointer("pointerup", 245); ui.click(0);
    expect(ui.rated).toHaveBeenCalledOnce(); ui.binding.destroy(); ui.surface.remove();
  });
  it.each(["mouse", "pen"])("preserves %s clicks", pointerType => {
    const ui = setup(); ui.pointer("pointerdown", 240, 100, { pointerType }); ui.pointer("pointerup", 130, 100, { pointerType }); ui.click();
    expect(ui.rated).toHaveBeenCalledOnce(); ui.binding.destroy(); ui.surface.remove();
  });
  it("preserves keyboard and programmatic rating clicks", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 130); ui.click(0, 0);
    expect(ui.rated).toHaveBeenCalledOnce(); ui.binding.destroy(); ui.surface.remove();
  });
  it("rejects a vertical drag and a cancelled pointer", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 240, 150); ui.click();
    ui.pointer("pointerdown", 240); ui.pointer("pointercancel", 240); ui.click();
    expect(ui.rated).not.toHaveBeenCalled(); ui.binding.destroy(); ui.surface.remove();
  });
  it("cancels a multi-finger rating gesture", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerdown", 230, 100, { pointerId: 2, isPrimary: false }); ui.pointer("pointerup", 240); ui.click();
    expect(ui.rated).not.toHaveBeenCalled(); ui.binding.destroy(); ui.surface.remove();
  });
  it("does not suppress unrelated controls", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 130);
    const event = { target: { closest: () => null }, timeStamp: 101, detail: 1, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    ui.listeners.get("click")(event); expect(event.preventDefault).not.toHaveBeenCalled();
    ui.binding.destroy(); ui.surface.remove();
  });
  it("clears pending touch state when the view is reset", () => {
    const ui = setup(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 130); ui.binding.reset(); ui.click();
    expect(ui.rated).toHaveBeenCalledOnce(); ui.binding.destroy(); ui.surface.remove();
  });
  it("releases listeners on close", () => {
    const ui = setup(); ui.binding.destroy(); ui.pointer("pointerdown", 240); ui.pointer("pointerup", 130); ui.click();
    expect(ui.rated).toHaveBeenCalledOnce(); ui.surface.remove();
  });
});

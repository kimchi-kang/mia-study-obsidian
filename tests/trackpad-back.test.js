import { describe, expect, it, vi } from "vitest";
import { TrackpadSwipe } from "../src/core/trackpad-swipe";
import { bindTrackpadBack } from "../src/ui/study-gestures";

const wheel = (time, dx, dy = 0, ctrl = false) => ({ time, dx, dy, ctrl });

describe("trackpad two-finger back", () => {
  it("fires once for a rightward finger swipe and ignores its momentum", () => {
    const swipe = new TrackpadSwipe();
    const results = [];
    for (let t = 0; t < 600; t += 16) results.push(swipe.feed(wheel(t, -20, 1)));
    expect(results.filter(Boolean)).toEqual(["back"]);
  });

  it("fires again after the wheel stream pauses", () => {
    const swipe = new TrackpadSwipe();
    for (let t = 0; t < 160; t += 16) swipe.feed(wheel(t, -20));
    let again = null;
    for (let t = 600; t < 760; t += 16) again ??= swipe.feed(wheel(t, -20));
    expect(again).toBe("back");
  });

  it.each([
    ["leftward swipe", -1],
    ["vertical scroll", 0],
    ["pinch", 2],
  ])("ignores %s", (_name, kind) => {
    const swipe = new TrackpadSwipe();
    const results = [];
    for (let t = 0; t < 400; t += 16) {
      if (kind === -1) results.push(swipe.feed(wheel(t, 25)));
      if (kind === 0) results.push(swipe.feed(wheel(t, -10, 30)));
      if (kind === 2) results.push(swipe.feed(wheel(t, -25, 0, true)));
    }
    expect(results.filter(Boolean)).toEqual([]);
  });

  it("counts vertical wobble by size so up-and-down shaking cannot pass as a sideways swipe", () => {
    const swipe = new TrackpadSwipe();
    const results = [];
    for (let t = 0, i = 0; t < 400; t += 16, i += 1) results.push(swipe.feed(wheel(t, -20, i % 2 ? 30 : -30)));
    expect(results.filter(Boolean)).toEqual([]);
  });

  it("stays quiet for the rest of a stream that a scrollable block started using", () => {
    const swipe = new TrackpadSwipe();
    swipe.suppress(0);
    const results = [];
    for (let t = 16; t < 600; t += 16) results.push(swipe.feed(wheel(t, -20)));
    expect(results.filter(Boolean)).toEqual([]);
    let again = null;
    for (let t = 900; t < 1060; t += 16) again ??= swipe.feed(wheel(t, -20));
    expect(again).toBe("back");
  });

  it("respects sensitivity thresholds", () => {
    const light = new TrackpadSwipe(); const firm = new TrackpadSwipe();
    let lightHit = null; let firmHit = null;
    for (let t = 0; t <= 80; t += 16) { lightHit ??= light.feed(wheel(t, -20), "light"); firmHit ??= firm.feed(wheel(t, -20), "firm"); }
    expect(lightHit).toBe("back");
    expect(firmHit).toBeNull();
  });

  function setup(enabled = true) {
    const listeners = new Map();
    const surface = { clientWidth: 800, addEventListener: (type, cb, options) => listeners.set(type, { cb, options }), removeEventListener: type => listeners.delete(type) };
    const back = vi.fn();
    const binding = bindTrackpadBack(surface, () => enabled, back);
    const emit = (values = {}) => listeners.get("wheel")?.cb({ deltaX: -40, deltaY: 0, deltaMode: 0, ctrlKey: false, timeStamp: 0, target: null, ...values });
    return { surface, listeners, back, binding, emit };
  }

  it("binds a passive wheel listener that calls back once and unbinds", () => {
    const ui = setup();
    expect(ui.listeners.get("wheel").options).toEqual({ passive: true });
    for (let t = 0; t < 200; t += 16) ui.emit({ timeStamp: t });
    expect(ui.back).toHaveBeenCalledTimes(1);
    ui.binding.destroy();
    expect(ui.listeners.has("wheel")).toBe(false);
  });

  it("does nothing when disabled or over a block that can still scroll left", () => {
    const off = setup(false);
    for (let t = 0; t < 200; t += 16) off.emit({ timeStamp: t });
    expect(off.back).not.toHaveBeenCalled();

    const ui = setup();
    const code = { nodeType: 1, scrollLeft: 30, scrollWidth: 900, clientWidth: 300, parentElement: ui.surface };
    for (let t = 0; t < 200; t += 16) ui.emit({ timeStamp: t, target: code });
    expect(ui.back).not.toHaveBeenCalled();
  });

  it("does not go back when momentum continues after a scrolled block reaches its left edge", () => {
    const ui = setup();
    const code = { nodeType: 1, scrollLeft: 60, scrollWidth: 900, clientWidth: 300, parentElement: ui.surface };
    let t = 0;
    for (; t < 96; t += 16) { ui.emit({ timeStamp: t, target: code }); code.scrollLeft = Math.max(0, code.scrollLeft - 20); }
    expect(code.scrollLeft).toBe(0);
    for (; t < 600; t += 16) ui.emit({ timeStamp: t, target: code });
    expect(ui.back).not.toHaveBeenCalled();
  });
});

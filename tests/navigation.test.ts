import { describe, expect, it } from "vitest";
import { MiaNavigationHistory, TrackpadBackGesture, isBackSwipe } from "../src/core/navigation";

describe("MIA navigation history", () => {
  it("returns through visited screens and resets at the dashboard", () => {
    const history = new MiaNavigationHistory();
    history.navigate("questions");
    history.navigate("study");
    expect(history.back()).toBe("questions");
    expect(history.back()).toBe("dashboard");
    expect(history.canGoBack).toBe(false);
    history.navigate("keywords");
    expect(history.reset()).toBe("dashboard");
    expect(history.canGoBack).toBe(false);
  });

  it("does not add duplicate visits", () => {
    const history = new MiaNavigationHistory();
    history.navigate("questions");
    history.navigate("questions");
    expect(history.back()).toBe("dashboard");
  });
});

describe("back gestures", () => {
  it("accepts a deliberate right swipe and rejects vertical or slow motion", () => {
    expect(isBackSwipe({ x: 20, y: 100, at: 0 }, { x: 120, y: 112, at: 500 })).toBe(true);
    expect(isBackSwipe({ x: 20, y: 100, at: 0 }, { x: 120, y: 180, at: 500 })).toBe(false);
    expect(isBackSwipe({ x: 20, y: 100, at: 0 }, { x: 120, y: 112, at: 1_500 })).toBe(false);
  });

  it("accumulates horizontal trackpad movement once and ignores vertical scrolling", () => {
    const gesture = new TrackpadBackGesture();
    expect(gesture.update(-70, 4, 100)).toBe(false);
    expect(gesture.update(-70, 3, 140)).toBe(false);
    expect(gesture.update(-50, 2, 180)).toBe(true);
    expect(gesture.update(-200, 0, 200)).toBe(false);
    expect(gesture.update(0, 100, 1_000)).toBe(false);
  });
});

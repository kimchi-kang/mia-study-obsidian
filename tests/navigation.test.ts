import { describe, expect, it } from "vitest";
import { DEFAULT_MIA_NAVIGATION_STATE, isMiaRoute, parseMiaNavigationState } from "../src/core/navigation";

describe("MIA navigation history", () => {
  it("accepts only supported Obsidian view routes", () => {
    expect(isMiaRoute("questions")).toBe(true);
    expect(isMiaRoute("sidebar")).toBe(false);
  });

  it("restores a study session from Obsidian navigation state", () => {
    expect(parseMiaNavigationState({
      route: "study",
      queue: ["q-1", "q-2"],
      queueIndex: 1,
      answerVisible: true,
      sessionMode: "browse",
    })).toEqual({
      route: "study",
      queue: ["q-1", "q-2"],
      queueIndex: 1,
      answerVisible: true,
      sessionMode: "browse",
    });
  });

  it("uses safe defaults and clamps an invalid queue position", () => {
    expect(parseMiaNavigationState(null)).toEqual(DEFAULT_MIA_NAVIGATION_STATE);
    expect(parseMiaNavigationState({ route: "wrong", queue: ["q-1", 2], queueIndex: 99 })).toEqual({
      ...DEFAULT_MIA_NAVIGATION_STATE,
      queue: ["q-1"],
    });
  });
});

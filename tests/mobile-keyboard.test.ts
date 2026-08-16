import { describe, expect, it } from "vitest";
import { calculateKeyboardViewport } from "../src/core/mobile-keyboard-metrics";

describe("mobile keyboard viewport", () => {
  it("calculates the iOS keyboard and remaining space above it", () => {
    expect(calculateKeyboardViewport(844, 477, 0, 96)).toEqual({
      visibleHeight: 477,
      offsetTop: 0,
      keyboardHeight: 367,
      availableHeight: 381,
      keyboardOpen: true,
    });
  });

  it("does not treat small browser chrome changes as a keyboard", () => {
    expect(calculateKeyboardViewport(844, 790, 0, 80)).toMatchObject({
      keyboardHeight: 54,
      availableHeight: 710,
      keyboardOpen: false,
    });
  });

  it("accounts for a shifted visual viewport and clamps invalid dimensions", () => {
    expect(calculateKeyboardViewport(844, 500, 44, 100)).toMatchObject({
      offsetTop: 44,
      keyboardHeight: 300,
      availableHeight: 444,
      keyboardOpen: true,
    });
    expect(calculateKeyboardViewport(-1, -2, -3, -4)).toEqual({
      visibleHeight: 0,
      offsetTop: 0,
      keyboardHeight: 0,
      availableHeight: 0,
      keyboardOpen: false,
    });
  });
});

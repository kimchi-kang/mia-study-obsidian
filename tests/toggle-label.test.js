import { describe, expect, it } from "vitest";
import { labelToggle } from "../src/ui/toggle-label";

const element = () => ({ attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } });

describe("toggle accessible names", () => {
  it("names both the switch and its checkbox after the setting", () => {
    const input = element();
    const toggleEl = { ...element(), querySelector: selector => (selector === "input" ? input : null) };
    const toggle = { toggleEl };
    expect(labelToggle(toggle, "집중 모드")).toBe(toggle);
    expect(toggleEl.attrs["aria-label"]).toBe("집중 모드");
    expect(input.attrs["aria-label"]).toBe("집중 모드");
  });

  it("keeps working when a host toggle has no element yet", () => {
    const toggle = {};
    expect(labelToggle(toggle, "양방향 연결")).toBe(toggle);
  });
});

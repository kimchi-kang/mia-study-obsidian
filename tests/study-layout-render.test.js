import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
vi.mock("obsidian", async () => {
  const { obsidianLayoutBoundary } = await import("./fixtures/study-layout-obsidian");
  return obsidianLayoutBoundary();
});
import { createLayoutDom, renderLayoutCase } from "./fixtures/study-layout-render";
import { layoutHarness } from "./fixtures/study-layout-harness-template";
let dom;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  dom = createLayoutDom();
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("study layout rendered DOM", () => {
  it("creates no related rail before reveal even with recommendations", async () => {
    const { root } = await renderLayoutCase({ revealed: false });
    expect(root.querySelector(".mia-related")).toBeNull();
  });
  it("creates no related rail for zero recommendations after reveal", async () => {
    const { root } = await renderLayoutCase({ related: false });
    expect(root.querySelector(".mia-answer")).not.toBeNull();
    expect(root.querySelector(".mia-related")).toBeNull();
    expect(root.querySelector(".mia-study-layout").children).toHaveLength(1);
  });
  it("places real recommended items beside the card in the DOM after reveal", async () => {
    const { root } = await renderLayoutCase();
    expect(root.querySelector(".mia-study-layout > .mia-related > .mia-related-item")).not.toBeNull();
    expect(root.querySelectorAll(".mia-ratings > button")).toHaveLength(4);
    expect(root.querySelector(".mia-study-concepts").textContent).toContain("재료 보존");
    expect(root.querySelectorAll(".mia-answer li")).toHaveLength(3);
  });
  it("keeps all 40 lines in the long answer", async () => {
    const { root } = await renderLayoutCase({ long: true });
    expect(root.querySelectorAll(".mia-answer li")).toHaveLength(40);
  });
  it("ships a reproducible standalone harness with real rendered study HTML", async () => {
    const cases = {};
    for (const [name, options] of Object.entries({ short: {}, long: { long: true }, "no-related": { related: false } })) {
      const { root } = await renderLayoutCase(options);
      cases[name] = root.outerHTML;
      root.remove();
    }
    const html = layoutHarness(cases);
    const path = new URL("./fixtures/study-layout-harness.html", import.meta.url);
    if (process.env.MIA_GENERATE_LAYOUT_HARNESS === "1") await writeFile(path, html);
    expect(await readFile(path, "utf8")).toBe(html);
  });
});

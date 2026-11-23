import { readFile } from "node:fs/promises";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const rules: Rule[] = [];
root.walkRules(rule => { rules.push(rule); });
const declarations = (rule: Rule) => Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value]));
const touchStudy = (rule: Rule) => rule.selector.includes(".mia-route-study:is([data-device=\"phone\"], [data-device=\"tablet\"])");
const slimStudy = '.mia-view:is([data-device="phone"], [data-device="tablet"]).mia-route-study:has(.mia-study-layout)';

describe("study pane width and chrome CSS", () => {
  it("expands only the study desktop reading cap to 1360px", () => {
    expect(rules.find(rule => rule.selector === ".mia-view.mia-route-study" && declarations(rule)["--mia-study-width"])).toBeDefined();
    expect(declarations(rules.find(rule => rule.selector === ".mia-view.mia-route-study" && declarations(rule)["--mia-study-width"])!)["--mia-study-width"]).toBe("1360px");
    expect(declarations(rules.find(rule => rule.selector === ".mia-view" && declarations(rule)["--mia-study-width"])!)["--mia-study-width"]).toBe("1080px");
  });
  it("removes all five touch route caps and uses small pane gutters plus the existing safe edges", () => {
    const rule = rules.find(rule => rule.selector.includes(".mia-route-dashboard") && declarations(rule)["--mia-study-width"] === "none");
    expect(rule).toBeDefined();
    for (const route of ["study", "dashboard", "progress", "questions", "keywords"]) expect(rule!.selector).toContain(`.mia-route-${route}`);
    expect(rule!.selector).toContain(':is([data-device="phone"], [data-device="tablet"])');
    expect(declarations(rule!)).toMatchObject({
      "--mia-study-width": "none",
      "--mia-pane-gutter": "clamp(8px, calc(var(--mia-pane-width, 400px) * .02), 16px)",
      "padding-left": "calc(var(--mia-pane-gutter) + var(--mia-edge-left))",
      "padding-right": "calc(var(--mia-pane-gutter) + var(--mia-edge-right))",
    });
    for (const edge of ["left", "right"]) {
      const variable = `--mia-edge-${edge}`;
      const definition = rules.map(declarations).find(decls => decls[variable])![variable];
      expect(definition).toContain(`var(--safe-area-inset-${edge}, 0px)`);
      expect(definition).toContain(`env(safe-area-inset-${edge}, 0px)`);
      expect(definition).toContain(edge === "left" ? "var(--mia-pane-left, 0px)" : "var(--mia-pane-right-gap, 0px)");
    }
  });
  it("reserves a rail at 960px of pane width only with real, nonhidden recommendations", () => {
    const rails = rules.filter(rule => declarations(rule)["grid-template-columns"]?.match(/(?:230|340)px/));
    expect(rails).toHaveLength(1);
    const rail = rails[0];
    if (!rail?.parent) throw new Error("Expected a container-scoped recommendation rail");
    expect(rail.selector).not.toContain("[data-device");
    expect(rail.selector).toContain(':not([data-density="compact"])');
    expect(rail.selector).toContain(':not([data-answer-layout="split"])');
    expect(rail.selector).toContain(':has(> .mia-related:not([hidden]):not([aria-hidden="true"]) > .mia-related-item)');
    expect(rail.parent.type).toBe("atrule");
    expect(rail.parent).toMatchObject({ name: "container", params: "mia-view (min-width: 960px)" });
  });
  it("uses one column by default and keeps touch targets at least 44px", () => {
    expect(declarations(rules.find(rule => rule.selector === ".mia-study-layout")!)["grid-template-columns"]).toBe("minmax(0, 1fr)");
    expect(rules.some(rule => touchStudy(rule) && rule.selector.endsWith(" :is(button, summary)") && declarations(rule)["min-height"] === "44px")).toBe(true);
    expect(rules.some(rule => rule.selector.includes('.mia-route-study[data-device="tablet"] .mia-study-dock .mia-ratings button') && declarations(rule)["min-height"] === "50px")).toBe(true);
  });
  it("keeps the desktop progress subject inline without dashboard card padding", () => {
    const rule = rules.find(rule => rule.selector === '.mia-view.mia-route-study[data-device="desktop"] .mia-study-navigation .mia-progress-subject');
    expect(declarations(rule!)).toMatchObject({ display: "inline", padding: "0", margin: "0", "border-width": "0" });
  });
  it("places the header across both columns so the question and answer share a row in split mode", () => {
    const header = rules.find(rule => rule.selector === '.mia-view[data-answer-layout="split"] .mia-study-card > .mia-card-header')!;
    expect(header.parent).toMatchObject({ name: "container", params: "mia-view (min-width: 900px)" });
    expect(declarations(header)["grid-column"]).toBe("1 / -1");
    const card = rules.find(rule => rule.selector === '.mia-view[data-answer-layout="split"] .mia-study-card:has(.mia-answer-section)')!;
    expect(declarations(card)["grid-template-columns"]).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });
  it("uses the same slim five-column bar and 44px controls in phone and tablet sessions", () => {
    const grid = rules.find(rule => rule.selector === slimStudy)!;
    expect(grid.parent?.type).toBe("root");
    expect(declarations(grid)).toMatchObject({ display: "grid", "grid-template-columns": "auto minmax(0, 1fr) auto auto auto" });
    const buttons = rules.find(rule => rule.selector === `${slimStudy} :is(.mia-focus-exit, .mia-settings-buttons > button)`)!;
    expect(declarations(buttons)).toMatchObject({ "grid-row": "1", "min-width": "44px", "min-height": "44px", width: "44px", height: "44px" });
    expect(declarations(rules.find(rule => rule.selector === `${slimStudy} .mia-study-navigation .mia-progress`)!)).toMatchObject({ "grid-area": "1 / 2" });
    expect(declarations(rules.find(rule => rule.selector === `${slimStudy} .mia-progress-count`)!)).toMatchObject({ flex: "none", "white-space": "nowrap" });
    const subject = rules.find(rule => rule.selector.startsWith(slimStudy) && rule.selector.includes(".mia-progress-subject"))!;
    expect(declarations(subject).display).toBe("none");
    const label = rules.find(rule => rule.selector === `${slimStudy} .mia-button-label`)!;
    expect(declarations(label)).toMatchObject({ position: "absolute", "clip-path": "inset(50%)" });
    expect(declarations(label).display).toBeUndefined();
    expect(rules.some(rule => rule.selector.includes('[data-device="phone"].mia-route-study .mia-study-dock .mia-ratings') && declarations(rule)["grid-template-columns"] === "repeat(4, minmax(0, 1fr))")).toBe(true);
  });
});


describe("wide library routes", () => {
  it("limits only the four touch library routes to 1600px, without reaching dialogs or study", () => {
    const rule = rules.find(rule => declarations(rule)["max-width"] === "1600px")!;
    expect(rule.selector).toContain('[data-device="tablet"]');
    expect(rule.selector).toContain('[data-device="phone"]');
    expect(rule.selector).toContain(' > *');
    expect(rule.selector).not.toContain('.mia-route-study');
    expect(rule.selector).not.toContain('modal');
    for (const route of ["dashboard", "progress", "questions", "keywords"]) expect(rule.selector).toContain(`.mia-route-${route}`);
  });
  it("adds adaptive subject and question grids and sizes question rows by their own column", () => {
    for (const selector of [".mia-view.mia-route-dashboard .mia-subject-grid", ".mia-view.mia-route-progress .mia-progress-subjects", ".mia-view.mia-route-questions .mia-list"]) {
      expect(rules.some(rule => rule.selector === selector && declarations(rule)["grid-template-columns"]?.includes("repeat(auto-fill, minmax(min("))).toBe(true);
    }
    const row = rules.find(rule => rule.selector === ".mia-view.mia-route-questions .mia-row")!;
    expect(row.parent).toMatchObject({ name: "container", params: "mia-question-list (max-width: 760px) or (min-width: 966px)" });
    expect(declarations(row)["grid-template-areas"]).toBe('"dot body more"');
  });
  it("preserves the detail breakpoint while allowing both columns to grow", () => {
    const rule = rules.find(rule => rule.selector === ".mia-view.mia-route-questions .mia-questions-layout")!;
    expect(rule.parent).toMatchObject({ name: "container", params: "mia-view (min-width: 1000px)" });
    expect(declarations(rule)["grid-template-columns"]).toBe("minmax(0, 1.8fr) minmax(400px, 1fr)");
  });
});

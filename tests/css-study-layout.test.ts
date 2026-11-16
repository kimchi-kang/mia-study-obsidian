import { readFile } from "node:fs/promises";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const rules: Rule[] = [];
root.walkRules(rule => { rules.push(rule); });
const declarations = (rule: Rule) => Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value]));
const touchStudy = (rule: Rule) => rule.selector.includes(".mia-route-study:is([data-device=\"phone\"], [data-device=\"tablet\"])");

describe("study pane width and chrome CSS", () => {
  it("expands only the study desktop reading cap to 1360px", () => {
    expect(rules.find(rule => rule.selector === ".mia-view.mia-route-study" && declarations(rule)["--mia-study-width"])).toBeDefined();
    expect(declarations(rules.find(rule => rule.selector === ".mia-view.mia-route-study" && declarations(rule)["--mia-study-width"])!)["--mia-study-width"]).toBe("1360px");
    expect(declarations(rules.find(rule => rule.selector === ".mia-view" && declarations(rule)["--mia-study-width"])!)["--mia-study-width"]).toBe("1080px");
  });
  it("removes the touch study cap and uses small pane gutters plus the existing safe edges", () => {
    const rule = rules.find(rule => touchStudy(rule) && declarations(rule)["--mia-study-width"]);
    expect(rule).toBeDefined();
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
  it("reserves a rail only on a sufficiently wide desktop with real, nonhidden recommendations", () => {
    const rails = rules.filter(rule => declarations(rule)["grid-template-columns"]?.match(/(?:230|340)px/));
    expect(rails).toHaveLength(1);
    const rail = rails[0];
    if (!rail?.parent) throw new Error("Expected a container-scoped recommendation rail");
    expect(rail.selector).toContain('[data-device="desktop"]');
    expect(rail.selector).toContain(':not([data-density="compact"])');
    expect(rail.selector).toContain(':not([data-answer-layout="split"])');
    expect(rail.selector).toContain(':has(> .mia-related:not([hidden]):not([aria-hidden="true"]) > .mia-related-item)');
    expect(rail.parent.type).toBe("atrule");
    expect(rail.parent).toMatchObject({ name: "container", params: "mia-view (min-width: 1100px)" });
  });
  it("keeps recommendations below touch cards and touch targets at least 44px", () => {
    expect(rules.some(rule => touchStudy(rule) && rule.selector.endsWith(" .mia-study-layout") && declarations(rule)["grid-template-columns"] === "minmax(0, 1fr)")).toBe(true);
    expect(rules.some(rule => touchStudy(rule) && rule.selector.endsWith(" :is(button, summary)") && declarations(rule)["min-height"] === "44px")).toBe(true);
    expect(rules.some(rule => rule.selector.includes('.mia-route-study[data-device="tablet"] .mia-study-dock .mia-ratings button') && declarations(rule)["min-height"] === "50px")).toBe(true);
  });
  it("removes dashboard subject-card padding from the study progress span on tablet, desktop and landscape phones", () => {
    for (const prefix of ['.mia-view.mia-route-study:is([data-device="tablet"], [data-device="desktop"])', '.mia-view.mia-route-study[data-device="phone"]']) {
      const rule = rules.find(rule => rule.selector === `${prefix} .mia-study-navigation .mia-progress-subject`);
      expect(rule).toBeDefined();
      expect(declarations(rule!)).toMatchObject({ display: "inline", padding: "0", margin: "0", "border-width": "0" });
    }
  });
  it("retains the phone 44px bar and four-column rating buttons", () => {
    expect(rules.some(rule => rule.selector.includes('[data-device="phone"].mia-route-study:has(.mia-study-layout) .mia-settings-buttons > button') && declarations(rule)["min-height"] === "44px")).toBe(true);
    expect(rules.some(rule => rule.selector.includes('[data-device="phone"].mia-route-study .mia-study-dock .mia-ratings') && declarations(rule)["grid-template-columns"] === "repeat(4, minmax(0, 1fr))")).toBe(true);
  });
});

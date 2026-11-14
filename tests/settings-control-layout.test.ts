import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const harness = readFileSync(new URL("fixtures/responsive-modal-harness.html", import.meta.url), "utf8");
const declarations = (selector: string) => {
  const values: Record<string, string> = {};
  root.walkRules(selector, rule => { rule.walkDecls(decl => { values[decl.prop] = decl.value; }); });
  return values;
};

describe("settings control layout", () => {
  it("leaves native toggle variables, geometry and pseudo elements to the host theme", () => {
    root.walkDecls(decl => expect(decl.prop).not.toMatch(/^--toggle-/));
    root.walkRules(rule => {
      if (/\.checkbox-container(?::focus-visible|\.is-enabled)?$/.test(rule.selector)) {
        expect(rule.selector).not.toMatch(/::(?:before|after)/);
        rule.walkDecls(decl => expect(decl.prop).not.toMatch(/^(width|height|border|inset|left|top|margin|padding|transform)/));
      }
    });
    expect(css).not.toContain(".is-phone .mia-appearance-modal .setting-item");
  });

  it("centers controls in a 44px container, sharing select widths without changing the switch", () => {
    expect(declarations(".mia-setting-controls .setting-item-info")).toMatchObject({ flex: "1", "min-width": "0" });
    expect(declarations(".mia-setting-controls .setting-item-control")).toMatchObject({ "min-height": "44px", "align-items": "center", "justify-content": "flex-end" });
    expect(declarations(".mia-setting-controls .setting-item.mod-toggle .setting-item-control")).toMatchObject({ "flex-wrap": "nowrap", width: "auto" });
    expect(css).toContain("width: var(--mia-settings-select-width)");
    expect(css).toContain(".modal-container > .modal.mia-appearance-modal { width: min(480px, calc(100vw - 28px)); }");
    const query = root.nodes.find(node => node.type === "atrule" && node.name === "container" && node.params === "mia-setting-controls (max-width: 419px)");
    expect(query?.toString()).toContain(".setting-item:not(.mod-toggle)");
    expect(query?.toString()).toContain("min-width: 0");
    expect(query?.toString()).toContain("width: 100%");
  });

  it.each(["study-appearance-modal", "study-controls-modal", "mobile-keyboard", "settings-tab", "study-management-settings", "follow-up-modal"])("opts %s into the common layout", file => {
    expect(readFileSync(new URL(`../src/ui/${file}.ts`, import.meta.url), "utf8")).toContain('"mia-setting-controls"');
  });

  it("provides four browser presets and checks for both switch states and mobile layouts", () => {
    expect(harness).toContain("[390, 820, 1024, 1280]");
    expect(harness).toContain("harness-mobile");
    expect(harness).toContain('classList.toggle("is-mobile"');
    for (const check of ["thumb containment", "select alignment", "select full width", "44px target", "horizontal overflow"]) expect(harness).toContain(check);
    expect(harness).toContain('params.get("width")');
    expect(harness).toContain("padding: var(--toggle-border-width)");
    expect(harness).toContain("translate3d(calc(var(--toggle-width) - var(--toggle-thumb-width) - var(--toggle-border-width)), 0, 0)");
    expect(harness).toContain("transform.m41");
    expect(harness).toContain('toggle("집중 모드", false)');
    expect(harness).toContain('toggle("쓸어서 뒤로가기", true)');
  });
});

import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const switchScope = ":is(.mia-view, .mia-keyboard-settings, .modal:is(.mia-keyboard-modal, .mia-study-management-modal, .mia-appearance-modal, .mia-controls-modal))";
const decls = (selector: string) => {
  const values: Record<string, string> = {};
  root.walkRules(selector, rule => { rule.walkDecls(d => { values[d.prop] = d.value; }); });
  return values;
};

describe("MIA design consistency", () => {
  it.each([false, true])("inherits existing tokens in dark=%s without separate control palettes", dark => {
    const palettes: Record<string, string>[] = [];
    root.walkRules(rule => {
      if (rule.selector.startsWith(dark ? "body.theme-dark :is(.mia-view," : ":is(.mia-view,") && rule.selector.endsWith(".mia-editor-modal-compact)")) {
        const palette: Record<string, string> = {};
        rule.walkDecls(/^--mia-/, d => { palette[d.prop] = d.value; });
        if (palette["--mia-panel"]) palettes.push(palette);
      }
    });
    expect(palettes).toHaveLength(1);
    for (const token of ["--mia-panel", "--mia-ink", "--mia-blue", "--mia-focus"]) expect(palettes[0]?.[token]).toBeTruthy();
    expect(decls(`${switchScope} .checkbox-container`)).toEqual({
      "background-color": "var(--mia-panel)", "box-shadow": "0 0 0 3px var(--mia-ink)",
    });
    expect(decls(`${switchScope} .checkbox-container.is-enabled`)).toEqual({ "background-color": "var(--mia-blue)" });
    expect(decls(`${switchScope} .checkbox-container:focus-visible`)).toEqual({
      "box-shadow": "0 0 0 3px var(--mia-ink)", outline: "4px solid var(--mia-focus)", "outline-offset": "5px",
    });
  });

  it("uses existing tokens for every added paint rule, including settings controls and descriptions", () => {
    const additions = postcss.parse(css.slice(css.indexOf("/* The same utility row")));
    root.walkRules(rule => { if (rule.selector.startsWith(switchScope)) additions.append(rule.clone()); });
    additions.walkDecls(d => {
      expect(d.value).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
      if (/^(color|background(?:-color)?|border(?:-color)?|box-shadow|outline)$/.test(d.prop)) expect(d.value).toMatch(/var\(--mia-/);
      // MIA tokens first; an Obsidian fallback is allowed for dialogs outside the palette scope.
      if (d.prop === "border-radius") expect(d.value).toMatch(/^var\(--mia-radius(?:, var\(--radius-s\))?\)$/);
    });
    const input = decls('.mia-setting-controls .setting-item-control > :is(input:not([type="checkbox"], [type="radio"], [type="range"]), select, textarea)');
    expect(input).toMatchObject({ border: "3px solid var(--mia-ink, var(--background-modifier-border))", "border-radius": "var(--mia-radius, var(--radius-s))", "min-height": "44px", background: "var(--mia-panel, var(--background-primary))", color: "var(--mia-ink, var(--text-normal))" });
    expect(decls(".mia-setting-controls .setting-item-control > button:not(.mod-cta, .mod-warning, .checkbox-container)")).toMatchObject({ border: input.border, "border-radius": input["border-radius"], "min-height": input["min-height"] });
    expect(decls(".mia-study-management-settings .mia-anki-settings-section > .setting-item-description")).toMatchObject({ color: "var(--mia-muted)", "overflow-wrap": "anywhere" });
  });

  it("keeps memorization navigation in two columns and completion actions in the shared action group", () => {
    expect(decls(".mia-view .mia-thumb-navigation:not(:has(.mia-dock-undo, .mia-controls-help))")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr)", "margin-top": "0" });
    const source = readFileSync(new URL("../src/ui/study-view.ts", import.meta.url), "utf8");
    const browse = source.slice(source.indexOf('if ((!question || !question.id) && this.readOnlyBrowse)'), source.indexOf('const navigation = root.createDiv'));
    expect(browse.match(/done.createDiv\(\{ cls: "mia-inline-actions" \}\)/g)).toHaveLength(2);
    expect(browse).toContain('actions.createEl("button", { text: "처음부터 다시", cls: "mod-cta" })');
    expect(decls(".mia-view .mia-hero-main > .mia-inline-actions + .mia-muted")).toMatchObject({ margin: "8px 0 0", "font-size": "var(--font-ui-small)" });
  });
});

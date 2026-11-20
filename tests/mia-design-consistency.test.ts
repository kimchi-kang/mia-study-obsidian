import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const declarations = (selector: string) => {
  const values: Record<string, string> = {};
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(d => { values[d.prop] = d.value; });
  });
  return values;
};
const palettes = root.nodes.filter(node => node.type === "rule" && node.nodes.some(
  node => node.type === "decl" && node.prop === "--mia-bg",
));
const base = palettes.find(rule => rule.type === "rule" && !rule.selector.includes("night"));
if (!base || base.type !== "rule") throw new Error("Missing shared MIA palette");
const scope = base.selector;
const tokens = declarations(scope);
const night = { ...tokens, ...declarations('.mia-view[data-night="true"]') };

function color(palette: Record<string, string>, name: string): number[] {
  const value = palette[`--mia-${name}`];
  const alias = value?.match(/^var\(--mia-([\w-]+)\)$/);
  if (alias) return color(palette, alias[1]!);
  if (!value || !/^#[a-f\d]{6}$/i.test(value)) throw new Error(`Expected a hex color for ${name}, received ${value}`);
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
}

const weights = [.2126, .7152, .0722];
const weighted = (rgb: number[]) => rgb.reduce((sum, v, i) => sum + v * weights[i]!, 0);
const luminance = (rgb: number[]) => weighted(rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4));
const redOverlay = (rgb: number[]) => [weighted(rgb), 0, 0];

function contrast(palette: Record<string, string>, a: string, b: string) {
  const values = [a, b].map(token => {
    const rgb = color(palette, token);
    return luminance(palette === night ? redOverlay(rgb) : rgb);
  });
  return (Math.max(...values) + .05) / (Math.min(...values) + .05);
}

describe("MIA design consistency", () => {
  it("shares one dark palette across views, settings and dialogs in either Obsidian theme", () => {
    expect(palettes).toHaveLength(2); // Shared palette plus explicit night mode.
    expect(scope).toContain(".mia-view");
    expect(scope).toContain(".mia-keyboard-settings");
    expect(scope).toContain(".mia-study-management-settings");
    for (const dialog of ["detail", "result", "preview", "appearance", "controls", "study-management", "confirm", "recovery", "editor-modal-long", "editor-modal-medium", "editor-modal-compact", "export"]) {
      expect(scope).toContain(`.mia-${dialog.includes("editor") ? dialog : `${dialog}-modal`}`);
    }
    expect(scope).toContain(".modal:where(");
    expect(tokens).toMatchObject({ "--mia-bg": "#2B2F38", "--mia-panel": "var(--mia-bg)", "color-scheme": "dark" });
    root.walkRules(rule => {
      if (/\.theme-(?:light|dark)\b/.test(rule.selector)) {
        expect(rule.selector).toBe("body.mia-night-global.theme-light");
        rule.walkDecls(/^--mia-/, d => { throw new Error(`Theme-specific MIA token ${d.prop}`); });
      }
    });
  });

  it("has no thick solid black or ink border and uses system fonts", () => {
    root.walkRules(rule => {
      if (!/\.mia-/.test(rule.selector)) return;
      rule.walkDecls(/^border(?:-(?:block|inline|top|right|bottom|left)(?:-(?:start|end))?)?$/, d => {
        const width = d.value.match(/(?:^|\s)(\d+(?:\.\d+)?)px\s+solid\b/i);
        if (width && Number(width[1]) >= 2) {
          expect(d.value, rule.selector).not.toMatch(/--mia-ink|--text-normal|\bblack\b|#(?:000(?:000)?|121212)\b|rgba?\(\s*0[ ,]+0[ ,]+0\b/i);
        }
      });
    });
    expect(tokens["--mia-head"]).toContain('"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR"');
    expect(css).not.toMatch(/@import|@font-face|Black Han Sans|Do Hyeon/i);
  });

  it("uses one upper-left light source for all raised and inset shadows", () => {
    expect(tokens["--mia-shadow"]).toBe("8px 8px 16px var(--mia-shadow-dark), -8px -8px 16px var(--mia-shadow-light)");
    expect(tokens["--mia-shadow-small"]).toBe("5px 5px 10px var(--mia-shadow-dark), -5px -5px 10px var(--mia-shadow-light)");
    expect(tokens["--mia-shadow-inset"]).toBe("inset 6px 6px 12px var(--mia-shadow-dark), inset -6px -6px 12px var(--mia-shadow-light)");
    for (const palette of [tokens, night]) {
      expect(luminance(color(palette, "shadow-light"))).toBeGreaterThan(luminance(color(palette, "panel")));
      expect(luminance(color(palette, "shadow-dark"))).toBeLessThan(luminance(color(palette, "panel")));
    }
    root.walkDecls("box-shadow", d => expect(d.value).toMatch(/^(none|var\(--mia-shadow(?:-inset|-small)?\))$/));
  });

  it.each([false, true])("keeps all text pairs at AA and focus at 3:1 with red overlay=%s", red => {
    const palette = red ? night : tokens;
    for (const text of ["ink", "muted", "accent-text", "danger-text", "warning-text"]) {
      for (const surface of ["bg", "surface"]) expect(contrast(palette, text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    const grades = ["again", "hard", "good", "easy"];
    expect(new Set(grades.map(grade => color(palette, grade).join(","))).size).toBe(4);
    for (const surface of ["blue", ...grades]) {
      expect(contrast(palette, "on-color", surface), `button on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ["bg", "surface", "blue"]) {
      expect(contrast(palette, "focus", surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses shared tokens for raised buttons, recessed controls, toggles and the selected nav tab", () => {
    const input = declarations(`${scope} :is(input:not([type="checkbox"], [type="radio"], [type="range"]), select, textarea)`);
    expect(input).toMatchObject({ border: "0", "border-radius": "var(--mia-radius-s)", "background-color": "var(--mia-surface)", color: "var(--mia-ink)", "box-shadow": "var(--mia-shadow-inset)" });
    expect(declarations(`${scope} button.mod-cta`)).toMatchObject({ "background-color": "var(--mia-blue)", color: "var(--mia-on-color)" });
    expect(declarations(`${scope} .checkbox-container`)).toEqual({
      "background-color": "var(--mia-surface)", "box-shadow": "var(--mia-shadow-inset)",
    });
    expect(declarations(`${scope} .checkbox-container.is-enabled`)).toEqual({ "background-color": "var(--mia-blue)" });
    expect(declarations(".mia-view .mia-nav")).toMatchObject({ "box-shadow": "var(--mia-shadow-inset)", "border-radius": "var(--mia-radius-pill)" });
    expect(declarations(".mia-view .mia-nav button.mod-cta")).toMatchObject({ "box-shadow": "var(--mia-shadow-small)", color: "var(--mia-accent-text)" });
    expect(declarations('.mia-setting-controls .setting-item-control > :is(input:not([type="checkbox"], [type="radio"], [type="range"]), select, textarea)')).toMatchObject({ "min-height": "44px" });
    expect(declarations(".mia-setting-controls .setting-item-control > button:not(.mod-cta, .mod-warning, .checkbox-container)")).toMatchObject({ "min-height": "44px" });
    expect(declarations(".mia-study-management-settings .mia-anki-settings-section > .setting-item-description")).toMatchObject({ color: "var(--mia-muted)", "overflow-wrap": "anywhere" });
  });

  it("keeps memorization navigation in two columns and completion actions in the shared action group", () => {
    expect(declarations(".mia-view .mia-thumb-navigation:not(:has(.mia-dock-undo, .mia-controls-help))")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr)", "margin-top": "0" });
    const source = readFileSync(new URL("../src/ui/study-view.ts", import.meta.url), "utf8");
    const browse = source.slice(source.indexOf('if ((!question || !question.id) && this.readOnlyBrowse)'), source.indexOf('const navigation = root.createDiv'));
    expect(browse.match(/done.createDiv\(\{ cls: "mia-inline-actions" \}\)/g)).toHaveLength(2);
    expect(browse).toContain('actions.createEl("button", { text: "처음부터 다시", cls: "mod-cta" })');
    expect(declarations(".mia-view .mia-hero-main > .mia-inline-actions + .mia-muted")).toMatchObject({ margin: "8px 0 0", "font-size": "var(--font-ui-small)" });
  });
});

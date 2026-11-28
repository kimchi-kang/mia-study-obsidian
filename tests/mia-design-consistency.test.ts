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
    // 1.6.2: 바탕은 완전 검정, 카드·버튼은 그보다 한 단계 밝은 면이라 검정 그림자와 위쪽 빛으로 떠 보인다.
    expect(tokens).toMatchObject({ "--mia-bg": "#000000", "--mia-panel": "#111216", "--mia-shadow-dark": "#000000", "color-scheme": "dark" });
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

  // 1.8.8: 순검정 바탕에서는 우하단 검정 그림자가 보이지 않아 좌상단 빛만 뿌옇게 번졌다(사용자 요청으로 변경).
  // 솟은 것은 윗변 안쪽 빛·얇은 윤곽·아래 그림자, 파인 것은 안쪽 어두운 그림자로 나누고, 빛은 바깥으로 번지지 않는다.
  it("raises with an inner top edge and keeps light from blooming outside on pure black", () => {
    for (const raised of [tokens["--mia-shadow"], tokens["--mia-shadow-small"]]) {
      expect(raised).toMatch(/^inset 0 1px 0 var\(--mia-shadow-light\), /);
      expect(raised).toMatch(/0 0 0 1px /);
      expect(raised).toMatch(/0 \d+px \d+px rgba\(0, 0, 0, /);
    }
    expect(tokens["--mia-shadow-inset"]).toMatch(/^inset 0 2px 4px rgba\(0, 0, 0, /);
    for (const value of [tokens["--mia-shadow"], tokens["--mia-shadow-small"], tokens["--mia-shadow-inset"]]) {
      // 음수 좌표로 바깥에 퍼지는 빛(옛 -5px -5px 10px)이 다시 생기지 않게 한다.
      expect(value).not.toMatch(/-\d/);
    }
    for (const palette of [tokens, night]) {
      expect(palette["--mia-shadow-light"]).toMatch(/^rgba\(255, 255, 255, \.0\d\)$/);
      // 버튼 면은 카드보다 반 단계 밝아 그림자 없이도 카드와 구분된다.
      expect(luminance(color(palette, "control"))).toBeGreaterThan(luminance(color(palette, "panel")));
      for (const text of ["ink", "muted", "accent-text"]) expect(contrast(palette, text, "control"), `${text} on control`).toBeGreaterThanOrEqual(4.5);
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
    expect(declarations(".mia-view .mia-nav button.mod-cta")).toMatchObject({ "box-shadow": "var(--mia-shadow-small)", color: "var(--mia-accent-text)", background: "var(--mia-control)" });
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

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const view = await readFile(new URL("../src/ui/study-view.ts", import.meta.url), "utf8");
const questionList = await readFile(new URL("../src/ui/question-list-page.ts", import.meta.url), "utf8");

describe("mobile UI contract", () => {
  it("shows every tab label in a bottom bar on phones", () => {
    // Full labels, not abbreviations: nothing is hidden by font-size or a short-label attribute.
    expect(view).not.toContain("shortLabel");
    expect(styles).not.toContain("data-short-label");
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.mia-nav\s*\{[^}]*position:\s*sticky;\s*bottom:\s*0/);
  });

  it("keeps the study-route nav governed by the focus setting on phones", () => {
    const phone = styles.slice(styles.indexOf("/* ── Phones: a bottom tab bar"), styles.indexOf("/* Phone detail: full screen"));
    // Never hidden unconditionally in study: focus mode on hides it (existing rule), focus off shows the bottom bar.
    expect(phone).not.toMatch(/\.mia-route-study\s+\.mia-nav\s*\{\s*display:\s*none/);
    expect(phone).toContain('.mia-route-study[data-focus="false"]) .mia-nav');
    expect(styles).toContain('.mia-route-study[data-focus="true"] .mia-header .mia-nav { display: none; }');
    expect(phone).toContain(".mia-keyboard-open .mia-nav { display: none; }");
  });

  it("hides the bottom nav over the keyboard with a rule that outranks and follows the show rule", () => {
    const phone = styles.slice(styles.indexOf("/* ── Phones: a bottom tab bar"), styles.indexOf("/* Phone detail: full screen"));
    const rules = [...phone.matchAll(/^\s*([^{}\n][^{}]*)\{([^}]*)\}/gm)].map(([, selector, body], order) => ({ selector: selector!.trim(), body: body!, order }));
    // :where() adds no specificity: drop its (balanced) argument list.
    const stripWhere = (selector: string): string => {
      const start = selector.indexOf(":where(");
      if (start < 0) return selector;
      let depth = 0, end = start + 6;
      for (; end < selector.length; end += 1) { if (selector[end] === "(") depth += 1; if (selector[end] === ")" && --depth === 0) break; }
      return stripWhere(selector.slice(0, start) + selector.slice(end + 1));
    };
    // Specificity as a class count: classes and attributes (also inside :not()) add 1; :is() counts as its heaviest argument.
    const weight = (selector: string): number => {
      selector = stripWhere(selector);
      const start = selector.indexOf(":is(");
      if (start < 0) return (selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;
      let depth = 0, end = start + 3;
      for (; end < selector.length; end += 1) { if (selector[end] === "(") depth += 1; if (selector[end] === ")" && --depth === 0) break; }
      const inner = selector.slice(start + 4, end);
      const args: string[] = []; let level = 0, from = 0;
      for (let at = 0; at <= inner.length; at += 1) {
        if (inner[at] === "(") level += 1; if (inner[at] === ")") level -= 1;
        if (at === inner.length || (inner[at] === "," && level === 0)) { args.push(inner.slice(from, at)); from = at + 1; }
      }
      return Math.max(...args.map(weight)) + weight(selector.slice(0, start) + selector.slice(end + 1));
    };
    const show = rules.find((rule) => rule.selector.endsWith(".mia-nav") && /position:\s*sticky/.test(rule.body))!;
    const hide = rules.find((rule) => rule.selector.includes(".mia-keyboard-open .mia-nav"))!;
    expect(hide.body).toContain("display: none");
    expect(hide.order).toBeGreaterThan(show.order);
    expect(weight(hide.selector)).toBeGreaterThan(weight(show.selector));
  });

  it("keeps the bottom tab bar exactly full width with safe-area insets", () => {
    const phone = styles.slice(styles.indexOf("/* ── Phones: a bottom tab bar"), styles.indexOf("/* ── Study on a phone"));
    const bar = phone.match(/\.mia-nav\s*\{([^}]*)\}/g)!.find((rule) => rule.includes("position: sticky"))!;
    // `.mia-nav` is capped at max-width: 100% elsewhere; the bleed margins only widen the bar if that cap is lifted.
    expect(bar).toContain("max-width: none");
    expect(bar).toMatch(/margin-inline:\s*calc\(-1 \* var\(--mia-bleed-left\)\) calc\(-1 \* var\(--mia-bleed-right\)\)/);
    expect(bar).toMatch(/padding:\s*0 var\(--mia-edge-right[^)]*\)\s+max\(0px, var\(--mia-edge-bottom[^)]*\)\)\s+var\(--mia-edge-left/);
    expect(bar).toContain("repeat(4, minmax(0, 1fr))");
  });

  it("keeps the full-screen phone detail dialog below the status bar and Dynamic Island", () => {
    // The insets are max(--safe-area-inset-*, env(safe-area-inset-*)) so both Obsidian's variables and env() work.
    expect(styles).toMatch(/--mia-modal-top:\s*max\(var\(--safe-area-inset-top, 0px\), env\(safe-area-inset-top, 0px\)\)/);
    expect(styles).toMatch(/\.is-phone \.modal-container:not\(\.mia-keyboard-open\):has\(> \.modal\.mia-detail-modal\)\s*\{\s*padding:\s*var\(--mia-modal-top, 0px\) var\(--mia-modal-right, 0px\) var\(--mia-modal-bottom, 0px\) var\(--mia-modal-left, 0px\)/);
  });

  it("collapses the study header into one slim 44px bar on phones", () => {
    const study = styles.slice(styles.indexOf("/* ── Study on a phone"), styles.indexOf("/* Phone detail: full screen"));
    expect(study).toContain("display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto");
    expect(study).toMatch(/\.mia-settings-buttons > button \{\s*grid-row: 1; min-height: 44px/);
    expect(study).toContain("repeat(4, minmax(0, 1fr))");
  });

  it("applies the bottom safe-area inset once in the phone study layout, never inside the dock", () => {
    const study = styles.slice(styles.indexOf("/* ── Study on a phone"), styles.indexOf("/* Phone detail: full screen"));
    const rules = [...study.replace(/^@media[^{]*\{/m, "").matchAll(/^\s*([^{}\n][^{}]*)\{([^}]*)\}/gm)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }));
    for (const rule of rules.filter(({ selector }) => selector.includes(".mia-study-dock"))) {
      expect(rule.body, rule.selector).not.toMatch(/--mia-edge-bottom|safe-area/);
    }
    const root = rules.find(({ selector }) => /route-study:has\(\.mia-study-layout\)$/.test(selector) && selector.includes("data-device"))!;
    expect(root.body).toContain("padding-bottom: calc(6px + var(--mia-edge-bottom, 0px))");
  });

  it("keeps the phone tab bar and study bar keyed to the device so a narrow desktop window is unchanged", () => {
    const phone = styles.slice(styles.indexOf("/* ── Phones: a bottom tab bar"), styles.indexOf("/* Phone detail: full screen"));
    expect(phone).toContain("@media (max-width: 640px), (max-height: 500px) and (pointer: coarse)");
    for (const rule of phone.match(/^\s*\.mia-view[^{}\n]*(?:\.mia-nav|\.mia-header|route-study)[^{}\n]*\{/gm) ?? []) {
      expect(rule, rule).toContain('[data-device="phone"]');
    }
  });

  it("collapses the dense question filter panel on mobile", () => {
    expect(questionList).toContain("filterPanel.open = !Platform.isMobile");
    expect(styles).toContain(".mia-filter-panel > summary");
  });

  it("keeps mobile touch controls at least 44 pixels high", () => {
    expect(styles).toMatch(/\.mia-view button,[\s\S]*?min-height:\s*44px/);
  });

  it("provides phone-sized keyboard, detail, and result modals", () => {
    expect(styles).toContain(".is-phone .mia-keyboard-modal");
    expect(styles).toContain(".is-phone .mia-detail-modal");
    expect(styles).toContain(".is-phone .mia-result-modal");
  });

  it("keeps short phone editors content-sized above the keyboard", () => {
    expect(styles).toMatch(/\.mia-keyboard-modal\s*\{[^}]*height:\s*auto\s*!important/);
    expect(styles).toMatch(/\.mia-keyboard-modal-container\.mia-keyboard-open\s*\{[^}]*align-items:\s*flex-end/);
    expect(styles).toContain(".mia-editor-modal-compact");
    expect(styles).toContain(".mia-editor-modal-long");
  });

  it("defines a dedicated tablet layout range", () => {
    expect(styles).toContain("@media (min-width: 641px) and (max-width: 1100px)");
    expect(styles).toMatch(/@media \(min-width: 641px\) and \(max-width: 1100px\)[\s\S]*?\.mia-keyboard-modal/);
  });

  it("reserves the Obsidian mobile navigation and safe-area space", () => {
    expect(styles).toContain("--mia-navbar-clearance");
    expect(styles).toContain("--safe-area-inset-bottom");
  });

  it("keeps dashboard text inside cards at every pane width", () => {
    expect(styles).toMatch(/\.mia-view\s*\{[\s\S]*?container-type:\s*inline-size/);
    expect(styles).toMatch(/\.mia-view\s*\{[\s\S]*?overflow-x:\s*hidden/);
    expect(styles).toMatch(/\.mia-stat\s*\{[^}]*height:\s*auto\s*!important/);
    expect(styles).toMatch(/\.mia-stat span\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(styles).toContain("@container mia-view (max-width: 1050px)");
    expect(styles).toContain("@container mia-view (max-width: 600px)");
    expect(styles).toContain("@container mia-view (max-width: 280px)");
  });
});

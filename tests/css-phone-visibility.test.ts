import { readdir, readFile } from "node:fs/promises";
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const uiDir = new URL("../src/ui/", import.meta.url);
const uiSource = (await Promise.all((await readdir(uiDir)).filter((file) => file.endsWith(".ts")).map((file) => readFile(new URL(file, uiDir), "utf8")))).join("\n");

/** Controls and readouts a phone layout must never hide, clip or shrink to nothing. */
const PROTECTED = [
  "mia-focus-exit", "mia-learning-button", "mia-appearance-button", "mia-thumb-navigation", "mia-thumb-previous",
  "mia-thumb-next", "mia-dock-undo", "mia-controls-help", "mia-reveal", "mia-ratings", "mia-session-edit-actions",
  "mia-progress-count", "mia-card-context", "mia-detail-actions", "mia-detail-reset",
];
/** Hides that are intended (decorative, duplicated elsewhere, or moved into 조작 안내); none is a protected class. */
const ALLOWED_HIDES = [".mia-brand", ".mia-badge", ".mia-study-navigation > button", ".mia-shortcut-hint", ".mia-progress-subject", ".mia-touch-hint", ".mia-nav"];

const hidesContent = (prop: string, value: string): boolean => {
  const v = value.replace(/!important/i, "").trim().toLowerCase();
  switch (prop.toLowerCase()) {
    case "display": return v === "none";
    case "visibility": return v === "hidden";
    case "opacity": return Number(v) === 0 && v !== "";
    case "width": case "height": return /^0(px|rem|em|%)?$/.test(v);
    case "clip": return v !== "auto";
    case "clip-path": return v !== "none";
    case "font-size": return /^0(px|rem|em|%)?$/.test(v);
    default: return false;
  }
};
const mentionsProtected = (selector: string): string | undefined => {
  // Pseudo-class arguments (:not(), :has()) do not make an element the target.
  const flat = selector.replace(/:(not|has|where)\((?:[^()]|\([^()]*\))*\)/g, "");
  return PROTECTED.find((name) => new RegExp(`\\.${name}(?![\\w-])`).test(flat));
};
const inPhoneContext = (rule: Rule): boolean => {
  for (let node = rule.parent; node && node.type !== "root"; node = node.parent) {
    if (node.type === "atrule" && (node as AtRule).name === "media" && /640px|pointer:\s*coarse/.test((node as AtRule).params)) return true;
  }
  return /\.is-phone|\[data-device="phone"\]|\.mia-keyboard-open/.test(rule.selector);
};

describe("phone CSS never hides protected controls", () => {
  const phoneRules: Rule[] = [];
  const allRules: Rule[] = [];
  root.walkRules((rule) => { allRules.push(rule); if (inPhoneContext(rule)) phoneRules.push(rule); });

  it("finds the phone rules it is meant to check", () => {
    expect(phoneRules.length).toBeGreaterThan(50);
    // Every protected name must be a real class in the UI code, so the list cannot rot silently.
    for (const name of PROTECTED) expect(uiSource, name).toContain(name);
  });

  it("declares no hiding property on a protected class inside phone, touch or keyboard rules", () => {
    const offenders: string[] = [];
    for (const rule of phoneRules) {
      for (const selector of rule.selectors) {
        const protectedName = mentionsProtected(selector);
        if (!protectedName || ALLOWED_HIDES.some((allowed) => selector.includes(allowed))) continue;
        rule.walkDecls((decl) => { if (hidesContent(decl.prop, decl.value)) offenders.push(`${selector} { ${decl.prop}: ${decl.value} }`); });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never truncates a protected readout with nowrap plus an ellipsis", () => {
    const offenders: string[] = [];
    for (const rule of allRules) {
      let ellipsis = false, nowrap = false;
      rule.walkDecls((decl) => {
        if (decl.prop === "text-overflow" && decl.value.trim() === "ellipsis") ellipsis = true;
        if (decl.prop === "white-space" && decl.value.trim() === "nowrap") nowrap = true;
      });
      if (!ellipsis || !nowrap) continue;
      for (const selector of rule.selectors) if (mentionsProtected(selector)) offenders.push(selector);
    }
    expect(offenders).toEqual([]);
  });
});

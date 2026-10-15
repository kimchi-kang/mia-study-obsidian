import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const view = await readFile(new URL("../src/ui/study-view.ts", import.meta.url), "utf8");

describe("mobile UI contract", () => {
  it("uses compact mobile navigation labels without wrapping", () => {
    expect(view).toContain("dataset.shortLabel");
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.mia-nav\s*\{[^}]*flex-wrap:\s*nowrap/);
  });

  it("collapses the dense question filter panel on mobile", () => {
    expect(view).toContain("filterPanel.open = !Platform.isMobile");
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
    expect(styles).toContain("@container mia-view (max-width: 380px)");
  });
});

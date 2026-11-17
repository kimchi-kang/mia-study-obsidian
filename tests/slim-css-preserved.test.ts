import { readFileSync } from "node:fs";
import postcss, { type AtRule } from "postcss";
import { expect, it } from "vitest";
import unrendered from "./fixtures/slim-unrendered-classes.json";
import preserved from "./fixtures/slim-preserved-css.json";

it("preserves interactive states and editor/keyboard and unrendered declarations from 1.4.27", () => {
  const rules: typeof preserved = [];
  postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8")).walkRules(rule => {
    const unmeasured = (rule.selector.match(/(?<=\.)mia-[\w-]+/g) ?? []).some(cls => unrendered.includes(cls));
    if (!/:hover|:focus|:active|:disabled|:enabled|:checked|:visited|:link|mia-(?:keyboard|editor|confirm|followup|follow-up|export|metadata)/.test(rule.selector) && !unmeasured) return;
    const context: string[][] = [];
    for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
      const condition = parent as AtRule;
      context.unshift([condition.name, condition.params]);
    }
    rules.push({ context, selector: rule.selector, declarations: rule.nodes.filter(node => node.type === "decl").map(d => [d.prop, d.value, !!d.important]) });
  });
  const ordered = (values: typeof preserved) => values.map(rule => JSON.stringify(rule)).sort();
  expect(ordered(rules)).toEqual(ordered(preserved));
});

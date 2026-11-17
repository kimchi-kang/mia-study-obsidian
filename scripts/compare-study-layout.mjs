import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

// Compare measurements from measure-study-layout.mjs, including optional style fingerprints.
if (process.argv.length !== 4) throw new Error("Usage: node scripts/compare-study-layout.mjs <before.json> <after.json>");
const [before, after] = await Promise.all(process.argv.slice(2).map(async path => JSON.parse(await readFile(path, "utf8"))));
if (!Array.isArray(before) || !before.length || !Array.isArray(after) || before.length !== after.length) throw new Error("Measurement case counts must be equal and non-empty.");
const differences = before.flatMap((item, index) => {
  if (isDeepStrictEqual(item, after[index])) return [];
  const keys = [...new Set([...Object.keys(item), ...Object.keys(after[index] ?? {})])]
    .filter(key => !isDeepStrictEqual(item[key], after[index]?.[key]));
  return [{ index, route: item.route, theme: item.theme, width: item.width, height: item.height, keys }];
});
if (differences.length) throw new Error(`Layout/style differences: ${JSON.stringify(differences)}`);
console.log(JSON.stringify({ cases: before.length, elements: before.reduce((count, item) => count + (item.computedStyles?.length ?? 0), 0), differences: 0 }, null, 2));

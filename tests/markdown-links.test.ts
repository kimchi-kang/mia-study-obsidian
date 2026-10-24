import { describe, expect, it } from "vitest";
import { rebaseMarkdownLinks } from "../src/core/markdown-links";

const rebase = (text: string) => rebaseMarkdownLinks(text, "MIA/math/bank.md", "MIA/physics/bank.md");
describe("question move Markdown links", () => {
  it.each([
    ['![image](./image.png)', '![image](../math/image.png)'],
    ['[note](notes/a.md#section "title")', '[note](../math/notes/a.md#section "title")'],
    ['[note](../shared/a.md)', '[note](../shared/a.md)'],
    ['![image](<./an image.png> "title")', '![image](<../math/an%20image.png> "title")'],
    ['[note](./a\\)b.md)', '[note](../math/a%29b.md)'],
    ['[note](./a(b).md)', '[note](../math/a%28b%29.md)'],
    ['[ref][id]\n\n[id]: ./note.md "title"', '[ref][id]\n\n[id]: ../math/note.md "title"'],
    ['> ![image](./image.png)', '> ![image](../math/image.png)'],
    ['[![image](./image.png)](./note.md)', '[![image](../math/image.png)](../math/note.md)'],
  ])("rebases %s without rewriting its label or title", (before, after) => expect(rebase(before)).toBe(after));

  it.each([
    '`![image](./image.png)`',
    '```md\n![image](./image.png)\n```',
    '> ```md\n> ![image](./image.png)\n> ```',
    '    ![image](./image.png)',
    '[web](https://example.com/a) ![data](data:image/png;base64,aaaa)',
    '[anchor](#section) [root](/image.png) [[relative/wiki]]',
    '[not a valid link](./note.md extra text)',
    '<!-- [example](./note.md) -->',
  ])("preserves code and non-relative or invalid links: %s", text => expect(rebase(text)).toBe(text));

  it("rebases the actual link while leaving inline code untouched", () => {
    expect(rebase('`[code](./a)` [note](./a)')).toBe('`[code](./a)` [note](../math/a)');
  });
  it("encodes actual source folder names containing URL punctuation", () => {
    expect(rebaseMarkdownLinks('[note](./a.md)', 'MIA/math#1/bank.md', 'MIA/physics/bank.md')).toBe('[note](../math%231/a.md)');
  });
});

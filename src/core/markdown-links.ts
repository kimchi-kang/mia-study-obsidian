import MarkdownIt, { type Token } from "markdown-it";

/** Preserve Markdown spelling and code while changing only parsed link destinations. */
export function rebaseMarkdownLinks(markdown: string, sourcePath: string, destinationPath: string): string {
  if (sourcePath === destinationPath) return markdown;
  const parser = new MarkdownIt({ html: true });
  const edits = new Map<number, { end: number; text: string }>();
  let activeSource = markdown;
  let pending: Array<{ start: number; end: number; target: string }> = [];
  const parseDestination = parser.helpers.parseLinkDestination;
  // Helpers are shared by MarkdownIt instances; keep this instrumentation instance-local.
  parser.helpers = { ...parser.helpers, parseLinkDestination: (source, start, max) => {
    const result = parseDestination(source, start, max);
    if (result.ok && source === activeSource) pending.push({ start, end: result.pos, target: result.str });
    return result;
  } };
  const accept = () => {
    for (const { start, end, target } of pending) {
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/iu.test(target)) continue;
      const base = new URL(sourcePath.split("/").map(encodeURIComponent).join("/"), "https://mia.invalid/");
      const resolved = new URL(target, base);
      const folder = new URL(destinationPath.split("/").map(encodeURIComponent).join("/"), "https://mia.invalid/").pathname.split("/").slice(1, -1);
      const parts = resolved.pathname.split("/").slice(1);
      while (folder.length && parts.length && folder[0] === parts[0]) { folder.shift(); parts.shift(); }
      const relative = `${"../".repeat(folder.length)}${parts.join("/").replaceAll("(", "%28").replaceAll(")", "%29")}${resolved.search}${resolved.hash}`;
      edits.set(start, { end, text: activeSource[start] === "<" ? `<${relative}>` : relative });
    }
  };
  const masked = markdown.split("");
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index++) if (markdown[index] === "\n") lineStarts.push(index + 1);
  const maskLines = (start: number, end: number) => {
    for (let index = lineStarts[start] ?? markdown.length; index < (lineStarts[end] ?? markdown.length); index++) {
      if (masked[index] !== "\n") masked[index] = " ";
    }
  };
  const reference = { ...parser.block.ruler.__rules__.find(rule => rule.name === "reference")! };
  parser.block.ruler.at("reference", (state, start, end, silent) => {
    pending = [];
    const accepted = reference.fn(state, start, end, silent);
    if (accepted && !silent) { accept(); maskLines(start, state.line); }
    pending = [];
    return accepted;
  }, { alt: reference.alt });
  const tokens: Token[] = [];
  const environment = {};
  parser.block.parse(markdown, parser, environment, tokens);
  for (const token of tokens) if ((token.type === "fence" || token.type === "code_block" || token.type === "html_block") && token.map) maskLines(token.map[0], token.map[1]);
  activeSource = masked.join("");
  for (const name of ["link", "image"]) {
    const rule = { ...parser.inline.ruler.__rules__.find(item => item.name === name)! };
    parser.inline.ruler.at(name, (state, silent) => {
      const outer = pending;
      pending = [];
      const accepted = rule.fn(state, silent);
      if (accepted && !silent) accept();
      pending = outer;
      return accepted;
    });
  }
  parser.inline.parse(activeSource, parser, environment, []);
  let result = markdown;
  for (const [start, { end, text }] of [...edits].sort(([left], [right]) => right - left)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}

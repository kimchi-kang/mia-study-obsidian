import MarkdownIt, { type Token } from "markdown-it";
import {
  Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
  type ParagraphChild,
} from "docx";
import type { QuestionRecord } from "./models";
import { fencedCodeLines } from "./markdown-structure";

export interface ExportImage {
  data: ArrayBuffer;
  type: "png" | "jpg" | "gif" | "bmp";
  width: number;
  height: number;
}
export type ExportImageReader = (target: string, sourcePath: string) => Promise<ExportImage | null>;
export interface SubjectExportResult { data: ArrayBuffer; count: number; warnings: string[] }

// Strip only standalone management lines, never occurrences inside prose or code.
export function cleanExportMarkdown(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const fenced = fencedCodeLines(lines);
  let metadata = false;
  return lines.filter((line, index) => {
    if (fenced[index]) return true;
    if (/^>\s*\[!mia\][+-]?(?:\s|$)/iu.test(line)) { metadata = true; return false; }
    if (metadata && /^>/.test(line)) return false;
    metadata = false;
    if (/^\^mia-q-[A-Za-z0-9-]+\s*$/u.test(line)) return false;
    if (/^\s*(?:\*\*)?원문(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(?:\[\[[^\n]+\]\]|\[[^\]]+\]\([^)]+\))\s*$/u.test(line)) return false;
    return !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line);
  }).join("\n").trim();
}

function parser() {
  const md = new MarkdownIt({ html: false, breaks: true });
  md.inline.ruler.before("escape", "mia_math", (state, silent) => {
    const rest = state.src.slice(state.pos);
    const opening = ["$$", "\\[", "\\(", "$"].find((value) => rest.startsWith(value));
    if (!opening) return false;
    const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
    const end = state.src.indexOf(closing, state.pos + opening.length);
    if (end < 0) return false;
    if (!silent) state.push("mia_math", "", 0).content = state.src.slice(state.pos, end + closing.length);
    state.pos = end + closing.length;
    return true;
  });
  md.inline.ruler.before("link", "mia_wiki", (state, silent) => {
    const match = /^(!?)\[\[([^\]\n]+)\]\]/u.exec(state.src.slice(state.pos));
    if (!match) return false;
    const [target = "", label] = (match[2] ?? "").split("|");
    if (!silent) {
      const token = state.push(match[1] ? "image" : "text", "", 0);
      token.content = label ?? target.split("/").at(-1) ?? target;
      if (match[1]) token.attrSet("src", target);
    }
    state.pos += match[0].length;
    return true;
  });
  return md;
}

interface RenderContext {
  sourcePath: string;
  warnings: Set<string>;
  readImage?: ExportImageReader;
  pauseIfNeeded(): Promise<void> | undefined;
}

async function inline(tokens: readonly Token[], context: RenderContext): Promise<ParagraphChild[]> {
  const runs: ParagraphChild[] = [];
  let bold = 0, italics = 0, strike = 0;
  for (const token of tokens) {
    const pause = context.pauseIfNeeded();
    if (pause) await pause;
    if (token.type === "strong_open") { bold++; continue; }
    if (token.type === "strong_close") { bold--; continue; }
    if (token.type === "em_open") { italics++; continue; }
    if (token.type === "em_close") { italics--; continue; }
    if (token.type === "s_open") { strike++; continue; }
    if (token.type === "s_close") { strike--; continue; }
    if (token.type === "softbreak" || token.type === "hardbreak") { runs.push(new TextRun({ break: 1 })); continue; }
    if (token.type === "image") {
      const target = String(token.attrGet("src") ?? "");
      const image = await context.readImage?.(target, context.sourcePath);
      if (image) {
        const scale = Math.min(1, 590 / image.width, 700 / image.height);
        runs.push(new ImageRun({ data: image.data, type: image.type, transformation: { width: image.width * scale, height: image.height * scale } }));
      } else {
        context.warnings.add(`첨부 이미지를 넣지 못했습니다: ${target}`);
        runs.push(new TextRun(`[이미지: ${token.content || target}]`));
      }
      continue;
    }
    if (token.type === "mia_math") context.warnings.add("수식은 Word 수식으로 변환하지 않고 원문 LaTeX 표기로 저장했습니다.");
    if (["text", "code_inline", "mia_math", "html_inline"].includes(token.type)) {
      runs.push(new TextRun({ text: token.content, ...(bold ? { bold: true } : {}), ...(italics ? { italics: true } : {}), ...(strike ? { strike: true } : {}),
        ...(token.type === "code_inline" ? { font: "Consolas" } : {}) }));
    }
  }
  return runs;
}

async function table(tokens: readonly Token[], context: RenderContext): Promise<Table> {
  const rows: TableRow[] = [];
  let cells: TableCell[] = [], children: ParagraphChild[] = [], header = false, headerRow = false;
  for (const token of tokens) {
    const pause = context.pauseIfNeeded();
    if (pause) await pause;
    if (token.type === "tr_open") { cells = []; headerRow = false; }
    if (token.type === "th_open" || token.type === "td_open") { children = []; header = token.type === "th_open"; if (header) headerRow = true; }
    if (token.type === "inline") children.push(...await inline(token.children ?? [], context));
    if (token.type === "th_close" || token.type === "td_close") cells.push(new TableCell({
      children: [new Paragraph({ children })], ...(header ? { shading: { fill: "F1F1F1" } } : {}),
    }));
    if (token.type === "tr_close") rows.push(new TableRow({ children: cells, ...(headerRow ? { tableHeader: true } : {}) }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

async function blocks(markdown: string, context: RenderContext): Promise<Array<Paragraph | Table>> {
  const tokens = parser().parse(cleanExportMarkdown(markdown), {});
  const output: Array<Paragraph | Table> = [];
  const lists: Array<{ ordered: boolean; next: number; marker: boolean }> = [];
  let heading = false;
  for (let index = 0; index < tokens.length; index++) {
    const pause = context.pauseIfNeeded();
    if (pause) await pause;
    const token = tokens[index];
    if (!token) continue;
    if (token.type === "table_open") {
      const end = tokens.findIndex((item, offset) => offset > index && item.type === "table_close");
      output.push(await table(tokens.slice(index, end + 1), context)); index = end; continue;
    }
    if (token.type === "heading_open") heading = true;
    if (token.type === "heading_close") heading = false;
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") lists.push({
      ordered: token.type === "ordered_list_open", next: Number(token.attrGet("start") ?? 1), marker: false,
    });
    if (token.type === "bullet_list_close" || token.type === "ordered_list_close") lists.pop();
    const list = lists.at(-1);
    if (token.type === "list_item_open" && list) list.marker = true;
    if (token.type === "inline") {
      const prefix = list?.marker ? `${list.ordered ? `${list.next++}.` : "•"} ` : "";
      if (list) list.marker = false;
      output.push(new Paragraph({ children: [...(prefix ? [new TextRun(prefix)] : []), ...await inline(token.children ?? [], context)],
        ...(heading ? { heading: HeadingLevel.HEADING_3 } : {}),
        ...(list ? { indent: { left: lists.length * 280 } } : {}),
        spacing: { after: 120 }, widowControl: true,
      }));
    }
    if (token.type === "fence" || token.type === "code_block") {
      const lines = token.content.trimEnd().split("\n");
      for (const [lineIndex, line] of lines.entries()) {
        const pause = context.pauseIfNeeded();
        if (pause) await pause;
        output.push(new Paragraph({
          children: [new TextRun({ text: line, font: "Consolas", size: 19 })], spacing: { after: 0 },
          keepNext: lineIndex < lines.length - 1, keepLines: true,
        }));
      }
    }
  }
  return output;
}

const EXPORT_SLICE_MS = 16;

export async function exportSubjectDocx(
  subject: string, questions: readonly QuestionRecord[], readImage?: ExportImageReader,
): Promise<SubjectExportResult> {
  const comparePaths = new Intl.Collator("ko", { numeric: true }).compare;
  const selected = questions.filter((question) => question.subject === subject).sort((a, b) =>
    comparePaths(a.filePath, b.filePath) || a.location.headingLine - b.location.headingLine);
  if (!selected.length) throw new Error("출력할 질문이 없습니다.");
  const warnings = new Set<string>();
  const children: Array<Paragraph | Table> = [new Paragraph({ text: `${subject} 질문 답변 정리`, heading: HeadingLevel.TITLE })];
  let sliceStartedAt = performance.now();
  const pauseIfNeeded = (): Promise<void> | undefined => {
    if (performance.now() - sliceStartedAt < EXPORT_SLICE_MS) return;
    return new Promise<void>((resolve) => setTimeout(() => {
      sliceStartedAt = performance.now();
      resolve();
    }, 0));
  };
  for (const [index, question] of selected.entries()) {
    // Awaiting already-resolved rendering promises does not let input/timers run.
    if (index === 0 || performance.now() - sliceStartedAt >= EXPORT_SLICE_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sliceStartedAt = performance.now();
    }
    const context: RenderContext = { sourcePath: question.filePath, warnings, pauseIfNeeded, ...(readImage ? { readImage } : {}) };
    children.push(new Paragraph({ text: `질문 ${index + 1}`, heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 300, after: 100 } }));
    children.push(...await blocks(question.questionMarkdown, context));
    children.push(new Paragraph({ children: [new TextRun({ text: "답변", bold: true })], keepNext: true, spacing: { before: 80, after: 100 } }));
    children.push(...await blocks(question.answerMarkdown, context));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const doc = new Document({
    creator: "MIA Study", title: `${subject} 질문 답변 정리`,
    styles: { default: {
      document: { run: { font: "맑은 고딕", size: 22, color: "000000" }, paragraph: { spacing: { line: 300, after: 120 } } },
      title: { run: { font: "맑은 고딕", size: 36, bold: true, color: "000000" }, paragraph: { spacing: { after: 300 } } },
      heading2: { run: { size: 26, bold: true, color: "000000" } },
      heading3: { run: { size: 23, bold: true, color: "000000" } },
    } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return { data: await Packer.toArrayBuffer(doc), count: selected.length, warnings: [...warnings] };
}

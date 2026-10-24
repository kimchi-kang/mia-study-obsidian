import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { cleanExportMarkdown, exportSubjectDocx } from "../src/core/subject-export";
import { renderManagedQuestion } from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";

function question(subject: string, id: string, prompt: string, answer: string) {
  return parseQuestionFile(`MIA/${subject}/문제은행.md`, renderManagedQuestion({
    questionMarkdown: prompt, answerMarkdown: answer, questionType: "정의형", coreKeywords: [], subKeywords: [],
  }, id), { subject }).questions;
}

async function documentXml(data: ArrayBuffer) {
  const zip = await JSZip.loadAsync(data);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("No Word document");
  return { zip, xml: await file.async("string") };
}

describe("subject Word export", () => {
  it("exports only the selected subject's questions and answers without managed metadata or source links", async () => {
    const questions = [
      ...question("수학", "mia-q-one", "사과 **두 개**에 세 개를 더하면?", "5개다.\n\n---\n원문: [[비공개 원본|출처]]"),
      ...question("역사", "mia-q-other", "다른 과목의 질문", "다른 과목의 답변"),
      ...question("수학", "mia-q-two", "덧셈이란?", "수량을 합하는 연산이다."),
    ];
    const originals = JSON.stringify(questions);
    const result = await exportSubjectDocx("수학", questions);
    const { xml } = await documentXml(result.data);
    expect(result.count).toBe(2);
    expect(result.warnings).toEqual([]);
    for (const text of ["수학 질문 답변 정리", "질문 1", "질문 2", "5개다.", "수량을 합하는 연산이다."]) expect(xml).toContain(text);
    for (const text of ["mia-q-", "학습 정보", "비공개 원본", "원문:", "다른 과목", "[!question]", "**두 개**"]) expect(xml).not.toContain(text);
    expect(xml).toContain("<w:b/>");
    expect(JSON.stringify(questions)).toBe(originals);
  });

  it("retains tables, lists, code and literal formulas and resolves vault images using the source file", async () => {
    const answer = "- 첫째\n- 둘째\n\n| 이름 | 값 |\n| --- | --- |\n| 합 | 5 |\n\n```text\n^mia-q-keep-in-code\n원문: [[keep-in-code]]\n```\n\n수식 $a_1 + b_2 = c$ 와 \\(x \\times y\\)\n\n![[그림.png|예제 그림]]";
    const questions = question("수학", "mia-q-one", "예제 질문", answer);
    const image = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=", "base64")).buffer;
    const targets: string[] = [];
    const result = await exportSubjectDocx("수학", questions, async (target, source) => {
      targets.push(`${source}:${target}`);
      return { data: image, type: "png", width: 1, height: 1 };
    });
    const { xml, zip } = await documentXml(result.data);
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("첫째"); expect(xml).toContain("둘째");
    expect(xml).toContain("^mia-q-keep-in-code");
    expect(xml).toContain("원문: [[keep-in-code]]");
    expect(xml).toContain("$a_1 + b_2 = c$");
    expect(xml).toContain("\\(x \\times y\\)");
    expect(result.warnings).toHaveLength(1);
    expect(targets).toEqual(["MIA/수학/문제은행.md:그림.png"]);
    expect(Object.keys(zip.files).some((path) => path.startsWith("word/media/") && path.endsWith(".png"))).toBe(true);
  });

  it("reports unsupported or missing images instead of silently losing content", async () => {
    const result = await exportSubjectDocx("수학", question("수학", "mia-q-one", "그림을 보시오", "![[missing.svg|회로 그림]]"));
    const { xml } = await documentXml(result.data);
    expect(xml).toContain("[이미지: 회로 그림]");
    expect(result.warnings).toEqual(["첨부 이미지를 넣지 못했습니다: missing.svg"]);
  });

  it("does not create external Word relationships or expose note paths through document metadata", async () => {
    const questions = question("수학", "mia-q-private-sentinel", "[사이트](https://example.invalid/private) <script>secret()</script>", "![원격](https://example.invalid/tracker.png) ![[로컬 없음.svg]]");
    const result = await exportSubjectDocx("수학", questions);
    const { zip, xml } = await documentXml(result.data);
    const textFiles = Object.values(zip.files).filter(file => !file.dir && /\.(?:xml|rels)$/u.test(file.name));
    const parts = await Promise.all(textFiles.map(file => file.async("string")));
    const packageText = parts.join("\n");
    expect(packageText).not.toContain('TargetMode="External"');
    expect(packageText).not.toContain("https://example.invalid");
    expect(packageText).not.toContain(questions[0]?.filePath);
    expect(packageText).not.toContain("mia-q-private-sentinel");
    expect(xml).toContain("&lt;script&gt;secret()&lt;/script&gt;");
    expect(xml).not.toContain("<script>");
    expect(await zip.file("docProps/core.xml")?.async("string")).toContain("MIA Study");
    expect(result.warnings).toHaveLength(2);
  });

  it("does not export an empty subject", async () => {
    await expect(exportSubjectDocx("수학", [])).rejects.toThrow("출력할 질문이 없습니다.");
  });

  it("removes standalone management lines but preserves similar answer text", () => {
    const source = "> [!mia]- 학습 정보\n> 유형: 정의형\n\n설명에서 원문:이라는 표현을 사용한다.\n\n**원문:** [[출처]]\n^mia-q-test";
    expect(cleanExportMarkdown(source)).toBe("설명에서 원문:이라는 표현을 사용한다.");
  });
});


it("marks only each table's header row for repetition across pages", async () => {
  const table = "| 단계 | 검사값 |\n| --- | --- |\n| 첫째 | 1 |\n| 둘째 | 2 |";
  const questions = question("표", "mia-q-tables", table, table);
  const before = JSON.stringify(questions);
  const result = await exportSubjectDocx("표", questions);
  const { xml } = await documentXml(result.data);
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/gu) ?? [];
  expect(tables).toHaveLength(2);
  for (const entry of tables) {
    const rows = entry.match(/<w:tr[ >][\s\S]*?<\/w:tr>/gu) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("<w:tblHeader/>");
    for (const body of rows.slice(1)) expect(body).not.toContain("w:tblHeader");
  }
  expect(JSON.stringify(questions)).toBe(before);
});

it("keeps Korean numeric path order, heading order and stable ties without changing the input", async () => {
  const entry = (path: string, line: number, marker: string) => question("수학", `mia-q-${marker.toLowerCase().replaceAll("_", "-")}`, marker, "정답")
    .map((record) => ({ ...record, filePath: `MIA/수학/${path}.md`, location: { ...record.location, headingLine: line } }));
  const questions = [
    ...entry("가10", 1, "ORDER_TEN_END"),
    ...entry("나1", 1, "ORDER_NA_END"),
    ...entry("가2", 9, "ORDER_LATE_END"),
    ...entry("가2", 3, "ORDER_EARLY_END"),
    ...entry("가2", 3, "ORDER_TIE_END"),
    ...question("역사", "mia-q-excluded", "EXCLUDED_ORDER_END", "다른 과목"),
  ];
  const before = JSON.stringify(questions);
  const result = await exportSubjectDocx("수학", questions);
  const { xml } = await documentXml(result.data);
  expect(xml.match(/ORDER_[A-Z]+_END/gu)).toEqual([
    "ORDER_EARLY_END", "ORDER_TIE_END", "ORDER_LATE_END", "ORDER_TEN_END", "ORDER_NA_END",
  ]);
  expect(xml).not.toContain("EXCLUDED_ORDER_END");
  expect(result.count).toBe(5);
  expect(JSON.stringify(questions)).toBe(before);
});

it("preserves each table and the prose between tables in one long answer", async () => {
  const answer = Array.from({ length: 24 }, (_, index) =>
    `문단시작_${index}_끝\n\n| 머리_${index}_끝 | 값 |\n| --- | --- |\n| 셀_${index}_끝 | **강조_${index}_끝** |\n\n문단종료_${index}_끝`,
  ).join("\n\n");
  const questions = question("연속표", "mia-q-multiple-tables", "질문 표 보존", answer);
  const original = JSON.stringify(questions);
  const result = await exportSubjectDocx("연속표", questions);
  const { xml } = await documentXml(result.data);
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/gu) ?? [];
  expect(tables).toHaveLength(24);
  let previousEnd = -1;
  for (let index = 0; index < 24; index++) {
    const table = tables[index] ?? "";
    for (const marker of [`머리_${index}_끝`, `셀_${index}_끝`, `강조_${index}_끝`]) {
      expect(table).toContain(marker);
      expect(xml.split(marker)).toHaveLength(2);
    }
    expect(table).toContain("<w:b/>");
    const start = xml.indexOf(`문단시작_${index}_끝`);
    const tableStart = xml.indexOf(table, start);
    const end = xml.indexOf(`문단종료_${index}_끝`);
    expect(start).toBeGreaterThan(previousEnd);
    expect(tableStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(tableStart + table.length);
    previousEnd = end;
  }
  expect(result.warnings).toEqual([]);
  expect(JSON.stringify(questions)).toBe(original);
});

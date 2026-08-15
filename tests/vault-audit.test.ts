import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQuestionFile } from "../src/core/question-parser";
import { registerQuestion, updateQuestionMetadata } from "../src/core/question-writer";

const vaultPath = process.env.MIA_AUDIT_VAULT;

async function markdownFiles(folder: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === ".obsidian" || entry.name === ".git") continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) output.push(...await markdownFiles(path));
    if (entry.isFile() && entry.name.toLocaleLowerCase("en").endsWith(".md")) output.push(path);
  }
  return output;
}

describe.skipIf(!vaultPath)("read-only vault compatibility audit", () => {
  it("parses every question callout without empty prompts, answers, or diagnostics", async () => {
    if (!vaultPath) return;
    const parsed = await Promise.all((await markdownFiles(vaultPath)).map(async (path) =>
      parseQuestionFile(relative(vaultPath, path).replaceAll("\\", "/"), await readFile(path, "utf8")),
    ));
    const questions = parsed.flatMap((file) => file.questions);
    const diagnostics = parsed.flatMap((file) => file.diagnostics);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.filter((question) => !question.questionMarkdown.trim())).toEqual([]);
    expect(questions.filter((question) => !question.answerMarkdown.trim())).toEqual([]);
    expect(diagnostics).toEqual([]);
    console.info(`MIA vault audit: ${questions.length} questions in ${parsed.filter((file) => file.questions.length).length} notes`);
  });

  it("round-trips dummy metadata for every question entirely in memory", async () => {
    if (!vaultPath) return;
    let checked = 0;
    for (const path of await markdownFiles(vaultPath)) {
      const filePath = relative(vaultPath, path).replaceAll("\\", "/");
      const content = await readFile(path, "utf8");
      const questions = parseQuestionFile(filePath, content).questions;
      for (const question of questions) {
        const metadata = {
          questionType: "정의형" as const,
          coreKeywords: [{ target: "MIA/키워드/감사", label: "감사", raw: "[[MIA/키워드/감사|감사]]" }],
          subKeywords: [],
        };
        const id = question.id ?? `mia-q-audit-${checked}`;
        const rewritten = question.id
          ? updateQuestionMetadata(content, question, metadata)
          : registerQuestion(content, question, metadata, id);
        const roundTripped = parseQuestionFile(filePath, rewritten).questions.find((candidate) => candidate.id === id);
        expect(roundTripped?.questionMarkdown).toBe(question.questionMarkdown);
        expect(roundTripped?.answerMarkdown).toBe(question.answerMarkdown);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
    console.info(`MIA vault write audit: ${checked} in-memory round trips`);
  });
});

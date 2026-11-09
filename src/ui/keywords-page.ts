import type { KeywordReference, QuestionRecord } from "../core/models";
import type { KeywordNoteEntry } from "../services/keyword-operations";
import { renderQuestionHeading } from "./question-row";
import type { StudyPageContext } from "./study-page-context";

/** Groups references to the same note, however the link was written. */
function keywordKey(keyword: KeywordReference): string {
  const path = keyword.target.split("#")[0]?.replace(/\.md$/i, "").replaceAll("\\", "/") ?? keyword.label;
  return (path.split("/").at(-1) ?? path).trim().toLocaleLowerCase("ko");
}

export function renderKeywords(ctx: StudyPageContext, root: HTMLElement): void {
  const pageActions = root.createDiv({ cls: "mia-page-actions" });
  pageActions.createEl("button", { text: "키워드 추가", cls: "mod-cta" }).addEventListener("click", () => {
    ctx.plugin.openKeywordEditor();
  });
  const toolbar = root.createDiv({ cls: "mia-toolbar" });
  const search = toolbar.createEl("input", { type: "search", placeholder: "키워드 검색", attr: { "aria-label": "키워드 검색" } });
  const keywords = new Map<string, {
    keyword: KeywordReference;
    questions: Map<string, QuestionRecord & { id: string }>;
    entry?: KeywordNoteEntry;
  }>();
  for (const entry of ctx.plugin.listKeywordNotes()) {
    const keyword = { target: entry.target, label: entry.name, raw: `[[${entry.target}|${entry.name}]]` };
    keywords.set(keywordKey(keyword), { keyword, questions: new Map(), entry });
  }
  for (const question of ctx.plugin.index.registered) {
    for (const keyword of [...question.coreKeywords, ...question.subKeywords]) {
      const key = keywordKey(keyword);
      const item = keywords.get(key) ?? { keyword, questions: new Map() };
      item.questions.set(question.id, question);
      keywords.set(key, item);
    }
  }
  const grid = root.createDiv({ cls: "mia-keyword-grid" });
  const renderGrid = () => {
    grid.empty();
    const query = search.value.trim().toLocaleLowerCase("ko");
    const items = [...keywords.values()]
      .filter((item) => !query || `${item.keyword.label}\n${item.keyword.target}`.toLocaleLowerCase("ko").includes(query))
      .sort((a, b) => b.questions.size - a.questions.size || a.keyword.label.localeCompare(b.keyword.label, "ko"));
    for (const item of items) {
      const questions = [...item.questions.values()];
      const coreCount = questions.filter((question) => question.coreKeywords.some((keyword) => keywordKey(keyword) === keywordKey(item.keyword))).length;
      const subCount = questions.filter((question) => question.subKeywords.some((keyword) => keywordKey(keyword) === keywordKey(item.keyword))).length;
      const card = grid.createDiv({ cls: "mia-keyword" });
      card.createEl("strong", { text: item.keyword.label });
      card.createEl("span", { text: `${questions.length}문제 · 핵심 ${coreCount} · 보조 ${subCount}` });
      const reference = questions[0];
      card.addEventListener("click", () => {
        const sourcePath = reference?.filePath ?? item.entry?.filePath;
        if (sourcePath) ctx.plugin.showKeywordMeaning(item.keyword.target, item.keyword.label, sourcePath);
      });
      const editEntry = item.entry ?? {
        name: item.keyword.label,
        target: item.keyword.target,
        filePath: `${item.keyword.target}.md`,
      };
      const edit = card.createEl("button", { text: "키워드 수정" });
      edit.addEventListener("click", (event) => {
        event.stopPropagation();
        ctx.plugin.openKeywordEditor(editEntry);
      });
      const review = card.createEl("button", { text: "연결 문제 시험" });
      review.disabled = questions.length === 0;
      review.addEventListener("click", (event) => {
        event.stopPropagation();
        ctx.startReview(questions.map((question) => question.id));
      });
      const browse = card.createEl("button", { text: "연결 문제 암기" });
      browse.disabled = questions.length === 0;
      browse.addEventListener("click", (event) => {
        event.stopPropagation();
        ctx.startReview(questions.map((question) => question.id), "browse");
      });
      if (questions.length) {
        const details = card.createEl("details", { cls: "mia-keyword-questions" });
        details.addEventListener("click", (event) => event.stopPropagation());
        details.createEl("summary", { text: "연결 질문 보기" });
        for (const question of questions.slice(0, 300)) {
          const questionButton = details.createEl("button");
          renderQuestionHeading(ctx, questionButton, question);
          questionButton.addEventListener("click", () => void ctx.plugin.openQuestionDetail(question));
        }
      }
      const remove = card.createEl("button", { text: "키워드 삭제", cls: "mod-warning" });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        ctx.plugin.confirmDeleteKeyword(editEntry);
      });
    }
    if (!items.length) grid.createEl("p", {
      text: keywords.size ? "검색 조건에 맞는 키워드가 없습니다." : "키워드를 추가하거나 질문에 핵심/보조 키워드를 연결하면 여기에 나타납니다.",
      cls: "mia-empty",
    });
  };
  let composing = false;
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; renderGrid(); });
  search.addEventListener("input", () => { if (!composing) renderGrid(); });
  renderGrid();
}

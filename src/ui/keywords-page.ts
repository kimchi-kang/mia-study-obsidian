import { reportUiFailure } from "./error-message";
import { groupKeywordQuestions, keywordKey, rankKeywordWeakness } from "../core/keyword-radar";
import type { KeywordReference } from "../core/models";
import type { KeywordNoteEntry } from "../services/keyword-operations";
import { renderQuestionHeading } from "./question-row";
import type { StudyPageContext } from "./study-page-context";

export function renderKeywords(ctx: StudyPageContext, root: HTMLElement): void {
  const pageActions = root.createDiv({ cls: "mia-page-actions" });
  pageActions.createEl("button", { text: "키워드 추가", cls: "mod-cta" }).addEventListener("click", () => {
    ctx.plugin.openKeywordEditor();
  });
  const { index, store, fsrs } = ctx.plugin;
  const groups = groupKeywordQuestions(index.registered);
  type Links = NonNullable<ReturnType<typeof groups.get>>["questions"];
  type KeywordItem = { keyword: KeywordReference; questions: Links; entry?: KeywordNoteEntry };
  const keywords = new Map<string, KeywordItem>();
  for (const entry of ctx.plugin.listKeywordNotes()) {
    const keyword = { target: entry.target, label: entry.name, raw: `[[${entry.target}|${entry.name}]]` };
    const key = keywordKey(keyword);
    keywords.set(key, { keyword, questions: groups.get(key)?.questions ?? new Map(), entry });
  }
  for (const [key, group] of groups) if (!keywords.has(key)) keywords.set(key, group);
  const noteNames = new Map([...keywords].map(([key, item]) => [key, item.keyword.label]));
  const ranked = rankKeywordWeakness(groups, store.reviews, fsrs, noteNames);
  const scores = new Map(ranked.map((item, i) => [item.key, i]));
  const showMeaning = (item: KeywordItem) => {
    const first = item.questions.values().next().value;
    const path = first?.question.filePath ?? item.entry?.filePath;
    if (path) ctx.plugin.showKeywordMeaning(item.keyword.target, item.keyword.label, path);
  };
  if (ranked.length) {
    const radar = root.createEl("section", { cls: "mia-keyword-radar" });
    radar.createEl("h3", { text: "흔들리는 개념 Top 5" });
    const rows = radar.createEl("ol");
    for (const item of ranked.slice(0, 5)) {
      const row = rows.createEl("li");
      const keyword = keywords.get(item.key)!;
      row.createEl("button", { text: item.label, attr: { "aria-label": `${item.label} 의미 보기` } })
        .addEventListener("click", () => showMeaning(keyword));
      row.createEl("span", { cls: "mia-muted", text: `기억률\u00a0${Math.round(item.averageRecall * 100)}% · 문제\u00a0${item.studied}/${item.total} 학습 · 잊음\u00a0${item.lapses}회 · 최근 못\u00a0암기\u00a0${item.again} · 애매\u00a0${item.hard}` });
      row.createEl("button", { text: "이 개념 학습", cls: "mia-radar-start" })
        .addEventListener("click", () => ctx.startFocusedReview(item.questionIds));
    }
  }
  const toolbar = root.createDiv({ cls: "mia-toolbar mia-keyword-toolbar" });
  const search = toolbar.createEl("input", { type: "search", placeholder: "키워드 검색", attr: { "aria-label": "키워드 검색" } });
  const sort = toolbar.createEl("select", { attr: { "aria-label": "키워드 정렬" } });
  sort.createEl("option", { text: "연결 문제 많은 순", attr: { value: "linked" } });
  sort.createEl("option", { text: "취약 순", attr: { value: "weak" } });
  const grid = root.createDiv({ cls: "mia-keyword-grid" });
  const renderGrid = () => {
    grid.empty();
    const query = search.value.trim().toLocaleLowerCase("ko");
    const items = [...keywords]
      .filter(([, item]) => !query || `${item.keyword.label}\n${item.keyword.target}`.toLocaleLowerCase("ko").includes(query))
      .sort(([left, a], [right, b]) =>
        (sort.value === "weak" ? (scores.get(left) ?? ranked.length) - (scores.get(right) ?? ranked.length) : 0)
        || b.questions.size - a.questions.size || a.keyword.label.localeCompare(b.keyword.label, "ko"));
    for (const [, item] of items) {
      const links = [...item.questions.values()];
      const questions = links.map(link => link.question);
      const coreCount = links.filter(link => link.core).length;
      const subCount = links.filter(link => link.sub).length;
      const card = grid.createDiv({ cls: "mia-keyword" });
      // 카드 전체 클릭과 같은 의미 보기를 키보드(Tab → Enter/Space)로도 열 수 있게 이름을 버튼 역할로 둔다.
      const title = card.createEl("strong", {
        text: item.keyword.label,
        attr: { tabindex: "0", role: "button", "aria-label": `키워드 ${item.keyword.label} 의미 보기` },
      });
      title.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        showMeaning(item);
      });
      card.createEl("span", { text: `${questions.length}문제 · 핵심 ${coreCount} · 보조 ${subCount}` });
      card.addEventListener("click", () => showMeaning(item));
      const editEntry = item.entry ?? {
        name: item.keyword.label === item.keyword.target
          ? (item.keyword.target.replaceAll("\\", "/").split("/").at(-1) ?? item.keyword.label).replace(/\.md$/i, "")
          : item.keyword.label,
        target: item.keyword.target,
      };
      const edit = card.createEl("button", { text: "편집", attr: { "aria-label": `키워드 ${item.keyword.label} 편집` } });
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
        details.createEl("summary", { text: "연결 문제 보기" });
        for (const question of questions.slice(0, 300)) {
          const questionButton = details.createEl("button");
          renderQuestionHeading(ctx, questionButton, question);
          questionButton.addEventListener("click", () => reportUiFailure(ctx.plugin.openQuestionDetail(question)));
        }
      }
      const remove = card.createEl("button", { text: "삭제", cls: "mod-warning", attr: { "aria-label": `키워드 ${item.keyword.label} 삭제` } });
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
  sort.addEventListener("change", renderGrid);
  renderGrid();
}

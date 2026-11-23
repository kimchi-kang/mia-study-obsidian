/** Standalone file:// harness. Only host defaults and pane geometry are simulated. */
export function layoutHarness(cases) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MIA 학습 레이아웃 하네스</title>
<style>
:root {
  --background-primary: #faf8f0; --background-primary-alt: #f0eee6;
  --background-secondary: #ece9e0; --background-modifier-border: #292929;
  --background-modifier-hover: #e6e3da; --text-normal: #181818;
  --text-muted: #555; --text-faint: #666; --text-on-accent: #fff;
  --interactive-accent: #174ce5; --interactive-normal: #eee;
  --text-error: #c92327; --text-warning: #916000;
  --font-ui-smaller: 12px; --font-ui-small: 13px; --font-ui-medium: 16px;
  --font-ui-large: 20px; --font-interface: system-ui, sans-serif;
  --font-text: system-ui, sans-serif; --font-monospace: monospace;
  --radius-s: 0px; --radius-m: 0px; --radius-l: 0px;
  font: 16px/1.5 var(--font-interface); color: var(--text-normal); background: var(--background-primary);
}
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; }
.workspace, .workspace-leaf, .workspace-leaf-content, .view-content { height: 100%; min-height: 0; min-width: 0; }
.workspace { position: relative; }
.workspace-leaf { position: absolute; }
.workspace-leaf-content { display: flex; flex-direction: column; }
.view-content { flex: 1; padding: 0; }
button { font: inherit; cursor: pointer; height: auto; }
button:disabled { cursor: default; opacity: .55; }
h2 { font-size: 1.5em; } h3 { font-size: 1.17em; }
p, ol, ul { margin-block: 1em; }
.mia-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
<link rel="stylesheet" href="../../styles.css">
</head>
<body>
<div class="workspace"><div class="workspace-leaf"><div class="workspace-leaf-content"><div class="view-content"></div></div></div></div>
<script id="mia-cases" type="application/json">${JSON.stringify(cases).replaceAll("<", "\\u003c")}</script>
<script>
// Queries: route=dashboard|progress|questions|keywords|study, device, case=short|long|no-related, safeLeft/Right/Top/Bottom (px),
// paneLeft/Top/Width/Height/RightGap/BottomGap (px), focus, density, answerLayout.
const params = new URLSearchParams(location.search);
const cases = JSON.parse(document.getElementById('mia-cases').textContent);
const route = ['dashboard', 'progress', 'questions', 'keywords', 'study'].includes(params.get('route')) ? params.get('route') : 'study';
const selected = route === 'study' ? params.get('case') || 'short' : route;
document.querySelector('.view-content').innerHTML = cases[selected] || cases.short;
const view = document.querySelector('.mia-view');
view.dataset.device = ['phone', 'tablet', 'desktop'].includes(params.get('device')) ? params.get('device') : 'tablet';
view.dataset.focus = params.get('focus') || 'false';
view.dataset.density = params.get('density') || view.dataset.density;
view.dataset.answerLayout = params.get('answerLayout') || view.dataset.answerLayout;
document.body.classList.toggle('is-mobile', view.dataset.device !== 'desktop');
document.body.classList.toggle('is-phone', view.dataset.device === 'phone');
const number = (name, fallback = 0) => {
  const value = params.has(name) ? Number(params.get(name)) : fallback;
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
};
function geometry() {
  const left = number('paneLeft'), top = number('paneTop');
  const width = number('paneWidth', innerWidth - left - number('paneRightGap'));
  const height = number('paneHeight', innerHeight - top - number('paneBottomGap'));
  const pane = document.querySelector('.workspace-leaf');
  Object.assign(pane.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
  const values = { top, left, width, 'right-gap': Math.max(0, innerWidth - left - width), 'bottom-gap': Math.max(0, innerHeight - top - height) };
  for (const [key, value] of Object.entries(values)) view.style.setProperty('--mia-pane-' + key, value + 'px');
  for (const edge of ['Left', 'Right', 'Top', 'Bottom']) view.style.setProperty('--safe-area-inset-' + edge.toLowerCase(), number('safe' + edge) + 'px');
  view.dataset.viewportHeight = height < 320 ? 'minimal' : height < 440 ? 'short' : height < 600 ? 'compact' : 'regular';
}
geometry();
addEventListener('resize', geometry);
// 테스트용 setIcon은 빈 svg만 남기므로, 하네스를 눈으로 볼 때만 아이콘 자리에 비슷한 글자를 그린다(실제 Obsidian은 Lucide 아이콘).
const iconGlyphs = { 'arrow-left': '\\u2190', settings: '\\u2699', type: 'Aa', moon: '\\u263e' };
for (const svg of document.querySelectorAll('svg[data-icon]')) {
  const glyph = iconGlyphs[svg.getAttribute('data-icon')];
  if (!glyph) continue;
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  Object.entries({ x: '12', y: '17', 'text-anchor': 'middle', 'font-size': '15', 'font-weight': '700', fill: 'currentColor' }).forEach(([key, value]) => text.setAttribute(key, value));
  text.textContent = glyph;
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.append(text);
}
window.miaLayoutReport = function() {
  const pane = view.getBoundingClientRect();
  const content = view.querySelector(({ study: '.mia-study-layout', dashboard: '.mia-hero', progress: '.mia-stats', questions: '.mia-questions-layout', keywords: '.mia-keyword-grid' })[route]);
  const card = content.getBoundingClientRect();
  const layout = content;
  const grids = {};
  for (const selector of ['.mia-stats', '.mia-subject-grid', '.mia-progress-subjects', '.mia-keyword-grid', '.mia-list', '.mia-questions-layout', '.mia-study-layout', '.mia-hero-counts']) {
    const grid = view.querySelector(selector);
    if (grid) grids[selector] = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length;
  }
  const panel = view.querySelector('.mia-detail-panel');
  const panelVisible = !!panel && getComputedStyle(panel).display !== 'none';
  const css = getComputedStyle(view);
  // Resolving calc/max/var via a probe preserves the production safe-area calculation.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;height:0;visibility:hidden;width:calc(var(--mia-edge-left) + var(--mia-edge-right))';
  view.append(probe);
  const safeWidth = probe.getBoundingClientRect().width;
  probe.remove();
  return {
    route, grids, panelVisible, panelWidth: panelVisible ? panel.getBoundingClientRect().width : 0,
    contentWidth: card.width, contentPaneRatio: card.width / pane.width, contentSafePaneRatio: card.width / (pane.width - safeWidth),
    device: view.dataset.device, case: selected, paneWidth: pane.width, cardWidth: card.width,
    cardPaneRatio: card.width / pane.width,
    cardSafePaneRatio: card.width / (pane.width - safeWidth),
    leftMargin: card.left - pane.left, rightMargin: pane.right - card.right,
    layoutScrollHeight: layout.scrollHeight, layoutClientHeight: layout.clientHeight,
    layoutNeedsScroll: layout.scrollHeight > layout.clientHeight + 1,
    rootNeedsScroll: view.scrollHeight > view.clientHeight + 1,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth, innerWidth,
    paneHorizontalOverflow: view.scrollWidth > view.clientWidth,
    overflowingElements: [...view.querySelectorAll('*')].filter(el => el.getClientRects().length && getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1).map(el => el.className).filter(Boolean),
    layoutColumns: getComputedStyle(layout).gridTemplateColumns,
    studyWidth: css.getPropertyValue('--mia-study-width').trim()
  };
};
if (params.get('report') === '1') setTimeout(() => { document.body.dataset.layoutReport = JSON.stringify(window.miaLayoutReport()); }, 200);
</script>
</body>
</html>
`;
}

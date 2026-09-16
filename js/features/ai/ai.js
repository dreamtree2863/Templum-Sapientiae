/* ai.js — 문서 AI. 물어보면 **내 자료에서** 찾아 답한다.
 *
 *  ‼ 키가 없어도 쓸모 있어야 한다. 순서가 그래서 이렇다:
 *      질문 → 관련 문서 목록(즉시·오프라인) → [근거 보기] → [AI 답변](키 있을 때)
 *    목록만으로도 "어느 문서를 펴야 하나"가 풀린다. 그게 대부분의 필요다.
 *
 *  ‼ 지어내지 않는 것이 이 화면의 전부다. 답 밑에 쓴 문서를 반드시 붙이고,
 *    눌러서 원문으로 갈 수 있게 한다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { search, markOpened, catalog } from '../../data/index.js';

const esc = shell.escapeHtml;
let last = { q: '', hits: [], context: '', sources: [], answer: '' };

export function renderAi() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="search-row">
      <input type="search" id="q" placeholder="자료에 물어보기"
             autocomplete="off" enterkeyhint="search" value="${esc(last.q)}">
    </div>
    <div id="out"></div>`;

  const $q = el.querySelector('#q');
  $q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(el, $q.value); });
  $q.addEventListener('search', () => go(el, $q.value));
  el.addEventListener('click', (e) => onClick(e, el));

  shell.render({ title: '문서 AI', back: true, node: el });
  if (last.q) paint(el);
  else el.querySelector('#out').innerHTML = intro();
  setTimeout(() => $q.focus(), 60);
}

function intro() {
  return `<p class="set-note">받아 둔 자료에서 찾아 줍니다.
    ${search.hasKey() ? 'AI 답변도 쓸 수 있습니다.'
      : 'AI 답변을 쓰려면 설정에서 키를 넣으세요 — 키 없이도 찾기는 됩니다.'}</p>`;
}

function go(el, q) {
  q = (q || '').trim();
  if (!q) return;
  last = { q, hits: search.rank(q, { limit: 12 }), context: '', sources: [], answer: '' };
  paint(el);
}

function paint(el) {
  const out = el.querySelector('#out');
  if (!last.hits.length) {
    out.innerHTML = `<div class="empty">관련된 자료를 찾지 못했습니다.<br>
      다른 낱말로 물어보세요.</div>`;
    return;
  }
  out.innerHTML = `
    ${last.answer ? `<div class="ai-answer">${fmt(last.answer)}</div>
      <h3 class="set-sub">근거로 쓴 문서</h3>
      <div class="doc-list">${last.sources.map(s => `
        <button class="doc-row pressable" data-doc="${esc(s.id)}">
          <span class="doc-name">${esc(s.title)}</span>
          <span class="doc-meta"><span class="where">${esc(s.path)}</span></span>
        </button>`).join('')}</div>` : ''}

    ${!last.answer ? `
      <div class="list-count">관련 자료 ${last.hits.length}편</div>
      <div class="doc-list">${last.hits.map(h => `
        <button class="doc-row pressable" data-doc="${esc(h.id)}">
          <span class="doc-name">${esc(h.baseTitle || h.name)}</span>
          <span class="doc-meta">
            <span class="kind k-${esc(h.kind)}">${esc(h.label)}</span>
            <span class="where">${esc(h.path)}</span>
          </span>
        </button>`).join('')}</div>
      <div class="set-actions">
        <button class="more-btn pressable" data-act="gather">근거 모으기 (문서 3편)</button>
        ${search.hasKey() ? `<button class="more-btn pressable" data-act="ask">AI 에게 묻기</button>` : ''}
      </div>
      ${last.context ? `<h3 class="set-sub">모은 근거</h3>
        <pre class="ai-context">${esc(last.context)}</pre>` : ''}` : ''}`;
}

/** 아주 가벼운 서식 — 줄바꿈과 굵게만. 답에 HTML 을 넣지 않는다(지어낸 마크업 방지). */
function fmt(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>');
}

async function onClick(e, el) {
  const doc = e.target.closest('[data-doc]');
  if (doc) {
    const f = catalog.byId(doc.dataset.doc);
    if (f) markOpened(f);
    router.go('#/doc/' + encodeURIComponent(doc.dataset.doc));
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;

  if (b.dataset.act === 'gather') {
    b.disabled = true;
    try {
      const r = await search.gather(last.q, {
        docs: 3,
        onProgress: (i, n, name) => { b.textContent = `${i}/${n} · ${name.slice(0, 18)}…`; },
      });
      last.context = r.context; last.sources = r.sources;
      if (!r.context) shell.toast('근거를 찾지 못했습니다');
    } catch (err) { shell.toast(err.message, 'error'); }
    b.disabled = false; b.textContent = '근거 모으기 (문서 3편)';
    paint(el);
    return;
  }

  if (b.dataset.act === 'ask') {
    b.disabled = true; b.textContent = '찾는 중…';
    try {
      if (!last.context) {
        const r = await search.gather(last.q, {
          docs: 3,
          onProgress: (i, n) => { b.textContent = `근거 ${i}/${n}…`; },
        });
        last.context = r.context; last.sources = r.sources;
      }
      if (!last.context) { shell.toast('근거를 찾지 못해 묻지 않았습니다'); }
      else {
        b.textContent = '생각하는 중…';
        last.answer = await search.ask(last.q, last.context);
      }
    } catch (err) {
      if (err.needKey) shell.toast('설정에서 AI 키를 먼저 넣어 주세요');
      else shell.toast(err.message, 'error');
    }
    b.disabled = false; b.textContent = 'AI 에게 묻기';
    paint(el);
  }
}

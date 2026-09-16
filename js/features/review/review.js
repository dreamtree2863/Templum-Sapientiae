/* review.js — 오늘의 복습. 엘리베이터에서 세 장 넘기는 화면.
 *
 *  ‼ 손가락만으로 끝나야 한다. 타이핑 0, 스크롤 최소, 단추는 엄지 높이에.
 *    앞면을 보고 → 떠올리고 → 뒤집어 확인하고 → 셋 중 하나를 누른다.
 *
 *  ‼ 오프라인에서도 진도가 나간다. 채점은 그 자리에서 반영하고 큐로 쌓아 둔다.
 */
import * as shell from '../shell.js';
import * as router from '../../core/router.js';
import { review } from '../../data/index.js';

const esc = shell.escapeHtml;
const LABEL = { again: '잊음', hard: '아슬', good: '됨' };

let session = null;      // {items, totalDue, carried}
let at = 0;              // 지금 몇 번째
let flipped = false;

export async function renderToday() {
  await review.load();
  const s = review.buildSession({ maxItems: 20 });
  session = s; at = 0; flipped = false;

  if (!s.items.length) {
    shell.render({ title: '오늘의 복습', back: true, node: emptyView(s) });
    return;
  }
  paint();
}

function emptyView(s) {
  const el = document.createElement('div');
  const total = review.all().length;
  el.innerHTML = total
    ? `<div class="empty">오늘 볼 카드가 없습니다.<br>다음 카드가 뜨면 여기에 나옵니다.</div>
       <div class="rows"><div class="set-row"><span class="k">가진 카드</span>
         <span class="v">${total}장</span></div></div>`
    : `<div class="empty">아직 복습 카드를 받지 못했습니다.<br>
       PC 에서 한 번 켜 두면 폰으로 넘어옵니다.</div>`;
  const b = document.createElement('button');
  b.className = 'more-btn pressable';
  b.textContent = '카드 다시 받기';
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '받는 중…';
    try {
      const n = await review.pull();
      shell.toast(n == null ? 'PC 가 아직 안 내보냈습니다' : `${n}장 받았습니다`, 'ok');
      renderToday();
    } catch (e) { shell.toast(e.message, 'error'); b.disabled = false; b.textContent = '카드 다시 받기'; }
  });
  el.appendChild(b);
  return el;
}

function paint() {
  const c = session.items[at];
  if (!c) { renderDone(); return; }

  const el = document.createElement('div');
  el.className = 'rv';
  el.innerHTML = `
    <div class="rv-top">
      <span class="rv-count">${at + 1} / ${session.items.length}</span>
      ${c.subject ? `<span class="rv-sub">${esc(c.subject)}</span>` : ''}
      <span class="rv-lvl" title="안정도">${'●'.repeat(Number(c.level || 0) + 1)}</span>
    </div>
    <div class="rv-card ${flipped ? 'flipped' : ''}" id="card">
      <div class="rv-face">${esc(c.front || '')}</div>
      ${flipped ? `<div class="rv-back">${esc(c.back || '')}</div>` : ''}
      ${flipped && (c.weak_points || []).length
        ? `<div class="rv-weak">지난번에 빠뜨린 것 · ${(c.weak_points || []).map(esc).join(' · ')}</div>` : ''}
      ${flipped && c.source ? `<div class="rv-src">${esc(c.source)}</div>` : ''}
    </div>
    ${flipped ? `
      <div class="rv-grade">
        ${['again', 'hard', 'good'].map(g =>
          `<button class="rv-b g-${g} pressable" data-grade="${g}">${LABEL[g]}</button>`).join('')}
      </div>`
      : `<button class="rv-flip pressable" data-flip="1">뒤집기</button>`}`;

  el.addEventListener('click', onClick);
  shell.render({ title: '오늘의 복습', back: true, node: el });
}

async function onClick(e) {
  if (e.target.closest('[data-flip]')) { flipped = true; paint(); return; }
  const g = e.target.closest('[data-grade]');
  if (!g) return;
  const c = session.items[at];
  const r = await review.grade(c.id, g.dataset.grade);
  shell.toast(r ? `${r.days}일 뒤에 다시` : '기록했습니다', 'ok');
  at += 1; flipped = false;
  paint();
}

function renderDone() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="rv-done">
      <div class="rv-done-n">${session.items.length}장</div>
      <p>오늘 몫을 끝냈습니다.</p>
      ${session.carried ? `<p class="set-note">${session.carried}장은 내일로 넘겼습니다.</p>` : ''}
      <p class="set-note">채점은 PC 로 자동으로 넘어갑니다. 지금 연결이 없어도 쌓아 두었다가 보냅니다.</p>
    </div>`;
  const b = document.createElement('button');
  b.className = 'more-btn pressable';
  b.textContent = '복습 허브로';
  b.addEventListener('click', () => router.go('#/review'));
  el.appendChild(b);
  shell.render({ title: '오늘의 복습', back: true, node: el });
}

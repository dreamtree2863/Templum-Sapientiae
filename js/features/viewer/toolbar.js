/* toolbar.js — 문서 화면 하단 툴바.
 *
 *  ‼ 상단이 아니라 하단이다. 큰 폰에서 상단바에는 엄지가 닿지 않는다.
 *    문서를 보는 내내 쓰는 것(글자 크기·테마·작도칸 안내)만 둔다.
 */
import { get } from '../../core/store.js';
import * as shell from '../shell.js';

const SCALES = [0.9, 1, 1.15, 1.3];

export function mountToolbar(wrap, { file, plan, onTheme, onScale }) {
  const ui = get('ui');
  const bar = document.createElement('div');
  bar.className = 'doc-bar';
  bar.innerHTML = `
    <button class="doc-btn" data-act="scale-down" aria-label="글자 작게">가<small>−</small></button>
    <button class="doc-btn" data-act="scale-up" aria-label="글자 크게">가<small>+</small></button>
    <button class="doc-btn" data-act="theme" aria-label="밝기">${themeIcon(ui.theme)}</button>
    <span class="doc-bar-gap"></span>
    ${plan.graph ? `<span class="doc-note" title="작도칸이 있는 학습지입니다">✏️ 작도칸</span>` : ''}
    ${plan.worksheet ? `<span class="doc-note">답은 이 기기에 저장됩니다</span>` : ''}`;
  wrap.appendChild(bar);

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const cur = get('ui');
    if (b.dataset.act === 'scale-up' || b.dataset.act === 'scale-down') {
      const i = SCALES.indexOf(cur.textScale);
      const at = i < 0 ? 1 : i;
      const next = SCALES[Math.min(SCALES.length - 1, Math.max(0,
        at + (b.dataset.act === 'scale-up' ? 1 : -1)))];
      onScale(next);
      shell.toast('글자 ' + Math.round(next * 100) + '%');
      return;
    }
    if (b.dataset.act === 'theme') {
      const order = ['system', 'light', 'dark'];
      const next = order[(order.indexOf(cur.theme) + 1) % order.length];
      onTheme(next);
      b.textContent = themeIcon(next);
      shell.toast({ system: '시스템 설정', light: '밝게', dark: '어둡게' }[next]);
    }
  });

  return bar;
}

function themeIcon(t) {
  return t === 'dark' ? '🌙' : t === 'light' ? '☀️' : '🌗';
}

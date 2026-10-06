/* sketch_pad.js — 답안용 자유 그림판 (도식·화살표·상자·손그림)
 *
 * graph_editor.js 가 '경제학 곡선' 전용이라면, 이 그림판은 국제정치·국제법 답안의
 * 개념 도식(행위자 상자 + 화살표, 비교 도해, 간단한 손그래프)을 빠르게 그리는 용도.
 * 결과는 PNG data URI 로 답안에 인라인 삽입된다(채점기 _extract_inline_figures 호환).
 * 넣은 그림은 data-sketch="1" 이 붙어, 더블클릭하면 그 그림을 바탕으로 다시 고칠 수 있다.
 *
 * 사용:  SketchPad.open({ src: dataUriOrNull, done: (dataUri) => {...} })
 */
(function () {
    "use strict";

    const W = 720, H = 440;
    const TOOLS = [
        ["pen", "✏ 펜"], ["line", "╱ 직선"], ["arrow", "→ 화살표"], ["darrow", "↔ 양방향"],
        ["rect", "▭ 상자"], ["ellipse", "◯ 타원"], ["text", "T 글자"], ["eraser", "⌫ 지우개"],
    ];
    const COLORS = [["#111", "검정"], ["#c0392b", "빨강"], ["#1b6fb9", "파랑"], ["#888", "회색"]];
    const WIDTHS = [[2, "가늘게"], [3.5, "보통"], [6, "굵게"]];

    let styled = false;
    function injectStyle() {
        if (styled) return;
        styled = true;
        const css = `
.sp-overlay{position:fixed;inset:0;background:rgba(20,24,32,.55);z-index:10050;display:flex;align-items:center;justify-content:center}
.sp-dlg{background:#fdfbf7;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.35);padding:12px 14px;max-width:96vw;font-family:'Malgun Gothic',sans-serif}
.sp-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;color:#5d4037;font-weight:bold}
.sp-bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:8px}
.sp-bar button{border:1px solid #cfc6b4;background:#fff;color:#333;border-radius:5px;padding:4px 8px;font-size:12.5px;cursor:pointer;font-family:inherit}
.sp-bar button.on{background:#1b6fb9;color:#fff;border-color:#1b6fb9}
.sp-sep{width:1px;height:20px;background:#d8d0c0;margin:0 4px}
.sp-dot{width:18px;height:18px;border-radius:50%;display:inline-block;vertical-align:middle}
.sp-canvas-wrap{position:relative;border:1px solid #cfc6b4;background:#fff;line-height:0}
.sp-canvas-wrap canvas{display:block;cursor:crosshair;max-width:92vw;touch-action:none}
.sp-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px}
.sp-foot .sp-hint{font-size:11.5px;color:#8a8070}
.sp-foot button{border:0;border-radius:6px;padding:7px 16px;font-size:13px;cursor:pointer;font-family:inherit}
.sp-ok{background:#1b6fb9;color:#fff}.sp-cancel{background:#888;color:#fff}
`;
        const st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
    }

    function open(opts) {
        opts = opts || {};
        injectStyle();
        const ov = document.createElement('div');
        ov.className = 'sp-overlay';
        ov.innerHTML = `
<div class="sp-dlg" role="dialog" aria-label="그림 그리기">
  <div class="sp-head"><span>✏ 그림 그리기 — 도식·화살표·상자</span><span style="font-weight:normal;font-size:12px;color:#8a8070">Esc 취소 · Ctrl+Z 되돌리기</span></div>
  <div class="sp-bar">
    ${TOOLS.map(([k, l]) => `<button data-tool="${k}">${l}</button>`).join("")}
    <span class="sp-sep"></span>
    ${COLORS.map(([c, l]) => `<button data-color="${c}" title="${l}"><span class="sp-dot" style="background:${c}"></span></button>`).join("")}
    <span class="sp-sep"></span>
    ${WIDTHS.map(([w, l]) => `<button data-width="${w}">${l}</button>`).join("")}
    <span class="sp-sep"></span>
    <button data-act="dash" title="점선으로 그리기 (직선·화살표·상자·타원)">┄ 점선</button>
    <button data-act="undo">↶ 되돌리기</button>
    <button data-act="clear">🗑 모두 지우기</button>
  </div>
  <div class="sp-canvas-wrap"><canvas width="${W}" height="${H}"></canvas></div>
  <div class="sp-foot">
    <span class="sp-hint">상자·화살표로 행위자 관계를, 직선으로 축을 그리세요. 글자 도구는 클릭한 곳에 입력합니다. Shift 를 누르면 직선이 수평·수직·45°로 맞춰집니다.</span>
    <span><button class="sp-cancel">취소</button> <button class="sp-ok">답안에 넣기</button></span>
  </div>
</div>`;
        document.body.appendChild(ov);

        const cv = ov.querySelector('canvas');
        const ctx = cv.getContext('2d');
        const state = { tool: 'pen', color: '#111', width: 3.5, dash: false };
        const history = [];
        let drag = null;

        function fillWhite() { ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
        function snapshot() {
            history.push(ctx.getImageData(0, 0, W, H));
            if (history.length > 40) history.shift();
        }
        fillWhite();
        if (opts.src) {
            const im = new Image();
            im.onload = () => {
                // 원래 그림을 비율 유지해 가운데 배치
                const s = Math.min(W / im.width, H / im.height, 1);
                const w = im.width * s, h = im.height * s;
                ctx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h);
            };
            im.src = opts.src;
        }

        function syncBar() {
            ov.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === state.tool));
            ov.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color === state.color));
            ov.querySelectorAll('[data-width]').forEach(b => b.classList.toggle('on', Number(b.dataset.width) === state.width));
            ov.querySelector('[data-act="dash"]').classList.toggle('on', state.dash);
            cv.style.cursor = state.tool === 'text' ? 'text' : 'crosshair';
        }
        syncBar();

        function pos(e) {
            const r = cv.getBoundingClientRect();
            return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
        }
        function applyStroke() {
            ctx.strokeStyle = state.color;
            ctx.fillStyle = state.color;
            ctx.lineWidth = state.width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.setLineDash(state.dash ? [state.width * 3, state.width * 2.5] : []);
        }
        function arrowHead(x0, y0, x1, y1) {
            const a = Math.atan2(y1 - y0, x1 - x0), L = 8 + state.width * 2.2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x1 - L * Math.cos(a - 0.42), y1 - L * Math.sin(a - 0.42));
            ctx.lineTo(x1 - L * Math.cos(a + 0.42), y1 - L * Math.sin(a + 0.42));
            ctx.closePath();
            ctx.fill();
        }
        function snap(p0, p, shift) {
            if (!shift) return p;
            const dx = p[0] - p0[0], dy = p[1] - p0[1];
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const d = Math.hypot(dx, dy);
            return [p0[0] + d * Math.cos(a), p0[1] + d * Math.sin(a)];
        }
        function drawShape(tool, p0, p1) {
            applyStroke();
            const [x0, y0] = p0, [x1, y1] = p1;
            ctx.beginPath();
            if (tool === 'line' || tool === 'arrow' || tool === 'darrow') {
                ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
                if (tool !== 'line') arrowHead(x0, y0, x1, y1);
                if (tool === 'darrow') arrowHead(x1, y1, x0, y0);
            } else if (tool === 'rect') {
                ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
            } else if (tool === 'ellipse') {
                ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // 마우스·손가락·펜 모두 — pointer 이벤트 (폰에서 그리며 화면이 끌려가지 않게 touch-action:none)
        cv.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            try { cv.setPointerCapture(e.pointerId); } catch (_) {}
            const p = pos(e);
            if (state.tool === 'text') {
                const t = prompt("넣을 글자 (예: 미국, 중국, 안보딜레마, A국 ⇄ B국):", "");
                if (!t) return;
                snapshot();
                ctx.save();
                ctx.fillStyle = state.color;
                ctx.font = `${Math.round(13 + state.width * 1.6)}px 'Malgun Gothic', sans-serif`;
                ctx.textBaseline = 'middle';
                t.split('\n').forEach((ln, i) => ctx.fillText(ln, p[0], p[1] + i * (16 + state.width * 2)));
                ctx.restore();
                return;
            }
            snapshot();
            drag = { p0: p, last: p, base: ctx.getImageData(0, 0, W, H) };
            if (state.tool === 'pen' || state.tool === 'eraser') {
                applyStroke();
                ctx.setLineDash([]);
                if (state.tool === 'eraser') { ctx.strokeStyle = '#fff'; ctx.lineWidth = state.width * 5; }
                ctx.beginPath();
                ctx.moveTo(p[0], p[1]);
                ctx.lineTo(p[0] + 0.01, p[1] + 0.01);
                ctx.stroke();
            }
        });
        const onMove = (e) => {
            if (!drag) return;
            const p = pos(e);
            if (state.tool === 'pen' || state.tool === 'eraser') {
                ctx.beginPath();
                ctx.moveTo(drag.last[0], drag.last[1]);
                ctx.lineTo(p[0], p[1]);
                ctx.stroke();
                drag.last = p;
            } else {
                ctx.putImageData(drag.base, 0, 0);
                drawShape(state.tool, drag.p0, snap(drag.p0, p, e.shiftKey));
            }
        };
        const onUp = () => { drag = null; };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);

        function close() {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            document.removeEventListener('keydown', onKey, true);
            ov.remove();
        }
        function undo() {
            const s = history.pop();
            if (s) ctx.putImageData(s, 0, 0);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.stopPropagation(); undo(); }
        }
        document.addEventListener('keydown', onKey, true);

        ov.querySelector('.sp-bar').addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            if (b.dataset.tool) state.tool = b.dataset.tool;
            else if (b.dataset.color) state.color = b.dataset.color;
            else if (b.dataset.width) state.width = Number(b.dataset.width);
            else if (b.dataset.act === 'dash') state.dash = !state.dash;
            else if (b.dataset.act === 'undo') undo();
            else if (b.dataset.act === 'clear') { snapshot(); fillWhite(); }
            syncBar();
        });
        ov.querySelector('.sp-cancel').addEventListener('click', close);
        ov.querySelector('.sp-ok').addEventListener('click', () => {
            const uri = trimmedDataUri();
            close();
            if (uri && typeof opts.done === 'function') opts.done(uri);
        });

        // 흰 여백을 잘라 내고(여유 12px) PNG 로 — 답안에 작은 도식이 큰 빈 상자로 들어가지 않게
        function trimmedDataUri() {
            const d = ctx.getImageData(0, 0, W, H).data;
            let x0 = W, y0 = H, x1 = -1, y1 = -1;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) {
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
            }
            if (x1 < 0) return null;   // 빈 그림
            const m = 12;
            x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
            x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
            const out = document.createElement('canvas');
            out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
            out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
            return out.toDataURL('image/png');
        }
    }

    window.SketchPad = { open };
})();

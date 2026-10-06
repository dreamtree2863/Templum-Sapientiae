/* rich_answer.js — 답안 작성용 리치 편집기 (contenteditable) 공용 헬퍼.
 *
 * 목적: 기존 <textarea> 답안란을 대체해 *답안 본문에 그림을 인라인으로 삽입*하고
 *       *드래그로 크기 조절*할 수 있게 한다. 그림은 base64 <img> 로 들어가므로
 *       채점(grading)·시험기록과 그대로 호환된다(채점기 _extract_inline_figures 가 인식).
 *
 * 작성 보조 (2026-10):
 *   · 개요 번호 — 제N문 / Ⅰ. / 1. / (1) / 1) / ① 6단계. 툴바 버튼으로 현재 줄에 적용,
 *     Tab·Shift+Tab 으로 한 단계 내리기·올리기, Ctrl+Enter 로 같은 단계 다음 번호 줄.
 *     outlineMode:'continue'(목차 퀴즈·개요 메모)에서는 Enter 만으로 다음 번호가 이어지고,
 *     번호만 있는 빈 줄에서 Enter 하면 한 단계 올라간다(아웃라이너 방식).
 *     🔢 번호 정리 = 문서 전체 번호를 계층대로 다시 매김.
 *   · 자동 기호 — -> → · => ⇒ · <=> ⇔ · >= ≥ · <= ≤ · != ≠ · ^2 ² · ;a α (math_input.js 와 같은 ; 그리스 규칙)
 *   · Σ 기호 판 · B/U 강조 · ▦ 표 · 🖍 도식(sketch_pad.js) · 📈 그래프 그리기(graph_editor.js 그래프 편집기) · 🧭 목차 이동
 *
 * 사용:  const ed = RichAnswer.upgrade(divEl, { onChange, placeholder, outlineMode, tools });
 *        ed.getHTML() / ed.setContent(s) / ed.getText() / ed.isEmpty() / ed.clear()
 *        ed.focus() / ed.setDisabled(b) / ed.caretTextOffset() / ed.insertContent(s)
 *        ed.selectedOrAllHTML() / ed.insertImageFromFile() / ed.el
 *        ed.getOutlineText()  — 그림을 [그래프: 곡선명…]/[그림] 로 바꾼 평문 (AI 채점용)
 *        ed.getHeadings()     — [{level, text}] 개요 번호 줄
 *        ed.renumber()
 *   tools: 켤 도구 목록(기본 전부) — 'image','graph','sketch','outline','format','table','symbols','nav'
 *   touch: true 면 Tab·Ctrl+Enter 대신 ⇤ ⇥ ↵번호 단추를 둔다(폰 — 자판에 Tab 이 없고 한글 조합 중 Enter 를 못 가로챈다)
 *
 * textarea 대체이므로 호출부는 .value 대신 위 메서드를 쓴다.
 */
(function () {
    "use strict";

    const looksHTML = (s) => /<[a-z!/][\s\S]*>/i.test(s || "");
    const escHtml = (s) => (window.escHtml ? window.escHtml(s)
        : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    const textToHtml = (s) => escHtml(s).replace(/\n/g, "<br>");

    // ── 개요 번호 체계 ─────────────────────────────────────────────
    const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ'];
    const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
    const LEVELS = [
        { label: '제N문', title: '문항 머리 (제1문, 제2문…)', re: /^제\s*(\d+)\s*문\.?[  ]?/, num: m => +m[1], make: n => `제${n}문. ` },
        { label: 'Ⅰ.', title: '대목차 (Ⅰ. Ⅱ. Ⅲ.)', re: /^([Ⅰ-Ⅻ])\.?[  ]?/, num: m => ROMAN.indexOf(m[1]) + 1, make: n => `${ROMAN[n - 1] || n}. ` },
        { label: '1.', title: '중목차 (1. 2. 3.)', re: /^(\d{1,2})\.(?!\d)[  ]?/, num: m => +m[1], make: n => `${n}. ` },
        { label: '(1)', title: '소목차 ((1) (2))', re: /^\((\d{1,2})\)[  ]?/, num: m => +m[1], make: n => `(${n}) ` },
        { label: '1)', title: '세목 (1) 2))', re: /^(\d{1,2})\)[  ]?/, num: m => +m[1], make: n => `${n}) ` },
        { label: '①', title: '세세목 (① ②)', re: /^([①-⑳])[  ]?/, num: m => CIRC.indexOf(m[1]) + 1, make: n => `${CIRC[n - 1] || '(' + n + ')'} ` },
    ];
    const indentOf = (lv) => ' '.repeat(Math.max(0, lv - 1) * 2);

    /** 줄 앞부분 → {level, n, prefixLen(들여쓰기+번호+공백), rest} · 번호 없으면 level -1 */
    function parseLine(text) {
        const ws = /^[  　\t]*/.exec(text)[0];
        const body = text.slice(ws.length);
        for (let lv = 0; lv < LEVELS.length; lv++) {
            const m = LEVELS[lv].re.exec(body);
            if (m) return { level: lv, n: LEVELS[lv].num(m), prefixLen: ws.length + m[0].length, rest: body.slice(m[0].length), ws };
        }
        return { level: -1, n: 0, prefixLen: ws.length, rest: body, ws };
    }

    // ── 논리 줄 스캔 — <div>/<p> 블록 · <br> · 텍스트 속 \n 을 모두 줄바꿈으로 본다 ──
    const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TBODY|THEAD|TR|TD|TH|SECTION|FIGURE)$/;
    function scanLines(root) {
        const lines = [];
        let atStart = true;
        const push = (node, off, text) => lines.push({ node, off, text });
        (function walk(n) {
            for (let c = n.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === 3) {
                    const s = c.data;
                    if (!s) continue;
                    const lineText = (from) => { const j = s.indexOf('\n', from); return s.slice(from, j < 0 ? s.length : j); };
                    if (atStart) push(c, 0, lineText(0));
                    let i = s.indexOf('\n');
                    while (i !== -1) { push(c, i + 1, lineText(i + 1)); i = s.indexOf('\n', i + 1); }
                    atStart = s.endsWith('\n');
                } else if (c.nodeType === 1) {
                    const tag = c.tagName;
                    const idx = Array.prototype.indexOf.call(n.childNodes, c);
                    if (tag === 'BR') {
                        if (atStart) push(n, idx, '');
                        atStart = true;
                    } else if (tag === 'IMG') {
                        if (atStart) push(n, idx, '');
                        atStart = false;
                    } else if (BLOCK.test(tag)) {
                        atStart = true;
                        if (!c.firstChild) push(c, 0, '');
                        walk(c);
                        atStart = true;
                    } else {
                        walk(c);
                    }
                }
            }
        })(root);
        if (atStart) push(root, root.childNodes.length, '');
        return lines;
    }
    /** (n1,o1) <= (n2,o2) ? */
    function le(n1, o1, n2, o2) {
        try {
            const r = document.createRange();
            r.setStart(n1, o1); r.collapse(true);
            return r.comparePoint(n2, o2) >= 0;
        } catch (e) { return false; }
    }

    // ── 자동 기호 ──────────────────────────────────────────────────
    const GREEK = {
        a: 'α', b: 'β', g: 'γ', d: 'δ', e: 'ε', z: 'ζ', h: 'η', t: 'θ', k: 'κ', l: 'λ', m: 'μ', n: 'ν',
        x: 'ξ', p: 'π', r: 'ρ', s: 'σ', u: 'τ', f: 'φ', c: 'χ', y: 'ψ', w: 'ω',
        D: 'Δ', G: 'Γ', L: 'Λ', P: 'Π', S: 'Σ', F: 'Φ', W: 'Ω', T: 'Θ',
    };
    // [앞에 놓인 글자열, 바꿀 기호] — 긴 것부터
    const AUTO = [
        ['≤>', '⇔'], ['←>', '↔'], ['->', '→'], ['<-', '←'], ['=>', '⇒'], ['>=', '≥'], ['<=', '≤'],
        ['!=', '≠'], ['~=', '≈'], ['+-', '±'], ['^2', '²'], ['^3', '³'], ['^-1', '⁻¹'],
    ];
    Object.keys(GREEK).forEach(k => AUTO.push([';' + k, GREEK[k]]));

    const SYMBOLS = [
        '→', '←', '↔', '⇒', '⇔', '↑', '↓', '⇄', '≥', '≤', '≠', '≈', '≡', '±', '×', '÷',
        '∴', '∵', '∞', '∂', '√', '∑', 'Δ', 'α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π',
        'ρ', 'σ', 'τ', 'φ', 'ω', '²', '³', '⁻¹', 'ₜ', '₀', '₁', '₂', '*', '※', '·', '○',
        '△', '□', '■', '◆', '▶', '「', '」', '『', '』', '〈', '〉', '§', '∈', '∩', '∪',
    ];

    // ── 그림 크기 조절: 선택된 <img> 에 코너 핸들을 띄워 드래그로 width 조절 ──
    function attachResizer(host, editor, onChange) {
        let sel = null;          // 선택된 img
        const handle = document.createElement('div');
        handle.className = 'ra-resize-handle';
        handle.style.touchAction = 'none';
        handle.style.display = 'none';
        const label = document.createElement('div');
        label.className = 'ra-size-label';
        label.style.display = 'none';
        host.appendChild(handle);
        host.appendChild(label);

        function place() {
            if (!sel) { handle.style.display = 'none'; label.style.display = 'none'; return; }
            const ir = sel.getBoundingClientRect();
            const hr = host.getBoundingClientRect();
            handle.style.display = 'block';
            handle.style.left = (ir.right - hr.left - 7) + 'px';
            handle.style.top = (ir.bottom - hr.top - 7) + 'px';
            label.style.display = 'block';
            label.style.left = (ir.left - hr.left + 4) + 'px';
            label.style.top = (ir.top - hr.top + 4) + 'px';
            label.textContent = Math.round(sel.getBoundingClientRect().width) + 'px';
        }
        function select(img) {
            if (sel) sel.classList.remove('ra-img-selected');
            sel = img;
            if (sel) sel.classList.add('ra-img-selected');
            place();
        }
        function deselect() { select(null); }

        editor.addEventListener('click', (e) => {
            if (e.target && e.target.tagName === 'IMG') { e.preventDefault(); select(e.target); }
            else deselect();
        });
        editor.addEventListener('scroll', place);
        window.addEventListener('resize', place);
        editor.addEventListener('input', () => { if (sel && !editor.contains(sel)) deselect(); else place(); });
        // 선택 그림 삭제 (Delete/Backspace) — 캡처해서 글자 삭제와 구분
        editor.addEventListener('keydown', (e) => {
            if (sel && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault();
                const img = sel; deselect();
                img.remove();
                onChange && onChange();
            }
        });

        let drag = null;
        handle.addEventListener('pointerdown', (e) => {      // 마우스·손가락 모두
            if (!sel) return;
            e.preventDefault(); e.stopPropagation();
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            drag = { x: e.clientX, w: sel.getBoundingClientRect().width };
            document.body.style.userSelect = 'none';
        });
        window.addEventListener('pointermove', (e) => {
            if (!drag || !sel) return;
            const w = Math.max(40, Math.round(drag.w + (e.clientX - drag.x)));
            sel.style.width = w + 'px';
            sel.style.height = 'auto';
            sel.removeAttribute('width'); sel.removeAttribute('height');
            place();
        });
        const endDrag = () => {
            if (drag) { drag = null; document.body.style.userSelect = ''; onChange && onChange(); }
        };
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);

        return { deselect, place };
    }

    function insertImageData(editor, adapter, dataUri, onChange, extraAttr) {
        editor.focus();
        // 기본 폭: 편집기 폭의 45%(상한 360px) — 이후 드래그로 조절
        const w = Math.min(360, Math.round((editor.clientWidth || 600) * 0.45));
        const html = `<img class="ans-img" src="${dataUri}" style="width:${w}px;height:auto;" alt="답안 그림"${extraAttr || ''}>`;
        adapter.insertContent(html);
        onChange && onChange();
    }

    /** 그래프 모델(JSON) → "[그래프: 축 P–Q · 곡선 AD, AS · 점 E]" — 채점 AI 가 그림 내용을 알 수 있게 */
    function graphSummary(json) {
        try {
            const m = JSON.parse(json);
            const parts = [];
            const ax = m.axes || {};
            if (ax.x || ax.y) parts.push(`축 ${ax.y || '?'}–${ax.x || '?'}`);
            const by = { curve: [], point: [], area: [] };
            (m.items || []).forEach(it => { if (it.label && by[it.type]) by[it.type].push(it.label); });
            if (by.curve.length) parts.push('곡선 ' + by.curve.join(', '));
            if (by.point.length) parts.push('점 ' + by.point.join(', '));
            if (by.area.length) parts.push('영역 ' + by.area.join(', '));
            return `[그래프${parts.length ? ': ' + parts.join(' · ') : ''}]`;
        } catch (e) { return '[그래프]'; }
    }

    /** 노드 → 평문 (블록·br 은 줄바꿈, 그림은 표지, 표는 칸을 | 로) */
    function toPlain(root) {
        let out = '';
        const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
        (function walk(n) {
            for (let c = n.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === 3) { out += c.data; continue; }
                if (c.nodeType !== 1) continue;
                const tag = c.tagName;
                if (tag === 'BR') { out += '\n'; continue; }
                if (tag === 'IMG') {
                    const gm = c.getAttribute('data-ge-model');
                    out += gm ? graphSummary(gm) : (c.getAttribute('data-sketch') ? '[도식 그림]' : '[그림]');
                    continue;
                }
                if (tag === 'TR') {
                    nl();
                    out += Array.from(c.children).map(td => toPlain(td).replace(/\n+/g, ' ').trim()).join(' | ');
                    out += '\n';
                    continue;
                }
                const block = BLOCK.test(tag);
                if (block) nl();
                walk(c);
                if (block) nl();
            }
        })(root);
        return out.replace(/\n{3,}/g, '\n\n').trim();
    }

    function btn(label, title, cls) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ra-btn' + (cls ? ' ' + cls : '');
        b.innerHTML = label;
        if (title) b.title = title;
        // 편집기 선택(커서)을 잃지 않도록 mousedown 기본동작 차단 (폰: pointerdown 도 — 자판이 닫히지 않게)
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); });
        return b;
    }
    function sep() { const s = document.createElement('span'); s.className = 'ra-sep'; return s; }

    function upgrade(el, opts) {
        opts = opts || {};
        if (!el) return null;
        el.setAttribute('contenteditable', 'true');
        el.classList.add('rich-answer');
        if (opts.placeholder) el.setAttribute('data-placeholder', opts.placeholder);
        el.setAttribute('spellcheck', 'false');
        const tools = new Set(opts.tools || ['image', 'graph', 'sketch', 'outline', 'format', 'table', 'symbols', 'nav']);
        const continueMode = opts.outlineMode === 'continue';

        const host = el.parentElement || el;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

        const onChange = () => { opts.onChange && opts.onChange(); };
        const editable = () => el.getAttribute('contenteditable') !== 'false';

        // ── 편집 원시 동작 (execCommand 로 해 Ctrl+Z 되돌리기가 살아 있게) ──
        function selectRange(n1, o1, n2, o2) {
            const r = document.createRange();
            r.setStart(n1, o1); r.setEnd(n2, o2);
            const s = window.getSelection();
            s.removeAllRanges(); s.addRange(r);
        }
        function replaceRange(n1, o1, n2, o2, text) {
            selectRange(n1, o1, n2, o2);
            if (text) document.execCommand('insertText', false, text);
            else if (!(n1 === n2 && o1 === o2)) document.execCommand('delete');
        }
        function caretPoint() {
            const s = window.getSelection();
            if (!s || !s.rangeCount || !el.contains(s.anchorNode)) return null;
            return { node: s.focusNode, off: s.focusOffset };
        }
        function currentLine() {
            const c = caretPoint();
            if (!c) return null;
            const lines = scanLines(el);
            let idx = -1;
            for (let i = 0; i < lines.length; i++) {
                if (le(lines[i].node, lines[i].off, c.node, c.off)) idx = i; else break;
            }
            if (idx < 0) return null;
            return { lines, idx, line: lines[idx], caret: c };
        }
        /** lines[idx] 위쪽에서 같은 단계의 직전 번호 + 1 (상위 단계를 만나면 1부터) */
        function nextNumber(lines, idx, lv) {
            for (let i = idx - 1; i >= 0; i--) {
                const p = parseLine(lines[i].text);
                if (p.level < 0) continue;
                if (p.level === lv) return p.n + 1;
                if (p.level < lv) return 1;
            }
            return 1;
        }
        /** 줄의 기존 머리(들여쓰기+번호)를 newPrefix 로 바꾸고 커서를 본문 같은 자리에 둔다 */
        function setLinePrefix(cur, newPrefix) {
            const { line, caret } = cur;
            const p = parseLine(line.text);
            const tn = line.node;
            let caretInLine = null;
            if (tn.nodeType === 3 && caret.node === tn && caret.off >= line.off) caretInLine = caret.off - line.off;
            replaceRange(tn, line.off, tn, line.off + (tn.nodeType === 3 ? p.prefixLen : 0), newPrefix);
            // 커서 보정 — 번호 뒤 본문에 있었다면 같은 글자 위치로
            if (caretInLine != null && caretInLine > p.prefixLen) {
                const s = window.getSelection();
                const n = s.focusNode, o = s.focusOffset + (caretInLine - p.prefixLen);
                if (n && n.nodeType === 3 && o <= n.data.length) { try { s.collapse(n, o); } catch (e) {} }
            }
            onChange();
        }
        function applyLevel(lv) {
            if (!editable()) return;
            el.focus();
            const cur = currentLine();
            if (!cur) { adapter.insertContent(LEVELS[lv].make(1)); return; }
            const n = nextNumber(cur.lines, cur.idx, lv);
            setLinePrefix(cur, indentOf(lv) + LEVELS[lv].make(n));
        }
        function shiftLevel(delta) {
            const cur = currentLine();
            if (!cur) return false;
            const p = parseLine(cur.line.text);
            if (p.level < 0) return false;
            let lv = p.level + delta;
            if (lv >= LEVELS.length) return true;          // 더 내릴 수 없음 — Tab 은 삼킴
            if (lv < 1 && p.level >= 1) return true;        // Ⅰ. 위로는 제N문으로 올리지 않음
            lv = Math.max(0, lv);
            const n = nextNumber(cur.lines, cur.idx, lv);
            setLinePrefix(cur, indentOf(lv) + LEVELS[lv].make(n));
            return true;
        }
        /** 새 줄 + 같은 단계 다음 번호. 번호만 있는 빈 줄이면 한 단계 올리기(맨 위면 번호 지움) */
        function continueOutline() {
            const cur = currentLine();
            if (!cur) return false;
            const p = parseLine(cur.line.text);
            if (p.level < 0) return false;
            if (!p.rest.trim()) {
                if (p.level <= 1) setLinePrefix(cur, '');
                else {
                    const lv = p.level - 1;
                    setLinePrefix(cur, indentOf(lv) + LEVELS[lv].make(nextNumber(cur.lines, cur.idx, lv)));
                }
                return true;
            }
            const n = p.n + 1;
            document.execCommand('insertLineBreak');
            // 들여쓰기는 그 줄의 것을 그대로 (사용자가 직접 맞춘 들여쓰기 존중)
            document.execCommand('insertText', false, p.ws + LEVELS[p.level].make(n));
            onChange();
            return true;
        }
        /** 문서 전체 번호를 계층대로 다시 매김 (뒤에서부터 고쳐 앞 줄 위치가 밀리지 않게) */
        function renumber() {
            const lines = scanLines(el);
            const cnt = new Array(LEVELS.length).fill(0);
            const edits = [];
            lines.forEach(ln => {
                const p = parseLine(ln.text);
                if (p.level < 0 || ln.node.nodeType !== 3) return;
                cnt[p.level]++;
                for (let k = p.level + 1; k < cnt.length; k++) cnt[k] = 0;
                const want = p.ws + LEVELS[p.level].make(cnt[p.level]);
                const have = ln.text.slice(0, p.prefixLen);
                if (want.trimEnd() !== have.trimEnd()) edits.push({ ln, len: p.prefixLen, want });
            });
            if (!edits.length) return 0;
            const save = adapter.caretTextOffset();
            el.focus();
            for (let i = edits.length - 1; i >= 0; i--) {
                const { ln, len, want } = edits[i];
                replaceRange(ln.node, ln.off, ln.node, ln.off + len, want);
            }
            restoreCaret(save);
            onChange();
            return edits.length;
        }
        function restoreCaret(n) {
            const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let t, acc = 0;
            while ((t = w.nextNode())) {
                if (acc + t.data.length >= n) { try { window.getSelection().collapse(t, n - acc); } catch (e) {} return; }
                acc += t.data.length;
            }
        }
        function headings() {
            return scanLines(el)
                .map(ln => ({ ln, p: parseLine(ln.text) }))
                .filter(x => x.p.level >= 0 && x.ln.text.trim())
                .map(x => ({ level: x.p.level, text: x.ln.text.trim(), line: x.ln }));
        }
        /** 방금 친 글자 앞을 보고 -> · ;a 등을 기호로 */
        function autoSymbol() {
            const s = window.getSelection();
            if (!s || !s.isCollapsed) return;
            const n = s.focusNode, o = s.focusOffset;
            if (!n || n.nodeType !== 3 || !el.contains(n)) return;
            const before = n.data.slice(Math.max(0, o - 4), o);
            for (const [k, v] of AUTO) {
                if (before.endsWith(k)) {
                    replaceRange(n, o - k.length, n, o, v);
                    return;
                }
            }
        }

        // ── 툴바 ───────────────────────────────────────────────────
        const bar = document.createElement('div');
        bar.className = 'ra-toolbar';
        const add = (node) => { bar.appendChild(node); return node; };

        let imgBtn = null, graphBtn = null, sketchBtn = null;
        if (tools.has('image')) {
            imgBtn = add(btn('🖼 그림', '답안에 그림 파일 삽입 (붙여넣기 Ctrl+V 도 가능 · 넣은 그림은 모서리 드래그로 크기 조절, Delete 로 삭제)'));
        }
        if (tools.has('graph')) {
            // 그래프 그리기 — 곡선을 골라 놓는 편집기를 띄우고 결과를 그림으로 넣는다
            graphBtn = add(btn('📈 그래프 그리기', '그래프 편집기(직접 조립)로 축·곡선·점·영역을 놓아 그래프를 그려 답안에 넣습니다 (넣은 그래프를 더블클릭하면 다시 고칠 수 있습니다)'));
        }
        if (tools.has('sketch')) {
            sketchBtn = add(btn('🖍 도식', '자유 그림판 — 상자·화살표·직선·글자로 국제정치·법 도식을 그려 넣습니다 (그래프는 📈 그래프 그리기 · 넣은 그림을 더블클릭하면 다시 고칠 수 있습니다)'));
        }
        if (tools.has('outline')) {
            add(sep());
            LEVELS.forEach((L, lv) => {
                const b = add(btn(L.label, `현재 줄을 ${L.title} 로 — Tab/Shift+Tab 단계 이동 · Ctrl+Enter 다음 번호`, 'ra-sub'));
                b.addEventListener('click', () => applyLevel(lv));
            });
            if (opts.touch) {
                const up = add(btn('⇤', '한 단계 올리기 (Shift+Tab)', 'ra-sub'));
                up.addEventListener('click', () => { if (editable()) shiftLevel(-1); });
                const down = add(btn('⇥', '한 단계 내리기 (Tab)', 'ra-sub'));
                down.addEventListener('click', () => { if (editable()) shiftLevel(1); });
                const nx = add(btn('↵번호', '새 줄 + 같은 단계 다음 번호 (Ctrl+Enter)', 'ra-sub'));
                nx.addEventListener('click', () => {
                    if (!editable()) return;
                    el.focus();
                    if (!continueOutline()) { document.execCommand('insertLineBreak'); onChange(); }
                });
            }
            const rn = add(btn('🔢', '번호 정리 — 문서 전체의 개요 번호를 계층대로 다시 매깁니다(중간 삽입·삭제 뒤 사용)', 'ra-sub'));
            rn.addEventListener('click', () => {
                if (!editable()) return;
                const k = renumber();
                flash(k ? `번호 ${k}곳을 고쳤습니다` : '번호가 이미 맞습니다');
            });
        }
        if (tools.has('format')) {
            add(sep());
            const b = add(btn('<b>B</b>', '굵게 (Ctrl+B)', 'ra-sub'));
            b.addEventListener('click', () => { if (editable()) { document.execCommand('bold'); onChange(); } });
            const u = add(btn('<u>U</u>', '밑줄 (Ctrl+U) — 핵심어 강조', 'ra-sub'));
            u.addEventListener('click', () => { if (editable()) { document.execCommand('underline'); onChange(); } });
        }
        if (tools.has('table')) {
            const t = add(btn('▦ 표', '비교표 삽입 — 행×열 입력 (첫 행은 머리글)', 'ra-sub'));
            t.addEventListener('click', () => {
                if (!editable()) return;
                const ans = prompt('표 크기 (행x열, 머리글 행 포함):', '3x3');
                const m = /^\s*(\d+)\s*[x×*,]\s*(\d+)\s*$/i.exec(ans || '');
                if (!m) return;
                const R = Math.min(20, Math.max(1, +m[1])), C = Math.min(8, Math.max(1, +m[2]));
                let h = '<table class="ans-table"><tbody>';
                for (let r = 0; r < R; r++) {
                    h += '<tr>' + Array.from({ length: C }, () => r === 0 ? '<th>&nbsp;</th>' : '<td>&nbsp;</td>').join('') + '</tr>';
                }
                h += '</tbody></table><br>';
                adapter.insertContent(h);
            });
        }
        if (tools.has('symbols')) {
            const sb = add(btn('Σ 기호', '기호 판 — 클릭하면 커서 위치에 넣습니다. 자동 변환: -> → · => ⇒ · >= ≥ · <= ≤ · != ≠ · ^2 ² · ;a α ;b β ;D Δ …', 'ra-sub'));
            const pop = document.createElement('div');
            pop.className = 'ra-sym-pop';
            pop.style.display = 'none';
            SYMBOLS.forEach(sy => {
                const b = btn(sy, '', 'ra-sym');
                b.addEventListener('click', () => { if (editable()) adapter.insertContent(escHtml(sy)); });
                pop.appendChild(b);
            });
            const hint = document.createElement('div');
            hint.className = 'ra-sym-hint';
            hint.textContent = '자동: -> → · <- ← · => ⇒ · <=> ⇔ · >= ≥ · <= ≤ · != ≠ · ~= ≈ · +- ± · ^2 ² · ^-1 ⁻¹ · ;a α · ;D Δ (; + 로마자 = 그리스)';
            pop.appendChild(hint);
            sb.addEventListener('click', (e) => {
                e.stopPropagation();
                pop.style.display = pop.style.display === 'none' ? 'grid' : 'none';
            });
            document.addEventListener('click', (e) => { if (!pop.contains(e.target)) pop.style.display = 'none'; });
            const wrap = document.createElement('span');
            wrap.style.position = 'relative';
            bar.replaceChild(wrap, sb);
            wrap.appendChild(sb);
            wrap.appendChild(pop);
        }
        let navSel = null;
        if (tools.has('nav')) {
            navSel = document.createElement('select');
            navSel.className = 'ra-nav';
            navSel.title = '목차 이동 — 개요 번호 줄로 바로 갑니다';
            navSel.innerHTML = '<option value="">🧭 목차</option>';
            const refresh = () => {
                const hs = headings();
                navSel.innerHTML = `<option value="">🧭 목차 (${hs.length})</option>` + hs.map((h, i) =>
                    `<option value="${i}">${'  '.repeat(Math.max(0, h.level - 1))}${escHtml(h.text.slice(0, 40))}</option>`).join('');
                navSel._hs = hs;
            };
            navSel.addEventListener('mousedown', refresh);
            navSel.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') refresh(); });
            navSel.addEventListener('change', () => {
                const h = navSel._hs && navSel._hs[+navSel.value];
                navSel.value = '';
                if (!h) return;
                try {
                    const r = document.createRange();
                    r.setStart(h.line.node, h.line.off); r.collapse(true);
                    el.focus();
                    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                    const rect = (h.line.node.nodeType === 3 ? r.getClientRects()[0] : null)
                        || (h.line.node.nodeType === 1 ? h.line.node.getBoundingClientRect() : null)
                        || h.line.node.parentElement.getBoundingClientRect();
                    el.scrollTop += rect.top - el.getBoundingClientRect().top - 24;
                } catch (e) {}
            });
            add(sep());
            add(navSel);
        }
        const msg = document.createElement('span');
        msg.className = 'ra-hint';
        msg.textContent = opts.touch
            ? '⇤⇥ 단계 · ↵번호 다음 번호 · -> ⇒ >= 자동 기호'
            : continueMode
            ? 'Enter 다음 번호 · Tab 내리기 · Shift+Tab 올리기 · 빈 번호 줄 Enter = 한 단계 위로'
            : 'Tab/Shift+Tab 번호 단계 · Ctrl+Enter 다음 번호 · -> ⇒ >= 자동 기호';
        add(msg);
        let flashTimer = null;
        function flash(t) {
            const keep = msg.textContent;
            msg.textContent = t; msg.style.color = '#1b6fb9';
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => { msg.textContent = keep; msg.style.color = ''; }, 2200);
        }
        el.parentNode.insertBefore(bar, el);

        const adapter = {
            el,
            getHTML() { return el.innerHTML || ""; },
            getText() { return el.innerText || ""; },
            getOutlineText() { return toPlain(el); },
            getHeadings() { return headings().map(h => ({ level: h.level, text: h.text })); },
            renumber,
            isEmpty() {
                return (el.innerText || "").trim() === "" && !/<img/i.test(el.innerHTML || "");
            },
            setContent(s) {
                s = s == null ? "" : String(s);
                el.innerHTML = looksHTML(s) ? s : textToHtml(s);
                el.scrollTop = 0;
                onChange();
            },
            clear() { el.innerHTML = ""; onChange(); },
            focus() { el.focus(); },
            setDisabled(v) {
                el.setAttribute('contenteditable', v ? 'false' : 'true');
                el.classList.toggle('ra-disabled', !!v);
            },
            // 커서까지의 *텍스트* 오프셋 (문항별 시간추적용)
            caretTextOffset() {
                try {
                    const s = window.getSelection();
                    if (!s || !s.rangeCount || !el.contains(s.anchorNode)) return (el.innerText || "").length;
                    const r = s.getRangeAt(0).cloneRange();
                    const pre = r.cloneRange();
                    pre.selectNodeContents(el);
                    pre.setEnd(r.endContainer, r.endOffset);
                    return pre.toString().length;
                } catch (e) { return (el.innerText || "").length; }
            },
            insertContent(s) {
                s = s == null ? "" : String(s);
                const html = looksHTML(s) ? s : textToHtml(s);
                el.focus();
                let ok = false;
                try { ok = document.execCommand('insertHTML', false, html); } catch (e) { ok = false; }
                if (!ok) el.innerHTML += html;
                onChange();
            },
            selectedOrAllHTML() {
                const s = window.getSelection();
                if (s && !s.isCollapsed && el.contains(s.anchorNode)) {
                    const d = document.createElement('div');
                    d.appendChild(s.getRangeAt(0).cloneContents());
                    return d.innerHTML;
                }
                return el.innerHTML || "";
            },
            insertImageFromFile() {
                const inp = document.createElement('input');
                inp.type = 'file';
                inp.accept = 'image/*';
                inp.onchange = () => {
                    const f = inp.files && inp.files[0];
                    if (!f) return;
                    const rd = new FileReader();
                    rd.onload = () => insertImageData(el, adapter, rd.result, onChange);
                    rd.readAsDataURL(f);
                };
                inp.click();
            },
        };

        imgBtn?.addEventListener('click', () => {
            if (!editable()) return;
            adapter.insertImageFromFile();
        });

        adapter.onChange = onChange;
        graphBtn?.addEventListener('click', () => {
            if (!editable() || !window.GraphEditor) return;
            window.GraphEditor.insertInto(adapter, null);
        });
        // 그리기 — 열기 전 커서 위치를 기억했다가 그 자리에 넣는다
        function openSketch(img) {
            if (!window.SketchPad) return;
            const s = window.getSelection();
            const saved = (s && s.rangeCount && el.contains(s.anchorNode)) ? s.getRangeAt(0).cloneRange() : null;
            window.SketchPad.open({
                src: img ? img.src : null,
                done: (uri) => {
                    if (img && img.parentNode) { img.src = uri; onChange(); return; }
                    el.focus();
                    if (saved) { const ss = window.getSelection(); ss.removeAllRanges(); ss.addRange(saved); }
                    insertImageData(el, adapter, uri, onChange, ' data-sketch="1"');
                },
            });
        }
        sketchBtn?.addEventListener('click', () => { if (editable()) openSketch(null); });
        // 넣어 둔 그래프·그림을 더블클릭하면 그 자리에서 다시 고친다
        el.addEventListener('dblclick', (e) => {
            if (!editable()) return;
            const g = e.target && e.target.closest && e.target.closest('img[data-ge-model]');
            if (g && window.GraphEditor) { e.preventDefault(); window.GraphEditor.insertInto(adapter, g); return; }
            const sk = e.target && e.target.closest && e.target.closest('img[data-sketch]');
            if (sk) { e.preventDefault(); openSketch(sk); }
        });

        // 개요 단축키 — Tab/Shift+Tab 단계, Ctrl+Enter(어디서나)·Enter(continue 모드) 다음 번호
        el.addEventListener('keydown', (e) => {
            if (!editable() || e.isComposing || e.keyCode === 229) return;
            if (!tools.has('outline')) return;
            if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                if (!shiftLevel(e.shiftKey ? -1 : 1) && !e.shiftKey) document.execCommand('insertText', false, '  ');
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && (e.ctrlKey || continueMode)) {
                if (continueOutline()) { e.preventDefault(); return; }
                if (e.ctrlKey) {   // 번호 줄이 아니면 같은 단계를 알 수 없음 — 그냥 줄바꿈
                    e.preventDefault();
                    document.execCommand('insertLineBreak');
                }
            }
        });
        el.addEventListener('input', (e) => {
            if (tools.has('symbols') && e.inputType === 'insertText' && !e.isComposing) autoSymbol();
        });

        // 클립보드 이미지 붙여넣기 → 인라인 삽입
        el.addEventListener('paste', (e) => {
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const it of items) {
                if (it.type && it.type.indexOf('image') === 0) {
                    const f = it.getAsFile();
                    if (f) {
                        e.preventDefault();
                        const rd = new FileReader();
                        rd.onload = () => insertImageData(el, adapter, rd.result, onChange);
                        rd.readAsDataURL(f);
                        return;
                    }
                }
            }
            // 이미지가 아니면 *순수 텍스트* 로 붙여넣어 외부 서식 오염 방지
            const txt = e.clipboardData && e.clipboardData.getData('text/plain');
            if (txt != null) {
                e.preventDefault();
                adapter.insertContent(txt);
            }
        });

        el.addEventListener('input', onChange);
        attachResizer(host, el, onChange);
        return adapter;
    }

    window.RichAnswer = { upgrade, parseLine, LEVELS };
})();

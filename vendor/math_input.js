/* math_input.js — 학습지 수식 빈칸 입력·채점 (MathLive 위에 얹는 얇은 층)
 *
 *  ‼ 이 파일은 런타임에 읽혀 문서(iframe srcdoc)에 인라인된다 — core/math_input.py 참조.
 *
 *  ① 모든 문서에 같은 입력 규칙
 *     · 그리스 문자 : ';' + 로마자 (;a α, ;p π, ;t θ … 대문자는 대문자 그리스)
 *     · 꾸밈       : 기호 뒤에 이름 (Ybar Ȳ, ;rhat ρ̂, xtilde x̃, kdot k̇)
 *     · 별표       : '*' → 위첨자 별 (;p* → π*)
 *     · 구조       : '_' 아래첨자 · '^' 위첨자 · '/' 분수 · '→' 빠져나오기
 *  ② 이 문서의 변수 자동 제안 — 정답 LaTeX 에서 뽑아 첫 글자만 쳐도 첨자까지 완성
 *  ③ 채점 : LaTeX 를 직접 파싱해 난수를 대입한 수치 비교(항 순서·괄호 전개·분수 모양 무시,
 *           π 는 상수가 아니라 변수로 취급, 시점 첨자 t 는 생략 허용)
 *
 *  사용법 (문서 쪽)
 *     <span class="mi" data-answer="\pi_{t-1}+\phi(Y_t-\bar Y_t)+\nu_t"></span>
 *     window.MathInput.init();                     // 모든 .mi 를 수식칸으로
 *     window.MathInput.grade();                    // → {total, right, items:[{ok, el}]}
 *     window.MathInput.equivalent(a, b);           // 두 LaTeX 가 수학적으로 같은가
 */
(function (global) {
  'use strict';

  /* ───────────────── 공통 규칙 ───────────────── */
  var GREEK_KEYS = [
    ['a', 'alpha', 'α'], ['b', 'beta', 'β'], ['g', 'gamma', 'γ'], ['d', 'delta', 'δ'], ['e', 'varepsilon', 'ε'], ['z', 'zeta', 'ζ'],
    ['h', 'eta', 'η'], ['t', 'theta', 'θ'], ['i', 'iota', 'ι'], ['k', 'kappa', 'κ'], ['l', 'lambda', 'λ'], ['m', 'mu', 'μ'],
    ['n', 'nu', 'ν'], ['x', 'xi', 'ξ'], ['p', 'pi', 'π'], ['r', 'rho', 'ρ'], ['s', 'sigma', 'σ'], ['u', 'tau', 'τ'],
    ['f', 'phi', 'φ'], ['c', 'chi', 'χ'], ['y', 'psi', 'ψ'], ['w', 'omega', 'ω'],
    ['D', 'Delta', 'Δ'], ['G', 'Gamma', 'Γ'], ['L', 'Lambda', 'Λ'], ['P', 'Pi', 'Π'], ['S', 'Sigma', 'Σ'],
    ['F', 'Phi', 'Φ'], ['W', 'Omega', 'Ω'], ['T', 'Theta', 'Θ']
  ];
  var SHORTCUTS = { '*': '^{*}', 'bar': '\\bar{#@}', 'hat': '\\hat{#@}', 'tilde': '\\tilde{#@}', 'dot': '\\dot{#@}' };
  GREEK_KEYS.forEach(function (g) { SHORTCUTS[';' + g[0]] = '\\' + g[1]; });

  /* ───────────────── LaTeX → 식 트리 ───────────────── */
  var ALIAS = { varepsilon: 'eps', epsilon: 'eps', varphi: 'phi', vartheta: 'theta' };
  function tokenize(src) {
    var s = String(src || '').replace(/−/g, '-').replace(/\\mleft|\\mright|\\left|\\right|\\displaystyle|\\,|\\;|\\!|\\ |\\:|~/g, '');
    var out = [], i = 0, m;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '\\') {
        m = /^\\([A-Za-z]+)/.exec(s.slice(i));
        if (!m) { i += 2; continue; }
        var name = m[1]; i += m[0].length;
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') out.push({ t: 'frac' });
        else if (name === 'cdot' || name === 'times' || name === 'ast') out.push({ t: '*' });
        else if (name === 'lparen' || name === 'rparen' || name === 'lbrack' || name === 'rbrack')
          out.push({ t: { lparen: '(', rparen: ')', lbrack: '[', rbrack: ']' }[name] });
        else if (name === 'div') out.push({ t: '/' });
        else if (name === 'lt') out.push({ t: '<' });
        else if (name === 'gt') out.push({ t: '>' });
        else if (name === 'le' || name === 'leq') out.push({ t: '<=' });
        else if (name === 'ge' || name === 'geq') out.push({ t: '>=' });
        else if (name === 'bar' || name === 'overline' || name === 'hat' || name === 'widehat' || name === 'tilde' || name === 'dot')
          out.push({ t: 'acc', v: /hat/.test(name) ? 'hat' : (/tilde/.test(name) ? 'tilde' : (name === 'dot' ? 'dot' : 'bar')) });
        else if (name === 'mathrm' || name === 'mathit' || name === 'text' || name === 'operatorname') { /* 투명 */ }
        else out.push({ t: 'sym', v: ALIAS[name] || name });
        continue;
      }
      if (/[0-9.]/.test(c)) { m = /^[0-9]*\.?[0-9]+/.exec(s.slice(i)); out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (/[A-Za-z]/.test(c)) { out.push({ t: 'sym', v: c }); i++; continue; }
      if (c === '<' || c === '>') { if (s[i + 1] === '=') { out.push({ t: c + '=' }); i += 2; } else { out.push({ t: c }); i++; } continue; }
      if ('{}()[]+-*/^_='.indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
      i++;
    }
    return out;
  }
  function Parser(tokens) { this.k = tokens; this.i = 0; }
  Parser.prototype.peek = function () { return this.k[this.i]; };
  Parser.prototype.eat = function (t) { var p = this.k[this.i]; if (p && p.t === t) { this.i++; return p; } return null; };
  Parser.prototype.need = function (t) { if (!this.eat(t)) throw new Error('expected ' + t); };
  Parser.prototype.relation = function () {
    var l = this.expr(), p = this.peek();
    if (p && ['=', '<', '>', '<=', '>='].indexOf(p.t) >= 0) { this.i++; return { rel: p.t, l: l, r: this.expr() }; }
    return { rel: null, l: l };
  };
  Parser.prototype.expr = function () {
    var n = this.term();
    for (;;) { if (this.eat('+')) n = ['+', n, this.term()]; else if (this.eat('-')) n = ['-', n, this.term()]; else return n; }
  };
  Parser.prototype.startsFactor = function (p) { return p && ['num', 'sym', 'acc', 'frac', '(', '{', '['].indexOf(p.t) >= 0; };
  Parser.prototype.term = function () {
    var n = this.unary();
    for (;;) {
      if (this.eat('*')) n = ['*', n, this.unary()];
      else if (this.eat('/')) n = ['/', n, this.unary()];
      else if (this.startsFactor(this.peek())) n = ['*', n, this.postfix()];
      else return n;
    }
  };
  Parser.prototype.unary = function () {
    if (this.eat('-')) return ['neg', this.unary()];
    if (this.eat('+')) return this.unary();
    return this.postfix();
  };
  Parser.prototype.groupText = function () {
    if (this.eat('{')) {
      var depth = 1, txt = '';
      while (this.i < this.k.length) {
        var p = this.k[this.i++];
        if (p.t === '{') depth++;
        else if (p.t === '}') { if (--depth === 0) break; }
        else txt += (p.v !== undefined ? p.v : p.t);
      }
      return txt;
    }
    var q = this.k[this.i++]; return q ? (q.v !== undefined ? String(q.v) : q.t) : '';
  };
  Parser.prototype.groupExpr = function () {
    if (this.eat('{')) { var e = this.expr(); this.need('}'); return e; }
    return this.primary();
  };
  Parser.prototype.postfix = function () {
    var n = this.primary();
    for (;;) {
      var p = this.peek();
      if (!p) return n;
      if (p.t === '_' && n.v) { this.i++; n.sub = this.groupText().replace(/[{}\s]/g, ''); continue; }
      if (p.t === '^') {
        this.i++;
        if (n.v) {
          var j = this.i, g = this.groupText();
          if (g === '*' || g === 'e') { n.sup = g; continue; }
          this.i = j;
        }
        n = ['^', n, this.groupExpr()]; continue;
      }
      return n;
    }
  };
  Parser.prototype.primary = function () {
    var p = this.k[this.i++];
    if (!p) throw new Error('end');
    if (p.t === 'num') return { num: p.v };
    if (p.t === 'sym') return { v: p.v };
    if (p.t === 'acc') return { v: p.v + '(' + this.groupText().replace(/[{}\s]/g, '') + ')' };
    if (p.t === 'frac') { var a = this.groupExpr(), d = this.groupExpr(); return ['/', a, d]; }
    if (p.t === '(') { var e = this.expr(); this.need(')'); return e; }
    if (p.t === '[') { var e2 = this.expr(); this.need(']'); return e2; }
    if (p.t === '{') { var e3 = this.expr(); this.need('}'); return e3; }
    throw new Error('unexpected ' + p.t);
  };
  function varName(n) { return n.v + (n.sub && n.sub !== 't' ? '_' + n.sub : '') + (n.sup ? '^' + n.sup : ''); }
  function evaluate(n, env) {
    if (n.num !== undefined) return n.num;
    if (n.v !== undefined) { var k = varName(n); if (!(k in env)) env[k] = 0.35 + Math.random() * 1.3; return env[k]; }
    var a = evaluate(n[1], env);
    switch (n[0]) {
      case 'neg': return -a;
      case '+': return a + evaluate(n[2], env);
      case '-': return a - evaluate(n[2], env);
      case '*': return a * evaluate(n[2], env);
      case '/': return a / evaluate(n[2], env);
      case '^': return Math.pow(a, evaluate(n[2], env));
    }
    return NaN;
  }
  function parse(latex) { var P = new Parser(tokenize(latex)); var r = P.relation(); if (P.i < P.k.length) throw new Error('trailing'); return r; }
  function diffOf(rel, env) {
    var l = evaluate(rel.l, env);
    if (!rel.rel) return { kind: 'expr', d: l };
    var r = evaluate(rel.r, env);
    if (rel.rel === '=') return { kind: 'eq', d: l - r };
    if (rel.rel === '>' || rel.rel === '>=') return { kind: rel.rel.length > 1 ? 'ge' : 'gt', d: l - r };
    return { kind: rel.rel.length > 1 ? 'ge' : 'gt', d: r - l };
  }
  function equivalent(userLatex, keyLatex) {
    var U, K;
    try { U = parse(userLatex); K = parse(keyLatex); } catch (e) { return false; }
    var ratio = null;
    for (var trial = 0; trial < 7; trial++) {
      var env = {}, ku = diffOf(K, env), uu = diffOf(U, env);
      if (ku.kind !== uu.kind || !isFinite(uu.d) || !isFinite(ku.d)) return false;
      var tol = 1e-8 * Math.max(1, Math.abs(ku.d));
      if (ku.kind === 'expr') { if (Math.abs(uu.d - ku.d) > tol) return false; continue; }
      if (Math.abs(ku.d) < 1e-9) { if (Math.abs(uu.d) > tol) return false; continue; }
      var c = uu.d / ku.d;
      if (ratio === null) ratio = c;
      if (Math.abs(c - ratio) > 1e-7 * Math.max(1, Math.abs(ratio))) return false;
      if (ku.kind !== 'eq' && ratio <= 0) return false;
    }
    return true;
  }

  /* ───────────────── 이 문서의 변수 목록 ───────────────── */
  var ATOM = /(\\(?:bar|hat|tilde|dot)\{(?:\\[a-zA-Z]+|[A-Za-z])\}|\\(?!frac|left|right|mleft|mright|cdot|times|le|ge|lt|gt)[a-zA-Z]+|[A-Za-z]+)((?:_(?:\{[^{}]*\}|\\[a-zA-Z]+|[A-Za-z0-9])|\^(?:\{\*\}|\*))*)/g;
  function tidy(base, tail) {
    var sub = '', sup = '';
    tail.replace(/_(\{[^{}]*\}|\\[a-zA-Z]+|[A-Za-z0-9])|\^(\{\*\}|\*)/g, function (m, s, p) {
      if (s) sub = s.charAt(0) === '{' ? s.slice(1, -1) : s;
      if (p) sup = '*';
      return '';
    });
    return base + (sup ? '^{*}' : '') + (sub ? '_{' + sub + '}' : '');
  }
  function baseKey(latex) {
    var m = /^(\\(?:bar|hat|tilde|dot)\{(\\[a-zA-Z]+|[A-Za-z])\}|\\[a-zA-Z]+|[A-Za-z]+)/.exec(latex || '');
    if (!m) return '';
    return m[0].replace(/\\(bar|hat|tilde|dot)\{\\?([a-zA-Z]+)\}/, '$2$1').replace(/\\/g, '');
  }
  function buildVars(latexList) {
    var freq = {};
    latexList.forEach(function (tex) {
      String(tex || '').replace(ATOM, function (m, base, tail) {
        if (/^[A-Za-z]{2,}$/.test(base) && !tail) return m;         /* αθ 같은 곱은 제외 */
        var full = tidy(base, tail || ''); freq[full] = (freq[full] || 0) + 1; return m;
      });
    });
    return Object.keys(freq).map(function (k) { return { latex: k, key: baseKey(k), n: freq[k] }; })
      .sort(function (a, b) { return b.n - a.n || a.latex.length - b.latex.length; });
  }

  /* ───────────────── 자동 제안 ───────────────── */
  var TAIL = /((?:\\(?:bar|hat|tilde|dot)\{(?:\\[a-zA-Z]+|[A-Za-z])\}|\\[a-zA-Z]+|[A-Za-z])+)$/;
  /* 커서 왼쪽 LaTeX → 제안 후보(이 문서의 변수) */
  function candidatesFor(leftLatex, vars) {
    var m = TAIL.exec(leftLatex || '');
    if (!m) return [];
    var toks = m[1].match(/\\(?:bar|hat|tilde|dot)\{(?:\\[a-zA-Z]+|[A-Za-z])\}|\\[a-zA-Z]+|[A-Za-z]/g) || [];
    var last = toks[toks.length - 1], key = baseKey(last);
    if (!key) return [];
    return vars.filter(function (v) {
      return v.key === key || (v.key.indexOf(key) === 0 && v.key !== key && /bar|hat|tilde|dot/.test(v.key));
    }).filter(function (v) { return v.latex !== last; }).slice(0, 6);
  }

  function attachSuggest(mf, host, vars) {
    var box = document.createElement('div');
    box.className = 'mi-sugg'; box.hidden = true; box.setAttribute('role', 'listbox');
    host.appendChild(box);
    var cands = [], sel = 0;
    function close() { box.hidden = true; cands = []; }
    function render() {
      box.innerHTML = cands.map(function (c, i) {
        return '<div class="mi-opt' + (i === sel ? ' on' : '') + '" role="option" data-k="' + i + '">' +
          (global.MathLive && MathLive.convertLatexToMarkup ? MathLive.convertLatexToMarkup(c.latex) : c.latex) +
          (i === sel ? '<kbd>Tab</kbd>' : '') + '</div>';
      }).join('') + '<div class="mi-hint">↓↑ 고르기 · Esc 닫기</div>';
      box.hidden = false;
    }
    function update() {
      var left; try { left = mf.getValue(0, mf.position, 'latex'); } catch (e) { left = ''; }
      cands = candidatesFor(left, vars);
      if (!cands.length) return close();
      sel = 0; render();
    }
    function accept(i) {
      var c = cands[i]; if (!c) return;
      mf.executeCommand('deleteBackward');
      mf.insert(c.latex, { format: 'latex', selectionMode: 'after' });
      close();
      mf.dispatchEvent(new Event('input', { bubbles: true }));
    }
    mf.addEventListener('input', function () { setTimeout(update, 0); });
    mf.addEventListener('keydown', function (e) {
      if (box.hidden || !cands.length) return;
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); accept(sel); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = (sel + 1) % cands.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = (sel - 1 + cands.length) % cands.length; render(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') close();
    }, true);
    mf.addEventListener('focusout', function () { setTimeout(close, 120); });
    box.addEventListener('mousedown', function (e) {
      var o = e.target.closest && e.target.closest('.mi-opt'); if (!o) return;
      e.preventDefault(); accept(+o.getAttribute('data-k')); mf.focus();
    });
  }

  /* ───────────────── 자동 첨자 (경제학 학습지) ─────────────────
   *  기호(대문자·그리스·꾸민 기호) 바로 뒤에 **소문자나 숫자**를 치면 밑첨자로 들어간다.
   *    Yt → Y_t · ;pt → π_t · it → i_t · Ybart → Ȳ_t · Yt-1 → Y_{t-1}
   *  나오기는 → (오른쪽 화살표). 대문자·그리스가 이어지면 곱으로 둔다(αθ · MU · DAS 안 깨지게).
   *
   *  ‼ 뒤에 붙는 낱말 규칙(bar·hat·dot)과 ln·log 같은 이름이 먼저다 —
   *    지금까지 친 글자가 그 낱말의 앞부분이면 첨자로 넣지 않고 그대로 흘려보낸다.
   *    (그래서 tilde 는 자동 첨자와 겹쳐 쓸 수 없다 — t 는 첨자로 간다)
   */
  var DECOR = ['bar', 'hat', 'dot'];        /* 기호 뒤에 붙는 낱말 — 첫 글자부터 첨자보다 먼저 */
  var FUNCS = ['ln', 'log', 'exp', 'min', 'max', 'lim', 'sin', 'cos', 'tan'];  /* 두 번째 글자부터 */

  /* ───────────────── 약자(略字) ─────────────────
   *  등록된 약자는 앞뒤에 다른 영문자가 없을 때 곧바로 대문자로 바뀐다 — nato → NATO.
   *  약자를 이루는 글자들은 자동 첨자로 가지 않는다 (mc → MC, m_c 아님).
   */
  var ABBR = {
    econ: ['MC', 'AC', 'TC', 'TVC', 'AVC', 'TFC', 'AFC', 'MR', 'AR', 'TR', 'MB', 'MAC',
           'IS', 'LM', 'AD', 'AS', 'MPC', 'MPS', 'MPL', 'MPK', 'MRS', 'MRTS', 'MRP',
           'GDP', 'GNP', 'CPI', 'PPP', 'IRP', 'UIP', 'CIP', 'NX', 'BP', 'LRAS', 'SRAS'],
    /* 국제법·국제정치학은 겹치는 약자가 많아 한 묶음으로 쓴다 */
    intl: ['VCLT', 'VCDR', 'VCCR', 'UN', 'UNCLOS', 'ILC', 'ICC', 'ITLOS', 'ICESCR', 'ICCPR',
           'ICJ', 'PCIJ', 'WTO', 'GATT', 'GATS', 'TRIPS', 'ILO', 'WHO', 'IMO', 'ICRC',
           'ARSIWA', 'ECHR', 'IACHR',
           'NATO', 'START', 'SALT', 'NPT', 'PTBT', 'CTBT', 'EU', 'ASEAN', 'OPEC', 'BRICS',
           'IMF', 'IAEA', 'ABM', 'INF', 'MAD', 'G7', 'G20', 'OECD', 'APEC', 'NAFTA',
           'USMCA', 'AU', 'OAS', 'PKO', 'ODA']
  };
  ABBR.law = ABBR.politics = ABBR.intl;

  function wordish(cand, first, abbr) {
    var list = first ? DECOR : DECOR.concat(FUNCS);
    for (var i = 0; i < list.length; i++) if (list[i].indexOf(cand) === 0) return list[i] === cand ? 2 : 1;
    if (abbr && abbr.length) {                       /* 약자는 대소문자 안 가리고 앞부분부터 */
      var up = cand.toUpperCase(), pre = 0;
      for (var j = 0; j < abbr.length; j++) {
        if (abbr[j] === up) return 3;                /* 3 = 약자 완성 → 대문자로 */
        if (abbr[j].indexOf(up) === 0) pre = 1;      /* 1 = 아직 앞부분 */
      }
      if (pre) return pre;
    }
    return 0;
  }
  var SYMBOL_END = /(?:\\(?:bar|hat|tilde|dot|vec)\{(?:\\[a-zA-Z]+|[A-Za-z])\}|\^\{?\*\}?|\\[a-zA-Z]+|[A-Za-z])$/;
  /* 직전 키가 이것이면 첨자로 보내지 않는다 — MathLive 의 getValue 는 여는 괄호를 빼고 주기 때문에
     'α(' 를 'α' 로 잘못 읽는다. 이름 있는 키(화살표·Backspace…) 뒤도 위치가 바뀐 뒤라 건드리지 않는다. */
  var NO_SUB_AFTER = /^(?:[([{|,]|.{2,})$/;

  /** 등록된 약자면 방금 친 낱말을 대문자로 바꿔 놓는다. */
  function upperize(mf, st) {
    var run = st.pend, up = run ? run.toUpperCase() : '';
    if (!run || run === up) return;
    try {
      for (var i = 0; i < run.length; i++) mf.executeCommand('deleteBackward');
      mf.executeCommand(['typedText', up]);
    } catch (e) { return; }
    st.pend = up;
  }
  function finishAbbr(mf, st) {
    if (st.pend && wordish(st.pend, false, st.abbr) === 3) upperize(mf, st);
  }

  /* ───────────────── 괄호·분수 구조 ─────────────────
   *  ① 첨자 안에서 = < > / * ( , 를 치면 먼저 첨자 밖으로 나온다 ( ) 는 MathLive 가 알아서 나감).
   *  ② 첨자 안의 + − 는 다음 글자를 보고 판단한다 — 숫자면 t−1 처럼 첨자 안에, 아니면 항 구분.
   *  ③ / 는 앞의 '항' 을 분자로 삼되 괄호 묶음은 괄호를 벗긴다. / 를 한 번 더 누르면 분자를 한 항 넓힌다.
   */
  var SUB_EXIT = /^[=<>/*(,]$/;
  var HARD_STOP = /^[=<>,)\]}]/;          /* 분자를 여기서 끊는다 */
  var SOFT_STOP = /^[+\-]/;               /* / 를 더 누르면 넘어갈 수 있는 경계 */

  function snapOf(mf) { try { return { v: mf.value, p: mf.position }; } catch (e) { return null; } }
  function restoreSnap(mf, s) { if (s) { try { mf.value = s.v; mf.position = s.p; } catch (e) {} } }
  function leaveGroup(mf) { try { mf.executeCommand('moveAfterParent'); } catch (e) {} }

  /** 커서 앞 LaTeX 에서 분자로 삼을 부분이 시작하는 글자 위치 — level 만큼 +,− 를 더 넘어간다. */
  function termStart(left, level) {
    var i = left.length, depth = 0, crossed = 0;
    while (i > 0) {
      var c = left.charAt(i - 1);
      if (c === '}' || c === ')' || c === ']') { depth++; i--; continue; }
      if (c === '{' || c === '(' || c === '[') {
        depth--; i--;
        if (depth < 0) return i + 1;              /* 바깥 그룹으로 넘어갔다 */
        continue;
      }
      if (depth === 0) {
        if (c === '=' || c === '<' || c === '>' || c === ',') return i;
        if (c === '+' || c === '-') {
          if (crossed >= level) return i;
          crossed++;
        }
      }
      i--;
    }
    return 0;
  }

  /** getValue 로 같은 꼬리를 만드는 오프셋을 찾는다 (원자 오프셋 ≠ 글자 수라 되짚어 찾는다). */
  function offsetOfTail(mf, pos, tail) {
    for (var s = pos - 1; s >= 0; s--) {
      var t;
      try { t = mf.getValue(s, pos, 'latex'); } catch (e) { continue; }
      if (t === tail) return s;
    }
    return -1;
  }

  var PAREN = new RegExp('^\\\\(?:m)?left\\((.*)\\\\(?:m)?right\\)$');
  function unwrap(tex) {
    var m = PAREN.exec(tex);
    if (m) return m[1];
    if (tex.charAt(0) === '(' && tex.charAt(tex.length - 1) === ')') {
      var inner = tex.slice(1, -1), d = 0;
      for (var i = 0; i < inner.length; i++) {
        if (inner[i] === '(') d++;
        else if (inner[i] === ')') { if (--d < 0) return tex; }
      }
      return inner;
    }
    return tex;
  }

  /** 커서가 괄호·분수·첨자 안이 아닌 맨 바깥에 있나 — 안쪽에서는 getValue 가 둘러싼 괄호를 빼고 준다. */
  function atTopLevel(mf) {
    try {
      var pos = mf.position;
      return mf.getValue(0, pos, 'latex') + mf.getValue(pos, mf.lastOffset, 'latex') === mf.value;
    } catch (e) { return false; }
  }

  /** '/' 직접 처리 — 분자를 정해 \frac 으로 감싼다. 처리했으면 true.
   *  괄호 안에서는 MathLive 기본 동작이 이미 정확하므로 건드리지 않는다. */
  function makeFrac(mf, st, level, snap) {
    if (!atTopLevel(mf)) return false;
    var pos, left;
    try { pos = mf.position; left = mf.getValue(0, pos, 'latex'); } catch (e) { return false; }
    if (!left) return false;
    var cut = termStart(left, level);
    var num = left.slice(cut);
    if (!num) return false;
    var s = (cut === 0) ? 0 : offsetOfTail(mf, pos, num);
    if (s < 0) return false;
    var inner = unwrap(num);
    try {
      mf.selection = { ranges: [[s, pos]], direction: 'none' };
      mf.insert('\\frac{' + inner + '}{#?}', { format: 'latex', selectionMode: 'placeholder' });
    } catch (e) { return false; }
    st.frac = { snap: snap, level: level, after: snapOf(mf) };
    st.inSub = false;
    return true;
  }

  function autoSubscript(mf, st, e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.key === 'Process') return;
    var k = e.key;

    /* ② 방금 자동으로 들어간 첨자를 백스페이스로 되돌린다 — 글자는 남기고 첨자만 푼다 */
    if (k === 'Backspace' && st.just) {
      e.preventDefault(); e.stopPropagation();
      st.just = false; st.lit = true;                 /* 되돌린 낱말은 계속 그대로 쓴다 */
      mf.executeCommand('deleteBackward');            /* 첨자 안의 글자 */
      mf.executeCommand('deleteBackward');            /* 빈 첨자 자리 */
      mf.executeCommand(['typedText', st.ch, { simulateKeystroke: true }]);
      st.prev = k; return;
    }
    st.just = false;

    /* ③ 백틱 = 그대로 쓰기 — 이어지는 영문 낱말 동안 자동 첨자를 끈다 */
    if (k === '`') { e.preventDefault(); e.stopPropagation(); st.lit = true; st.pend = ''; st.prev = k; return; }

    /* 첨자 안에서 친 +,− 는 다음 글자를 보고 판정한다 — 숫자면 t−1, 아니면 항 구분이라 밖으로 뺀다 */
    if (st.sign) {
      var sign = st.sign; st.sign = null;
      if (k !== 'Backspace' && !/^[0-9]$/.test(k)) {
        restoreSnap(mf, sign.snap);
        leaveGroup(mf);
        st.inSub = false;
        mf.executeCommand(['typedText', sign.ch, { simulateKeystroke: true }]);
        if (k === 'ArrowRight' || k === 'Enter' || k === 'Tab') {
          e.preventDefault(); e.stopPropagation(); st.prev = k; return;   /* 나오려던 참이었다 */
        }
      }
    }

    var was = st.prev; st.prev = k;
    var wasFrac = st.frac; st.frac = null;
    if (k.length > 1) st.inSub = false;          /* →·Esc·Tab … 첨자 밖으로 나왔다 */

    /* 첨자 안에서 다른 기호를 치면 먼저 빠져나온다 */
    if (st.inSub && SUB_EXIT.test(k)) { leaveGroup(mf); st.inSub = false; }
    if (k === ')') st.inSub = false;             /* ) 는 MathLive 가 알아서 나간다 */
    if (k === '_' || k === '^') st.inSub = true; /* 직접 친 첨자 — 그 안에 또 넣지 않게 */

    if (k === '/') {                              /* 분수 — 분자를 정해서 우리가 감싼다 */
      var snap = wasFrac ? wasFrac.snap : snapOf(mf);
      var level = wasFrac ? wasFrac.level + 1 : 0;
      if (wasFrac) restoreSnap(mf, snap);
      if (makeFrac(mf, st, level, snap)) { e.preventDefault(); e.stopPropagation(); }
      else if (wasFrac) {                         /* 더 넓힐 게 없다 — 방금 만든 분수로 되돌린다 */
        restoreSnap(mf, wasFrac.after);
        st.frac = wasFrac;
        e.preventDefault(); e.stopPropagation();
      }
      st.pend = ''; st.lit = false; return;
    }

    if (!/^[A-Za-z0-9]$/.test(k)) {              /* 낱말 밖으로 나왔다 — 여기서 약자를 확정한다 */
      finishAbbr(mf, st);
      /* 첨자 안의 +,− 는 판정을 미룬다 */
      if (st.inSub && (k === '+' || k === '-')) st.sign = { snap: snapOf(mf), ch: k };
      st.pend = ''; st.lit = false; return;
    }

    if (st.lit) { st.pend = ''; return; }                  /* 백틱 — 그대로 쓰는 중 */

    var left = '';
    try { left = mf.getValue(0, mf.position, 'latex'); } catch (err) { left = ''; }

    /* ① 이미 시작한 낱말·약자를 이어 간다 */
    if (st.pend) {
      var wc = wordish(st.pend + k, false, st.abbr);
      if (wc) {
        st.pend = (wc === 2) ? '' : st.pend + k;
        if (wc === 3) setTimeout(function () { upperize(mf, st); }, 0);
        return;
      }
    }
    /* ② bar·hat·dot 은 언제든 새로 시작한다 — 기호 뒤라는 자리가 첨자와 같기 때문 */
    if (/[a-z]/.test(k) && wordish(k, true, null)) { st.pend = k; return; }

    /* 약자는 앞에 영문자가 없는 자리에서만 시작한다 */
    function abbrStart() {
      return !!(st.abbr && st.abbr.length && !/[A-Za-z]$/.test(left) && wordish(k, false, st.abbr));
    }
    if (!/^[a-z0-9]$/.test(k)) { st.pend = abbrStart() ? k : ''; return; }   /* 대문자는 첨자 대상 아님 */

    var go = st.sub && !!left && !st.inSub && !NO_SUB_AFTER.test(was || '')
      && (left.match(/\{/g) || []).length === (left.match(/\}/g) || []).length   /* 이미 첨자·분수 안이면 말고 */
      && !/[_^]$/.test(left)                                                     /* 방금 _ 를 쳤다 */
      && !/(?:\\(?:frac|sqrt|left|right|cdot|times|ln|log|exp|min|max|lim|sin|cos|tan)|[0-9])$/.test(left)
      && SYMBOL_END.test(left);
    /* 그냥 쳤다 — 낱말·약자가 될 수 있는 글자만 기억해 둔다 */
    if (!go) { st.pend = (wordish(k, false, null) || abbrStart()) ? k : ''; return; }
    e.preventDefault();
    e.stopPropagation();
    mf.executeCommand(['typedText', '_' + k, { simulateKeystroke: true }]);
    st.pend = ''; st.just = true; st.inSub = true; st.ch = k;
  }

  /** 이 학습지가 어느 과목인가 — 자동 첨자(경제학)·약자 목록을 여기서 고른다.
   *  경로·<meta name="mi-subject">·제목 순으로 본다. */
  function subjectOf() {
    var t = '';
    try { t = decodeURIComponent(global.location.href || ''); } catch (e) { t = global.location.href || ''; }
    var m = document.querySelector('meta[name="mi-subject"]');
    if (m) t = m.getAttribute('content') || '';
    else t += ' ' + (document.title || '');
    if (/경제|econ/i.test(t) || /거시|미시|국제금융|국제무역|계량/.test(t)) return 'econ';
    if (/국제법|국제정치|정치학|외교사|law|politics|intl/i.test(t)) return 'intl';
    return '';
  }

  /* ───────────────── 초기화 ───────────────── */
  var STYLE = '.mi{position:relative;display:inline-block;min-width:8em;vertical-align:middle}' +
    '.mi math-field{display:block;width:100%;font-size:17px;padding:1px 7px;border:1px solid #a99a82;border-radius:4px;background:#fff;color:#221e18;' +
    '--caret-color:#9a6a30;--selection-background-color:#f0e5d3}' +
    '.mi math-field:focus-within{outline:2px solid #9a6a30;outline-offset:1px}' +
    '.mi math-field::part(virtual-keyboard-toggle),.mi math-field::part(menu-toggle){display:none}' +
    '.mi.ok math-field{border-color:#2f6b48;background:#e9f4ec}.mi.bad math-field{border-color:#a3392b;background:#fbeceb}' +
    '.mi-sugg{position:absolute;left:0;top:100%;margin-top:3px;z-index:60;background:#fff;color:#221e18;border:1px solid #c9bfa9;border-radius:6px;' +
    'box-shadow:0 6px 18px rgba(40,30,10,.18);display:flex;flex-direction:column;padding:3px;min-width:160px}' +
    '.mi-sugg[hidden]{display:none}.mi-opt{display:flex;align-items:center;gap:10px;padding:2px 9px;border-radius:4px;font-size:16px;cursor:pointer}' +
    '.mi-opt.on{background:#f0e5d3}.mi-opt kbd{font-size:10px;margin-left:auto;opacity:.7}' +
    '.mi-hint{font-size:10.5px;color:#7b7061;padding:1px 9px 2px}' +
    '.mi-ans{display:none;font-size:12.5px;color:#2f6b48;font-weight:700;margin-left:4px}' +
    'body.mi-reveal .mi:not(.ok) .mi-ans{display:inline-block}';

  var fields = [];
  function init(opts) {
    opts = opts || {};
    if (!global.MathfieldElement) return false;
    if (!document.getElementById('mi-style')) {
      var st = document.createElement('style'); st.id = 'mi-style'; st.textContent = STYLE; document.head.appendChild(st);
    }
    MathfieldElement.fontsDirectory = opts.fontsDirectory !== undefined ? opts.fontsDirectory : null;
    MathfieldElement.soundsDirectory = null;
    var subject = opts.subject || subjectOf();
    var autoSub = (opts.autoSubscript === undefined) ? (subject === 'econ') : !!opts.autoSubscript;
    var abbr = opts.abbr || ABBR[subject] || [];
    var hosts = [].slice.call(document.querySelectorAll('.mi'));
    var vars = buildVars(hosts.map(function (h) { return (h.getAttribute('data-answer') || '').split('|')[0]; }));
    fields = [];
    hosts.forEach(function (host) {
      if (host.querySelector('math-field')) return;
      var mf = new MathfieldElement();
      mf.mathVirtualKeyboardPolicy = 'manual';
      mf.inlineShortcutTimeout = 0;
      mf.value = host.getAttribute('data-value') || '';
      host.insertBefore(mf, host.firstChild);
      try { mf.inlineShortcuts = Object.assign({}, mf.inlineShortcuts, SHORTCUTS); } catch (e) {}
      try { mf.menuItems = []; } catch (e) {}
      var ansTag = document.createElement('span');
      ansTag.className = 'mi-ans';
      var ansTex = (host.getAttribute('data-answer') || '').split('|')[0];
      if (global.MathLive && MathLive.convertLatexToMarkup) {
        ansTag.innerHTML = '정답 ' + MathLive.convertLatexToMarkup(ansTex);   // LaTeX 원문이 아니라 수식으로
      } else {
        ansTag.textContent = '정답 ' + ansTex;
      }
      host.appendChild(ansTag);
      mf.addEventListener('input', function () {
        host.classList.remove('ok', 'bad');
        host.setAttribute('data-value', mf.value);
        if (typeof opts.onInput === 'function') opts.onInput(host, mf);
      });
      attachSuggest(mf, host, vars);
      {   /* 괄호·분수 구조는 모든 과목 공통, 자동 첨자·약자만 과목별 */
        var st = { pend: '', lit: false, just: false, ch: '', prev: '', abbr: abbr, sub: autoSub };
        mf.addEventListener('keydown', function (e) { autoSubscript(mf, st, e); }, true);
        mf.addEventListener('focusin', function () {
          st.pend = ''; st.lit = false; st.just = false; st.prev = '';
          st.inSub = false; st.sign = null; st.frac = null;
        });
        mf.addEventListener('focusout', function () { finishAbbr(mf, st); st.pend = ''; });
      }
      fields.push({ host: host, mf: mf });
    });
    try { initText({ subject: subject, abbr: abbr }); } catch (e) {}   /* 그림 라벨칸에도 약자 */
    return true;
  }

  /* ───────────────── 평문 작성칸의 수식 규칙 ─────────────────
   *  서술형 답안·복습·큐카드처럼 **평문으로 저장되는** 칸에서도 같은 손버릇을 쓴다.
   *  다만 MathLive 를 얹을 수 없으므로 결과를 **유니코드 글자**로 넣는다 — π · Yₜ · Ȳ · x² .
   *  저장이 평문이든 HTML이든 그대로 남고, 낭독·채점도 그 글자를 그대로 읽는다.
   *
   *  ‼ 여기서는 자동 첨자를 쓰지 않는다. 산문에 섞인 영어 낱말까지 첨자로 빨려 들어가기 때문.
   *    첨자는 '_' , 위첨자는 '^' 로 분명히 찍을 때만 내려간다.
   */
  var SUBC = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇',
    '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ',
    p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };
  var SUPC = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷',
    '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    i: 'ⁱ', n: 'ⁿ', e: 'ᵉ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ',
    k: 'ᵏ', l: 'ˡ', m: 'ᵐ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ',
    w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', '*': '*' };
  var MARK = { bar: '̄', hat: '̂', dot: '̇', tilde: '̃' };
  /* 이미 첨자인 글자인지 빨리 보려고 뒤집어 둔 표 */
  var SUB_SET = {}, SUP_SET = {};
  Object.keys(SUBC).forEach(function (k) { SUB_SET[SUBC[k]] = 1; });
  Object.keys(SUPC).forEach(function (k) { if (SUPC[k] !== k) SUP_SET[SUPC[k]] = 1; });
  var GREEK_CHAR = {};
  GREEK_KEYS.forEach(function (g) { GREEK_CHAR[g[0]] = g[2]; });
  /* 꾸밈을 붙일 수 있는 것 — 대문자·그리스 문자만. 산문의 'sandbar' 가 망가지지 않게. */
  var DECORABLE = /[A-ZͰ-Ͽ]$/;

  /** 커서 앞 글자를 읽고 고치는 공통 창구 — textarea·input 과 contenteditable 을 함께 다룬다. */
  function caretAt(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      var off = el.selectionStart;
      if (off == null || off !== el.selectionEnd) return null;
      return {
        before: el.value.slice(0, off),
        replace: function (n, put) {
          el.value = el.value.slice(0, off - n) + put + el.value.slice(off);
          var c = off - n + put.length;
          el.setSelectionRange(c, c);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
    }
    var sel = global.getSelection && global.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!r.collapsed) return null;
    var node = r.startContainer, o2 = r.startOffset;
    if (!node || node.nodeType !== 3) return null;
    return {
      before: node.data.slice(0, o2),
      replace: function (n, put) {
        node.deleteData(o2 - n, n);
        if (put) node.insertData(o2 - n, put);
        var r2 = document.createRange();
        r2.setStart(node, o2 - n + put.length); r2.collapse(true);
        sel.removeAllRanges(); sel.addRange(r2);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
  }

  /** 커서 앞 글자에 맞는 규칙 하나를 찾아 {n, put} 로 돌려준다. 없으면 null.
   *  chainOff 이면 '이어지는 첨자'만 끊는다 — 평문 칸에서 → 로 첨자를 빠져나오는 길. */
  function textRule(before, key, abbr, chainOff) {
    var m;
    /* ① 그리스 문자 — ';' + 로마자 */
    if (/^[A-Za-z]$/.test(key) && before.slice(-2, -1) === ';') {
      var g = GREEK_CHAR[key];
      if (g) return { n: 2, put: g };
    }
    /* ② 꾸밈 — 대문자·그리스 뒤에 낱말 (Ybar Ȳ · ;rhat ρ̂).
     *   소문자 뒤에는 걸지 않는다 — 'that'·'sandbar' 같은 산문이 망가진다. */
    for (var w in MARK) {
      if (before.slice(-w.length) === w && DECORABLE.test(before.slice(0, -w.length))) {
        var base = before.slice(0, -w.length).slice(-1);
        var made = (base + MARK[w]);
        try { made = made.normalize('NFC'); } catch (e) {}   /* Y+̄ → Ȳ 한 글자로 */
        return { n: w.length + 1, put: made };
      }
    }
    /* ③ 아래첨자 · 위첨자 — '_' '^' 로 분명히 찍을 때만 */
    if ((m = /([_^])(.)$/.exec(before))) {
      var tbl = m[1] === '_' ? SUBC : SUPC;
      var c = tbl[m[2]] || tbl[m[2].toLowerCase()];
      if (c) return { n: 2, put: c };
    }
    /* 이어지는 첨자 — 이미 첨자 글자 뒤라면 '_' 없이도 이어 간다 (Y_t-1 → Yₜ₋₁ · e^-rt → e⁻ʳᵗ) */
    var prev = before.slice(-2, -1), cur = before.slice(-1);
    if (!chainOff) {
      if (prev && SUB_SET[prev] && SUBC[cur]) return { n: 1, put: SUBC[cur] };
      if (prev && SUP_SET[prev] && SUPC[cur] && SUPC[cur] !== cur) return { n: 1, put: SUPC[cur] };
    }

    /* ④ 약자 대문자 — 앞뒤에 다른 영문자가 없을 때만.
     *   평문 칸에서는 **세 글자 이상**만 바꾼다. 두 글자(IS·AD·AS…)는 영어 낱말과 겹쳐
     *   'this is a bar' 같은 산문을 망가뜨린다. */
    if (abbr && abbr.length && /^[A-Za-z]$/.test(key) && (m = /([A-Za-z]+)$/.exec(before))) {
      var run = m[1], up = run.toUpperCase();
      if (run.length >= 3 && run !== up && abbr.indexOf(up) >= 0
          && !/[A-Za-z]/.test(before.charAt(before.length - run.length - 1))) {
        return { n: run.length, put: up };
      }
    }
    return null;
  }

  function isWritable(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName;
    if (t === 'TEXTAREA') return true;
    if (t === 'INPUT') return /^(text|search|)$/i.test(el.type || '');
    return !!el.isContentEditable;
  }

  /** 문서 전체의 평문 작성칸에 수식 손버릇을 건다 — 나중에 생기는 칸에도 자동으로 걸린다. */
  function initText(opts) {
    opts = opts || {};
    var abbr = opts.abbr || ABBR[opts.subject || subjectOf()] || [];
    if (document.__miText) { document.__miText.abbr = abbr; return -1; }
    var state = { abbr: abbr, chainOff: false };
    document.__miText = state;

    /* → 로 첨자에서 빠져나온다. 평문 칸의 첨자는 '모드' 가 아니라 글자라서
       화살표로는 커서가 움직일 곳이 없다 → 다음 글자를 첨자로 잇지 않는 것으로 대신한다.
       (스페이스·다른 글자로도 자연히 끊긴다) */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'
          || e.key === 'Home' || e.key === 'End') state.chainOff = true;
    }, true);
    document.addEventListener('mouseup', function () { state.chainOff = true; }, true);

    document.addEventListener('keyup', function (e) {
      if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!e.key || e.key.length !== 1) return;
      var off = state.chainOff;
      state.chainOff = false;                            /* 한 글자에만 듣는다 */
      var el = e.target;
      if (!isWritable(el)) return;
      if (el.closest && el.closest('.mi')) return;        /* 수식칸은 MathLive 가 맡는다 */
      if (el.hasAttribute && el.hasAttribute('data-no-math')) return;
      var c = caretAt(el);
      if (!c) return;
      var rule = textRule(c.before, e.key, state.abbr, off);
      if (rule) c.replace(rule.n, rule.put);
    }, true);
    return 1;
  }

  function grade() {
    var right = 0, items = fields.map(function (f) {
      var answers = (f.host.getAttribute('data-answer') || '').split('|');
      var ok = !!f.mf.value.trim() && answers.some(function (a) { return equivalent(f.mf.value, a); });
      f.host.classList.remove('ok', 'bad'); f.host.classList.add(ok ? 'ok' : 'bad');
      if (ok) right++;
      return { ok: ok, el: f.host, value: f.mf.value };
    });
    return { total: fields.length, right: right, items: items };
  }
  function markCorrect(host) { host.classList.remove('bad'); host.classList.add('ok'); }
  function reveal(on) { document.body.classList.toggle('mi-reveal', !!on); }

  global.MathInput = {
    init: init, grade: grade, equivalent: equivalent, reveal: reveal, markCorrect: markCorrect,
    shortcuts: SHORTCUTS, greekKeys: GREEK_KEYS, buildVars: buildVars, baseKey: baseKey,
    candidatesFor: candidatesFor, fields: function () { return fields; },
    abbr: ABBR, subject: subjectOf, initText: initText
  };
})(window);

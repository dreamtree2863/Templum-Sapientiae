/* graph_editor.js — 경제학 그래프 편집기 (구성요소 조립식)
 *
 *  ‼ 진실의 원본은 SVG 가 아니라 **모델(JSON)** 이다.
 *     모델 ──render()──▶ SVG ──▶ 화면·저장·백과사전 삽입
 *     모델은 내보낸 SVG 의 <metadata id="graph-model"> 안에 함께 실려, 다시 열어 고칠 수 있다.
 *
 *  좌표계 : 그림판 안을 0~100 × 0~100 으로 쓴다(해상도·크기와 무관).
 *           u(가로) → X(u), v(세로) → Y(v) 로 viewBox 좌표로 옮긴다.
 *
 *  집 스타일(기존 AI 생성기와 동일) : 흰 바탕 · 전부 검정 · 음영은 회색/빗금 · 맑은 고딕.
 *
 *  파이썬 슬롯은 기존 것을 그대로 쓴다 —
 *     handle_econ_graph_save({svg,title,format})  ·  handle_econ_graph_insert({svg,title})
 */
(function () {
  'use strict';

  /* ───────────────── 치수·좌표 ───────────────── */
  var W = 520, H = 460;
  /* 그림판 여백 — 에지워스 상자는 네 변 모두에 이름이 붙어 좌우·위를 더 비운다 */
  var PX0, PX1, PY0, PY1;                          // 세로는 뒤집힌다
  function setFrame(fr) {
    var m = (fr === 'edgeworth') ? { l: 72, r: 72, t: 46, b: 52 } : { l: 58, r: 32, t: 30, b: 54 };
    PX0 = m.l; PX1 = W - m.r; PY0 = H - m.b; PY1 = m.t;
  }
  setFrame('q1');
  function X(u) { return PX0 + (PX1 - PX0) * (u / 100); }
  function Y(v) { return PY0 + (PY1 - PY0) * (v / 100); }
  function invX(x) { return (x - PX0) / (PX1 - PX0) * 100; }
  function invY(y) { return (y - PY0) / (PY1 - PY0) * 100; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }

  var FONT = "'Malgun Gothic','맑은 고딕',sans-serif";

  /* ───────────────── 곡선 모양 ─────────────────
   *  모든 곡선은 두 끝점 p,q 로 정해진다. 모양(shape)이 그 사이를 어떻게 잇는지 결정한다.
   */
  var SHAPES = [
    { id: 'curve',  name: '곡선(휨 조절)', hint: '직선·체증·체감이 모두 휨 하나로 이어진다' },
    { id: 'ushape', name: 'U자',          hint: '평균비용·평균가변비용' },
    { id: 'vert',   name: '수직',         hint: '장기총공급·장기필립스' },
    { id: 'horiz',  name: '수평',         hint: '가격선 P=MR·상한선' }
  ];

  /* 예전 이름 → 휨 값. 저장해 둔 그림을 그대로 열 수 있게 남겨 둔다. */
  var LEGACY = { line: 0, convex: -0.6, concave: 0.6, jshape: 0.6 };

  /** 휨 k(-1~1) → 지수. k=0 이면 직선, 클수록 처음이 평평하고 끝이 가파르다. */
  function expOf(k) { return Math.pow(3, clamp(k == null ? 0 : k, -1, 1)); }

  /** 가로 u 에서의 세로값 — 수직선만 함수가 아니라 null 을 준다. */
  function vAt(it, u) {
    var p = it.p, q = it.q;
    if (it.shape === 'vert') return null;
    if (it.shape === 'horiz') return p[1];
    var span = q[0] - p[0];
    var t = clamp(span === 0 ? 0 : (u - p[0]) / span, 0, 1);
    var k = (it.k == null) ? (LEGACY[it.shape] || 0) : it.k;
    if (it.shape === 'ushape') {                      // U자 — 가운데가 내려앉는다(깊이도 휨으로 조절)
      var s = 2 * t - 1;
      var lo = Math.min(p[1], q[1]), hi = Math.max(p[1], q[1]);
      return lo + (hi - lo) * s * s - (1 - s * s) * (18 + 14 * clamp(k, -1, 1));
    }
    return p[1] + (q[1] - p[1]) * Math.pow(t, expOf(k));
  }

  /** 가로 범위 [u0,u1] — 수직선은 한 점. */
  function uRange(it) {
    if (it.shape === 'vert') return [it.p[0], it.p[0]];
    return [Math.min(it.p[0], it.q[0]), Math.max(it.p[0], it.q[0])];
  }

  /** 곡선을 훑어 [u,v] 점들을 돌려준다 — 그리기·라벨 위치에 쓴다. */
  function sample(it, n) {
    var p = it.p, q = it.q, out = [], i, u;
    if (it.shape === 'vert') return [[p[0], p[1]], [p[0], q[1]]];
    if (it.shape === 'horiz') return [[p[0], p[1]], [q[0], p[1]]];
    var kk = (it.k == null) ? (LEGACY[it.shape] || 0) : it.k;
    if (it.shape !== 'ushape' && Math.abs(kk) < 0.001) return [[p[0], p[1]], [q[0], q[1]]];
    // 휨이 셀수록 한쪽 끝이 가팔라 각져 보인다 → 표본을 늘리고 끝을 촘촘히 훑는다
    n = n || Math.round(56 + 90 * Math.abs(kk));
    for (i = 0; i <= n; i++) {
      var t = i / n;
      t = t * t * (3 - 2 * t);                       // 양 끝을 촘촘하게
      u = p[0] + (q[0] - p[0]) * t;
      out.push([u, vAt(it, u)]);
    }
    return out;
  }

  function pathOf(it) {
    var pts = sample(it), d = '', i;
    for (i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + r1(X(pts[i][0])) + ' ' + r1(Y(pts[i][1]));
    return d;
  }

  /** 두 곡선의 교점 — 세로 차이의 부호가 바뀌는 곳을 찾아 사이를 갈라 들어간다. */
  function crossing(a, b) {
    if (a.shape === 'vert' && b.shape === 'vert') return null;
    if (a.shape === 'vert' || b.shape === 'vert') {         // 수직선은 가로가 정해져 있다
      var ln = a.shape === 'vert' ? a : b, other = a.shape === 'vert' ? b : a;
      var u0 = ln.p[0], rg = uRange(other);
      if (u0 < rg[0] - 1 || u0 > rg[1] + 1) return null;
      var vv = vAt(other, clamp(u0, rg[0], rg[1]));
      var lo = Math.min(ln.p[1], ln.q[1]), hi = Math.max(ln.p[1], ln.q[1]);
      return (vv >= lo - 2 && vv <= hi + 2) ? [u0, vv] : null;
    }
    var ra = uRange(a), rb = uRange(b);
    var s = Math.max(ra[0], rb[0]), e = Math.min(ra[1], rb[1]);
    if (e - s < 0.5) return null;
    var N = 400, prev = null, i, u, d;
    for (i = 0; i <= N; i++) {
      u = s + (e - s) * (i / N);
      d = vAt(a, u) - vAt(b, u);
      if (prev !== null && ((prev.d <= 0 && d >= 0) || (prev.d >= 0 && d <= 0))) {
        var lo2 = prev.u, hi2 = u, j, mid, dm;
        for (j = 0; j < 40; j++) {                          // 이분법으로 좁힌다
          mid = (lo2 + hi2) / 2;
          dm = vAt(a, mid) - vAt(b, mid);
          if ((prev.d <= 0 && dm <= 0) || (prev.d >= 0 && dm >= 0)) lo2 = mid; else hi2 = mid;
        }
        mid = (lo2 + hi2) / 2;
        return [mid, vAt(a, mid)];
      }
      prev = { u: u, d: d };
    }
    return null;
  }

  /** U자 곡선의 최저점 [u,v] */
  function lowest(it) {
    var rg = uRange(it), best = null, i, u, v;
    for (i = 0; i <= 200; i++) {
      u = rg[0] + (rg[1] - rg[0]) * (i / 200);
      v = vAt(it, u);
      if (v === null) continue;
      if (!best || v < best[1]) best = [u, v];
    }
    return best;
  }

  /** mc 의 시작 높이를 조정해 ac 의 최저점을 지나게 한다 (MC 는 AC 최저점을 통과한다). */
  function throughLowest(mc, ac) {
    var lo = lowest(ac);
    if (!lo) return;
    var t = (lo[0] - mc.p[0]) / (mc.q[0] - mc.p[0]);
    var w = Math.pow(clamp(t, 0, 1), expOf(mc.k));
    if (w >= 0.999) return;
    mc.p[1] = r1((lo[1] - mc.q[1] * w) / (1 - w));
  }

  /* ───────────────── 모델 ───────────────── */
  var seq = 0;
  function nid(pre) { return pre + (++seq); }

  /* ───────────────── 좌표평면 종류 ─────────────────
   *  곡선·점은 언제나 0~100 상자 안의 좌표다. 평면 종류는 **축을 어디에 긋는지**만 바꾼다.
   */
  var FRAMES = [
    { id: 'q1',        name: '1사분면 (기본)',   hint: '수요·공급, IS-LM 등 대부분' },
    { id: 'yneg',      name: '세로축 음수까지',   hint: '순수출·이윤/손실처럼 0 아래가 있는 경우' },
    { id: 'mirror',    name: '좌우 맞보기',      hint: '세로축을 가운데 두고 좌·우에 다른 가로축' },
    { id: 'cross',     name: '4분면 (십자)',     hint: '위·아래·왼·오른쪽 축에 각각 다른 변수' },
    { id: 'edgeworth', name: '에지워스 상자',    hint: '두 원점 O_A(왼아래)·O_B(오른위)' }
  ];

  /** 그 평면에서 세로축이 선 가로위치(ax)와 가로축이 놓인 세로위치(ay). */
  function axisAt(model) {
    var f = (model.axes && model.axes.frame) || 'q1';
    if (f === 'yneg') return { ax: 0, ay: 50, f: f };
    if (f === 'mirror') return { ax: 50, ay: 0, f: f };
    if (f === 'cross') return { ax: 50, ay: 50, f: f };
    return { ax: 0, ay: 0, f: f };
  }

  function blank() {
    return {
      v: 1, size: [W, H],
      axes: { frame: 'q1', x: 'Q', y: 'P', origin: 'O', x2: '', y2: '', origin2: '' },
      items: []
    };
  }

  /* ───────────────── 렌더 ───────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 점 이름을 점의 어느 쪽에 놓을지 — 곡선·보조선과 겹치는 자리를 피해 고른다 */
  var LABEL_POS = {
    up:    { dx: 0,   dy: -14, anchor: 'middle', name: '위' },
    down:  { dx: 0,   dy: 16,  anchor: 'middle', name: '아래' },
    left:  { dx: -11, dy: 0,   anchor: 'end',    name: '왼쪽' },
    right: { dx: 11,  dy: 0,   anchor: 'start',  name: '오른쪽' }
  };

  /* 변수 이름만 이탤릭 — 한글이 섞이면 눕히지 않는다(읽기 나빠진다) */
  function romanOnly(s) { return /^[A-Za-z0-9*'’_^{}Ͱ-Ͽ+\-()]+$/.test(String(s || '')); }

  /** O_A · Q_1 · P^e 처럼 _ ^ 로 쓴 첨자를 실제 첨자로 내려/올려 준다. */
  function withScripts(str, size) {
    var txt = String(str == null ? '' : str), out = '', i = 0, m;
    while (i < txt.length) {
      m = /^([_^])(\{[^}]*\}|.)/.exec(txt.slice(i));
      if (m) {
        var body = m[2].charAt(0) === '{' ? m[2].slice(1, -1) : m[2];
        out += '<tspan font-size="' + r1(size * 0.72) + '" dy="'
          + (m[1] === '_' ? r1(size * 0.22) : r1(-size * 0.34)) + '">' + esc(body) + '</tspan>'
          + '<tspan font-size="' + size + '" dy="'
          + (m[1] === '_' ? r1(-size * 0.22) : r1(size * 0.34)) + '"></tspan>';
        i += m[0].length;
      } else { out += esc(txt.charAt(i)); i++; }
    }
    return out;
  }

  function textEl(x, y, s, opt) {
    opt = opt || {};
    var size = opt.size || 14;
    var ital = opt.italic && romanOnly(s);
    return '<text x="' + r1(x) + '" y="' + r1(y) + '" font-family="' + FONT + '"'
      + ' font-size="' + size + '"'
      + ' text-anchor="' + (opt.anchor || 'middle') + '"'
      + ' dominant-baseline="' + (opt.base || 'middle') + '"'
      + (ital ? ' font-style="italic"' : '')
      + ' fill="#000000">' + withScripts(s, size) + '</text>';
  }

  /** 곡선 끝에 붙일 라벨 자리 — 마지막 두 점의 방향으로 조금 밀어 낸다. */
  function endLabelPos(it) {
    var pts = sample(it), n = pts.length, a = pts[n - 2] || pts[0], b = pts[n - 1];
    var dx = X(b[0]) - X(a[0]), dy = Y(b[1]) - Y(a[1]);
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    return [X(b[0]) + dx / len * 15, Y(b[1]) + dy / len * 15];
  }

  function render(model, opt) {
    opt = opt || {};
    var live = !!opt.live;                 // 편집 화면용(끌기 손잡이 포함)
    setFrame((model.axes && model.axes.frame) || 'q1');
    var s = [];
    s.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '"'
      + (live ? ' id="ge-svg" style="width:100%;height:auto;touch-action:none"' : ' width="' + W + '" height="' + H + '"')
      + '>');
    if (!live) {
      s.push('<metadata id="graph-model">' + esc(JSON.stringify(model)) + '</metadata>');
    }
    s.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>');
    s.push('<defs><marker id="ga" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"'
      + ' orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#000000"/></marker>'
      + '<pattern id="gh" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
      + '<line x1="0" y1="0" x2="0" y2="7" stroke="#000000" stroke-width="1"/></pattern></defs>');

    /* 축 — 평면 종류에 따라 놓이는 자리가 다르다 */
    var A = model.axes, fr = axisAt(model).f;
    function axline(x1, y1, x2, y2, both) {
      s.push('<line x1="' + r1(x1) + '" y1="' + r1(y1) + '" x2="' + r1(x2) + '" y2="' + r1(y2)
        + '" stroke="#000000" stroke-width="1.6" marker-end="url(#ga)"'
        + (both ? ' marker-start="url(#ga)"' : '') + '/>');
    }
    if (fr === 'edgeworth') {
      s.push('<rect x="' + PX0 + '" y="' + PY1 + '" width="' + (PX1 - PX0) + '" height="' + (PY0 - PY1)
        + '" fill="none" stroke="#000000" stroke-width="1.6"/>');
      if (A.x) s.push(textEl((PX0 + PX1) / 2, PY0 + 20, A.x, { italic: true }));
      if (A.y) s.push(textEl(PX0 - 30, (PY0 + PY1) / 2, A.y, { italic: true }));
      if (A.x2) s.push(textEl((PX0 + PX1) / 2, PY1 - 18, A.x2, { italic: true }));
      if (A.y2) s.push(textEl(PX1 + 30, (PY0 + PY1) / 2, A.y2, { italic: true }));
      if (A.origin) s.push(textEl(PX0 - 15, PY0 + 15, A.origin, { size: 13 }));
      if (A.origin2) s.push(textEl(PX1 + 15, PY1 - 13, A.origin2, { size: 13 }));
    } else if (fr === 'cross') {
      axline(PX0 - 14, Y(50), PX1 + 14, Y(50), true);             // 가로축 — 좌우로
      axline(X(50), PY0 + 14, X(50), PY1 - 14, true);             // 세로축 — 위아래로
      if (A.x) s.push(textEl(PX1 + 18, Y(50) + 20, A.x, { anchor: 'end', italic: true }));
      if (A.x2) s.push(textEl(PX0 - 18, Y(50) + 20, A.x2, { anchor: 'start', italic: true }));
      if (A.y) s.push(textEl(X(50) + 15, PY1 - 12, A.y, { anchor: 'start', italic: true }));
      if (A.y2) s.push(textEl(X(50) + 15, PY0 + 22, A.y2, { anchor: 'start', italic: true }));
      if (A.origin) s.push(textEl(X(50) - 12, Y(50) + 14, A.origin, { size: 13 }));
    } else if (fr === 'mirror') {
      axline(PX0 - 14, PY0, PX1 + 14, PY0, true);                 // 가로축 — 양쪽으로
      axline(X(50), PY0, X(50), PY1 - 14);                        // 세로축 — 가운데
      if (A.x) s.push(textEl(PX1 + 18, PY0 + 20, A.x, { anchor: 'end', italic: true }));
      if (A.x2) s.push(textEl(PX0 - 18, PY0 + 20, A.x2, { anchor: 'start', italic: true }));
      if (A.y) s.push(textEl(X(50) + 15, PY1 - 12, A.y, { anchor: 'start', italic: true }));
      if (A.origin) s.push(textEl(X(50) - 13, PY0 + 15, A.origin, { size: 13 }));
    } else if (fr === 'yneg') {
      axline(PX0, Y(50), PX1 + 14, Y(50));                        // 가로축 — 0 선
      axline(PX0, PY0, PX0, PY1 - 14);                            // 세로축 — 아래까지
      if (A.x) s.push(textEl(PX1 + 18, Y(50) + 20, A.x, { anchor: 'end', italic: true }));
      if (A.y) s.push(textEl(PX0 - 16, PY1 - 18, A.y, { anchor: 'start', italic: true }));
      if (A.origin) s.push(textEl(PX0 - 13, Y(50) + 14, A.origin, { size: 13 }));
    } else {
      axline(PX0, PY0, PX1 + 14, PY0);
      axline(PX0, PY0, PX0, PY1 - 14);
      if (A.x) s.push(textEl(PX1 + 18, PY0 + 20, A.x, { anchor: 'end', italic: true }));
      if (A.y) s.push(textEl(PX0 - 16, PY1 - 18, A.y, { anchor: 'start', italic: true }));
      if (A.origin) s.push(textEl(PX0 - 13, PY0 + 14, A.origin, { size: 13 }));
    }

    /* 영역(뒤에 깔린다) */
    model.items.forEach(function (it) {
      if (it.type !== 'area') return;
      var a = model.items.filter(function (x) { return x.id === it.a; })[0];
      var b = model.items.filter(function (x) { return x.id === it.b; })[0];
      if (!a || !b) return;
      var pa = sample(a), pb = sample(b).slice().reverse(), d = '', i;
      for (i = 0; i < pa.length; i++) d += (i ? 'L' : 'M') + r1(X(pa[i][0])) + ' ' + r1(Y(pa[i][1]));
      for (i = 0; i < pb.length; i++) d += 'L' + r1(X(pb[i][0])) + ' ' + r1(Y(pb[i][1]));
      s.push('<path d="' + d + 'Z" fill="' + (it.fill === 'hatch' ? 'url(#gh)' : '#dddddd')
        + '" fill-opacity="' + (it.fill === 'hatch' ? '1' : '0.85') + '" stroke="none"'
        + (live ? ' data-id="' + it.id + '" style="cursor:move"' : '') + '/>');
    });

    /* 점의 좌표를 축에 표시 — 점선 + 눈금 + 값 (곡선보다 아래에 깔린다) */
    var AX = axisAt(model), axx = X(AX.ax), axy = Y(AX.ay);
    model.items.forEach(function (it) {
      if (it.type !== 'point') return;
      var x = X(it.at[0]), y = Y(it.at[1]);
      if (it.guides) {
        s.push('<line x1="' + r1(axx) + '" y1="' + r1(y) + '" x2="' + r1(x) + '" y2="' + r1(y)
          + '" stroke="#000000" stroke-width="1" stroke-dasharray="4 3"/>');
        s.push('<line x1="' + r1(x) + '" y1="' + r1(y) + '" x2="' + r1(x) + '" y2="' + r1(axy)
          + '" stroke="#000000" stroke-width="1" stroke-dasharray="4 3"/>');
      }
      if (it.ylab) {
        s.push('<line x1="' + r1(axx - 4) + '" y1="' + r1(y) + '" x2="' + r1(axx + 4) + '" y2="' + r1(y)
          + '" stroke="#000000" stroke-width="1.4"/>');
        s.push(textEl(axx - 10, y, it.ylab, { anchor: 'end', size: 13, italic: true }));
      }
      if (it.xlab) {
        s.push('<line x1="' + r1(x) + '" y1="' + r1(axy - 4) + '" x2="' + r1(x) + '" y2="' + r1(axy + 4)
          + '" stroke="#000000" stroke-width="1.4"/>');
        s.push(textEl(x, axy + 17, it.xlab, { size: 13, italic: true }));
      }
    });

    /* 곡선 */
    model.items.forEach(function (it) {
      if (it.type !== 'curve') return;
      s.push('<path d="' + pathOf(it) + '" fill="none" stroke="#000000" stroke-width="'
        + (it.width || 1.8) + '"' + (it.dash ? ' stroke-dasharray="6 4"' : '')
        + (live ? ' data-id="' + it.id + '" style="cursor:move"' : '') + '/>');
      if (live) {   // 잡기 쉽도록 투명한 굵은 선을 겹쳐 둔다
        s.push('<path d="' + pathOf(it) + '" fill="none" stroke="transparent" stroke-width="14"'
          + ' data-id="' + it.id + '" style="cursor:move"/>');
      }
      if (it.label) {
        var lp = endLabelPos(it);
        s.push(textEl(lp[0], lp[1], it.label, { size: 15, italic: true }));
      }
    });

    /* 화살표 */
    model.items.forEach(function (it) {
      if (it.type !== 'arrow') return;
      s.push('<line x1="' + r1(X(it.p[0])) + '" y1="' + r1(Y(it.p[1])) + '" x2="' + r1(X(it.q[0]))
        + '" y2="' + r1(Y(it.q[1])) + '" stroke="#000000" stroke-width="1.6" marker-end="url(#ga)"'
        + (it.dash ? ' stroke-dasharray="6 4"' : '')
        + (live ? ' data-id="' + it.id + '" style="cursor:move"' : '') + '/>');
      if (live) s.push('<line x1="' + r1(X(it.p[0])) + '" y1="' + r1(Y(it.p[1])) + '" x2="'
        + r1(X(it.q[0])) + '" y2="' + r1(Y(it.q[1])) + '" stroke="transparent" stroke-width="14"'
        + ' data-id="' + it.id + '" style="cursor:move"/>');
    });

    /* 점 */
    model.items.forEach(function (it) {
      if (it.type !== 'point') return;
      var x = X(it.at[0]), y = Y(it.at[1]);
      s.push('<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="3.6" fill="#000000"'
        + (live ? ' data-id="' + it.id + '" style="cursor:move"' : '') + '/>');
      if (live) s.push('<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="11" fill="transparent"'
        + ' data-id="' + it.id + '" style="cursor:move"/>');
      if (it.label) {
        var lp = LABEL_POS[it.lp] || LABEL_POS.up;
        s.push(textEl(x + lp.dx, y + lp.dy, it.label, { size: 14, italic: true, anchor: lp.anchor }));
      }
    });

    /* 자유 글자 */
    model.items.forEach(function (it) {
      if (it.type !== 'text') return;
      var x = X(it.at[0]), y = Y(it.at[1]);
      s.push(textEl(x, y, it.text, { size: it.size || 14, anchor: it.anchor || 'middle' }));
      if (live) s.push('<rect x="' + r1(x - 26) + '" y="' + r1(y - 11) + '" width="52" height="22"'
        + ' fill="transparent" data-id="' + it.id + '" style="cursor:move"/>');
    });

    /* 선택 손잡이 */
    if (live && opt.sel) {
      var it = model.items.filter(function (x) { return x.id === opt.sel; })[0];
      if (it) {
        handlesOf(it).forEach(function (h) {
          s.push('<rect x="' + r1(X(h.u) - 5) + '" y="' + r1(Y(h.v) - 5) + '" width="10" height="10"'
            + ' fill="#ffffff" stroke="#9a6a30" stroke-width="1.8" data-handle="' + h.k
            + '" data-id="' + it.id + '" style="cursor:pointer"/>');
        });
      }
    }
    s.push('</svg>');
    return s.join('');
  }

  function handlesOf(it) {
    if (it.type === 'curve' || it.type === 'arrow') {
      return [{ k: 'p', u: it.p[0], v: it.p[1] }, { k: 'q', u: it.q[0], v: it.q[1] }];
    }
    if (it.type === 'point' || it.type === 'text') return [{ k: 'at', u: it.at[0], v: it.at[1] }];
    return [];
  }

  /* ───────────────── 모양새 ─────────────────
   *  ‼ 편집기 CSS 의 단일 출처. 프로그램 화면과 학습지 문서 양쪽에 같은 것을 심는다.
   */
  var STYLE = ''
    + '.ge-wrap{display:grid;grid-template-columns:210px minmax(0,1fr) 232px;gap:14px;align-items:start;margin-top:14px}'
    + '@media (max-width:1100px){.ge-wrap{grid-template-columns:1fr}}'
    + '.ge-side{border:1px solid #e0e1dd;border-radius:8px;background:#fbfbf9;padding:10px 11px 13px}'
    + '.ge-sec{font-size:11.5px;font-weight:bold;color:#8a8778;letter-spacing:.4px;margin:12px 0 6px}'
    + '.ge-side>.ge-sec:first-child{margin-top:2px}'
    + '.ge-note{font-weight:normal;color:#b3afa0;letter-spacing:0}'
    + '.ge-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}'
    + '.ge-grid4{grid-template-columns:repeat(4,1fr)}'
    + '.ge-btn{background:#fff;border:1px solid #e0e1dd;border-radius:6px;padding:7px 6px;font-size:12px;'
    + 'color:#414833;cursor:pointer;transition:all .12s;font-family:inherit}'
    + '.ge-btn:hover{border-color:#c19a6b;color:#a9793f;background:#fffdf9}'
    + '.ge-btn small{display:block;font-size:10px;color:#a8a496;margin-top:1px}'
    + '.ge-canvas{border:1px solid #e0e1dd;border-radius:8px;background:#fff;padding:10px;min-height:320px;user-select:none}'
    + '.ge-canvas svg{display:block;width:100%;height:auto}'
    + '.ge-empty{color:#aaa;font-size:12.5px;line-height:1.6;padding:4px 0 8px}'
    + '.ge-khint{font-size:11px;color:#8a8778;margin:-3px 0 8px 82px}'
    + '.ge-prop-head{font-size:13px;font-weight:bold;color:#414833;margin:2px 0 8px}'
    + '.ge-prop{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:12px;color:#6b6a5e}'
    + '.ge-prop>span{flex:0 0 74px}'
    + '.ge-prop input[type="text"],.ge-prop input:not([type]),.ge-prop select{flex:1;min-width:0;padding:5px 7px;'
    + 'border:1px solid #e0e1dd;border-radius:5px;font-size:12.5px;background:#fff;font-family:inherit}'
    + '.ge-prop input[type="checkbox"]{width:15px;height:15px}'
    + '.ge-prop input[type="range"]{flex:1;min-width:0;accent-color:#9a6a30}'
    + '.ge-prop-btns{display:flex;gap:6px;margin-top:10px}'
    + '.ge-lp{display:flex;gap:4px;flex:1}'
    + '.ge-lp .ge-mini{padding:3px 0;font-size:12px}'
    + '.ge-mini{flex:1;background:#fff;border:1px solid #e0e1dd;border-radius:5px;padding:5px 4px;'
    + 'font-size:11.5px;color:#414833;cursor:pointer;font-family:inherit}'
    + '.ge-mini:hover{border-color:#c19a6b;color:#a9793f}'
    + '.ge-mini.danger:hover{border-color:#c0392b;color:#c0392b}'
    + '.ge-mini.on{border-color:#9a6a30;background:#fdf7ee;color:#8a5a20;font-weight:bold}'
    + '.ge-row{display:block;width:100%;text-align:left;background:#fff;border:1px solid #e0e1dd;border-radius:5px;'
    + 'padding:6px 9px;margin-bottom:5px;font-size:12.5px;color:#414833;cursor:pointer;font-family:inherit}'
    + '.ge-row:hover{border-color:#c19a6b}'
    + '.ge-row.on{border-color:#9a6a30;background:#fdf7ee;font-weight:bold}'
    /* 학습지 안 대화상자 */
    + '.ge-dlg{position:fixed;inset:0;z-index:9999;background:rgba(40,36,28,.45);display:flex;'
    + 'align-items:center;justify-content:center;padding:18px;font-family:"Malgun Gothic","맑은 고딕",sans-serif}'
    + '.ge-dlg-box{background:#faf7f0;border-radius:10px;box-shadow:0 18px 50px rgba(30,24,10,.35);'
    + 'padding:14px 16px 16px;width:min(1080px,96vw);max-height:94vh;overflow:auto}'
    + '.ge-dlg-head{display:flex;align-items:center;gap:10px;font-size:14px;color:#414833}'
    + '.ge-dlg-label{color:#8a8778;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ge-dlg-btns{display:flex;gap:6px;flex:0 0 auto}'
    + '.ge-dlg-btns .ge-mini{flex:0 0 auto;padding:6px 14px;font-size:12.5px}'
    + '.ge-mini.ge-ok{border-color:#2f6b48;color:#2f6b48;font-weight:bold}'
    + '.ge-mini.ge-ok:hover{background:#e9f4ec}'
    + '.ge-dlg .ge-wrap{margin-top:10px}'
    + '.ge-msg{font-size:12px;color:#6b6a5e;margin-top:8px;min-height:1em}'
    /* 작도칸에 붙는 단추와 결과 */
    + '.ge-boxbar{display:flex;gap:6px;margin:6px 0 4px}'
    + '.ge-boxbar .ge-mini{flex:0 0 auto;padding:5px 12px}'
    + '.ge-out{margin:2px 0 6px}'
    + '.ge-out svg{display:block;max-width:min(430px,100%);height:auto;margin:0 auto}';

  function injectStyle() {
    if (document.getElementById('ge-style')) return;
    var st = document.createElement('style');
    st.id = 'ge-style';
    st.textContent = STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ───────────────── 편집기 ───────────────── */
  var model = blank(), sel = null, undoStack = [], redoStack = [];
  var host, svgBox, propBox, listBox, msgBox;

  /* 한 번에 한 곳에서만 편집한다 — 프로그램 화면이든 학습지 안 대화상자든 */
  function $(id) { return (host || document).querySelector('#' + id); }
  function snap() { undoStack.push(JSON.stringify(model)); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(model)); model = JSON.parse(undoStack.pop()); sel = null; draw(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(model)); model = JSON.parse(redoStack.pop()); sel = null; draw(); }
  function selected() { return model.items.filter(function (x) { return x.id === sel; })[0] || null; }
  function msg(t, ok) {
    if (!msgBox) return;
    msgBox.style.color = ok === false ? '#c0392b' : (ok ? '#27ae60' : '#555');
    msgBox.textContent = t || '';
  }

  function draw() {
    if (!svgBox) return;
    svgBox.innerHTML = render(model, { live: true, sel: sel });
    drawProps();
    drawList();
  }

  /* 항목 목록 */
  function nameOf(it) {
    if (it.type === 'curve') return '곡선 ' + (it.label || '(이름 없음)');
    if (it.type === 'point') return '점 ' + (it.label || '');
    if (it.type === 'arrow') return '이동 화살표';
    if (it.type === 'area') return '영역 ' + (it.label || '');
    return '글자 ' + (it.text || '');
  }
  function drawList() {
    if (!listBox) return;
    if (!model.items.length) { listBox.innerHTML = '<div class="ge-empty">아직 아무것도 없습니다. 왼쪽에서 골라 놓으세요.</div>'; return; }
    listBox.innerHTML = model.items.map(function (it) {
      return '<button type="button" class="ge-row' + (it.id === sel ? ' on' : '') + '" data-pick="' + it.id + '">'
        + esc(nameOf(it)) + '</button>';
    }).join('');
  }

  /* 속성 패널 */
  function row(label, html) {
    return '<label class="ge-prop"><span>' + label + '</span>' + html + '</label>';
  }
  function drawProps() {
    if (!propBox) return;
    var it = selected();
    if (!it) {
      var fr = model.axes.frame || 'q1';
      var h0 = '<div class="ge-empty">항목을 고르면 여기서 이름·모양을 고칠 수 있습니다.</div>'
        + row('평면', '<select id="ge-frame">' + FRAMES.map(function (f) {
          return '<option value="' + f.id + '"' + (f.id === fr ? ' selected' : '') + '>' + f.name + '</option>';
        }).join('') + '</select>')
        + '<div class="ge-khint">' + esc((FRAMES.filter(function (f) { return f.id === fr; })[0] || {}).hint || '') + '</div>';
      if (fr === 'edgeworth') {
        h0 += row('아래 가로축', '<input id="ge-ax" value="' + esc(model.axes.x) + '">')
          + row('왼쪽 세로축', '<input id="ge-ay" value="' + esc(model.axes.y) + '">')
          + row('위 가로축', '<input id="ge-ax2" value="' + esc(model.axes.x2 || '') + '">')
          + row('오른쪽 세로축', '<input id="ge-ay2" value="' + esc(model.axes.y2 || '') + '">')
          + row('왼아래 원점', '<input id="ge-ao" value="' + esc(model.axes.origin) + '">')
          + row('오른위 원점', '<input id="ge-ao2" value="' + esc(model.axes.origin2 || '') + '">');
      } else if (fr === 'cross') {
        h0 += row('오른쪽 축', '<input id="ge-ax" value="' + esc(model.axes.x) + '">')
          + row('왼쪽 축', '<input id="ge-ax2" value="' + esc(model.axes.x2 || '') + '">')
          + row('위쪽 축', '<input id="ge-ay" value="' + esc(model.axes.y) + '">')
          + row('아래쪽 축', '<input id="ge-ay2" value="' + esc(model.axes.y2 || '') + '">')
          + row('원점 표시', '<input id="ge-ao" value="' + esc(model.axes.origin) + '">');
      } else if (fr === 'mirror') {
        h0 += row('오른쪽 가로축', '<input id="ge-ax" value="' + esc(model.axes.x) + '">')
          + row('왼쪽 가로축', '<input id="ge-ax2" value="' + esc(model.axes.x2 || '') + '">')
          + row('세로축 이름', '<input id="ge-ay" value="' + esc(model.axes.y) + '">')
          + row('원점 표시', '<input id="ge-ao" value="' + esc(model.axes.origin) + '">');
      } else {
        h0 += row('가로축 이름', '<input id="ge-ax" value="' + esc(model.axes.x) + '">')
          + row('세로축 이름', '<input id="ge-ay" value="' + esc(model.axes.y) + '">')
          + row('원점 표시', '<input id="ge-ao" value="' + esc(model.axes.origin) + '">');
      }
      propBox.innerHTML = h0;
      return;
    }
    var h = '<div class="ge-prop-head">' + esc(nameOf(it)) + '</div>';
    if (it.type === 'curve') {
      var shape = SHAPES.some(function (s2) { return s2.id === it.shape; }) ? it.shape : 'curve';
      var kk = (it.k == null) ? (LEGACY[it.shape] || 0) : it.k;
      h += row('이름(곡선 끝)', '<input id="ge-label" value="' + esc(it.label || '') + '">');
      h += row('모양', '<select id="ge-shape">' + SHAPES.map(function (sh) {
        return '<option value="' + sh.id + '"' + (sh.id === shape ? ' selected' : '') + '>' + sh.name + '</option>';
      }).join('') + '</select>');
      if (shape !== 'vert' && shape !== 'horiz') {
        h += row(shape === 'ushape' ? '깊이' : '휨',
          '<input type="range" id="ge-k" min="-100" max="100" step="2" value="' + Math.round(kk * 100) + '">');
        if (shape !== 'ushape') {
          h += '<div class="ge-khint">' + (kk > 0.03 ? '체증 — 갈수록 가팔라짐'
            : (kk < -0.03 ? '체감 — 갈수록 완만해짐' : '직선')) + '</div>';
        }
      }
    } else if (it.type === 'point') {
      h += row('이름', '<input id="ge-label" value="' + esc(it.label || '') + '">');
      h += '<div class="ge-prop"><span>이름 자리</span><span class="ge-lp">'
        + ['up', 'left', 'right', 'down'].map(function (k) {
          return '<button type="button" class="ge-mini' + ((it.lp || 'up') === k ? ' on' : '')
            + '" data-lp="' + k + '" title="' + LABEL_POS[k].name + '">'
            + { up: '↑', down: '↓', left: '←', right: '→' }[k] + '</button>';
        }).join('') + '</span></div>';
      h += row('축까지 점선', '<input type="checkbox" id="ge-guides"' + (it.guides ? ' checked' : '') + '>');
      h += row('가로축 값', '<input id="ge-xlab" value="' + esc(it.xlab || '') + '">');
      h += row('세로축 값', '<input id="ge-ylab" value="' + esc(it.ylab || '') + '">');
      h += '<div class="ge-prop-btns"><button type="button" class="ge-mini" data-act="axauto">축 값 자동 채우기</button></div>';
    } else if (it.type === 'text') {
      h += row('글자', '<input id="ge-text" value="' + esc(it.text || '') + '">');
    } else if (it.type === 'area') {
      h += row('채움', '<select id="ge-fill"><option value="gray"' + (it.fill !== 'hatch' ? ' selected' : '')
        + '>회색</option><option value="hatch"' + (it.fill === 'hatch' ? ' selected' : '') + '>빗금</option></select>');
    }
    if (it.type === 'curve' || it.type === 'arrow') {
      h += '<div class="ge-prop-btns"><button type="button" class="ge-mini'
        + (it.dash ? ' on' : '') + '" data-act="dash">'
        + (it.dash ? '⌁ 점선 (누르면 실선)' : '━ 실선 (누르면 점선)') + '</button></div>';
    }
    h += '<div class="ge-prop-btns">'
      + '<button type="button" class="ge-mini" data-act="dup">복제</button>'
      + '<button type="button" class="ge-mini" data-act="front">맨 앞으로</button>'
      + '<button type="button" class="ge-mini danger" data-act="del">삭제</button></div>';
    propBox.innerHTML = h;
  }

  /* 추가 */
  function addCurve(shape, dir, k) {
    snap();
    var p, q;
    if (shape === 'vert') { p = [50, 6]; q = [50, 92]; }
    else if (shape === 'horiz') { p = [6, 50]; q = [92, 50]; }
    else if (shape === 'ushape') { p = [14, 78]; q = [90, 72]; }
    else if (dir === 'up') { p = [12, 14]; q = [88, 86]; }
    else { p = [12, 86]; q = [88, 14]; }
    var it = { id: nid('c'), type: 'curve', shape: shape, k: k || 0, p: p, q: q, label: '', dash: false };
    model.items.push(it); sel = it.id; draw();
  }

  var SUB = ['₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
  /** 이 점의 축 값 이름을 짓는다 — 첫 점은 Q*·P*, 다음부터 Q₁·P₁ … */
  function axisNames(skipId) {
    var used = model.items.filter(function (x) {
      return x.type === 'point' && x.id !== skipId && (x.xlab || x.ylab);
    }).length;
    var sfx = used === 0 ? '*' : (SUB[used - 1] || String(used));
    return [(model.axes.x || 'X') + sfx, (model.axes.y || 'Y') + sfx];
  }

  function addPoint(at) {
    snap();
    var nm = axisNames(null);
    var it = {
      id: nid('p'), type: 'point', at: at || [50, 50], label: 'E', guides: true,
      xlab: nm[0], ylab: nm[1]
    };
    model.items.push(it); sel = it.id; draw();
  }
  function addArrow() {
    snap();
    var it = { id: nid('a'), type: 'arrow', p: [40, 60], q: [58, 60] };
    model.items.push(it); sel = it.id; draw();
  }
  function addText() {
    snap();
    var it = { id: nid('t'), type: 'text', at: [50, 96], text: '설명', anchor: 'middle' };
    model.items.push(it); sel = it.id; draw();
  }

  /** 곡선이 실제로 차지하는 범위 — U자는 가운데가 아래로 처지므로 그만큼 더 본다. */
  function extent(it) {
    var u0 = Math.min(it.p[0], it.q[0]), u1 = Math.max(it.p[0], it.q[0]);
    var v0 = Math.min(it.p[1], it.q[1]), v1 = Math.max(it.p[1], it.q[1]);
    if (it.shape === 'ushape') v0 -= (18 + 14 * clamp(it.k || 0, -1, 1));
    return [u0, u1, v0, v1];
  }

  /** 곡선을 통째로 옆으로 옮긴 사본 + 이동 화살표 — 경제학 도해에서 가장 자주 하는 일.
   *  ‼ 두 끝점을 각각 자르면 기울기가 바뀌어 평행이 깨진다 → 이동량 자체를 한 번만 줄인다. */
  function shiftCopy(dir) {
    var it = selected();
    if (!it || it.type !== 'curve') { msg('먼저 옮길 곡선을 고르세요.', false); return; }
    var want = { right: [11, 0], left: [-11, 0], up: [0, 11], down: [0, -11] }[dir];
    var ex = extent(it);
    var dx = clamp(want[0], 0 - ex[0], 100 - ex[1]);
    var dy = clamp(want[1], 0 - ex[2], 100 - ex[3]);
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
      msg('그 방향으로는 자리가 없습니다 — 원래 곡선을 조금 줄이거나 반대쪽으로 옮기세요.', false);
      return;
    }
    snap();
    var cp = JSON.parse(JSON.stringify(it));
    cp.id = nid('c');
    cp.p = [r1(it.p[0] + dx), r1(it.p[1] + dy)];      // 같은 양만큼 → 평행
    cp.q = [r1(it.q[0] + dx), r1(it.q[1] + dy)];
    cp.label = (it.label || '') ? it.label + "'" : '';
    model.items.push(cp);
    var mid = [(ex[0] + ex[1]) / 2, 0];
    mid[1] = it.shape === 'vert' ? (it.p[1] + it.q[1]) / 2 : vAt(it, mid[0]);
    model.items.push({
      id: nid('a'), type: 'arrow',
      p: [r1(mid[0]), r1(mid[1])],
      q: [r1(mid[0] + dx), r1(mid[1] + dy)]
    });
    sel = cp.id; draw();
    msg(Math.abs(dx || dy) < Math.abs(want[0] || want[1])
      ? '가장자리에 닿아 이동 폭을 줄였습니다 — 평행은 유지됩니다.'
      : '곡선을 평행하게 복제하고 이동 화살표를 붙였습니다.', true);
  }

  /** 고른 곡선 두 개의 교점에 점을 놓는다. */
  function addCrossing() {
    var cs = model.items.filter(function (x) { return x.type === 'curve'; });
    if (cs.length < 2) { msg('곡선이 두 개 이상이어야 교점을 찾습니다.', false); return; }
    var it = selected();
    var a = (it && it.type === 'curve') ? it : cs[cs.length - 2];
    var b = cs.filter(function (x) { return x.id !== a.id; }).pop();
    var at = crossing(a, b);
    if (!at) { msg('두 곡선이 만나지 않습니다.', false); return; }
    addPoint([r1(at[0]), r1(at[1])]);
    msg('교점에 점을 놓았습니다.', true);
  }

  function addArea() {
    var cs = model.items.filter(function (x) { return x.type === 'curve'; });
    if (cs.length < 2) { msg('영역은 곡선 두 개 사이에 칠합니다.', false); return; }
    snap();
    var it = { id: nid('r'), type: 'area', a: cs[cs.length - 2].id, b: cs[cs.length - 1].id, fill: 'gray' };
    model.items.unshift(it); sel = it.id; draw();
  }

  /* 끌기 */
  var drag = null;
  function userXY(ev) {
    var svg = svgBox.querySelector('svg');
    var pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    var loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [clamp(invX(loc.x), -4, 104), clamp(invY(loc.y), -4, 104)];
  }

  function onDown(ev) {
    var t = ev.target;
    var id = t.getAttribute && t.getAttribute('data-id');
    if (!id) { sel = null; draw(); return; }
    var handle = t.getAttribute('data-handle');
    sel = id; draw();
    var it = selected();
    if (!it) return;
    snap();
    drag = { id: id, handle: handle, from: userXY(ev), orig: JSON.parse(JSON.stringify(it)) };
    ev.preventDefault();
    svgBox.setPointerCapture && svgBox.setPointerCapture(ev.pointerId);
  }

  function onMove(ev) {
    if (!drag) return;
    var it = selected();
    if (!it) return;
    var now = userXY(ev), dx = now[0] - drag.from[0], dy = now[1] - drag.from[1];
    var o = drag.orig;
    function mv(pt) { return [r1(clamp(pt[0] + dx, 0, 100)), r1(clamp(pt[1] + dy, 0, 100))]; }
    if (drag.handle === 'p') it.p = [r1(now[0]), r1(now[1])];
    else if (drag.handle === 'q') it.q = [r1(now[0]), r1(now[1])];
    else if (drag.handle === 'at') it.at = [r1(now[0]), r1(now[1])];
    else if (it.type === 'point' || it.type === 'text') it.at = mv(o.at);
    else if (it.p) { it.p = mv(o.p); it.q = mv(o.q); }
    svgBox.innerHTML = render(model, { live: true, sel: sel });
  }

  function onUp() { if (drag) { drag = null; draw(); } }

  /* 내보내기 */
  function exportSvg() { return render(model, {}); }

  function title() {
    var el = $('ge-title');
    return (el && el.value.trim()) || '경제학 그림';
  }

  function bridgeCall(name, payload, done) {
    if (!window.pyBridge || !window.pyBridge[name]) { msg('프로그램 연결이 없습니다.', false); return; }
    window.pyBridge[name](JSON.stringify(payload), function (r) {
      var res = {};
      try { res = JSON.parse(r); } catch (e) { res = { status: 'error', message: r }; }
      done(res);
    });
  }

  function saveAs(fmt) {
    bridgeCall('handle_econ_graph_save', { svg: exportSvg(), title: title(), format: fmt }, function (res) {
      if (res.status === 'success') msg('저장했습니다 — ' + res.path, true);
      else if (res.status !== 'cancel') msg(res.message || '저장에 실패했습니다.', false);
    });
  }

  /* 불러오기 — 내보낸 SVG 의 metadata 에서 모델을 되살린다 */
  function loadSvgText(txt) {
    var m = /<metadata[^>]*id="graph-model"[^>]*>([\s\S]*?)<\/metadata>/.exec(txt || '');
    if (!m) { msg('이 SVG에는 편집 정보가 없습니다 — 이 편집기로 만든 그림만 다시 열 수 있습니다.', false); return; }
    var raw = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    try {
      var mm = JSON.parse(raw);
      if (!mm || !mm.items) throw new Error('형식이 다릅니다');
      snap(); model = mm; sel = null;
      model.items.forEach(function (it) {                 // id 충돌 방지
        var n = parseInt(String(it.id).slice(1), 10);
        if (n > seq) seq = n;
      });
      draw(); msg('불러왔습니다.', true);
    } catch (e) { msg('불러오기에 실패했습니다: ' + e.message, false); }
  }

  /* 미리 짜 둔 뼈대 */
  var PRESETS = {
    '수요·공급': function () {
      model = blank(); model.axes = { x: 'Q', y: 'P', origin: 'O' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [10, 88], q: [84, 18], label: 'D' },
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [10, 14], q: [84, 84], label: 'S' }
      ];
      var at = crossing(model.items[0], model.items[1]);
      if (at) model.items.push({ id: nid('p'), type: 'point', at: [r1(at[0]), r1(at[1])], label: 'E', guides: true, xlab: 'Q*', ylab: 'P*' });
    },
    'IS-LM': function () {
      model = blank(); model.axes = { x: 'Y', y: 'r', origin: 'O' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [10, 88], q: [84, 22], label: 'IS' },
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [10, 18], q: [84, 84], label: 'LM' }
      ];
      var at = crossing(model.items[0], model.items[1]);
      if (at) model.items.push({ id: nid('p'), type: 'point', at: [r1(at[0]), r1(at[1])], label: 'E', guides: true, xlab: 'Y*', ylab: 'r*' });
    },
    'AD-AS': function () {
      model = blank(); model.axes = { x: 'Y', y: 'P', origin: 'O' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [10, 86], q: [84, 20], label: 'AD' },
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [10, 20], q: [84, 84], label: 'SRAS' },
        { id: nid('c'), type: 'curve', shape: 'vert', p: [50, 6], q: [50, 94], label: 'LRAS' }
      ];
      var at = crossing(model.items[0], model.items[1]);
      if (at) model.items.push({ id: nid('p'), type: 'point', at: [r1(at[0]), r1(at[1])], label: 'E', guides: true, xlab: 'Y*', ylab: 'P*' });
    },
    '무차별곡선·예산선': function () {
      model = blank(); model.axes = { x: 'X', y: 'Y', origin: 'O' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: -0.6, p: [12, 90], q: [84, 14], label: 'IC' },
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [8, 92], q: [86, 10], label: 'BL' }
      ];
      model.items.push({ id: nid('p'), type: 'point', at: [50, 50], label: 'E', guides: true, xlab: 'X*', ylab: 'Y*' });
    },
    '비용곡선': function () {
      model = blank(); model.axes = { x: 'Q', y: '비용', origin: 'O' };
      var ac = { id: nid('c'), type: 'curve', shape: 'ushape', k: 0, p: [14, 78], q: [90, 72], label: 'AC' };
      var mc = { id: nid('c'), type: 'curve', shape: 'curve', k: 0.6, p: [14, 40], q: [88, 92], label: 'MC' };
      throughLowest(mc, ac);          // MC 는 AC 최저점을 지나야 한다
      model.items = [mc, ac];
    },
    '에지워스 상자': function () {
      model = blank();
      model.axes = { frame: 'edgeworth', x: 'X재', y: 'Y재', x2: 'X재', y2: 'Y재',
                     origin: 'O_A', origin2: 'O_B' };
      model.items = [
        /* A의 무차별곡선 — 왼아래 원점에 볼록 */
        { id: nid('c'), type: 'curve', shape: 'curve', k: -0.6, p: [6, 72], q: [72, 6], label: 'IC_A' },
        /* B의 무차별곡선 — 오른위 원점 쪽으로 볼록(같은 곡선족을 뒤집으면 된다) */
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0.6, p: [28, 94], q: [94, 28], label: 'IC_B' },
        /* 계약곡선 — 두 원점을 잇는 부드러운 곡선 */
        { id: nid('c'), type: 'curve', shape: 'curve', k: -0.35, p: [0, 0], q: [90, 90],
          label: '계약곡선', dash: true }
      ];
      var at = crossing(model.items[0], model.items[1]);
      if (at) model.items.push({ id: nid('p'), type: 'point', at: [r1(at[0]), r1(at[1])],
                                 label: 'E', guides: false, xlab: '', ylab: '' });
    },
    '순수출(0 아래까지)': function () {
      model = blank();
      model.axes = { frame: 'yneg', x: 'Y', y: 'NX', origin: 'O', x2: '', y2: '', origin2: '' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [4, 86], q: [92, 16], label: 'NX' }
      ];
      var nx = model.items[0];
      /* 0 선과 만나는 곳에 점 — 무역수지 균형 */
      var u0 = nx.p[0] + (nx.q[0] - nx.p[0]) * (nx.p[1] - 50) / (nx.p[1] - nx.q[1]);
      model.items.push({ id: nid('p'), type: 'point', at: [r1(u0), 50], label: '',
                         guides: false, xlab: 'Y₀', ylab: '' });
    },
    '4분면 도출': function () {
      model = blank();
      model.axes = { frame: 'cross', x: 'Y', x2: 'L', y: 'r', y2: 'N', origin: 'O',
                     origin2: '' };
      model.items = [
        /* 오른위 — 우하향 (예: IS) */
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [54, 94], q: [96, 56], label: 'IS' },
        /* 왼위 — 우상향으로 넘어가는 보조관계 */
        { id: nid('c'), type: 'curve', shape: 'curve', k: -0.4, p: [6, 94], q: [46, 56], label: '' },
        /* 왼아래 — 45°선 (두 축을 옮겨 잇는 장치) */
        /* 라벨이 원점의 O 와 겹치지 않게 바깥쪽 끝에서 끝난다 */
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [46, 46], q: [8, 8],
          label: '45°', dash: true },
        /* 오른아래 — 생산함수 등 */
        { id: nid('c'), type: 'curve', shape: 'curve', k: -0.5, p: [54, 46], q: [96, 8], label: '' }
      ];
    },
    '좌우 맞보기(양국)': function () {
      model = blank();
      model.axes = { frame: 'mirror', x: '자국 노동', x2: '외국 노동', y: 'w', origin: 'O',
                     y2: '', origin2: '' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [52, 88], q: [96, 20], label: 'MPL' },
        { id: nid('c'), type: 'curve', shape: 'curve', k: 0, p: [48, 88], q: [4, 20], label: 'MPL*' }
      ];
    },
    '필립스곡선': function () {
      model = blank(); model.axes = { x: 'u', y: 'π', origin: 'O' };
      model.items = [
        { id: nid('c'), type: 'curve', shape: 'curve', k: -0.6, p: [12, 88], q: [84, 16], label: 'SPC' },
        { id: nid('c'), type: 'curve', shape: 'vert', p: [50, 6], q: [50, 94], label: 'LPC' }
      ];
    }
  };

  /* ───────────────── 배선 ───────────────── */
  function palette() {
    return ''
      + '<div class="ge-sec">뼈대부터 시작</div>'
      + '<div class="ge-grid">' + Object.keys(PRESETS).map(function (k) {
        return '<button type="button" class="ge-btn" data-preset="' + esc(k) + '">' + esc(k) + '</button>';
      }).join('') + '</div>'
      + '<div class="ge-sec">곡선 놓기 <span class="ge-note">놓은 뒤 휨으로 조절</span></div>'
      + '<div class="ge-grid">'
      + '<button type="button" class="ge-btn" data-add="down|0">우하향 직선</button>'
      + '<button type="button" class="ge-btn" data-add="up|0">우상향 직선</button>'
      + '<button type="button" class="ge-btn" data-add="down|-0.6">우하향 체감<br><small>원점에 볼록</small></button>'
      + '<button type="button" class="ge-btn" data-add="down|0.6">우하향 체증<br><small>원점에 오목</small></button>'
      + '<button type="button" class="ge-btn" data-add="up|0.6">우상향 체증</button>'
      + '<button type="button" class="ge-btn" data-add="up|-0.6">우상향 체감</button>'
      + '<button type="button" class="ge-btn" data-add="ushape">U자</button>'
      + '<button type="button" class="ge-btn" data-add="vert">수직선</button>'
      + '<button type="button" class="ge-btn" data-add="horiz">수평선</button>'
      + '</div>'
      + '<div class="ge-sec">표시 넣기</div>'
      + '<div class="ge-grid">'
      + '<button type="button" class="ge-btn" data-add="point">점</button>'
      + '<button type="button" class="ge-btn" data-act2="cross">두 곡선 교점</button>'
      + '<button type="button" class="ge-btn" data-add="arrow">화살표</button>'
      + '<button type="button" class="ge-btn" data-act2="area">영역 음영</button>'
      + '<button type="button" class="ge-btn" data-add="text">글자</button>'
      + '</div>'
      + '<div class="ge-sec">고른 곡선 이동</div>'
      + '<div class="ge-grid ge-grid4">'
      + '<button type="button" class="ge-btn" data-shift="left">←</button>'
      + '<button type="button" class="ge-btn" data-shift="right">→</button>'
      + '<button type="button" class="ge-btn" data-shift="up">↑</button>'
      + '<button type="button" class="ge-btn" data-shift="down">↓</button>'
      + '</div>';
  }

  function mount(root) {
    host = root;
    if (!host) return false;
    svgBox = $('ge-canvas');
    propBox = $('ge-props');
    listBox = $('ge-list');
    msgBox = $('ge-message');
    var pal = $('ge-palette');
    if (pal) pal.innerHTML = palette();

    var me = host;                       /* 이 처리기는 자기 화면만 본다 (닫힌 대화상자가 끼어들지 않게) */
    me.addEventListener('click', function (ev) {
      if (host !== me) return;
      var t = ev.target.closest && ev.target.closest('button');
      if (!t || !me.contains(t)) return;
      var a;
      if ((a = t.getAttribute('data-preset'))) {
        snap(); PRESETS[a](); sel = null; draw(); msg(a + ' 뼈대를 놓았습니다. 끌어서 고치세요.', true); return;
      }
      if ((a = t.getAttribute('data-add'))) {
        if (a === 'point') addPoint();
        else if (a === 'arrow') addArrow();
        else if (a === 'text') addText();
        else if (a === 'vert' || a === 'horiz' || a === 'ushape') addCurve(a, '', 0);
        else {                                   // "방향|휨" 꼴
          var bits = a.split('|');
          addCurve('curve', bits[0], parseFloat(bits[1]) || 0);
        }
        return;
      }
      if ((a = t.getAttribute('data-act2'))) {
        if (a === 'cross') addCrossing();
        else if (a === 'area') addArea();
        return;
      }
      if ((a = t.getAttribute('data-lp'))) {
        var pt = selected();
        if (pt && pt.type === 'point') { snap(); pt.lp = a; draw(); }
        return;
      }
      if ((a = t.getAttribute('data-shift'))) { shiftCopy(a); return; }
      if ((a = t.getAttribute('data-pick'))) { sel = a; draw(); return; }
      if ((a = t.getAttribute('data-act'))) {
        var it = selected();
        if (!it) return;
        snap();
        if (a === 'dash') { it.dash = !it.dash; }
        else if (a === 'axauto') { var nm = axisNames(it.id); it.xlab = nm[0]; it.ylab = nm[1]; }
        else if (a === 'del') { model.items = model.items.filter(function (x) { return x.id !== it.id; }); sel = null; }
        else if (a === 'dup') {
          var cp = JSON.parse(JSON.stringify(it)); cp.id = nid(String(it.id).charAt(0));
          if (cp.p) { cp.p = [cp.p[0] + 4, cp.p[1] + 4]; cp.q = [cp.q[0] + 4, cp.q[1] + 4]; }
          if (cp.at) cp.at = [cp.at[0] + 4, cp.at[1] + 4];
          model.items.push(cp); sel = cp.id;
        } else if (a === 'front') {
          model.items = model.items.filter(function (x) { return x.id !== it.id; }); model.items.push(it);
        }
        draw();
      }
    });

    me.addEventListener('input', function (ev) {
      if (host !== me) return;
      var id = ev.target.id, it = selected();
      if (id === 'ge-frame') {
        snap(); model.axes.frame = ev.target.value; sel = null; draw(); return;
      }
      if (id === 'ge-ax') { model.axes.x = ev.target.value; draw(); return; }
      if (id === 'ge-ay') { model.axes.y = ev.target.value; draw(); return; }
      if (id === 'ge-ao') { model.axes.origin = ev.target.value; draw(); return; }
      if (id === 'ge-ax2') { model.axes.x2 = ev.target.value; draw(); return; }
      if (id === 'ge-ay2') { model.axes.y2 = ev.target.value; draw(); return; }
      if (id === 'ge-ao2') { model.axes.origin2 = ev.target.value; draw(); return; }
      if (!it) return;
      var reprops = false;
      if (id === 'ge-label') it.label = ev.target.value;
      else if (id === 'ge-text') it.text = ev.target.value;
      else if (id === 'ge-xlab') it.xlab = ev.target.value;
      else if (id === 'ge-ylab') it.ylab = ev.target.value;
      else if (id === 'ge-shape') {
        if (it.k == null) it.k = LEGACY[it.shape] || 0;
        it.shape = ev.target.value; reprops = true;
      } else if (id === 'ge-k') {
        it.k = Math.round(parseFloat(ev.target.value)) / 100;
        var hint = me.querySelector('.ge-khint');
        if (hint) hint.textContent = it.k > 0.03 ? '체증 — 갈수록 가팔라짐'
          : (it.k < -0.03 ? '체감 — 갈수록 완만해짐' : '직선');
      } else if (id === 'ge-dash') it.dash = ev.target.checked;
      else if (id === 'ge-guides') it.guides = ev.target.checked;
      else if (id === 'ge-fill') it.fill = ev.target.value;
      else return;
      var keep = document.activeElement && document.activeElement.id;
      svgBox.innerHTML = render(model, { live: true, sel: sel });
      drawList();
      if (reprops) drawProps();
      if (keep) { var k2 = $(keep); if (k2 && k2.focus) { k2.focus(); } }
    });

    if (svgBox) {
      svgBox.addEventListener('pointerdown', onDown);
      svgBox.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    if (!keysBound) {                     /* 문서에 한 번만 — 편집기를 여닫아도 쌓이지 않게 */
      keysBound = true;
      document.addEventListener('keydown', onKey);
    }

    var b;
    if ((b = $('btn-ge-new'))) b.addEventListener('click', function () { snap(); model = blank(); sel = null; draw(); msg('새로 시작합니다.'); });
    if ((b = $('btn-ge-undo'))) b.addEventListener('click', undo);
    if ((b = $('btn-ge-save-svg'))) b.addEventListener('click', function () { saveAs('svg'); });
    if ((b = $('btn-ge-save-png'))) b.addEventListener('click', function () { saveAs('png'); });
    if ((b = $('btn-ge-insert'))) b.addEventListener('click', function () {
      bridgeCall('handle_econ_graph_insert', { svg: exportSvg(), title: title() }, function (res) {
        if (res.status === 'success') msg('백과사전에 저장했습니다 — ' + res.path, true);
        else msg(res.message || '저장에 실패했습니다.', false);
      });
    });
    if ((b = $('btn-ge-copy'))) b.addEventListener('click', function () {
      var t = exportSvg();
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { msg('SVG를 복사했습니다.', true); },
        function () { msg('복사에 실패했습니다.', false); });
    });
    if ((b = $('btn-ge-load'))) b.addEventListener('click', function () {
      var f = $('ge-file'); if (f) f.click();
    });
    if ((b = $('ge-file'))) b.addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () { loadSvgText(String(fr.result)); };
      fr.readAsText(file, 'utf-8');
      ev.target.value = '';
    });

    draw();
    return true;
  }

  /** Delete 로 지우기 · Ctrl+Z 로 되돌리기 — 지금 살아 있는 편집기에만 듣는다. */
  var keysBound = false;
  function onKey(ev) {
    if (!host || !host.classList || host.classList.contains('hidden')) return;
    if (!document.body.contains(host)) return;          /* 이미 닫힌 대화상자 */
    var tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.target.isContentEditable) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      var it = selected(); if (!it) return;
      ev.preventDefault(); snap();
      model.items = model.items.filter(function (x) { return x.id !== it.id; });
      sel = null; draw();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
    }
  }

  /* ───────────────── 학습지 작도칸 연결 ─────────────────
   *  백지인출 학습지의 <div class="write draw"> 는 마우스로 그릴 수 없는 빈 칸이었다.
   *  여기에 [그래프 그리기] 를 달아, 같은 편집기를 문서 안 대화상자로 띄우고
   *  완성된 SVG 를 칸에 넣는다. 모델은 따로 저장해 다시 열어 고칠 수 있다.
   */
  var DLG_HTML = ''
    + '<div class="ge-dlg-box">'
    + '  <div class="ge-dlg-head"><b>그래프 그리기</b>'
    + '    <span class="ge-dlg-label"></span>'
    + '    <span class="ge-dlg-btns">'
    + '      <button type="button" class="ge-mini" id="ge-dlg-cancel">취소</button>'
    + '      <button type="button" class="ge-mini ge-ok" id="ge-dlg-ok">칸에 넣기</button>'
    + '    </span></div>'
    + '  <div class="ge-wrap">'
    + '    <div class="ge-side" id="ge-palette"></div>'
    + '    <div class="ge-main"><div class="ge-canvas" id="ge-canvas"></div>'
    + '      <div id="ge-message" class="ge-msg"></div></div>'
    + '    <div class="ge-side"><div class="ge-sec">고친 곳</div><div id="ge-props"></div>'
    + '      <div class="ge-sec">놓인 것</div><div id="ge-list"></div></div>'
    + '  </div></div>';

  /** 편집기를 문서 안 대화상자로 띄운다. done(svg, modelJson) 으로 결과를 돌려준다. */
  function openDialog(opt) {
    opt = opt || {};
    injectStyle();
    var back = document.createElement('div');
    back.className = 'ge-dlg';
    back.innerHTML = DLG_HTML;
    document.body.appendChild(back);
    var lab = back.querySelector('.ge-dlg-label');
    if (lab) lab.textContent = opt.label || '';

    var keepHost = host, keepModel = model, keepSel = sel;
    model = blank(); sel = null; undoStack = []; redoStack = [];
    mount(back);
    if (opt.model) {
      try {
        var mm = (typeof opt.model === 'string') ? JSON.parse(opt.model) : opt.model;
        if (mm && mm.items) {
          model = mm;
          model.items.forEach(function (it) {
            var n = parseInt(String(it.id).slice(1), 10);
            if (n > seq) seq = n;
          });
          draw();
        }
      } catch (e) { /* 못 읽으면 빈 그림에서 시작 */ }
    }
    function close() {
      back.remove();
      host = keepHost; model = keepModel; sel = keepSel;
      if (host) { svgBox = $('ge-canvas'); propBox = $('ge-props'); listBox = $('ge-list'); msgBox = $('ge-message'); draw(); }
    }
    back.querySelector('#ge-dlg-cancel').addEventListener('click', close);
    back.querySelector('#ge-dlg-ok').addEventListener('click', function () {
      var svg = exportSvg(), json = JSON.stringify(model);
      close();
      if (typeof opt.done === 'function') opt.done(svg, json);
    });
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && document.body.contains(back)) { close(); document.removeEventListener('keydown', esc); }
    });
  }

  /* ───────────────── 다른 작성칸에 넣기 ─────────────────
   *  시험 답안·채점 답안·문서 편집기는 내용을 HTML 로 보관하고 그림은 <img> 로 다룬다.
   *  그래서 SVG 를 data URI <img> 로 감싸 넣는다 — 기존 크기조절·그림추출이 그대로 통한다.
   *  모델은 data-ge-model 에 실어 두어 나중에 그 그림을 다시 열어 고칠 수 있다.
   */
  function svgToDataUri(svg) {
    try { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); }
    catch (e) { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); }
  }

  function svgToImg(svg, json, width) {
    var w = width || 360;
    return '<img class="ans-img ge-img" src="' + svgToDataUri(svg) + '"'
      + ' style="width:' + w + 'px;height:auto;" alt="그래프"'
      + ' data-ge-model="' + esc(json || '') + '">';
  }

  /** 작성칸(contenteditable)에 그래프를 넣거나, 이미 있는 그래프를 고친다. */
  function insertInto(adapter, img) {
    var cur = img && img.getAttribute ? img.getAttribute('data-ge-model') : null;
    openDialog({
      model: cur,
      label: img ? '이 그래프 고치기' : '',
      done: function (svg, json) {
        if (img && img.parentNode) {                 /* 있던 그림을 그 자리에서 갈아 끼운다 */
          var w = img.style.width || '';
          img.src = svgToDataUri(svg);
          img.setAttribute('data-ge-model', json);
          if (w) img.style.width = w;
          if (adapter && typeof adapter.onChange === 'function') adapter.onChange();
          return;
        }
        var el = adapter && adapter.el;
        var wid = el ? Math.min(380, Math.round((el.clientWidth || 600) * 0.5)) : 360;
        if (adapter && typeof adapter.insertContent === 'function') adapter.insertContent(svgToImg(svg, json, wid));
      }
    });
  }

  /** 이 학습지에서 쓸 저장 열쇠 앞머리 — 문서 자체 스크립트의 PREFIX 를 그대로 쓴다. */
  function storePrefix() {
    var m = /var\s+PREFIX\s*=\s*'([^']+)'/.exec(document.body ? document.body.innerHTML : '');
    return 'ge-' + (m ? m[1] : (document.title || 'doc').slice(0, 40));
  }

  function attachWriteBoxes() {
    var boxes = [].slice.call(document.querySelectorAll('.write.draw'));
    if (!boxes.length) return 0;
    injectStyle();
    var pre = storePrefix();
    boxes.forEach(function (box) {
      if (box.__ge) return;
      box.__ge = true;
      var key = pre + '-' + (box.getAttribute('data-key') || '');
      var bar = document.createElement('div');
      bar.className = 'ge-boxbar';
      bar.innerHTML = '<button type="button" class="ge-mini" data-ge="draw">📈 그래프 그리기</button>'
        + '<button type="button" class="ge-mini" data-ge="clear" hidden>지우기</button>';
      box.parentNode.insertBefore(bar, box);

      function paint(svg) {
        var holder = box.querySelector('.ge-out');
        if (!svg) {
          if (holder) holder.remove();
          bar.querySelector('[data-ge="clear"]').hidden = true;
          bar.querySelector('[data-ge="draw"]').textContent = '📈 그래프 그리기';
          return;
        }
        if (!holder) {
          holder = document.createElement('div');
          holder.className = 'ge-out';
          holder.setAttribute('contenteditable', 'false');
          box.insertBefore(holder, box.firstChild);
        }
        holder.innerHTML = svg;
        bar.querySelector('[data-ge="clear"]').hidden = false;
        bar.querySelector('[data-ge="draw"]').textContent = '📈 그래프 고치기';
      }

      var savedJson = null;
      try { savedJson = localStorage.getItem(key); } catch (e) { savedJson = null; }
      if (savedJson) {
        try { paint(render(JSON.parse(savedJson), {})); } catch (e) { savedJson = null; }
      }

      bar.addEventListener('click', function (ev) {
        var t = ev.target.closest && ev.target.closest('button');
        if (!t) return;
        if (t.getAttribute('data-ge') === 'clear') {
          paint('');
          savedJson = null;
          try { localStorage.removeItem(key); } catch (e) {}
          return;
        }
        openDialog({
          model: savedJson,
          label: box.getAttribute('data-label') || '',
          done: function (svg, json) {
            savedJson = json;
            paint(svg);
            try { localStorage.setItem(key, json); } catch (e) {}
          }
        });
      });
    });
    return boxes.length;
  }

  function boot() {
    var screen = document.getElementById('screen-graph-editor');
    if (screen) mount(screen);
    if (document.querySelector('.write.draw')) attachWriteBoxes();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 학습지·다른 도구에서 쓸 수 있게 열어 둔다 */
  window.GraphEditor = {
    render: render, blank: blank, sample: sample, crossing: crossing,
    model: function () { return model; },
    load: loadSvgText,
    mount: mount, openDialog: openDialog, attach: attachWriteBoxes,
    insertInto: insertInto, svgToImg: svgToImg, style: injectStyle
  };
})();

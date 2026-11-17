/* imaging.js — 스캔 화상 처리. **화질이 이 기능의 존재 이유다.**
 *
 *  Google Drive 앱 스캔은 화질이 떨어졌다(미리보기 프레임 해상도 + 강한 압축·이진화).
 *  여기서는:
 *    · 사진은 폰 **카메라 앱 원본**(<input capture>, 12MP 이상)을 받는다 — 미리보기 영상 프레임을 쓰지 않는다.
 *    · 자르기·펴기(원근 보정)는 **원본 화소**에서 한 번만 한다(결과 긴 변 최대 4000px ≈ A4 340dpi).
 *    · 보정은 '조명 고르기'만 — 배경(종이)을 추정해 나눠 하얗게 하되 획의 농담·연필 자국은 남긴다.
 *      흑백 이진화·재압축 반복이 없다. JPEG 은 마지막에 한 번, 품질 0.92.
 *
 *  화면 층에 있지만 DOM 은 캔버스만 쓴다(데이터 층은 캔버스를 모른다 — tools/check-layers.sh).
 */

export const MAX_SRC = 5000;      // 펴기 전 원본 긴 변 상한 — 50MP 폰에서 메모리가 터지지 않게
export const MAX_OUT = 4000;      // 결과 긴 변 상한
export const JPEG_Q = 0.92;

/** Blob → 그릴 수 있는 것(EXIF 회전 반영). 다 쓰면 close() 해 둔다. */
export async function decode(blob) {
  if (self.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* 아래로 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const im = new Image();
    im.src = url;
    await im.decode();
    const c = canvasOf(im.naturalWidth, im.naturalHeight);
    c.getContext('2d').drawImage(im, 0, 0);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
export function release(src) {
  try { if (src && src.close) src.close(); else if (src && 'width' in src) { src.width = 0; src.height = 0; } } catch (e) {}
}

const dims = (s) => ({ w: s.naturalWidth || s.width, h: s.naturalHeight || s.height });
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const ctxOf = (c) => c.getContext('2d', { willReadFrequently: true });

/** 줄여 그리기 — 큰 비율은 반씩 여러 번(한 번에 줄이면 계단·무아레가 생긴다). */
export function scaled(src, maxSide) {
  const { w, h } = dims(src);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  let cur = src, cw = w, ch = h;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = canvasOf(nw, nh);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    if (cur !== src) release(cur);
    cur = c; cw = nw; ch = nh;
  }
  const c = canvasOf(tw, th);
  const x = ctxOf(c);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, tw, th);
  if (cur !== src) release(cur);
  return c;
}

/* ── 종이 찾기 ─────────────────────────────────────────────────────────
 *  640px 로 줄여 밝기 → 흐리게(글씨 구멍 메우기) → 오츠 문턱 → 가장 큰 밝은 덩어리 →
 *  x+y, x−y 극값 네 점. 어두운 바닥 위 흰 종이면 잘 잡힌다. 못 잡으면 null(= 전체).
 */
export const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function detectCorners(src) {
  const c = scaled(src, 640);
  const W = c.width, H = c.height, N = W * H;
  const d = ctxOf(c).getImageData(0, 0, W, H).data;
  release(c);
  let L = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  L = boxBlur(L, W, H, 4);

  const hist = new Float64Array(256);
  for (let i = 0; i < N; i++) hist[Math.min(255, L[i] | 0)]++;
  const t = otsu(hist, N);

  const lab = new Int32Array(N);
  const stack = new Int32Array(N);
  let best = 0, bestId = 0, id = 0;
  for (let s = 0; s < N; s++) {
    if (lab[s] || L[s] <= t) continue;
    id++;
    let sp = 0, size = 0;
    stack[sp++] = s; lab[s] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % W;
      if (x > 0 && !lab[p - 1] && L[p - 1] > t) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && !lab[p + 1] && L[p + 1] > t) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= W && !lab[p - W] && L[p - W] > t) { lab[p - W] = id; stack[sp++] = p - W; }
      if (p < N - W && !lab[p + W] && L[p + W] > t) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    if (size > best) { best = size; bestId = id; }
  }
  if (best < 0.12 * N || best > 0.97 * N) return null;

  // 테두리를 절반 넘게 덮으면 종이가 아니라 밝은 바닥이다
  let edge = 0;
  for (let x = 0; x < W; x++) { if (lab[x] === bestId) edge++; if (lab[N - W + x] === bestId) edge++; }
  for (let y = 0; y < H; y++) { if (lab[y * W] === bestId) edge++; if (lab[y * W + W - 1] === bestId) edge++; }
  if (edge > (W + H)) return null;

  let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
  let tl, br, tr, bl;
  for (let p = 0; p < N; p++) {
    if (lab[p] !== bestId) continue;
    const x = p % W, y = (p / W) | 0, s = x + y, df = x - y;
    if (s < sMin) { sMin = s; tl = [x, y]; }
    if (s > sMax) { sMax = s; br = [x, y]; }
    if (df > dMax) { dMax = df; tr = [x, y]; }
    if (df < dMin) { dMin = df; bl = [x, y]; }
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / W, (y + 0.5) / H]);
  if (quadArea(q) < 0.1 || !convex(q)) return null;
  return q;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; t = i; }
  }
  return t;
}

/** 분리형 상자 흐림(반지름 r) — 누적합이라 r 에 무관하게 빠르다. */
function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[o + x] = acc / (2 * r + 1);
      acc += src[o + Math.min(W - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
export function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) continue;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/* ── 펴기(원근 보정) ───────────────────────────────────────────────────── */
/** 출력 (u,v) → 원본 (x,y) 사영 변환 8계수. */
function homography(srcPts, dstPts) {
  const A = [], b = [];
  for (let k = 0; k < 4; k++) {
    const [u, v] = dstPts[k], [x, y] = srcPts[k];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  for (let i = 0; i < 8; i++) {          // 부분 피벗 가우스 소거
    let m = i;
    for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    for (let r = 0; r < 8; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let c = i; c < 8; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * 종이의 실제 가로/세로 비 — 변 길이만 재면 원근(멀리 있는 변이 짧다) 때문에 비율이 틀어진다.
 * 사진 중심을 주점으로 보고 초점거리를 같이 풀어 직사각형의 참 비율을 구한다
 * (Zhang & He, "Whiteboard scanning and image enhancement", 2007). 못 풀면 null.
 * P = 픽셀 좌표 [왼위, 오위, 오아래, 왼아래], W·H = 사진 크기.
 */
function trueAspect(P, W, H) {
  const u0 = W / 2, v0 = H / 2;
  const m = (p) => [p[0] - u0, p[1] - v0, 1];
  const m1 = m(P[0]), m2 = m(P[1]), m3 = m(P[3]), m4 = m(P[2]);     // 논문 순서: 왼위·오위·왼아래·오아래
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  if (Math.abs(n2[2] * n3[2]) < 1e-9) return null;                  // 거의 정면 — 변 길이로 충분
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  const diag = Math.max(W, H);
  if (!(f2 > (0.3 * diag) ** 2 && f2 < (5 * diag) ** 2)) return null; // 폰 카메라로 말이 되는 초점거리만
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  return isFinite(r) && r > 0.2 && r < 5 ? r : null;
}
const PAPER = Math.SQRT1_2;          // A4·B4·A3 모두 1 : √2

/**
 * 한 쪽을 만든다 → 캔버스.  corners = 정규화 네 점(왼위·오위·오아래·왼아래), rot = 0/90/180/270,
 * mode = 'doc'(조명 고르기) | 'color'(원본 색 그대로). maxOut 을 작게 주면 미리보기.
 */
export function render(src, corners, { rot = 0, mode = 'doc', maxOut = MAX_OUT } = {}) {
  const q = corners || FULL;
  const sc = scaled(src, Math.min(MAX_SRC, Math.round(maxOut * 1.25)));
  const W = sc.width, H = sc.height;
  const P = q.map(([x, y]) => [x * W, y * H]);
  let ow = Math.max(dist(P[0], P[1]), dist(P[3], P[2]));
  let oh = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
  // 비율 바로잡기 — 면적(화소 수)은 두고 가로/세로 비만 참 비율로. 1:√2 근처면 그 값에 붙인다.
  let ar = (corners && corners !== FULL) ? trueAspect(P, W, H) : null;
  if (ar) {
    const near = (x) => Math.abs(ar / x - 1) < 0.06;
    if (near(PAPER)) ar = PAPER; else if (near(1 / PAPER)) ar = 1 / PAPER;
    const area = ow * oh;
    ow = Math.sqrt(area * ar); oh = Math.sqrt(area / ar);
  }
  const k = Math.min(1, maxOut / Math.max(ow, oh));
  ow = Math.max(8, Math.round(ow * k)); oh = Math.max(8, Math.round(oh * k));

  const s = ctxOf(sc).getImageData(0, 0, W, H).data;
  release(sc);
  const out = new ImageData(ow, oh);
  const o = out.data;
  const [a, b, c, d, e, f, g, h] = homography(P, [[0, 0], [ow, 0], [ow, oh], [0, oh]]);
  const W4 = W * 4, xMax = W - 1, yMax = H - 1;
  let idx = 0;
  for (let v = 0; v < oh; v++) {
    const vv = v + 0.5;
    let nx = a * 0.5 + b * vv + c, ny = d * 0.5 + e * vv + f, dn = g * 0.5 + h * vv + 1;
    for (let u = 0; u < ow; u++) {
      let x = nx / dn - 0.5, y = ny / dn - 0.5;
      if (x < 0) x = 0; else if (x > xMax) x = xMax;
      if (y < 0) y = 0; else if (y > yMax) y = yMax;
      let x0 = x | 0, y0 = y | 0;
      if (x0 >= xMax) x0 = xMax - 1;
      if (y0 >= yMax) y0 = yMax - 1;
      const fx = x - x0, fy = y - y0, gx = 1 - fx, gy = 1 - fy;
      const i00 = y0 * W4 + x0 * 4, i01 = i00 + W4;
      o[idx]     = (s[i00]     * gx + s[i00 + 4] * fx) * gy + (s[i01]     * gx + s[i01 + 4] * fx) * fy;
      o[idx + 1] = (s[i00 + 1] * gx + s[i00 + 5] * fx) * gy + (s[i01 + 1] * gx + s[i01 + 5] * fx) * fy;
      o[idx + 2] = (s[i00 + 2] * gx + s[i00 + 6] * fx) * gy + (s[i01 + 2] * gx + s[i01 + 6] * fx) * fy;
      o[idx + 3] = 255;
      idx += 4; nx += a; ny += d; dn += g;
    }
  }
  if (mode === 'doc') whiten(out);
  return rotated(out, rot);
}

/**
 * 조명 고르기 — 종이(배경)의 밝기·색을 낮은 해상도로 추정해 화소마다 나눈다.
 *   그림자·노란 조명·가장자리 어두움이 사라지고 종이는 흰색, 획은 원래 농담 그대로.
 *   배경 추정: 1/16 축소(획이 거의 사라짐) → 최댓값 걸러내기 2번(남은 획 지우기) → 흐리게 → 다시 키우기.
 */
function whiten(img) {
  const { width: w, height: h, data } = img;
  const full = canvasOf(w, h);
  full.getContext('2d').putImageData(img, 0, 0);
  const f = Math.max(1, Math.round(Math.max(w, h) / 200));
  const sw = Math.max(4, Math.round(w / f)), sh = Math.max(4, Math.round(h / f));
  const small = scaled(full, Math.max(sw, sh));
  release(full);
  const sx = ctxOf(small);
  const sm = sx.getImageData(0, 0, small.width, small.height);
  const bw = small.width, bh = small.height;
  for (let ch = 0; ch < 3; ch++) {
    let plane = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) plane[i] = sm.data[i * 4 + ch];
    plane = maxFilter(plane, bw, bh, 2);
    plane = maxFilter(plane, bw, bh, 2);
    plane = boxBlur(plane, bw, bh, 3);
    plane = boxBlur(plane, bw, bh, 3);
    for (let i = 0; i < bw * bh; i++) sm.data[i * 4 + ch] = plane[i];
  }
  sx.putImageData(sm, 0, 0);
  const bg = canvasOf(w, h);
  const bx = ctxOf(bg);
  bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high';
  bx.drawImage(small, 0, 0, w, h);
  release(small);
  const B = bx.getImageData(0, 0, w, h).data;
  release(bg);
  // r = 화소/배경. 0.92 넘으면 종이 → 흰색, 그 아래는 감마 1.6 으로 획을 또렷하게(연한 연필도 남김)
  const lut = new Uint8ClampedArray(1025);
  for (let i = 0; i <= 1024; i++) { const r = i / 1024; lut[i] = r >= 0.92 ? 255 : 255 * Math.pow(r / 0.92, 1.6); }
  for (let i = 0; i < data.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const r = data[i + ch] / Math.max(B[i + ch], 32);
      data[i + ch] = r >= 1 ? 255 : lut[(r * 1024) | 0];
    }
  }
}

function maxFilter(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) { const v = src[y * W + k]; if (v > m) m = v; }
    tmp[y * W + x] = m;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) { const v = tmp[k * W + x]; if (v > m) m = v; }
    out[y * W + x] = m;
  }
  return out;
}

function rotated(img, rot) {
  const r = ((rot % 360) + 360) % 360;
  const c0 = canvasOf(img.width, img.height);
  c0.getContext('2d').putImageData(img, 0, 0);
  if (!r) return c0;
  const swap = r === 90 || r === 270;
  const c = canvasOf(swap ? img.height : img.width, swap ? img.width : img.height);
  const x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2);
  x.rotate(r * Math.PI / 180);
  x.drawImage(c0, -img.width / 2, -img.height / 2);
  release(c0);
  return c;
}

/** 캔버스 → JPEG Blob (한 번만 압축). */
export function toJpeg(canvas, q = JPEG_Q) {
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('JPEG 만들기 실패'))), 'image/jpeg', q));
}

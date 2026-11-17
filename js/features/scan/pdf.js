/* pdf.js — JPEG 쪽들을 PDF 하나로 묶는다(라이브러리 없이).
 *
 *  JPEG 바이트를 그대로(DCTDecode) 넣는다 — 다시 압축하지 않으니 화질 손실이 없다.
 *  쪽 크기: 긴 변을 A4 긴 변(841.89pt)에 맞추고 짧은 변은 사진 비율대로.
 */
const A4_LONG = 841.89;

/** pages = [{blob: JPEG Blob, w, h}] → PDF Blob */
export async function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let off = 0;
  const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); off += u.byteLength; };

  const n = pages.length;
  const N = 3 + 3 * n;                       // 0(빈칸)·1 카탈로그·2 쪽 묶음·쪽마다 3개(쪽·내용·그림)
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  offsets[1] = off; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  offsets[2] = off; push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  for (let i = 0; i < n; i++) {
    const { blob, w, h } = pages[i];
    const s = A4_LONG / Math.max(w, h);
    const pw = (w * s).toFixed(2), ph = (h * s).toFixed(2);
    const pg = 3 + 3 * i, ct = pg + 1, im = pg + 2;
    offsets[pg] = off;
    push(`${pg} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] `
      + `/Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>\nendobj\n`);
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    offsets[ct] = off;
    push(`${ct} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    offsets[im] = off;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.byteLength} >>\nstream\n`);
    push(bytes);
    push('\nendstream\nendobj\n');
  }

  const xref = off;
  let x = `xref\n0 ${N}\n0000000000 65535 f \n`;
  for (let k = 1; k < N; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${N} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

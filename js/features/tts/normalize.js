/* normalize.js — 낭독 텍스트 정규화.
 *
 *  ‼ 원본은 데스크톱 `tts_common.py` 의 `normalize`. 옛 app.js:1093-1294 에
 *    이식해 둔 것을 그대로 모듈로 꺼냈다(로직 무수정). 한쪽을 고치면 다른 쪽도.
 *
 *  이게 왜 폰에 필요한가 — 두 가지다.
 *    1) 저장된 mp3 가 없는 문서를 Web Speech 로 읽을 때 컴퓨터와 같은 규칙을 따르려고
 *    2) mp3 에 박아 둔 타이밍의 **지문(sig)** 을 다시 계산해 맞춰 보려고
 *       (tts_common._timing_sig = md5(세그먼트 수 + 정규화된 세그먼트들))
 */
const TTS_GREEK = {
    alpha:"알파",beta:"베타",gamma:"감마",delta:"델타",epsilon:"엡실론",varepsilon:"엡실론",
    zeta:"제타",eta:"에타",theta:"세타",vartheta:"세타",iota:"이오타",kappa:"카파",lambda:"람다",
    mu:"뮤",nu:"뉴",xi:"크시",omicron:"오미크론",pi:"파이",varpi:"파이",rho:"로",varrho:"로",
    sigma:"시그마",tau:"타우",upsilon:"웁실론",phi:"피",varphi:"피",chi:"카이",psi:"프사이",omega:"오메가",
    Gamma:"감마",Delta:"델타",Theta:"세타",Lambda:"람다",Xi:"크시",Pi:"파이",Sigma:"시그마",
    Upsilon:"웁실론",Phi:"피",Psi:"프사이",Omega:"오메가",
};
const TTS_OPS = {
    times:" 곱하기 ",cdot:" , ",div:" 나누기 ",pm:" 플러스마이너스 ",mp:" 마이너스플러스 ",
    leq:" 작거나 같다 ",le:" 작거나 같다 ",geq:" 크거나 같다 ",ge:" 크거나 같다 ",neq:" 같지 않다 ",
    approx:" 근사적으로 ",equiv:" 항등 ",sim:" 비례 ",propto:" 비례 ",rightarrow:" 로 ",to:" 로 ",
    Rightarrow:" 따라서 ",leftarrow:" 에서 ",Leftrightarrow:" 동치 ",infty:" 무한대 ",partial:" 편미분 ",
    nabla:" 나블라 ",sum:" 시그마 ",prod:" 곱 ",int:" 적분 ",sqrt:" 루트 ",cdots:" 등 ",ldots:" 등 ",
    dots:" 등 ",in:" 의 원소 ",forall:" 모든 ",exists:" 존재 ",
};
const TTS_LETTER_KOR = {
    a:"에이",b:"비",c:"씨",d:"디",e:"이",f:"에프",g:"지",h:"에이치",i:"아이",j:"제이",k:"케이",
    l:"엘",m:"엠",n:"엔",o:"오",p:"피",q:"큐",r:"아르",s:"에스",t:"티",u:"유",v:"브이",w:"더블유",
    x:"엑스",y:"와이",z:"지",
};
const TTS_SYMBOL_MAP = {
    "∴":" 따라서 ","∵":" 왜냐하면 ","⇒":" ","⟹":" ","→":" ","⟶":" ","←":" ","↔":" ","⇔":" ",
    "≒":" 약 ","≈":" 약 ","∝":" 비례 ","※":" ","○":" ","●":" ","◦":" ","▪":" ","▶":" ","■":" ","□":" ",
    "∙":", ","·":", ","•":" ","ㆍ":", ","・":", ","‧":", ","⋅":", ","﹒":", ","･":", ","․":", ",
    "〈":" ","〉":" ","《":" ","》":" ","「":" ","」":" ","『":" ","』":" ","【":" ","】":" ","〔":" ","〕":" ",
    "–":" ","—":" ","―":" ","－":" ","ー":" ","‐":" ","∼":" ","~":" ","<":" ",">":" ","$":" ","＜":" ","＞":" ",
};
const TTS_SYMBOL_RE = new RegExp(Object.keys(TTS_SYMBOL_MAP)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
const TTS_INVISIBLE_RE = /[­​-‏‪-‮⁠﻿᠎　]/g;
const TTS_HANJA_G = /[㐀-䶿一-鿿豈-﫿々〆〇ヶ]+/g;
const TTS_HANJA_CHAR = /[㐀-䶿一-鿿豈-﫿々〆〇ヶ]/;
const TTS_EUI_KEEP_ALWAYS = new Set(["분의","주의","의의"]);
const TTS_EUI_KEEP_WS = new Set(["정의","회의","합의","논의","협의","결의","함의","강의","유의","편의",
    "이의","항의","모의","발의","창의","심의","숙의","상의","동의","제의","거의","명의","임의","고의",
    "자의","본의","진의","타의","호의","예의","사의","건의","문의","양의","품의","광의","수의","내의","하의"]);

function ttsMathToKor(s) {
    for (let i=0;i<4;i++) s = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $2 분의 $1 ");
    for (let i=0;i<3;i++) s = s.replace(/\\(?:bar|hat|tilde|vec|dot|ddot|overline|underline|mathbf|mathrm|mathit|mathcal|boldsymbol|text|operatorname)\s*\{([^{}]*)\}/g, " $1 ");
    s = s.replace(/\\([A-Za-z]+)/g, (m,p) => (TTS_GREEK[p] !== undefined ? TTS_GREEK[p] : "\\"+p));
    s = s.replace(/\\([A-Za-z]+)/g, (m,p) => (TTS_OPS[p] !== undefined ? TTS_OPS[p] : " "));
    s = s.replace(/_\{([^{}]*)\}/g, " $1 ").replace(/\^\{([^{}]*)\}/g, " $1 ");
    s = s.replace(/_([A-Za-z0-9])/g, " $1").replace(/\^([A-Za-z0-9])/g, " $1");
    s = s.replace(/[{}\\]/g, " ").replace(/\s{2,}/g, " ").trim();
    return " " + s + " ";
}
function ttsCircledOrRoman(ch) {
    const o = ch.codePointAt(0);
    if (o>=0x2460&&o<=0x2473) return " "+(o-0x2460+1)+" ";
    if (o>=0x2474&&o<=0x2487) return " "+(o-0x2474+1)+" ";
    if (o>=0x2488&&o<=0x249b) return " "+(o-0x2488+1)+" ";
    if (o>=0x2160&&o<=0x216b) return " "+(o-0x2160+1)+" ";
    if (o>=0x2170&&o<=0x217b) return " "+(o-0x2170+1)+" ";
    return ch;
}
function ttsSpaceMarkers(t) {
    t = t.replace(/(제?\s*\d+\s*(?:조|항|호|목|장|절|편|관)(?:\s*의\s*\d+)?)/g, " $1 ");
    t = t.replace(/(\d{2,4}[가-힣]{1,2}\d{1,6})/g, " $1 ");
    t = t.replace(/(\(\d{1,2}\)|\([가-힣]\)|\([ivxlcdmIVXLCDM]+\))/g, " $1 ");
    t = t.replace(/[Ⅰ-ⅿ①-⒛]/g, ttsCircledOrRoman);
    return t;
}
function ttsFixEui(text) {
    return text.replace(/([가-힣])의(?![가-힣])/g, (m, syl, offset) => {
        const word = syl + "의";
        const prev = offset > 0 ? text[offset-1] : "";
        const atWordstart = !(prev >= "가" && prev <= "힣");
        if (TTS_EUI_KEEP_ALWAYS.has(word)) return m;
        if (atWordstart && TTS_EUI_KEEP_WS.has(word)) return m;
        return syl + "에";
    });
}
const TTS_ART = "조|항|호|목|장|절|편|관";
function ttsJoinArticleNumbers(t) {
    t = t.replace(/(\d)\s*\n\s*(조|항|호|목|장|절|편|관)/g, "$1$2");
    t = t.replace(new RegExp("(\\d+\\s*(?:"+TTS_ART+")(?:\\s*의\\s*\\d+)?\\s*[,·]?)\\s*\\n\\s*(?=제?\\s*\\d+\\s*(?:"+TTS_ART+"))", "g"), "$1 ");
    return t;
}
const TTS_ENUM_LEAD = /^[ \t]*(\(\s*\d+\s*\)|\(\s*[가-힣]\s*\)|\(\s*[A-Za-z]\s*\)|\d+\s*[.)]|[Ⅰ-Ⅿ]+\s*[.)]|[A-Za-z]\s*[.)])[ \t]+/gm;
function ttsPauseAfterEnum(t) {
    return t.replace(TTS_ENUM_LEAD, (m, p1) => p1.replace(/[()（）.\s]/g, "") + ", ");
}
const TTS_ENUM_CIRCLED = /[①-⒛㉑-㉟]/g;
function ttsCircledPause(ch) {
    const o = ch.codePointAt(0); let n;
    if (o>=0x2460&&o<=0x2473) n=o-0x2460+1;
    else if (o>=0x2474&&o<=0x2487) n=o-0x2474+1;
    else if (o>=0x2488&&o<=0x249b) n=o-0x2488+1;
    else if (o>=0x3251&&o<=0x325f) n=o-0x3251+21;
    else return ch;
    return ", " + n + ", ";
}
function ttsPauseAfterCircled(t) { return t.replace(TTS_ENUM_CIRCLED, ttsCircledPause); }
const TTS_ROMAN_VAL = {i:1,v:5,x:10,l:50,c:100,d:500,m:1000};
function ttsIntToRoman(n) {
    const vals=[[1000,"m"],[900,"cm"],[500,"d"],[400,"cd"],[100,"c"],[90,"xc"],[50,"l"],[40,"xl"],[10,"x"],[9,"ix"],[5,"v"],[4,"iv"],[1,"i"]];
    let out=""; for (const [v,sym] of vals) { while (n>=v) { out+=sym; n-=v; } } return out;
}
function ttsRomanNum(s) {
    s = s.toLowerCase(); if (!s) return null;
    for (const c of s) if (!(c in TTS_ROMAN_VAL)) return null;
    let total=0, prev=0;
    for (let i=s.length-1;i>=0;i--) { const v=TTS_ROMAN_VAL[s[i]]; if (v<prev) total-=v; else { total+=v; prev=v; } }
    if (!(total>=1&&total<=3999) || ttsIntToRoman(total)!==s) return null;
    return total;
}
function ttsRomanOk(tok) {
    const n = ttsRomanNum(tok);
    if (n===null || n>49) return null;
    if (tok.length===1 && tok.toLowerCase()!=="i") return null;
    return n;
}
function ttsConvertRomanMarkers(text) {
    text = text.replace(/^([ \t]*)([IVX])\s*([.)])/gm, (m,a,b,c) => { const n=ttsRomanNum(b); return a + ((n&&n<=49) ? (n+", ") : (b+c)); });
    text = text.replace(/[\(（]\s*([A-Za-z]{1,6})\s*[\)）]/g, (m,p) => { const n=ttsRomanOk(p); return n ? (" "+n+" ") : m; });
    text = text.replace(/(?<![A-Za-z가-힣])([A-Za-z]{1,6})\s*([.)])/g, (m,p) => { const n=ttsRomanOk(p); return n ? (n+", ") : m; });
    text = text.replace(/(?<![A-Za-z])([ivxlcdmIVXLCDM]{3,6})(?![A-Za-z])/g, (m,p) => { const n=ttsRomanOk(p); return n ? String(n) : m; });
    return text;
}
const TTS_YEAR_RE = /(?<![\d.])(1\d{3}|20\d{2})(?!\d)(?!\.\d)(?!\s*(?:년|연대|월|일|원|명|개|회|호|차|위|점|쪽|면|번|건|종|척|대|권|인|세|표|줄|조|항|달러|위안|엔|페소|루블|프랑|마르크|％|%|미터|그램|킬로|시간|페이지))/g;
function ttsAppendYear(t) { return t.replace(TTS_YEAR_RE, (m,p) => p+"년"); }
function ttsStripForeignParen(text) {
    return text.replace(/[\(（]([^()（）]*)[\)）]/g, (m, inner) => {
        if (/[가-힣]/.test(inner)) return m;
        if (/[A-Za-z]/.test(inner) || TTS_HANJA_CHAR.test(inner)) return "";
        return m;
    });
}
const TTS_SRC_CORE = "일반[^.!?。\\n()（）]{0,40}?(?:으로|로)\\s*(?:보강|구성|작성|서술)[가-힣\\w]*";
const TTS_SRC_PAREN = new RegExp("[\\(（][^()（）]*"+TTS_SRC_CORE+"[^()（）]*[\\)）]", "g");
const TTS_SRC_SENT = new RegExp("[^\\n。.!?]*?"+TTS_SRC_CORE+"[^\\n。.!?]*?(?:[。.!?]|(?=\\n)|$)", "g");
function ttsStripSourceNotes(t) { return t.replace(TTS_SRC_PAREN, "").replace(TTS_SRC_SENT, " "); }

function ttsNormalize(text) {
    text = text.normalize("NFC");
    text = text.replace(TTS_INVISIBLE_RE, " ");
    text = ttsStripSourceNotes(text);
    text = text.replace(/\\\[([\s\S]*?)\\\]/g, (m,p) => ttsMathToKor(p));
    text = text.replace(/\\\(([\s\S]*?)\\\)/g, (m,p) => ttsMathToKor(p));
    text = text.replace(/\$([\s\S]+?)\$/g, (m,p) => ttsMathToKor(p));
    text = ttsConvertRomanMarkers(text);
    text = ttsStripForeignParen(text);
    text = text.replace(TTS_HANJA_G, "");
    text = text.replace(/\s*[-‐-―－]+\s*/g, ", ");
    text = ttsAppendYear(text);
    text = text.replace(/(?:,\s*){2,}/g, ", ");
    text = text.replace(TTS_SYMBOL_RE, m => TTS_SYMBOL_MAP[m]);
    text = text.replace(/(?<![가-힣])의의/g, "의이").replace(/협정/g, "협쩡");
    text = ttsFixEui(text);
    text = ttsJoinArticleNumbers(text);
    text = ttsPauseAfterEnum(text);
    text = ttsPauseAfterCircled(text);
    text = ttsSpaceMarkers(text);
    text = text.replace(/[A-Z]{2,}/g, m => m.split("").join(" "));   // 약어 철자
    text = text.replace(/(?<![A-Za-z])([A-Za-z])(?![A-Za-z])/g, (m,p) => TTS_LETTER_KOR[p.toLowerCase()]);
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/ +([,.])/g, "$1");
    text = text.replace(/(?:,\s*){2,}/g, ", ");
    text = text.replace(/ *\n */g, "\n");
    text = text.replace(/\n{2,}/g, "\n").trim();
    const lines = [];
    for (let ln of text.split("\n")) {
        ln = ln.trim().replace(/^,+/, "").trim();
        if (!ln) continue;
        if (!/[.!?。,;:·…)\]」』】"'`]$/.test(ln)) ln += ",";
        lines.push(ln);
    }
    return lines.join("\n");
}
function ttsHtmlUnescape(s) {
    const d = document.createElement("textarea");
    d.innerHTML = s;
    return d.value;
}
function ttsHtmlToText(raw) {
    raw = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
    raw = raw.replace(/<!--[\s\S]*?-->/g, " ");
    raw = raw.replace(/<div[^>]*class=["']?[^"'>]*\bnote\b[^"'>]*["']?[^>]*>[\s\S]*?<\/div>/gi, " ");
    raw = raw.replace(/\r/g, " ").replace(/\n/g, " ");
    raw = raw.replace(/<br\s*\/?>/gi, "\n");
    raw = raw.replace(/<h[1-6][^>]*>/gi, "\n. … ");
    raw = raw.replace(/<\/h[1-6]\s*>/gi, " . …\n");
    raw = raw.replace(/<\/(p|div|li|tr|td|th|blockquote|section|article|table|ul|ol|dd|dt|figcaption)\s*>/gi, "\n");
    let text = raw.replace(/<[^>]+>/g, " ");
    text = ttsHtmlUnescape(text);
    return ttsNormalize(text);
}
// 정규화 텍스트는 줄 단위로 쉼이 설계됨 — 줄 경계를 지키며 ~200자 발화 단위로 묶음
function ttsChunkLines(t) {
    const out = []; let buf = "";
    for (const raw of (t || "").split("\n")) {
        const ln = raw.trim(); if (!ln) continue;
        if (buf && (buf.length + 1 + ln.length) > 200) { out.push(buf); buf = ln; }
        else buf = buf ? (buf + "\n" + ln) : ln;
    }
    if (buf) out.push(buf);
    return out;
}

/** tts_common._seg_norm — 정규화 후 한 줄로. 지문 계산의 단위다. */
export function segNorm(s) {
  return ttsNormalize(s || '').split('\n').join(' ').replace(/\s+/g, ' ').trim();
}

export { ttsNormalize as normalize, ttsHtmlToText as htmlToText, ttsChunkLines as chunkLines };

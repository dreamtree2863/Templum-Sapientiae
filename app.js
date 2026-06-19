// ─────────────────────────────────────────────────────────────────────
// Templum Sapientiae Mobile — Drive 기반 읽기 전용 뷰어
//
//  1) Google OAuth (Identity Services) 으로 access_token 획득
//  2) Drive API 로 `Templum/archive` + `Templum/encyclopedia` 폴더 안 HTML 나열
//  3) 항목 탭 → 파일 내용 다운로드 → 화면에 렌더 (MathJax 자동)
//  4) 서비스워커가 이미 열어본 문서를 캐시 → 오프라인 재방문 OK
// ─────────────────────────────────────────────────────────────────────

// ⚠️ 사용 전 1회 설정 — README §A 참고
const GOOGLE_CLIENT_ID = "113629352800-he0vmc6f2m3f3vn5clr968db12sf6t4u.apps.googleusercontent.com";
const DRIVE_ROOT_NAME = "Templum";  // My Drive 안의 동기화 폴더 이름

// 읽기 전용 권한만 — 다른 Drive 파일에는 접근 불가
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";

// 캐시 키 (schema 변경 시 v2, v3 ... 으로 bump)
const CACHE_KEY = "templum.docList.v7";  // v7: 낭독 오디오 연결 강제 재조회 — 오디오 없던 시절 굳은 목록 캐시 무효화

// 낭독 오디오 확장자 (데스크톱 tts_common.AUDIO_EXTS 와 동일)
const AUDIO_RE = /\.(mp3|m4a|wav|ogg|opus|aac|flac|wma)$/i;
// 오디오 파일명 → 문서 stem 정규화: 확장자·'_낭독'/' 낭독' 접미사 제거 후 NFC 소문자
function audioStem(name) {
    let s = name.replace(AUDIO_RE, "");
    s = s.replace(/(_| )낭독$/, "");
    return s.normalize("NFC").toLowerCase();
}
// 문서(html) 파일명 → stem (확장자 제거 후 NFC 소문자) — 오디오 매칭 키
function docStem(name) {
    return name.replace(/\.html?$/i, "").normalize("NFC").toLowerCase();
}
const TOKEN_KEY = "templum.googleAccessToken";
const EXPANDED_KEY = "templum.expanded.v1";  // 펼친 폴더 경로 집합
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // 24시간 — 그 후엔 자동 재조회

// 펼친 폴더 상태 영속화 helpers
function loadExpanded() {
    try {
        const raw = localStorage.getItem(EXPANDED_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) { return new Set(); }
}
function saveExpanded() {
    try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded]));
    } catch (_) {}
}

// 상태
const state = {
    accessToken: null,
    tokenClient: null,
    rootFolderId: null,
    /** archive: { subject: { groupKey: {subject, baseTitle, files:{kind:file}, latestMtime} } } */
    grouped: {},
    /** encyclopedia: 폴더 트리 { folders:{ name: subtree }, files:[{...}] } */
    encyclopediaTree: { folders: {}, files: [] },
    /** 펼쳐진 폴더 경로 (예: "경제학", "경제학/거시경제학") — localStorage 영속 */
    expanded: loadExpanded(),
    /** 검색 필터 (소문자) */
    searchTerm: "",
    /** 아카이브 분류 탭 + 계단식 필터 (형식→학문→연도/순환/저자/문제책) */
    archiveTab: '모의고사',
    af: { fmt: '', lv1: '', lv2a: '', lv2b: '', lvJ: '' },
    /** 마지막 캐시 시각 (Date.now()) */
    fetchedAt: 0,
    /** 백그라운드 갱신 중 표시용 */
    refreshing: false,
    /** PWA 설치 프롬프트 (Chrome 이 띄울 준비됐을 때만 set) */
    installPrompt: null,
};

// ─── DOM 헬퍼 ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    $(screenId).classList.remove('hidden');
    $('btn-back').style.display = (screenId === 'screen-doc' || screenId === 'screen-ai') ? '' : 'none';
    $('btn-refresh').style.display = (screenId === 'screen-list') ? '' : 'none';
    const aiBtn = $('btn-ai');
    if (aiBtn) aiBtn.style.display = (screenId === 'screen-list') ? '' : 'none';
}
function setStatus(msg) { $('status-bar').textContent = msg || ""; }

// ─── OAuth + 토큰 영속화 ────────────────────────────────────────────
function storeToken(token, expiresInSeconds) {
    try {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({
            token,
            expiresAt: Date.now() + (Number(expiresInSeconds) || 3600) * 1000,
        }));
    } catch (_) { /* 용량/권한 오류 — 무시 */ }
}
function loadStoredToken() {
    try {
        const raw = localStorage.getItem(TOKEN_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        // 60초 여유로 만료 판정 (Drive 호출 중 만료 회피)
        if (d.expiresAt && d.expiresAt > Date.now() + 60_000) return d.token;
    } catch (_) {}
    return null;
}
function clearStoredToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

function initOAuth() {
    if (!window.google?.accounts?.oauth2) {
        // GSI 가 아직 로드되지 않음 — 조금 뒤 재시도
        setTimeout(initOAuth, 200);
        return;
    }
    state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
            if (resp.error) {
                // silent 재인증 실패는 조용히 무시 — 사용자가 직접 로그인 버튼 누르도록
                if (!state.silentAuthAttempted) {
                    alert("로그인 실패: " + resp.error);
                }
                state.silentAuthAttempted = false;
                return;
            }
            state.accessToken = resp.access_token;
            storeToken(resp.access_token, resp.expires_in);
            onSignedIn();
        }
    });
    // 초기화 직후 — 저장된 토큰이 있으면 자동 진입
    autoSignInIfPossible();
}

function autoSignInIfPossible() {
    // 1) 만료 전 토큰이 있으면 즉시 사용
    const cached = loadStoredToken();
    if (cached) {
        state.accessToken = cached;
        onSignedIn();
        return;
    }
    // 2) 없거나 만료 — silent 재인증 시도 (Google 에 로그인된 상태면 동의 화면 없이 토큰 발급)
    if (!state.tokenClient || GOOGLE_CLIENT_ID.startsWith("<")) return;
    state.silentAuthAttempted = true;
    try {
        state.tokenClient.requestAccessToken({ prompt: '' });
    } catch (_) { state.silentAuthAttempted = false; }
}

function requestSignIn() {
    if (!state.tokenClient) {
        alert("OAuth 클라이언트 초기화 실패. README 의 Client ID 설정을 확인하세요.");
        return;
    }
    if (GOOGLE_CLIENT_ID.startsWith("<")) {
        alert("GOOGLE_CLIENT_ID 가 설정되지 않았습니다. app.js 상단을 수정하세요.");
        return;
    }
    state.silentAuthAttempted = false;
    state.tokenClient.requestAccessToken({ prompt: 'consent' });
}

function signOut() {
    clearStoredToken();
    state.accessToken = null;
    state.grouped = {};
    show('screen-auth');
}

async function onSignedIn() {
    show('screen-list');

    // 1) 캐시가 있으면 *즉시* 표시 (UX 우선)
    const cached = loadCache();
    if (cached) {
        state.grouped = cached.grouped;
        state.encyclopediaTree = cached.encyclopediaTree || { folders: {}, files: [] };
        state.fetchedAt = cached.fetchedAt;
        renderList();
        setStatus(
            `📦 캐시에서 즉시 표시 (총 ${cached.totalFiles}개 파일, ${fmtTimeSince(cached.fetchedAt)} 전 동기화) — 백그라운드 새로고침 중…`
        );
    } else {
        setStatus("Drive 폴더 검색 중…");
    }

    // 2) 백그라운드에서 최신 가져옴
    try {
        if (!state.rootFolderId) {
            state.rootFolderId = await findFolderByName(DRIVE_ROOT_NAME);
        }
        if (!state.rootFolderId) {
            setStatus(`Drive 에서 "${DRIVE_ROOT_NAME}" 폴더를 찾을 수 없습니다. PC 의 Google Drive 데스크톱이 동기화 중인지 확인하세요.`);
            return;
        }
        await loadDocuments(/* hasCache */ !!cached);
    } catch (e) {
        if (!cached) setStatus("오류: " + e.message);
        else setStatus(`📦 캐시 표시 중 — 갱신 실패: ${e.message}`);
    }
}

// ─── 캐시 helpers ────────────────────────────────────────────────────
function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !data.grouped) return null;
        return data;
    } catch (_) { return null; }
}

function saveCache() {
    try {
        const totalFiles = Object.values(state.grouped).reduce(
            (sum, items) => sum + Object.values(items).reduce(
                (s, it) => s + Object.keys(it.files).length, 0), 0);
        const payload = {
            grouped: state.grouped,
            encyclopediaTree: state.encyclopediaTree,
            fetchedAt: state.fetchedAt,
            totalFiles,
        };
        localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (_) { /* 용량 초과 등 — 조용히 무시 */ }
}

function fmtTimeSince(ts) {
    if (!ts) return "?";
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금";
    if (min < 60) return `${min}분`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간`;
    return `${Math.floor(hr / 24)}일`;
}

// ─── Drive API ───────────────────────────────────────────────────────
async function driveFetch(path, params) {
    const url = new URL("https://www.googleapis.com/drive/v3/" + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const resp = await fetch(url.toString(), {
        headers: { "Authorization": "Bearer " + state.accessToken },
    });
    if (resp.status === 401) {
        // 토큰 만료 — 저장 토큰 폐기 + silent 재인증 시도
        clearStoredToken();
        state.accessToken = null;
        autoSignInIfPossible();
        throw new Error("토큰 만료 — 자동 재로그인 시도 중. 잠시 후 새로고침해 주세요.");
    }
    if (!resp.ok) throw new Error("Drive API " + resp.status + " " + resp.statusText);
    return resp.json();
}

async function findFolderByName(name, parentId) {
    const q = [
        `name='${name.replace(/'/g, "\\'")}'`,
        "mimeType='application/vnd.google-apps.folder'",
        "trashed=false",
    ];
    if (parentId) q.push(`'${parentId}' in parents`);
    const res = await driveFetch("files", { q: q.join(" and "), fields: "files(id,name)" });
    return res.files?.[0]?.id || null;
}

async function listAllFilesUnder(folderId, onBatch) {
    /** 하위 폴더까지 재귀로 HTML 파일 전부 수집.
        onBatch(batch[]) 콜백이 있으면 각 폴더 페이지를 받을 때마다 호출 — 점진적 렌더링. */
    const stack = [{ id: folderId, path: [] }];
    while (stack.length) {
        const { id, path } = stack.pop();
        let pageToken;
        do {
            const params = {
                q: `'${id}' in parents and trashed=false`,
                fields: "nextPageToken, files(id,name,mimeType,modifiedTime,size)",
                pageSize: 500,
            };
            if (pageToken) params.pageToken = pageToken;
            const res = await driveFetch("files", params);
            const batch = [];
            for (const f of (res.files || [])) {
                if (f.mimeType === "application/vnd.google-apps.folder") {
                    stack.push({ id: f.id, path: [...path, f.name] });
                } else if (/\.html?$/i.test(f.name) || AUDIO_RE.test(f.name)) {
                    batch.push({
                        id: f.id,
                        name: f.name,
                        mtime: Date.parse(f.modifiedTime),
                        size: Number(f.size) || 0,
                        path: path.join("/"),  // Templum 내부 상대 경로
                        isAudio: AUDIO_RE.test(f.name),
                    });
                }
            }
            if (batch.length && onBatch) onBatch(batch);
            pageToken = res.nextPageToken;
        } while (pageToken);
    }
}

// ─── 항목 정규화 (suffix → kind 매핑) ──────────────────────────────
const SUFFIX_MAP = [
    // 문제(시험) 계열
    ["_요약본.html",      { kind: "summary",       label: "요약본" }],
    ["_종합추출본.html",   { kind: "q_toc_a",       label: "종합답안" }],
    ["_문제목차추출본.html",{ kind: "q_toc",         label: "문제+목차" }],
    ["_문제추출본.html",   { kind: "q_only",        label: "문제" }],
    ["_시험기준.html",     { kind: "exam_criteria", label: "출제 기준" }],
    ["_채점기준.html",     { kind: "grading_criteria", label: "채점 기준" }],
    // 쟁점(문제 외 지식) 계열
    ["_쟁점목차.html",     { kind: "topic_toc",     label: "쟁점목차" }],
    ["_쟁점본문.html",     { kind: "topic_body",    label: "쟁점본문" }],
    ["_쟁점요약.html",     { kind: "topic_summary", label: "쟁점요약" }],
];

function classify(file) {
    for (const [sfx, info] of SUFFIX_MAP) {
        if (file.name.endsWith(sfx)) {
            // base title 추출 — 요약본은 두 단계 접미사 제거
            let base = file.name.slice(0, -sfx.length);
            if (info.kind === "summary") {
                for (const ssfx of ["_종합추출본", "_문제목차추출본", "_문제추출본"]) {
                    if (base.endsWith(ssfx)) { base = base.slice(0, -ssfx.length); break; }
                }
            }
            return { ...info, baseTitle: base };
        }
    }
    // 백과사전 일반 HTML — suffix 없음 → 단일 문서
    return { kind: "plain", label: "열기", baseTitle: file.name.replace(/\.html?$/i, "") };
}

async function loadDocuments(hasCache = false) {
    state.refreshing = true;
    if (!hasCache) setStatus("문서 목록 로드 중… (첫 동기화는 오래 걸릴 수 있습니다)");

    // 점진적 수집 — 폴더 받을 때마다 그룹화 + 부분 렌더
    const groups = {};                                  // archive: subject → groupKey → item
    const encTree = { folders: {}, files: [] };         // encyclopedia: 폴더 트리
    const audioByKey = {};                              // "path|stem" → {id,name,mtime} (낭독 오디오)
    let totalSoFar = 0;

    await listAllFilesUnder(state.rootFolderId, (batch) => {
        for (const f of batch) {
            if (f.isAudio) {
                // 낭독 오디오 — 같은 폴더·같은 stem 의 문서에 연결하기 위해 보관
                audioByKey[`${f.path}|${audioStem(f.name)}`] = { id: f.id, name: f.name, mtime: f.mtime };
                continue;
            }
            const info = classify(f);
            const segs = f.path.split("/").filter(Boolean);

            if (segs[0] === "encyclopedia") {
                // encyclopedia 는 *폴더 트리* 로 — 깊은 계층 그대로 보존
                const folderSegs = segs.slice(1);  // "encyclopedia" 제외
                addFileToTree(encTree, folderSegs, {
                    id: f.id, name: f.name, mtime: f.mtime, size: f.size, path: f.path,
                    baseTitle: info.baseTitle, kind: info.kind, label: info.label,
                });
            } else {
                // archive 구조: archive/{형식}/{과목}/{책폴더}/...  (2026-06 폴더 구조 변경)
                //   · 과목(subject)=segs[2], 책폴더(book)=segs[3].
                //   · 같은 시험의 문제/종합/요약/채점 파일이 형식 폴더로 흩어지므로,
                //     형식을 제외한 (과목|책폴더|제목) 으로 묶어 한 카드에 모은다.
                let subject = "기타", book = "";
                if (segs[0] === "archive") {
                    subject = segs[2] || segs[1] || "기타";
                    book = segs[3] || "";
                } else if (segs[0]) {
                    subject = segs[0];
                    book = segs[1] || "";
                }

                const groupKey = `${subject}|${book}|${info.baseTitle}`;
                groups[subject] = groups[subject] || {};
                const item = groups[subject][groupKey] = groups[subject][groupKey] || {
                    subject, book, baseTitle: info.baseTitle, files: {}, latestMtime: 0, path: f.path,
                };
                item.files[info.kind] = {
                    id: f.id, name: f.name, mtime: f.mtime, size: f.size, path: f.path, label: info.label,
                };
                if (f.mtime > item.latestMtime) item.latestMtime = f.mtime;
            }
        }
        totalSoFar += batch.length;
        if (!hasCache) {
            state.grouped = groups;
            state.encyclopediaTree = encTree;
            renderList();
            setStatus(`📥 동기화 중… ${totalSoFar}개 수집됨`);
        }
    });

    // 낭독 오디오를 같은 폴더·같은 stem 의 문서에 연결 (file.audio = {id,name})
    const linkAudio = (file) => {
        const a = audioByKey[`${file.path}|${docStem(file.name)}`];
        if (a) file.audio = { id: a.id, name: a.name };
    };
    for (const subj of Object.keys(groups)) {
        for (const it of Object.values(groups[subj])) {
            for (const k of Object.keys(it.files)) linkAudio(it.files[k]);
        }
    }
    (function walkTree(node) {
        for (const f of (node.files || [])) linkAudio(f);
        for (const sub of Object.values(node.folders || {})) walkTree(sub);
    })(encTree);

    state.grouped = groups;
    state.encyclopediaTree = encTree;
    state.fetchedAt = Date.now();
    state.refreshing = false;
    saveCache();
    renderList();
    const audioCount = Object.keys(audioByKey).length;
    setStatus(`✅ ${totalSoFar}개 파일 동기화 완료${audioCount ? ` (🔊 음성 ${audioCount})` : ""} (${new Date().toLocaleTimeString('ko-KR')})`);
}

// encyclopedia 트리에 파일 추가 — 폴더 세그먼트 따라 재귀로 들어가며 노드 생성
function addFileToTree(node, folderSegs, file) {
    if (folderSegs.length === 0) {
        node.files.push(file);
        return;
    }
    const [head, ...rest] = folderSegs;
    if (!node.folders[head]) {
        node.folders[head] = { folders: {}, files: [] };
    }
    addFileToTree(node.folders[head], rest, file);
}

// ─── 아카이브 분류 (데스크톱 archive.js 와 동일 기준) ─────────────────
const ARCHIVE_TABS = ['모의고사', '문제책', '쟁점정리집', '기타'];
function arcCategory(item) {
    const f = item.files || {};
    const t = item.baseTitle || '';
    const mockByName = /\d{4}/.test(t) && /\d+\s*순/.test(t) && /\d+\s*회/.test(t);
    if (f.exam_criteria || f.grading_criteria || mockByName) return '모의고사';
    if (f.topic_toc || f.topic_body || f.topic_summary) return '쟁점정리집';
    if (f.q_only || f.q_toc || f.q_toc_a) return '문제책';
    return '기타';
}
const arcFormat = (item) => item.format || '논술형';   // PWA: 내용 미독 → 기본 논술형
function arcDisc(item) {
    if (state.archiveTab === '모의고사' && state.af.fmt === '객관식') {
        const s = `${item.baseTitle || ''} ${item.path || ''}`;
        if (/언어\s*논리/.test(s)) return '언어논리';
        if (/자료\s*해석/.test(s)) return '자료해석';
        if (/상황\s*판단/.test(s)) return '상황판단';
        return '기타';
    }
    return item.subject || '기타';
}
function arcYear(item) { const m = (item.baseTitle || '').match(/(\d{4})/) || (item.path || '').match(/(\d{4})/); return m ? m[1] : '연도미상'; }
function arcCycle(item) { const m = (item.baseTitle || '').match(/(\d+)\s*순/) || (item.path || '').match(/(\d+)\s*순/); return m ? m[1] + '순환' : '순환미상'; }
function arcBook(item) { return item.book || ((item.path || '').split('/').filter(Boolean)[3]) || '기타'; }
function arcAuthor(item) {
    const t = (item.baseTitle || '').replace(/\d{4}/g, ' ').replace(/\d+\s*회/g, ' ').replace(/\d+\s*순환?/g, ' ')
        .replace(/언어\s*논리|자료\s*해석|상황\s*판단|모의고사/g, ' ');
    const toks = t.split(/[\s_]+/).filter(x => /[가-힣A-Za-z]/.test(x) && x.length <= 6);
    return toks.length ? toks[0] : '저자미상';
}
const arcUniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));

function arcChipRow(label, values, active, onPick) {
    const row = document.createElement('div'); row.className = 'arc-chiprow';
    const lab = document.createElement('span'); lab.className = 'arc-lab'; lab.textContent = label;
    row.appendChild(lab);
    [['', '전체'], ...values.map(v => [v, v])].forEach(([val, text]) => {
        const b = document.createElement('button');
        b.className = 'arc-chip' + (active === val ? ' on' : '');
        b.textContent = text;
        b.addEventListener('click', () => onPick(val));
        row.appendChild(b);
    });
    return row;
}

function renderArchiveSection(container, allArcItems, term) {
    const counts = { 모의고사: 0, 문제책: 0, 쟁점정리집: 0, 기타: 0 };
    allArcItems.forEach(it => counts[arcCategory(it)]++);
    if (counts[state.archiveTab] === 0) state.archiveTab = ARCHIVE_TABS.find(t => counts[t] > 0) || '모의고사';

    const wrap = document.createElement('div'); wrap.className = 'subject-group';

    const tabBar = document.createElement('div'); tabBar.className = 'arc-tabbar';
    ARCHIVE_TABS.forEach(t => {
        const b = document.createElement('button');
        b.className = 'arc-tab' + (t === state.archiveTab ? ' on' : '');
        b.textContent = `${t} (${counts[t]})`;
        b.addEventListener('click', () => { state.archiveTab = t; state.af = { fmt: '', lv1: '', lv2a: '', lv2b: '', lvJ: '' }; renderList(); });
        tabBar.appendChild(b);
    });
    wrap.appendChild(tabBar);

    const tab = state.archiveTab, af = state.af;
    const tabItems = allArcItems.filter(it => arcCategory(it) === tab);
    let finalItems = tabItems;

    if (tab === '쟁점정리집') {
        wrap.appendChild(arcChipRow('학문', arcUniq(tabItems.map(it => it.subject)), af.lvJ, v => { af.lvJ = v; renderList(); }));
        finalItems = tabItems.filter(it => !af.lvJ || it.subject === af.lvJ);
    } else if (tab === '기타') {
        finalItems = tabItems;
    } else {
        const fmtRow = document.createElement('div'); fmtRow.className = 'arc-chiprow';
        const lab = document.createElement('span'); lab.className = 'arc-lab'; lab.textContent = '형식'; fmtRow.appendChild(lab);
        [['논술형', '논술형'], ['객관식', '객관식']].forEach(([val, label]) => {
            const cnt = tabItems.filter(it => arcFormat(it) === val).length;
            const b = document.createElement('button'); b.className = 'arc-chip fmt' + (af.fmt === val ? ' on' : '');
            b.textContent = `${label} (${cnt})`;
            b.addEventListener('click', () => { af.fmt = (af.fmt === val ? '' : val); af.lv1 = ''; af.lv2a = ''; af.lv2b = ''; renderList(); });
            fmtRow.appendChild(b);
        });
        wrap.appendChild(fmtRow);

        if (!af.fmt) {
            finalItems = tabItems;
        } else {
            const fmtItems = tabItems.filter(it => arcFormat(it) === af.fmt);
            wrap.appendChild(arcChipRow('학문', arcUniq(fmtItems.map(arcDisc)), af.lv1, v => { af.lv1 = v; af.lv2a = ''; af.lv2b = ''; renderList(); }));
            if (!af.lv1) {
                finalItems = fmtItems;
            } else {
                const discItems = fmtItems.filter(it => arcDisc(it) === af.lv1);
                if (tab === '모의고사' && af.fmt === '객관식') {
                    wrap.appendChild(arcChipRow('연도', arcUniq(discItems.map(arcYear)), af.lv2a, v => { af.lv2a = v; renderList(); }));
                    wrap.appendChild(arcChipRow('저자', arcUniq(discItems.map(arcAuthor)), af.lv2b, v => { af.lv2b = v; renderList(); }));
                    finalItems = discItems.filter(it => (!af.lv2a || arcYear(it) === af.lv2a) && (!af.lv2b || arcAuthor(it) === af.lv2b));
                } else if (tab === '모의고사') {
                    wrap.appendChild(arcChipRow('연도', arcUniq(discItems.map(arcYear)), af.lv2a, v => { af.lv2a = v; renderList(); }));
                    wrap.appendChild(arcChipRow('순환', arcUniq(discItems.map(arcCycle)), af.lv2b, v => { af.lv2b = v; renderList(); }));
                    finalItems = discItems.filter(it => (!af.lv2a || arcYear(it) === af.lv2a) && (!af.lv2b || arcCycle(it) === af.lv2b));
                } else {
                    wrap.appendChild(arcChipRow('문제책', arcUniq(discItems.map(arcBook)), af.lv2b, v => { af.lv2b = v; renderList(); }));
                    finalItems = discItems.filter(it => !af.lv2b || arcBook(it) === af.lv2b);
                }
            }
        }
    }

    let items = finalItems.filter(it => !term || (it.baseTitle || '').toLowerCase().includes(term) || (it.subject || '').toLowerCase().includes(term));
    items.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'ko', { numeric: true }) || (a.baseTitle || '').localeCompare(b.baseTitle || '', 'ko', { numeric: true }));

    const cnt = document.createElement('div'); cnt.className = 'arc-count';
    cnt.textContent = `📚 ${tab} ${items.length}개`;
    wrap.appendChild(cnt);

    items.forEach(it => wrap.appendChild(buildItemCard(it)));
    container.appendChild(wrap);
    return items.length;
}

// ─── 렌더링 ─────────────────────────────────────────────────────────
function renderList() {
    const container = $('item-list');
    container.innerHTML = "";

    const term = state.searchTerm.trim().toLowerCase();
    let totalShown = 0;

    // ── 1. encyclopedia 트리 (인라인 아코디언) — 위로 ──
    const encTree = state.encyclopediaTree;
    const hasEnc = !!encTree && (Object.keys(encTree.folders).length || encTree.files.length);
    if (hasEnc) {
        const encShown = countTreeMatches(encTree, term);
        if (encShown > 0) {
            const encGrp = document.createElement('div');
            encGrp.className = "subject-group";
            const encH = document.createElement('h3');
            encH.textContent = `📖 백과사전 (${encShown})`;
            encGrp.appendChild(encH);
            // 루트 폴더의 자식들 직접 렌더 (루트 폴더 자체는 토글 없음)
            renderTreeChildren(encGrp, encTree, "", 0, term);
            container.appendChild(encGrp);
            totalShown += encShown;
        }
    }

    // ── 2. archive — 4탭 + 계단식 필터 (모의고사/문제책/쟁점정리집/기타) ──
    const allArcItems = [];
    for (const subj of Object.keys(state.grouped)) {
        for (const it of Object.values(state.grouped[subj])) allArcItems.push(it);
    }
    if (allArcItems.length) {
        totalShown += renderArchiveSection(container, allArcItems, term);
    }

    if (totalShown === 0) {
        container.innerHTML = term
            ? `<div class="hint">"${escapeHtml(term)}" 와 일치하는 문서가 없습니다.</div>`
            : `<div class="hint">동기화된 문서가 없습니다. PC 에서 archive/encyclopedia 폴더가 Drive 의 Templum 안에 들어 있는지 확인하세요.</div>`;
    }
}

// 트리 노드 안의 *매칭되는* 파일 개수 (검색어 적용)
function countTreeMatches(node, term) {
    let n = 0;
    for (const f of (node.files || [])) {
        if (!term || f.baseTitle.toLowerCase().includes(term) || f.name.toLowerCase().includes(term)) n++;
    }
    for (const [folderName, subnode] of Object.entries(node.folders || {})) {
        // 폴더 이름 자체가 매칭되면 그 안 *전체* 카운트
        if (term && folderName.toLowerCase().includes(term)) {
            n += countTreeMatches(subnode, "");  // 검색어 없이 전체 카운트
        } else {
            n += countTreeMatches(subnode, term);
        }
    }
    return n;
}

// 폴더 노드의 자식들을 부모 컨테이너에 *직접* 추가 (들여쓰기 깊이 = depth)
function renderTreeChildren(parentEl, node, pathPrefix, depth, term) {
    // 폴더 먼저 (이름 순)
    const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b, 'ko'));
    for (const name of folderNames) {
        const subnode = node.folders[name];
        const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;
        // 검색어 적용 — 폴더 이름이 일치하지 않고 안에도 매칭 없으면 스킵
        const matchInside = countTreeMatches(subnode, term);
        const folderMatches = term && name.toLowerCase().includes(term);
        if (term && !folderMatches && matchInside === 0) continue;

        parentEl.appendChild(buildFolderRow(name, subnode, fullPath, depth, term));
    }
    // 그 뒤 파일들 (이름 순)
    const files = (node.files || []).slice().sort((a, b) => a.baseTitle.localeCompare(b.baseTitle, 'ko'));
    for (const f of files) {
        if (term && !f.baseTitle.toLowerCase().includes(term) && !f.name.toLowerCase().includes(term)) continue;
        parentEl.appendChild(buildFileRow(f, depth));
    }
}

function buildFolderRow(name, subnode, fullPath, depth, term) {
    const wrap = document.createElement('div');
    wrap.className = "tree-folder";
    wrap.style.setProperty('--depth', String(depth));

    const header = document.createElement('div');
    header.className = "tree-folder-header";
    const isOpen = state.expanded.has(fullPath) || (term && term.length > 0);  // 검색 중엔 전부 펼침
    const folderCount = countTreeMatches(subnode, term);

    header.innerHTML = `
        <span class="tree-arrow">${isOpen ? '▼' : '▶'}</span>
        <span class="tree-icon">📁</span>
        <span class="tree-label">${escapeHtml(name)}</span>
        <span class="tree-count">${folderCount}</span>
    `;
    header.addEventListener('click', () => {
        if (state.expanded.has(fullPath)) state.expanded.delete(fullPath);
        else state.expanded.add(fullPath);
        saveExpanded();
        renderList();
    });
    wrap.appendChild(header);

    if (isOpen) {
        const children = document.createElement('div');
        children.className = "tree-children";
        renderTreeChildren(children, subnode, fullPath, depth + 1, term);
        wrap.appendChild(children);
    }
    return wrap;
}

function buildFileRow(file, depth) {
    const wrap = document.createElement('div');
    wrap.className = "tree-file";
    wrap.style.setProperty('--depth', String(depth));
    wrap.innerHTML = `
        <span class="tree-arrow"></span>
        <span class="tree-icon">📄</span>
        <span class="tree-label">${escapeHtml(file.baseTitle)}</span>
    `;
    wrap.addEventListener('click', () => openDocument(file));
    return wrap;
}

function buildItemCard(item) {
    const card = document.createElement('div');
    card.className = "item-card";

    const title = document.createElement('div');
    title.className = "item-title";
    title.textContent = item.baseTitle;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = "item-meta";
    if (item.latestMtime) {
        meta.textContent = new Date(item.latestMtime).toLocaleString('ko-KR', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    }
    card.appendChild(meta);

    const row = document.createElement('div');
    row.className = "btn-row";

    // 쟁점 파일만 있으면 쟁점 버튼 셋, 아니면 시험 버튼 셋
    const hasTopic = !!(item.files.topic_toc || item.files.topic_body || item.files.topic_summary);
    const hasExam = !!(item.files.q_only || item.files.q_toc || item.files.q_toc_a
                       || item.files.summary || item.files.exam_criteria || item.files.grading_criteria);

    let kinds;
    if (hasTopic && !hasExam) {
        kinds = ["topic_toc", "topic_body", "topic_summary"];
    } else if (hasExam) {
        kinds = ["q_only", "q_toc", "q_toc_a", "summary"];
        if (item.files.exam_criteria) kinds.push("exam_criteria");
        if (item.files.grading_criteria) kinds.push("grading_criteria");
    } else {
        kinds = ["plain"];
    }

    for (const kind of kinds) {
        const f = item.files[kind];
        const btn = document.createElement('button');
        btn.className = "doc-btn";
        btn.textContent = (f?.label) || labelOf(kind);
        if (!f) btn.disabled = true;
        else btn.addEventListener('click', () => openDocument(f));
        row.appendChild(btn);
    }
    card.appendChild(row);
    return card;
}

function labelOf(kind) {
    const item = SUFFIX_MAP.find(([_, v]) => v.kind === kind);
    return item ? item[1].label : kind;
}

// ─── 문서 열람 ──────────────────────────────────────────────────────
async function openDocument(file) {
    show('screen-doc');
    stopDocPlayback();
    $('title').textContent = file.name;
    $('doc-content').innerHTML = `<div class="hint"><span class="spinner"></span> 문서 로드 중…</div>`;

    // 안드로이드 시스템 뒤로가기 처리용 — 히스토리에 'doc' 상태 push.
    // 사용자가 폰 하단 < 버튼 누르면 popstate 발화 → 자동으로 목록으로 복귀.
    if (!history.state || history.state.screen !== 'doc') {
        history.pushState({ screen: 'doc' }, '', '#doc');
    }
    setupAudioBar(file);
    try {
        const html = await fetchFileContent(file);
        state.currentDocHtml = html;   // 📖 낭독이 원본 HTML 에서 규칙대로 정규화하도록 보관
        // body 내용만 추출 (외부 HTML 의 head/style 은 무시 — 안전성 ↑)
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        const inner = bodyMatch ? bodyMatch[1] : html;
        $('doc-content').innerHTML = inner;
        // MathJax 재실행 (수식 렌더)
        if (window.MathJax?.typesetPromise) {
            window.MathJax.typesetPromise([$('doc-content')]).catch(() => {});
        }
    } catch (e) {
        $('doc-content').innerHTML = `<div class="hint" style="color:#c0392b;">오류: ${escapeHtml(e.message)}</div>`;
    }
}

// ─── 낭독 / 저장된 음성파일 재생 ────────────────────────────────────
let _docAudioEl = null;     // 현재 <audio> 엘리먼트
let _docBlobUrl = null;     // 현재 blob: URL (재생 종료 시 해제)
let _speaking = false;      // Web Speech 낭독 진행중 여부

// 문서를 떠나거나 새 문서를 열 때 — 재생/낭독 전부 정지 + 리소스 해제
function stopDocPlayback() {
    try { if (_docAudioEl) { _docAudioEl.pause(); _docAudioEl.src = ""; } } catch (_) {}
    _docAudioEl = null;
    if (_docBlobUrl) { try { URL.revokeObjectURL(_docBlobUrl); } catch (_) {} _docBlobUrl = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (_) {} }
    _speaking = false;
}

// 문서 상단 컨트롤 바 구성: (있으면) 저장된 음성 재생 + 브라우저 낭독
function setupAudioBar(file) {
    const bar = $('doc-audiobar');
    if (!bar) return;
    bar.innerHTML = "";
    bar.style.display = "";

    // ① 저장된 음성파일(낭독 mp3) — 데스크톱에서 생성·Drive 동기화된 파일
    if (file && file.audio) {
        const loadBtn = document.createElement('button');
        loadBtn.className = "audio-btn";
        loadBtn.textContent = "🔊 저장된 음성 재생";
        loadBtn.addEventListener('click', () => playSavedAudio(file.audio, bar, loadBtn));
        bar.appendChild(loadBtn);
    }

    // ② 브라우저 낭독 (Web Speech) — 저장 음성이 없어도 본문을 읽어줌
    if ('speechSynthesis' in window) {
        const ttsBtn = document.createElement('button');
        ttsBtn.className = "audio-btn tts";
        ttsBtn.textContent = "📖 낭독";
        ttsBtn.addEventListener('click', () => toggleSpeak(ttsBtn));
        bar.appendChild(ttsBtn);
    }

    if (!bar.childElementCount) bar.style.display = "none";
}

// 저장된 mp3 를 Drive 에서 blob 으로 받아 <audio> 로 재생 (인증 헤더 필요 → 직접 src 불가)
async function playSavedAudio(audio, bar, loadBtn) {
    stopDocPlayback();
    loadBtn.disabled = true;
    loadBtn.textContent = "⏳ 음성 불러오는 중…";
    try {
        const url = `https://www.googleapis.com/drive/v3/files/${audio.id}?alt=media`;
        const resp = await fetch(url, { headers: { "Authorization": "Bearer " + state.accessToken } });
        if (!resp.ok) throw new Error("음성 다운로드 " + resp.status);
        const blob = await resp.blob();
        _docBlobUrl = URL.createObjectURL(blob);
        const el = document.createElement('audio');
        el.controls = true;
        el.autoplay = true;
        el.className = "doc-audio";
        el.src = _docBlobUrl;
        _docAudioEl = el;
        loadBtn.replaceWith(el);
        el.play().catch(() => {});
    } catch (e) {
        loadBtn.disabled = false;
        loadBtn.textContent = "⚠️ 재생 실패 — 다시 시도";
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 낭독 텍스트 정규화 — 데스크톱 tts_common.normalize 를 그대로 이식.
//   폰의 '일반 낭독(📖)'이 컴퓨터 낭독과 *동일한 규칙*을 따르게 한다:
//   수식(LaTeX)→한국어, 조문 띄우기, 약어 철자, 한 글자 영문→한글 이름,
//   '의'→[에] 자연화, 오독 교정, 연도 '년', 로마숫자, 원어괄호 제거,
//   출처주석 미독, 줄/개요 경계 쉼표 끊어읽기 등.
//   ⚠️ innerText 가 아니라 *원본 HTML* 에서 변환해야 LaTeX 등이 살아있다.
// ═══════════════════════════════════════════════════════════════════════
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

// 브라우저 내장 음성으로 본문 낭독 (토글) — 데스크톱과 동일 규칙으로 다듬어 읽는다.
function toggleSpeak(btn) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (_speaking) {
        synth.cancel();
        _speaking = false;
        btn.textContent = "📖 낭독";
        return;
    }
    // 저장 음성이 돌고 있으면 멈춤
    if (_docAudioEl) { try { _docAudioEl.pause(); } catch (_) {} }
    // 원본 HTML 에서 컴퓨터 낭독과 동일 규칙으로 정규화 (LaTeX·조문·약어·'의'→에·쉼 등)
    let text = "";
    try { if (state.currentDocHtml) text = ttsHtmlToText(state.currentDocHtml); } catch (_) {}
    if (!text) text = ($('doc-content').innerText || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const chunks = ttsChunkLines(text);
    let i = 0;
    const speakNext = () => {
        if (i >= chunks.length) { _speaking = false; btn.textContent = "📖 낭독"; return; }
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        u.lang = "ko-KR";
        u.rate = 0.95;
        u.onend = speakNext;
        u.onerror = () => { _speaking = false; btn.textContent = "📖 낭독"; };
        synth.speak(u);
    };
    _speaking = true;
    btn.textContent = "⏹ 낭독 멈춤";
    speakNext();
}

async function fetchFileContent(file) {
    // 서비스워커가 이미 캐시했으면 그쪽이 응답. 아니면 Drive API.
    const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    const resp = await fetch(url, {
        headers: { "Authorization": "Bearer " + state.accessToken },
    });
    if (!resp.ok) throw new Error("Drive 다운로드 " + resp.status);
    return resp.text();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// 종료 안내 토스트 — 2초간 화면 하단에 표시
let _exitToastEl = null;
let _exitToastTimer = null;
function showExitToast() {
    if (!_exitToastEl) {
        _exitToastEl = document.createElement('div');
        _exitToastEl.className = "exit-toast";
        _exitToastEl.textContent = "한 번 더 뒤로가기를 누르면 종료됩니다";
        document.body.appendChild(_exitToastEl);
    }
    _exitToastEl.style.display = '';
    if (_exitToastTimer) clearTimeout(_exitToastTimer);
    _exitToastTimer = setTimeout(() => {
        if (_exitToastEl) _exitToastEl.style.display = 'none';
    }, 2000);
}

// ─── PWA 설치 프롬프트 ──────────────────────────────────────────────
// Chrome (안드로이드/데스크톱) 은 PWA 가 설치 가능할 때 `beforeinstallprompt` 를 발화시킴.
// 우리는 그 이벤트를 *낚아채서 보관* 했다가 사용자가 버튼을 누를 때 prompt() 호출.
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    const btn = $('btn-install');
    if (btn) btn.style.display = "";
});
window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    const btn = $('btn-install');
    if (btn) btn.style.display = "none";
});

async function tryInstall() {
    if (!state.installPrompt) {
        // 안드로이드 Chrome 이 자동으로 안 띄웠거나, 이미 설치됨, 또는 지원 안 함
        alert(
            "설치 가능 상태가 아닙니다.\n\n" +
            "확인사항:\n" +
            "  • Chrome 메뉴(⋮) → '앱 설치' 가 있는지 보세요.\n" +
            "  • 이미 설치돼 있을 수도 있습니다.\n" +
            "  • iOS Safari 는 '공유 → 홈 화면에 추가' 로 설치하세요."
        );
        return;
    }
    state.installPrompt.prompt();
    const result = await state.installPrompt.userChoice;
    if (result?.outcome === 'accepted') {
        state.installPrompt = null;
        $('btn-install').style.display = "none";
    }
}

// ═════════════════════════════════════════════════════════════════════
// 문서 AI — 동기화된 문서 내용에 *근거하여* 질문에 답하는 가벼운 RAG.
//   데스크톱 unified_ai.py 의 깔때기(키워드→재선별→전문로드→답변)를
//   임베딩 인덱스 없이 모바일에서 재현. 외부 SDK 없이 Gemini REST 직접 호출.
//     ① 로드된 문서 목록(제목·경로)에서 키워드 점수화 → 후보 추림
//     ② 저비용 모델로 재선별(가장 관련 있는 문서 번호만)
//     ③ 선택 문서 본문을 Drive 에서 받아 텍스트로 정제
//     ④ 자료에만 근거하도록 지시 + 출처 명시하여 답변 생성
// ═════════════════════════════════════════════════════════════════════
const AI_KEY_LS = "templum.geminiApiKey";
const AI_MODEL_LS = "templum.aiModel";
const AI_DEFAULT_MODEL = "gemini-3-flash-preview";   // 데스크톱 통합 AI 기본 답변 모델과 동일
const AI_CHEAP_MODEL = "gemini-3.1-flash-lite";       // 재선별용 저비용 모델
const AI_MAX_DOCS = 6;          // 답변에 넣을 최대 문서 수
const AI_CAND = 40;             // 제목·경로 기반 1차 후보 수
const AI_READ = 12;             // 본문을 실제로 읽어 내용 채점할 문서 수
const AI_DOC_CHARS = 3500;      // 문서 1개당 컨텍스트(관련 단락) 최대 글자
let aiBusy = false;

function getAiKey() { try { return (localStorage.getItem(AI_KEY_LS) || "").trim(); } catch (_) { return ""; } }
function getAiModel() { try { return (localStorage.getItem(AI_MODEL_LS) || "").trim() || AI_DEFAULT_MODEL; } catch (_) { return AI_DEFAULT_MODEL; } }
function promptAiKey() {
    const v = prompt("Google Gemini API 키를 입력하세요\n(데스크톱 프로그램의 gemini_api_key.txt 와 동일한 키):", getAiKey());
    if (v != null) { try { localStorage.setItem(AI_KEY_LS, v.trim()); } catch (_) {} }
    return getAiKey();
}
function promptAiModel() {
    const v = prompt("AI 답변에 사용할 Gemini 모델명:\n(예: gemini-3-flash-preview, gemini-3.5-pro 등)", getAiModel());
    if (v != null && v.trim()) { try { localStorage.setItem(AI_MODEL_LS, v.trim()); } catch (_) {} }
}

// 로드된 문서들을 평탄화 — {id, title, path, mtime}. 아카이브 그룹은 내용이 풍부한 대표 1개만.
function flattenDocs() {
    const docs = [];
    (function walk(node) {
        for (const f of (node.files || [])) {
            docs.push({ id: f.id, title: f.baseTitle || f.name, path: f.path || "encyclopedia", mtime: f.mtime || 0 });
        }
        for (const sub of Object.values(node.folders || {})) walk(sub);
    })(state.encyclopediaTree || { folders: {}, files: [] });

    const PREF = ["topic_body", "q_toc_a", "topic_summary", "summary", "q_toc", "q_only", "grading_criteria", "exam_criteria", "topic_toc", "plain"];
    for (const subj of Object.keys(state.grouped || {})) {
        for (const it of Object.values(state.grouped[subj])) {
            let chosen = null;
            for (const k of PREF) { if (it.files[k]) { chosen = it.files[k]; break; } }
            if (!chosen) { const ks = Object.keys(it.files); if (ks.length) chosen = it.files[ks[0]]; }
            if (chosen) docs.push({ id: chosen.id, title: it.baseTitle, path: it.path || subj, mtime: it.latestMtime || 0 });
        }
    }
    return docs;
}

function _bigrams(s) { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; }

// 키워드 점수화 — 제목 일치 +3, 경로 일치 +1. 결과가 빈약하면 글자 바이그램 겹침으로 보강.
function scoreDocs(docs, query) {
    const ql = query.toLowerCase();
    const tokens = ql.split(/[\s,.?!()\[\]{}'"·…:;/\\、，。]+/).filter(t => t.length >= 2);
    const scored = docs.map(d => {
        const t = (d.title || "").toLowerCase(), p = (d.path || "").toLowerCase();
        let s = 0;
        for (const tok of tokens) { if (t.includes(tok)) s += 3; if (p.includes(tok)) s += 1; }
        return { d, s };
    });
    let pos = scored.filter(x => x.s > 0);
    if (pos.length < 5) {
        const qbi = _bigrams(ql.replace(/\s+/g, ""));
        for (const x of scored) {
            if (x.s > 0) continue;
            const tb = _bigrams((x.d.title || "").toLowerCase());
            let o = 0; for (const g of qbi) if (tb.has(g)) o++;
            x.s = o * 0.5;
        }
        pos = scored.filter(x => x.s > 0);
    }
    pos.sort((a, b) => b.s - a.s || (b.d.mtime || 0) - (a.d.mtime || 0));
    return pos.map(x => x.d);
}

// Gemini REST 호출 (브라우저 직접). x-goog-api-key 헤더 + CORS 허용 엔드포인트.
async function geminiGenerate(model, promptText, maxTokens) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": getAiKey() },
        body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens || 4096 },
        }),
    });
    if (!resp.ok) {
        let body = ""; try { body = await resp.text(); } catch (_) {}
        throw new Error(`AI ${resp.status}: ${body.slice(0, 300) || resp.statusText}`);
    }
    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts;
    return parts ? parts.map(p => p.text || "").join("") : "";
}

// 후보 문서 중 질문에 가장 관련 있는 번호만 저비용 모델로 재선별.
async function rerankDocs(query, cands) {
    const list = cands.map((d, i) => `${i}: ${d.title} — ${d.path}`).join("\n");
    const p = `다음은 학습 문서 후보 목록입니다. 사용자 질문에 답하는 데 가장 도움이 될 문서의 번호만 고르세요.\n\n` +
        `질문: ${query}\n\n후보:\n${list}\n\n` +
        `관련도 높은 순으로 최대 ${AI_MAX_DOCS}개의 번호를 JSON 배열로만 출력하세요 (예: [3,0,7]). 설명·다른 말 금지.`;
    const out = await geminiGenerate(AI_CHEAP_MODEL, p, 200);
    const m = out.match(/\[[\d,\s]*\]/);
    if (!m) return [];
    try {
        const arr = JSON.parse(m[0]);
        return arr.filter(n => Number.isInteger(n) && n >= 0 && n < cands.length);
    } catch (_) { return []; }
}

// 질문 → 검색 특징(중복 제거 토큰 + 글자 바이그램). 본문 채점·단락 추출에서 공용 사용.
function queryFeatures(query) {
    const ql = (query || "").toLowerCase();
    const tokens = [...new Set(
        ql.split(/[\s,.?!()\[\]{}'"·…:;/\\、，。~"'\-]+/).filter(t => t.length >= 2)
    )];
    return { tokens, qbi: _bigrams(ql.replace(/\s+/g, "")) };
}

// Drive 문서 HTML → 본문 텍스트. 블록 경계마다 줄바꿈을 남겨 *단락 추출*이 가능하도록 함.
async function fetchDocBody(doc) {
    const html = await fetchFileContent({ id: doc.id });
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let inner = bodyMatch ? bodyMatch[1] : html;
    inner = inner
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<img[^>]*>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|td|th|caption)>/gi, "\n");
    return inner.replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[^\S\n]+/g, " ")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

// 본문 전체의 질문 관련도 — 등장한 *서로 다른 토큰 수(coverage)* 를 크게 가중 + 총 등장수.
function contentScore(text, tokens) {
    if (!text || !tokens.length) return 0;
    const l = text.toLowerCase();
    let cover = 0, hits = 0;
    for (const t of tokens) {
        const c = l.split(t).length - 1;
        if (c > 0) { cover++; hits += Math.min(c, 5); }
    }
    return cover * 5 + hits;
}

// 한 줄(단락)의 점수 — 토큰 포함 여부 + 반복 등장 가중.
function lineScore(line, tokens) {
    const l = line.toLowerCase();
    let s = 0;
    for (const t of tokens) {
        const c = l.split(t).length - 1;
        if (c > 0) s += 2 + Math.min(2, c - 1);
    }
    return s;
}

// 본문에서 *질문과 관련된 단락만* 골라 budget 글자 이내로 추려 컨텍스트로. (앞부분 통째로 넣지 않음)
function extractPassages(text, tokens, budget) {
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 1);
    if (!lines.length) return text.slice(0, budget);
    const hits = lines
        .map((l, i) => ({ i, s: lineScore(l, tokens) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s);
    if (!hits.length) return text.slice(0, budget) + (text.length > budget ? " …" : "");

    // 점수 높은 줄 주변(±1)을 문맥과 함께 예산 안에서 수집 → 원래 순서로 복원.
    const picked = new Map();
    let used = 0;
    for (const h of hits) {
        for (let j = Math.max(0, h.i - 1); j <= Math.min(lines.length - 1, h.i + 1); j++) {
            if (picked.has(j)) continue;
            if (used + lines[j].length > budget && picked.size) continue;
            picked.set(j, lines[j]);
            used += lines[j].length;
        }
        if (used >= budget) break;
    }
    const idxs = [...picked.keys()].sort((a, b) => a - b);
    let out = "", prev = -2;
    for (const j of idxs) {
        out += (j === prev + 1 ? "\n" : (out ? "\n…\n" : "")) + lines[j];
        prev = j;
    }
    return out.length > budget ? out.slice(0, budget) + " …" : out;
}

function buildAnswerPrompt(query, context) {
    return (
        "당신은 통합 학습 도우미입니다. 아래 자료(동기화된 문서)에만 근거하여 한국어로 답변하세요.\n" +
        "답변 시 출처를 밝히세요: 각 자료 머리의 [출처: ...] 표기를 활용해 답변 끝에 사용한 문서를 적으세요.\n" +
        "자료에 없는 내용은 추측하지 말고 '해당 내용을 자료에서 찾을 수 없습니다.'라고 답하세요.\n" +
        "수식은 인라인 \\( ... \\), 블록 \\[ ... \\] (MathJax/LaTeX 호환) 으로 쓰세요.\n\n" +
        "=== 검색된 자료 ===\n" + context + "\n=================\n\n" +
        "=== 질문 ===\n" + query
    );
}

// ─── AI 채팅 화면 ────────────────────────────────────────────────────
function aiAppend(role, text, sources) {
    const chat = $('ai-chat');
    const div = document.createElement('div');
    div.className = 'ai-msg ai-' + role;
    if (role === 'user' || role === 'sys') {
        div.textContent = text;
    } else {
        let html = formatAnswer(text);
        if (sources && sources.length) {
            html += `<div class="ai-src">📄 ${sources.map(s => escapeHtml(s.title)).join(' · ')}</div>`;
        }
        div.innerHTML = html;
        if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([div]).catch(() => {});
    }
    chat.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
    return div;
}
function aiWait(msg) {
    const chat = $('ai-chat');
    const div = document.createElement('div');
    div.className = 'ai-msg ai-wait';
    div.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
    chat.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
    return div;
}
function aiWaitSet(el, msg) { if (el) el.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`; window.scrollTo(0, document.body.scrollHeight); }
function aiWaitFail(el, msg) { if (el) el.innerHTML = `<span style="color:#c0392b;">⚠️ ${escapeHtml(msg)}</span>`; window.scrollTo(0, document.body.scrollHeight); }
function aiWaitRemove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

function formatAnswer(text) {
    let s = escapeHtml(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/\n/g, '<br>');
    return s;
}

function aiGreetIfEmpty() {
    const chat = $('ai-chat');
    if (chat.childElementCount > 0) return;
    if (!getAiKey()) {
        aiAppend('sys', '먼저 우측 상단 🔑 버튼으로 Gemini API 키를 설정하세요. 동기화된 문서 내용에만 근거해 답변합니다.');
    } else {
        aiAppend('sys', '동기화된 문서 내용에 대해 질문하세요. 자료에 근거해 답하고 출처를 함께 보여줍니다.');
    }
}

function clearAiChat() { $('ai-chat').innerHTML = ''; aiGreetIfEmpty(); }

function openAI() {
    show('screen-ai');
    $('title').textContent = '🤖 문서 AI';
    if (!history.state || history.state.screen !== 'ai') {
        history.pushState({ screen: 'ai' }, '', '#ai');
    }
    aiGreetIfEmpty();
    setTimeout(() => $('ai-input')?.focus(), 120);
}

async function askAI() {
    if (aiBusy) return;
    const input = $('ai-input');
    const q = (input.value || '').trim();
    if (!q) return;
    if (!getAiKey()) { if (!promptAiKey()) return; }

    aiBusy = true;
    input.value = '';
    $('ai-send').disabled = true;
    aiAppend('user', q);
    const wait = aiWait('질문 분석 중…');
    try {
        const docs = flattenDocs();
        if (!docs.length) {
            aiWaitFail(wait, '동기화된 문서가 없습니다. 먼저 목록 화면에서 문서를 동기화하세요.');
            return;
        }
        aiWaitSet(wait, '관련 문서 검색 중…');
        // ① 제목·경로 키워드로 후보를 넓게 추림
        const cands = scoreDocs(docs, q).slice(0, AI_CAND);
        if (!cands.length) {
            aiWaitFail(wait, '질문과 관련된 문서를 찾지 못했습니다. 다른 표현으로 질문해 보세요.');
            return;
        }

        // ② 저비용 모델 재선별로 *본문 읽을 문서* 선정 + 제목 상위를 합쳐 회수율 보강
        let toRead = cands.slice(0, AI_READ);
        try {
            aiWaitSet(wait, '문서 선별 중…');
            const picks = await rerankDocs(q, cands);
            if (picks.length) {
                const ranked = picks.map(i => cands[i]).filter(Boolean);
                const seen = new Set(ranked.map(d => d.id));
                for (const d of cands.slice(0, 6)) { if (!seen.has(d.id)) { ranked.push(d); seen.add(d.id); } }
                toRead = ranked.slice(0, AI_READ);
            }
        } catch (_) { /* 재선별 실패 시 키워드 상위 사용 */ }

        // ③ 본문을 실제로 읽어 *내용 점수*로 재랭킹 (제목엔 없지만 본문에 답이 있는 문서를 살림)
        aiWaitSet(wait, `자료 읽는 중… (문서 ${toRead.length}개)`);
        const feats = queryFeatures(q);
        const read = (await Promise.all(toRead.map(d =>
            fetchDocBody(d)
                .then(text => ({ d, text, score: contentScore(text, feats.tokens) }))
                .catch(() => null)
        ))).filter(Boolean);
        if (!read.length) { aiWaitFail(wait, '선택된 문서를 불러오지 못했습니다.'); return; }

        read.sort((a, b) => b.score - a.score);
        let chosen = read.filter(x => x.score > 0).slice(0, AI_MAX_DOCS);
        if (!chosen.length) chosen = read.slice(0, AI_MAX_DOCS);  // 본문 적중 0건이면 상위라도 사용

        // ④ 각 문서에서 질문 관련 단락만 추출해 컨텍스트 구성
        const ctxParts = chosen.map(x =>
            `[출처: ${x.d.title}] (경로: ${x.d.path})\n${extractPassages(x.text, feats.tokens, AI_DOC_CHARS)}`
        );

        aiWaitSet(wait, '답변 생성 중…');
        const answer = await geminiGenerate(getAiModel(), buildAnswerPrompt(q, ctxParts.join('\n\n---\n\n')), 4096);
        aiWaitRemove(wait);
        aiAppend('ai', answer || '답변을 생성하지 못했습니다.', chosen.map(x => x.d));
    } catch (e) {
        aiWaitFail(wait, e.message || String(e));
    } finally {
        aiBusy = false;
        $('ai-send').disabled = false;
        input.focus();
    }
}

// ─── 이벤트 바인딩 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // 저장 토큰 있으면 인증 화면 깜빡임 없이 바로 목록 화면으로
    const hasCachedToken = !!loadStoredToken();
    show(hasCachedToken ? 'screen-list' : 'screen-auth');
    initOAuth();
    $('btn-signin').addEventListener('click', requestSignIn);
    // 인앱 ← 버튼 — 시스템 뒤로가기와 동일하게 history.back()
    $('btn-back').addEventListener('click', () => history.back());

    // ── History 초기 상태 세팅 ──
    // 시스템 뒤로가기를 *2단계로 처리* 하기 위해 sentinel 을 history 바닥에 깔아둠.
    //   [list-bottom (sentinel)] → [list (사용자 시작 위치)] → [doc (문서 열람)]
    //   · 문서에서 ← → list 로 복귀
    //   · 목록에서 ← → list-bottom 으로 갔다가 toast + 재푸시 (앱 안 꺼짐)
    //   · 2초 내 한 번 더 ← → 재푸시 없이 list-bottom 에 머물고 다음 ← 에서 앱 종료
    if (!history.state || history.state.screen !== 'list') {
        history.replaceState({ screen: 'list-bottom' }, '', location.pathname);
        history.pushState({ screen: 'list' }, '', '#list');
    }

    let lastBackPress = 0;
    window.addEventListener('popstate', (e) => {
        const st = e.state || {};
        const docScreen = document.getElementById('screen-doc');
        const onDoc = docScreen && !docScreen.classList.contains('hidden');
        const aiScreen = document.getElementById('screen-ai');
        const onAI = aiScreen && !aiScreen.classList.contains('hidden');

        if (st.screen === 'list' && (onDoc || onAI)) {
            // 문서·AI 화면에서 ← → 목록으로 복귀
            stopDocPlayback();
            $('title').textContent = "Templum Sapientiae";
            show('screen-list');
            return;
        }

        if (st.screen === 'list-bottom') {
            // 목록에서 ← 누름 — 2단계 종료 처리
            const now = Date.now();
            if (now - lastBackPress < 2000) {
                // 2초 내 두 번째 ← → 가로채지 않음. 다음 ← 에서 앱 종료.
                lastBackPress = 0;
                return;
            }
            lastBackPress = now;
            // 첫 번째 ← → list 상태 재푸시 + 안내 토스트
            history.pushState({ screen: 'list' }, '', '#list');
            showExitToast();
        }
    });
    $('btn-refresh').addEventListener('click', () => {
        if (state.accessToken) loadDocuments();
        else requestSignIn();
    });
    $('btn-install').addEventListener('click', tryInstall);

    // ── 문서 AI ──
    $('btn-ai')?.addEventListener('click', openAI);
    $('ai-send')?.addEventListener('click', askAI);
    $('ai-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAI(); }
    });
    $('btn-ai-key')?.addEventListener('click', () => { promptAiKey(); });
    $('btn-ai-model')?.addEventListener('click', () => { promptAiModel(); });
    $('btn-ai-clear')?.addEventListener('click', clearAiChat);

    // 검색 — 입력하는 동안 즉시 필터링
    const searchInput = $('search-input');
    const clearBtn = $('btn-clear-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            state.searchTerm = searchInput.value || "";
            clearBtn.style.display = state.searchTerm ? "" : "none";
            renderList();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = "";
            state.searchTerm = "";
            clearBtn.style.display = "none";
            renderList();
            searchInput.focus();
        });
    }
});

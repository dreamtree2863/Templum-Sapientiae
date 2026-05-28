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
const CACHE_KEY = "templum.docList.v2";  // v2: 경로 기반 키 + 백과사전 폴더별 subject
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
    $('btn-back').style.display = (screenId === 'screen-doc') ? '' : 'none';
    $('btn-refresh').style.display = (screenId === 'screen-list') ? '' : 'none';
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
                } else if (/\.html?$/i.test(f.name)) {
                    batch.push({
                        id: f.id,
                        name: f.name,
                        mtime: Date.parse(f.modifiedTime),
                        size: Number(f.size) || 0,
                        path: path.join("/"),  // Templum 내부 상대 경로
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
    let totalSoFar = 0;

    await listAllFilesUnder(state.rootFolderId, (batch) => {
        for (const f of batch) {
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
                // archive (및 그 외) 는 기존처럼 *주제별 그룹화*
                let subject = "기타";
                if (segs[0] === "archive" && segs[1]) subject = segs[1];
                else if (segs[0]) subject = segs[0];

                const groupKey = `${f.path}|${info.baseTitle}`;
                groups[subject] = groups[subject] || {};
                const item = groups[subject][groupKey] = groups[subject][groupKey] || {
                    subject, baseTitle: info.baseTitle, files: {}, latestMtime: 0, path: f.path,
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

    state.grouped = groups;
    state.encyclopediaTree = encTree;
    state.fetchedAt = Date.now();
    state.refreshing = false;
    saveCache();
    renderList();
    setStatus(`✅ ${totalSoFar}개 파일 동기화 완료 (${new Date().toLocaleTimeString('ko-KR')})`);
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

    // ── 2. archive 그룹 (시험·문제·요약본 등) — 아래로 ──
    const subjects = Object.keys(state.grouped).sort();
    for (const subject of subjects) {
        const items = Object.values(state.grouped[subject])
            .filter(it => !term
                || it.baseTitle.toLowerCase().includes(term)
                || subject.toLowerCase().includes(term))
            .sort((a, b) => a.baseTitle.localeCompare(b.baseTitle, 'ko'));

        if (items.length === 0) continue;

        const grp = document.createElement('div');
        grp.className = "subject-group";
        const h = document.createElement('h3');
        h.textContent = `📚 ${subject} (${items.length})`;
        grp.appendChild(h);

        for (const item of items) {
            grp.appendChild(buildItemCard(item));
            totalShown++;
        }
        container.appendChild(grp);
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
                       || item.files.summary || item.files.exam_criteria);

    let kinds;
    if (hasTopic && !hasExam) {
        kinds = ["topic_toc", "topic_body", "topic_summary"];
    } else if (hasExam) {
        kinds = ["q_only", "q_toc", "q_toc_a", "summary"];
        if (item.files.exam_criteria) kinds.push("exam_criteria");
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
    $('title').textContent = file.name;
    $('doc-content').innerHTML = `<div class="hint"><span class="spinner"></span> 문서 로드 중…</div>`;

    // 안드로이드 시스템 뒤로가기 처리용 — 히스토리에 'doc' 상태 push.
    // 사용자가 폰 하단 < 버튼 누르면 popstate 발화 → 자동으로 목록으로 복귀.
    if (!history.state || history.state.screen !== 'doc') {
        history.pushState({ screen: 'doc' }, '', '#doc');
    }
    try {
        const html = await fetchFileContent(file);
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

// ─── 이벤트 바인딩 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // 저장 토큰 있으면 인증 화면 깜빡임 없이 바로 목록 화면으로
    const hasCachedToken = !!loadStoredToken();
    show(hasCachedToken ? 'screen-list' : 'screen-auth');
    initOAuth();
    $('btn-signin').addEventListener('click', requestSignIn);
    // 인앱 ← 버튼 — 시스템 뒤로가기와 동일하게 history 를 통해 처리
    $('btn-back').addEventListener('click', () => {
        if (history.state && history.state.screen === 'doc') {
            history.back();  // popstate 발화 → 핸들러가 목록 복귀
        } else {
            $('title').textContent = "Templum Sapientiae";
            show('screen-list');
        }
    });

    // 시스템 뒤로가기 (안드로이드 폰 하단 < 버튼) — popstate 받으면 목록으로 복귀
    window.addEventListener('popstate', () => {
        const docScreen = document.getElementById('screen-doc');
        if (docScreen && !docScreen.classList.contains('hidden')) {
            $('title').textContent = "Templum Sapientiae";
            show('screen-list');
        }
        // 목록 화면에서 추가로 뒤로가기 → 기본 동작 (PWA 종료 / 브라우저 이전 페이지)
    });
    $('btn-refresh').addEventListener('click', () => {
        if (state.accessToken) loadDocuments();
        else requestSignIn();
    });
    $('btn-install').addEventListener('click', tryInstall);

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

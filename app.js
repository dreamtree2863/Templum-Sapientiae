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

// 상태
const state = {
    accessToken: null,
    tokenClient: null,
    rootFolderId: null,
    /** { subject: [{id, name, mtime, kind, baseTitle, group}, ...] } */
    grouped: {},
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

// ─── OAuth ───────────────────────────────────────────────────────────
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
                alert("로그인 실패: " + resp.error);
                return;
            }
            state.accessToken = resp.access_token;
            onSignedIn();
        }
    });
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
    state.tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function onSignedIn() {
    show('screen-list');
    setStatus("Drive 폴더 검색 중…");
    try {
        state.rootFolderId = await findFolderByName(DRIVE_ROOT_NAME);
        if (!state.rootFolderId) {
            setStatus(`Drive 에서 "${DRIVE_ROOT_NAME}" 폴더를 찾을 수 없습니다. PC 의 Google Drive 데스크톱이 동기화 중인지 확인하세요.`);
            return;
        }
        await loadDocuments();
    } catch (e) {
        setStatus("오류: " + e.message);
    }
}

// ─── Drive API ───────────────────────────────────────────────────────
async function driveFetch(path, params) {
    const url = new URL("https://www.googleapis.com/drive/v3/" + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const resp = await fetch(url.toString(), {
        headers: { "Authorization": "Bearer " + state.accessToken },
    });
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

async function listAllFilesUnder(folderId) {
    /** 하위 폴더까지 재귀로 HTML 파일 전부 수집. 깊이 제한은 별로 없음. */
    const out = [];
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
            for (const f of (res.files || [])) {
                if (f.mimeType === "application/vnd.google-apps.folder") {
                    stack.push({ id: f.id, path: [...path, f.name] });
                } else if (/\.html?$/i.test(f.name)) {
                    out.push({
                        id: f.id,
                        name: f.name,
                        mtime: Date.parse(f.modifiedTime),
                        size: Number(f.size) || 0,
                        path: path.join("/"),  // Templum 내부 상대 경로
                    });
                }
            }
            pageToken = res.nextPageToken;
        } while (pageToken);
    }
    return out;
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

async function loadDocuments() {
    setStatus("문서 목록 로드 중…");
    const files = await listAllFilesUnder(state.rootFolderId);
    setStatus(`총 ${files.length}개 HTML 파일 발견`);

    // 항목 그룹화 — { subject: { baseTitle: { kind→file, group, latestMtime } } }
    const groups = {};  // subject → baseTitle → item
    for (const f of files) {
        const info = classify(f);
        // subject = path 첫 세그먼트 (예: "archive/국제법" → "국제법", "encyclopedia/학문/..." → "백과사전")
        const segs = f.path.split("/").filter(Boolean);
        let subject = "기타";
        if (segs[0] === "archive" && segs[1]) subject = segs[1];
        else if (segs[0] === "encyclopedia") subject = "백과사전";
        else if (segs[0]) subject = segs[0];

        groups[subject] = groups[subject] || {};
        const item = groups[subject][info.baseTitle] = groups[subject][info.baseTitle] || {
            subject, baseTitle: info.baseTitle, files: {}, latestMtime: 0,
        };
        item.files[info.kind] = { ...f, label: info.label };
        if (f.mtime > item.latestMtime) item.latestMtime = f.mtime;
    }
    state.grouped = groups;
    renderList();
}

// ─── 렌더링 ─────────────────────────────────────────────────────────
function renderList() {
    const container = $('item-list');
    container.innerHTML = "";

    const subjects = Object.keys(state.grouped).sort();
    if (subjects.length === 0) {
        container.innerHTML = `<div class="hint">동기화된 문서가 없습니다. PC 에서 archive/encyclopedia 폴더가 Drive 의 Templum 안에 들어 있는지 확인하세요.</div>`;
        return;
    }

    for (const subject of subjects) {
        const grp = document.createElement('div');
        grp.className = "subject-group";
        const h = document.createElement('h3');
        h.textContent = `📚 ${subject}`;
        grp.appendChild(h);

        const items = Object.values(state.grouped[subject])
            .sort((a, b) => a.baseTitle.localeCompare(b.baseTitle, 'ko'));

        for (const item of items) {
            grp.appendChild(buildItemCard(item));
        }
        container.appendChild(grp);
    }
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

// ─── 이벤트 바인딩 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    show('screen-auth');
    initOAuth();
    $('btn-signin').addEventListener('click', requestSignIn);
    $('btn-back').addEventListener('click', () => {
        $('title').textContent = "Templum Sapientiae";
        show('screen-list');
    });
    $('btn-refresh').addEventListener('click', () => {
        if (state.accessToken) loadDocuments();
        else requestSignIn();
    });
});

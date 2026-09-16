// ─────────────────────────────────────────────────────────────────────
// tts_player.js — 위치 추적 낭독 (문장/세그먼트 단위 하이라이트 + 클릭 점프)
//   백과사전(뷰어 페이지)·아카이브(iframe) 공용. 호스트가 합성 API 2개를 주입한다.
//
//   const p = createTTSPlayer(rootDoc, {
//       synthPlan: (segTexts)        => Promise({chunks:[{seg_from,seg_to}]}),
//       synthChunk:(chunkIndex)      => Promise({ok,audio_b64,starts,seg_from,seg_to}),
//       onState:   (state)           => void,   // 'playing'|'stopped'|'loading' (선택)
//   });
//   p.start();  p.stop();  p.toggle();
//
//   · 세그먼트 = 읽기 단위(문단·표 셀·개요 항목·제목 등 '잎' 블록 요소).
//   · 재생은 <audio>(웹 오디오) — currentTime 으로 현재 세그먼트를 정확히 하이라이트.
//   · 세그먼트 클릭 → 그 위치로 점프(같은 청크는 시킹, 다른 청크는 로드 후 재생).
// ─────────────────────────────────────────────────────────────────────
(function (global) {
    "use strict";

    // div 도 포함 — 일부 문서는 소제목((1) 개념, 1) 견해의 대립 …)을 div(예: div.sub)에 담는데,
    //   이게 음성엔 읽히지만 세그먼트로 안 잡히면 클릭 불가 + 글자수 비례(하이라이트/점프)가 어긋난다.
    //   잎(leaf) 규칙상 자식 블록이 있는 컨테이너 div 는 제외되고, 직접 텍스트만 가진 div 만 잡힌다.
    const SEG_SEL = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,dt,dd,figcaption,caption,div";
    // 하이라이트 선행 시간(초) — 음성이 그 줄을 읽기 시작하기 이만큼 전에 표시가 옮겨간다.
    //   0 = 낭독 시점과 정확히 일치(기본). 0.45 로 앞세워 봤더니 너무 일찍 넘어가 되돌림.
    const HL_LEAD_SEC = 0;
    const STYLE_ID = "__tts_seg_style";

    function injectStyle(doc) {
        if (doc.getElementById(STYLE_ID)) return;
        const st = doc.createElement("style");
        st.id = STYLE_ID;
        st.textContent =
            ".tts-seg{cursor:pointer;transition:background-color .15s;border-radius:3px;}" +
            ".tts-seg:hover{background-color:rgba(193,154,107,.18);}" +
            ".tts-active{background-color:rgba(255,214,10,.45)!important;box-shadow:0 0 0 2px rgba(255,214,10,.55);border-radius:3px;}";
        (doc.head || doc.documentElement).appendChild(st);
    }

    // 화면에 실제로 그려지는 요소인지(= 낭독 대상인지). display:none 인 뷰어 셸 장식
    // (.print-header/.print-footer, 로딩 오버레이)이 세그먼트로 잡히면 하이라이트가 밀리고
    // 세그먼트 지문이 음성과 어긋나 whisper 타이밍이 heuristic 으로 폴백한다.
    function isRendered(el) {
        return !!(el.offsetWidth || el.offsetHeight ||
                  (el.getClientRects && el.getClientRects().length));
    }

    // 읽기 단위(잎 블록) 수집 — 다른 후보를 포함하는 요소는 제외(중복 방지).
    function collectSegments(root) {
        const all = Array.prototype.slice.call(root.querySelectorAll(SEG_SEL));
        const set = new Set(all);
        const leaves = all.filter(function (el) {
            // note(주석) div 는 html_to_text 가 낭독에서 빼므로 세그먼트에서도 제외(음성과 일치)
            if (el.closest && el.closest(".note")) return false;
            for (const c of el.querySelectorAll(SEG_SEL)) { if (set.has(c)) return false; }
            return (el.textContent || "").trim().length > 0;
        });
        // 숨은 요소 제거. 단, 뷰어 전체가 아직 숨겨진 상태에서 호출되면 전부 걸러질 수 있으므로
        // 그때는 필터 전 목록을 그대로 쓴다(세그먼트 0개가 되어 낭독이 죽는 것보다 낫다).
        const shown = leaves.filter(isRendered);
        return shown.length ? shown : leaves;  // 문서 순서 = 읽기 순서
    }

    function createTTSPlayer(rootDoc, api) {
        const doc = rootDoc;
        let segEls = [], plan = null, curChunk = -1, audio = null, blobUrl = null;
        let starts = [], segFrom = 0, segTo = 0, activeSeg = -1, prefetch = null, prefetchIdx = -1;
        let running = false, rafId = 0;
        // 로드 중 클릭 점프가 초기 로드와 *동시 로드 경쟁*을 일으키지 않도록 가드 + 보류 점프
        let loadingChunk = false, pendingSeek = -1;

        function setState(s) { try { api.onState && api.onState(s); } catch (e) {} }

        function buildSegments() {
            injectStyle(doc);
            segEls = collectSegments(doc.body || doc.documentElement);
            segEls.forEach(function (el, i) {
                el.classList.add("tts-seg");
                el.setAttribute("data-seg", String(i));
                if (!el.__ttsBound) {
                    el.__ttsBound = true;
                    el.addEventListener("click", function () {
                        const idx = parseInt(el.getAttribute("data-seg"), 10);
                        if (!isNaN(idx)) jumpToSeg(idx);
                    });
                }
            });
            const isHead = function (el) { return !!el && /^h[1-6]$/i.test(el.tagName || ""); };
            return segEls.map(function (el, i) {
                let txt = (el.textContent || "").trim();
                // 개요(제목)→본문으로 넘어가거나(이 세그가 제목), 개요가 바뀔 때(다음 세그가 제목)
                //   더 길게 쉬도록 강한 종지(마침표+말줄임표)를 덧붙인다.
                if (isHead(el) || isHead(segEls[i + 1])) {
                    txt = txt.replace(/[\s.,;:·…]+$/, "") + " . …";
                }
                return txt;
            });
        }

        function clearHighlight() {
            if (activeSeg >= 0 && segEls[activeSeg]) segEls[activeSeg].classList.remove("tts-active");
            activeSeg = -1;
        }
        // 문서 제목(맨 앞 h1)은 낭독은 하되 하이라이트하지 않는다.
        //   제목은 길이에 비해 읽는 시간이 길어(개요 전환 쉼까지 포함) 하이라이트가 먼저
        //   다음 단락으로 넘어가 버린다 → 초반부터 하이라이트와 음성이 어긋나 보인다.
        //   타이밍 계산에서는 그대로 한 세그먼트로 두고(시간 배분 유지) 표시만 건너뛴다.
        function isTitleSeg(idx) {
            const el = segEls[idx];
            return idx === 0 && !!el && el.tagName === "H1";
        }
        function highlight(idx) {
            if (idx === activeSeg) return;
            if (activeSeg >= 0 && segEls[activeSeg]) segEls[activeSeg].classList.remove("tts-active");
            activeSeg = idx;
            if (isTitleSeg(idx)) return;          // 제목 낭독 중 — 하이라이트·스크롤 없음
            const el = segEls[idx];
            if (el) {
                el.classList.add("tts-active");
                try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
            }
        }

        // 현재 audio.currentTime → 청크 내 세그먼트 인덱스
        function segAtTime() {
            if (!audio || !audio.duration) return segFrom;
            // 하이라이트를 음성보다 살짝 앞세운다 — 다음 줄을 미리 눈으로 따라갈 수 있게.
            //   (경계에 정확히 맞추면 읽기 시작한 뒤에야 표시가 옮겨와 한 박자 늦게 느껴진다)
            const f = (audio.currentTime + HL_LEAD_SEC) / audio.duration;
            // 첫 세그먼트가 시작되기 전 구간은 *어느 세그먼트도 아니다* → 하이라이트 없음(-1).
            //   백과 뷰어는 문서 제목(h1)을 떼고 본문만 띄우지만 낭독에는 제목이 들어간다.
            //   제목을 읽는 동안 본문 첫 줄에 하이라이트가 걸리던 문제를 여기서 막는다.
            if (starts.length && f < starts[0]) return -1;
            let local = 0;
            for (let i = 0; i < starts.length; i++) { if (starts[i] <= f) local = i; else break; }
            return segFrom + local;
        }
        function tick() {
            if (!running || !audio) return;
            highlight(segAtTime());
            rafId = global.requestAnimationFrame(tick);
        }
        // requestAnimationFrame 은 임베드/백그라운드 WebEngine 에서 throttle 될 수 있어 tick 이 멈출 수 있다.
        //   재생 위치 기반 하이라이트를 <audio> 의 timeupdate(재생 중 주기적 발생)에도 묶어, rAF 와 무관하게
        //   다음 세그먼트로 확실히 넘어가게 한다. (한 audio 당 한 번만 바인딩)
        function bindHighlightEvents(a) {
            if (!a || a.__ttsHlBound) return;
            a.__ttsHlBound = true;
            const onMove = function () { if (running) highlight(segAtTime()); };
            a.addEventListener("timeupdate", onMove);
            a.addEventListener("seeked", onMove);
        }

        function revokeBlob() { if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} blobUrl = null; } }
        function b64ToUrl(b64) {
            const bin = atob(b64); const len = bin.length; const arr = new Uint8Array(len);
            for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
            return URL.createObjectURL(new Blob([arr], { type: "audio/mpeg" }));
        }
        // 청크의 오디오 출처 — 데스크톱은 base64(파이썬이 건네줌), 폰은 URL 스트리밍.
        //   폰에서 몇 MB mp3 를 base64 로 메모리에 올리지 않으려고 audio_url 을 받는다.
        function srcOf(data) {
            if (data.audio_url) { revokeBlob(); return data.audio_url; }
            revokeBlob(); blobUrl = b64ToUrl(data.audio_b64); return blobUrl;
        }

        async function ensurePlan() {
            if (plan) return plan;
            const texts = buildSegments();
            if (!texts.length) return null;
            const r = await api.synthPlan(texts);
            plan = (r && r.chunks) ? r.chunks : null;
            return plan;
        }

        async function loadChunk(idx) {
            let data = null;
            if (prefetch && prefetchIdx === idx) { data = await prefetch; prefetch = null; prefetchIdx = -1; }
            else data = await api.synthChunk(idx);
            return data;
        }
        function startPrefetch(idx) {
            if (!plan || idx < 0 || idx >= plan.length) { prefetch = null; prefetchIdx = -1; return; }
            prefetchIdx = idx; prefetch = api.synthChunk(idx);
        }

        async function playChunk(idx, seekFrac) {
            if (!plan || idx < 0 || idx >= plan.length) { stop(); return; }
            setState("loading");
            loadingChunk = true;
            const data = await loadChunk(idx);
            if (!running) { loadingChunk = false; return; }
            if (!data || !data.ok) { // 실패 → 다음 청크로
                loadingChunk = false;
                if (idx + 1 < plan.length) return playChunk(idx + 1, 0);
                stop(); return;
            }
            curChunk = idx; starts = data.starts || [0]; segFrom = data.seg_from; segTo = data.seg_to;
            const srcUrl = srcOf(data);
            if (!audio) {
                audio = api.audioEl || new Audio();   // 보이는 컨트롤(seek bar) 주입 가능
                audio.addEventListener("ended", function () {
                    if (!running) return;
                    if (curChunk + 1 < plan.length) playChunk(curChunk + 1, 0); else stop();
                });
                bindHighlightEvents(audio);
            }
            audio.src = srcUrl;
            audio.onloadedmetadata = function () {
                if (seekFrac && audio.duration) { try { audio.currentTime = seekFrac * audio.duration; } catch (e) {} }
            };
            try { await audio.play(); } catch (e) {}
            setState("playing");
            startPrefetch(idx + 1);
            global.cancelAnimationFrame(rafId); rafId = global.requestAnimationFrame(tick);
            loadingChunk = false;
            if (pendingSeek >= 0) { const t = pendingSeek; pendingSeek = -1; jumpToSeg(t); }
        }

        function chunkOfSeg(idx) {
            if (!plan) return -1;
            for (let i = 0; i < plan.length; i++) { if (idx >= plan[i].seg_from && idx < plan[i].seg_to) return i; }
            return -1;
        }

        async function start() {
            if (running) return;
            running = true;
            if (!(await ensurePlan())) { running = false; return; }
            await playChunk(0, 0);
        }

        async function jumpToSeg(idx) {
            if (!(await ensurePlan())) return;
            // 초기/다른 청크 로드 중이면 경쟁 로드를 일으키지 말고 보류 — 로드 완료 후 적용.
            if (loadingChunk) { pendingSeek = idx; running = true; return; }
            const ci = chunkOfSeg(idx);
            if (ci < 0) return;
            const localStart = idx - plan[ci].seg_from;
            running = true;
            if (ci === curChunk && audio && audio.duration && starts[localStart] != null) {
                try { audio.currentTime = starts[localStart] * audio.duration; } catch (e) {}
                highlight(idx);
                try { await audio.play(); } catch (e) {}
                setState("playing");
                global.cancelAnimationFrame(rafId); rafId = global.requestAnimationFrame(tick);
            } else {
                // 다른 청크 — 로드 후 그 세그먼트 비율로 시킹
                prefetch = null; prefetchIdx = -1;
                const seekFrac = (idx > plan[ci].seg_from) ? null : 0;  // 시작 세그먼트면 0, 아니면 metadata 후 계산
                // metadata 후 정확 시킹을 위해 임시로 fraction 계산은 playChunk 내부 starts 로 보정
                await playChunkAtSeg(ci, idx);
            }
        }
        // 특정 청크를 로드해 그 안 세그먼트(idx)부터 재생
        async function playChunkAtSeg(ci, idx) {
            setState("loading");
            loadingChunk = true;
            const data = await loadChunk(ci);
            if (!running) { loadingChunk = false; return; }
            if (!data || !data.ok) { loadingChunk = false; stop(); return; }
            curChunk = ci; starts = data.starts || [0]; segFrom = data.seg_from; segTo = data.seg_to;
            const srcUrl = srcOf(data);
            if (!audio) {
                audio = api.audioEl || new Audio();   // 보이는 컨트롤(seek bar) 주입 가능
                audio.addEventListener("ended", function () {
                    if (!running) return;
                    if (curChunk + 1 < plan.length) playChunk(curChunk + 1, 0); else stop();
                });
                bindHighlightEvents(audio);
            }
            const local = idx - segFrom;
            audio.src = srcUrl;
            audio.onloadedmetadata = function () {
                if (audio.duration && starts[local] != null) { try { audio.currentTime = starts[local] * audio.duration; } catch (e) {} }
            };
            highlight(idx);
            try { await audio.play(); } catch (e) {}
            setState("playing");
            startPrefetch(ci + 1);
            global.cancelAnimationFrame(rafId); rafId = global.requestAnimationFrame(tick);
            loadingChunk = false;
            if (pendingSeek >= 0) { const t = pendingSeek; pendingSeek = -1; jumpToSeg(t); }
        }

        function stop() {
            running = false;
            pendingSeek = -1; loadingChunk = false;
            global.cancelAnimationFrame(rafId);
            if (audio) { try { audio.pause(); } catch (e) {} }
            revokeBlob();
            clearHighlight();
            setState("stopped");
        }
        function pause() { if (audio && running) { try { audio.pause(); } catch (e) {} global.cancelAnimationFrame(rafId); setState("paused"); } }
        function resume() { if (audio) { try { audio.play(); } catch (e) {} rafId = global.requestAnimationFrame(tick); setState("playing"); } }
        function toggle() { if (running && audio && !audio.paused) pause(); else if (audio && audio.paused && running) resume(); else start(); }

        // 보정용 — 현재(단일 청크) 세그먼트 시작 비율을 교체하면 하이라이트가 즉시 새 타이밍을 따른다.
        function setStarts(arr) { if (Array.isArray(arr) && arr.length) starts = arr.slice(); }
        function getSegEls() { return segEls; }
        return { start: start, stop: stop, pause: pause, resume: resume, toggle: toggle, jumpToSeg: jumpToSeg, setStarts: setStarts, getSegEls: getSegEls, _segments: buildSegments };
    }

    global.createTTSPlayer = createTTSPlayer;
})(window);

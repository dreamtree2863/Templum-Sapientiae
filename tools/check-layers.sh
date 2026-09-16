#!/bin/sh
# 층 경계 검사 — 빌드 도구가 없으므로 grep 세 줄이 린터를 대신한다.
# 커밋 전에 한 번 돌린다. 아무것도 출력하지 않으면 통과.
#
#   규칙 1  화면 층은 data/index.js 라는 단 하나의 창구만 쓴다
#   규칙 2  데이터 층은 DOM 을 모른다
#   규칙 3  화면 층은 네트워크를 모른다
#
# 사용:  sh tools/check-layers.sh     (pwa/ 에서)

cd "$(dirname "$0")/.." || exit 1
fail=0

if grep -rn "from '\.\./\.\./data/\|from '\.\./data/" js/features 2>/dev/null | grep -v "data/index\.js"; then
  echo "↑ 위반 1: 화면 층이 data/index.js 를 건너뛰고 데이터 모듈을 직접 import"
  fail=1
fi

if grep -rn "document\.\|getElementById\|innerHTML\|querySelector" \
     js/data js/core/store.js js/core/bus.js js/core/idb.js js/core/kv.js 2>/dev/null; then
  echo "↑ 위반 2: 데이터 층이 DOM 에 손을 댐"
  fail=1
fi

if grep -rn "fetch(\|googleapis\.com" js/features 2>/dev/null; then
  echo "↑ 위반 3: 화면 층이 네트워크를 직접 호출"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "층 경계 이상 없음"
exit "$fail"

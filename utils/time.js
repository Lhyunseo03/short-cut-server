// ─────────────────────────────────────────────────────────────
// utils/time.js — KST(한국 표준시) 날짜 헬퍼
//
// server.js 안에도 같은 함수가 있지만 export 가 안 돼 있어서 라우트 파일에서 못 씀.
// 복붙 대신 여기로 분리. (server.js 쪽은 통계 코드가 쓰고 있으므로 지금은 건드리지 않음)
// ─────────────────────────────────────────────────────────────

const KST_OFFSET = 9 * 60 * 60 * 1000; // UTC + 9시간

// timestamp(ms) → KST 기준 'YYYY-MM-DD'
//   Date 는 UTC 기준으로 동작하므로, 9시간을 "더한 뒤" UTC 로 읽으면
//   결과적으로 KST 날짜가 된다. (Asia/Seoul 은 서머타임이 없어서 이 방식이 안전)
function toKSTDateString(timestamp) {
  return new Date(timestamp + KST_OFFSET).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' → 그날 KST 00:00:00.000 의 ms
//   문자열에 +09:00 을 직접 박아서 파싱시킨다. 서버가 어느 타임존에서 돌든 같은 값이 나옴.
//   (Railway 컨테이너는 UTC 라서 이 처리가 없으면 9시간 밀림)
function startOfKSTDay(dateStr) {
  return new Date(dateStr + "T00:00:00.000+09:00").getTime();
}

module.exports = { KST_OFFSET, toKSTDateString, startOfKSTDay };

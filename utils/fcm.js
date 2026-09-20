// ─────────────────────────────────────────────────────────────
// utils/fcm.js — FCM data message 발송 (다중 기기 동기화)
//
// 서버 → 앱 방향으로 "먼저 말을 거는" 유일한 수단.
// REST 는 앱이 요청해야만 응답할 수 있고, Socket.IO 는 앱이 죽으면 끊긴다.
// FCM 은 안드로이드 OS 가 구글과 상시 유지하는 연결을 빌려 쓰므로 앱이 꺼져 있어도 도착한다.
//
// 보내는 내용은 데이터가 아니라 "지금 REST 를 호출해라" 라는 신호 한 단어:
//   { type: "FLUSH" }         — 미전송 스크롤이 있으면 지금 POST /userlogs 해라
//   { type: "COUNT_UPDATED" } — 서버 합계가 바뀌었다, GET /sync 를 다시 불러라
// ─────────────────────────────────────────────────────────────

const { db, admin } = require("./firebase");
const logger = require("./logger");

// COUNT_UPDATED 를 받을 자격 — 최근 2분 안에 GET /sync 를 부른 기기.
// = "지금 타겟 앱을 보고 있는 기기". 앱은 쇼츠를 보는 동안 1분마다 sync 하므로
//   2분이면 한 번은 걸린다(한 번 놓쳐도 살아남는 여유).
const RECENT_SYNC_MS = 2 * 60 * 1000;

// 발송 대상 토큰 고르기
//   excludeDeviceId  : 요청한 기기 자신 (자기가 자기를 깨울 이유가 없음)
//   onlyRecentSync   : true 면 최근 2분 내 sync 한 기기만 (COUNT_UPDATED 용)
async function collectTargetTokens(userId, excludeDeviceId, onlyRecentSync) {
  const snap = await db
    .collection("users")
    .doc(userId)
    .collection("devices")
    .get();
  const targets = [];
  const cutoff = Date.now() - RECENT_SYNC_MS;

  snap.forEach((doc) => {
    const d = doc.data();

    if (doc.id === excludeDeviceId) return; // 나 자신 제외
    if (!d.fcmToken) return; // 토큰이 없거나 죽어서 지워진 기기 제외

    // 로그아웃한 기기 제외 (G11 + 비기능 요구사항).
    // 받아 봐야 userId 가 없어서 처리도 못 하고, 공용 기기면 남의 알림이 뜬다.
    if (d.loggedOutAt) return;

    // lastSyncAt 이 아예 없으면(undefined) 비교가 false 가 되어 자연히 제외된다.
    // !(a >= b) 로 쓴 이유: undefined >= cutoff 는 false 라서 이 형태가 안전.
    if (onlyRecentSync && !(d.lastSyncAt >= cutoff)) return;

    targets.push({ deviceId: doc.id, token: d.fcmToken });
  });

  return targets;
}

// data message 발송. 반환값 { sent, failed } 는 로그/테스트용.
// 실패해도 호출한 API 의 응답에는 영향이 없도록 여기서 모든 예외를 삼킨다.
async function sendDataToOtherDevices(
  userId,
  excludeDeviceId,
  type,
  extra = {},
) {
  let targets = [];
  try {
    // COUNT_UPDATED 일 때만 "최근 sync" 필터를 켠다. FLUSH 는 전부에게.
    targets = await collectTargetTokens(
      userId,
      excludeDeviceId,
      type === "COUNT_UPDATED",
    );
  } catch (err) {
    logger.error(`FCM 대상 조회 실패 — userId: ${userId}, ${err.message}`);
    return { sent: 0, failed: 0 };
  }

  if (targets.length === 0) return { sent: 0, failed: 0 }; // 보낼 데가 없으면 조용히 끝

  // FCM data 의 값은 반드시 문자열이어야 한다(숫자를 넣으면 발송 에러).
  const data = { type, sentAt: String(Date.now()) };
  for (const [k, v] of Object.entries(extra)) data[k] = String(v);

  try {
    // sendEachForMulticast — 여러 토큰에 한 번에 발송.
    // firebase-admin v13 의 현재 API (구버전의 sendMulticast 는 v13 에 없음).
    const resp = await admin.messaging().sendEachForMulticast({
      tokens: targets.map((t) => t.token),
      data,
      android: { priority: "high" }, // 삼성 절전 모드에서 몇 분씩 밀리는 것 방지
    });

    // 죽은 토큰 정리 — 앱을 지운 기기의 토큰은 앞으로도 영원히 실패한다.
    // 그냥 두면 매번 발송을 시도하느라 느려지므로 fcmToken 을 null 로 비운다.
    // (문서 자체는 남긴다 — 설정 화면 목록과 G11 표시에 필요)
    const cleanups = [];
    resp.responses.forEach((r, i) => {
      // responses[i] 는 targets[i] 의 결과
      if (r.success) return;
      const code = r.error?.code || "";
      logger.warn(`FCM 발송 실패 — deviceId: ${targets[i].deviceId}, ${code}`);
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        cleanups.push(
          db
            .collection("users")
            .doc(userId)
            .collection("devices")
            .doc(targets[i].deviceId)
            .update({ fcmToken: null }),
        );
      }
    });
    if (cleanups.length) await Promise.all(cleanups);

    logger.info(
      `FCM ${type} 발송 — userId: ${userId}, 성공 ${resp.successCount} / 실패 ${resp.failureCount}`,
    );
    return { sent: resp.successCount, failed: resp.failureCount };
  } catch (err) {
    // 네트워크 장애 · 권한 문제 등. 앱 응답에는 영향 없음.
    logger.error(`FCM ${type} 발송 실패 — userId: ${userId}, ${err.message}`);
    return { sent: 0, failed: targets.length };
  }
}

module.exports = { sendDataToOtherDevices, RECENT_SYNC_MS };

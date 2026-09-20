// ─────────────────────────────────────────────────────────────
// routes/sync.js — 다중 기기 동기화 (제안서 D3 / D4 / D6)
//
// 앱이 "지금 진짜 카운트가 몇이야?" 라고 묻는 창구.
// 1학기엔 앱이 서버에 올리기만 했는데(POST /userlogs), 기기가 2대가 되면
// 진짜 합계는 어느 기기도 모르고 서버만 안다. 그 값을 돌려주는 게 여기.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");
const { sendDataToOtherDevices } = require("../utils/fcm");
const { toKSTDateString, startOfKSTDay } = require("../utils/time");
const {
  isValidDeviceId,
  countActiveDevices,
  devicesRef,
} = require("./devices");
//        ↑ devices.js 에서 내보낸 것을 재사용 (검증 규칙을 한 곳에만 둔다)

const router = express.Router();
const ONE_HOUR_MS = 60 * 60 * 1000; // 시간당 슬라이딩 윈도우 길이

// ═════════════════════════════════════════════════════════════
// 카운트 계산 — 오늘 합계 + 다른 기기 최근 1시간
// ═════════════════════════════════════════════════════════════
// 두 값을 따로 쿼리하면 Firestore 읽기가 2배. 같은 userLogs 를 보는 거라
// 한 번만 읽고 메모리에서 나눈다.
async function computeCounts(userId, deviceId, now) {
  const dateKST = toKSTDateString(now); // 예: "2026-09-20"
  const dayStart = startOfKSTDay(dateKST); // 그날 00:00:00 KST 의 ms
  const hourStart = now - ONE_HOUR_MS; // 지금으로부터 1시간 전

  // 어디서부터 읽을까?
  // 보통은 dayStart 가 더 이르다(낮 시간대). 그런데 자정 직후(예: 00:30)엔
  // hourStart(어제 23:30)가 더 이르다. dayStart 부터만 읽으면 어제 23:30~24:00 로그가
  // 빠져서 "최근 1시간" 이 틀어진다. 그래서 둘 중 이른 쪽부터 읽는다.
  const from = Math.min(dayStart, hourStart);

  const snap = await db
    .collection("userLogs")
    .where("userId", "==", userId) // 내 로그만
    .where("timestamp", ">=", from) // 인덱스 (userId, timestamp) 사용 — 이미 등록돼 있음
    .get();
  // ※ deviceId 로는 쿼리에서 거르지 않는다.
  //    Firestore 의 != 는 복합 인덱스를 새로 만들어야 하고 제약도 많은데,
  //    하루치 로그는 많아야 수십 건이라 메모리 필터가 훨씬 싸고 단순하다.

  let dailyTotal = 0; // 오늘 모든 기기 합계
  let otherDevicesLastHour = 0; // 최근 1시간, 나를 뺀 기기들의 합계

  snap.forEach((doc) => {
    const l = doc.data();
    const n = Number(l.scrollCount) || 0; // 문자열/누락이어도 NaN 이 안 섞이게 방어

    // ① 일간 — 오늘 00:00 이후면 무조건 더한다 (내 기기 것 포함)
    if (l.timestamp >= dayStart) dailyTotal += n;

    // ② 시간당 — 최근 1시간 && "내가 아닌 기기" 것만 더한다
    //    내 것을 빼는 이유: 앱은 자기 로컬 윈도우(Room)를 이미 갖고 있고
    //    거기에 이 값을 "더한다". 내 것까지 주면 내 스크롤이 두 번 세진다.
    //    (l.deviceId || 'legacy') — 1학기 앱이 올린 옛 문서엔 deviceId 필드가 없다.
    if (l.timestamp >= hourStart && (l.deviceId || "legacy") !== deviceId) {
      otherDevicesLastHour += n;
    }
  });

  return { dateKST, dailyTotal, otherDevicesLastHour };
}

// ═════════════════════════════════════════════════════════════
// 개입 상태 읽기 — blockUntil / lastShownMilestone (D6)
// ═════════════════════════════════════════════════════════════
// 이 값들은 3주차의 POST /block, POST /milestone 이 채운다.
// 지금(2주차)은 users/{uid} 문서 자체가 없어서 기본값만 나간다.
async function readInterventionState(userId, dateKST) {
  const doc = await db.collection("users").doc(userId).get();
  const d = doc.exists ? doc.data() : {}; // 문서 없으면 빈 객체로 취급
  const ms = d.lastShownMilestone || {};

  // daily 마일스톤은 "오늘 몇 개에서 팝업 띄웠나" 라서 날짜가 바뀌면 의미가 없다.
  const daily = d.milestoneDate === dateKST ? (ms.daily ?? -1) : -1;

  // 이미 지난 차단은 내려보내지 않는다.
  let blockUntil = d.blockUntil ?? null;
  if (blockUntil !== null && blockUntil <= Date.now()) blockUntil = null;

  return { blockUntil, lastShownMilestone: { hourly: ms.hourly ?? -1, daily } };
}

// ═════════════════════════════════════════════════════════════
// GET /sync?deviceId=...
// ═════════════════════════════════════════════════════════════
// 앱이 부르는 시점 (D2 / D3):
//   · 타겟 앱 진입 직후 (미전송분 flush 를 먼저 하고 나서)
//   · 타겟 앱 보는 동안 1분마다
//   · FCM 으로 COUNT_UPDATED 를 받았을 때
// → 쇼츠를 안 보고 있으면 아예 안 부른다 = 놀고 있는 기기는 트래픽 0 (비기능 요구사항)
router.get("/sync", verifyToken, async (req, res) => {
  try {
    // userId 는 쿼리가 아니라 검증된 토큰에서.
    const userId = req.userId;

    // deviceId 는 "누구를 제외할지" 를 정하는 값이라 반드시 필요하다.
    const { deviceId } = req.query;
    if (!isValidDeviceId(deviceId)) {
      return res
        .status(400)
        .json({ error: "deviceId 쿼리가 필요합니다 (영문/숫자/-/_ 8~64자)" });
    }

    // now 를 한 번만 찍어 전부에 같은 값을 쓴다.
    const now = Date.now();

    // 세 조회는 서로 무관하므로 동시에 실행. 순서대로 await 하면 응답이 3배 느려진다.
    const [counts, state, deviceCount] = await Promise.all([
      computeCounts(userId, deviceId, now),
      readInterventionState(userId, toKSTDateString(now)),
      countActiveDevices(userId),
    ]);

    // 이 기기가 "방금 sync 했다" 고 기록 → COUNT_UPDATED 수신 자격(최근 2분)의 근거.
    // await 하지 않는다: 기다릴 이유가 없고, 실패해도 응답은 정상이어야 한다.
    devicesRef(userId)
      .doc(deviceId)
      .get()
      .then((doc) => {
        if (doc.exists)
          return doc.ref.update({ lastSyncAt: now, lastSeenAt: now });
      })
      .catch((err) => logger.warn(`lastSyncAt 갱신 실패 — ${err.message}`));

    res.json({
      serverTime: now, // 앱이 기기 시계 차이를 보정할 때 쓸 수 있음
      date: counts.dateKST, // 어느 날짜 기준인지 (자정 경계 디버깅용)
      dailyTotal: counts.dailyTotal, // 앱: 로컬 일간값을 이걸로 "덮어쓰기"
      otherDevicesLastHour: counts.otherDevicesLastHour, // 앱: 로컬 1시간 윈도우에 "더하기"
      deviceCount, // 앱: 2 이상이면 배치 주기 1분
      blockUntil: state.blockUntil, // 앱: 남은 시간만큼 차단 (3주차)
      lastShownMilestone: state.lastShownMilestone, // 앱: 같은 팝업 생략 (3주차)
    });

    logger.info(
      `sync — userId: ${userId}, device: ${deviceId}, daily ${counts.dailyTotal}, othersLastHour ${counts.otherDevicesLastHour}, devices ${deviceCount}`,
    );

    // ── 응답을 보낸 "뒤에" 다른 기기를 깨운다 (D3 2단계 동기화의 1단계) ──
    // FCM 발송은 수백 ms 걸린다. 응답 전에 하면 진입 동기화가 그만큼 늦어진다.
    // 기기가 1대면 깨울 상대가 없으므로 Firestore 읽기를 아낀다.
    if (deviceCount >= 2) {
      sendDataToOtherDevices(userId, deviceId, "FLUSH");
    }
  } catch (err) {
    logger.error(`sync 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };

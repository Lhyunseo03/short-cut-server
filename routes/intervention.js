// ─────────────────────────────────────────────────────────────
// routes/intervention.js — 개입 상태 동기화 (제안서 D6)
//
// 2주차까지는 "카운트"만 기기 사이에 맞췄다면, 여기서는 "개입 상태"를 맞춘다.
//   · 폰에서 그만보기를 누르면 태블릿도 같은 시각까지 차단   → blockUntil
//   · 한쪽에서 뜬 팝업이 다른 쪽에서 또 뜨지 않게            → lastShownMilestone
//   · 한쪽에서 답하면 다른 쪽에 떠 있던 팝업이 닫히게        → lastAnsweredMilestone
//
// Firestore 경로: users/{uid}  (기기별이 아니라 사용자 단위 — 모든 기기가 공유하는 상태)
//   blockUntil             Stop 차단이 끝나는 절대 시각(ms). 없으면 null
//   lastShownMilestone     { hourly, daily } 마지막으로 "띄운" 단계. 미발생 -1
//   lastAnsweredMilestone  { hourly, daily } 마지막으로 "답한" 단계. 미발생 -1
//   milestoneDate          위 daily 값이 어느 날짜(KST)의 것인지 — 자정 넘으면 무효
//
// ── 왜 shown 과 answered 를 나눴나 (9/23 결정) ──
// 두 기기가 거의 동시에 같은 단계를 넘으면 둘 다 팝업을 띄운다.
// 값이 하나뿐이면 "떴다"와 "답했다"를 구분할 수 없어서, 한쪽에서 계속보기를 눌러도
// 다른 쪽 팝업을 닫아줄 근거가 없다. 그래서 역할이 다른 두 값으로 나눈다.
//   shown    → 아직 안 뜬 기기가 같은 팝업을 새로 띄우지 않게 (억제)
//   answered → 이미 떠 있는 기기의 팝업을 닫게 (해제)
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");
const { sendDataToOtherDevices } = require("../utils/fcm");
const { toKSTDateString } = require("../utils/time");
const { isValidDeviceId } = require("./devices");

const router = express.Router();

// users/{uid} 문서 참조 — devices 서브컬렉션의 부모이기도 하다
function userRef(userId) {
  return db.collection("users").doc(userId);
}

// 마일스톤 갱신 규칙 — "더 큰 값으로만" 올리고, -1 이 오면 리셋한다.
//   prev: 저장돼 있던 값, next: 앱이 보낸 값
//   next 가 undefined/null 이면 이번 요청은 그 종류를 건드리지 않는다는 뜻 → prev 유지
//   next 가 -1 이면 명시적 리셋 (시간당 윈도우가 회복돼 다음 초과에 다시 떠야 할 때)
//   그 외에는 max — 네트워크 지연으로 옛 값이 늦게 도착해도 되돌아가지 않게
function mergeMilestone(prev, next) {
  if (next === undefined || next === null) return prev ?? -1;
  const n = Number(next);
  if (!Number.isFinite(n)) return prev ?? -1;
  if (n === -1) return -1; // 리셋
  return Math.max(prev ?? -1, n);
}

// ═════════════════════════════════════════════════════════════
// POST /block  { deviceId, blockUntil }
// ═════════════════════════════════════════════════════════════
// 앱이 부르는 시점: 사용자가 "그만보기"를 눌러 5분 차단이 시작된 직후.
//
// blockUntil 은 "남은 초"가 아니라 끝나는 **절대 시각(ms)** 으로 받는다.
// 남은 시간으로 주고받으면 전송·수신 지연만큼 다른 기기의 차단이 늦게 끝난다.
// 절대 시각이면 차단 시작은 늦어도 끝나는 순간은 두 기기가 같다. (제안서 D6)
router.post("/block", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { deviceId, blockUntil } = req.body;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "deviceId 형식이 잘못되었습니다" });
    }
    if (typeof blockUntil !== "number" || !Number.isFinite(blockUntil)) {
      return res
        .status(400)
        .json({ error: "blockUntil 은 숫자(Unix ms)여야 합니다" });
    }

    const now = Date.now();
    // 이미 지난 시각을 저장하면 다른 기기가 의미 없는 값을 받게 된다.
    // 0 이나 과거 시각은 "차단 해제"로 해석해 null 로 지운다.
    const value = blockUntil > now ? blockUntil : null;

    // merge: true — devices 서브컬렉션이나 다른 필드를 건드리지 않고 이 필드만 갱신
    await userRef(userId).set({ blockUntil: value }, { merge: true });

    logger.success(
      `block 저장 — userId: ${userId}, device: ${deviceId}, blockUntil: ${value ?? "해제"}`,
    );
    res.json({ status: "ok", blockUntil: value });

    // 다른 기기가 다음 /sync(최대 1분)를 기다리지 않고 바로 알도록 깨운다.
    // COUNT_UPDATED 를 받은 앱은 GET /sync 를 다시 부르고, 거기에 blockUntil 이 실려 간다.
    sendDataToOtherDevices(userId, deviceId, "COUNT_UPDATED");
  } catch (err) {
    logger.error(`block 저장 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// POST /milestone  { deviceId, hourly, daily, answered }
// ═════════════════════════════════════════════════════════════
// 앱이 부르는 시점 두 가지:
//   ① 팝업이 떴을 때            → answered 없음(또는 false) → shown 만 갱신
//   ② 사용자가 답했을 때        → answered: true            → shown + answered 둘 다 갱신
//   ③ 시간당 단계가 리셋됐을 때 → { hourly: -1 }            → 그 종류를 둘 다 -1 로
//
// hourly / daily 중 이번에 해당하지 않는 쪽은 아예 안 보내면 된다(건드리지 않음).
router.post("/milestone", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { deviceId, hourly, daily, answered } = req.body;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "deviceId 형식이 잘못되었습니다" });
    }
    if (hourly === undefined && daily === undefined) {
      return res
        .status(400)
        .json({ error: "hourly 또는 daily 중 하나는 있어야 합니다" });
    }
    if (answered !== undefined && typeof answered !== "boolean") {
      return res
        .status(400)
        .json({ error: "answered 는 boolean 이어야 합니다" });
    }

    const todayKST = toKSTDateString(Date.now());

    const doc = await userRef(userId).get();
    const d = doc.exists ? doc.data() : {};
    const shownPrev = d.lastShownMilestone || {};
    const ansPrev = d.lastAnsweredMilestone || {};

    // 저장된 daily 값이 어제 것이면 이미 의미가 없다 → -1 에서 새로 시작
    const sameDay = d.milestoneDate === todayKST;
    const shownDailyPrev = sameDay ? shownPrev.daily : -1;
    const ansDailyPrev = sameDay ? ansPrev.daily : -1;

    const shown = {
      hourly: mergeMilestone(shownPrev.hourly, hourly),
      daily: mergeMilestone(shownDailyPrev, daily),
    };

    // answered 는 true 일 때만 올라간다.
    // 단 -1(리셋)은 answered 여부와 무관하게 따라가야 한다 —
    // 안 그러면 시간당이 회복된 뒤 같은 단계를 다시 넘었을 때
    // "이미 답한 단계"로 잡혀서 팝업이 영영 안 뜬다.
    const ans = {
      hourly: answered
        ? mergeMilestone(ansPrev.hourly, hourly)
        : Number(hourly) === -1
          ? -1
          : (ansPrev.hourly ?? -1),
      daily: answered
        ? mergeMilestone(ansDailyPrev, daily)
        : Number(daily) === -1
          ? -1
          : (ansDailyPrev ?? -1),
    };

    await userRef(userId).set(
      {
        lastShownMilestone: shown,
        lastAnsweredMilestone: ans,
        milestoneDate: todayKST,
      },
      { merge: true },
    );

    logger.success(
      `milestone 저장 — userId: ${userId}, device: ${deviceId}, ` +
        `shown(h${shown.hourly}/d${shown.daily}) answered(h${ans.hourly}/d${ans.daily})${answered ? " [응답]" : ""}`,
    );
    res.json({
      status: "ok",
      lastShownMilestone: shown,
      lastAnsweredMilestone: ans,
    });

    // 응답일 때만 다른 기기를 깨운다.
    // "떴다"는 알릴 이유가 없다(그 기기는 어차피 자기 카운트로 판단) — 푸시를 아낀다.
    // "답했다"는 다른 기기에 떠 있는 팝업을 닫아야 하므로 즉시 알린다.
    if (answered) {
      sendDataToOtherDevices(userId, deviceId, "COUNT_UPDATED");
    }
  } catch (err) {
    logger.error(`milestone 저장 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// POST /heartbeat  { deviceId, permissionsOk }
// ═════════════════════════════════════════════════════════════
// GuardService 가 기기별로 10분마다 보낸다. 살아 있다는 신호 + 권한 상태.
// 지금은 저장만 하고, 5~6주차 그룹 화면에서 "마지막 접속 / 권한 꺼짐" 표시에 쓴다 (G11).
router.post("/heartbeat", verifyToken, async (req, res) => {
  try {
    const { deviceId, permissionsOk } = req.body;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "deviceId 형식이 잘못되었습니다" });
    }
    if (permissionsOk !== undefined && typeof permissionsOk !== "boolean") {
      return res
        .status(400)
        .json({ error: "permissionsOk 는 boolean 이어야 합니다" });
    }

    const now = Date.now();
    const data = { lastSeenAt: now };
    if (permissionsOk !== undefined) data.permissionsOk = permissionsOk;

    const ref = userRef(req.userId).collection("devices").doc(deviceId);
    const doc = await ref.get();
    if (!doc.exists) {
      // 등록 안 된 기기가 heartbeat 를 보내는 건 정상 흐름이 아니다.
      // 여기서 문서를 만들면 토큰 없는 유령 기기가 생기므로 404 로 알려
      // 앱이 /devices/register 를 다시 부르게 한다.
      return res.status(404).json({ error: "등록되지 않은 기기입니다" });
    }

    await ref.update(data);
    res.json({ status: "ok", serverTime: now });
  } catch (err) {
    logger.error(`heartbeat 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// POST /logout  { deviceId }
// ═════════════════════════════════════════════════════════════
// 앱이 부르는 시점: 로그아웃 버튼을 눌렀을 때, auth.signOut() **전에**.
// (로그아웃한 뒤에는 토큰이 없어 이 요청을 보낼 수 없다)
//
// 문서를 지우지 않고 시각만 남기는 이유 — 그룹 화면의 "Logged out (9/11 23:41)" 표시에
// 그 시각이 필요하기 때문 (G11). 이후 이 기기는 FCM 발송 대상과 기기 수에서 빠지고,
// 다시 로그인하면 /devices/register 가 loggedOutAt 을 null 로 되돌린다.
router.post("/logout", verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "deviceId 형식이 잘못되었습니다" });
    }

    const now = Date.now();
    const ref = userRef(req.userId).collection("devices").doc(deviceId);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "등록되지 않은 기기입니다" });
    }

    await ref.update({ loggedOutAt: now, lastSeenAt: now });

    logger.info(`로그아웃 — userId: ${req.userId}, deviceId: ${deviceId}`);
    res.json({ status: "ok", loggedOutAt: now });
  } catch (err) {
    logger.error(`logout 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };

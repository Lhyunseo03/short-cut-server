// ─────────────────────────────────────────────────────────────
// routes/devices.js — 기기 등록 / 조회 / 삭제 (제안서 D1)
//
// Firestore 경로: users/{uid}/devices/{deviceId}
//   deviceId      설치 단위 UUID (앱이 최초 실행 시 생성 · 앱 데이터 삭제 시 새로 발급)
//   deviceName    "Galaxy S23" 같은 표시용 — 설정 > Devices 화면
//   fcmToken      FCM 등록 토큰. null 이면 발송 대상에서 제외
//   permissionsOk 접근성 / 사용통계 / 오버레이 3개가 모두 켜져 있는지 (G11 표시용)
//   registeredAt  최초 등록 시각
//   lastSeenAt    마지막 신호 시각 (register · heartbeat · sync 때 갱신)
//   lastSyncAt    마지막 GET /sync 시각 — COUNT_UPDATED 수신 자격 판단(최근 2분)
//   loggedOutAt   로그아웃 시각. null 이면 로그인 상태
//
// ※ 로그아웃해도 문서를 지우지 않고 시각만 찍는다.
//    G11 의 "Logged out (9/11 23:41)" 표시에 그 시각이 필요하기 때문.
//    문서가 실제로 사라지는 건 사용자가 설정에서 직접 삭제할 때뿐.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// deviceId 형식 — 영문/숫자/-/_ 8~64자.
// UUID(36자)와 Firebase Installations ID(22자) 둘 다 통과하는 범위.
// 길이 하한을 두는 이유: "a" 같은 값으로 문서를 마구 만들지 못하게.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function isValidDeviceId(id) {
  return typeof id === "string" && DEVICE_ID_RE.test(id);
}

// users/{uid}/devices 컬렉션 참조. sync.js 에서도 import 해서 씀.
function devicesRef(userId) {
  return db.collection("users").doc(userId).collection("devices");
}

// 앱에 내려보낼 형태로 정리 — fcmToken 은 빼고 hasToken(boolean)만 준다.
function toPublic(doc) {
  const d = doc.data();
  return {
    deviceId: doc.id,
    deviceName: d.deviceName || null,
    permissionsOk: d.permissionsOk ?? null, // ?? 는 null/undefined 일 때만 기본값 (false 는 살림)
    registeredAt: d.registeredAt ?? null,
    lastSeenAt: d.lastSeenAt ?? null,
    loggedOutAt: d.loggedOutAt ?? null,
    hasToken: !!d.fcmToken,
  };
}

// 로그인 상태 기기 수. 로그아웃한 기기는 빼고 센다.
// 앱은 이 값이 2 이상일 때만 배치 주기를 1분으로 줄인다 (D2).
async function countActiveDevices(userId) {
  const snap = await devicesRef(userId).get();
  let n = 0;
  snap.forEach((doc) => {
    if (!doc.data().loggedOutAt) n++;
  });
  return n;
}

// ═════════════════════════════════════════════════════════════
// POST /devices/register
// ═════════════════════════════════════════════════════════════
// 앱이 부르는 시점: 로그인 성공 직후 · FCM onNewToken(토큰 갱신) · 앱 시작 시
// 같은 deviceId 면 새로 만들지 않고 갱신한다.
router.post("/devices/register", verifyToken, async (req, res) => {
  try {
    // body 의 userId 를 믿지 않는다 — 토큰에서 꺼낸 값만 쓴다.
    const userId = req.userId;
    const { deviceId, deviceName, fcmToken, permissionsOk } = req.body;

    // ── 입력 검증 ──
    if (!isValidDeviceId(deviceId)) {
      return res
        .status(400)
        .json({
          error: "deviceId 형식이 잘못되었습니다 (영문/숫자/-/_ 8~64자)",
        });
    }
    // fcmToken 은 없어도 됨(토큰 아직 못 받은 상태). 단, 오면 문자열이어야 함.
    if (
      fcmToken !== undefined &&
      fcmToken !== null &&
      typeof fcmToken !== "string"
    ) {
      return res.status(400).json({ error: "fcmToken은 문자열이어야 합니다" });
    }
    // "false" 같은 문자열이 들어와 true 로 저장되는 사고 방지
    if (permissionsOk !== undefined && typeof permissionsOk !== "boolean") {
      return res
        .status(400)
        .json({ error: "permissionsOk는 boolean이어야 합니다" });
    }

    const now = Date.now();
    const ref = devicesRef(userId).doc(deviceId);
    const prev = await ref.get(); // 이미 있는 기기인지 확인 (registeredAt 보존용)

    const data = {
      deviceId,
      lastSeenAt: now,
      loggedOutAt: null, // 등록 = 로그인 상태. 재로그인 시 로그아웃 표시가 풀린다.
      // 기존 문서가 있으면 최초 등록 시각을 유지. 없으면 지금.
      registeredAt: prev.exists ? (prev.data().registeredAt ?? now) : now,
    };

    // 앱이 안 보낸 필드는 아예 객체에 넣지 않는다.
    // Firestore 는 undefined 를 저장하려 하면 에러를 던진다.
    if (deviceName !== undefined) data.deviceName = deviceName;
    if (fcmToken !== undefined) data.fcmToken = fcmToken;
    if (permissionsOk !== undefined) data.permissionsOk = permissionsOk;

    // merge: true — 보낸 필드만 갱신하고 나머지는 그대로 둔다.
    // 이게 없으면 fcmToken 만 보내는 onNewToken 호출 때 deviceName 이 날아간다.
    await ref.set(data, { merge: true });

    const deviceCount = await countActiveDevices(userId);
    logger.success(
      `기기 등록 — userId: ${userId}, deviceId: ${deviceId}, ${prev.exists ? "갱신" : "신규"}, 활성 기기 ${deviceCount}대`,
    );

    res.json({ status: "ok", deviceId, deviceCount, serverTime: now });
  } catch (err) {
    logger.error(`기기 등록 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /devices — 설정 > Devices 화면용
// ═════════════════════════════════════════════════════════════
router.get("/devices", verifyToken, async (req, res) => {
  try {
    // 등록 순서대로 — 목록이 매번 뒤바뀌면 사용자가 헷갈린다.
    // registeredAt 단일 필드 정렬이라 Firestore 자동 인덱스로 충분(복합 인덱스 불필요).
    const snap = await devicesRef(req.userId)
      .orderBy("registeredAt", "asc")
      .get();
    const devices = snap.docs.map(toPublic); // toPublic 이 fcmToken 을 걸러 준다
    res.json({ userId: req.userId, count: devices.length, devices });
  } catch (err) {
    logger.error(`기기 목록 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /devices/:deviceId — 설정 화면에서 기기 삭제
// ═════════════════════════════════════════════════════════════
router.delete("/devices/:deviceId", verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "deviceId 형식이 잘못되었습니다" });
    }

    const ref = devicesRef(req.userId).doc(deviceId); // 내 기기만 지울 수 있음(경로에 내 uid)
    const doc = await ref.get();
    if (!doc.exists) {
      // 없는 걸 지웠다고 ok 를 주면 앱이 "지워졌다" 고 오해한다. 404 로 알려 준다.
      return res.status(404).json({ error: "등록되지 않은 기기입니다" });
    }

    await ref.delete();
    // ※ 그 기기가 올린 userLogs 는 지우지 않는다.
    //    지우면 과거 통계가 줄어든다. 기기를 없앤 것이지 기록을 없앤 게 아님.

    const deviceCount = await countActiveDevices(req.userId);
    logger.info(
      `기기 삭제 — userId: ${req.userId}, deviceId: ${deviceId}, 남은 활성 기기 ${deviceCount}대`,
    );
    res.json({ status: "ok", deviceId, deviceCount });
  } catch (err) {
    logger.error(`기기 삭제 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// router 외에 나머지 3개는 sync.js 가 재사용한다.
// 같은 검증 규칙을 두 파일에 복붙하면 나중에 한쪽만 고치는 사고가 난다.
module.exports = { router, isValidDeviceId, countActiveDevices, devicesRef };

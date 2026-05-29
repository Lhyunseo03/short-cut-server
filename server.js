// server.js — 메인 서버 진입점
'use strict';

const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');
const logger  = require('./utils/logger');
const { registerHandlers } = require('./handlers/socketHandlers');

// ── 설정 ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// KST (한국 표준시) = UTC + 9시간
const KST_OFFSET = 9 * 60 * 60 * 1000;

// timestamp(ms)를 KST 기준 날짜 문자열(YYYY-MM-DD)로 변환
function toKSTDateString(timestamp) {
  return new Date(timestamp + KST_OFFSET).toISOString().slice(0, 10);
}

// timestamp(ms)의 KST 기준 시(hour) 반환
function toKSTHour(timestamp) {
  return new Date(timestamp + KST_OFFSET).getUTCHours();
}

// timestamp(ms)를 KST 기준 HH:mm 문자열로 변환 (hourly violation 시각 표시용)
function toKSTHHMM(timestamp) {
  const d = new Date(timestamp + KST_OFFSET);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ── Express ────────────────────────────────────────────────
const app = express();
app.use(express.json());

// 헬스체크 — Android 앱이나 CI에서 서버 살아있는지 확인용
app.get('/health', (_req, res) => {
  logger.info('헬스체크 요청 받음');
  res.json({ status: 'ok', uptime: process.uptime(), time: Date.now() });
});

// ── HTTP + Socket.IO 서버 생성 ─────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    // 개발 중에는 전체 허용, 프로덕션에서는 출처를 제한하세요
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // 클라이언트가 일시적으로 끊겼을 때 재연결을 기다리는 시간 (ms)
  pingTimeout:  20000,
  pingInterval: 10000,
});

// ── Socket.IO 이벤트 핸들러 등록 ──────────────────────────
registerHandlers(io);

// ── 서버 시작 ──────────────────────────────────────────────
// 서버가 localhost(127.0.0.1)에만 열려있어서 에뮬레이터가 못 붙는 거예요.
// 0.0.0.0으로 바꾸면 에뮬레이터 포함 모든 네트워크 인터페이스에서 접근 가능해져요.
httpServer.listen(PORT, '0.0.0.0', () => {
  logger.success(`서버 시작 — http://localhost:${PORT}`);
  logger.info('대기 중인 이벤트: scroll_event, ping_test');
  logger.info('헬스체크: GET /health');
});

// ── 조회 API ───────────────────────────────────────────────
const { db } = require('./utils/firebase');
// Firebase Auth 토큰 검증 미들웨어 import
const { verifyToken } = require('./middleware/auth');

// ══════════════════════════════════════════════════════════════
// Stats 캐시 헬퍼
//
// Firestore 경로: stats/{userId}/daily/{YYYY-MM-DD}
//
// 오늘 날짜는 캐시에 저장하지 않음 (데이터가 계속 바뀌므로)
// 어제 이전 날짜는 첫 조회 시 userLogs + violations 전체 스캔 후 결과를 저장
// → 이후 조회부터는 캐시 문서 1개만 읽으면 됨 (빠름)
//
// 주간/월간 통계도 이 캐시를 기반으로 계산 → userLogs 대량 스캔 불필요
// ══════════════════════════════════════════════════════════════

// 원시 데이터(userLogs + violations)에서 하루 통계를 계산해 반환
// 캐시 저장은 하지 않음 — 저장 여부는 호출 측에서 결정
async function computeDailyStats(userId, date, limits) {
  const startOfDay = new Date(date + 'T00:00:00.000+09:00').getTime();
  const endOfDay   = new Date(date + 'T23:59:59.999+09:00').getTime();

  // 그날 스크롤 로그 가져오기
  const logsSnap = await db.collection('userLogs')
    .where('userId', '==', userId)
    .where('timestamp', '>=', startOfDay)
    .where('timestamp', '<=', endOfDay)
    .orderBy('timestamp', 'asc')
    .get();
  const logs = logsSnap.docs.map(d => d.data());

  // 총 스크롤 횟수
  const totalScroll = logs.reduce((s, l) => s + l.scrollCount, 0);

  // 플랫폼별 집계 — platform 필드 없는 구버전 로그는 youtube로 처리
  const platform = { youtube: 0, instagram: 0, tiktok: 0 };
  logs.forEach(l => {
    const p = l.platform || 'youtube';
    if (p in platform) platform[p] += l.scrollCount;
  });

  // 시간대별 그래프 (24칸, 인덱스 = KST 시간)
  const hourlyGraph = new Array(24).fill(0);
  logs.forEach(l => { hourlyGraph[toKSTHour(l.timestamp)] += l.scrollCount; });

  // 가장 많이 본 시간대
  const peakHour = totalScroll > 0
    ? hourlyGraph.indexOf(Math.max(...hourlyGraph))
    : null;

  // 그날 violation 가져오기
  const violSnap = await db.collection('violations')
    .where('userId', '==', userId)
    .where('timestamp', '>=', startOfDay)
    .where('timestamp', '<=', endOfDay)
    .orderBy('timestamp', 'asc')
    .get();
  const violations = violSnap.docs.map(d => d.data());

  // stop / ignore 횟수
  const stopCount   = violations.filter(v => v.action === 'stop').length;
  const ignoreCount = violations.filter(v => v.action === 'ignore').length;

  // hourly violation 목록 — timeKST는 "14:23" 형식으로 앱 UI에서 바로 표시 가능
  // hourlyScrollCount / dailyScrollCount: 구버전(scrollCount만 있는) 데이터도 호환
  const hourlyViolations = violations
    .filter(v => v.limitType === 'hourly')
    .map(v => ({
      time:              new Date(v.timestamp).toISOString(),
      timeKST:           toKSTHHMM(v.timestamp),
      hourlyScrollCount: v.hourlyScrollCount ?? v.scrollCount ?? 0,
      dailyScrollCount:  v.dailyScrollCount  ?? 0,
      hourlyLimit:       limits.hourlyLimit,
    }));

  // daily violation
  const dailyViolEntry = violations.find(v => v.limitType === 'daily');

  // 목표 달성 여부 — 일일 한도 이내면 달성
  const goalAchieved = limits.dailyLimit > 0
    ? totalScroll <= limits.dailyLimit
    : true;

  return {
    userId,
    date,
    totalScroll,
    platform,
    dailyLimit:          limits.dailyLimit,
    hourlyLimit:         limits.hourlyLimit,
    goalAchieved,
    stopCount,
    ignoreCount,
    peakHour,
    hourlyGraph,
    hourlyViolations,
    hourlyLimitExceeded: hourlyViolations.length > 0,
    dailyViolation:      !!dailyViolEntry,
    dailyViolationTime:  dailyViolEntry
      ? new Date(dailyViolEntry.timestamp).toISOString()
      : null,
    calculatedAt: Date.now(),
  };
}

// 하루 통계 가져오기
// isToday=true  → 항상 실시간 계산, 캐시에 저장하지 않음
// isToday=false → 캐시 우선 조회, 없으면 계산 후 캐시 저장
async function getDailyStats(userId, date, limits, isToday = false) {
  if (!isToday) {
    // 캐시 조회
    const cached = await db.collection('stats').doc(userId)
      .collection('daily').doc(date).get();
    if (cached.exists) return cached.data();
  }

  // 캐시 miss 또는 오늘 → 실시간 계산
  const data = await computeDailyStats(userId, date, limits);

  if (!isToday) {
    // 과거 날짜만 캐시에 저장 — 이후 조회부터 빠르게
    await db.collection('stats').doc(userId)
      .collection('daily').doc(date).set(data);
  }

  return data;
}

// ── 스크롤 배치 저장 — POST /userlogs ─────────────────────
// Android에서 10개 누적 or 5분마다 배치 전송
app.post('/userlogs', verifyToken, async (req, res) => {
  try {
    const { userId, logId, timestamp, scrollCount, platform } = req.body;

    // 필수 필드 검증 — logId 추가됨 (중복 방지용 UUID)
    if (!userId || !logId || !timestamp || scrollCount === undefined) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    if (typeof scrollCount !== 'number' || scrollCount <= 0) {
      return res.status(400).json({ error: 'scrollCount는 양수여야 합니다' });
    }

    // platform 검증 — youtube / instagram / tiktok만 허용
    const validPlatforms = ['youtube', 'instagram', 'tiktok'];
    if (platform && !validPlatforms.includes(platform)) {
      return res.status(400).json({ error: 'platform은 youtube, instagram, tiktok 중 하나여야 합니다' });
    }

    // logId를 Firestore 문서 ID로 사용
    // 앱이 같은 배치를 재전송해도 동일한 문서를 덮어쓰기 → 중복 집계 방지
    // 기존 add() 방식은 호출할 때마다 새 문서 생성 → 중복 저장됨
    await db.collection('userLogs').doc(logId).set({
      userId,
      logId,
      timestamp,
      scrollCount,
      platform: platform || 'youtube', // platform 없는 구버전 앱은 youtube로 처리
    });

    logger.success(`userLog 저장 완료 — userId: ${userId}, logId: ${logId}, scrollCount: ${scrollCount}, platform: ${platform || 'youtube'}`);
    res.json({ status: 'ok' });

  } catch (err) {
    logger.error(`userLog 저장 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// user별 조회 — GET /logs/:userId
// 특정 유저의 최근 50개 로그 반환
app.get('/logs/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const snapshot = await db.collection('userLogs')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ userId, count: logs.length, logs });
  } catch (err) {
    logger.error(`logs 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 시간 범위 조회 — GET /logs/:userId/range
// 시작시간, 끝시간 사이 로그만 반환
app.get('/logs/:userId/range', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { start, end } = req.query;

    let query = db.collection('userLogs').where('userId', '==', userId);
    if (start) query = query.where('timestamp', '>=', Number(start));
    if (end)   query = query.where('timestamp', '<=', Number(end));
    query = query.orderBy('timestamp', 'desc').limit(50);

    const snapshot = await query.get();
    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ userId, count: logs.length, logs });
  } catch (err) {
    logger.error(`logs 범위 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// violation_event 수신 — POST /violations
// scrollCount → hourlyScrollCount + dailyScrollCount 로 분리
// hourlyScrollCount: 위반 시점 최근 1시간 누적 스크롤 수
// dailyScrollCount:  위반 시점 오늘 누적 스크롤 수
app.post('/violations', verifyToken, async (req, res) => {
  try {
    const { userId, timestamp, limitType, hourlyScrollCount, dailyScrollCount, action } = req.body;

    // 필수 필드 검증
    if (!userId || !timestamp || !limitType || !action) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    if (hourlyScrollCount === undefined || dailyScrollCount === undefined) {
      return res.status(400).json({ error: 'hourlyScrollCount, dailyScrollCount 필드 누락' });
    }

    if (!['hourly', 'daily'].includes(limitType)) {
      return res.status(400).json({ error: 'limitType은 hourly 또는 daily여야 합니다' });
    }

    if (!['stop', 'ignore'].includes(action)) {
      return res.status(400).json({ error: 'action은 stop 또는 ignore여야 합니다' });
    }

    // Firestore 저장
    await db.collection('violations').add({
      userId,
      timestamp,
      limitType,
      hourlyScrollCount, // 위반 시점 최근 1시간 스크롤 수
      dailyScrollCount,  // 위반 시점 오늘 누적 스크롤 수
      action,
    });

    logger.success(`violation 저장 완료 — userId: ${userId}, limitType: ${limitType}, hourly: ${hourlyScrollCount}, daily: ${dailyScrollCount}`);
    res.json({ status: 'ok' });

  } catch (err) {
    logger.error(`violation 저장 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 일간 통계 — GET /stats/:userId/daily?date=2026-05-03
// 오늘: 실시간 계산 / 과거: stats 캐시 우선 (없으면 계산 후 캐시 저장)
// 응답에 hourlyLimit, platform별 집계, hourly violation 시각(HH:mm) 포함
app.get('/stats/:userId/daily', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date 파라미터가 필요합니다' });
    }

    const todayKST = toKSTDateString(Date.now());
    const isToday  = date === todayKST;

    // limit 가져오기 (없으면 기본값)
    const limitsDoc = await db.collection('limits').doc(userId).get();
    const limits = limitsDoc.exists
      ? limitsDoc.data()
      : { hourlyLimit: 50, dailyLimit: 100 };

    const stats = await getDailyStats(userId, date, limits, isToday);

    // hourlyGraph를 앱 형식으로 변환 (scrollCount > 0인 시간대만)
    const hourlyGraphArr = stats.hourlyGraph
      .map((count, hour) => ({ hour, scrollCount: count }))
      .filter(h => h.scrollCount > 0);

    res.json({
      userId,
      date,
      totalScroll:         stats.totalScroll,
      platform:            stats.platform,
      dailyLimit:          stats.dailyLimit,
      hourlyLimit:         stats.hourlyLimit,
      goalAchieved:        stats.goalAchieved,
      stopCount:           stats.stopCount,
      ignoreCount:         stats.ignoreCount,
      peakHour:            stats.peakHour,
      hourlyGraph:         hourlyGraphArr,
      hourlyLimitExceeded: stats.hourlyLimitExceeded,
      hourlyViolations:    stats.hourlyViolations,  // timeKST 포함
      dailyViolation:      stats.dailyViolation,
      dailyViolationTime:  stats.dailyViolationTime,
    });

  } catch (err) {
    logger.error(`daily stats 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 주간 통계 — GET /stats/:userId/weekly?date=2026-05-03
// stats 캐시 기반으로 전환 — userLogs 대량 스캔 없이 일별 캐시 합산
// platform별 집계, dailyTotals(앱 히트맵용) 포함
app.get('/stats/:userId/weekly', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date 파라미터가 필요합니다' });
    }

    const todayKST = toKSTDateString(Date.now());

    // 이번 주 월요일 ~ date 계산 (KST 기준)
    const refDate     = new Date(date + 'T00:00:00.000+09:00');
    const dayOfWeek   = refDate.getUTCDay();
    const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStartDate = new Date(refDate);
    weekStartDate.setUTCDate(refDate.getUTCDate() - daysFromMon);

    // 주간 날짜 목록 (월~일, 오늘까지만)
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartDate);
      d.setUTCDate(weekStartDate.getUTCDate() + i);
      const ds = d.toISOString().slice(0, 10);
      if (ds <= todayKST) days.push(ds);
    }

    // limit 가져오기 (없으면 기본값)
    const limitsDoc = await db.collection('limits').doc(userId).get();
    const limits = limitsDoc.exists
      ? limitsDoc.data()
      : { hourlyLimit: 50, dailyLimit: 100 };

    // 각 날짜 통계 병렬 조회 — 캐시 있으면 빠름, 없으면 계산 후 저장
    const dayStats = await Promise.all(
      days.map(d => getDailyStats(userId, d, limits, d === todayKST))
    );

    // 주간 집계
    const totalScroll = dayStats.reduce((s, d) => s + d.totalScroll, 0);
    const platform    = { youtube: 0, instagram: 0, tiktok: 0 };
    dayStats.forEach(d => {
      platform.youtube   += d.platform?.youtube   || 0;
      platform.instagram += d.platform?.instagram || 0;
      platform.tiktok    += d.platform?.tiktok    || 0;
    });

    // 가장 많이 본 날
    const peakDay = dayStats.reduce(
      (max, d) => d.totalScroll > (max?.totalScroll || 0) ? d : max,
      null
    );

    // 날짜별 totals — 앱 히트맵 그리드에서 사용
    const dailyTotals = {};
    dayStats.forEach(d => { dailyTotals[d.date] = d.totalScroll; });

    const daysPassed = days.length;

    res.json({
      userId,
      weekStart:       days[0],
      weekEnd:         date,
      totalScroll,
      avgScrollPerDay: daysPassed > 0 ? Math.round(totalScroll / daysPassed) : 0,
      daysPassed,
      platform,
      peakDay:         peakDay?.totalScroll > 0
        ? { date: peakDay.date, scrollCount: peakDay.totalScroll }
        : null,
      dailyTotals,
    });

  } catch (err) {
    logger.error(`weekly stats 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// limit 설정 저장 — POST /limits/:userId
app.post('/limits/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params; // 주소에서 변수 꺼내서 userId에 저장
    const { hourlyLimit, dailyLimit } = req.body;

    if (hourlyLimit === undefined || dailyLimit === undefined) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    if (typeof hourlyLimit !== 'number' || typeof dailyLimit !== 'number') {
      return res.status(400).json({ error: 'hourlyLimit, dailyLimit은 숫자여야 합니다' });
    }

    // firebase 에 저장
    await db.collection('limits').doc(userId).set({
      userId,
      hourlyLimit,
      dailyLimit,
      updatedAt: Date.now(),
    });

    logger.success(`limit 저장 완료 — userId: ${userId}`);
    res.json({ status: 'ok' });

  } catch (err) {
    logger.error(`limit 저장 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 월간 통계 — GET /stats/:userId/monthly?date=2026-05
// stats 캐시 기반으로 전환 — platform별 집계, stop/ignore 합산, 목표달성일 수 포함
app.get('/stats/:userId/monthly', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query; // "2026-05"

    if (!date) {
      return res.status(400).json({ error: 'date 파라미터가 필요합니다' });
    }

    const todayKST  = toKSTDateString(Date.now());
    const year      = parseInt(date.slice(0, 4));
    const month     = parseInt(date.slice(5, 7));
    const daysInMonth = new Date(year, month, 0).getDate();

    // 해당 달의 날짜 목록 (오늘까지만)
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${date}-${String(d).padStart(2, '0')}`;
      if (ds <= todayKST) days.push(ds);
    }

    if (days.length === 0) {
      return res.json({
        userId, month: date,
        totalScroll: 0, avgScrollPerDay: 0, daysPassed: 0,
        platform: { youtube: 0, instagram: 0, tiktok: 0 },
        peakDay: null, goalAchievedCount: 0, stopCount: 0, ignoreCount: 0,
        dailyTotals: {},
      });
    }

    // limit 가져오기 (없으면 기본값)
    const limitsDoc = await db.collection('limits').doc(userId).get();
    const limits = limitsDoc.exists
      ? limitsDoc.data()
      : { hourlyLimit: 50, dailyLimit: 100 };

    // 각 날짜 통계 병렬 조회 — 캐시 있으면 빠름, 없으면 계산 후 저장
    const dayStats = await Promise.all(
      days.map(d => getDailyStats(userId, d, limits, d === todayKST))
    );

    // 월간 집계
    const totalScroll = dayStats.reduce((s, d) => s + d.totalScroll, 0);
    const platform    = { youtube: 0, instagram: 0, tiktok: 0 };
    let stopCount = 0, ignoreCount = 0, goalAchievedCount = 0;

    dayStats.forEach(d => {
      platform.youtube   += d.platform?.youtube   || 0;
      platform.instagram += d.platform?.instagram || 0;
      platform.tiktok    += d.platform?.tiktok    || 0;
      stopCount          += d.stopCount   || 0;
      ignoreCount        += d.ignoreCount || 0;
      if (d.goalAchieved) goalAchievedCount++;
    });

    // 가장 많이 본 날
    const peakDay = dayStats.reduce(
      (max, d) => d.totalScroll > (max?.totalScroll || 0) ? d : max,
      null
    );

    // 날짜별 totals — 앱 히트맵 달력에서 사용
    const dailyTotals = {};
    dayStats.forEach(d => { dailyTotals[d.date] = d.totalScroll; });

    const daysPassed = days.length;

    res.json({
      userId,
      month:           date,
      totalScroll,
      avgScrollPerDay: daysPassed > 0 ? Math.round(totalScroll / daysPassed) : 0,
      daysPassed,
      platform,
      peakDay:         peakDay?.totalScroll > 0
        ? { date: peakDay.date, scrollCount: peakDay.totalScroll }
        : null,
      goalAchievedCount, // 목표(dailyLimit) 달성한 날 수
      stopCount,
      ignoreCount,
      dailyTotals,
    });

  } catch (err) {
    logger.error(`monthly stats 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// limit 조회 — GET /limits/:userId
app.get('/limits/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const doc = await db.collection('limits').doc(userId).get();

    if (!doc.exists) {
      return res.json({
        userId,
        hourlyLimit: 50,
        dailyLimit: 100,
      }); // 기본값 반환
    }

    res.json({ userId, ...doc.data() }); // userId랑 doc에 있는 data 합쳐서 넣음

  } catch (err) {
    logger.error(`limit 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 회원 탈퇴 — DELETE /users/:userId
// 유저의 Firestore 데이터 전체 삭제 + Firebase Auth 계정 삭제
// 본인 계정만 탈퇴 가능 (토큰의 uid와 요청 userId 일치 여부 확인)
app.delete('/users/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    // 토큰에서 추출한 uid와 요청한 userId 비교
    // 다른 유저의 계정을 삭제하는 것을 방지
    if (req.userId !== userId) {
      return res.status(403).json({ error: '본인 계정만 탈퇴할 수 있습니다' });
    }

    // Firestore — userLogs 컬렉션에서 해당 유저 문서 전체 삭제
    // 스크롤 통계 데이터 삭제
    const userLogsSnapshot = await db.collection('userLogs')
      .where('userId', '==', userId)
      .get();
    const deleteUserLogs = userLogsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(deleteUserLogs); // 병렬 삭제로 속도 최적화
    logger.info(`userLogs 삭제 완료 — userId: ${userId}`);

    // Firestore — violations 컬렉션에서 해당 유저 문서 전체 삭제
    // 한도 초과 위반 기록 삭제
    const violationsSnapshot = await db.collection('violations')
      .where('userId', '==', userId)
      .get();
    const deleteViolations = violationsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(deleteViolations); // 병렬 삭제로 속도 최적화
    logger.info(`violations 삭제 완료 — userId: ${userId}`);

    // Firestore — limits 문서 삭제
    // hourly/daily limit 설정 삭제
    await db.collection('limits').doc(userId).delete();
    logger.info(`limits 삭제 완료 — userId: ${userId}`);

    // Firestore — stats 서브컬렉션 삭제
    // Firestore는 부모 문서 삭제 시 서브컬렉션이 자동 삭제되지 않으므로 별도 삭제 필요
    const statsSnapshot = await db.collection('stats').doc(userId)
      .collection('daily').get();
    await Promise.all(statsSnapshot.docs.map(doc => doc.ref.delete()));
    await db.collection('stats').doc(userId).delete();
    logger.info(`stats 삭제 완료 — userId: ${userId}`);

    // Firebase Auth — 계정 삭제
    // 삭제 후 해당 계정으로 로그인 불가능
    const { admin } = require('./utils/firebase');
    await admin.auth().deleteUser(userId);
    logger.info(`Firebase Auth 계정 삭제 완료 — userId: ${userId}`);

    logger.success(`회원 탈퇴 완료 — userId: ${userId}`);
    res.json({ status: 'ok' });

  } catch (err) {
    logger.error(`회원 탈퇴 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// AI 통계 분석 — POST /analyze
// 앱이 보낸 통계 프롬프트를 Gemini에 전달하고 분석 결과만 반환
// API 키는 서버 환경변수에만 보관 — 앱에 절대 노출 안 됨
const { GoogleGenerativeAI } = require('@google/generative-ai');

app.post('/analyze', verifyToken, async (req, res) => {
  try {
    const { userId, prompt } = req.body;

    // 필수 필드 검증
    if (!userId || !prompt) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    // Gemini 클라이언트 초기화 — 환경변수에서 API 키 로드
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // 프롬프트가 최근 14일 통계라 길 수 있음 → 60초 타임아웃
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI 응답 타임아웃')), 60000)
      ),
    ]);

    // Gemini 응답에서 텍스트만 추출해서 반환
    const analysis = result.response.text();

    logger.success(`AI 분석 완료 — userId: ${userId}`);
    res.json({ analysis });

  } catch (err) {
    logger.error(`AI 분석 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── 예외 처리 ──────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection:', reason);
})
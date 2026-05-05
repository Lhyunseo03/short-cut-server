// server.js — 메인 서버 진입점
'use strict';

const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');
const logger  = require('./utils/logger');
const { registerHandlers } = require('./handlers/socketHandlers');

// ── 설정 ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

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
//서버가 localhost(127.0.0.1)에만 열려있어서 에뮬레이터가 못 붙는 거예요.
//0.0.0.0으로 바꾸면 에뮬레이터 포함 모든 네트워크 인터페이스에서 접근 가능해져요.
httpServer.listen(PORT, '0.0.0.0', () => {
  logger.success(`서버 시작 — http://localhost:${PORT}`);
  logger.info('대기 중인 이벤트: scroll_event, ping_test');
  logger.info('헬스체크: GET /health');
});

// ── 조회 API ───────────────────────────────────────────────
const { db } = require('./utils/firebase');

// user별 조회 — GET /logs/:userId
// 특정 유저의 최근 50개 로그 반환 
app.get('/logs/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snapshot = await db.collection('userLogs')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ userId, count: logs.length, logs });
  } catch (err) {
    logger.error(`logs 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 시간 범위 조회 — GET /logs/:userId?start=1700000000000&end=1700999999999
// 시작시간, 끝시간 사이 로그만 반환 
app.get('/logs/:userId/range', async (req, res) => {
  try {
    const { userId } = req.params;
    const { start, end } = req.query;

    let query = db.collection('userLogs').where('userId', '==', userId);
    if (start) query = query.where('createdAt', '>=', Number(start));
    if (end)   query = query.where('createdAt', '<=', Number(end));
    query = query.orderBy('createdAt', 'desc').limit(50);

    const snapshot = await query.get();
    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ userId, count: logs.length, logs });
  } catch (err) {
    logger.error(`logs 범위 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// violation_event 수신 — POST /violations
app.post('/violations', async (req, res) => {
  try {
    const { userId, timestamp, limitType, scrollCount, action } = req.body;

    // 필수 필드 검증
    if (!userId || !timestamp || !limitType || scrollCount === undefined) {
      return res.status(400).json({ error: '필수 필드 누락' });
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
      scrollCount,
      action
    });

    logger.success(`violation 저장 완료 — userId: ${userId}, limitType: ${limitType}`);
    res.json({ status: 'ok' });

  } catch (err) {
    logger.error(`violation 저장 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 일간 통계 — GET /stats/:userId/daily?date=2026-05-03
app.get('/stats/:userId/daily', async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date 파라미터가 필요합니다' });
    }

    // 하루 시작/끝 시각 계산
    const startOfDay = new Date(date + 'T00:00:00.000Z').getTime();
    const endOfDay   = new Date(date + 'T23:59:59.999Z').getTime();

    // limit 가져오기 (없으면 기본값)
    const limitsDoc = await db.collection('limits').doc(userId).get();
    const limits = limitsDoc.exists
      ? limitsDoc.data()
      : { hourlyLimit: 50, dailyLimit: 100 };

    // 그날 스크롤 로그 가져오기
    const logsSnapshot = await db.collection('userLogs')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startOfDay)
      .where('timestamp', '<=', endOfDay)
      .orderBy('timestamp', 'asc')
      .get();

    const logs = logsSnapshot.docs.map(doc => doc.data());

    // 총 스크롤 횟수
    const totalScroll = logs.length;

    // 시간대별 그래프
    const hourlyGraph = Array.from({ length: 24 }, (_, i) => ({ hour: i, scrollCount: 0, exceeded: false }));
    logs.forEach(log => {
      const hour = new Date(log.timestamp).getHours();
      hourlyGraph[hour].scrollCount++;
    });

    // 그날 violation 가져오기
    const violationsSnapshot = await db.collection('violations')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startOfDay)
      .where('timestamp', '<=', endOfDay)
      .orderBy('timestamp', 'asc')
      .get();

    const violations = violationsSnapshot.docs.map(doc => doc.data());

    // daily violation
    const dailyViolationEntry = violations.find(v => v.limitType === 'daily');
    const dailyViolation      = !!dailyViolationEntry;
    const dailyViolationTime  = dailyViolationEntry
      ? new Date(dailyViolationEntry.timestamp).toISOString()
      : null;

    // hourly violation 목록
    const hourlyViolations = violations
      .filter(v => v.limitType === 'hourly')
      .map(v => ({
        time:            new Date(v.timestamp).toISOString(),
        recentHourCount: v.scrollCount,
        hourlyLimit:     limits.hourlyLimit,
      }));

    // hourlyGraph에 exceeded 표시
    hourlyViolations.forEach(v => {
      const hour = new Date(v.time).getHours();
      hourlyGraph[hour].exceeded = true;
    });

    // peakHour — recentHourCount / hourlyLimit 비율이 가장 높은 시각
    const peakHour = hourlyViolations.reduce(
      (max, v) =>
        (v.recentHourCount / v.hourlyLimit) > ((max?.recentHourCount / max?.hourlyLimit) || 0)
          ? v : max,
      null
    );

    // stop / ignore 횟수
    const stopCount   = violations.filter(v => v.action === 'stop').length;
    const ignoreCount = violations.filter(v => v.action === 'ignore').length;

    res.json({
      userId,
      date,
      totalScroll,
      dailyLimit:          limits.dailyLimit,
      dailyViolation,
      dailyViolationTime,
      hourlyLimitExceeded: hourlyViolations.length > 0,
      hourlyViolations,
      stopCount,
      ignoreCount,
      peakHour,
      hourlyGraph:         hourlyGraph.filter(h => h.scrollCount > 0),
    });

  } catch (err) {
    logger.error(`daily stats 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 주간 통계 — GET /stats/:userId/weekly?date=2026-05-03
app.get('/stats/:userId/weekly', async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date 파라미터가 필요합니다' });
    }

    // 이번 주 월요일 ~ 오늘 계산
    const today = new Date(date + 'T00:00:00.000Z');
    const dayOfWeek = today.getUTCDay(); // 0=일, 1=월, ..., 6=토
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const weekStart = new Date(today);
    weekStart.setUTCDate(today.getUTCDate() - daysFromMonday);

    const startTs = weekStart.getTime();
    const endTs   = new Date(date + 'T23:59:59.999Z').getTime();
    const daysPassed = daysFromMonday + 1; // 월요일 포함

    // 스크롤 로그 가져오기
    const logsSnapshot = await db.collection('userLogs')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startTs)
      .where('timestamp', '<=', endTs)
      .orderBy('timestamp', 'asc')
      .get();

    const logs = logsSnapshot.docs.map(doc => doc.data());

    // 총 스크롤 횟수
    const totalScroll = logs.length;

    // 하루 평균
    const avgScrollPerDay = Math.round(totalScroll / daysPassed);

    // 날짜별 스크롤 횟수
    const dailyMap = {};
    logs.forEach(log => {
      const d = new Date(log.timestamp).toISOString().slice(0, 10);
      dailyMap[d] = (dailyMap[d] || 0) + 1;
    });

    // 가장 많이 본 날
    const peakDay = Object.entries(dailyMap).reduce(
      (max, [date, count]) => count > (max?.scrollCount || 0)
        ? { date, scrollCount: count }
        : max,
      null
    );

    res.json({
      userId,
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd:   date,
      totalScroll,
      avgScrollPerDay,
      daysPassed,
      peakDay,
    });

  } catch (err) {
    logger.error(`weekly stats 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// limit 설정 저장 — POST /limits/:userId
app.post('/limits/:userId', async (req, res) => {
  try {
    const { userId } = req.params; // 주소에서 변수 꺼내서 userId에 저장 
    const { hourlyLimit, dailyLimit } = req.body;

    if (hourlyLimit === undefined || dailyLimit === undefined) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    if (typeof hourlyLimit !== 'number' || typeof dailyLimit !== 'number') {
      return res.status(400).json({ error: 'hourlyLimit, dailyLimit은 숫자여야 합니다' });
    }

    //firebase 에 저장
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
app.get('/stats/:userId/monthly', async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query; // "2026-05"

    if (!date) {
      return res.status(400).json({ error: 'date 파라미터가 필요합니다' });
    }

    // 이번 달 시작/끝 계산
    const startOfMonth = new Date(date + '-01T00:00:00.000Z').getTime();
    const today = new Date();
    const endOfMonth = new Date(
      today.getUTCFullYear() === parseInt(date.slice(0, 4)) &&
      today.getUTCMonth() + 1 === parseInt(date.slice(5, 7))
        ? today.toISOString().slice(0, 10) + 'T23:59:59.999Z'
        : date + '-' + new Date(parseInt(date.slice(0, 4)), parseInt(date.slice(5, 7)), 0).getDate() + 'T23:59:59.999Z'
    ).getTime();

    // 지난 일수 계산
    const daysPassed = Math.ceil((endOfMonth - startOfMonth) / (1000 * 60 * 60 * 24));

    // 스크롤 로그 가져오기
    const logsSnapshot = await db.collection('userLogs')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startOfMonth)
      .where('timestamp', '<=', endOfMonth)
      .orderBy('timestamp', 'asc')
      .get();

    const logs = logsSnapshot.docs.map(doc => doc.data());

    // 총 스크롤 횟수
    const totalScroll = logs.length;

    // 하루 평균
    const avgScrollPerDay = Math.round(totalScroll / daysPassed);

    // 날짜별 스크롤 횟수
    const dailyMap = {};
    logs.forEach(log => {
      const d = new Date(log.timestamp).toISOString().slice(0, 10);
      dailyMap[d] = (dailyMap[d] || 0) + 1;
    });

    // 가장 많이 본 날
    const peakDay = Object.entries(dailyMap).reduce(
      (max, [date, count]) => count > (max?.scrollCount || 0)
        ? { date, scrollCount: count }
        : max,
      null
    );

    res.json({
      userId,
      month: date,
      totalScroll,
      avgScrollPerDay,
      daysPassed,
      peakDay,
    });

  } catch (err) {
    logger.error(`monthly stats 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// limit 조회 — GET /limits/:userId
app.get('/limits/:userId', async (req, res) => {
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

    res.json({ userId, ...doc.data() }); // userid랑 doc에 있는 data 합쳐서 넣음

  } catch (err) {
    logger.error(`limit 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── 예외 처리 ──────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection:', reason);
});

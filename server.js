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

// ── 예외 처리 ──────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection:', reason);
});

// handlers/socketHandlers.js — Socket.IO 이벤트 핸들러

const logger = require('../utils/logger');
const { db } = require('../utils/firebase');  // ✅ 추가

/**
 * scroll_event 데이터 형식 (확정 초안)
 * {
 *   userId:      string   — 기기 또는 사용자 식별자
 *   appPkg:      string   — 앱 패키지명 (ex. "com.example.app")
 *   timestamp:   number   — 이벤트 발생 시각 (Unix ms)
 *   scrollCount: number   — 누적 스크롤 횟수
 * }
 */

// ── 필드 검증 ──────────────────────────────────────────────
const REQUIRED_FIELDS = ['userId', 'appPkg', 'timestamp', 'scrollCount'];

function validateScrollEvent(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'payload가 객체가 아닙니다' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) {
      return { valid: false, reason: `필수 필드 누락: "${field}"` };
    }
  }

  if (typeof data.userId !== 'string' || data.userId.trim() === '') {
    return { valid: false, reason: 'userId는 비어 있지 않은 문자열이어야 합니다' };
  }

  if (typeof data.appPkg !== 'string' || data.appPkg.trim() === '') {
    return { valid: false, reason: 'appPkg는 비어 있지 않은 문자열이어야 합니다' };
  }

  if (typeof data.timestamp !== 'number' || data.timestamp <= 0) {
    return { valid: false, reason: 'timestamp는 양수 숫자(Unix ms)여야 합니다' };
  }

  if (typeof data.scrollCount !== 'number' || data.scrollCount < 0) {
    return { valid: false, reason: 'scrollCount는 0 이상의 숫자여야 합니다' };
  }

  return { valid: true };
}

// ── scroll_event 핸들러 ────────────────────────────────────
async function handleScrollEvent(socket, data, callback) {
  const validation = validateScrollEvent(data);
  
  if (!validation.valid) {
    logger.warn(`scroll_event 검증 실패 [${socket.id}] — ${validation.reason}`);

    // ACK로 에러 응답
    if (typeof callback === 'function') {
      callback({ status: 'error', reason: validation.reason });
    }
    return;
  }

  // 정상 수신 로그
  logger.event('scroll_event', socket.id, data);

// Firestore 저장
  try {
    await db.collection('userLogs').add({
      userId:      data.userId,
      appPkg:      data.appPkg,
      eventType:   'scroll_event',
      scrollCount: data.scrollCount,
      timestamp:   data.timestamp,
      createdAt:   Date.now(),
    });
    logger.success(`userLogs 저장 완료 — userId: ${data.userId}`);
  } catch (err) {
    logger.error(`userLogs 저장 실패 — ${err.message}`);
  }

  // e.g. await ScrollEvent.save(data);

  // ACK 응답
  if (typeof callback === 'function') {
    callback({
      status: 'ok',
      received: {
        userId:      data.userId,
        appPkg:      data.appPkg,
        scrollCount: data.scrollCount,
        serverTime:  Date.now(),
      },
    });
  }
}

// ── 소켓 등록 진입점 ───────────────────────────────────────
function registerHandlers(io) {
  io.on('connection', (socket) => {
    const clientIp =
      socket.handshake.headers['x-forwarded-for'] ||
      socket.handshake.address;

    logger.connect(socket.id, clientIp);

    // scroll_event
    socket.on('scroll_event', async (data, callback) => {
      await handleScrollEvent(socket, data, callback);
    });

    // ping — 연결 확인용
    socket.on('ping_test', (data, callback) => {
      logger.info(`ping_test from ${socket.id}`);
      if (typeof callback === 'function') {
        callback({ status: 'pong', serverTime: Date.now() });
      }
    });

    // 연결 해제
    socket.on('disconnect', (reason) => {
      logger.disconnect(socket.id, reason);
    });

    // 재연결 감지 (클라이언트가 reconnect 후 다시 connect 이벤트 발생)
    socket.on('reconnect_attempt', () => {
      logger.info(`reconnect attempt from ${socket.id}`);
    });
  });
}

module.exports = { registerHandlers };

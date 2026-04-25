// test-client.js — scroll_event 테스트 클라이언트
// 실행: node test-client.js
'use strict';

const { io } = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

console.log(`[테스트 클라이언트] 서버에 연결 중: ${SERVER_URL}\n`);

const socket = io(SERVER_URL, {
  reconnectionAttempts: 3,
  timeout: 5000,
});

// ── 연결 이벤트 ───────────────────────────────────────────
socket.on('connect', () => {
  console.log(`✅ 연결됨 — socket.id: ${socket.id}\n`);
  runTests();
});

socket.on('connect_error', (err) => {
  console.error(`❌ 연결 실패: ${err.message}`);
  process.exit(1);
});

socket.on('disconnect', (reason) => {
  console.log(`\n🔌 연결 해제 — reason: ${reason}`);
});

// ── 테스트 시나리오 ───────────────────────────────────────
async function runTests() {
  // 1. ping_test — 서버 응답 확인
  console.log('--- 테스트 1: ping_test ---');
  await sendEvent('ping_test', {}, (ack) => {
    console.log('  ACK:', JSON.stringify(ack));
  });

  await delay(500);

  // 2. 정상 scroll_event
  console.log('\n--- 테스트 2: 정상 scroll_event ---');
  const validPayload = {
    userId:      'user_android_001',
    appPkg:      'com.example.myapp',
    timestamp:   Date.now(),
    scrollCount: 42,
  };
  await sendEvent('scroll_event', validPayload, (ack) => {
    console.log('  ACK:', JSON.stringify(ack, null, 2));
  });

  await delay(500);

  // 3. 누락 필드 — 에러 응답 확인
  console.log('\n--- 테스트 3: scrollCount 누락 (에러 케이스) ---');
  const missingField = {
    userId:    'user_android_001',
    appPkg:    'com.example.myapp',
    timestamp: Date.now(),
    // scrollCount 없음
  };
  await sendEvent('scroll_event', missingField, (ack) => {
    console.log('  ACK:', JSON.stringify(ack));
  });

  await delay(500);

  // 4. 잘못된 타입 — 에러 응답 확인
  console.log('\n--- 테스트 4: scrollCount 음수 (에러 케이스) ---');
  const badType = {
    userId:      'user_android_001',
    appPkg:      'com.example.myapp',
    timestamp:   Date.now(),
    scrollCount: -5,
  };
  await sendEvent('scroll_event', badType, (ack) => {
    console.log('  ACK:', JSON.stringify(ack));
  });

  await delay(300);

  console.log('\n✅ 모든 테스트 완료');
  socket.disconnect();
}

// ── 헬퍼 ─────────────────────────────────────────────────
function sendEvent(event, data, callback) {
  return new Promise((resolve) => {
    socket.emit(event, data, (ack) => {
      if (callback) callback(ack);
      resolve(ack);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

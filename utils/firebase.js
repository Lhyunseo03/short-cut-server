// utils/firebase.js — Firebase Admin SDK 초기화

const admin = require('firebase-admin');

let credential;
let serviceAccount;  // ← 밖으로 꺼내기

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log('[DEBUG] SA prefix:', process.env.FIREBASE_SERVICE_ACCOUNT?.substring(0, 30));

  // Railway 환경 — base64 디코딩
  serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
  );

  console.log('[DEBUG] project_id:', serviceAccount.project_id);
  console.log('[DEBUG] client_email:', serviceAccount.client_email);
  console.log('[DEBUG] private_key valid:', serviceAccount.private_key?.startsWith('-----BEGIN RSA PRIVATE KEY-----') || serviceAccount.private_key?.startsWith('-----BEGIN PRIVATE KEY-----'));
  console.log('[DEBUG] has newlines:', serviceAccount.private_key?.includes('\n'));
  credential = admin.credential.cert(serviceAccount);
} else {
  // 로컬 환경
  serviceAccount = require('../serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

//임시 로그 - railway에서 firebase_service_account 환경변수가 실제로 인식되는지 확인 
//console.log('ENV CHECK:', !!process.env.FIREBASE_SERVICE_ACCOUNT);

//fix: Firebase projectId 명시

//debug: Firebase 초기화 에러 로그 추가
try {
  admin.initializeApp({ 
    credential,
    projectId: serviceAccount.project_id
  });
  console.log('[DEBUG] Firebase 초기화 성공');
} catch (e) {
  console.error('[DEBUG] Firebase 초기화 실패:', e.message);
}

const db = admin.firestore();

module.exports = { db };
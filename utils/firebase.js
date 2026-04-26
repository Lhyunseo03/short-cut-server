// utils/firebase.js — Firebase Admin SDK 초기화

const admin = require('firebase-admin');

let credential;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log('[DEBUG] SA prefix:', process.env.FIREBASE_SERVICE_ACCOUNT?.substring(0, 30));

  // Railway 환경 — base64 디코딩
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
  );

  console.log('[DEBUG] project_id:', serviceAccount.project_id);
  console.log('[DEBUG] client_email:', serviceAccount.client_email);
  credential = admin.credential.cert(serviceAccount);
} else {
  // 로컬 환경
  const serviceAccount = require('../serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

//임시 로그 - railway에서 firebase_service_account 환경변수가 실제로 인식되는지 확인 
//console.log('ENV CHECK:', !!process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential });

const db = admin.firestore();

module.exports = { db };
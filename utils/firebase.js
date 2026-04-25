// utils/firebase.js — Firebase Admin SDK 초기화

const admin = require('firebase-admin');

let credential;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Railway 환경 — base64 디코딩
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
  );
  credential = admin.credential.cert(serviceAccount);
} else {
  // 로컬 환경
  const serviceAccount = require('../serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

admin.initializeApp({ credential });

const db = admin.firestore();

module.exports = { db };
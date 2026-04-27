const admin = require('firebase-admin');

let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
  );
  credential = admin.credential.cert(serviceAccount);
} else {
  const serviceAccount = require('../serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

admin.initializeApp({ credential });

// 토큰 발급 테스트
admin.app().options.credential.getAccessToken()
  .then(token => console.log('[DEBUG] 토큰 발급 성공:', token.expirationTime))
  .catch(err => console.error('[DEBUG] 토큰 발급 실패:', err.message));

const db = admin.firestore();
module.exports = { db };
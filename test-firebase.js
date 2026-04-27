const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount) 
});

admin.firestore().collection('test').add({ test: true })
  .then(ref => { console.log('✅ 성공:', ref.id); process.exit(0); })
  .catch(err => { console.error('❌ 실패:', err.message); process.exit(1); });
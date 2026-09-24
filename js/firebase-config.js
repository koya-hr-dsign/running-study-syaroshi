/* firebase-config.js — Firebase の接続情報
 *
 * ここに並ぶ値は公開前提のもので、リポジトリに含めて問題ない。
 * データを守るのは Firestore のセキュリティルール側で、
 * ログインした本人の users/{uid} 配下だけを読み書きできるようにしてある。
 *
 * 同期を使わない場合は window.FIREBASE_CONFIG = null; にすればよい。
 */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC1I3XAOWCKN3YyI9a4EzK8IeRW32CYVfo',
  authDomain: 'running-study-syaroshi.firebaseapp.com',
  projectId: 'running-study-syaroshi',
  storageBucket: 'running-study-syaroshi.firebasestorage.app',
  messagingSenderId: '160064546719',
  appId: '1:160064546719:web:11f46c47bb966981113faa'
};

// Firebase JS SDK の配信元。バージョンは固定する
window.FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/11.10.0/';

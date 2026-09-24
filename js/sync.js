/* sync.js — Google ログインと Firestore による学習履歴の同期
 *
 * 設計はローカル優先。端末内の localStorage / IndexedDB を常に正とし、
 * Firestore はその上に乗る同期層として扱う。ログインしなくてもアプリは
 * 従来どおり動き、オフラインでも学習できる。
 *
 * Firestore の構成
 *   users/{uid}/state/progress    学習履歴（配列。問題 id をキーにしないのは
 *                                 Firestore のマップキーに使えない文字があるため）
 *   users/{uid}/state/settings    設定（APIキーなど端末固有のものは除く）
 *   users/{uid}/questions/{n}     取り込んだ問題を50問ずつ分割して保存
 */
(function (global) {
  'use strict';

  var CHUNK = 50;
  // 端末ごとに持つべき設定は同期しない。API キーをクラウドに置かないのが主眼
  var LOCAL_ONLY = ['geminiKey', 'voiceURI'];

  var fb = null;          // 読み込んだ SDK の関数をまとめたもの
  var loading = null;
  var db = null, auth = null;

  function loadSDK() {
    if (loading) return loading;
    var base = global.FIREBASE_SDK;
    loading = Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js')
    ]).then(function (mods) {
      var app = mods[0], a = mods[1], f = mods[2];
      fb = { app: app, auth: a, fs: f };
      var instance = app.initializeApp(global.FIREBASE_CONFIG);
      auth = a.getAuth(instance);
      // オフラインでも読み書きを受け付け、復帰時にまとめて送る
      try {
        db = f.initializeFirestore(instance, {
          localCache: f.persistentLocalCache({ tabManager: f.persistentMultipleTabManager() })
        });
      } catch (e) {
        db = f.getFirestore(instance);
      }
      a.onAuthStateChanged(auth, function (u) {
        Sync.user = u;
        if (Sync.onChange) Sync.onChange();
        if (u) Sync.run('ログイン');
      });
      return fb;
    }).catch(function (e) {
      loading = null;
      throw new Error('Firebase の読み込みに失敗しました（' + e.message + '）');
    });
    return loading;
  }

  function stateDoc(name) {
    return fb.fs.doc(db, 'users', Sync.user.uid, 'state', name);
  }

  var Sync = {
    user: null,
    busy: false,
    lastSyncAt: 0,
    lastError: '',
    onChange: null,

    get configured() { return !!(global.FIREBASE_CONFIG && global.FIREBASE_CONFIG.apiKey); },
    get signedIn() { return !!Sync.user; },

    /** 起動時に呼ぶ。すでにログイン済みならセッションが復元される */
    init: function () {
      if (!Sync.configured) return Promise.resolve(false);
      return loadSDK().then(function () { return true; }).catch(function (e) {
        Sync.lastError = e.message;
        return false;
      });
    },

    signIn: function () {
      if (!Sync.configured) return Promise.reject(new Error('Firebase が設定されていません'));
      return loadSDK().then(function () {
        var provider = new fb.auth.GoogleAuthProvider();
        return fb.auth.signInWithPopup(auth, provider).catch(function (e) {
          // ポップアップがブロックされる環境ではリダイレクトに切り替える
          if (/popup-blocked|popup-closed|cancelled-popup/.test(e.code || '')) {
            return fb.auth.signInWithRedirect(auth, provider);
          }
          throw e;
        });
      });
    },

    signOut: function () {
      if (!auth) return Promise.resolve();
      return fb.auth.signOut(auth).then(function () {
        Sync.user = null;
        if (Sync.onChange) Sync.onChange();
      });
    },

    /**
     * 取得 → 統合 → 反映 をまとめて行う。
     * 履歴は問題ごとに last が新しいほうを採るので、どちらの端末で解いた
     * 分も失われない。設定は updatedAt が新しい側をまるごと採用する。
     */
    run: function (reason) {
      if (!Sync.signedIn || Sync.busy) return Promise.resolve(null);
      Sync.busy = true;
      Sync.lastError = '';
      if (Sync.onChange) Sync.onChange();

      var fs = fb.fs, result = { pulled: 0, questions: 0, reason: reason || '' };

      return fs.getDoc(stateDoc('progress'))
        .then(function (snap) {
          var remote = (snap.exists() && snap.data().items) || [];
          result.pulled = Store.mergeProgress(remote);
          return fs.setDoc(stateDoc('progress'), {
            items: Store.progressArray(),
            updatedAt: Date.now()
          });
        })
        .then(function () { return fs.getDoc(stateDoc('settings')); })
        .then(function (snap) {
          var local = Store.settings;
          var remote = snap.exists() ? snap.data() : null;
          if (remote && remote.data && (remote.updatedAt || 0) > (local.syncedAt || 0)) {
            var patch = {};
            Object.keys(remote.data).forEach(function (k) {
              if (LOCAL_ONLY.indexOf(k) < 0) patch[k] = remote.data[k];
            });
            patch.syncedAt = remote.updatedAt;
            Store.saveSettings(patch);
            if (Sync.onSettings) Sync.onSettings();
          } else {
            var out = {};
            Object.keys(local).forEach(function (k) {
              if (LOCAL_ONLY.indexOf(k) < 0) out[k] = local[k];
            });
            var now = Date.now();
            Store.saveSettings({ syncedAt: now });
            return fs.setDoc(stateDoc('settings'), { data: out, updatedAt: now });
          }
        })
        .then(function () { return Sync._questions(); })
        .then(function (n) {
          result.questions = n;
          Sync.lastSyncAt = Date.now();
          return result;
        })
        .catch(function (e) {
          Sync.lastError = Sync._explain(e);
          throw e;
        })
        .finally(function () {
          Sync.busy = false;
          if (Sync.onChange) Sync.onChange();
        });
    },

    /** 取り込んだ問題を双方向にそろえる。初期データは配信側にあるので対象外 */
    _questions: function () {
      var fs = fb.fs;
      var col = fs.collection(db, 'users', Sync.user.uid, 'questions');
      return Promise.all([Store.userQuestions(), fs.getDocs(col)]).then(function (r) {
        var mine = r[0], snap = r[1];
        var byId = {}, added = 0;
        mine.forEach(function (q) { byId[q.id] = q; });

        var incoming = [];
        snap.forEach(function (d) {
          (d.data().items || []).forEach(function (q) {
            if (!byId[q.id]) { byId[q.id] = q; incoming.push(q); added++; }
          });
        });

        var all = Object.keys(byId).map(function (k) { return byId[k]; });
        var writes = incoming.length ? Store.putQuestions(incoming) : Promise.resolve();

        return writes.then(function () {
          var batch = fs.writeBatch(db), i, n = 0;
          for (i = 0; i < all.length; i += CHUNK) {
            batch.set(fs.doc(col, String(n++)), {
              items: all.slice(i, i + CHUNK), updatedAt: Date.now()
            });
          }
          // 減ったぶんの古いチャンクを消す
          snap.forEach(function (d) {
            if (parseInt(d.id, 10) >= n) batch.delete(d.ref);
          });
          return batch.commit().then(function () { return added; });
        });
      });
    },

    _explain: function (e) {
      var code = (e && e.code) || '';
      if (/permission-denied/.test(code)) {
        return 'Firestore のセキュリティルールが未設定です。コンソールでルールを公開してください。';
      }
      if (/unauthorized-domain/.test(code)) {
        return 'このドメインが Firebase の承認済みドメインに入っていません。';
      }
      if (/popup-blocked/.test(code)) return 'ポップアップがブロックされました。';
      if (/network/.test(code)) return 'ネットワークに接続できませんでした。';
      return (e && e.message) || String(e);
    }
  };

  global.Sync = Sync;
})(window);

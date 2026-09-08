/* store.js — 設定 / 学習履歴 (localStorage) と 問題データ (IndexedDB) */
(function (global) {
  'use strict';

  var DB_NAME = 'sharoushi', DB_VER = 1, OS = 'questions';
  var K_SET = 'sq.settings', K_PROG = 'sq.progress';

  var DEFAULT_SETTINGS = {
    theme: 'light',
    rate: 1.2, pitch: 1.0, voiceURI: '',
    autoRead: true, readChoices: true, autoExplain: true, autoNext: false,
    bargeIn: true, micAuto: true, nextDelay: 1.5,
    geminiKey: '', geminiModel: 'gemini-2.5-flash', aiSpeak: true
  };

  /* --- localStorage helpers --- */
  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  var settings = Object.assign({}, DEFAULT_SETTINGS, readJSON(K_SET, {}));
  var progress = readJSON(K_PROG, {});

  /* --- IndexedDB --- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(OS)) d.createObjectStore(OS, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(OS, mode), s = t.objectStore(OS), out;
        out = fn(s);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* --- 問題の正規化 --- */
  function hash(str) {
    var h = 5381, i;
    for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function normalize(q, origin) {
    var type = (q.type === 'choice' || (q.choices && q.choices.length > 2)) ? 'choice' : 'ox';
    var choices = type === 'choice' ? (q.choices || []).map(String) : ['○（正しい）', '×（誤り）'];
    var ans = Number(q.answer);
    if (!isFinite(ans)) ans = 0;
    var text = String(q.text || q.question || '').trim();
    if (!text) return null;
    return {
      id: q.id || (origin || 'q') + '-' + hash(text),
      subject: String(q.subject || 'その他'),
      type: type,
      text: text,
      choices: choices,
      answer: Math.max(0, Math.min(choices.length - 1, ans)),
      explanation: String(q.explanation || '').trim(),
      source: String(q.source || '').trim(),
      verify: !!q.verify,
      origin: q.origin || origin || 'user'
    };
  }

  /* --- CSV --- */
  function parseCSV(text) {
    var rows = [], row = [], cell = '', i, c, inQ = false;
    text = text.replace(/^﻿/, '');
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return [];
    var head = rows.shift().map(function (h) { return h.trim().toLowerCase(); });
    return rows.filter(function (r) { return r.join('').trim() !== ''; }).map(function (r) {
      var o = {}, j;
      for (j = 0; j < head.length; j++) o[head[j]] = (r[j] || '').trim();
      var choices = o.choices ? o.choices.split('|').map(function (s) { return s.trim(); }) : null;
      return {
        subject: o.subject, type: o.type || (choices ? 'choice' : 'ox'),
        text: o.text, choices: choices,
        answer: Math.max(0, (parseInt(o.answer, 10) || 1) - 1),  // CSV は 1 始まり
        explanation: o.explanation, source: o.source, verify: o.verify === '1' || o.verify === 'true'
      };
    });
  }

  var Store = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    get settings() { return settings; },
    saveSettings: function (patch) {
      Object.assign(settings, patch || {});
      if (!writeJSON(K_SET, settings)) console.warn('設定の保存に失敗しました');
      return settings;
    },

    get progress() { return progress; },
    stateOf: function (id) {
      return progress[id] || { box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    },
    /** Leitner: 正解で箱を1つ上げ、不正解で箱0へ戻す */
    record: function (id, correct) {
      var INTERVAL_DAYS = [0, 1, 3, 7, 16, 35, 90];
      var s = Store.stateOf(id), now = Date.now();
      s.seen++;
      if (correct) { s.right++; s.box = Math.min(INTERVAL_DAYS.length - 1, s.box + 1); }
      else { s.wrong++; s.box = 0; }
      s.last = now;
      s.due = now + INTERVAL_DAYS[s.box] * 86400000;
      progress[id] = s;
      writeJSON(K_PROG, progress);
      return s;
    },
    resetProgress: function () { progress = {}; writeJSON(K_PROG, progress); },

    /** 初回は data/questions.json を取り込む。以降は IndexedDB が唯一の情報源 */
    loadQuestions: function () {
      return tx('readonly', function (s) { return s.getAll(); }).then(function (all) {
        if (all && all.length) return all;
        return fetch('data/questions.json', { cache: 'no-cache' })
          .then(function (r) { return r.json(); })
          .then(function (raw) {
            var list = raw.map(function (q) { return normalize(q, 'seed'); }).filter(Boolean);
            return Store.putQuestions(list).then(function () { return list; });
          })
          .catch(function (e) { console.error('初期データの読み込みに失敗', e); return []; });
      });
    },
    putQuestions: function (list) {
      return tx('readwrite', function (s) { list.forEach(function (q) { s.put(q); }); });
    },
    /** JSON / CSV テキストを取り込む。既存 id は上書き */
    importText: function (text, filename) {
      var raw;
      if (/\.csv$/i.test(filename || '') || (text.trim()[0] !== '[' && text.trim()[0] !== '{')) {
        raw = parseCSV(text);
      } else {
        raw = JSON.parse(text);
        if (!Array.isArray(raw)) raw = raw.questions || [];
      }
      var list = raw.map(function (q) { return normalize(q, 'user'); }).filter(Boolean);
      if (!list.length) throw new Error('取り込める問題がありませんでした');
      return Store.putQuestions(list).then(function () { return list.length; });
    },
    clearQuestions: function () {
      return tx('readwrite', function (s) { s.clear(); });
    },

    exportAll: function () {
      return tx('readonly', function (s) { return s.getAll(); }).then(function (all) {
        return JSON.stringify({
          exportedAt: new Date().toISOString(),
          questions: all,
          progress: progress
        }, null, 2);
      });
    }
  };

  global.Store = Store;
})(window);

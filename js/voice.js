/* voice.js — 読み上げ (SpeechSynthesis) と 音声コマンド (SpeechRecognition) */
(function (global) {
  'use strict';

  var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
  var synth = global.speechSynthesis;

  /* ============================================================
   * 文字列の正規化
   * 音声認識は「次」「解説」「3番」のように漢字を混ぜて返してくるため、
   * 全角→半角・カタカナ→ひらがなに加えて、よく使う語の漢字をひらがなに
   * 畳んでから判定する。長い語を先に置くこと（もう一度 → 一度 → 一）。
   * ============================================================ */
  var KANJI_FOLD = [
    ['もう一度', 'もういちど'], ['もう一回', 'もういっかい'], ['一度', 'いちど'], ['一回', 'いっかい'],
    ['読み上げ', 'よみあげ'], ['読んで', 'よんで'], ['聞こえない', 'きこえない'],
    ['解説', 'かいせつ'], ['説明', 'せつめい'], ['質問', 'しつもん'], ['聞いて', 'きいて'], ['聞き', 'きき'],
    ['止めて', 'とめて'], ['停止', 'ていし'], ['黙', 'だま'], ['静か', 'しずか'], ['やめて', 'やめて'],
    ['次', 'つぎ'], ['進', 'すす'], ['戻', 'もど'], ['前の問題', 'まえのもんだい'],
    ['分からない', 'わからない'], ['判らない', 'わからない'], ['飛ばして', 'とばして'], ['保留', 'ほりゅう'],
    ['終了', 'しゅうりょう'], ['終わり', 'おわり'],
    ['正解', 'せいかい'], ['正しい', 'ただしい'], ['間違', 'まちが'], ['誤り', 'あやまり'], ['違', 'ちが'],
    // 「まる」は音声認識が句点に、「ばつ」は罰・×などに書き起こす。読みに戻して判定する
    ['丸', 'まる'], ['○', 'まる'], ['◯', 'まる'], ['〇', 'まる'], ['円', 'まる'],
    ['×', 'ばつ'], ['✕', 'ばつ'], ['☓', 'ばつ'], ['罰', 'ばつ'], ['バッテン', 'ばつ'], ['ばってん', 'ばつ'],
    ['答え', 'こたえ'], ['回答', 'かいとう'],
    ['番目', 'ばんめ'], ['番号', 'ばんごう'], ['番', 'ばん'], ['目', 'め'],
    ['一つ', 'ひとつ'], ['二つ', 'ふたつ'], ['三つ', 'みっつ'], ['四つ', 'よっつ'], ['五つ', 'いつつ'],
    ['一', 'いち'], ['二', 'に'], ['三', 'さん'], ['四', 'よん'], ['五', 'ご'],
    ['願', 'ねが'], ['思', 'おも'], ['第', '']
  ];

  function fold(s) {
    for (var i = 0; i < KANJI_FOLD.length; i++) {
      s = s.split(KANJI_FOLD[i][0]).join(KANJI_FOLD[i][1]);
    }
    return s;
  }

  function norm(s) {
    if (!s) return '';
    s = String(s).replace(/[！-～]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    s = fold(s);
    return s
      .replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); })
      .replace(/[\s、。,.!?！？「」・ー]/g, '')
      .toLowerCase();
  }

  /* ============================================================
   * コマンド定義（上にあるものが優先）
   * 「もういちど」は「いち」より先に判定する必要があるため順序が重要
   * ============================================================ */
  var PATTERNS = [
    { cmd: 'stop',    re: /(とめて|とまれ|ストップ|すとっぷ|だまって|しずかに|よみあげやめ)/ },
    { cmd: 'repeat',  re: /(もういちど|もういっかい|もっかい|もういち|よみあげ|よんで|りぴーと|きこえない)/ },
    { cmd: 'ask',     re: /(しつもん|きいて|ききたい|じぇみに|じぇみない|えーあい|ai)/ },
    { cmd: 'explain', re: /(かいせつ|せつめい|どういうこと|なぜ|りゆう)/ },
    { cmd: 'next',    re: /(つぎ|すすんで|すすめ|ねくすと|おっけー|おーけー)/ },
    { cmd: 'prev',    re: /(まえのもんだい|もどって|もどる|ばっく)/ },
    { cmd: 'skip',    re: /(わからない|わかんない|ぱす|すきっぷ|とばして|ほりゅう)/ },
    { cmd: 'home',    re: /(しゅうりょう|おわり|やめる|ほーむ|めにゅー)/ }
  ];

  // ○×・番号の語彙。完全一致で判定する（部分一致は誤爆しやすいため）
  var ANSWER_WORDS = {
    '1': 1, 'いち': 1, 'ひとつ': 1, 'ひとつめ': 1, 'あ': 1, 'えー': 1, 'a': 1, 'い一': 1,
    '2': 2, 'に': 2, 'ふたつ': 2, 'ふたつめ': 2, 'い': 2, 'びー': 2, 'b': 2,
    '3': 3, 'さん': 3, 'みっつ': 3, 'みっつめ': 3, 'う': 3, 'しー': 3, 'c': 3,
    '4': 4, 'よん': 4, 'し': 4, 'よっつ': 4, 'よっつめ': 4, 'え': 4, 'でぃー': 4, 'd': 4,
    '5': 5, 'ご': 5, 'いつつ': 5, 'いつつめ': 5, 'お': 5, 'いー': 5, 'e': 5
  };
  var O_WORDS = /^(まる|0|ただしい|せいかい|そのとおり|あってる|あっている|はい|ok|よし)$/;
  var X_WORDS = /^(ばつ|ぺけ|x|まちが|まちがい|まちがってる|あやまり|ちが|ちがう|ちがい|いいえ|だめ)$/;

  // 「答えは3番でお願いします」→「3」のように、飾りを剥がして答えの語だけにする。
  // 1回では剥がしきれないので変化がなくなるまで繰り返す。
  var HEAD = /^(こたえは|かいとうは|せいかいは|えらぶのは|ばんごうは|ばんごう|えっと|あの)/;
  var TAIL = /(だとおもいます|とおもいます|だとおもう|とおもう|でおねがいします|おねがいします|でおねがい|ください|です|ます|だよ|だね|かな|でしょう|ばんめ|ばんごう|ばん|め)$/;
  function stripTail(t) {
    for (var i = 0; i < 6; i++) {
      var before = t;
      t = t.replace(HEAD, '').replace(TAIL, '');
      if (t === before) break;
    }
    return t;
  }

  function parse(raw) {
    // 「まる」と発話すると音声認識は句点だけを返してくることがある。
    // 発話全体が句点等のときに限り「まる」と解釈する（文末の句点は対象外）。
    if (/^[\s。．.]+$/.test(String(raw || ''))) return { cmd: 'answer', payload: 1 };

    var t = norm(raw);
    if (!t) return null;

    var i;
    for (i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i].re.test(t)) {
        if (PATTERNS[i].cmd === 'ask') {
          // 「質問、○○について」→ ○○ を質問文として渡す（短すぎれば既定の質問にする）
          var body = raw
            .replace(/^.*?(質問|聞いて|聞きたい|ジェミニ|ジェミナイ|AI)/i, '')
            .replace(/^[はがをにでへとも、,\s]+/, '')
            .trim();
          return { cmd: 'ask', payload: body.length >= 4 ? body : '' };
        }
        return { cmd: PATTERNS[i].cmd };
      }
    }

    var s = stripTail(t);
    if (O_WORDS.test(t) || O_WORDS.test(s)) return { cmd: 'answer', payload: 1 };
    if (X_WORDS.test(t) || X_WORDS.test(s)) return { cmd: 'answer', payload: 2 };
    if (Object.prototype.hasOwnProperty.call(ANSWER_WORDS, s)) {
      return { cmd: 'answer', payload: ANSWER_WORDS[s] };
    }
    // 「3番でお願いします」等、数字だけ残った場合の保険
    var m = s.match(/^(\d)$/);
    if (m && m[1] >= '1' && m[1] <= '5') return { cmd: 'answer', payload: +m[1] };
    return null;
  }

  /* ============================================================
   * 読み上げ
   * ============================================================ */
  var voices = [], speakingText = '', speakSeq = 0;

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter(function (v) { return /^ja/i.test(v.lang); });
    if (!voices.length) voices = synth.getVoices();
  }
  if (synth) {
    loadVoices();
    synth.addEventListener('voiceschanged', loadVoices);
  }

  // Chrome は 15 秒ほどで読み上げが止まる既知の不具合があるため定期的に resume する
  setInterval(function () {
    if (synth && synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
  }, 10000);

  var Voice = {
    ttsSupported: !!synth,
    sttSupported: !!SR,
    settings: {},
    onCommand: null,
    onHeard: null,
    onState: null,

    voiceList: function () { return voices; },

    /** 直列に読み上げる。前の読み上げは打ち切る */
    speak: function (text, opts) {
      opts = opts || {};
      if (!synth || !text) return Promise.resolve();
      var seq = ++speakSeq;
      synth.cancel();
      speakingText = norm(text);
      if (!Voice.settings.bargeIn) Voice._pauseRecognition(true);
      Voice._emitState();

      return new Promise(function (resolve) {
        var u = new SpeechSynthesisUtterance(String(text));
        u.lang = 'ja-JP';
        u.rate = opts.rate || Voice.settings.rate || 1.2;
        u.pitch = opts.pitch || Voice.settings.pitch || 1;
        var v = voices.filter(function (x) { return x.voiceURI === Voice.settings.voiceURI; })[0];
        if (v) u.voice = v;
        function done() {
          if (seq !== speakSeq) return resolve();
          speakingText = '';
          if (!Voice.settings.bargeIn) Voice._pauseRecognition(false);
          Voice._emitState();
          resolve();
        }
        u.onend = done;
        u.onerror = done;
        // Android で稀に onend が来ないことがあるので保険のタイマーを置く
        setTimeout(done, 2000 + String(text).length * 220);
        synth.speak(u);
      });
    },

    /** 複数の文を順番に読み上げる（途中で cancel されたら中断） */
    speakAll: function (parts) {
      var list = parts.filter(Boolean);
      return list.reduce(function (p, t) {
        return p.then(function () {
          if (Voice._cancelled) return;
          return Voice.speak(t);
        });
      }, Promise.resolve());
    },

    cancel: function () {
      speakSeq++;
      Voice._cancelled = true;
      setTimeout(function () { Voice._cancelled = false; }, 50);
      speakingText = '';
      if (synth) synth.cancel();
      if (!Voice.settings.bargeIn) Voice._pauseRecognition(false);
      Voice._emitState();
    },

    get speaking() { return !!(synth && synth.speaking); },

    /* ==========================================================
     * 音声コマンド
     * ========================================================== */
    _recog: null,
    _want: false,      // ユーザーがマイク ON を望んでいるか
    _paused: false,    // 読み上げ中の一時停止
    _active: false,    // 実際に認識が動いているか
    _lastFire: { cmd: '', at: 0 },

    get listening() { return Voice._want; },
    get active() { return Voice._active; },

    _emitState: function () {
      if (Voice.onState) Voice.onState({
        want: Voice._want, active: Voice._active, speaking: Voice.speaking
      });
    },

    _build: function () {
      var r = new SR();
      r.lang = 'ja-JP';
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 3;

      r.onstart = function () { Voice._active = true; Voice._emitState(); };

      r.onresult = function (ev) {
        var i, j, res, alt, best = null, isFinal = false;
        for (i = ev.resultIndex; i < ev.results.length; i++) {
          res = ev.results[i];
          isFinal = res.isFinal;
          for (j = 0; j < res.length; j++) {
            alt = res[j].transcript;
            if (!best) best = alt;
            var hit = Voice._consider(alt);
            if (hit) return;   // 最初に解釈できた候補で確定（速さ優先）
          }
        }
        if (best && Voice.onHeard) Voice.onHeard(best, isFinal);
      };

      r.onerror = function (ev) {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          Voice._want = false;
          if (Voice.onState) Voice.onState({ error: 'マイクが許可されていません', want: false, active: false });
        }
      };

      r.onend = function () {
        Voice._active = false;
        Voice._emitState();
        // continuous でも無音が続くと勝手に終了するので自動で再開する
        if (Voice._want && !Voice._paused) setTimeout(Voice._start, 250);
      };
      return r;
    },

    /** 認識結果を1件評価。コマンドとして処理したら true */
    _consider: function (transcript) {
      var t = norm(transcript);
      if (!t) return false;

      // 読み上げ中のマイク割り込みでは、自分の声を拾ったものを無視したい。
      // ただし「まる」「ばつ」「つぎ」のような短い指示は、読み上げ文にそのまま
      // 含まれていても利用者の発話とみなす。ここを短く取りすぎると回答できない。
      if (speakingText && t.length >= 4 && speakingText.indexOf(t) >= 0) return false;

      var hit = parse(transcript);
      if (!hit) return false;

      var key = hit.cmd + ':' + (hit.payload || '');
      var now = Date.now();
      if (Voice._lastFire.cmd === key && now - Voice._lastFire.at < 1200) return true;
      Voice._lastFire = { cmd: key, at: now };

      if (Voice.onHeard) Voice.onHeard(transcript, true);
      if (Voice.onCommand) Voice.onCommand(hit.cmd, hit.payload, transcript);
      return true;
    },

    _start: function () {
      if (!SR || !Voice._want || Voice._paused || Voice._active) return;
      if (!Voice._recog) Voice._recog = Voice._build();
      try { Voice._recog.start(); }
      catch (e) { /* すでに開始済み。onend で復帰する */ }
    },

    _pauseRecognition: function (on) {
      if (!SR) return;
      Voice._paused = on;
      if (on) { if (Voice._recog && Voice._active) { try { Voice._recog.stop(); } catch (e) {} } }
      else if (Voice._want) setTimeout(Voice._start, 200);
    },

    listen: function (on) {
      if (!SR) return false;
      Voice._want = on;
      if (on) Voice._start();
      else {
        Voice._paused = false;
        if (Voice._recog) { try { Voice._recog.abort(); } catch (e) {} }
        Voice._active = false;
      }
      Voice._emitState();
      return true;
    },

    toggle: function () { return Voice.listen(!Voice._want); },

    /** AI への質問などを1回だけ書き取る */
    dictate: function () {
      if (!SR) return Promise.reject(new Error('この端末は音声認識に対応していません'));
      var wasOn = Voice._want;
      Voice.listen(false);
      return new Promise(function (resolve, reject) {
        var r = new SR(), settled = false;
        r.lang = 'ja-JP'; r.continuous = false; r.interimResults = true;
        var text = '';
        r.onresult = function (ev) {
          text = '';
          for (var i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
          if (Voice.onHeard) Voice.onHeard(text, false);
        };
        r.onerror = function (ev) { if (!settled) { settled = true; reject(new Error(ev.error)); } };
        r.onend = function () {
          if (wasOn) setTimeout(function () { Voice.listen(true); }, 300);
          if (!settled) { settled = true; resolve(text.trim()); }
        };
        try { r.start(); } catch (e) { settled = true; reject(e); }
      });
    },

    _normalize: norm,
    _parse: parse
  };

  global.Voice = Voice;
})(window);

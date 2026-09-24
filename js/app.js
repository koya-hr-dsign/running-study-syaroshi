/* app.js — 画面制御・出題ロジック・音声コマンドの束ね役 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const S = () => Store.settings;

  let questions = [];
  let session = null;      // { list:[q], idx, mode, label }
  let answeredIdx = -1;    // 回答済みなら選んだ番号(0始まり)
  let aiHistory = [];
  let flowToken = 0;       // 読み上げの流れを打ち切るためのトークン
  let wakeLock = null;

  /* ============================================================
   * 読み上げの流れ
   * ============================================================ */
  async function say(...parts) {
    const my = ++flowToken;
    for (const p of parts.filter(Boolean)) {
      if (my !== flowToken) return false;
      await Voice.speak(p);
      if (my !== flowToken) return false;
    }
    return true;
  }
  function stopSpeaking() { flowToken++; Voice.cancel(); }

  /* テーマ（既定はライト。ダークは端末の省電力用に用意する） */
  const THEME_COLOR = { light: '#ffffff', dark: '#17171b' };
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const dark = t === 'dark' ||
      (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('themeColor').setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
  }
  matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (S().theme === 'auto') applyTheme('auto'); });

  function toast(msg, ms = 2200) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* ============================================================
   * 画面切り替え
   * ============================================================ */
  const VIEWS = { home: 'view-home', quiz: 'view-quiz', settings: 'view-settings' };
  let view = 'home';

  function show(name) {
    view = name;
    Object.entries(VIEWS).forEach(([k, id]) => { $(id).hidden = (k !== name); });
    $('bottombar').hidden = (name !== 'quiz');
    document.body.classList.toggle('no-bottombar', name !== 'quiz');
    $('backBtn').hidden = (name === 'home');
    $('appTitle').textContent =
      name === 'quiz' ? (session ? session.label : '学習') :
      name === 'settings' ? '設定' : '社労士 音声学習';
    window.scrollTo(0, 0);
    if (name === 'quiz') requestWakeLock(); else releaseWakeLock();
    if (name === 'home') renderHome();
    if (name === 'settings') updateDataInfo();
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { /* 非対応。学習には支障ないので黙って諦める */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && view === 'quiz') requestWakeLock();
  });

  /* ============================================================
   * ホーム
   * ============================================================ */
  const SUBJECT_ORDER = [
    '労働基準法', '労働安全衛生法', '労働者災害補償保険法', '雇用保険法', '労働保険徴収法',
    '労務管理その他の労働に関する一般常識', '社会保険に関する一般常識',
    '健康保険法', '厚生年金保険法', '国民年金法'
  ];

  function isDue(q) { const s = Store.stateOf(q.id); return s.seen > 0 && s.due <= Date.now(); }
  function isNew(q) { return Store.stateOf(q.id).seen === 0; }
  function isWrong(q) { const s = Store.stateOf(q.id); return s.wrong > 0; }

  function renderHome() {
    const total = questions.length;
    let right = 0, seen = 0;
    questions.forEach((q) => { const s = Store.stateOf(q.id); right += s.right; seen += s.seen; });
    $('stTotal').textContent = total;
    $('stDue').textContent = questions.filter(isDue).length;
    $('stNew').textContent = questions.filter(isNew).length;
    $('stRate').textContent = seen ? Math.round(right / seen * 100) + '%' : '—';

    const bySubject = new Map();
    questions.forEach((q) => {
      if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
      bySubject.get(q.subject).push(q);
    });

    // IndexedDB は id 順で返すため、本試験の科目順に並べ直す
    const ordered = [...bySubject.entries()].sort((a, b) => {
      const ia = SUBJECT_ORDER.indexOf(a[0]), ib = SUBJECT_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0], 'ja');
    });

    const wrap = $('subjectList');
    wrap.textContent = '';
    ordered.forEach(([name, list]) => {
      const done = list.filter((q) => Store.stateOf(q.id).box >= 2).length;
      const btn = document.createElement('button');
      btn.className = 'subj';
      btn.innerHTML =
        `<span class="name"></span>
         <span class="bar"><i style="width:${list.length ? Math.round(done / list.length * 100) : 0}%"></i></span>
         <span class="cnt">${done}/${list.length}</span>`;
      btn.querySelector('.name').textContent = name;
      btn.addEventListener('click', () => start('subject', name));
      wrap.appendChild(btn);
    });
  }

  /* ============================================================
   * 出題
   * ============================================================ */
  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  }

  function pick(mode, subject) {
    switch (mode) {
      case 'due':     return shuffle(questions.filter(isDue));
      case 'new':     return shuffle(questions.filter(isNew));
      case 'wrong':   return shuffle(questions.filter(isWrong));
      case 'random':  return shuffle(questions);
      case 'subject': return shuffle(questions.filter((q) => q.subject === subject));
      default: {
        // おまかせ: 復習期限が来たもの → 未学習 → 残り
        const due = shuffle(questions.filter(isDue));
        const fresh = shuffle(questions.filter(isNew));
        const rest = shuffle(questions.filter((q) => !isDue(q) && !isNew(q)));
        return [...due, ...fresh, ...rest];
      }
    }
  }

  const MODE_LABEL = {
    auto: 'おまかせ学習', due: '復習', new: '未学習', wrong: '間違えた問題', random: 'ランダム'
  };

  function start(mode, subject) {
    const list = pick(mode, subject);
    if (!list.length) { toast('該当する問題がありません'); return; }
    session = { list, idx: 0, mode, label: subject || MODE_LABEL[mode] || '学習' };
    show('quiz');
    if (S().micAuto && Voice.sttSupported && !Voice.listening) Voice.listen(true);
    renderQuestion();
  }

  function current() { return session && session.list[session.idx]; }

  function renderQuestion() {
    const q = current();
    if (!q) return;
    answeredIdx = -1;
    aiHistory = [];
    stopSpeaking();

    const st = Store.stateOf(q.id);
    $('qSubject').textContent = q.subject;
    $('qProgress').textContent = `${session.idx + 1} / ${session.list.length}`;
    $('qBox').textContent = st.seen ? `習熟 ${st.box}/6・${st.right}○ ${st.wrong}×` : '未学習';
    $('qText').textContent = q.text;
    $('qSource').textContent = q.source ? `根拠: ${q.source}` : '';

    const box = $('choices');
    box.textContent = '';
    q.choices.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'choice' + (q.type === 'ox' ? ' ox' : '');
      b.dataset.i = i;
      if (q.type === 'ox') {
        b.textContent = i === 0 ? '○' : '×';
      } else {
        b.innerHTML = '<span class="no"></span><span class="txt"></span>';
        b.querySelector('.no').textContent = i + 1;
        b.querySelector('.txt').textContent = c;
      }
      b.addEventListener('click', () => answer(i));
      box.appendChild(b);
    });

    $('feedback').hidden = true;
    $('explain').hidden = true;
    $('ai').hidden = true;
    $('aiLog').textContent = '';
    $('btnNext').disabled = false;

    if (S().autoRead) readQuestion();
  }

  function questionSpeech() {
    const q = current();
    const parts = [q.subject + '。' + q.text];
    if (S().readChoices) {
      if (q.type === 'ox') parts.push('まるか、ばつか。');
      else q.choices.forEach((c, i) => parts.push(`${i + 1}番、${c}。`));
    }
    return parts;
  }
  function readQuestion() { say(...questionSpeech()); }

  async function answer(i) {
    const q = current();
    if (!q || answeredIdx >= 0) return;
    if (i < 0 || i >= q.choices.length) { toast(`${i + 1} は選べません`); return; }
    answeredIdx = i;
    stopSpeaking();

    const correct = (i === q.answer);
    Store.record(q.id, correct);
    scheduleSync();

    [...$('choices').children].forEach((b, n) => {
      b.disabled = true;
      if (n === q.answer) b.classList.add('correct');
      else if (n === i) b.classList.add('wrong');
    });

    const fb = $('feedback');
    fb.hidden = false;
    fb.className = 'feedback ' + (correct ? 'ok' : 'ng');
    $('fbMark').textContent = correct ? '○' : '×';
    $('fbText').textContent = correct
      ? '正解'
      : `不正解 — 正解は ${q.type === 'ox' ? (q.answer === 0 ? '○' : '×') : (q.answer + 1) + '番'}`;

    showExplanation(false);

    const speech = [correct ? '正解。' : `不正解。正解は、${q.type === 'ox' ? (q.answer === 0 ? 'まる' : 'ばつ') : (q.answer + 1) + '番'}。`];
    if (S().autoExplain && q.explanation) speech.push(q.explanation);
    const finished = await say(...speech);

    if (finished && S().autoNext) {
      const my = flowToken;
      setTimeout(() => { if (my === flowToken && answeredIdx >= 0) next(); }, S().nextDelay * 1000);
    }
  }

  function showExplanation(speakIt) {
    const q = current();
    if (!q) return;
    $('explain').hidden = false;
    $('expText').textContent = q.explanation || '（この問題には解説が登録されていません）';
    $('expWarn').hidden = !q.verify;
    if (speakIt && q.explanation) say(q.explanation);
  }

  function next() {
    if (!session) return;
    if (session.idx + 1 >= session.list.length) {
      stopSpeaking();
      say('お疲れさまでした。この範囲は終わりです。');
      toast('この範囲は終わりです');
      show('home');
      session = null;
      return;
    }
    session.idx++;
    renderQuestion();
  }
  function prev() {
    if (!session || session.idx === 0) { toast('最初の問題です'); return; }
    session.idx--;
    renderQuestion();
  }
  function skip() {
    const q = current();
    if (!q) return;
    if (answeredIdx < 0) Store.record(q.id, false);   // 分からない = 間違いとして次回すぐ出す
    toast('あとでもう一度出題します');
    next();
  }

  /* ============================================================
   * AI（Gemini）
   * ============================================================ */
  function openAi(prefill) {
    $('ai').hidden = false;
    $('aiModel').textContent = S().geminiModel || '';
    $('ai').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (prefill) askAi(prefill);
    else if (!Gemini.configured) addMsg('err', '設定画面で Gemini の API キーを入力してください。');
    else $('aiInput').focus();
  }

  function addMsg(cls, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    $('aiLog').appendChild(d);
    $('aiLog').scrollTop = $('aiLog').scrollHeight;
    return d;
  }

  async function askAi(message) {
    const q = current();
    if (!q || !message) return;
    $('ai').hidden = false;
    stopSpeaking();
    addMsg('me', message);
    $('aiInput').value = '';
    const pending = addMsg('ai', '考えています…');
    try {
      const text = await Gemini.ask(q, aiHistory, message);
      pending.textContent = text;
      aiHistory.push({ role: 'user', text: message }, { role: 'model', text });
      if (S().aiSpeak) say(text);
    } catch (e) {
      pending.className = 'msg err';
      pending.textContent = 'エラー: ' + e.message;
    }
  }

  /* ============================================================
   * 音声コマンド
   * ============================================================ */
  Voice.onHeard = (text, isFinal) => {
    const el = $('heard');
    el.textContent = '🎤 ' + text;
    el.hidden = false;
    clearTimeout(Voice.onHeard._t);
    Voice.onHeard._t = setTimeout(() => { el.hidden = true; }, isFinal ? 1400 : 2600);
  };

  Voice.onState = (st) => {
    const b = $('micBtn');
    b.classList.toggle('on', !!st.want);
    b.classList.toggle('listening', !!st.active && !st.speaking);
    if (st.error) toast(st.error);
  };

  Voice.onCommand = (cmd, payload) => {
    if (view !== 'quiz') {
      if (cmd === 'next' || cmd === 'repeat') start('auto');
      return;
    }
    switch (cmd) {
      case 'answer':  answeredIdx < 0 ? answer(payload - 1) : next(); break;
      case 'next':    answeredIdx < 0 ? toast('先に回答してください（「わからない」でパス）') : next(); break;
      case 'prev':    prev(); break;
      case 'repeat':  readQuestion(); break;
      case 'explain': showExplanation(true); break;
      case 'skip':    skip(); break;
      case 'stop':    stopSpeaking(); break;
      case 'ask':     openAi(payload || 'この問題をもっと詳しく説明して'); break;
      case 'home':    stopSpeaking(); session = null; show('home'); break;
    }
  };

  /* ============================================================
   * 設定画面
   * ============================================================ */
  /** 設定値を画面の各コントロールに反映する。同期で設定が入れ替わった後も呼ぶ */
  function bindSettingsValues() {
    const s = S();
    $('setTheme').value = s.theme || 'light';
    $('setRate').value = s.rate;
    $('setPitch').value = s.pitch;
    $('setNextDelay').value = s.nextDelay;
    $('rateVal').textContent = s.rate + '倍';
    $('nextDelayVal').textContent = s.nextDelay + '秒';
    ['autoRead', 'readChoices', 'autoExplain', 'autoNext', 'bargeIn', 'micAuto', 'aiSpeak']
      .forEach((k) => { $('set' + k[0].toUpperCase() + k.slice(1)).checked = !!s[k]; });
    $('setGeminiKey').value = s.geminiKey;
    $('setGeminiModel').value = s.geminiModel;
  }

  function bindSettings() {
    const s = S();
    bindSettingsValues();

    const fillVoices = () => {
      const sel = $('setVoice');
      sel.textContent = '';
      const list = Voice.voiceList();
      const auto = new Option('自動で選ぶ', '');
      sel.appendChild(auto);
      list.forEach((v) => sel.appendChild(new Option(`${v.name}（${v.lang}）`, v.voiceURI)));
      sel.value = s.voiceURI || '';
    };
    fillVoices();
    if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', fillVoices);

    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on('setTheme', 'change', (e) => { Store.saveSettings({ theme: e.target.value }); applyTheme(e.target.value); });
    on('setRate', 'input', (e) => { Store.saveSettings({ rate: +e.target.value }); $('rateVal').textContent = e.target.value + '倍'; });
    on('setPitch', 'input', (e) => Store.saveSettings({ pitch: +e.target.value }));
    on('setNextDelay', 'input', (e) => { Store.saveSettings({ nextDelay: +e.target.value }); $('nextDelayVal').textContent = e.target.value + '秒'; });
    on('setVoice', 'change', (e) => Store.saveSettings({ voiceURI: e.target.value }));
    [['setAutoRead', 'autoRead'], ['setReadChoices', 'readChoices'], ['setAutoExplain', 'autoExplain'],
     ['setAutoNext', 'autoNext'], ['setBargeIn', 'bargeIn'], ['setMicAuto', 'micAuto'], ['setAiSpeak', 'aiSpeak']]
      .forEach(([id, key]) => on(id, 'change', (e) => Store.saveSettings({ [key]: e.target.checked })));
    on('setGeminiKey', 'change', (e) => Store.saveSettings({ geminiKey: e.target.value.trim() }));
    on('setGeminiModel', 'change', (e) => Store.saveSettings({ geminiModel: e.target.value }));
    on('testVoice', 'click', () => say('労働基準法第32条。使用者は、労働者に、休憩時間を除き、1週間について40時間を超えて労働させてはならない。'));

    on('importBtn', 'click', () => $('importFile').click());
    on('importFile', 'change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const n = await Store.importText(await f.text(), f.name);
        questions = await Store.loadQuestions();
        toast(`${n} 問を取り込みました`);
        updateDataInfo();
      } catch (err) { toast('取り込み失敗: ' + err.message, 4000); }
      e.target.value = '';
    });
    on('exportBtn', 'click', async () => {
      const blob = new Blob([await Store.exportAll()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sharoushi-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    on('resetProgress', 'click', () => {
      if (!confirm('学習履歴をすべて消します。よろしいですか？')) return;
      Store.resetProgress(); toast('学習履歴をリセットしました'); updateDataInfo();
    });
    on('resetQuestions', 'click', async () => {
      if (!confirm('取り込んだ問題を含めて全問題を削除し、初期データを読み直します。よろしいですか？')) return;
      await Store.clearQuestions();
      questions = await Store.loadQuestions();
      toast('初期データに戻しました'); updateDataInfo();
    });

    updateDataInfo();
    updateEnvInfo();
  }

  async function updateEnvInfo() {
    const lines = [
      `読み上げ: ${Voice.ttsSupported ? '利用可' : '非対応'}`,
      `音声認識: ${Voice.sttSupported ? '利用可' : '非対応（iOS Safari など）'}`,
      `日本語音声: ${Voice.voiceList().length} 件`
    ];
    try {
      if (navigator.storage) {
        const persisted = await navigator.storage.persisted();
        lines.push(`保存領域: ${persisted ? '永続化済み（自動削除されません）'
          : 'ベストエフォート（端末の空き容量が逼迫すると消えることがあります）'}`);
        if (navigator.storage.estimate) {
          const { usage, quota } = await navigator.storage.estimate();
          if (quota) {
            lines.push(`使用量: ${(usage / 1024).toFixed(0)} KB / 上限 ${(quota / 1048576).toFixed(0)} MB`);
          }
        }
      }
    } catch (e) { /* 取得できない環境では表示しないだけ */ }
    $('envInfo').textContent = lines.join(' / ');
  }

  /**
   * 学習履歴が端末のストレージ逼迫で消えないよう永続化を要求する。
   * Chrome はホーム画面に追加済み（インストール済み）なら自動的に許可する。
   */
  async function requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      if (await navigator.storage.persisted()) return;
      await navigator.storage.persist();
    } catch (e) { /* 失敗しても学習自体には影響しない */ }
  }

  /* ============================================================
   * アカウント同期
   * ============================================================ */
  let syncTimer = null;

  function renderSync() {
    const st = $('syncState');
    if (!st) return;
    if (!Sync.configured) {
      st.textContent = '同期は設定されていません（この端末にのみ保存されます）';
      $('syncBtn').hidden = true;
      return;
    }
    const inTxt = Sync.signedIn
      ? `${Sync.user.displayName || Sync.user.email} としてログイン中`
      : 'ログインしていません（この端末にのみ保存されます）';
    const when = Sync.lastSyncAt
      ? `・最終同期 ${new Date(Sync.lastSyncAt).toLocaleString('ja-JP')}`
      : '';
    st.textContent = Sync.busy ? '同期中…' : inTxt + when + (Sync.lastError ? `\n⚠ ${Sync.lastError}` : '');
    $('syncBtn').hidden = Sync.signedIn;
    $('syncNow').hidden = !Sync.signedIn;
    $('syncOut').hidden = !Sync.signedIn;
  }

  /** 解答のたびに書きに行くと無駄なので、少し待ってからまとめて送る */
  function scheduleSync() {
    if (!Sync.signedIn) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      Sync.run('自動').then(renderHomeIfVisible).catch(() => {});
    }, 4000);
  }
  function renderHomeIfVisible() {
    renderSync();
    if (view === 'home') renderHome();
  }

  function bindSync() {
    Sync.onChange = renderSync;
    Sync.onSettings = () => { applyTheme(S().theme || 'light'); bindSettingsValues(); };

    $('syncBtn').addEventListener('click', async () => {
      try {
        toast('Google のログイン画面を開きます');
        await Sync.signIn();
      } catch (e) {
        toast('ログインできませんでした: ' + Sync._explain(e), 5000);
      }
      renderSync();
    });
    $('syncNow').addEventListener('click', async () => {
      try {
        const r = await Sync.run('手動');
        toast(r ? `同期しました（履歴 ${r.pulled} 件、問題 ${r.questions} 件を取り込み）` : '同期しました', 4000);
        renderHomeIfVisible();
      } catch (e) {
        toast('同期に失敗: ' + Sync.lastError, 6000);
      }
    });
    $('syncOut').addEventListener('click', async () => {
      if (!confirm('ログアウトします。この端末の学習履歴はそのまま残ります。')) return;
      await Sync.signOut();
      toast('ログアウトしました');
    });

    // 画面を閉じる直前にも送っておく
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && Sync.signedIn) {
        clearTimeout(syncTimer);
        Sync.run('離脱時').catch(() => {});
      }
    });

    Sync.init().then(renderSync);
  }

  function updateDataInfo() {
    const user = questions.filter((q) => q.origin === 'user').length;
    $('dataInfo').textContent =
      `全 ${questions.length} 問（初期データ ${questions.length - user} 問 / 追加 ${user} 問）・` +
      `学習履歴 ${Object.keys(Store.progress).length} 件`;
  }

  /* ============================================================
   * 画面のボタン
   * ============================================================ */
  function bindUI() {
    $('backBtn').addEventListener('click', () => { stopSpeaking(); show('home'); });
    $('settingsBtn').addEventListener('click', () => show(view === 'settings' ? (session ? 'quiz' : 'home') : 'settings'));
    $('micBtn').addEventListener('click', () => {
      if (!Voice.sttSupported) { toast('この端末のブラウザは音声認識に対応していません（Android Chrome 推奨）', 4000); return; }
      const on = Voice.toggle();
      toast(Voice.listening ? 'マイク ON' : 'マイク OFF');
      return on;
    });

    document.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => start(b.dataset.mode)));

    $('btnRead').addEventListener('click', readQuestion);
    $('btnExplain').addEventListener('click', () => showExplanation(true));
    $('btnAi').addEventListener('click', () => openAi());
    $('btnSkip').addEventListener('click', skip);
    $('btnNext').addEventListener('click', () => {
      if (answeredIdx < 0) { toast('先に回答してください（分からなければ「パス」）'); return; }
      next();
    });

    $('aiSend').addEventListener('click', () => askAi($('aiInput').value.trim()));
    $('aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') askAi($('aiInput').value.trim()); });
    $('aiMic').addEventListener('click', async () => {
      try {
        toast('どうぞ');
        const t = await Voice.dictate();
        if (t) askAi(t);
      } catch (e) { toast('聞き取れませんでした'); }
    });
    document.querySelectorAll('.aiquick button').forEach((b) =>
      b.addEventListener('click', () => askAi(b.dataset.q)));

    // キーボード（PC での確認用）
    document.addEventListener('keydown', (e) => {
      if (view !== 'quiz' || e.target.tagName === 'INPUT') return;
      if (e.key >= '1' && e.key <= '5') answer(+e.key - 1);
      else if (e.key === 'o' || e.key === 'O') answer(0);
      else if (e.key === 'x' || e.key === 'X') answer(1);
      else if (e.key === 'Enter' || e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'r') readQuestion();
      else if (e.key === 'e') showExplanation(true);
      else if (e.key === 'Escape') stopSpeaking();
    });
  }

  /* ============================================================
   * 起動
   * ============================================================ */
  async function main() {
    Voice.settings = S();
    applyTheme(S().theme || 'light');
    requestPersistence();
    bindUI();
    questions = await Store.loadQuestions();
    Store.pruneProgress(questions.map((q) => q.id));
    bindSettings();
    bindSync();
    show('home');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // 設定変更が Voice 側にも反映されるよう、同じオブジェクトを参照させ続ける
    setInterval(() => { Voice.settings = S(); }, 1000);
  }

  main();
})();

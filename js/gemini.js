/* gemini.js — Gemini API への薄いラッパー（解説を深掘りするための対話） */
(function (global) {
  'use strict';

  var ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

  function systemPrompt(q) {
    return [
      'あなたは社会保険労務士試験の受験指導のプロです。学習者が今解いた問題について質問します。',
      '回答のルール:',
      '- 日本語で、読み上げても分かるように話し言葉で簡潔に答える',
      '- 根拠となる法令名・条文番号を必ず示す。うろ覚えの場合は「要確認」と明示する',
      '- 制度改正で変わりうる論点は、いつ時点の内容かを添える',
      '- 箇条書きは使ってよいが、記号の装飾（**や#）は使わない',
      '- 長くても400字程度に収める',
      '',
      '--- 対象の問題 ---',
      '科目: ' + q.subject,
      '問題: ' + q.text,
      '選択肢: ' + q.choices.map(function (c, i) { return (i + 1) + '. ' + c; }).join(' / '),
      '正解: ' + (q.answer + 1) + '番',
      '手元の解説: ' + (q.explanation || 'なし'),
      '根拠: ' + (q.source || 'なし')
    ].join('\n');
  }

  var Gemini = {
    get configured() { return !!(Store.settings.geminiKey || '').trim(); },

    /**
     * @param {object} q       対象の問題
     * @param {Array}  history [{role:'user'|'model', text}] これまでのやり取り
     * @param {string} message 今回の質問
     */
    ask: function (q, history, message) {
      var key = (Store.settings.geminiKey || '').trim();
      if (!key) return Promise.reject(new Error('設定画面で Gemini の API キーを入力してください'));
      var model = Store.settings.geminiModel || 'gemini-2.5-flash';

      var contents = history.map(function (m) {
        return { role: m.role, parts: [{ text: m.text }] };
      });
      contents.push({ role: 'user', parts: [{ text: message }] });

      return fetch(ENDPOINT + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt(q) }] },
          contents: contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
        })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
          }
          var cand = data.candidates && data.candidates[0];
          var parts = cand && cand.content && cand.content.parts;
          var text = (parts || []).map(function (p) { return p.text || ''; }).join('').trim();
          if (!text) throw new Error('回答が空でした（' + ((cand && cand.finishReason) || 'unknown') + '）');
          return text;
        });
      });
    }
  };

  global.Gemini = Gemini;
})(window);

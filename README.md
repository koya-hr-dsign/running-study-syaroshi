# 社労士 音声学習（running-study-syaroshi）

社会保険労務士試験の学習用 PWA。スマホ・タブレットで、**声で答えて、耳で聴く**ことを最優先に作っています。

## できること

- **音声で回答** —「1」「2」…／「まる」「ばつ」と言うだけで選択・採点
- **音声コマンド** —「つぎ」「もういちど」「かいせつ」「わからない」「とめて」「しつもん ○○」
- **読み上げ** — 問題・選択肢・解説を日本語音声で読み上げ（速度・声を設定可）
- **ハンズフリー学習** — 読み上げ → 回答待ち → 正誤 → 解説 → 自動で次へ
- **AI 解説（Gemini）** — 解いた問題の文脈を渡した状態で深掘り質問。回答も読み上げ可
- **間隔反復（Leitner）** — 正解で復習間隔を延ばし、不正解で先頭に戻す
- **オフライン動作** — Service Worker でアプリ本体と問題をキャッシュ（AI 質問のみ通信必要）
- **問題の取り込み** — 自前の問題を JSON / CSV で追加

## 動作環境

| | 読み上げ | 音声認識 |
|---|---|---|
| Android Chrome | ○ | ○（推奨環境） |
| PC Chrome / Edge | ○ | ○ |
| iOS Safari | ○ | **×**（Web Speech API の音声認識が未実装） |

iOS では読み上げと画面操作は問題なく使えます。音声で答える機能は Android か PC を使ってください。

## 使い方（ローカル）

Service Worker とマイクは `https` か `localhost` でのみ動きます。

```bash
python -m http.server 8765
```

ブラウザで `http://localhost:8765/` を開きます。

### スマホから使う

1. GitHub Pages などの HTTPS で配信する
2. Android Chrome で開き、メニューから「ホーム画面に追加」
3. 初回だけマイク許可を出す（🎤 ボタン）

## AI 解説の設定

1. [Google AI Studio](https://aistudio.google.com/apikey) で API キーを取得
2. アプリの ⚙ → 「AI 解説（Gemini）」にキーを貼り付け

キーは端末の `localStorage` にのみ保存され、ブラウザから Gemini へ直接送られます。共用端末では使わないでください。

## 問題データ

初期データ `data/questions.json` は、条文・制度に基づいて書き下ろしたオリジナル問題です（本試験の過去問本文は著作権があるため収録していません）。

`verify: true` が付いた問題は制度改正で内容が変わりうる論点です。アプリ上で警告が出ます。受験年度の最新情報で必ず裏を取ってください。

### 自分の問題を追加する

⚙ →「問題を読み込む」から取り込みます。

**JSON**

```json
[{
  "subject": "労働基準法",
  "type": "ox",
  "text": "使用者は…",
  "answer": 0,
  "explanation": "正しい。…",
  "source": "労基法35条"
}]
```

`type` が `choice` のときは `"choices": ["…", "…"]` を付け、`answer` は **0 始まり**の番号。

**CSV**（ヘッダ必須）

```csv
subject,type,text,choices,answer,explanation,source
労働基準法,choice,法定労働時間は？,週40時間|週44時間|週48時間,1,労基法32条の原則です。,労基法32条
```

CSV の `choices` は `|` 区切り、`answer` は **1 始まり**（○× は 1=○, 2=×）。

## 構成

```
index.html            画面
css/style.css         スタイル（ダーク/ライト自動）
js/store.js           設定・学習履歴(localStorage) / 問題(IndexedDB)
js/voice.js           読み上げ + 音声コマンド解析
js/gemini.js          Gemini API ラッパー
js/app.js             画面制御・出題ロジック
data/questions.json   初期問題
sw.js                 オフラインキャッシュ
```

## キーボード操作（PC で確認するとき）

`1`〜`5` 回答 / `O` `X` ○× / `Enter` `→` 次へ / `←` 前へ / `R` 読み上げ / `E` 解説 / `Esc` 読み上げ停止

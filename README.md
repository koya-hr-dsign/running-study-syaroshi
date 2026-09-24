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

## アカウント同期（任意）

⚙ →「アカウント同期」→ Google でログインすると、学習履歴と設定が Firestore の `users/{uid}` 配下に保存され、機種変更や別の端末でも引き継げます。

設計は**ローカル優先**です。端末内の localStorage / IndexedDB を常に正として動かし、Firestore はその上に乗る同期層にすぎません。ログインしなくてもアプリは従来どおり動き、オフラインでも学習できます。

- 学習履歴は問題ごとに最終解答時刻の新しいほうを採るので、複数端末で解いた分が合流します
- 取り込んだ問題も同期します（初期データは配信側にあるので対象外）
- **Gemini の API キーは同期しません**。秘密鍵をクラウドに置かないため、端末ごとに入力してください

接続情報は `js/firebase-config.js` にあります。ここに並ぶ値は公開前提のもので、リポジトリに含めて問題ありません。データを守るのは次のセキュリティルールです。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

別の Firebase プロジェクトを使う場合は、`js/firebase-config.js` を差し替え、Authentication で Google ログインを有効化し、配信するドメインを承認済みドメインに追加してください。

## AI 解説の設定

1. [Google AI Studio](https://aistudio.google.com/apikey) で API キーを取得
2. アプリの ⚙ → 「AI 解説（Gemini）」にキーを貼り付け

キーは端末の `localStorage` にのみ保存され、ブラウザから Gemini へ直接送られます。共用端末では使わないでください。

## 問題データ

初期データは `data/index.json` が索引となり、科目別ファイル（10科目×25問＝**250問**）を読み込みます。本試験と同じ **5肢択一**で、条文・制度に基づいて書き下ろしたオリジナル問題です（本試験の過去問本文は著作権があるため収録していません）。

正解の位置は上位に偏らないよう均してあります。初期データを差し替えたときは `js/store.js` の `SEED_VERSION` を上げると、既存の端末でも次回起動時に入れ替わります（取り込んだ問題と学習履歴は残ります）。

`verify: true` が付いた問題は制度改正で内容が変わりうる論点です。アプリ上で警告が出ます。受験年度の最新情報で必ず裏を取ってください。

### 自分の問題を追加する

⚙ →「問題を読み込む」から取り込みます。

**JSON**

```json
[{
  "subject": "労働基準法",
  "type": "choice",
  "text": "法定労働時間の原則として、正しいものはどれか。",
  "choices": ["1週44時間、1日8時間", "1週40時間、1日8時間", "…"],
  "answer": 1,
  "explanation": "1週40時間、1日8時間です。…",
  "source": "労基法32条"
}]
```

`answer` は **0 始まり**の番号。`type` を `ox` にすると○×問題になり、`choices` は不要（`answer` は 0=○, 1=×）。

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
js/firebase-config.js Firebase の接続情報
js/sync.js            Googleログインと Firestore 同期
js/app.js             画面制御・出題ロジック
data/index.json       初期問題の索引
data/*.json           科目別の問題（250問）
sw.js                 オフラインキャッシュ
```

## キーボード操作（PC で確認するとき）

`1`〜`5` 回答 / `O` `X` ○× / `Enter` `→` 次へ / `←` 前へ / `R` 読み上げ / `E` 解説 / `Esc` 読み上げ停止

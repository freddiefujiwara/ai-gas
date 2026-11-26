# ai-gas 統合設計（2026年11月26日、本人が統合と UI 書き換えを承認）

## 方針

- 土台は muse-gas（src/Code.js 850行）をそのまま使い、groq-gas（203行）からは
  Groq 呼び出し＋キャッシュ部分だけを移植する。新規に作り直さない。
- リポジトリは新規 `freddiefujiwara/ai-gas`（Public想定、muse-gas と同じ）。
  CI は muse-gas の node.yaml をそのまま流用（secrets 名も同じ:
  CLASPRC_JSON / DEPLOYMENT_ID / STAGING_SCRIPT_ID / STAGING_DEPLOYMENT_ID）。
- appsscript.json のスコープは muse-gas の集合で足りる（external_request 含む）。
  access は ANYONE_ANONYMOUS を維持。

## 入口の振り分け（doGet / doPost）

- GET で `p` パラメータがある → Groq 窓口（従来互換。xuexi-gas / time-table-gas 用）
- POST で action が無く `p` / `prompt` のみ、または生テキスト → Groq 窓口
- POST の生テキストは JSON.parse に失敗した場合のみ Groq 扱い（muse-gas の doPost は
  JSON 前提なので、parse 失敗→Groq フォールバックで両立できる）
- action あり → Muse 橋（従来どおり: ask / answer / rename / delete /
  exchange_session、GET は result / list / rss）

## 認証（トークンは用途別に分離）

- Muse 橋: API_TOKEN（従来どおり）＋ Web セッション
- Groq 窓口: 新プロパティ GROQ_TOKEN。**値は現 groq-gas の API_TOKEN と同値**にする
  → 呼び出し側（xuexi-gas / time-table-gas）は GROQ_GAS_URL の差し替えだけで済む
- RSS: RSS_TOKEN（従来どおり、ai-gas で新規生成）

## Groq を会話として扱う（UI のシームレス化）

- requests シートに `engine` 列を追加（title 列追加と同じマイグレーション方式。
  既定は muse、既存行は muse 扱い）
- ask に `engine: "groq"` を付けると、メールを送らず Groq を同期で呼び、
  out / in 両メッセージをシートに書いて status=replied で即返す
- Groq 会話への answer は、シートの履歴を messages 配列に組み立てて Groq へ送る
  （文脈継続）。callGroq は messages 配列対応に拡張し、従来の単一プロンプト経路
  （p パラメータ）はそのまま残す
- RSS は従来どおり Muse の会話だけを対象にする（「Muse 返信」の意味を維持）

## 名前の衝突整理

- MAX_PROMPT_LENGTH: muse 4000 / groq 20000 → groq 側を GROQ_MAX_PROMPT_LENGTH に改名
- createJsonResponse（groq）と jsonOut（muse）は jsonOut に統一
- isAuthorized は muse 側を維持、groq 側は isGroqAuthorized に改名

## プロパティ一覧（ai-gas）

従来の muse-gas 分: API_TOKEN / RSS_TOKEN / SPREADSHEET_ID / ALLOWED_EMAIL /
GOOGLE_CLIENT_ID / MUSE_EMAIL
追加: GROQ_API_KEY / GROQ_MODEL（現行値 openai/gpt-oss-120b）/ GROQ_TOKEN

- GROQ_API_KEY の移行は値をチャット・ログに出さない方法で行う
  

## データ移行

- **SPREADSHEET_ID は既存の muse-gas のスプレッドシートをそのまま指す**（推奨）
  → 過去の会話履歴と Web セッションがそのまま引き継がれ、移行作業が消える。
  統合後は ai-gas がそのシートの担当になるので「自分のシートだけを読む」原則にも反しない
- 添付フォルダ API/muse → API/ai に改名。旧ファイルは fileId 参照のため
  既存の画像リンクはそのまま表示できる

## 件名タグと Gmail フィルタ

- 件名タグは `[ai-gas:<id>]` に変更する
- Gmail フィルタ（from Muse のメールボックス（アドレスはスクリプトプロパティ MUSE_EMAIL で管理）＋件名 [muse-gas:）に
  `[ai-gas:` 用のフィルタを追加する。ラベルは当面 muse-gas を流用

## URL 依存

- FRONT_URL は新 URL の決定待ち（/ai/ なら https://freddiefujiwara.com/ai/）。
  RSS のリンク先とチャンネルリンクが連動する。コード作成はこの定数以外 URL に依存しない

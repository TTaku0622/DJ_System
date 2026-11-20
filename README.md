# DJ System

身内だけで使うリクエスト DJ。ホストが選んだデフォルト曲をホストの Spotify で流し、共有 URL を開いた人がスマホから曲を検索・リクエストできる。

- リクエスト曲は Spotify のキューに入るので、今の曲が終わるとリクエスト順で流れる（アプリの操作は不要）。デフォルト曲には入れない（デフォルト曲はホストが選んだ曲だけ）
- リクエストがないときはデフォルト曲が流れる。デフォルト曲はホスト画面で1曲ずつ検索して追加・削除するか、自分のプレイリストからまとめて入れる。一覧はアプリの D1 にだけ持ち、Spotify には曲を直接指定して流す（Spotify のプレイリストは作らない・書き換えない）。最後まで流れて止まったら自動で最初から流し直す（ホスト画面で ON/OFF）
- 追加は「＋ そのまま」「✎ ニックネーム・コメント付き」の2通り
- アクセス制限は推測できない URL だけ。ゲストは共有 URL、ホストは `/host/enter/<HOST_KEY>` を開くだけ（ホストは一度開けば90日間ブラウザが覚える）。ホスト画面の「共有 URL を作り直す」で前の URL は無効になる
- ホスト画面に QR・リンクのコピー・共有ボタン（スマホなら LINE などに直接送れる）がある

技術: Cloudflare Workers / Hono / D1 / Spotify Web API

## 準備
1. Spotify Developer Dashboard でアプリを作る（所有者の Premium が必要）。Redirect URI に次を登録する
   - `http://127.0.0.1:8787/callback`（テスト用）
   - `https://dj-system.<アカウント>.workers.dev/callback`（本番用）
2. `cp .dev.vars.example .dev.vars` で作ったファイルに `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `HOST_KEY`（ホスト用 URL に使う長いランダム文字列。`openssl rand -hex 24` で作る）を書く
3. `npm install`

## テスト（Mac + TryCloudflare）
```sh
brew install cloudflared   # 初回のみ
npm run tunnel
```
- Mac のブラウザで `http://127.0.0.1:8787/host/enter/<HOST_KEY>` を開き（起動時に表示される）、Spotify 連携 → デフォルト曲を追加して「最初から流す」
- 出てきた QR（`https://xxxx.trycloudflare.com/s/...`）をスマホで読む
- 自分の Spotify で流すなら、連携は 127.0.0.1 から行う（TryCloudflare の URL は毎回変わるので、登録の手間がない 127.0.0.1 が楽）

### 別の人のパソコン・別の人の Spotify でホストをする
起動は自分の Mac のまま、ホストは別の人に任せて、その人の Spotify から流す手順。
1. 事前に1回: Spotify Dashboard の User Management にその人のアカウントを登録する（自分を含めて5人まで。その人も Premium が必要）。`HOST_KEY` は推測されない値にしておく
2. `npm run tunnel` で起動し、`https://xxxx.trycloudflare.com/host/enter/<HOST_KEY>` をその人に送る
3. Dashboard の Redirect URIs に `https://xxxx.trycloudflare.com/callback` を足して Save（起動し直すと URL が変わるので毎回）
4. その人がホスト画面の「Spotify と連携し直す」で自分のアカウントにログイン → デフォルト曲を選んで共有
- 連携は1人分だけなので、その人の連携に入れ替わる。自分の Spotify に戻すときは自分で「連携し直す」を押す
- デフォルト曲の一覧はアプリに1つだけ。誰がホストでも同じ一覧を使う

## 本番（Cloudflare Workers）
```sh
npx wrangler login
npx wrangler d1 create dj-system        # 出てきた database_id を wrangler.toml に書く
npm run db:migrate:remote
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put HOST_KEY
npm run deploy
```
本番のホスト画面は `https://dj-system.<アカウント>.workers.dev/host/enter/<HOST_KEY>` をブックマークしておく。
GitHub に push して自動で反映したい場合は、Cloudflare ダッシュボードの Workers → 設定 → Builds でこのリポジトリをつなぐ。

## 注意
- Spotify の連携は6か月で切れる。ホスト画面の「連携し直す」から更新する
- ホストの端末で Spotify が開いていないと、曲の追加と自動再開はできない
- キューに入れた曲は取り消せない

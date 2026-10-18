# DJ System

身内だけで使うリクエスト DJ。ホストの Spotify で紐付けたプレイリストを流し、共有 URL を開いた人がスマホから曲を検索・追加できる。

- リクエスト曲は Spotify のキューに入るので、今の曲が終わるとリクエスト順で流れる（アプリの操作は不要）。プレイリストの末尾にも記録する
- リクエストがないときは、紐付けたプレイリストがデフォルトの曲として流れる。最後まで流れて止まったら自動で最初から流し直す（ホスト画面で ON/OFF）
- 追加は「＋ そのまま」「✎ ニックネーム・コメント付き」の2通り
- アクセス制限は推測できない共有 URL だけ。セッションを終了するとその URL は無効になる

技術: Cloudflare Workers / Hono / D1 / Spotify Web API

## 準備
1. Spotify Developer Dashboard でアプリを作る（所有者の Premium が必要）。Redirect URI に次を登録する
   - `http://127.0.0.1:8787/callback`（テスト用）
   - `https://dj-system.<アカウント>.workers.dev/callback`（本番用）
2. `cp .dev.vars.example .dev.vars` で作ったファイルに `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `HOST_KEY`（ホスト画面の合言葉）を書く
3. `npm install`

## テスト（Mac + TryCloudflare）
```sh
brew install cloudflared   # 初回のみ
npm run tunnel
```
- Mac のブラウザで `http://127.0.0.1:8787/host` を開き、合言葉 → Spotify 連携 → プレイリストを選んで開始
- 出てきた QR（`https://xxxx.trycloudflare.com/s/...`）をスマホで読む
- Spotify 連携は 127.0.0.1 から行う（TryCloudflare の URL は毎回変わるので Spotify に登録できない）

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
GitHub に push して自動で反映したい場合は、Cloudflare ダッシュボードの Workers → 設定 → Builds でこのリポジトリをつなぐ。

## 注意
- Spotify の連携は6か月で切れる。ホスト画面の「連携し直す」から更新する
- ホストの端末で Spotify が開いていないと、曲の追加と自動再開はできない
- キューに入れた曲は取り消せない
- プレイリストを最後まで流すと、末尾に記録したリクエスト曲がもう一度流れる

#!/bin/sh
# テスト用: ローカルの Workers を起動し、TryCloudflare でスマホから見られるようにする
set -e
command -v cloudflared >/dev/null || { echo "cloudflared がありません: brew install cloudflared"; exit 1; }
npx wrangler d1 migrations apply dj-system --local
npx wrangler dev --port 8787 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT INT TERM
echo "ホスト画面は Mac のブラウザで http://127.0.0.1:8787/host を開く（Spotify 連携はこちらから）"
cloudflared tunnel --url http://127.0.0.1:8787

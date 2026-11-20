import { raw } from 'hono/html'
import type { Session } from '../player'
import { Layout } from './Layout'

type HostProps = {
  connected: boolean
  authorizedAt?: number
  session: Session | null
  shareUrl: string | null
  qrSvg: string | null
  message: string | null
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })

// ON/OFF を切り替えるだけのフォーム（JS なしでも動く）
const Toggle = (p: { action: string; on: boolean; label: string; note: string }) => (
  <form method="post" action={p.action} class="toggle-row">
    <span>
      {p.label}
      <small class="muted">{p.note}</small>
    </span>
    <input type="hidden" name="value" value={p.on ? '0' : '1'} />
    <button class={p.on ? 'switch on' : 'switch'} aria-label={`${p.label}の切り替え`}>
      {p.on ? 'ON' : 'OFF'}
    </button>
  </form>
)

export const HostPage = (p: HostProps) => (
  <Layout title="DJ Host" bodyClass="host">
    <main class="app">
      <header class="topbar">
        <span class="brand">
          <span class="dot on"></span>DJ Host
        </span>
      </header>

      {p.message && <p class="notice">{p.message}</p>}

      {!p.connected ? (
        <section class="card stack">
          <h2>Spotify と連携</h2>
          <p class="muted">再生と曲の追加は、ここで連携したアカウント（Premium）で行います。</p>
          <a class="button primary" href="/host/spotify">
            Spotify と連携する
          </a>
        </section>
      ) : (
        p.session && (
          <div class="host-layout">
            <section class="card stack title-card">
              <h2>
                <label for="title">タイトル</label>
              </h2>
              <p class="muted">ゲスト画面の「DJ System」の横に出る名前です。空にすると何も出ません。</p>
              <form method="post" action="/host/session/title" class="copy-row">
                <input id="title" name="title" maxlength={30} value={p.session.title} placeholder="例: 学祭準備・ドライブ" />
                <button class="primary">保存</button>
              </form>
            </section>

            <section class="card stack share">
              <h2>共有</h2>
              <div class="qr">{raw(p.qrSvg ?? '')}</div>
              <div class="copy-row">
                <input readonly value={p.shareUrl ?? ''} id="share-url" />
                <button type="button" class="ghost" data-copy="share-url">
                  コピー
                </button>
              </div>
              <button type="button" class="primary wide" data-share="share-url" hidden>
                LINE などで共有
              </button>
              <a class="button" href={`/s/${p.session.id}`} target="_blank">
                ゲスト画面を開く
              </a>
            </section>

            <section class="card stack defaults" id="defaults">
              <div class="card-head">
                <h2>デフォルト曲</h2>
                <span class="muted" id="default-count"></span>
              </div>
              <p class="muted">リクエストがないときに流れる曲です。検索して追加し、準備ができたら流してください。流している途中で足した曲は、次に「最初から流す」を押したとき（または自動再開のとき）から入ります。</p>
              <form class="searchbar" id="default-search" role="search">
                <input type="search" id="dq" placeholder="追加する曲を検索" enterkeyhint="search" autocomplete="off" />
                <button type="submit" class="primary">検索</button>
              </form>
              <div class="results" id="default-results-box" hidden>
                <div class="results-head">
                  <h2 id="default-results-title">検索結果</h2>
                  <button type="button" class="ghost" id="default-results-close">
                    閉じる
                  </button>
                </div>
                <ul id="default-results" class="tracks"></ul>
              </div>
              <details class="import" id="import">
                <summary>
                  プレイリストからまとめて入れる
                  {/* Lucide の chevron-down（線アイコン） */}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </summary>
                <p class="muted">選んだプレイリストの曲をデフォルト曲の最後に入れます。すでに入っている曲は飛ばします。プレイリストのほうは書き換えません。</p>
                <ul id="import-list" class="tracks">
                  <li class="empty">読み込み中…</li>
                </ul>
              </details>
              <p class="muted" id="default-status" role="status" aria-live="polite"></p>
              <ol id="default-list" class="tracks default-list">
                <li class="empty">読み込み中…</li>
              </ol>
              <form method="post" action="/host/session/play">
                <button class="primary wide">デフォルト曲を最初から流す</button>
              </form>
            </section>

            <section class="card stack settings">
              <h2>設定</h2>
              <Toggle
                action="/host/session/shuffle"
                on={Boolean(p.session.shuffle)}
                label="シャッフル"
                note="デフォルト曲をばらばらの順で流す"
              />
              <Toggle
                action="/host/session/auto-resume"
                on={Boolean(p.session.auto_resume)}
                label="自動再開"
                note="デフォルト曲を流し終えて止まったら最初から流し直す"
              />
              <form method="post" action="/host/session/renew" class="stack">
                <button class="danger wide">共有 URL を作り直す</button>
                <small class="muted">前の URL と QR は使えなくなります。デフォルト曲はそのまま残ります</small>
              </form>
              <p class="muted">
                Spotify の連携日: {p.authorizedAt ? fmtDate(p.authorizedAt) : '—'}（6か月で切れるので、その前に連携し直す）
              </p>
              <a class="button" href="/host/spotify">
                Spotify と連携し直す
              </a>
            </section>
          </div>
        )
      )}
    </main>
    <script src="/host.js" defer></script>
  </Layout>
)

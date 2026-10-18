import { raw } from 'hono/html'
import type { Session } from '../player'
import type { Playlist } from '../spotify'
import { Layout } from './Layout'

export const HostLogin = (props: { error?: boolean }) => (
  <Layout title="ホスト" bodyClass="center">
    <main class="card">
      <h1>ホスト</h1>
      <form method="post" action="/host/login" class="stack">
        <label>
          合言葉
          <input type="password" name="key" required autofocus autocomplete="current-password" />
        </label>
        {props.error && <p class="error">合言葉が違います</p>}
        <button class="primary">入る</button>
      </form>
    </main>
  </Layout>
)

type HostProps = {
  connected: boolean
  authorizedAt?: number
  session: Session | null
  shareUrl: string | null
  qrSvg: string | null
  playlists: Playlist[]
  message: string | null
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })

export const HostPage = (p: HostProps) => (
  <Layout title="ホスト" bodyClass="host">
    <main class="app">
      <header class="topbar">
        <span class="brand">
          <span class="dot on"></span>DJ ホスト
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
        <>
          {p.session && (
            <section class="card stack share">
              <h2>共有中: {p.session.playlist_name}</h2>
              <div class="qr">{raw(p.qrSvg ?? '')}</div>
              <div class="copy-row">
                <input readonly value={p.shareUrl ?? ''} id="share-url" />
                <button type="button" class="ghost" data-copy="share-url">
                  コピー
                </button>
              </div>
              <a class="button" href={`/s/${p.session.id}`} target="_blank">
                ゲスト画面を開く
              </a>
              <form method="post" action="/host/session/play">
                <button class="button wide">デフォルト曲を最初から流す</button>
              </form>
              <form method="post" action="/host/session/auto-resume" class="toggle-row">
                <span>
                  自動再開
                  <small class="muted">プレイリストを流し終えて止まったら最初から流し直す</small>
                </span>
                <input type="hidden" name="value" value={p.session.auto_resume ? '0' : '1'} />
                <button class={p.session.auto_resume ? 'switch on' : 'switch'} aria-label="自動再開の切り替え">
                  {p.session.auto_resume ? 'ON' : 'OFF'}
                </button>
              </form>
              <form method="post" action="/host/session/end">
                <button class="danger wide">セッションを終了（URL を無効にする）</button>
              </form>
            </section>
          )}

          <section class="card stack">
            <h2>{p.session ? '別のプレイリストで始め直す' : 'セッションを始める'}</h2>
            <p class="muted">選んだプレイリストがデフォルトの曲になり、リクエスト曲は末尾に記録されます。</p>
            <form method="post" action="/host/session" class="stack">
              <ul class="playlists">
                {p.playlists.map((pl, i) => (
                  <li>
                    <label>
                      <input type="radio" name="playlist" value={`${pl.id}\t${pl.name}`} required checked={i === 0} />
                      {pl.image ? <img src={pl.image} alt="" loading="lazy" /> : <span class="noart"></span>}
                      <span class="pl-name">{pl.name}</span>
                      <span class="muted">{pl.total}曲</span>
                    </label>
                  </li>
                ))}
              </ul>
              {p.playlists.length === 0 && <p class="muted">自分のプレイリストがありません。Spotify で作ってから再読み込みしてください。</p>}
              <label class="check">
                <input type="checkbox" name="shuffle" value="1" />
                デフォルト曲をシャッフル再生する
              </label>
              <button class="primary wide">始める（再生も開始）</button>
            </form>
          </section>

          <section class="card stack">
            <p class="muted">
              連携日: {p.authorizedAt ? fmtDate(p.authorizedAt) : '—'}（6か月で切れるので、その前に連携し直す）
            </p>
            <a class="button" href="/host/spotify">
              Spotify と連携し直す
            </a>
          </section>
        </>
      )}
    </main>
    <script src="/host.js" defer></script>
  </Layout>
)

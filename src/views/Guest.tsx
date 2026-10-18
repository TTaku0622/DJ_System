import type { Session } from '../player'
import { Layout } from './Layout'

// ゲスト画面。中身は public/app.js がポーリングで埋める
export const GuestPage = (props: { session: Session }) => (
  <Layout title={`DJ · ${props.session.playlist_name}`} bodyClass="guest">
    <main class="app" data-session={props.session.id}>
      <header class="topbar">
        <span class="brand">
          <span class="dot" id="live-dot"></span>DJ
        </span>
        <span class="playlist">{props.session.playlist_name}</span>
      </header>

      <section class="now" id="now">
        <div class="art">
          <img id="now-art" alt="" />
        </div>
        <div class="now-meta">
          <p class="label" id="now-label">NOW PLAYING</p>
          <h1 id="now-title">読み込み中…</h1>
          <p class="artist" id="now-artist"></p>
          <p class="req" id="now-req" hidden></p>
        </div>
      </section>

      <p class="notice" id="notice" hidden></p>

      <section class="upnext">
        <h2>次に流れる曲</h2>
        <ol id="next" class="tracks"></ol>
      </section>
    </main>

    <div class="sheet" id="sheet" hidden>
      <div class="sheet-backdrop" data-close></div>
      <div class="sheet-panel" role="dialog" aria-label="検索結果">
        <div class="sheet-head">
          <span id="results-title">検索結果</span>
          <button type="button" class="ghost" data-close>閉じる</button>
        </div>
        <p class="hint">
          <span class="key">＋</span>そのまま追加　<span class="key">✎</span>名前・コメント付きで追加
        </p>
        <ul id="results" class="tracks"></ul>
      </div>
    </div>

    <form class="searchbar" id="search-form" role="search">
      <input type="search" id="q" placeholder="曲名・アーティストで検索" enterkeyhint="search" autocomplete="off" />
      <button type="submit" class="primary">検索</button>
    </form>

    <dialog id="msg-dialog" class="msg-dialog">
      <form method="dialog" id="msg-form">
        <div class="msg-track" id="msg-track"></div>
        <label>
          ニックネーム<span class="opt">任意</span>
          <input name="nickname" maxlength={20} autocomplete="nickname" />
        </label>
        <label>
          コメント<span class="opt">任意</span>
          <input name="comment" maxlength={60} placeholder="ひとこと" />
        </label>
        <div class="actions">
          <button value="cancel" formnovalidate class="ghost">やめる</button>
          <button value="ok" class="primary">追加する</button>
        </div>
      </form>
    </dialog>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <script src="/app.js" defer></script>
  </Layout>
)

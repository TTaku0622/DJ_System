// ホスト画面: 共有 URL のコピー
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copy)
    try {
      await navigator.clipboard.writeText(input.value)
    } catch {
      input.select()
      document.execCommand('copy')
    }
    button.textContent = 'コピーしました'
    setTimeout(() => (button.textContent = 'コピー'), 1500)
  })
})

// スマホでは共有シート（LINE・AirDrop など）から直接送れるようにする
document.querySelectorAll('[data-share]').forEach((button) => {
  if (!navigator.share) return
  button.hidden = false
  button.addEventListener('click', () => {
    const url = document.getElementById(button.dataset.share).value
    navigator.share({ title: 'DJ', text: 'ここから曲をリクエストできるよ', url }).catch(() => {})
  })
})

// 押し間違えると困る操作は、実行する前に確認する（JS が使えないときは確認なしで動く）
const confirmBox = document.getElementById('confirm-dialog')
let confirming = null
if (confirmBox) document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    confirming = form
    document.getElementById('confirm-title').textContent = form.dataset.confirm
    document.getElementById('confirm-note').textContent = form.dataset.note
    document.getElementById('confirm-ok').textContent = form.dataset.ok
    confirmBox.returnValue = ''
    confirmBox.showModal()
  })
})
document.getElementById('confirm-cancel')?.addEventListener('click', () => confirmBox.close())
confirmBox?.addEventListener('close', () => {
  if (confirmBox.returnValue === 'ok') confirming.submit()
})

// ---- デフォルト曲（紐付けプレイリストの中身）の表示・検索・追加・削除 ----
const defaults = document.getElementById('defaults')
if (defaults) {
  const $ = (id) => document.getElementById(id)

  // 文字列はすべて textContent で入れる（曲名に HTML が入っていても安全）
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v)
    }
    node.append(...children.filter(Boolean))
    return node
  }
  // loading は src より先に付ける（Safari は src を付けた時点で読み始めるので、後だと全部の画像を一度に読んでしまう）
  const art = (src) => (src ? el('img', { loading: 'lazy', alt: '', src }) : el('span', { class: 'noart' }))
  const row = (t, button) =>
    el('li', { class: 'track' }, art(t.image),
      el('div', { class: 't' }, el('div', { class: 'name', text: t.name }), el('div', { class: 'sub', text: t.artist })),
      button)

  const status = (message) => ($('default-status').textContent = message)

  async function call(path, body) {
    const res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' }).catch(() => null)
    if (!res) throw new Error('通信できていません。電波を確かめてください')
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || 'エラーが起きました')
    return json
  }

  async function load() {
    const list = $('default-list')
    try {
      const { tracks } = await call('/host/api/default')
      $('default-count').textContent = `${tracks.length}曲`
      list.replaceChildren(...tracks.map((t) => row(t, el('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `${t.name} を外す`, text: '×',
        onclick: (ev) => remove(t, ev.currentTarget),
      }))))
      if (tracks.length === 0) list.append(el('li', { class: 'empty', text: 'まだありません。上の検索から追加してください' }))
    } catch (err) {
      list.replaceChildren(el('li', { class: 'empty', text: err.message }))
    }
  }

  async function add(t, button) {
    button.disabled = true
    try {
      const { added } = await call('/host/api/default', { uri: t.uri })
      button.textContent = '✓'
      status(added ? `「${t.name}」を追加しました` : `「${t.name}」はもう入っています`)
      load()
    } catch (err) {
      button.disabled = false
      status(err.message)
    }
  }

  async function remove(t, button) {
    button.disabled = true
    try {
      await call('/host/api/default/remove', { id: t.id })
      status(`「${t.name}」を外しました`)
      load()
    } catch (err) {
      button.disabled = false
      status(err.message)
    }
  }

  const box = $('default-results-box')
  let searches = 0
  const closeResults = () => {
    searches++ // 検索中に閉じたら、あとから届いた結果は使わない
    box.hidden = true
    $('default-results').replaceChildren()
    $('dq').value = ''
  }
  $('default-results-close').addEventListener('click', closeResults)

  $('default-search').addEventListener('submit', async (e) => {
    e.preventDefault()
    const q = $('dq').value.trim()
    if (!q) return
    $('dq').blur()
    const mine = ++searches
    const results = $('default-results')
    $('default-results-title').textContent = `「${q}」の検索結果`
    results.replaceChildren(el('li', { class: 'empty', text: '検索中…' }))
    box.hidden = false
    try {
      const { tracks } = await call(`/host/api/search?q=${encodeURIComponent(q)}`)
      if (mine !== searches) return // 次の検索を始めていたら、前の結果で上書きしない
      results.replaceChildren(...tracks.map((t) => row(t, el('button', {
        type: 'button', class: 'icon-btn primary', 'aria-label': `${t.name} をデフォルト曲に追加`, text: '＋',
        onclick: (ev) => add(t, ev.currentTarget),
      }))))
      if (tracks.length === 0) results.append(el('li', { class: 'empty', text: '見つかりませんでした' }))
    } catch (err) {
      if (mine !== searches) return
      results.replaceChildren(el('li', { class: 'empty', text: err.message }))
    }
  })

  // プレイリストからまとめて入れる（開いたときに一覧を読み込む）
  const importBox = $('import')
  let playlistsLoaded = false
  importBox.addEventListener('toggle', async () => {
    if (!importBox.open || playlistsLoaded) return
    playlistsLoaded = true
    const list = $('import-list')
    try {
      const { playlists } = await call('/host/api/playlists')
      list.replaceChildren(...playlists.map((pl) => row({ name: pl.name, artist: `${pl.total}曲`, image: pl.image }, el('button', {
        type: 'button', class: 'ghost import-btn', 'aria-label': `${pl.name} の曲をまとめて入れる`, text: '入れる',
        onclick: (ev) => importFrom(pl, ev.currentTarget),
      }))))
      if (playlists.length === 0) list.append(el('li', { class: 'empty', text: '入れられるプレイリストがありません' }))
    } catch (err) {
      playlistsLoaded = false
      list.replaceChildren(el('li', { class: 'empty', text: err.message }))
    }
  })

  async function importFrom(pl, button) {
    button.disabled = true
    status(`「${pl.name}」から入れています…`)
    try {
      const { added, skipped } = await call('/host/api/default/import', { playlistId: pl.id })
      status(`「${pl.name}」から${added}曲入れました` + (skipped ? `（すでに入っていた${skipped}曲は飛ばしました）` : ''))
      button.textContent = '入れました'
      load()
    } catch (err) {
      button.disabled = false
      status(err.message)
    }
  }

  load()
}

// ゲスト画面: 5秒ごとの再生状態の取得・検索・リクエスト追加
const root = document.querySelector('[data-session]')
const API = `/api/s/${root.dataset.session}`
const $ = (id) => document.getElementById(id)
const NICK_KEY = 'dj.nickname'

const store = {
  get(key) { try { return localStorage.getItem(key) ?? '' } catch { return '' } },
  set(key, value) { try { localStorage.setItem(key, value) } catch {} },
}

// 文字列はすべて textContent で入れる（曲名やコメントに HTML が入っていても安全）
function el(tag, props = {}, ...children) {
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

function art(src) {
  return src ? el('img', { src, alt: '', loading: 'lazy' }) : el('span', { class: 'noart' })
}

function requestLabel(req) {
  if (!req) return ''
  const who = req.nickname || '匿名'
  return req.comment ? `${who}「${req.comment}」` : `${who} のリクエスト`
}

let toastTimer
function toast(message, isError = false) {
  const t = $('toast')
  t.textContent = message
  t.classList.toggle('error', isError)
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200)
}

// ---- ジャケットの色をアクセントにする ----
const accentCache = new Map()
function applyAccent(src) {
  if (!src) return
  if (accentCache.has(src)) return setAccent(accentCache.get(src))
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const c = document.createElement('canvas')
      c.width = c.height = 16
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0, 16, 16)
      const d = ctx.getImageData(0, 0, 16, 16).data
      // 彩度の高い画素を重めに平均して、くすんだ色になりにくくする
      let r = 0, g = 0, b = 0, w = 0
      for (let i = 0; i < d.length; i += 4) {
        const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2])
        const weight = 1 + (max - min) / 32
        r += d[i] * weight; g += d[i + 1] * weight; b += d[i + 2] * weight; w += weight
      }
      const color = vivid(r / w, g / w, b / w)
      accentCache.set(src, color)
      setAccent(color)
    } catch {}
  }
  img.src = src
}

function vivid(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0
  const l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
  }
  h = Math.round(h * 60 + 360) % 360
  // 暗い背景で読めるように、明るさと彩度に下限を付ける
  return `hsl(${h} ${Math.round(Math.max(s, 0.45) * 100)}% ${Math.round(Math.min(Math.max(l, 0.5), 0.65) * 100)}%)`
}

function setAccent(color) {
  document.documentElement.style.setProperty('--accent', color)
}

// ---- 再生状態 ----
let currentUri = null

function trackRow(t, extra) {
  return el('li', { class: 'track' },
    art(t.image),
    el('div', { class: 't' },
      el('div', { class: 'name' }, t.request ? el('span', { class: 'badge', text: 'REQ' }) : null, t.name),
      el('div', { class: 'sub', text: t.request ? `${t.artist} · ${requestLabel(t.request)}` : t.artist }),
    ),
    extra ?? el('span'),
  )
}

function render(state) {
  $('live-dot').classList.toggle('on', state.isPlaying)
  const notice = $('notice')
  notice.hidden = !state.notice
  notice.textContent = state.notice ?? ''

  const c = state.current
  if ((c?.uri ?? null) !== currentUri) {
    currentUri = c?.uri ?? null
    const now = $('now')
    now.classList.remove('switching')
    void now.offsetWidth // アニメーションをやり直すため
    now.classList.add('switching')
    $('now-art').src = c?.image ?? ''
    $('now-title').textContent = c ? c.name : '再生していません'
    $('now-artist').textContent = c?.artist ?? ''
    applyAccent(c?.image)
  }
  $('now-label').textContent = state.isPlaying ? 'NOW PLAYING' : 'PAUSED'
  const req = $('now-req')
  req.hidden = !c?.request
  req.textContent = c?.request ? `🎧 ${requestLabel(c.request)}` : ''

  const list = $('next')
  list.replaceChildren(...state.next.map((t) => trackRow(t)))
  if (state.next.length === 0) list.append(el('li', { class: 'empty', text: 'まだありません。上の検索から曲を追加できます' }))
}

let pollTimer
async function poll() {
  clearTimeout(pollTimer)
  try {
    const res = await fetch(`${API}/state`, { cache: 'no-store' })
    if (res.status === 404) return location.reload() // セッション終了
    if (res.ok) render(await res.json())
  } catch {}
  if (!document.hidden) pollTimer = setTimeout(poll, 5000)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })

// ---- 検索 ----
const resultsBox = $('results-box')
function openResults() { resultsBox.hidden = false }
function closeResults() {
  resultsBox.hidden = true
  $('results').replaceChildren()
  $('q').value = ''
}
$('results-close').addEventListener('click', closeResults)

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('q')
  const q = input.value.trim()
  if (!q) return
  input.blur() // キーボードを閉じて結果を見やすく
  const results = $('results')
  $('results-title').textContent = `「${q}」の検索結果`
  results.replaceChildren(el('li', { class: 'empty', text: '検索中…' }))
  openResults()
  try {
    const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`)
    const { tracks, error } = await res.json()
    if (!res.ok) throw new Error(error)
    results.replaceChildren(...tracks.map((t) => trackRow(t, el('div', { class: 'btns' },
      el('button', { type: 'button', class: 'icon-btn primary', 'aria-label': `${t.name} をそのまま追加`, text: '＋', onclick: (ev) => add(t, null, null, ev.currentTarget) }),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t.name} を名前・コメント付きで追加`, text: '✎', onclick: () => openMessage(t) }),
    ))))
    if (tracks.length === 0) results.append(el('li', { class: 'empty', text: '見つかりませんでした' }))
  } catch (err) {
    results.replaceChildren(el('li', { class: 'empty', text: err.message || '検索できませんでした' }))
  }
})

// ---- 追加 ----
async function add(t, nickname, comment, button) {
  if (button) button.disabled = true
  try {
    const res = await fetch(`${API}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: t.uri, name: t.name, artist: t.artist, image: t.image, nickname, comment }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error)
    toast(json.ahead === 0 ? `「${t.name}」を追加しました・次に流れます` : `「${t.name}」を追加しました・あと${json.ahead}曲のあとに流れます`)
    closeResults()
    setTimeout(poll, 800)
  } catch (err) {
    toast(err.message || '追加できませんでした', true)
    if (button) button.disabled = false
  }
}

const dialog = $('msg-dialog')
const form = $('msg-form')
let pending = null
function openMessage(t) {
  pending = t
  $('msg-track').replaceChildren(art(t.image), el('div', { class: 't' },
    el('div', { class: 'name', text: t.name }), el('div', { class: 'sub muted', text: t.artist })))
  form.nickname.value = store.get(NICK_KEY)
  form.comment.value = ''
  dialog.showModal()
}
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'ok' || !pending) return
  const nickname = form.nickname.value.trim()
  store.set(NICK_KEY, nickname) // 次回も同じ名前を自動で入れる
  add(pending, nickname || null, form.comment.value.trim() || null)
  pending = null
})

poll()

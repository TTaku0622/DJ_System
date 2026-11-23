// 再生状態の取得・リクエスト追加・デフォルト曲の自動再開
import { waitUntil } from 'cloudflare:workers'
import { Shared } from './shared'
import { api, Env, SpotifyError, toTrack, Track } from './spotify'

export type Session = {
  id: string
  playlist_id: string
  playlist_name: string
  title: string
  shuffle: number
  auto_resume: number
  last_seen_playing_at: number | null
  last_device_id: string | null
  last_track_uri: string | null
  stopped_at: number | null
  current_request_id: number | null
  adding_at: number | null
  created_at: number
  ended_at: number | null
}

export type Playback = {
  isPlaying: boolean
  progressMs: number
  current: Track | null
  next: Track[]
  queue: string[] | null // Spotify が返したままの並び（取れなかったときは null）
  more: boolean // この後ろにもまだ続きがあるかもしれない
  endsAt: number | null // 今の曲が終わる見込みの時刻（止まっているときは null）
  deviceId: string | null
  contextUri: string | null
  shuffle: boolean
  repeat: 'off' | 'context' | 'track'
}

type RequestRow = {
  track_uri: string
  track_name: string
  artist: string
  image_url: string | null
  nickname: string | null
  comment: string | null
}

export type RequestInfo = { nickname: string | null; comment: string | null }

// ゲストが何人いても Spotify への問い合わせが増えないよう、数秒だけ使い回す
const CACHE_MS = 4000
// 混み合っている（429）間、前の状態を出しておく長さの上限
const STALE_MS = 60_000
// Spotify が返す「次の曲」は先頭20曲まで（公式の説明には無いが、開発者の報告による）
const QUEUE_LIMIT = 20

let cache: { at: number; value: Playback } | null = null
let failed: { until: number; error: SpotifyError } | null = null
let generation = 0
const loading = new Shared<Playback>()

export function invalidatePlayback() {
  cache = null
  generation++
  loading.reset()
  // 混み合い（429）で待つように言われている間は、聞き直しても断られるだけなので待つ
  if (failed?.error.status !== 429) failed = null
}

export async function playback(env: Env): Promise<Playback> {
  const now = Date.now()
  if (cache) {
    const age = now - cache.at
    // 使い回している間に曲が終わったはずなら、取り直す
    const ended = cache.value.endsAt !== null && now >= cache.value.endsAt
    if (age < (ended ? 1000 : CACHE_MS)) return cache.value
  }
  // 混み合っている（429）間は、少し前の状態を出しておく
  const fallback = (e: unknown) => {
    if (e instanceof SpotifyError && e.status === 429 && cache && now - cache.at < STALE_MS) return cache.value
    throw e
  }
  // 失敗した直後に全員が聞き直すと、混み合いが長引くので少し待つ
  if (failed && now < failed.until) return fallback(failed.error)
  const result = loading.run(async () => {
    const mine = generation
    try {
      const value = await loadPlayback(env)
      // 取っている間に曲が追加されたら、その前の状態なので使い回さない
      if (mine === generation) cache = { at: Date.now(), value }
      failed = null
      return value
    } catch (e) {
      if (e instanceof SpotifyError) {
        const wait = e.status === 429 ? Math.min(Math.max(e.retryAfter, 5), 300) * 1000 : CACHE_MS
        failed = { until: Date.now() + wait, error: e }
      }
      throw e
    }
  })
  return result.catch(fallback)
}

async function loadPlayback(env: Env): Promise<Playback> {
  const [state, queue] = await Promise.all([
    api(env, 'GET', '/me/player'),
    api(env, 'GET', '/me/player/queue').catch((e) => {
      // 混み合い（429）を「次の曲なし」と取り違えない
      if (e instanceof SpotifyError && e.status === 429) throw e
      // 再生端末がないときは失敗するので空扱い
      return null
    }),
  ])
  const current = toTrack(state?.item)
  const repeat: Playback['repeat'] = state?.repeat_state === 'context' || state?.repeat_state === 'track' ? state.repeat_state : 'off'
  const upcoming: Track[] = (queue?.queue ?? []).map(toTrack).filter((t: Track | null): t is Track => t !== null)
  // Spotify は、ループ中や残りの曲が少ないときに同じ曲をくり返し並べて返すことがあるので、1曲1回だけにする。
  // 1曲リピートなら今の曲は並べない
  const seen = new Set(repeat === 'track' && current ? [current.uri] : [])
  const next = upcoming.filter((t) => !seen.has(t.uri) && seen.add(t.uri))
  return {
    isPlaying: Boolean(state?.is_playing),
    progressMs: state?.progress_ms ?? 0,
    current,
    next,
    // 1曲リピート中は今の曲も「次」に並ぶので除く
    queue: queue ? upcoming.map((t) => t.uri).filter((uri) => repeat !== 'track' || uri !== current?.uri) : null,
    more: (queue?.queue?.length ?? 0) >= QUEUE_LIMIT,
    endsAt: state?.is_playing && current ? Date.now() + current.durationMs - (state.progress_ms ?? 0) : null,
    deviceId: state?.device?.id ?? null,
    contextUri: state?.context?.uri ?? null,
    shuffle: Boolean(state?.shuffle_state),
    repeat,
  }
}

export async function activeSession(env: Env, id?: string): Promise<Session | null> {
  const sql = id
    ? 'SELECT * FROM sessions WHERE id = ? AND ended_at IS NULL'
    : 'SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1'
  const stmt = env.DB.prepare(sql)
  return (id ? stmt.bind(id) : stmt).first<Session>()
}

// ---- デフォルト曲（Spotify のプレイリストは使わず、アプリの中だけに持つ） ----

export type DefaultTrack = Track & { id: number }

type DefaultRow = { id: number; track_uri: string; track_name: string; artist: string; image_url: string; duration_ms: number }

export async function defaultTracks(env: Env): Promise<DefaultTrack[]> {
  const { results } = await env.DB.prepare('SELECT * FROM default_tracks ORDER BY id').all<DefaultRow>()
  return results.map((r) => ({
    id: r.id,
    uri: r.track_uri,
    name: r.track_name,
    artist: r.artist,
    image: r.image_url,
    durationMs: r.duration_ms,
  }))
}

// 末尾に足す。すでに入っている曲は飛ばし、実際に入った曲数を返す
export async function addDefaultTracks(env: Env, tracks: Track[]): Promise<number> {
  if (tracks.length === 0) return 0
  const now = Date.now()
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO default_tracks (track_uri, track_name, artist, image_url, duration_ms, added_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const results = await env.DB.batch(tracks.map((t) => stmt.bind(t.uri, t.name, t.artist, t.image, t.durationMs, now)))
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
}

// Spotify に曲をまとめて直接指定して流す。多すぎると失敗するので先頭から500曲まで
const MAX_PLAY = 500

// デフォルト曲を最初から流す
export async function startDefaults(env: Env, session: Session, deviceId: string | null) {
  const uris = (await defaultTracks(env)).slice(0, MAX_PLAY).map((t) => t.uri)
  if (uris.length === 0) throw new Error('NO_DEFAULTS')
  const device = deviceId ? `device_id=${encodeURIComponent(deviceId)}` : ''
  const shuffle = `/me/player/shuffle?state=${session.shuffle ? 'true' : 'false'}${device ? `&${device}` : ''}`
  const shuffleSet = await api(env, 'PUT', shuffle).then(() => true, () => false)
  await api(env, 'PUT', `/me/player/play${device ? `?${device}` : ''}`, { uris })
  // 再生前は端末が止まっていてシャッフル設定に失敗することがあるので、再生後にもう一度
  if (!shuffleSet) await api(env, 'PUT', shuffle).catch(() => {})
  invalidatePlayback()
}

// ---- 再生済みの記録 ----

// 2つの並びに、同じ順番で共通して出てくる曲の数（間に別の曲が挟まっていてもよい）
function commonInOrder(a: string[], b: string[]): number {
  let row: number[] = new Array(b.length + 1).fill(0)
  for (const x of a) {
    const prev = row
    row = [0]
    for (let j = 1; j <= b.length; j++) row[j] = x === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1])
  }
  return row[b.length]
}

// 今流れている曲が未再生リクエストの何番目かを決め、そこまでの件数を返す（決められなければ 0）。
// 同じ曲が2回リクエストされていると曲だけでは区別できないので、キューにまだ残っている曲が
// 全部その後ろに並んでいるものだけを「これが流れている」とみなす
export function playedCount(pending: string[], current: string, queue: string[]): number {
  // リクエストはキューの先頭側に並ぶ。ホストが直接足した曲の分だけ少し余裕を見る
  const head = queue.slice(0, pending.length + 3)
  const left = commonInOrder(pending, head)
  return pending.findIndex((uri, i) => uri === current && commonInOrder(pending.slice(i + 1), head) === left) + 1
}

// 曲が変わったら、その曲のリクエスト（と、見逃したそれより前の分）を再生済みにする
async function markPlayed(env: Env, session: Session, uri: string, queue: string[]) {
  const { results: pending } = await env.DB.prepare(
    'SELECT id, track_uri FROM requests WHERE session_id = ? AND played_at IS NULL ORDER BY id',
  ).bind(session.id).all<{ id: number; track_uri: string }>()

  let lastId: number | null = null
  if (pending.some((r) => r.track_uri === uri)) {
    // デフォルト曲と同じ曲は、キューにあってもリクエストの分とは限らないので手がかりにしない
    const defaults = new Set((await defaultTracks(env)).map((t) => t.uri))
    const count = playedCount(pending.map((r) => r.track_uri), uri, queue.filter((u) => !defaults.has(u)))
    // まだ決められない（キューの情報が古いなど）。曲が変わったことにせず、次の確認でもう一度見る
    if (count === 0) return
    lastId = pending[count - 1].id
  }

  // 同時に何人も画面を開いていても、1回の曲の変わり目で処理するのは1回だけにする。
  // 2回処理すると、2回目が同じ曲の別のリクエストまで再生済みにしてしまう
  const { meta } = await env.DB.prepare(
    'UPDATE sessions SET last_track_uri = ?, current_request_id = ? WHERE id = ? AND last_track_uri IS ?',
  ).bind(uri, lastId, session.id, session.last_track_uri).run()
  if (!meta.changes || lastId === null) return
  await env.DB.prepare('UPDATE requests SET played_at = ? WHERE session_id = ? AND played_at IS NULL AND id <= ?')
    .bind(Date.now(), session.id, lastId).run()
}

// ポーリングと Cron の両方から呼ぶ。再生済みの記録と、止まったときの自動再開
export async function syncSession(env: Env, session: Session, pb: Playback) {
  const now = Date.now()
  const uri = pb.current?.uri ?? null

  if (uri && uri !== session.last_track_uri && pb.queue) await markPlayed(env, session, uri, pb.queue)

  if (pb.isPlaying) {
    await env.DB.prepare(
      'UPDATE sessions SET last_seen_playing_at = ?, last_device_id = COALESCE(?, last_device_id), stopped_at = NULL WHERE id = ?',
    ).bind(now, pb.deviceId, session.id).run()
    return
  }

  // ---- 自動再開（デフォルト曲を流し終えて止まったら最初から流し直す） ----
  // 以前は1回見ただけで判断していたため、曲の切り替わりの一瞬や Spotify の接続が一瞬切れたときにも
  // 「流し終えた」と勘違いして、デフォルト曲の最初に戻ってしまっていた
  const clearStop = () => env.DB.prepare('UPDATE sessions SET stopped_at = NULL WHERE id = ?').bind(session.id).run()
  if (!session.auto_resume || !session.last_seen_playing_at) return
  // 10分以上止まっているなら、ホストが止めたものとみなして触らない
  if (now - session.last_seen_playing_at > 10 * 60_000) return
  // 再生中の端末が見えない（アプリが裏に回った・電波が途切れた）ときは一時的なことが多いので触らない
  if (!pb.deviceId || !pb.current) return
  // ループ中は Spotify が自分でくり返す。アルバムなどデフォルト曲以外を流していたときも触らない
  if (pb.repeat !== 'off' || pb.contextUri) return
  // 曲の途中で止まっている＝一時停止。曲の頭か終わりで止まっている＝流し終えた
  const finished = pb.progressMs === 0 || pb.current.durationMs - pb.progressMs < 3000
  if (!finished) {
    if (session.stopped_at) await clearStop()
    return
  }
  // 曲の切り替わりの一瞬と区別するため、止まった状態が15秒以上続いたときだけ流し直す
  if (!session.stopped_at) {
    await env.DB.prepare('UPDATE sessions SET stopped_at = ? WHERE id = ?').bind(now, session.id).run()
    return
  }
  if (now - session.stopped_at < 15_000) return
  // 同時に何人も画面を開いていても、流し直すのは1回だけにする
  const { meta } = await env.DB.prepare('UPDATE sessions SET stopped_at = NULL WHERE id = ? AND stopped_at = ?')
    .bind(session.id, session.stopped_at).run()
  if (!meta.changes) return
  console.log('auto resume', { track: pb.current.name, progressMs: pb.progressMs, stoppedForMs: now - session.stopped_at })
  await startDefaults(env, session, pb.deviceId).catch((e) => console.error('auto resume failed', e))
}

// ---- リクエストの追加 ----

// 記録の「待っているリクエスト」を、Spotify のキューの並びと突き合わせる。
// matched はキューの各曲に対応するリクエスト、beyond はキューに見えている範囲より後ろで待っているリクエスト
function matchQueue<T extends { track_uri: string }>(pending: T[], queue: string[], more: boolean) {
  const used = new Set<T>()
  let last: T | undefined // キューに見えている最後のリクエスト
  let after = 0 // その後ろに並んでいる、リクエストでない曲の数
  const matched = queue.map((uri) => {
    const r = pending.find((p) => p.track_uri === uri && !used.has(p))
    if (r) used.add(r)
    if (r) last = r
    after = r ? 0 : after + 1
    return r
  })
  // 見えている範囲の終わりまでリクエストが続いているときだけ、その先にもリクエストがあるとみなす
  // （ホストが直接足した曲の分だけ少し余裕を見る）
  if (!more || !last || after > 3) return { matched, beyond: [] }
  const from = pending.indexOf(last)
  return { matched, beyond: pending.filter((r, i) => i > from && !used.has(r)) }
}

type PendingRow = { track_uri: string; created_at: number }

// 記録では待っているリクエストのうち、実際にまだ待っているものを流れる順に並べる。
// ホストが Spotify アプリでキューから消すと記録だけが残るので、それは数えない
function stillWaiting(pending: PendingRow[], pb: Playback | null): PendingRow[] {
  // キューが分からないとき（1曲リピート中は先が見えない）は、記録のとおりとみなす
  if (!pb?.queue || pb.repeat === 'track') return pending
  const { matched, beyond } = matchQueue(pending, pb.queue, pb.more)
  const found = [...matched.filter((r) => r !== undefined), ...beyond]
  // 入れた直後はキューにまだ出ないことがある
  const recent = pending.filter((r) => !found.includes(r) && Date.now() - r.created_at < 60_000)
  return [...found, ...recent]
}

// 追加は1件ずつ順番に行う。同時に進めると、同じ曲が2回入ったり、Spotify のキューと記録の順番が入れ替わったりする
const TURN_MS = 5000
async function inTurn<T>(env: Env, session: Session, work: () => Promise<T>): Promise<T> {
  let mine = 0
  for (let i = 0; i < 30 && !mine; i++) {
    const now = Date.now()
    // 途中で止まった人の印は、しばらくたてば無視する
    const { meta } = await env.DB.prepare('UPDATE sessions SET adding_at = ? WHERE id = ? AND (adding_at IS NULL OR adding_at < ?)')
      .bind(now, session.id, now - TURN_MS).run()
    if (meta.changes) mine = now
    else await new Promise((r) => setTimeout(r, 150 + i * 20 + Math.random() * 150))
  }
  // 順番が回ってこないときは、追加できないよりはよいので、そのまま進める
  try {
    return await work()
  } finally {
    if (mine) {
      await env.DB.prepare('UPDATE sessions SET adding_at = NULL WHERE id = ? AND adding_at = ?').bind(session.id, mine).run()
    }
  }
}

export type AddResult = { ahead: number; duplicate?: 'playing' | 'waiting' }

export async function addRequest(
  env: Env,
  session: Session,
  input: { uri: string; name: string; artist: string; image: string; nickname: string | null; comment: string | null },
): Promise<AddResult> {
  // 再生状態が取れないときは、追加を止めない
  const pb = await playback(env).catch(() => null)
  // 今流れている曲か、まだ待っているリクエストと同じ曲なら重複。流れ終わった曲は、また追加できる
  if (pb?.isPlaying && pb.current?.uri === input.uri) return { duplicate: 'playing', ahead: 0 }

  const job = inTurn(env, session, async (): Promise<AddResult> => {
    const { results: pending } = await env.DB.prepare(
      'SELECT track_uri, created_at FROM requests WHERE session_id = ? AND played_at IS NULL ORDER BY id',
    ).bind(session.id).all<PendingRow>()
    const waiting = stillWaiting(pending, pb)
    const i = waiting.findIndex((r) => r.track_uri === input.uri)
    if (i >= 0) return { duplicate: 'waiting', ahead: i }

    // キューに入れれば、今の曲の後にリクエスト順で必ず流れる。
    // デフォルト曲（プレイリスト）はホストが選んだ曲だけにするので、リクエストはそこに入れない
    await api(env, 'POST', `/me/player/queue?uri=${encodeURIComponent(input.uri)}`)
    const now = Date.now()
    await env.DB.batch([
      // ホストがキューから消した同じ曲の記録が残っていると、前の人の名前が付いてしまうので片付ける
      env.DB.prepare('UPDATE requests SET played_at = ? WHERE session_id = ? AND track_uri = ? AND played_at IS NULL')
        .bind(now, session.id, input.uri),
      env.DB.prepare(
        `INSERT INTO requests (session_id, track_uri, track_name, artist, image_url, nickname, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(session.id, input.uri, input.name, input.artist, input.image, input.nickname, input.comment, now),
    ])
    invalidatePlayback()
    return { ahead: waiting.length }
  })
  // 追加した人がすぐ画面を閉じても、キューに入れたのに記録だけ無い、ということにならないよう最後まで進める
  waitUntil(job.catch(() => {}))
  return job
}

// ---- ゲスト画面に出す内容 ----

export type NextTrack = Omit<Track, 'durationMs'> & { request: RequestInfo | null }

export type StateView = {
  isPlaying: boolean
  current: (Track & { request: RequestInfo | null }) | null
  next: NextTrack[]
  repeat: Playback['repeat']
  title: string
  notice: string | null
}

// v は内容の印（同じなら画面は描き直さなくてよい）、endsInMs は今の曲が終わるまでの見込み
export type State = { v: string; endsInMs: number | null; view: StateView }

type Built = { v: string; view: StateView }

// 同じ再生状態（数秒の使い回し中）なら、記録の読み書きもやり直さない。
// 画面の更新1回ごとに読んでいると、人数 × 件数で D1 の無料枠（1日500万行）に届いてしまう
let lastView: { sessionId: string; pb: Playback; built: Built } | null = null
const building = new Shared<Built>()

// ゲスト画面に出す形にまとめる（リクエストした人の名前・コメントを曲にくっつける）
export async function stateView(env: Env, session: Session): Promise<State> {
  let pb: Playback
  try {
    pb = await playback(env)
  } catch (e) {
    if (e instanceof SpotifyError && e.reason === 'NOT_CONNECTED') {
      const notice = 'ホストの Spotify 連携が切れています'
      return { ...(await finish({ isPlaying: false, current: null, next: [], repeat: 'off', title: session.title, notice })), endsInMs: null }
    }
    throw e
  }
  let built = lastView?.pb === pb && lastView.sessionId === session.id ? lastView.built : null
  if (!built) {
    built = await building.run(async () => {
      const value = await buildView(env, session, pb)
      lastView = { sessionId: session.id, pb, built: value }
      return value
    }, pb)
  }
  // タイトルはホストが変えたらすぐ出す
  if (built.view.title !== session.title) built = await finish({ ...built.view, title: session.title })
  return { ...built, endsInMs: pb.endsAt === null ? null : Math.max(0, pb.endsAt - Date.now()) }
}

async function finish(view: StateView): Promise<Built> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(view))))
  return { v: [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(''), view }
}

async function buildView(env: Env, session: Session, pb: Playback): Promise<Built> {
  await syncSession(env, session, pb)

  // 過去のリクエストは増え続けるので全部は読まず、待っている分と、今の曲の分だけ読む
  const [waiting, playing] = await env.DB.batch<RequestRow>([
    env.DB.prepare(
      `SELECT track_uri, track_name, artist, image_url, nickname, comment FROM requests
       WHERE session_id = ? AND played_at IS NULL ORDER BY id`,
    ).bind(session.id),
    env.DB.prepare(
      `SELECT r.* FROM sessions s JOIN requests r ON r.id = s.current_request_id WHERE s.id = ? AND r.track_uri = ?`,
    ).bind(session.id, pb.current?.uri ?? ''),
  ])

  const info = (r: RequestRow | undefined): RequestInfo | null => (r ? { nickname: r.nickname, comment: r.comment } : null)

  // Spotify が返した「次の曲」の後ろに、見えている範囲より先のリクエストをつなぐ
  const { matched, beyond } = matchQueue(waiting.results, pb.next.map((t) => t.uri), pb.more && pb.repeat !== 'track')
  let next: NextTrack[] = [
    ...pb.next.map((t, i) => ({ uri: t.uri, name: t.name, artist: t.artist, image: t.image, request: info(matched[i]) })),
    ...beyond.map((r) => ({ uri: r.track_uri, name: r.track_name, artist: r.artist, image: r.image_url ?? '', request: info(r) })),
  ]
  // キューだけ取れなかったときは、一覧を空にせず前のものを出しておく
  if (!pb.queue && pb.deviceId && lastView?.sessionId === session.id && lastView.built.view.current?.uri === pb.current?.uri) {
    next = lastView.built.view.next
  }

  let notice: string | null = null
  if (!pb.deviceId) notice = 'ホストの端末で Spotify が開かれていません'
  // デフォルト曲は曲を直接指定して流すので context が無い。context があるならアルバムなど別のものを流している
  else if (pb.contextUri) notice = 'デフォルト曲以外（アルバムやプレイリスト）を再生中です'

  return finish({
    isPlaying: pb.isPlaying,
    current: pb.current ? { ...pb.current, request: info(playing.results[0]) } : null,
    next,
    repeat: pb.repeat,
    title: session.title,
    notice,
  })
}

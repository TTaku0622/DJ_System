// 再生状態の取得・リクエスト追加・デフォルト曲の自動再開
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
  created_at: number
  ended_at: number | null
}

export type Playback = {
  isPlaying: boolean
  progressMs: number
  current: Track | null
  next: Track[]
  queue: string[] | null // Spotify が返したままの並び（取れなかったときは null）
  deviceId: string | null
  contextUri: string | null
  shuffle: boolean
  repeat: 'off' | 'context' | 'track'
}

type RequestRow = {
  track_uri: string
  nickname: string | null
  comment: string | null
}

export type RequestInfo = { nickname: string | null; comment: string | null }

// ゲストが何人いても Spotify への問い合わせが増えないよう、数秒だけ使い回す
const CACHE_MS = 4000
let cache: { at: number; value: Playback } | null = null

export function invalidatePlayback() {
  cache = null
}

export async function playback(env: Env): Promise<Playback> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const [state, queue] = await Promise.all([
    api(env, 'GET', '/me/player'),
    // 再生端末がないときは失敗するので空扱い
    api(env, 'GET', '/me/player/queue').catch(() => null),
  ])
  const current = toTrack(state?.item)
  const repeat: Playback['repeat'] = state?.repeat_state === 'context' || state?.repeat_state === 'track' ? state.repeat_state : 'off'
  const upcoming: Track[] = (queue?.queue ?? []).map(toTrack).filter((t: Track | null): t is Track => t !== null)
  let next = upcoming
  if (repeat !== 'off') {
    // ループ中の Spotify は同じ曲をくり返し並べて返すので、1曲1回だけにする。1曲リピートなら今の曲は並べない
    const seen = new Set(repeat === 'track' && current ? [current.uri] : [])
    next = next.filter((t) => !seen.has(t.uri) && seen.add(t.uri))
  }
  const value: Playback = {
    isPlaying: Boolean(state?.is_playing),
    progressMs: state?.progress_ms ?? 0,
    current,
    next,
    // 1曲リピート中は今の曲も「次」に並ぶので除く
    queue: queue ? upcoming.map((t) => t.uri).filter((uri) => repeat !== 'track' || uri !== current?.uri) : null,
    deviceId: state?.device?.id ?? null,
    contextUri: state?.context?.uri ?? null,
    shuffle: Boolean(state?.shuffle_state),
    repeat,
  }
  cache = { at: Date.now(), value }
  return value
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
  const { meta } = await env.DB.prepare('UPDATE sessions SET last_track_uri = ? WHERE id = ? AND last_track_uri IS ?')
    .bind(uri, session.id, session.last_track_uri).run()
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

export type AddResult = { ahead: number; duplicate?: 'playing' | 'waiting' }

// 今流れている曲か、まだ待っているリクエストと同じ曲なら重複。流れ終わった曲は、また追加できる
async function findDuplicate(env: Env, session: Session, uri: string): Promise<AddResult | null> {
  // 再生状態が取れないときは、追加を止めない
  const pb = await playback(env).catch(() => null)
  if (pb?.isPlaying && pb.current?.uri === uri) return { duplicate: 'playing', ahead: 0 }

  const { results: pending } = await env.DB.prepare(
    'SELECT track_uri, created_at FROM requests WHERE session_id = ? AND played_at IS NULL ORDER BY id',
  ).bind(session.id).all<{ track_uri: string; created_at: number }>()
  const i = pending.findIndex((r) => r.track_uri === uri)
  if (i < 0) return null
  // ホストが Spotify のキューを空にすると、記録だけが残る。その曲までのリクエストが1曲もキューに無ければ、
  // もう待っていないとみなして追加できるようにする（入れた直後はキューにまだ出ないことがあるので除く）
  const queue = pb?.queue
  const waiting =
    !queue ||
    pending.slice(0, i + 1).some((r) => queue.includes(r.track_uri)) ||
    Date.now() - pending[i].created_at < 60_000
  return waiting ? { duplicate: 'waiting', ahead: i } : null
}

export async function addRequest(
  env: Env,
  session: Session,
  input: { uri: string; name: string; artist: string; image: string; nickname: string | null; comment: string | null },
): Promise<AddResult> {
  const duplicate = await findDuplicate(env, session, input.uri)
  if (duplicate) return duplicate

  // キューに入れれば、今の曲の後にリクエスト順で必ず流れる。
  // デフォルト曲（プレイリスト）はホストが選んだ曲だけにするので、リクエストはそこに入れない
  await api(env, 'POST', `/me/player/queue?uri=${encodeURIComponent(input.uri)}`)

  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ? AND played_at IS NULL')
    .bind(session.id).first<{ n: number }>()
  await env.DB.prepare(
    `INSERT INTO requests (session_id, track_uri, track_name, artist, image_url, nickname, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(session.id, input.uri, input.name, input.artist, input.image, input.nickname, input.comment, Date.now()).run()
  invalidatePlayback()
  return { ahead: pending?.n ?? 0 }
}

export type StateView = {
  isPlaying: boolean
  current: (Track & { request: RequestInfo | null }) | null
  next: (Track & { request: RequestInfo | null })[]
  repeat: Playback['repeat']
  title: string
  notice: string | null
}

// 同じ再生状態（数秒の使い回し中）なら、記録の読み書きもやり直さない。
// 画面の更新1回ごとに読んでいると、人数 × 件数で D1 の無料枠（1日500万行）に届いてしまう
let lastView: { sessionId: string; pb: Playback; value: StateView } | null = null

// ゲスト画面に出す形にまとめる（リクエストした人の名前・コメントを曲にくっつける）
export async function stateView(env: Env, session: Session): Promise<StateView> {
  let pb: Playback
  try {
    pb = await playback(env)
  } catch (e) {
    if (e instanceof SpotifyError && e.reason === 'NOT_CONNECTED') {
      return { isPlaying: false, current: null, next: [], repeat: 'off', title: session.title, notice: 'ホストの Spotify 連携が切れています' }
    }
    throw e
  }
  if (lastView?.pb === pb && lastView.sessionId === session.id) return { ...lastView.value, title: session.title }
  await syncSession(env, session, pb)

  // 過去のリクエストは増え続けるので全部は読まず、待っている分と、今の曲の分だけ読む。
  // いま流れている曲が直近に再生済みになったリクエストなら、その人の名前を出す
  const recent = Date.now() - (pb.current?.durationMs ?? 0) - 60_000
  const [waiting, playing] = await env.DB.batch<RequestRow>([
    env.DB.prepare('SELECT track_uri, nickname, comment FROM requests WHERE session_id = ? AND played_at IS NULL ORDER BY id')
      .bind(session.id),
    env.DB.prepare(
      `SELECT track_uri, nickname, comment FROM requests WHERE session_id = ? AND played_at > ? AND track_uri = ?
       ORDER BY played_at DESC, id DESC LIMIT 1`,
    ).bind(session.id, recent, pb.current?.uri ?? ''),
  ])

  const info = (r: RequestRow | undefined): RequestInfo | null => (r ? { nickname: r.nickname, comment: r.comment } : null)

  const current: StateView['current'] = pb.current ? { ...pb.current, request: info(playing.results[0]) } : null

  const pending = [...waiting.results]
  const next = pb.next.slice(0, 6).map((t) => {
    const i = pending.findIndex((r) => r.track_uri === t.uri)
    const req = i >= 0 ? pending.splice(i, 1)[0] : undefined
    return { ...t, request: info(req) }
  })

  let notice: string | null = null
  if (!pb.deviceId) notice = 'ホストの端末で Spotify が開かれていません'
  // デフォルト曲は曲を直接指定して流すので context が無い。context があるならアルバムなど別のものを流している
  else if (pb.contextUri) notice = 'デフォルト曲以外（アルバムやプレイリスト）を再生中です'

  const value = { isPlaying: pb.isPlaying, current, next, repeat: pb.repeat, title: session.title, notice }
  lastView = { sessionId: session.id, pb, value }
  return value
}

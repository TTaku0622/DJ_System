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
  deviceId: string | null
  contextUri: string | null
  shuffle: boolean
  repeat: 'off' | 'context' | 'track'
}

type RequestRow = {
  id: number
  track_uri: string
  nickname: string | null
  comment: string | null
  played_at: number | null
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
  let next: Track[] = (queue?.queue ?? []).map(toTrack).filter((t: Track | null): t is Track => t !== null)
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

// ポーリングと Cron の両方から呼ぶ。再生済みの記録と、止まったときの自動再開
export async function syncSession(env: Env, session: Session, pb: Playback) {
  const now = Date.now()
  const uri = pb.current?.uri ?? null

  if (uri && uri !== session.last_track_uri) {
    // 曲が変わったら、その曲のリクエスト（とそれより前に入った未再生分）を再生済みにする
    await env.DB.prepare(
      `UPDATE requests SET played_at = ? WHERE session_id = ? AND played_at IS NULL AND id <= (
         SELECT id FROM requests WHERE session_id = ? AND track_uri = ? AND played_at IS NULL ORDER BY id LIMIT 1)`,
    ).bind(now, session.id, session.id, uri).run()
    await env.DB.prepare('UPDATE sessions SET last_track_uri = ? WHERE id = ?').bind(uri, session.id).run()
  }

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

export async function addRequest(
  env: Env,
  session: Session,
  input: { uri: string; name: string; artist: string; image: string; nickname: string | null; comment: string | null },
): Promise<{ ahead: number }> {
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
  await syncSession(env, session, pb)

  const { results } = await env.DB.prepare(
    'SELECT id, track_uri, nickname, comment, played_at FROM requests WHERE session_id = ? ORDER BY id',
  ).bind(session.id).all<RequestRow>()

  const info = (r: RequestRow | undefined): RequestInfo | null => (r ? { nickname: r.nickname, comment: r.comment } : null)

  let current: StateView['current'] = null
  if (pb.current) {
    // いま流れている曲が直近に再生済みになったリクエストなら、その人の名前を出す
    const recent = Date.now() - pb.current.durationMs - 60_000
    const req = [...results].reverse().find((r) => r.track_uri === pb.current!.uri && r.played_at && r.played_at > recent)
    current = { ...pb.current, request: info(req) }
  }

  const pending = results.filter((r) => !r.played_at)
  const next = pb.next.slice(0, 6).map((t) => {
    const i = pending.findIndex((r) => r.track_uri === t.uri)
    const req = i >= 0 ? pending.splice(i, 1)[0] : undefined
    return { ...t, request: info(req) }
  })

  let notice: string | null = null
  if (!pb.deviceId) notice = 'ホストの端末で Spotify が開かれていません'
  // デフォルト曲は曲を直接指定して流すので context が無い。context があるならアルバムなど別のものを流している
  else if (pb.contextUri) notice = 'デフォルト曲以外（アルバムやプレイリスト）を再生中です'

  return { isPlaying: pb.isPlaying, current, next, repeat: pb.repeat, title: session.title, notice }
}

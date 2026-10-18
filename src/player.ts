// 再生状態の取得・リクエスト追加・デフォルト曲の自動再開
import { api, Env, SpotifyError, toTrack, Track } from './spotify'

export type Session = {
  id: string
  playlist_id: string
  playlist_name: string
  shuffle: number
  auto_resume: number
  last_seen_playing_at: number | null
  last_device_id: string | null
  last_track_uri: string | null
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
  const value: Playback = {
    isPlaying: Boolean(state?.is_playing),
    progressMs: state?.progress_ms ?? 0,
    current: toTrack(state?.item),
    next: (queue?.queue ?? []).map(toTrack).filter((t: Track | null): t is Track => t !== null),
    deviceId: state?.device?.id ?? null,
    contextUri: state?.context?.uri ?? null,
    shuffle: Boolean(state?.shuffle_state),
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

function playlistUri(session: Session) {
  return `spotify:playlist:${session.playlist_id}`
}

// デフォルト曲（紐付けプレイリスト）を最初から流す
export async function startPlaylist(env: Env, session: Session, deviceId: string | null) {
  const device = deviceId ? `device_id=${encodeURIComponent(deviceId)}` : ''
  const shuffle = `/me/player/shuffle?state=${session.shuffle ? 'true' : 'false'}${device ? `&${device}` : ''}`
  const shuffleSet = await api(env, 'PUT', shuffle).then(() => true, () => false)
  await api(env, 'PUT', `/me/player/play${device ? `?${device}` : ''}`, { context_uri: playlistUri(session) })
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
    await env.DB.prepare('UPDATE sessions SET last_seen_playing_at = ?, last_device_id = COALESCE(?, last_device_id) WHERE id = ?')
      .bind(now, pb.deviceId, session.id).run()
    return
  }

  if (!session.auto_resume || !session.last_seen_playing_at) return
  // 10分以上止まっているなら、ホストが止めたものとみなして触らない
  if (now - session.last_seen_playing_at > 10 * 60_000) return
  // 曲の途中で止まっている＝一時停止。曲の終わり・曲がない状態＝プレイリストを流し終えた
  const finished = !pb.current || pb.progressMs === 0 || pb.current.durationMs - pb.progressMs < 3000
  if (!finished) return

  await startPlaylist(env, session, pb.deviceId ?? session.last_device_id).catch((e) => console.error('auto resume failed', e))
}

export async function addRequest(
  env: Env,
  session: Session,
  input: { uri: string; name: string; artist: string; image: string; nickname: string | null; comment: string | null },
): Promise<{ ahead: number }> {
  // キューに入れれば、今の曲の後にリクエスト順で必ず流れる（失敗したらプレイリストにも入れない）
  await api(env, 'POST', `/me/player/queue?uri=${encodeURIComponent(input.uri)}`)
  // 記録用にプレイリスト末尾へ。失敗しても再生には影響しないのでログだけ残す
  await api(env, 'POST', `/playlists/${session.playlist_id}/items`, { uris: [input.uri] })
    .catch((e) => console.error('playlist append failed', e))

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
  notice: string | null
}

// ゲスト画面に出す形にまとめる（リクエストした人の名前・コメントを曲にくっつける）
export async function stateView(env: Env, session: Session): Promise<StateView> {
  let pb: Playback
  try {
    pb = await playback(env)
  } catch (e) {
    if (e instanceof SpotifyError && e.reason === 'NOT_CONNECTED') {
      return { isPlaying: false, current: null, next: [], notice: 'ホストの Spotify 連携が切れています' }
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
  else if (pb.contextUri && pb.contextUri !== playlistUri(session)) notice = `「${session.playlist_name}」以外を再生中です`

  return { isPlaying: pb.isPlaying, current, next, notice }
}

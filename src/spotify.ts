// Spotify Web API との通信。トークンはホスト1人分だけを D1 に保存する
import { Shared } from './shared'

export type Env = {
  DB: D1Database
  SPOTIFY_CLIENT_ID: string
  SPOTIFY_CLIENT_SECRET: string
  HOST_KEY: string
  APP_BASE_URL?: string
}

export type Track = {
  uri: string
  name: string
  artist: string
  image: string
  durationMs: number
}

export class SpotifyError extends Error {
  // retryAfter: 混み合い（429）のとき、Spotify が待つように言ってきた秒数
  constructor(public status: number, public reason: string, public retryAfter = 0) {
    super(`Spotify ${status} ${reason}`)
  }
}

const API = 'https://api.spotify.com/v1'
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ')

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  })
  return `https://accounts.spotify.com/authorize?${params}`
}

// 応答が来ないまま待ち続けないよう、8秒で見切る
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })
  } catch (e) {
    throw new SpotifyError(504, e instanceof Error ? e.name : 'UNREACHABLE')
  }
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<Response> {
  return request('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  })
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<void> {
  const res = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  if (!res.ok) throw new SpotifyError(res.status, await res.text())
  const json = await res.json<{ access_token: string; refresh_token: string; expires_in: number }>()
  // User Management に登録されていない人も、ログインと許可まではできてしまう。
  // 保存する前に実際に使えるか確かめ、使えないなら今までの連携を残す
  const check = await request(`${API}/me/player`, { headers: { Authorization: `Bearer ${json.access_token}` } })
  if (!check.ok) throw new SpotifyError(check.status, 'NOT_USABLE')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO host_token (id, access_token, refresh_token, expires_at, authorized_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, authorized_at = excluded.authorized_at`,
  ).bind(json.access_token, json.refresh_token, now + json.expires_in * 1000, now).run()
}

type TokenRow = { access_token: string; refresh_token: string; expires_at: number; authorized_at: number }

export async function tokenStatus(env: Env): Promise<{ connected: boolean; authorizedAt?: number }> {
  const row = await env.DB.prepare('SELECT authorized_at FROM host_token WHERE id = 1').first<{ authorized_at: number }>()
  return row ? { connected: true, authorizedAt: row.authorized_at } : { connected: false }
}

const readToken = (env: Env) => env.DB.prepare('SELECT * FROM host_token WHERE id = 1').first<TokenRow>()

// 期限切れのときに何人も同時に開いていても、更新は1回にまとめる
const refreshing = new Shared<string>()

async function accessToken(env: Env): Promise<string> {
  const row = await readToken(env)
  if (!row) throw new SpotifyError(401, 'NOT_CONNECTED')
  if (row.expires_at > Date.now() + 60_000) return row.access_token
  return refreshing.run(() => refreshToken(env, row))
}

async function refreshToken(env: Env, row: TokenRow): Promise<string> {
  const res = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: row.refresh_token })
  if (!res.ok) {
    const err = await res.json<{ error?: string }>().catch(() => ({ error: undefined }))
    if (err.error === 'invalid_grant') {
      // Cron など別の処理が先に更新して鍵が入れ替わっただけなら、連携は切らずに新しい鍵を使う
      const latest = await readToken(env)
      if (latest && latest.refresh_token !== row.refresh_token && latest.expires_at > Date.now() + 60_000) {
        return latest.access_token
      }
      // 本当に失効した（初回認可から6か月）→ 再連携してもらう。その間に連携し直されていたら消さない
      await env.DB.prepare('DELETE FROM host_token WHERE id = 1 AND refresh_token = ?').bind(row.refresh_token).run()
      throw new SpotifyError(401, 'NOT_CONNECTED')
    }
    throw new SpotifyError(res.status, err.error ?? 'token refresh failed')
  }
  const json = await res.json<{ access_token: string; refresh_token?: string; expires_in: number }>()
  console.log('spotify token refreshed', { rotated: Boolean(json.refresh_token && json.refresh_token !== row.refresh_token) })
  // 更新中に連携し直されていたら、新しい連携を古い鍵で上書きしない
  await env.DB.prepare('UPDATE host_token SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1 AND refresh_token = ?')
    .bind(json.access_token, json.refresh_token ?? row.refresh_token, Date.now() + json.expires_in * 1000, row.refresh_token)
    .run()
  return json.access_token
}

export async function api<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T | null> {
  const token = await accessToken(env)
  const res = await request(API + path, {
    method,
    // ja を付けると曲名・アーティスト名が日本語表記で返る（付けないと「Kenshi Yonezu」など）
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Language': 'ja' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let reason = ''
    try {
      const json = await res.json<{ error?: { reason?: string; message?: string } }>()
      reason = json.error?.reason ?? json.error?.message ?? ''
    } catch {}
    throw new SpotifyError(res.status, reason, Number(res.headers.get('retry-after')) || 0)
  }
  // 再生操作系は本文が空か、JSON でない文字列のことがある（キュー追加は ID のような文字列が返る）
  const text = await res.text()
  try {
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

export function toTrack(item: any): Track | null {
  if (!item || item.type !== 'track') return null
  const images: { url: string }[] = item.album?.images ?? []
  return {
    uri: item.uri,
    name: item.name,
    artist: (item.artists ?? []).map((a: { name: string }) => a.name).join(', '),
    image: (images[1] ?? images[0])?.url ?? '',
    durationMs: item.duration_ms ?? 0,
  }
}

export async function searchTracks(env: Env, q: string): Promise<Track[]> {
  // 2026-02 の変更で limit の上限は10。market=from_token は user-read-private の許可が要る（無いと 403）ので日本に固定する
  const params = new URLSearchParams({ q, type: 'track', limit: '10', market: 'JP' })
  const json = await api(env, 'GET', `/search?${params}`)
  return (json?.tracks?.items ?? []).map(toTrack).filter((t: Track | null): t is Track => t !== null)
}

export type Playlist = { id: string; name: string; image: string; total: number }

// 中身を読めるのは自分が所有者か共同編集者のプレイリストだけなので、それ以外は除く
export async function myPlaylists(env: Env): Promise<Playlist[]> {
  const me = await api<{ id: string }>(env, 'GET', '/me')
  const json = await api(env, 'GET', '/me/playlists?limit=50')
  return (json?.items ?? [])
    .filter((p: any) => p && (p.owner?.id === me?.id || p.collaborative))
    .map((p: any) => ({
      id: p.id,
      name: p.name,
      image: p.images?.at(-1)?.url ?? '',
      total: p.items?.total ?? p.tracks?.total ?? 0,
    }))
}

// プレイリストの中身。2026-02 の変更で1回50件まで、各要素の曲は item（旧 track）に入る
export async function playlistTracks(env: Env, playlistId: string, max = 200): Promise<Track[]> {
  const tracks: Track[] = []
  for (let offset = 0; offset < max; offset += 50) {
    const json = await api(env, 'GET', `/playlists/${playlistId}/items?limit=50&offset=${offset}&market=JP`)
    for (const it of json?.items ?? []) {
      const t = toTrack(it?.item ?? it?.track)
      if (t) tracks.push(t)
    }
    if (!json?.next) break
  }
  return tracks
}

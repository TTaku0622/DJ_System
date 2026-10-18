// Spotify Web API との通信。トークンはホスト1人分だけを D1 に保存する
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
  constructor(public status: number, public reason: string) {
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

async function tokenRequest(env: Env, body: Record<string, string>): Promise<Response> {
  return fetch('https://accounts.spotify.com/api/token', {
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

async function accessToken(env: Env): Promise<string> {
  const row = await env.DB.prepare('SELECT * FROM host_token WHERE id = 1').first<TokenRow>()
  if (!row) throw new SpotifyError(401, 'NOT_CONNECTED')
  if (row.expires_at > Date.now() + 60_000) return row.access_token

  const res = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: row.refresh_token })
  if (!res.ok) {
    const err = await res.json<{ error?: string }>().catch(() => ({ error: undefined }))
    // リフレッシュトークンは初回認可から6か月で失効する → 再連携してもらう
    if (err.error === 'invalid_grant') {
      await env.DB.prepare('DELETE FROM host_token WHERE id = 1').run()
      throw new SpotifyError(401, 'NOT_CONNECTED')
    }
    throw new SpotifyError(res.status, err.error ?? 'token refresh failed')
  }
  const json = await res.json<{ access_token: string; refresh_token?: string; expires_in: number }>()
  await env.DB.prepare('UPDATE host_token SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1')
    .bind(json.access_token, json.refresh_token ?? row.refresh_token, Date.now() + json.expires_in * 1000)
    .run()
  return json.access_token
}

export async function api<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T | null> {
  const token = await accessToken(env)
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let reason = ''
    try {
      const json = await res.json<{ error?: { reason?: string; message?: string } }>()
      reason = json.error?.reason ?? json.error?.message ?? ''
    } catch {}
    throw new SpotifyError(res.status, reason)
  }
  // 再生操作系は 200/204 で本文が空のことがある
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : null
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
  // 2026-02 の変更で limit の上限は10
  const params = new URLSearchParams({ q, type: 'track', limit: '10', market: 'from_token' })
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

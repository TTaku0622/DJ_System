import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import qrcode from 'qrcode-generator'
import { activeSession, addRequest, invalidatePlayback, playback, Session, startPlaylist, stateView, syncSession } from './player'
import { api, authorizeUrl, createPlaylist, Env, exchangeCode, myPlaylists, playlistTracks, searchTracks, SpotifyError, tokenStatus } from './spotify'
import { GuestPage } from './views/Guest'
import { HostPage } from './views/Host'
import { MessagePage } from './views/Layout'

type AppEnv = { Bindings: Env; Variables: { session: Session } }
const app = new Hono<AppEnv>()

const randomId = (bytes: number) => {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// TryCloudflare 経由でも共有 URL が正しくなるよう、転送元のホスト名を優先する
const baseUrl = (c: Context<AppEnv>) => {
  if (c.env.APP_BASE_URL) return c.env.APP_BASE_URL.replace(/\/$/, '')
  const url = new URL(c.req.url)
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:'

const isTrackUri = (v: unknown): v is string => typeof v === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(v)

// ---- ホスト ----

const isHost = async (c: Context<AppEnv>) => (await getSignedCookie(c, c.env.HOST_KEY, 'host')) === '1'

app.get('/', (c) => c.html(<MessagePage title="DJ" message="共有された URL から開いてください。" />))

// ホスト用 URL（/host/enter/<HOST_KEY>）を開くと、このブラウザをホストとして覚える
app.get('/host/enter/:key', async (c) => {
  if (c.req.param('key') !== c.env.HOST_KEY) return notHost(c)
  // Lax: Spotify 連携から戻ったときも送られる。よそのサイトからの POST には付かないのでホスト操作は送らせられない
  await setSignedCookie(c, 'host', '1', c.env.HOST_KEY, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  })
  return c.redirect('/host')
})

const notHost = (c: Context<AppEnv>) =>
  c.html(<MessagePage title="ページが見つかりません" message="ホスト用の URL から開いてください。" />, 404)

app.use('/host/*', async (c, next) => {
  if (c.req.path.startsWith('/host/enter/')) return next()
  if (!(await isHost(c))) return notHost(c)
  return next()
})

// 共有中のセッションがなければ作る。デフォルト曲のプレイリストは前回のものを使い回し、初回だけ新しく作る
async function ensureSession(env: Env): Promise<Session> {
  const active = await activeSession(env)
  if (active) return active
  const last = await env.DB.prepare(
    'SELECT playlist_id, playlist_name, shuffle, auto_resume, title FROM sessions ORDER BY created_at DESC LIMIT 1',
  ).first<Pick<Session, 'playlist_id' | 'playlist_name' | 'shuffle' | 'auto_resume' | 'title'>>()
  // Spotify の ID は英数字22文字。テスト用の仮の ID などは使わない
  const reuse = last && /^[A-Za-z0-9]{22}$/.test(last.playlist_id)
  const playlist = reuse
    ? { id: last.playlist_id, name: last.playlist_name }
    : await createPlaylist(env, 'DJ System のデフォルト曲')
  const id = randomId(16)
  await env.DB.prepare(
    'INSERT INTO sessions (id, playlist_id, playlist_name, shuffle, auto_resume, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, playlist.id, playlist.name, reuse ? last.shuffle : 0, reuse ? last.auto_resume : 1, last?.title ?? '', Date.now()).run()
  return (await activeSession(env, id))!
}

app.get('/host', async (c) => {
  const status = await tokenStatus(c.env)
  let message = c.req.query('msg') ?? null
  let session: Session | null = null
  if (status.connected) {
    session = await ensureSession(c.env).catch((e) => {
      message = `準備できませんでした（${e.message}）`
      return null
    })
  }
  let shareUrl: string | null = null
  let qrSvg: string | null = null
  if (session) {
    shareUrl = `${baseUrl(c)}/s/${session.id}`
    const qr = qrcode(0, 'M')
    qr.addData(shareUrl)
    qr.make()
    qrSvg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true })
  }
  const latest = await tokenStatus(c.env) // 準備中に連携切れが分かった場合に反映
  return c.html(
    <HostPage
      connected={latest.connected}
      authorizedAt={latest.authorizedAt}
      session={session}
      shareUrl={shareUrl}
      qrSvg={qrSvg}
      message={message}
    />,
  )
})

app.get('/host/spotify', (c) => {
  const state = randomId(16)
  // Spotify からの戻りはサイトをまたぐ遷移なので Lax にする
  setCookie(c, 'oauth_state', state, { httpOnly: true, sameSite: 'Lax', secure: isHttps(c), path: '/', maxAge: 600 })
  return c.redirect(authorizeUrl(c.env, `${new URL(c.req.url).origin}/callback`, state))
})

app.get('/callback', async (c) => {
  const state = getCookie(c, 'oauth_state')
  deleteCookie(c, 'oauth_state', { path: '/' })
  const code = c.req.query('code')
  if (!state || state !== c.req.query('state') || !code) {
    return c.html(<MessagePage title="連携できませんでした" message="もう一度ホスト画面からやり直してください。" />, 400)
  }
  await exchangeCode(c.env, code, `${new URL(c.req.url).origin}/callback`)
  return c.redirect('/host?msg=' + encodeURIComponent('Spotify と連携しました'))
})

app.post('/host/session/play', async (c) => {
  const session = await activeSession(c.env)
  if (!session) return c.redirect('/host')
  let msg = 'デフォルト曲を流しました'
  try {
    invalidatePlayback()
    const pb = await playback(c.env)
    await startPlaylist(c.env, session, pb.deviceId ?? session.last_device_id)
  } catch {
    const empty = (await playlistTracks(c.env, session.playlist_id, 1).catch(() => [])).length === 0
    msg = empty
      ? 'デフォルト曲がまだありません。曲を追加してから押してください'
      : '再生できませんでした。Spotify アプリを開いてどれか1曲流してから、もう一度押してください'
  }
  return c.redirect('/host?msg=' + encodeURIComponent(msg))
})

app.post('/host/session/auto-resume', async (c) => {
  const form = await c.req.formData()
  await c.env.DB.prepare('UPDATE sessions SET auto_resume = ? WHERE ended_at IS NULL')
    .bind(form.get('value') === '1' ? 1 : 0).run()
  return c.redirect('/host')
})

app.post('/host/session/shuffle', async (c) => {
  const form = await c.req.formData()
  const on = form.get('value') === '1'
  await c.env.DB.prepare('UPDATE sessions SET shuffle = ? WHERE ended_at IS NULL').bind(on ? 1 : 0).run()
  // 再生中ならすぐ反映する。端末がなければ次に流すときに反映される
  await api(c.env, 'PUT', `/me/player/shuffle?state=${on}`).catch(() => {})
  invalidatePlayback()
  return c.redirect('/host')
})

app.post('/host/session/title', async (c) => {
  const form = await c.req.formData()
  const title = String(form.get('title') ?? '').trim().slice(0, 30)
  await c.env.DB.prepare('UPDATE sessions SET title = ? WHERE ended_at IS NULL').bind(title).run()
  return c.redirect('/host?msg=' + encodeURIComponent(title ? `タイトルを「${title}」にしました` : 'タイトルを消しました'))
})

// 今の URL を無効にして新しい URL にする（デフォルト曲はそのまま）
app.post('/host/session/renew', async (c) => {
  await c.env.DB.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL').bind(Date.now()).run()
  return c.redirect('/host?msg=' + encodeURIComponent('新しい URL にしました。前の URL は使えません'))
})

// ---- ホスト: デフォルト曲（紐付けプレイリストの中身）の編集 ----

app.use('/host/api/*', async (c, next) => {
  // JSON 以外は受け付けない（よそのサイトのフォームから勝手に書き換えさせないため）
  if (c.req.method === 'POST' && !c.req.header('content-type')?.startsWith('application/json')) {
    return c.json({ error: 'bad request' }, 400)
  }
  const session = await activeSession(c.env)
  if (!session) return c.json({ error: 'セッションがありません' }, 404)
  c.set('session', session)
  return next()
})

app.get('/host/api/default', async (c) => c.json({ tracks: await playlistTracks(c.env, c.get('session').playlist_id) }))

app.get('/host/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 100)
  if (!q) return c.json({ tracks: [] })
  return c.json({ tracks: await searchTracks(c.env, q) })
})

app.post('/host/api/default', async (c) => {
  const body = await c.req.json<{ uri?: unknown }>().catch(() => ({}) as { uri?: unknown })
  if (!isTrackUri(body.uri)) return c.json({ error: 'bad track' }, 400)
  await api(c.env, 'POST', `/playlists/${c.get('session').playlist_id}/items`, { uris: [body.uri] })
  return c.json({ ok: true })
})

// まとめて入れる元のプレイリスト（デフォルト曲そのものは除く）
app.get('/host/api/playlists', async (c) => {
  const playlists = await myPlaylists(c.env)
  return c.json({ playlists: playlists.filter((p) => p.id !== c.get('session').playlist_id) })
})

// 選んだプレイリストの曲を、デフォルト曲の末尾にまとめて入れる。すでに入っている曲は飛ばす
app.post('/host/api/default/import', async (c) => {
  const body = await c.req.json<{ playlistId?: unknown }>().catch(() => ({}) as { playlistId?: unknown })
  const from = body.playlistId
  if (typeof from !== 'string' || !/^[A-Za-z0-9]{22}$/.test(from)) return c.json({ error: 'bad playlist' }, 400)
  const target = c.get('session').playlist_id
  const [source, current] = await Promise.all([playlistTracks(c.env, from, 500), playlistTracks(c.env, target, 500)])
  const have = new Set(current.map((t) => t.uri))
  // ローカルファイルの曲（spotify:local:...）は他のプレイリストに入れられないので除く
  const unique = [...new Set(source.map((t) => t.uri))].filter((u) => isTrackUri(u))
  const uris = unique.filter((u) => !have.has(u))
  // 1回に入れられるのは100曲まで
  for (let i = 0; i < uris.length; i += 100) {
    await api(c.env, 'POST', `/playlists/${target}/items`, { uris: uris.slice(i, i + 100) })
  }
  return c.json({ added: uris.length, skipped: unique.length - uris.length })
})

app.post('/host/api/default/remove', async (c) => {
  const body = await c.req.json<{ uri?: unknown }>().catch(() => ({}) as { uri?: unknown })
  if (!isTrackUri(body.uri)) return c.json({ error: 'bad track' }, 400)
  // 位置は指定できないので、同じ曲が複数入っているとすべて外れる
  await api(c.env, 'DELETE', `/playlists/${c.get('session').playlist_id}/items`, { items: [{ uri: body.uri }] })
  return c.json({ ok: true })
})

// ---- ゲスト ----

const ended = (c: Context) =>
  c.html(<MessagePage title="このセッションは終了しました" message="ホストから新しい URL をもらってください。" />, 404)

app.get('/s/:id', async (c) => {
  const session = await activeSession(c.env, c.req.param('id'))
  if (!session) return ended(c)
  return c.html(<GuestPage session={session} />)
})

app.use('/api/s/:id/*', async (c, next) => {
  const session = await activeSession(c.env, c.req.param('id'))
  if (!session) return c.json({ error: 'ended' }, 404)
  c.set('session', session)
  return next()
})

app.get('/api/s/:id/state', async (c) => c.json(await stateView(c.env, c.get('session'))))

app.get('/api/s/:id/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 100)
  if (!q) return c.json({ tracks: [] })
  return c.json({ tracks: await searchTracks(c.env, q) })
})

const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

app.post('/api/s/:id/requests', async (c) => {
  // JSON 以外は受け付けない（よそのサイトのフォームから勝手に追加させないため）
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'bad request' }, 400)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  const uri = body.uri
  if (!isTrackUri(uri)) return c.json({ error: 'bad track' }, 400)
  try {
    const result = await addRequest(c.env, c.get('session'), {
      uri,
      name: clean(body.name, 200) ?? '',
      artist: clean(body.artist, 200) ?? '',
      image: clean(body.image, 300) ?? '',
      nickname: clean(body.nickname, 20),
      comment: clean(body.comment, 60),
    })
    return c.json(result)
  } catch (e) {
    if (e instanceof SpotifyError && (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE')) {
      return c.json({ error: '今は追加できません（ホストの Spotify が再生中ではありません）' }, 409)
    }
    throw e
  }
})

app.onError((e, c) => {
  console.error(e)
  if (e instanceof SpotifyError && e.status === 429) return c.json({ error: '混み合っています。少し待ってください' }, 429)
  // ホスト画面には原因が分かるよう Spotify の理由も出す
  if (c.req.path.startsWith('/host/api/') && e instanceof SpotifyError) {
    return c.json({ error: `Spotify でエラーが起きました（${e.status} ${e.reason}）` }, 500)
  }
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/host/api/')) return c.json({ error: 'エラーが起きました' }, 500)
  return c.html(<MessagePage title="エラー" message={e.message} />, 500)
})

export default {
  fetch: app.fetch,
  // ゲストが誰も画面を開いていなくても、止まったデフォルト曲を流し直せるように
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const session = await activeSession(env)
        if (!session || !(await tokenStatus(env)).connected) return
        await syncSession(env, session, await playback(env))
      })().catch((e) => console.error('cron failed', e)),
    )
  },
} satisfies ExportedHandler<Env>

import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import qrcode from 'qrcode-generator'
import { activeSession, addRequest, invalidatePlayback, playback, Session, startPlaylist, stateView, syncSession } from './player'
import { authorizeUrl, Env, exchangeCode, myPlaylists, searchTracks, SpotifyError, tokenStatus } from './spotify'
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

app.get('/host', async (c) => {
  const status = await tokenStatus(c.env)
  const session = await activeSession(c.env)
  let playlists: Awaited<ReturnType<typeof myPlaylists>> = []
  let message = c.req.query('msg') ?? null
  if (status.connected) {
    playlists = await myPlaylists(c.env).catch((e) => {
      message = `プレイリストを取得できませんでした（${e.message}）`
      return []
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
  const latest = await tokenStatus(c.env) // プレイリスト取得中に失効が分かった場合に反映
  return c.html(
    <HostPage
      connected={latest.connected}
      authorizedAt={latest.authorizedAt}
      session={session}
      shareUrl={shareUrl}
      qrSvg={qrSvg}
      playlists={playlists}
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

app.post('/host/session', async (c) => {
  const form = await c.req.formData()
  const [playlistId, playlistName] = String(form.get('playlist') ?? '').split('\t')
  if (!playlistId) return c.redirect('/host')
  const now = Date.now()
  // 同時に有効なのは1つだけ。古い URL は無効になる
  await c.env.DB.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL').bind(now).run()
  const id = randomId(16)
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, playlist_id, playlist_name, shuffle, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, playlistId, playlistName || 'プレイリスト', form.get('shuffle') ? 1 : 0, now).run()

  const session = (await activeSession(c.env, id))!
  let msg = 'セッションを始めました'
  try {
    const pb = await playback(c.env)
    await startPlaylist(c.env, session, pb.deviceId)
  } catch (e) {
    msg = 'セッションを始めました。再生は開始できなかったので、Spotify アプリでどれか1曲流してから「デフォルト曲を最初から流す」を押してください'
  }
  return c.redirect('/host?msg=' + encodeURIComponent(msg))
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
    msg = '再生できませんでした。Spotify アプリを開いてどれか1曲流してから、もう一度押してください'
  }
  return c.redirect('/host?msg=' + encodeURIComponent(msg))
})

app.post('/host/session/auto-resume', async (c) => {
  const form = await c.req.formData()
  await c.env.DB.prepare('UPDATE sessions SET auto_resume = ? WHERE ended_at IS NULL')
    .bind(form.get('value') === '1' ? 1 : 0).run()
  return c.redirect('/host')
})

app.post('/host/session/end', async (c) => {
  await c.env.DB.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL').bind(Date.now()).run()
  return c.redirect('/host?msg=' + encodeURIComponent('セッションを終了しました'))
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
  const uri = String(body.uri ?? '')
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) return c.json({ error: 'bad track' }, 400)
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
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'エラーが起きました' }, 500)
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

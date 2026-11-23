import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import qrcode from 'qrcode-generator'
import { activeSession, addDefaultTracks, addRequest, defaultTracks, invalidatePlayback, playback, Session, startDefaults, stateView, syncSession } from './player'
import { api, authorizeUrl, Env, exchangeCode, myPlaylists, playlistTracks, searchTracks, SpotifyError, toTrack, tokenStatus } from './spotify'
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

// 共有中のセッションがなければ作る。設定（シャッフル・自動再開・タイトル）は前回のものを引き継ぐ
async function ensureSession(env: Env): Promise<Session> {
  const active = await activeSession(env)
  if (active) return active
  const last = await env.DB.prepare('SELECT shuffle, auto_resume, title FROM sessions ORDER BY created_at DESC LIMIT 1')
    .first<Pick<Session, 'shuffle' | 'auto_resume' | 'title'>>()
  const id = randomId(16)
  // playlist_id / playlist_name は以前プレイリストを使っていたころの列。今は使わない
  await env.DB.prepare(
    `INSERT INTO sessions (id, playlist_id, playlist_name, shuffle, auto_resume, title, created_at) VALUES (?, '', '', ?, ?, ?, ?)`,
  ).bind(id, last?.shuffle ?? 0, last?.auto_resume ?? 1, last?.title ?? '', Date.now()).run()
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
  return c.redirect(authorizeUrl(c.env, `${baseUrl(c)}/callback`, state))
})

app.get('/callback', async (c) => {
  // ホスト以外が自分のアカウントの認可コードを持ち込んで、連携を入れ替えられないようにする
  // （host の cookie は Lax なので、Spotify から戻ってきたときも送られる）
  if (!(await isHost(c))) return notHost(c)
  const state = getCookie(c, 'oauth_state')
  deleteCookie(c, 'oauth_state', { path: '/' })
  const code = c.req.query('code')
  if (!state || state !== c.req.query('state') || !code) {
    return c.html(<MessagePage title="連携できませんでした" message="もう一度ホスト画面からやり直してください。" />, 400)
  }
  try {
    // 連携を始めたときと同じ戻り先を渡す（TryCloudflare 経由なら https://…trycloudflare.com/callback）
    await exchangeCode(c.env, code, `${baseUrl(c)}/callback`)
  } catch (e) {
    if (!(e instanceof SpotifyError)) throw e
    console.error('spotify link failed', e)
    const reason = e.status === 403
      ? 'このアカウントは Spotify に断られました。User Management に登録されているか確かめてください'
      : `Spotify でエラーが起きました（${e.status}）。少し待ってもう一度試してください`
    const kept = (await tokenStatus(c.env)).connected ? '。今までの連携はそのままです' : ''
    return c.redirect('/host?msg=' + encodeURIComponent(`連携できませんでした。${reason}${kept}`))
  }
  invalidatePlayback()
  return c.redirect('/host?msg=' + encodeURIComponent('Spotify と連携しました'))
})

app.post('/host/session/play', async (c) => {
  const session = await activeSession(c.env)
  if (!session) return c.redirect('/host')
  let msg = 'デフォルト曲を流しました'
  try {
    invalidatePlayback()
    const pb = await playback(c.env)
    await startDefaults(c.env, session, pb.deviceId ?? session.last_device_id)
  } catch (e) {
    if (e instanceof Error && e.message === 'NO_DEFAULTS') msg = 'デフォルト曲がまだありません。曲を追加してから押してください'
    else if (e instanceof SpotifyError && e.reason === 'NOT_CONNECTED') msg = 'Spotify の連携が切れています。連携し直してください'
    else if (e instanceof SpotifyError && e.status === 429) msg = '混み合っています。少し待ってから、もう一度押してください'
    else msg = '再生できませんでした。Spotify アプリを開いてどれか1曲流してから、もう一度押してください'
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

app.get('/host/api/default', async (c) => c.json({ tracks: await defaultTracks(c.env) }))

app.get('/host/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 100)
  if (!q) return c.json({ tracks: [] })
  return c.json({ tracks: await searchTracks(c.env, q) })
})

app.post('/host/api/default', async (c) => {
  const body = await c.req.json<{ uri?: unknown }>().catch(() => ({}) as { uri?: unknown })
  if (!isTrackUri(body.uri)) return c.json({ error: 'bad track' }, 400)
  // 曲名などは Spotify から取り直す（1曲ずつの取得は 2026-02 以降も使える）
  const track = toTrack(await api(c.env, 'GET', `/tracks/${body.uri.split(':')[2]}?market=JP`))
  if (!track) return c.json({ error: 'bad track' }, 400)
  const added = await addDefaultTracks(c.env, [track])
  return c.json({ added })
})

// まとめて入れる元のプレイリスト（読むだけで、Spotify 側は書き換えない）
app.get('/host/api/playlists', async (c) => c.json({ playlists: await myPlaylists(c.env) }))

// 選んだプレイリストの曲を、デフォルト曲の末尾にまとめて入れる。すでに入っている曲は飛ばす
app.post('/host/api/default/import', async (c) => {
  const body = await c.req.json<{ playlistId?: unknown }>().catch(() => ({}) as { playlistId?: unknown })
  const from = body.playlistId
  if (typeof from !== 'string' || !/^[A-Za-z0-9]{22}$/.test(from)) return c.json({ error: 'bad playlist' }, 400)
  // ローカルファイルの曲（spotify:local:...）は Spotify から流せないので除く
  const source = (await playlistTracks(c.env, from, 500)).filter((t) => isTrackUri(t.uri))
  const unique = [...new Map(source.map((t) => [t.uri, t])).values()]
  const added = await addDefaultTracks(c.env, unique)
  return c.json({ added, skipped: unique.length - added })
})

app.post('/host/api/default/remove', async (c) => {
  const body = await c.req.json<{ id?: unknown }>().catch(() => ({}) as { id?: unknown })
  if (typeof body.id !== 'number') return c.json({ error: 'bad track' }, 400)
  await c.env.DB.prepare('DELETE FROM default_tracks WHERE id = ?').bind(body.id).run()
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

app.get('/api/s/:id/state', async (c) => {
  try {
    return c.json(await stateView(c.env, c.get('session')))
  } catch (e) {
    // 混み合い（429）は onError に任せる
    if (!(e instanceof SpotifyError) || e.status === 429) throw e
    console.error(e)
    return c.json({ error: 'ホストの Spotify につながりません' }, 502)
  }
})

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
  const name = clean(body.name, 200) ?? ''
  try {
    const result = await addRequest(c.env, c.get('session'), {
      uri,
      name,
      artist: clean(body.artist, 200) ?? '',
      image: clean(body.image, 300) ?? '',
      nickname: clean(body.nickname, 20),
      comment: clean(body.comment, 60),
    })
    if (result.duplicate) {
      const when = result.ahead === 0 ? '次に流れます' : `あと${result.ahead}曲のあとに流れます`
      const message = result.duplicate === 'playing' ? 'は今流れています' : `はもう入っています・${when}`
      return c.json({ error: `「${name}」${message}`, duplicate: result.duplicate }, 409)
    }
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
  if (c.req.path.startsWith('/api/') && e instanceof SpotifyError) {
    const error = e.reason === 'NOT_CONNECTED' ? 'ホストの Spotify 連携が切れています' : 'ホストの Spotify につながりません'
    return c.json({ error }, 502)
  }
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

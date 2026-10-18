import type { Child } from 'hono/jsx'
import { raw } from 'hono/html'

export const Layout = (props: { title: string; bodyClass?: string; children: Child }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cut" />
        <meta name="theme-color" content="#0c0c12" />
        {/* 身内用なので検索エンジンに載せない */}
        <meta name="robots" content="noindex, nofollow" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body class={props.bodyClass}>{props.children}</body>
    </html>
  </>
)

export const MessagePage = (props: { title: string; message: string }) => (
  <Layout title={props.title} bodyClass="center">
    <main class="card message">
      <h1>{props.title}</h1>
      <p>{props.message}</p>
    </main>
  </Layout>
)

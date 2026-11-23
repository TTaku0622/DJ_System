import { waitUntil } from 'cloudflare:workers'

const LIMIT_MS = 10_000

// 同じ仕事が同時に来たら1回にまとめて、結果を全員で使う
export class Shared<T> {
  private job: { key: unknown; at: number; promise: Promise<T> } | null = null

  run(work: () => Promise<T>, key?: unknown): Promise<T> {
    if (!this.job || this.job.key !== key || Date.now() - this.job.at > LIMIT_MS) {
      const job = { key, at: Date.now(), promise: work() }
      const clear = () => {
        if (this.job === job) this.job = null
      }
      this.job = job
      // 始めた人が途中で画面を閉じても最後まで進める（止まると、待っている全員が固まる）
      waitUntil(job.promise.then(clear, clear))
    }
    return limit(this.job.promise)
  }

  // 進行中のものは待たずに、次の人からやり直す
  reset() {
    this.job = null
  }
}

// それでも終わらないときは、待ち続けずに見切る
function limit<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT')), LIMIT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

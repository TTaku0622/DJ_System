// ホスト画面: 共有 URL のコピー
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copy)
    try {
      await navigator.clipboard.writeText(input.value)
    } catch {
      input.select()
      document.execCommand('copy')
    }
    button.textContent = 'コピーしました'
    setTimeout(() => (button.textContent = 'コピー'), 1500)
  })
})

// スマホでは共有シート（LINE・AirDrop など）から直接送れるようにする
document.querySelectorAll('[data-share]').forEach((button) => {
  if (!navigator.share) return
  button.hidden = false
  button.addEventListener('click', () => {
    const url = document.getElementById(button.dataset.share).value
    navigator.share({ title: 'DJ', text: 'ここから曲をリクエストできるよ', url }).catch(() => {})
  })
})

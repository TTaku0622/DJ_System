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

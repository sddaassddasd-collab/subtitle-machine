// 請在已登入的控制端 Chrome DevTools Console 貼上這段程式。
// 每秒前進一格；抵達最後一格後回到第一格。
clearInterval(window.subtitlePressureTimer)

window.subtitlePressureTimer = window.setInterval(() => {
  const nextButton = [...document.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === '下一句',
  )

  if (nextButton && !nextButton.disabled) {
    nextButton.click()
    return
  }

  document.querySelector('.script-line')?.click()
}, 1000)

console.info(
  '字幕壓力測試已開始。停止方式：clearInterval(window.subtitlePressureTimer)',
)

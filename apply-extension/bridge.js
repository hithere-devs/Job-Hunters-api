/* Isolated-world bridge. Popup talks here; this talks to MAIN-world page.js. */
(() => {
  function callPage(cmd, args) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random()}`
      const timer = setTimeout(() => {
        window.removeEventListener('apply-pilot-result', onResult)
        resolve({ error: 'timeout' })
      }, 8000)
      function onResult(event) {
        if (event.detail?.id !== id) return
        clearTimeout(timer)
        window.removeEventListener('apply-pilot-result', onResult)
        resolve(event.detail)
      }
      window.addEventListener('apply-pilot-result', onResult)
      window.dispatchEvent(new CustomEvent('apply-pilot-cmd', { detail: { id, cmd, args } }))
    })
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return
    callPage(message.type, message.args).then(sendResponse)
    return true
  })
})()

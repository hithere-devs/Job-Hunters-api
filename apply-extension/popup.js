async function main() {
  const status = document.getElementById('status')
  const fields = document.getElementById('fields')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    status.textContent = 'No active tab'
    return
  }
  chrome.tabs.sendMessage(tab.id, { type: 'snapshot' }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Open an http(s) application page.'
      fields.textContent = chrome.runtime.lastError.message
      return
    }
    if (response?.error) {
      status.textContent = response.error
      return
    }
    const snap = response?.payload
    const list = Array.isArray(snap?.elements) ? snap.elements : []
    const unfilled = list.filter((el) => el.required && !el.filled && el.role !== 'button' && el.role !== 'file')
    status.textContent = list.length
      ? `Apply Pilot · ${list.length} controls · ${unfilled.length} required empty`
      : 'Apply Pilot · no controls'
    fields.textContent = list
      .slice(0, 40)
      .map((el) => `${el.required ? '* ' : '  '}[${el.id}] ${el.label} (${el.role})${el.filled ? ` = ${String(el.value || '').slice(0, 40)}` : ''}`)
      .join('\n')
  })
}

main()

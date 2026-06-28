document.getElementById('openBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) chrome.sidePanel.open({ tabId: tabs[0].id })
  })
  window.close()
})

function steps(s) {
  let n = 0
  if (s.bank_account_id) n++
  if (s.jwt) n++
  if (s.ek) n++
  if (['processing','verified','succeeded'].includes(s.stripe_session_status)) n++
  if (s.discharge_detected) n++
  return n
}

chrome.storage.local.get(['sessions'], r => {
  const sessions = r.sessions || {}
  const list = document.getElementById('list')
  const entries = Object.entries(sessions)
  if (!entries.length) {
    list.innerHTML = '<div class="empty">No data captured yet</div>'
    return
  }
  entries.forEach(([store, sess]) => {
    const n = steps(sess.state)
    const discharged = sess.state.discharge_detected
    const active = sess.state.active_restriction_status === 'ACTIVE'
    const dot = discharged ? '<span class="dot-done">✓</span>' : active ? '<span class="dot-active">●</span>' : '<span>—</span>'
    const div = document.createElement('div')
    div.className = 'store-row'
    div.innerHTML = `<span class="store-name">${store}</span><div class="store-info"><span class="steps-count">${n}/5</span>${dot}</div>`
    list.appendChild(div)
  })
})

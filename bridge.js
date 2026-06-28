// ISOLATED world — bridge between MAIN world and chrome APIs

// ── Load images immediately and inject into MAIN world ────────────────────────
function pushImages(phase) {
  chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2'], r => {
    window.postMessage({
      _idv: 'IDV_SET',
      dlFront: r.dl_front || null,
      dlBack:  r.dl_back  || null,
      selfies: [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean),
      phase:   phase || null
    }, '*')
  })
}

// Inject as early as possible
pushImages('id')

// Re-inject when storage changes (user uploads while page is open)
chrome.storage.onChanged.addListener(changes => {
  if (changes.dl_front || changes.dl_back || changes.selfie_0 || changes.selfie_1 || changes.selfie_2) {
    pushImages()
  }
})

// ── Relay CAPTURE → background ────────────────────────────────────────────────
window.addEventListener('message', ev => {
  if (ev.source !== window) return

  if (ev.data?._idv === 'CAPTURE') {
    const { _idv, ...payload } = ev.data
    chrome.runtime.sendMessage({ type: 'CAPTURE', ...payload }).catch(() => {})
  }

  // MAIN world requesting phase switch
  if (ev.data?._idv === 'IDV_PHASE_REQUEST') {
    pushImages(ev.data.phase || 'selfie')
  }
})

// ── Relay FORCE_VERIFY background → MAIN world ────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FORCE_VERIFY') return

  window.postMessage({ _idv: 'FORCE_VERIFY', riskRestrictionId: msg.riskRestrictionId }, '*')

  const handler = ev => {
    if (ev.source !== window || ev.data?._idv !== 'FORCE_VERIFY_RESULT') return
    window.removeEventListener('message', handler)
    sendResponse(ev.data.result)
  }
  window.addEventListener('message', handler)
  setTimeout(() => {
    window.removeEventListener('message', handler)
    sendResponse({ ok: false, error: 'timeout' })
  }, 15000)
  return true
})

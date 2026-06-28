// ISOLATED world — relays postMessage <-> chrome.runtime

// Send stored images to MAIN world when page loads
function injectImages() {
  chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0'], r => {
    if (r.dl_front || r.dl_back || r.selfie_0) {
      window.postMessage({
        _idv: 'IDV_IMAGES',
        dlFront: r.dl_front || null,
        dlBack:  r.dl_back  || null,
        selfie:  r.selfie_0 || null
      }, '*')
    }
  })
}
injectImages()

// Re-inject if storage changes (user uploads after page load)
chrome.storage.onChanged.addListener(changes => {
  if (changes.dl_front || changes.dl_back || changes.selfie_0) {
    injectImages()
  }
})

window.addEventListener('message', ev => {
  if (ev.source !== window) return

  if (ev.data?._idv === 'CAPTURE') {
    const { _idv, ...payload } = ev.data
    chrome.runtime.sendMessage({ type: 'CAPTURE', ...payload }).catch(() => {})
  }

  // Phase switch request from MAIN world
  if (ev.data?._idv === 'IDV_PHASE_REQUEST') {
    chrome.storage.local.get(['selfie_0'], r => {
      window.postMessage({
        _idv: 'IDV_IMAGES',
        dlFront: null,
        dlBack: null,
        selfie: r.selfie_0 || null
      }, '*')
      window.postMessage({ _idv: 'IDV_PHASE', phase: 'selfie' }, '*')
    })
  }
})

// Forward FORCE_VERIFY from background to patcher (MAIN)
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

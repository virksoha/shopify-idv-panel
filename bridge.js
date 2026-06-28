// ISOLATED world — loads images from storage and injects into MAIN world ASAP

const IDV_DOMAINS = [
  'shopify.com', 'shopifycloud.com', 'stripe.com', 'myshopify.com'
]

const isIDVDomain = IDV_DOMAINS.some(d => location.hostname.includes(d))
if (!isIDVDomain) { /* skip on unrelated pages */ }
else {

// ── Push images to MAIN world via sessionStorage (sync, no timing issue) ──────
function pushToSession(r) {
  try {
    // Resize images before storing to avoid sessionStorage limits
    const keys = ['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2']
    keys.forEach(k => {
      if (r[k]) {
        sessionStorage.setItem('__idv_' + k + '__', r[k])
      }
    })
    sessionStorage.setItem('__idv_ready__', '1')
  } catch(e) {
    // sessionStorage full — use postMessage only
  }
  // Also postMessage for immediate MAIN world pickup
  window.postMessage({
    _idv: 'IDV_SET',
    dlFront:  r.dl_front  || null,
    dlBack:   r.dl_back   || null,
    selfies:  [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean),
    phase:    sessionStorage.getItem('__idv_phase__') || 'id'
  }, '*')
}

// Load immediately at document_start
chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2'], r => {
  pushToSession(r)
})

// Re-push if storage updates
chrome.storage.onChanged.addListener(changes => {
  const relevant = ['dl_front','dl_back','selfie_0','selfie_1','selfie_2']
  if (relevant.some(k => k in changes)) {
    chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2'], r => {
      pushToSession(r)
    })
  }
})

// ── Phase switch request from MAIN world ──────────────────────────────────────
window.addEventListener('message', ev => {
  if (ev.source !== window) return
  const d = ev.data

  if (d?._idv === 'CAPTURE') {
    const { _idv, ...payload } = d
    chrome.runtime.sendMessage({ type: 'CAPTURE', ...payload }).catch(() => {})
  }

  if (d?._idv === 'IDV_PHASE_REQUEST') {
    const phase = d.phase || 'selfie'
    sessionStorage.setItem('__idv_phase__', phase)
    chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2'], r => {
      window.postMessage({
        _idv: 'IDV_SET',
        dlFront:  r.dl_front  || null,
        dlBack:   r.dl_back   || null,
        selfies:  [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean),
        phase
      }, '*')
    })
  }
})

// ── FORCE_VERIFY relay ────────────────────────────────────────────────────────
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

} // end isIDVDomain

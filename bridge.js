// ISOLATED world — loads images and injects into MAIN world ASAP

function ssGet(k)    { try { return sessionStorage.getItem(k) }  catch(_) { return null } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v) }      catch(_) {} }

function pushImages() {
  chrome.storage.local.get(['dl_front','dl_back','selfie_0','selfie_1','selfie_2'], r => {
    const phase = ssGet('__idv_phase__') || 'id'

    // Write to sessionStorage first (sync access in MAIN world)
    const keys = { dl_front: r.dl_front, dl_back: r.dl_back, selfie_0: r.selfie_0, selfie_1: r.selfie_1, selfie_2: r.selfie_2 }
    for (const [k, v] of Object.entries(keys)) {
      if (!v) continue
      ssSet('__idv_' + k + '__', v)
    }

    // postMessage for MAIN world pickup
    window.postMessage({
      _idv: 'IDV_SET',
      dlFront:  r.dl_front  || null,
      dlBack:   r.dl_back   || null,
      selfies:  [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean),
      phase
    }, '*')
  })
}

pushImages()

chrome.storage.onChanged.addListener(changes => {
  const watched = ['dl_front','dl_back','selfie_0','selfie_1','selfie_2']
  if (watched.some(k => k in changes)) pushImages()
})

window.addEventListener('message', ev => {
  if (ev.source !== window) return
  const d = ev.data

  if (d?._idv === 'CAPTURE') {
    const { _idv, ...payload } = d
    chrome.runtime.sendMessage({ type: 'CAPTURE', ...payload }).catch(() => {})
  }

  if (d?._idv === 'IDV_PHASE_REQUEST') {
    const phase = d.phase || 'selfie'
    ssSet('__idv_phase__', phase)
    pushImages()
  }
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FORCE_VERIFY') return
  window.postMessage({ _idv: 'FORCE_VERIFY', riskRestrictionId: msg.riskRestrictionId }, '*')
  const h = ev => {
    if (ev.source !== window || ev.data?._idv !== 'FORCE_VERIFY_RESULT') return
    window.removeEventListener('message', h)
    sendResponse(ev.data.result)
  }
  window.addEventListener('message', h)
  setTimeout(() => { window.removeEventListener('message', h); sendResponse({ ok:false, error:'timeout' }) }, 15000)
  return true
})

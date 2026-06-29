// ISOLATED world — loads images and injects into MAIN world ASAP

function ssGet(k)    { try { return sessionStorage.getItem(k) }  catch(_) { return null } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v) }      catch(_) {} }

function pushImages() {
  chrome.storage.local.get(['dl_front','dl_back','selfie_0','selfie_1','selfie_2'], r => {
    const phase = ssGet('__idv_phase__') || 'id'

    const keys = { dl_front: r.dl_front, dl_back: r.dl_back, selfie_0: r.selfie_0, selfie_1: r.selfie_1, selfie_2: r.selfie_2 }
    for (const [k, v] of Object.entries(keys)) {
      if (!v) continue
      ssSet('__idv_' + k + '__', v)
    }

    window.postMessage({
      _idv:    'IDV_SET',
      dlFront: r.dl_front  || null,
      dlBack:  r.dl_back   || null,
      selfies: [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean),
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

  if (d?._idv === 'POLL_RESULT') {
    // Parse discharge status from poll response
    const bh = d.data?.data?.shopifyPaymentsAccount?.bankAccount
    if (bh?.riskRestrictions !== undefined) {
      const active = bh.riskRestrictions.some(r => r.status === 'ACTIVE')
      const store  = d.store || window.location.pathname.match(/\/store\/([^/?#]+)/)?.[1]
      if (store) {
        chrome.runtime.sendMessage({ type: 'CAPTURE', store, url: 'shopify/graphql', captures: { discharge_detected: !active, _event: active ? 'poll_still_active' : 'discharge_detected', risk_restrictions: bh.riskRestrictions }, timestamp: Date.now() }).catch(() => {})
      }
    }
  }

  if (d?._idv === 'STRIPE_MODAL_DETECTED') {
    chrome.runtime.sendMessage({ type: 'STRIPE_MODAL_DETECTED', store: d.store, href: d.href, reason: d.reason }).catch(() => {})
  }

  if (d?._idv === 'PAGE_CONTEXT') {
    chrome.runtime.sendMessage({ type: 'PAGE_CONTEXT', page: d.page, store: d.store, href: d.href }).catch(() => {})
  }

  if (d?._idv === 'IDV_PHASE_REQUEST') {
    const phase = d.phase || 'selfie'
    ssSet('__idv_phase__', phase)
    pushImages()
  }

  if (d?._idv === 'SUBMIT_CONFIDENCE') {
    chrome.runtime.sendMessage({ type: 'SUBMIT_CONFIDENCE', ready: d.ready, captured: d.captured, taskStates: d.taskStates }).catch(() => {})
  }

  if (d?._idv === 'BACKEND_STATUS_RESULT') {
    const store = window.location.pathname.match(/\/store\/([^/?#]+)/)?.[1] || null
    chrome.runtime.sendMessage({ type: 'BACKEND_STATUS_FROM_PAGE', store, result: d.result }).catch(() => {})
  }

  if (d?._idv === 'IDV_VERIFY_FAILED') {
    chrome.runtime.sendMessage({ type: 'IDV_VERIFY_FAILED', store: d.store, reason: d.reason, href: d.href }).catch(() => {})
  }

  if (d?._idv === 'GQL_CONTEXT') {
    // Store GQL URL + CSRF so background-injected scripts can use them
    chrome.storage.local.set({ __idvGqlUrl: d.url, __idvGqlCsrf: d.csrf }).catch(() => {})
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

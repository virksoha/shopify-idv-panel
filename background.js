// IDV Panel — Background Service Worker v0.6.0

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

// ── Poll state (in-memory, resets on SW restart) ───────────────────────────────
const pollTimers  = {}   // store → intervalId
const pollMeta    = {}   // store → { startedAt, lastAt, count }

// ── Tab tracking ───────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url) return

  const isAdmin  = tab.url.includes('admin.shopify.com')
  const isStripe = tab.url.includes('verify.stripe.com')

  if (isAdmin || isStripe) {
    await chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'sidepanel.html' }).catch(() => {})
  }

  // Auto-submit when Stripe verification page loads
  if (changeInfo.status === 'complete' && isStripe) {
    const store = await getActiveStore()
    if (!store) return
    const session = await getSession(store)
    if (!session?.state?.ek_client_secret) return
    const docs = await chrome.storage.local.get(['dl_front', 'dl_back', 'selfies'])
    if (!docs.dl_front || !docs.dl_back) return
    chrome.scripting.executeScript({
      target: { tabId },
      func: stripeAutoSubmit,
      args: [{ dlFront: docs.dl_front, dlBack: docs.dl_back, selfies: docs.selfies || [] }]
    }).catch(e => console.log('[IDV] inject err:', e))
  }
})

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CAPTURE') {
    handleCapture(msg).then(async (wasNew) => {
      // Notify on key events
      if (msg.captures?._event === 'pgrr_jwt_minted' || msg.captures?._event === 'remediate_risk_restriction') {
        notify('jwt', '🔑 JWT Captured', `Store: ${msg.store} — PGRR challenge token ready`)
      }
      if (msg.captures?.discharge_detected === true) {
        notify('discharge_' + msg.store, '✅ DISCHARGED!', `${msg.store} — Risk restriction cleared!`)
        stopPoll(msg.store)
      }
      sendResponse({ ok: true })
    })
    return true
  }

  if (msg.type === 'GET_SESSION') {
    getSession(msg.store).then(s => sendResponse({ session: s }))
    return true
  }

  if (msg.type === 'GET_ALL_SESSIONS') {
    chrome.storage.local.get(['sessions'], r => sendResponse({ sessions: r.sessions || {} }))
    return true
  }

  if (msg.type === 'CLEAR_SESSION') {
    stopPoll(msg.store)
    chrome.storage.local.get(['sessions'], r => {
      const s = r.sessions || {}
      delete s[msg.store]
      chrome.storage.local.set({ sessions: s })
    })
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'FORCE_VERIFY') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return }
      chrome.tabs.sendMessage(tabId, { type: 'FORCE_VERIFY', riskRestrictionId: msg.riskRestrictionId }, res => {
        const err = chrome.runtime.lastError
        if (err || !res?.ok) {
          // Fallback: try payoutGateRemediate via inject
          injectFallbackPGRR(tabId, msg.riskRestrictionId).then(sendResponse)
        } else {
          sendResponse(res)
        }
      })
    })
    return true
  }

  if (msg.type === 'OPEN_STRIPE') {
    openStripeVerification(msg.clientSecret, msg.store, sendResponse)
    return true
  }

  if (msg.type === 'START_POLL') {
    startPoll(msg.store, msg.restrictionId)
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'STOP_POLL') {
    stopPoll(msg.store)
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'POLL_NOW') {
    triggerPollNow(msg.store, msg.restrictionId).then(sendResponse)
    return true
  }

  if (msg.type === 'GET_POLL_STATE') {
    const meta = pollMeta[msg.store] || null
    const active = !!(pollTimers[msg.store])
    sendResponse({ active, meta })
    return true
  }

  if (msg.type === 'GET_ACTIVE_STORE') {
    getActiveStore().then(store => sendResponse({ store }))
    return true
  }

  if (msg.type === 'STRIPE_SUBMIT_STATUS') {
    // Forward status update from Stripe auto-submit to sidepanel
    broadcastToSidePanel({ type: 'STRIPE_STATUS_UPDATE', status: msg.status, step: msg.step })
    return true
  }

  if (msg.type === 'STRIPE_MODAL_DETECTED') {
    broadcastToSidePanel({ type: 'STRIPE_MODAL_DETECTED', store: msg.store, href: msg.href })
    notify('modal_' + (msg.store || 'x'), '🔔 Verify Identity popup!', `Store ${msg.store || ''} — Click Start on Shopify or use Force Verify`)
    return true
  }
})

// ── Session storage ────────────────────────────────────────────────────────────
async function getSession(store) {
  const r = await chrome.storage.local.get(['sessions'])
  return (r.sessions || {})[store] || null
}

async function getActiveStore() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tabs[0]?.url || ''
  const m = url.match(/\/store\/([^/?#]+)/)
  return m?.[1] || null
}

async function getAdminTab() {
  const tabs = await chrome.tabs.query({ url: 'https://admin.shopify.com/*' })
  return tabs[0] || null
}

async function handleCapture(msg) {
  const { store, captures, timestamp } = msg
  if (!store) return false
  const r = await chrome.storage.local.get(['sessions'])
  const sessions = r.sessions || {}
  const isNew = !sessions[store]
  if (isNew) {
    sessions[store] = { store, created_at: timestamp, events: [], state: {} }
  }
  const session = sessions[store]
  session.events.push({ ...captures, timestamp })
  if (session.events.length > 200) session.events = session.events.slice(-200)
  session.updated_at = timestamp
  Object.assign(session.state, captures)
  await chrome.storage.local.set({ sessions })

  // Auto-start poll when Stripe submit confirmed
  const state = session.state
  if (captures.stripe_session_status && ['processing','verified','succeeded'].includes(captures.stripe_session_status)) {
    if (state.active_restriction_id && !pollTimers[store]) {
      startPoll(store, state.active_restriction_gid || state.active_restriction_id)
      notify('stripe_' + store, '🟣 Stripe Submitted', `${store} — Polling for discharge every 45s`)
    }
  }
  return isNew
}

// ── Poll system ────────────────────────────────────────────────────────────────
function startPoll(store, restrictionId) {
  if (pollTimers[store]) clearInterval(pollTimers[store])
  pollMeta[store] = { startedAt: Date.now(), lastAt: null, count: 0, restrictionId }
  pollTimers[store] = setInterval(() => triggerPollNow(store, restrictionId), 45000)
  broadcastToSidePanel({ type: 'POLL_STATE_CHANGED', store, active: true, meta: pollMeta[store] })
  console.log('[IDV] Poll started for', store)
}

function stopPoll(store) {
  if (pollTimers[store]) { clearInterval(pollTimers[store]); delete pollTimers[store] }
  if (pollMeta[store]) delete pollMeta[store]
  broadcastToSidePanel({ type: 'POLL_STATE_CHANGED', store, active: false })
  console.log('[IDV] Poll stopped for', store)
}

async function triggerPollNow(store, restrictionId) {
  const adminTab = await getAdminTab()
  if (!adminTab) return { ok: false, error: 'No Shopify admin tab open' }

  if (pollMeta[store]) {
    pollMeta[store].lastAt = Date.now()
    pollMeta[store].count++
  }
  broadcastToSidePanel({ type: 'POLL_TICK', store, meta: pollMeta[store] })

  // Inject a GQL poll into the admin tab — patcher will auto-capture the response
  chrome.scripting.executeScript({
    target: { tabId: adminTab.id },
    world: 'MAIN',
    func: (store) => {
      const q = `query IDVPoll{shopifyPaymentsAccount{bankAccount{riskRestrictions{id status}}}}`
      fetch('https://admin.shopify.com/api/shopify/graphql.json', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q })
      }).then(r => r.json()).then(data => {
        // patcher's fetch hook will auto-capture this, but also send explicitly
        window.postMessage({ _idv: 'POLL_RESULT', store, data }, '*')
      }).catch(() => {})
    },
    args: [store]
  }).catch(e => console.log('[IDV] poll inject err:', e))

  return { ok: true }
}

// ── Fallback PGRR (payoutGateRemediate) ───────────────────────────────────────
async function injectFallbackPGRR(tabId, restrictionId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (rid) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content
                  || window.Shopify?.csrfToken || ''
        const mut = `mutation PGRR($id:ID!){payoutGateRemediate(input:{riskRestrictionGid:$id}){challengeToken userErrors{field message}}}`
        try {
          const res = await fetch('https://admin.shopify.com/api/shopify/graphql.json', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
            body: JSON.stringify({ query: mut, variables: { id: rid } })
          })
          const d = await res.json()
          window.postMessage({ _idv: 'CAPTURE', store: window.location.pathname.match(/\/store\/([^/?#]+)/)?.[1], url: 'shopify/graphql', captures: { jwt: d?.data?.payoutGateRemediate?.challengeToken, jwt_type: 'pgrr_fallback', _event: 'pgrr_jwt_minted' }, timestamp: Date.now() }, '*')
          return d?.data?.payoutGateRemediate?.challengeToken ? { ok: true } : { ok: false, error: JSON.stringify(d?.data?.payoutGateRemediate?.userErrors || d?.errors || 'no token') }
        } catch(e) { return { ok: false, error: String(e) } }
      },
      args: [restrictionId]
    })
    return results?.[0]?.result || { ok: false, error: 'inject failed' }
  } catch(e) {
    return { ok: false, error: String(e) }
  }
}

// ── Open Stripe verification ───────────────────────────────────────────────────
async function openStripeVerification(clientSecret, store, sendResponse) {
  if (!clientSecret) { sendResponse({ ok: false, error: 'no client secret' }); return }
  const url = `https://verify.stripe.com/verify/${clientSecret}`
  const tab = await chrome.tabs.create({ url, active: true })
  sendResponse({ ok: true, tabId: tab.id })
}

// ── Chrome notifications ───────────────────────────────────────────────────────
function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjQgNEwzIDIwVjQ0SDQ1VjIwTDI0IDRaIiBmaWxsPSIjMzc0MUZGIi8+PC9zdmc+',
    title,
    message,
    priority: 2
  }).catch(() => {})
}

// ── Broadcast to all sidepanel pages ──────────────────────────────────────────
function broadcastToSidePanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {})
}

// ── Stripe auto-submit (injected into verify.stripe.com) ──────────────────────
function stripeAutoSubmit({ dlFront, dlBack, selfies }) {
  const LOG = s => { console.log('[IDV-Stripe]', s); try { chrome.runtime.sendMessage({ type:'STRIPE_SUBMIT_STATUS', status: s, step: s }) } catch(_){} }

  function b64toFile(b64, name) {
    const arr = b64.split(','), mime = arr[0].match(/:(.*?);/)[1]
    const bstr = atob(arr[1]), n = bstr.length, u8 = new Uint8Array(n)
    for (let i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i)
    return new File([u8], name, { type: mime || 'image/jpeg' })
  }

  function injectFile(input, file) {
    const dt = new DataTransfer(); dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // React synthetic events
    const nativeDescriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    if (nativeDescriptor) {
      const setter = nativeDescriptor.set
      if (setter) { setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })) }
    }
  }

  function findBtn(...texts) {
    const btns = [...document.querySelectorAll('button,[role="button"],[type="submit"]')]
    for (const t of texts) {
      const b = btns.find(el => el.textContent?.toLowerCase().trim().includes(t.toLowerCase()) && !el.disabled)
      if (b) return b
    }
    return null
  }

  function clickBtn(...texts) {
    const b = findBtn(...texts)
    if (b) { b.click(); return true }
    return false
  }

  function findFileInput() {
    // Try specific selectors first, then generic
    return document.querySelector('input[type="file"][accept*="image"]')
        || document.querySelector('input[type="file"]')
  }

  function findDocTypeOption(...keywords) {
    const all = [...document.querySelectorAll('[role="radio"],[role="option"],label,button,[data-testid]')]
    return all.find(el => {
      const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase()
      return keywords.some(k => t.includes(k))
    })
  }

  let step = 'start', attempts = 0, maxAttempts = 150

  function automate() {
    if (++attempts > maxAttempts) { LOG('timeout'); return }

    if (step === 'start') {
      // Look for Driver's License option
      const dlOpt = findDocTypeOption('driver','license','licence','driving')
      if (dlOpt) { dlOpt.click(); step = 'dl_selected'; LOG('DL type selected'); setTimeout(automate, 1800); return }
      // Maybe already on upload page
      if (findFileInput()) { step = 'dl_selected'; automate(); return }
      setTimeout(automate, 700); return
    }

    if (step === 'dl_selected') {
      if (clickBtn('continue','next','upload','select')) { step = 'front_page'; setTimeout(automate, 1800); return }
      if (findFileInput()) { step = 'front_page'; automate(); return }
      setTimeout(automate, 700); return
    }

    if (step === 'front_page') {
      const inp = findFileInput()
      if (inp && dlFront) {
        injectFile(inp, b64toFile(dlFront, 'dl_front.jpg'))
        step = 'front_uploaded'; LOG('DL front injected')
        setTimeout(automate, 2500); return
      }
      setTimeout(automate, 700); return
    }

    if (step === 'front_uploaded') {
      const inp = findFileInput()
      if (inp && dlBack) {
        injectFile(inp, b64toFile(dlBack, 'dl_back.jpg'))
        step = 'back_uploaded'; LOG('DL back injected')
        setTimeout(automate, 2500); return
      }
      clickBtn('continue','next','looks good','upload back')
      setTimeout(automate, 1200); return
    }

    if (step === 'back_uploaded') {
      const inp = findFileInput()
      if (inp && selfies.length > 0) {
        injectFile(inp, b64toFile(selfies[0], 'selfie.jpg'))
        step = 'selfie_uploaded'; LOG('Selfie injected')
        setTimeout(automate, 2500); return
      }
      clickBtn('continue','next','looks good')
      setTimeout(automate, 1200); return
    }

    if (step === 'selfie_uploaded') {
      clickBtn('submit','done','continue','finish','next')
      step = 'submitted'; LOG('Submitted!')
      return
    }

    if (step === 'submitted') {
      LOG('Complete — waiting for Shopify poll')
      return
    }

    setTimeout(automate, 700)
  }

  LOG('Starting in 2s...')
  setTimeout(automate, 2000)
}

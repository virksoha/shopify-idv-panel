// IDV Panel — Background Service Worker v0.9.0

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

  // Auto-submit when Stripe verification page loads — extract secret from URL directly
  if (changeInfo.status === 'complete' && isStripe) {
    const clientSecret = tab.url.match(/verify\.stripe\.com\/verify\/([^?#]+)/)?.[1]
    if (!clientSecret) return

    const docs = await chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2', 'selfies'])
    if (!docs.dl_front || !docs.dl_back) {
      autoStatus(null, 'need_docs', '⚠️ Upload DL front + back in Assets tab!')
      notify('need_docs', '⚠️ Upload DL Images', 'DL front + back needed in Assets tab before Stripe can auto-submit')
      return
    }

    const selfies = (docs.selfies?.length ? docs.selfies : [docs.selfie_0, docs.selfie_1, docs.selfie_2]).filter(Boolean)
    autoStatus(null, 'stripe_submit', '🟣 Stripe page loaded — auto-submitting docs...')

    // Small delay to let Stripe page fully initialize
    await new Promise(r => setTimeout(r, 3000))

    chrome.scripting.executeScript({
      target: { tabId },
      func: stripeAutoSubmit,
      args: [{ dlFront: docs.dl_front, dlBack: docs.dl_back, selfies }]
    }).catch(e => console.log('[IDV] inject err:', e))
  }
})

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CAPTURE') {
    handleCapture(msg).then(async () => {
      const ev  = msg.captures?._event
      const jwt = msg.captures?.jwt

      // Step 2→3: JWT captured → auto-open Stripe
      if ((ev === 'pgrr_jwt_minted' || ev === 'remediate_risk_restriction') && jwt) {
        notify('jwt', '🔑 JWT Captured', `Store: ${msg.store} — Opening Stripe automatically...`)
        autoStatus(msg.store, 'jwt_ok', '🔑 JWT captured! Opening Stripe...')
        await autoOpenStripe(jwt, msg.store)
      }

      // Step 4→5: Stripe submitted → backend check + start discharge poll
      const sStatus = msg.captures?.stripe_session_status
      if (['processing','verified','succeeded'].includes(sStatus) && msg.store) {
        notify('stripe_' + msg.store, '🟣 Stripe Submitted!', `${msg.store} — Checking backend + starting poll...`)
        autoStatus(msg.store, 'stripe_done', '🟣 Stripe submitted! Running backend check...')
        // Run backend check immediately, then start poll
        setTimeout(() => backendVerifyCheck(msg.store), 5000)
        const session = await getSession(msg.store)
        const rid = session?.state?.risk_restriction_id || session?.state?.active_restriction_id
        if (rid && !pollTimers[msg.store]) startPoll(msg.store, rid)
      }

      // Step 5: Discharged (from poll) — confirm with backend check
      if (msg.captures?.discharge_detected === true && msg.captures?._event !== 'backend_verify_check') {
        autoStatus(msg.store, 'discharged', '✅ Poll detected discharge — confirming with backend...')
        // Confirm with authoritative backend check
        const confirmed = await backendVerifyCheck(msg.store)
        if (confirmed?.overallStatus !== 'DISCHARGED') {
          // Poll said discharged but backend still shows active — keep polling
          autoStatus(msg.store, 'stripe_submit', '⚠️ Poll said discharged but backend still active — continuing poll...')
        }
        // backendVerifyCheck handles notification + stopPoll if really discharged
      }
      if (msg.captures?.discharge_detected === true && msg.captures?._event === 'backend_verify_check') {
        notify('discharge_' + msg.store, '✅ CONFIRMED DISCHARGED!', `${msg.store} — Backend verified: restriction cleared!`)
        autoStatus(msg.store, 'discharged', '✅ Backend CONFIRMED: DISCHARGED — store fully active!')
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
    broadcastToSidePanel({ type: 'STRIPE_MODAL_DETECTED', store: msg.store, href: msg.href, reason: msg.reason })
    // Kick off full auto-flow
    autoOrchestrate(msg.store)
    return true
  }

  if (msg.type === 'PAGE_CONTEXT') {
    broadcastToSidePanel({ type: 'PAGE_CONTEXT', page: msg.page, store: msg.store })
    return true
  }

  if (msg.type === 'SUBMIT_CONFIDENCE') {
    broadcastToSidePanel({ type: 'SUBMIT_CONFIDENCE', ready: msg.ready, captured: msg.captured, taskStates: msg.taskStates })
    return true
  }

  if (msg.type === 'AUTO_ORCHESTRATE') {
    autoOrchestrate(msg.store)
    return true
  }

  if (msg.type === 'AUTO_DISCOVER') {
    injectDiscovery(msg.store).then(rid => sendResponse({ restrictionId: rid }))
    return true
  }

  if (msg.type === 'BACKEND_CHECK') {
    backendVerifyCheck(msg.store).then(result => {
      broadcastToSidePanel({ type: 'BACKEND_STATUS', store: msg.store, result })
      sendResponse(result)
    })
    return true
  }

  if (msg.type === 'BACKEND_STATUS_FROM_PAGE') {
    broadcastToSidePanel({ type: 'BACKEND_STATUS', store: msg.store, result: msg.result })
    return true
  }

  if (msg.type === 'IDV_VERIFY_FAILED') {
    notify('idv_fail_' + msg.store, '❌ ID Verification Failed', `Store: ${msg.store} — Couldn't verify ID. Try a different document.`)
    autoStatus(msg.store, 'pgrr_fail', '❌ Couldn\'t verify ID — try a clearer/different document')
    broadcastToSidePanel({ type: 'IDV_VERIFY_FAILED', store: msg.store, reason: msg.reason })
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

  // Normalise restriction IDs — keep all aliases in sync
  const anyRid = captures.active_restriction_id || captures.risk_restriction_id
  if (anyRid) {
    session.state.active_restriction_id  = anyRid
    session.state.risk_restriction_id    = anyRid
  }
  if (captures.active_restriction_gid) session.state.active_restriction_gid = captures.active_restriction_gid

  await chrome.storage.local.set({ sessions })
  broadcastToSidePanel({ type: 'SESSION_UPDATED', store })
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

  // Inject a GQL poll into the admin tab — richer query with restriction details
  chrome.scripting.executeScript({
    target: { tabId: adminTab.id },
    world: 'MAIN',
    func: (store) => {
      const q = `query IDVPoll {
        shopifyPaymentsAccount {
          bankAccount {
            riskRestrictions { id status type reason updatedAt }
          }
          verifications { id status type requirement updatedAt }
        }
      }`
      const gqlUrl = window.__idvGqlUrl || (()=>{ const s=location.pathname.match(/\/store\/([^/?#]+)/)?.[1]; return s?`https://admin.shopify.com/store/${s}/api/shopify/graphql.json`:'https://admin.shopify.com/api/shopify/graphql.json' })()
      const csrf   = window.__idvGqlCsrf || document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
      fetch(gqlUrl, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(csrf ? {'X-CSRF-Token': csrf} : {}) },
        body: JSON.stringify({ query: q })
      }).then(r => r.json()).then(data => {
        window.postMessage({ _idv: 'POLL_RESULT', store, data }, '*')
        // Also extract verifications and send to panel
        const acc  = data?.data?.shopifyPaymentsAccount
        const rrs  = acc?.bankAccount?.riskRestrictions || []
        const vfs  = acc?.verifications || []
        const active = rrs.filter(r => r.status === 'ACTIVE')
        const failed = vfs.filter(v => ['failed','FAILED','rejected','REJECTED'].includes(v.status))
        const passed = vfs.filter(v => ['verified','VERIFIED','approved','APPROVED'].includes(v.status))
        window.postMessage({
          _idv: 'CAPTURE', store, url: 'shopify/graphql',
          captures: {
            discharge_detected: active.length === 0 && rrs.length > 0,
            backend_verifications: vfs,
            backend_failed_count: failed.length,
            backend_passed_count: passed.length,
            backend_issues: failed.map(v => v.requirement || v.type || v.status),
            _event: active.length === 0 && rrs.length > 0 ? 'discharge_detected' : 'poll_still_active'
          },
          timestamp: Date.now()
        }, '*')
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
        // Use GQL URL/CSRF from page's own intercepted calls — most reliable
        const gqlUrl = window.__idvGqlUrl || (()=>{ const s=location.pathname.match(/\/store\/([^/?#]+)/)?.[1]; return s?`https://admin.shopify.com/store/${s}/api/shopify/graphql.json`:'https://admin.shopify.com/api/shopify/graphql.json' })()
        const csrf   = window.__idvGqlCsrf || document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
        const hdrs   = { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }
        const mut1 = `mutation M1($id:ID!){remediateRiskRestriction(input:{riskRestrictionId:$id}){challengeToken userErrors{field message}}}`
        const mut2 = `mutation PGRR($id:ID!){payoutGateRemediate(input:{riskRestrictionGid:$id}){challengeToken userErrors{field message}}}`
        async function tryGql(query) {
          for (const url of [gqlUrl, 'https://admin.shopify.com/api/shopify/graphql.json']) {
            try {
              const res = await fetch(url, { method:'POST', credentials:'include', headers:hdrs, body: JSON.stringify({ query, variables:{ id: rid } }) })
              const ct = res.headers.get('content-type') || ''
              if (!ct.includes('json')) continue
              const d = await res.json()
              if (d?.data) return d
            } catch(_) {}
          }
          return null
        }
        try {
          let d = await tryGql(mut1)
          const tok1 = d?.data?.remediateRiskRestriction?.challengeToken
          const err1 = d?.data?.remediateRiskRestriction?.userErrors || []
          if (!tok1 && err1.length === 0) d = await tryGql(mut2)
          const tok = d?.data?.remediateRiskRestriction?.challengeToken || d?.data?.payoutGateRemediate?.challengeToken
          if (tok) {
            window.postMessage({ _idv:'CAPTURE', store, url:'shopify/graphql', captures:{ jwt:tok, jwt_type:'pgrr_fallback', _event:'pgrr_jwt_minted' }, timestamp:Date.now() }, '*')
            return { ok: true }
          }
          const errs = d?.data?.remediateRiskRestriction?.userErrors || d?.data?.payoutGateRemediate?.userErrors || d?.errors || []
          return { ok: false, error: JSON.stringify(errs) || 'no token' }
        } catch(e) { return { ok: false, error: String(e) } }
      },
      args: [restrictionId]
    })
    return results?.[0]?.result || { ok: false, error: 'inject failed' }
  } catch(e) {
    return { ok: false, error: String(e) }
  }
}

// ── Auto-orchestration ────────────────────────────────────────────────────────
function autoStatus(store, step, msg) {
  broadcastToSidePanel({ type: 'AUTO_STATUS', store, step, msg })
  console.log('[IDV AUTO]', step, msg)
}

async function autoOpenStripe(jwt, store) {
  // Check if a Stripe tab is already open
  const existingStripe = await chrome.tabs.query({ url: 'https://verify.stripe.com/*' })
  if (existingStripe.length > 0) return  // already open, onUpdated will handle it

  const docs = await chrome.storage.local.get(['dl_front', 'dl_back'])
  if (!docs.dl_front || !docs.dl_back) {
    autoStatus(store, 'need_docs', '⚠️ Upload DL front + back in Assets tab to continue!')
    notify('need_docs', '⚠️ Documents Needed', 'Upload DL front + back in Assets tab — flow paused')
    return
  }

  const url = `https://verify.stripe.com/verify/${jwt}`
  await chrome.tabs.create({ url, active: true })
  autoStatus(store, 'stripe_open', '🟣 Stripe tab opened — auto-submitting in 3s...')
}

async function injectDiscovery(store) {
  // Prefer active tab if it's Shopify admin, otherwise any admin tab
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const activeAdmin = activeTabs.find(t => t.url?.includes('admin.shopify.com'))
  // Also search all windows
  const allAdminTabs = await chrome.tabs.query({ url: 'https://admin.shopify.com/*' })
  const adminTab = activeAdmin || allAdminTabs[0]
  if (!adminTab) return null
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: adminTab.id },
      world: 'MAIN',
      func: async () => {
        const q = `query IDVDiscover{shopifyPaymentsAccount{bankAccount{id riskRestrictions{id status type reason}}}}`
        // Use GQL URL/CSRF captured from page's own calls — most reliable
        const gqlUrl = window.__idvGqlUrl || (()=>{ const s=location.pathname.match(/\/store\/([^/?#]+)/)?.[1]; return s?`https://admin.shopify.com/store/${s}/api/shopify/graphql.json`:'https://admin.shopify.com/api/shopify/graphql.json' })()
        const csrf   = window.__idvGqlCsrf || document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
        const hdrs   = { 'Content-Type':'application/json', ...(csrf ? {'X-CSRF-Token':csrf} : {}) }
        let data
        for (const url of [gqlUrl, 'https://admin.shopify.com/api/shopify/graphql.json']) {
          try {
            const res = await fetch(url, { method:'POST', credentials:'include', headers:hdrs, body: JSON.stringify({ query: q }) })
            const ct = res.headers.get('content-type') || ''
            if (!ct.includes('json')) continue
            const d = await res.json()
            if (d?.data) { data = d; break }
          } catch(_) {}
        }
        if (!data) return null
        const ba = data?.data?.shopifyPaymentsAccount?.bankAccount
        const active = ba?.riskRestrictions?.find(r => r.status === 'ACTIVE')
        if (store && ba) {
          window.postMessage({ _idv:'CAPTURE', store, url:'shopify/graphql', captures:{
            bank_account_id: ba.id,
            risk_restriction_id: active?.id,
            active_restriction_id: active?.id ? active.id.match(/\/(\d+)$/)?.[1] : null,
            active_restriction_gid: active?.id,
            risk_restrictions: ba.riskRestrictions,
            _event: 'banking_home_banking'
          }, timestamp: Date.now() }, '*')
        }
        return active?.id || null
      }, args: []
    })
    return results?.[0]?.result || null
  } catch(e) { return null }
}

async function autoOrchestrate(store) {
  if (!store) return
  autoStatus(store, 'start', '🤖 Auto IDV — checking documents...')

  // 1. Check docs first
  const docs = await chrome.storage.local.get(['dl_front', 'dl_back'])
  if (!docs.dl_front || !docs.dl_back) {
    autoStatus(store, 'need_docs', '⚠️ Upload DL front + back in Assets tab first!')
    notify('need_docs', '⚠️ Documents Needed', 'Upload DL front + back in Assets tab — flow paused')
    return
  }

  // 2. UI-driven: tell patcher to click "ID Verification" task on account_review page
  //    Page handles its own auth — no direct GQL injection needed
  const adminTab = await getAdminTab()
  if (!adminTab) {
    autoStatus(store, 'pgrr_wait', '⚠️ Open admin.shopify.com to continue')
    return
  }

  autoStatus(store, 'pgrr', '🖱️ Auto-driving verification UI...')

  chrome.scripting.executeScript({
    target: { tabId: adminTab.id },
    world: 'MAIN',
    func: () => {
      const txt = (document.body?.innerText || '').toLowerCase()
      const path = location.pathname

      // Reset click guards so patcher can fire again
      window._startClicked    = false
      window._lastStartClick  = 0
      window._idvTaskClicked  = false
      window._verifyLinkClicked = false

      // A) "Verify your identity" modal is already open → click Start immediately
      const startBtn = [...document.querySelectorAll('button,[role="button"]')]
        .find(b => /^(start|begin|verify now)$/i.test((b.textContent||'').trim()) && !b.disabled && b.offsetParent)
      if (startBtn) {
        startBtn.click()
        window.postMessage({ _idv: 'UI_ACTION', action: 'start_clicked' }, '*')
        return
      }

      // B) account_review page → click "ID verification" task row
      if (path.includes('account_review') || path.includes('account-review')) {
        const idvRow = [...document.querySelectorAll('a,[role="link"],[role="button"],button,li,div')]
          .find(el => /^id verification/i.test((el.textContent||'').trim()) && el.offsetParent)
        if (idvRow) { idvRow.click(); return }
      }

      // C) balance/payments page → click "verify your identity" link
      const link = [...document.querySelectorAll('a,[role="link"]')]
        .find(el => /verify.*(your.)?identity|identity.*verif/i.test(el.textContent || el.getAttribute('href') || ''))
      if (link) { link.click(); return }

      // D) Flagged store page → fire patcher DOM watchers
      window.postMessage({ _idv: 'AUTO_CLICK_IDV_TASK' }, '*')
    }
  }).catch(() => {})

  autoStatus(store, 'pgrr', '⏳ UI automation running — waiting for JWT...')
}

// ── Backend verification status check ─────────────────────────────────────────
// Queries Shopify GQL directly from admin tab to get full verification state
async function backendVerifyCheck(store) {
  const adminTab = await getAdminTab()
  if (!adminTab) return { ok: false, error: 'No Shopify admin tab open — navigate to admin.shopify.com first' }

  autoStatus(store, 'backend_check', '🔍 Querying Shopify backend for verification status...')

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: adminTab.id },
      world: 'MAIN',
      func: async () => {
        // Use GQL URL/CSRF captured from page's own calls — guaranteed to work
        const gqlUrl = window.__idvGqlUrl || (()=>{ const s=location.pathname.match(/\/store\/([^/?#]+)/)?.[1]; return s?`https://admin.shopify.com/store/${s}/api/shopify/graphql.json`:'https://admin.shopify.com/api/shopify/graphql.json' })()
        const csrf   = window.__idvGqlCsrf || document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
        const hdrs   = { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }
        const store  = location.pathname.match(/\/store\/([^/?#]+)/)?.[1] || null
        const gqlUrls = [gqlUrl, 'https://admin.shopify.com/api/shopify/graphql.json']

        // Deep query: restriction details + verification sessions + identity verification
        const q = `query IDVBackendCheck {
          shopifyPaymentsAccount {
            id
            bankAccount {
              id
              riskRestrictions {
                id
                status
                type
                reason
                createdAt
                updatedAt
              }
            }
            verifications {
              id
              status
              type
              requirement
              updatedAt
            }
          }
          currentAccountUser {
            id
            email
          }
        }`

        try {
          let data
          for (const gqlUrl of gqlUrls) {
            try {
              const res = await fetch(gqlUrl, {
                method: 'POST', credentials: 'include', headers: hdrs,
                body: JSON.stringify({ query: q })
              })
              const ct = res.headers.get('content-type') || ''
              if (!ct.includes('json')) continue
              const d = await res.json()
              if (d?.data) { data = d; break }
            } catch(_) {}
          }
          if (!data) throw new Error('All GQL endpoints returned non-JSON — session may have expired')
          const acc = data?.data?.shopifyPaymentsAccount
          const ba  = acc?.bankAccount

          // Active restrictions
          const activeRestrictions = (ba?.riskRestrictions || []).filter(r => r.status === 'ACTIVE')
          const allRestrictions    = ba?.riskRestrictions || []

          // Verification items
          const verifications = acc?.verifications || []
          const pendingVerifs = verifications.filter(v => v.status !== 'verified' && v.status !== 'VERIFIED')
          const failedVerifs  = verifications.filter(v => ['failed','FAILED','rejected','REJECTED','error','ERROR'].includes(v.status))
          const passedVerifs  = verifications.filter(v => ['verified','VERIFIED','approved','APPROVED','passed','PASSED'].includes(v.status))

          // Determine overall status
          let overallStatus, passPct
          if (activeRestrictions.length === 0 && allRestrictions.length > 0) {
            overallStatus = 'DISCHARGED'; passPct = 100
          } else if (failedVerifs.length > 0) {
            overallStatus = 'FAILED'; passPct = 0
          } else if (activeRestrictions.length > 0 && pendingVerifs.length === 0) {
            overallStatus = 'PENDING_REVIEW'; passPct = 80
          } else if (activeRestrictions.length > 0) {
            overallStatus = 'IN_PROGRESS'; passPct = Math.round((passedVerifs.length / Math.max(verifications.length,1)) * 100)
          } else {
            overallStatus = 'UNKNOWN'; passPct = 0
          }

          // Build issues list
          const issues = []
          for (const r of activeRestrictions) {
            issues.push({ type: 'restriction', id: r.id, reason: r.reason || r.type || 'ACTIVE restriction', status: r.status })
          }
          for (const v of failedVerifs) {
            issues.push({ type: 'verification', id: v.id, reason: `${v.type || 'Verification'} ${v.status}`, requirement: v.requirement })
          }
          for (const v of pendingVerifs) {
            issues.push({ type: 'pending', id: v.id, reason: `${v.type || 'Verification'} pending`, requirement: v.requirement })
          }

          const result = {
            ok: true,
            store,
            overallStatus,
            passPct,
            activeRestrictions,
            allRestrictions,
            verifications,
            pendingVerifs,
            failedVerifs,
            passedVerifs,
            issues,
            raw: data,
            checkedAt: Date.now()
          }

          // Also fire as capture so session gets updated
          if (store) {
            window.postMessage({
              _idv: 'CAPTURE', store, url: 'shopify/graphql',
              captures: {
                discharge_detected: activeRestrictions.length === 0 && allRestrictions.length > 0,
                backend_pass_pct: passPct,
                backend_status: overallStatus,
                _event: 'backend_verify_check'
              },
              timestamp: Date.now()
            }, '*')
          }

          // Also send directly to background for panel update
          window.postMessage({ _idv: 'BACKEND_STATUS_RESULT', result }, '*')
          return result

        } catch(e) {
          // Fallback: simpler query trying all URL options
          try {
            let d2
            for (const gurl2 of [gqlUrl, 'https://admin.shopify.com/api/shopify/graphql.json']) {
              try {
                const r2 = await fetch(gurl2, {
                  method: 'POST', credentials: 'include', headers: hdrs,
                  body: JSON.stringify({ query: `query{shopifyPaymentsAccount{bankAccount{riskRestrictions{id status type reason}}}}` })
                })
                const ct2 = r2.headers.get('content-type') || ''
                if (!ct2.includes('json')) continue
                const dd = await r2.json()
                if (dd?.data) { d2 = dd; break }
              } catch(_) {}
            }
            if (!d2) return { ok: false, error: String(e) }
            const arr = d2?.data?.shopifyPaymentsAccount?.bankAccount?.riskRestrictions || []
            const active = arr.filter(r => r.status === 'ACTIVE')
            return {
              ok: true, overallStatus: active.length === 0 ? 'DISCHARGED' : 'ACTIVE',
              passPct: active.length === 0 ? 100 : 0,
              activeRestrictions: active, allRestrictions: arr,
              verifications: [], issues: active.map(r => ({ type:'restriction', reason: r.reason || r.type || 'active', id: r.id })),
              checkedAt: Date.now(), fallback: true
            }
          } catch(e2) { return { ok: false, error: String(e2) } }
        }
      },
      args: []
    })

    const result = results?.[0]?.result
    if (!result) return { ok: false, error: 'Script injection failed' }

    // Log to session
    if (store && result.ok) {
      await handleCapture({
        store,
        url: 'shopify/graphql',
        captures: {
          backend_status: result.overallStatus,
          backend_pass_pct: result.passPct,
          discharge_detected: result.overallStatus === 'DISCHARGED',
          _event: 'backend_verify_check'
        },
        timestamp: Date.now()
      })
    }

    if (result.overallStatus === 'DISCHARGED') {
      notify('discharged_' + store, '✅ VERIFIED & DISCHARGED!', `${store} — Backend confirms: restriction cleared!`)
      autoStatus(store, 'discharged', '✅ Backend confirms: DISCHARGED — store is active!')
      stopPoll(store)
    } else if (result.overallStatus === 'FAILED') {
      const reasons = result.issues.map(i => i.reason).join(', ')
      notify('failed_' + store, '❌ Verification Failed', `${store} — ${reasons}`)
      autoStatus(store, 'pgrr_fail', `❌ Backend: FAILED — ${reasons}`)
    } else if (result.overallStatus === 'PENDING_REVIEW') {
      autoStatus(store, 'stripe_submit', '⏳ Backend: Under review — polling for discharge...')
      const session = await getSession(store)
      const rid = session?.state?.risk_restriction_id || session?.state?.active_restriction_id
      if (rid && !pollTimers[store]) startPoll(store, rid)
    } else {
      autoStatus(store, 'stripe_submit', `📡 Backend: ${result.overallStatus} — ${result.passPct}% complete`)
    }

    return result

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

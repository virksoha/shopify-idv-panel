// IDV Panel — Background Service Worker

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url) return
  if (tab.url.includes('admin.shopify.com') || tab.url.includes('verify.stripe.com')) {
    await chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'sidepanel.html' }).catch(() => {})
  }

  // When verify.stripe.com fully loads, trigger auto-submit if docs are ready
  if (changeInfo.status === 'complete' && tab.url.includes('verify.stripe.com')) {
    const store = await getActiveStore()
    if (!store) return
    const session = await getSession(store)
    if (!session?.state?.ek_client_secret) return

    const docs = await chrome.storage.local.get(['dl_front', 'dl_back', 'selfies'])
    if (!docs.dl_front || !docs.dl_back) return

    // Inject auto-submit script into Stripe page
    chrome.scripting.executeScript({
      target: { tabId },
      func: stripeAutoSubmit,
      args: [{ dlFront: docs.dl_front, dlBack: docs.dl_back, selfies: docs.selfies || [] }]
    }).catch(e => console.log('inject err:', e))
  }
})

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE') {
    handleCapture(msg).then(() => sendResponse({ ok: true }))
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
    chrome.storage.local.get(['sessions'], r => {
      const s = r.sessions || {}
      delete s[msg.store]
      chrome.storage.local.set({ sessions: s })
    })
    return true
  }
  if (msg.type === 'FORCE_VERIFY') {
    // Forward to the active Shopify tab's bridge
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return }
      chrome.tabs.sendMessage(tabId, { type: 'FORCE_VERIFY', riskRestrictionId: msg.riskRestrictionId }, res => {
        sendResponse(res || { ok: false, error: chrome.runtime.lastError?.message })
      })
    })
    return true
  }
  if (msg.type === 'OPEN_STRIPE') {
    openStripeVerification(msg.clientSecret, msg.store, sendResponse)
    return true
  }
  if (msg.type === 'GET_ACTIVE_STORE') {
    getActiveStore().then(store => sendResponse({ store }))
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

async function handleCapture(msg) {
  const { store, captures, timestamp } = msg
  if (!store) return
  const r = await chrome.storage.local.get(['sessions'])
  const sessions = r.sessions || {}
  if (!sessions[store]) {
    sessions[store] = { store, created_at: timestamp, events: [], state: {} }
  }
  const session = sessions[store]
  session.events.push({ ...captures, timestamp })
  session.updated_at = timestamp
  Object.assign(session.state, captures)
  await chrome.storage.local.set({ sessions })
}

// ── Open Stripe verification ───────────────────────────────────────────────────
async function openStripeVerification(clientSecret, store, sendResponse) {
  if (!clientSecret) { sendResponse({ ok: false, error: 'no client secret' }); return }
  const url = `https://verify.stripe.com/verify/${clientSecret}`
  const tab = await chrome.tabs.create({ url, active: true })
  sendResponse({ ok: true, tabId: tab.id })
}

// ── Stripe auto-submit (injected into verify.stripe.com) ──────────────────────
function stripeAutoSubmit({ dlFront, dlBack, selfies }) {
  console.log('[IDV] Stripe auto-submit starting...')

  function b64toFile(b64, name, type) {
    const arr = b64.split(',')
    const mime = arr[0].match(/:(.*?);/)[1]
    const bstr = atob(arr[1])
    let n = bstr.length
    const u8arr = new Uint8Array(n)
    while (n--) u8arr[n] = bstr.charCodeAt(n)
    return new File([u8arr], name, { type: mime || type || 'image/jpeg' })
  }

  function injectFile(input, file) {
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function clickButton(text) {
    const btns = [...document.querySelectorAll('button, [role="button"]')]
    const btn = btns.find(b => b.textContent?.toLowerCase().includes(text.toLowerCase()))
    if (btn) { btn.click(); return true }
    return false
  }

  function findFileInput() {
    return document.querySelector('input[type="file"]')
  }

  let step = 'start'
  let attempts = 0

  function automate() {
    attempts++
    if (attempts > 120) { console.log('[IDV] timeout'); return }

    const url = window.location.href

    // Step 1: Select document type — Driver's License
    if (step === 'start') {
      const options = [...document.querySelectorAll('[data-testid*="document"], [class*="document-type"], label, [role="radio"], button')]
      const dlOption = options.find(el => {
        const t = el.textContent?.toLowerCase() || ''
        return t.includes("driver") || t.includes("driving") || t.includes("license") || t.includes("licence")
      })
      if (dlOption) {
        dlOption.click()
        step = 'dl_selected'
        console.log('[IDV] Selected DL')
        setTimeout(automate, 1500)
        return
      }
      // Try clicking continue if already on upload step
      const fileInput = findFileInput()
      if (fileInput) { step = 'dl_selected'; automate(); return }
    }

    // Step 2: Upload DL front
    if (step === 'dl_selected') {
      // Try to click "Continue" or "Next" after selecting doc type
      const clicked = clickButton('continue') || clickButton('next') || clickButton('upload')
      if (clicked) { setTimeout(() => { step = 'front_page'; automate() }, 1500); return }
      // Or directly find file input
      const inp = findFileInput()
      if (inp) { step = 'front_page'; automate(); return }
      setTimeout(automate, 800)
      return
    }

    // Step 3: Inject front image
    if (step === 'front_page') {
      const inp = findFileInput()
      if (inp && dlFront) {
        injectFile(inp, b64toFile(dlFront, 'dl_front.jpg', 'image/jpeg'))
        step = 'front_uploaded'
        console.log('[IDV] Front uploaded')
        setTimeout(automate, 2000)
        return
      }
      setTimeout(automate, 800)
      return
    }

    // Step 4: Click continue after front, then upload back
    if (step === 'front_uploaded') {
      const inp = findFileInput()
      if (inp) {
        // New input appeared = back side
        injectFile(inp, b64toFile(dlBack, 'dl_back.jpg', 'image/jpeg'))
        step = 'back_uploaded'
        console.log('[IDV] Back uploaded')
        setTimeout(automate, 2000)
        return
      }
      clickButton('continue') || clickButton('next') || clickButton('looks good')
      setTimeout(automate, 1500)
      return
    }

    // Step 5: Continue after back, inject selfie
    if (step === 'back_uploaded') {
      const inp = findFileInput()
      if (inp && selfies.length > 0) {
        injectFile(inp, b64toFile(selfies[0], 'selfie.jpg', 'image/jpeg'))
        step = 'selfie_uploaded'
        console.log('[IDV] Selfie uploaded')
        setTimeout(automate, 2000)
        return
      }
      clickButton('continue') || clickButton('next') || clickButton('looks good')
      setTimeout(automate, 1500)
      return
    }

    // Step 6: Submit
    if (step === 'selfie_uploaded') {
      clickButton('continue') || clickButton('submit') || clickButton('done') || clickButton('next')
      step = 'submitted'
      console.log('[IDV] Submitted!')
      return
    }

    setTimeout(automate, 800)
  }

  // Wait a bit for page to fully render
  setTimeout(automate, 2000)
}

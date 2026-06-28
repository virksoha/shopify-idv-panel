// IDV Panel — Side Panel Logic

const STEPS_DEF = [
  { id: 1, label: 'Discovery', hint: 'Go to /balance/account — captures restriction ID', done: s => !!s.bank_account_id },
  { id: 2, label: 'PGRR / JWT', hint: 'Click "Verify identity" OR use Force button above', done: s => !!s.jwt },
  { id: 3, label: 'EK (Stripe key)', hint: 'Stripe modal opens automatically', done: s => !!s.ek },
  { id: 4, label: 'Stripe Submit', hint: 'Upload DL + selfie on verify.stripe.com', done: s => ['processing','verified','succeeded'].includes(s.stripe_session_status) },
  { id: 5, label: 'Discharge', hint: 'Restriction becomes INACTIVE', done: s => !!s.discharge_detected },
]

let currentStore = null
let currentSession = null
let copiedKey = null

// ── File storage (base64 in chrome.storage.local) ────────────────────────────
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function setupFileInput(inputId, slotId, previewId, storageKey) {
  const input = document.getElementById(inputId)
  const slot = document.getElementById(slotId)
  const preview = document.getElementById(previewId)
  if (!input) return

  // Load existing
  chrome.storage.local.get([storageKey], r => {
    if (r[storageKey]) {
      preview.src = r[storageKey]
      slot.classList.add('has-file')
      slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
    }
  })

  input.addEventListener('change', async e => {
    const file = e.target.files[0]
    if (!file) return
    const b64 = await fileToB64(file)
    await chrome.storage.local.set({ [storageKey]: b64 })
    preview.src = b64
    slot.classList.add('has-file')
    slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
    updateStripeButton()
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setupFileInput('inputFront', 'slotFront', 'prevFront', 'dl_front')
  setupFileInput('inputBack', 'slotBack', 'prevBack', 'dl_back')
  setupFileInput('inputS0', 'slotS0', 'prevS0', 'selfie_0')
  setupFileInput('inputS1', 'slotS1', 'prevS1', 'selfie_1')
  setupFileInput('inputS2', 'slotS2', 'prevS2', 'selfie_2')

  await detectStore()
  await render()

  // Listen for storage changes (new captures coming in)
  chrome.storage.onChanged.addListener(async changes => {
    if (changes.sessions) {
      const sessions = changes.sessions.newValue || {}
      currentSession = currentStore ? sessions[currentStore] : null
      await render()
    }
  })

  // Listen for tab changes
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
      await detectStore()
      await render()
    }
  })
  chrome.tabs.onActivated.addListener(async () => {
    await detectStore()
    await render()
  })

  // Buttons
  document.getElementById('btnForce').addEventListener('click', doForceVerify)
  document.getElementById('btnStripe').addEventListener('click', doOpenStripe)
  document.getElementById('btnExport').addEventListener('click', doExport)
  document.getElementById('btnClear').addEventListener('click', doClear)

  // Camera switcher
  document.getElementById('camBtnFront').addEventListener('click', () => switchCam('front'))
  document.getElementById('camBtnBack').addEventListener('click', () => switchCam('back'))
  document.getElementById('camBtnSelfie').addEventListener('click', () => switchCam('selfie'))
}

async function detectStore() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tabs[0]?.url || ''
  const m = url.match(/\/store\/([^/?#]+)/)
  currentStore = m?.[1] || null

  const r = await chrome.storage.local.get(['sessions'])
  const sessions = r.sessions || {}
  currentSession = currentStore ? sessions[currentStore] : null
}

// ── Render ────────────────────────────────────────────────────────────────────
async function render() {
  const state = currentSession?.state || {}
  const hasSession = !!currentSession

  // Header
  document.getElementById('hdrStore').textContent = currentStore || 'no store detected'
  document.getElementById('btnExport').style.display = hasSession ? 'inline-block' : 'none'
  document.getElementById('btnClear').style.display = hasSession ? 'inline-block' : 'none'

  // Empty state
  document.getElementById('emptyState').style.display = (!currentStore || !hasSession) && !currentStore ? 'block' : 'none'

  // Status badge
  const badge = document.getElementById('statusBadge')
  const isActive = state.active_restriction_status === 'ACTIVE'
  const isDischarged = !!state.discharge_detected
  if (state.active_restriction_id) {
    badge.className = 'status-badge ' + (isDischarged ? 'discharged' : isActive ? 'active' : '')
    document.getElementById('restrictionId').textContent = state.active_restriction_id
    document.getElementById('restrictionLabel').textContent = isDischarged ? '✓ DISCHARGED' : isActive ? '● ACTIVE' : ''
  } else {
    badge.className = 'status-badge'
  }

  // Force verify button
  const btnForce = document.getElementById('btnForce')
  const showForce = state.active_restriction_id && !state.jwt && !isDischarged
  btnForce.className = 'btn-force' + (showForce ? ' visible' : '')

  // Stripe submit button
  updateStripeButton()

  // Steps
  renderSteps(state)

  // Tokens
  renderTokens(state)
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
    const done = i < currentStep
    const isCurrent = i === currentStep
    const div = document.createElement('div')
    div.className = 'step ' + (done ? 'done' : isCurrent ? 'current' : 'pending')
    div.innerHTML = `
      <div class="step-icon">${done ? '✓' : isCurrent ? '●' : '○'}</div>
      <div class="step-body">
        <div class="step-label">${step.id}. ${step.label}${isCurrent ? ' <span style="color:#1e40af;font-size:10px;font-weight:400">← now</span>' : ''}</div>
        ${isCurrent ? `<div class="step-hint">${step.hint}</div>` : ''}
      </div>
    `
    container.appendChild(div)
  })
}

function renderTokens(state) {
  const rows = [
    { key: 'bankAcctId', val: state.bank_account_id },
    { key: 'principalId', val: state.principal_id },
    { key: 'restrictId', val: state.active_restriction_id },
    { key: 'JWT', val: state.jwt, short: true },
    { key: 'EK', val: state.ek },
    { key: 'clientSecret', val: state.ek_client_secret, short: true },
    { key: 'assessRef', val: state.assessment_ref || state.vhub_assessment_ref },
    { key: 'civaVariant', val: state.civa_variant },
    { key: 'stripeStatus', val: state.stripe_session_status },
  ].filter(r => !!r.val)

  const section = document.getElementById('tokensSection')
  const list = document.getElementById('tokenList')
  section.style.display = rows.length > 0 ? 'block' : 'none'
  list.innerHTML = ''

  rows.forEach(r => {
    const display = r.short && r.val.length > 40 ? r.val.slice(0, 24) + '…' + r.val.slice(-8) : r.val
    const div = document.createElement('div')
    div.className = 'token-row'
    div.innerHTML = `
      <span class="token-key">${r.key}</span>
      <span class="token-val" title="${r.val}">${display}</span>
      <button class="token-copy" data-val="${r.val}" title="Copy">⎘</button>
    `
    list.appendChild(div)
  })

  list.querySelectorAll('.token-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.val).then(() => {
        const orig = btn.textContent
        btn.textContent = '✓'
        btn.style.color = '#22c55e'
        setTimeout(() => { btn.textContent = orig; btn.style.color = '' }, 1500)
      })
    })
  })
}

async function updateStripeButton() {
  const state = currentSession?.state || {}
  const hasEK = !!state.ek_client_secret
  const r = await chrome.storage.local.get(['dl_front', 'dl_back'])
  const hasDocs = !!r.dl_front && !!r.dl_back
  const isDischarged = !!state.discharge_detected
  const btn = document.getElementById('btnStripe')
  if (hasEK && hasDocs && !isDischarged && !state.discharge_detected) {
    btn.className = 'btn-stripe visible'
  } else {
    btn.className = 'btn-stripe'
  }
}

// ── Force verify ──────────────────────────────────────────────────────────────
async function doForceVerify() {
  const state = currentSession?.state || {}
  if (!state.active_restriction_id) return

  const btn = document.getElementById('btnForce')
  const errDiv = document.getElementById('forceError')
  btn.textContent = '⬡ calling verify…'
  btn.className = 'btn-force visible loading'
  errDiv.className = 'force-error'

  chrome.runtime.sendMessage({
    type: 'FORCE_VERIFY',
    riskRestrictionId: state.active_restriction_gid || state.active_restriction_id
  }, res => {
    if (chrome.runtime.lastError || !res?.ok) {
      btn.textContent = '✕ error — retry'
      btn.className = 'btn-force visible error'
      errDiv.textContent = res?.error || chrome.runtime.lastError?.message || 'unknown error'
      errDiv.className = 'force-error visible'
    } else {
      btn.textContent = '✓ JWT captured!'
      btn.className = 'btn-force visible success'
      setTimeout(() => render(), 500)
    }
  })
}

// ── Open Stripe ───────────────────────────────────────────────────────────────
async function doOpenStripe() {
  const state = currentSession?.state || {}
  if (!state.ek_client_secret) return

  // Collect selfies
  const r = await chrome.storage.local.get(['dl_front', 'dl_back', 'selfie_0', 'selfie_1', 'selfie_2'])
  const selfies = [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean)
  await chrome.storage.local.set({ selfies })

  chrome.runtime.sendMessage({
    type: 'OPEN_STRIPE',
    clientSecret: state.ek_client_secret,
    store: currentStore
  }, res => {
    if (!res?.ok) alert('Error: ' + (res?.error || 'unknown'))
  })
}

// ── Export / Clear ────────────────────────────────────────────────────────────
function doExport() {
  if (!currentSession) return
  const blob = new Blob([JSON.stringify(currentSession, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `idv-${currentSession.store}-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function doClear() {
  if (!currentStore) return
  if (!confirm('Clear session for ' + currentStore + '?')) return
  chrome.runtime.sendMessage({ type: 'CLEAR_SESSION', store: currentStore })
  currentSession = null
  render()
}

// ── Camera switcher ──────────────────────────────────────────────────────────
async function switchCam(mode) {
  // Update button active states
  document.getElementById('camBtnFront').className = 'cam-btn' + (mode === 'front' ? ' active' : '')
  document.getElementById('camBtnBack').className = 'cam-btn' + (mode === 'back' ? ' active' : '')
  document.getElementById('camBtnSelfie').className = 'cam-btn' + (mode === 'selfie' ? ' active' : '')

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tabs[0]?.id
  if (!tabId) return

  // Map mode to IDV phase/idStep values
  const phase  = mode === 'selfie' ? 'selfie' : 'id'
  const idStep = mode === 'back' ? 1 : 0

  // Inject a postMessage into the MAIN world via scripting
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (phase, idStep) => {
      window.postMessage({ _idv: 'IDV_SWITCH', phase, idStep }, '*')
    },
    args: [phase, idStep]
  }).catch(() => {})
}

// ── Start ─────────────────────────────────────────────────────────────────────
init()

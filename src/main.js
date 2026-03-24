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
    // Start proactive token refresh cycle
    auth.startRefreshCycle()
    new ThoughtCollector(appEl, () => showAuthView())
}

// When session expires (token can't be refreshed), go back to login
setSessionExpiredHandler(() => {
    showAuthView()
})

function init() {
    if (auth.isAuthed()) {
        showAppView()
    } else {
        showAuthView()
    }
}

init()

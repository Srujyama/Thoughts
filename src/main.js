import './style.css'
import { AuthController } from './auth.js'
import { ThoughtCollector } from './app.js'
import { storage, authAPI } from './api.js'

const appEl = document.querySelector('#app')

function showAuthView() {
    const auth = new AuthController(appEl, () => {
        showAppView()
    })
    auth.render()
}

function showAppView() {
    new ThoughtCollector(appEl, async () => {
        await authAPI.logout()
        showAuthView()
    })
}

function init() {
    const token = storage.getToken()
    const user = storage.getUser()

    if (token && user) {
        showAppView()
    } else {
        showAuthView()
    }
}

init()

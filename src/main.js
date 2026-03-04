import './style.css'
import { AuthController } from './auth.js'
import { ThoughtCollector } from './app.js'
import { auth } from './api.js'

const appEl = document.querySelector('#app')

function showAuthView() {
    const controller = new AuthController(appEl, () => showAppView())
    controller.render()
}

function showAppView() {
    new ThoughtCollector(appEl, () => showAuthView())
}

function init() {
    if (auth.isAuthed()) {
        showAppView()
    } else {
        showAuthView()
    }
}

init()

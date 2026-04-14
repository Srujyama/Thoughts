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
    // Check for docs route
    if (location.hash === '#/docs') {
        showDocs()
        return
    }

    // Fast auth check — just look for token in localStorage (no network call)
    if (auth.isAuthed()) {
        // Show app immediately from local cache, token refresh happens async
        showAppView()
    } else {
        showAuthView()
    }
}

function showDocs() {
    appEl.innerHTML = `
        <div class="docs-page">
            <header class="docs-header">
                <a href="#/" class="docs-back">&larr; back</a>
                <h1>thoughts</h1>
            </header>
            <div class="docs-body">
                <section>
                    <h2>what is this</h2>
                    <p>a writing app. markdown-native, local-first sync, no electron bloat. an obsidian replacement that lives in your browser.</p>
                </section>
                <section>
                    <h2>features</h2>
                    <ul>
                        <li>full markdown with live preview</li>
                        <li>LaTeX math rendering</li>
                        <li>code syntax highlighting</li>
                        <li>mermaid diagrams</li>
                        <li>folder organization</li>
                        <li>wikilinks and backlinks</li>
                        <li>graph view</li>
                        <li>command palette</li>
                        <li>10+ themes</li>
                        <li>daily notes</li>
                        <li>cloud sync</li>
                    </ul>
                </section>
                <section>
                    <h2>keys</h2>
                    <div class="docs-keys">
                        <div><kbd>Ctrl/Cmd + P</kbd> command palette</div>
                        <div><kbd>Ctrl/Cmd + O</kbd> quick switcher</div>
                        <div><kbd>Ctrl/Cmd + S</kbd> save</div>
                        <div><kbd>Ctrl/Cmd + E</kbd> toggle edit/preview</div>
                        <div><kbd>Ctrl/Cmd + B</kbd> bold</div>
                        <div><kbd>Ctrl/Cmd + I</kbd> italic</div>
                        <div><kbd>Ctrl/Cmd + D</kbd> daily note</div>
                    </div>
                </section>
                <section class="docs-footer-section">
                    <p>made by Srujan Yamali &middot; Berkeley, CA &middot; 2026</p>
                </section>
            </div>
        </div>
    `
    document.querySelector('.docs-back').addEventListener('click', (e) => {
        e.preventDefault()
        location.hash = '#/'
        init()
    })
}

// Listen for hash changes (for docs navigation)
window.addEventListener('hashchange', () => {
    if (location.hash === '#/docs') {
        showDocs()
    }
})

// Run init as soon as possible
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
} else {
    init()
}

import './style.css'
import { AuthController } from './auth.js'
import { ThoughtCollector } from './app.js'
import { auth, setSessionExpiredHandler } from './api.js'

const appEl = document.querySelector('#app')

function applySavedTheme() {
    const saved = localStorage.getItem('nc_theme') || 'system'
    if (saved === 'system') {
        const resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'black' : 'white'
        document.documentElement.setAttribute('data-theme', resolved)
    } else {
        const migrations = { light: 'white', dark: 'black', docs: 'white' }
        document.documentElement.setAttribute('data-theme', migrations[saved] || saved)
    }
}

function showAuthView() {
    applySavedTheme()
    const controller = new AuthController(appEl, () => showAppView(), () => showDocs())
    controller.render()
}

function showAppView() {
    // Start proactive token refresh cycle immediately (non-blocking)
    auth.startRefreshCycle()
    new ThoughtCollector(appEl, () => showAuthView())
}

function showDocs() {
    applySavedTheme()
    appEl.innerHTML = `
        <div class="docs-page">
            <header class="docs-header">
                <button class="docs-back" id="docs-back-btn">&larr; back</button>
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
                        <li>obsidian vault import</li>
                    </ul>
                </section>
                <section>
                    <h2>obsidian sync</h2>
                    <p>import your entire obsidian vault in one click. hit "Import vault" on the folders page or open the command palette (<code>Ctrl/Cmd + P</code>) and run "Import Obsidian Vault". pick your vault folder and all your .md files come in, folder structure intact. <code>.obsidian</code> config is skipped automatically.</p>
                    <p style="margin-top: 0.6rem;">for live two-way sync, use the CLI tool:</p>
                    <div class="docs-code">
                        <code>pip install watchdog requests</code>
                        <code>python vault_sync.py --vault ~/my-vault --token YOUR_JWT</code>
                    </div>
                    <p style="margin-top: 0.4rem;">this watches your local vault for changes and syncs both ways every 30 seconds.</p>
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
    document.getElementById('docs-back-btn').addEventListener('click', () => {
        showAuthView()
    })
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

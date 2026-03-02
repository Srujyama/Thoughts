// src/app.js
import { thoughtsAPI, storage } from './api.js'

export class ThoughtCollector {
    constructor(containerEl, onLogout) {
        this.container = containerEl
        this.onLogout = onLogout
        this.thoughts = []
        this.loading = false

        this._renderShell()
        this._bindEvents()
        this.loadThoughts()

        window.addEventListener('auth:expired', () => this.onLogout())
    }

    _renderShell() {
        const user = storage.getUser()
        this.container.innerHTML = `
            <div class="app-shell">
                <header class="app-header">
                    <div class="header-left">
                        <h1 class="glitch-text small" data-text="THOUGHTS.EXE">THOUGHTS.EXE</h1>
                        <span class="user-badge">// ${user?.email || 'UNKNOWN'}</span>
                    </div>
                    <button class="cyber-btn logout-btn" id="logout-btn">
                        <span class="btn-text">JACK OUT</span>
                        <span class="btn-glow"></span>
                    </button>
                </header>

                <main class="app-main">
                    <div class="input-zone">
                        <div class="input-header">// NEW_THOUGHT.LOG</div>
                        <textarea
                            id="thought-input"
                            class="cyber-textarea"
                            placeholder="> type your thought here_"
                            rows="4"
                        ></textarea>
                        <div class="input-actions">
                            <span class="char-count" id="char-count">0 / 5000</span>
                            <button class="cyber-btn compact-btn" id="save-btn">
                                <span class="btn-text">TRANSMIT</span>
                                <span class="btn-glow"></span>
                            </button>
                        </div>
                    </div>

                    <div class="thoughts-feed" id="thoughts-list">
                        <div class="loading-state">
                            <span class="blink">// LOADING NEURAL DATA...</span>
                        </div>
                    </div>
                </main>

                <div class="scanlines"></div>
                <div class="noise-overlay"></div>
            </div>
        `

        this.input = this.container.querySelector('#thought-input')
        this.saveBtn = this.container.querySelector('#save-btn')
        this.listEl = this.container.querySelector('#thoughts-list')
        this.charCountEl = this.container.querySelector('#char-count')
    }

    _bindEvents() {
        this.saveBtn.addEventListener('click', () => this.saveThought())

        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                this.saveThought()
            }
        })

        this.input.addEventListener('input', () => {
            const len = this.input.value.length
            this.charCountEl.textContent = `${len} / 5000`
            this.charCountEl.classList.toggle('near-limit', len > 4500)
        })

        this.container.querySelector('#logout-btn').addEventListener('click', async () => {
            await this.onLogout()
        })
    }

    async loadThoughts() {
        this.loading = true
        try {
            const result = await thoughtsAPI.list()
            this.thoughts = result.thoughts
            this.render()
        } catch (err) {
            this.listEl.innerHTML = `
                <p class="error-state">> ERROR: ${this.escapeHtml(err.message)}</p>
            `
        } finally {
            this.loading = false
        }
    }

    async saveThought() {
        const text = this.input.value.trim()
        if (!text || this.loading) return

        this.saveBtn.disabled = true
        this.saveBtn.querySelector('.btn-text').textContent = 'TRANSMITTING...'

        try {
            const newThought = await thoughtsAPI.create(text)
            this.thoughts.unshift(newThought)
            this.input.value = ''
            this.charCountEl.textContent = '0 / 5000'
            this.render()
        } catch (err) {
            this._showToast(`> TX ERROR: ${err.message}`)
        } finally {
            this.saveBtn.disabled = false
            this.saveBtn.querySelector('.btn-text').textContent = 'TRANSMIT'
        }
    }

    async deleteThought(id) {
        const card = this.container.querySelector(`[data-id="${id}"]`)
        if (card) card.classList.add('deleting')

        try {
            await thoughtsAPI.delete(id)
            this.thoughts = this.thoughts.filter((t) => t.id !== id)
            this.render()
        } catch (err) {
            if (card) card.classList.remove('deleting')
            this._showToast(`> DELETE ERROR: ${err.message}`)
        }
    }

    _showToast(message) {
        const toast = document.createElement('div')
        toast.className = 'cyber-toast'
        toast.textContent = message
        document.body.appendChild(toast)
        setTimeout(() => toast.classList.add('visible'), 10)
        setTimeout(() => {
            toast.classList.remove('visible')
            setTimeout(() => toast.remove(), 300)
        }, 4000)
    }

    formatDate(isoString) {
        const date = new Date(isoString)
        const now = new Date()
        const diffMs = now - date
        const diffMins = Math.floor(diffMs / 60000)
        const diffHours = Math.floor(diffMs / 3600000)
        const diffDays = Math.floor(diffMs / 86400000)

        if (diffMins < 1) return 'just now'
        if (diffMins < 60) return `${diffMins}m ago`
        if (diffHours < 24) return `${diffHours}h ago`
        if (diffDays < 7) return `${diffDays}d ago`

        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        })
    }

    render() {
        if (this.thoughts.length === 0) {
            this.listEl.innerHTML = `
                <div class="empty-state">
                    <p class="blink">> NO THOUGHTS FOUND IN NEURAL DATABASE_</p>
                    <p class="empty-sub">// BEGIN TRANSMITTING ABOVE</p>
                </div>
            `
            return
        }

        this.listEl.innerHTML = this.thoughts
            .map(
                (thought) => `
            <div class="thought-card" data-id="${thought.id}">
                <div class="card-accent"></div>
                <p class="thought-text">${this.escapeHtml(thought.text)}</p>
                <div class="thought-footer">
                    <span class="thought-time">// ${this.formatDate(thought.created_at)}</span>
                    <button class="delete-btn" data-id="${thought.id}" title="Delete thought">[DELETE]</button>
                </div>
            </div>
        `
            )
            .join('')

        this.listEl.querySelectorAll('.delete-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                this.deleteThought(e.target.dataset.id)
            })
        })
    }

    escapeHtml(text) {
        const div = document.createElement('div')
        div.textContent = text
        return div.innerHTML.replace(/\n/g, '<br>')
    }
}

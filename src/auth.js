// src/auth.js
import { auth } from './api.js'

export class AuthController {
    constructor(containerEl, onAuthSuccess, onShowDocs) {
        this.container = containerEl
        this.onAuthSuccess = onAuthSuccess
        this.onShowDocs = onShowDocs
        this._mode = 'login'   // 'login' | 'signup'
        this._formRevealed = false
        this._cycleTimer = null
    }

    render() {
        const startRevealed = this._formRevealed
        const isSignup = this._mode === 'signup'
        const submitLabel = isSignup ? 'Create account' : 'Sign in'
        const toggleLabel = isSignup ? 'Have an account?' : 'New user?'
        const toggleAction = isSignup ? 'Sign in' : 'Create account'

        this.container.innerHTML = `
            <div class="auth-panel">
                <div class="auth-logo">
                    <h1 class="app-title" data-text="Thoughts">Thoughts</h1>
                    <p class="auth-subtitle">an obsidian replacement</p>
                </div>

                <button type="button" class="auth-prompt${startRevealed ? ' auth-prompt-gone' : ''}" id="auth-prompt" aria-label="Sign in">
                    <span class="auth-prompt-text" id="auth-prompt-text"></span><span class="auth-prompt-caret">_</span>
                </button>

                <form class="auth-form${startRevealed ? '' : ' auth-form-hidden'}" id="auth-form">
                    <div class="field-group">
                        <label class="field-label">Email</label>
                        <input
                            type="email"
                            id="auth-email"
                            class="cyber-input"
                            placeholder="you@example.com"
                            autocomplete="email"
                            required
                        />
                    </div>

                    <div class="field-group">
                        <label class="field-label">Password</label>
                        <input
                            type="password"
                            id="auth-password"
                            class="cyber-input"
                            placeholder="••••••••••"
                            autocomplete="current-password"
                            required
                        />
                    </div>

                    <div id="auth-error" class="auth-error hidden"></div>

                    <button type="submit" class="cyber-btn primary-btn" id="auth-submit">
                        <span class="btn-text">${submitLabel}</span>
                        <span class="btn-glow"></span>
                    </button>

                    <p class="auth-toggle">
                        <span id="toggle-label">${toggleLabel}</span>
                        <button type="button" class="link-btn" id="toggle-mode">${toggleAction}</button>
                    </p>
                </form>

                <div class="auth-meta">
                    <span>Srujan Yamali</span>
                    <span>&middot;</span>
                    <span>Berkeley, CA</span>
                    <span>&middot;</span>
                    <span>2026</span>
                </div>

                <button type="button" class="auth-docs-link" id="auth-docs-btn">docs</button>

                <div class="scanlines"></div>
            </div>
        `

        this._bindEvents()
        if (startRevealed) {
            const emailEl = this.container.querySelector('#auth-email')
            if (emailEl) emailEl.focus()
        } else {
            this._startPromptAnimation()
        }
    }

    _startPromptAnimation() {
        const textEl = this.container.querySelector('#auth-prompt-text')
        if (!textEl) return

        const phrases = [
            'click to sign in',
            'open your thoughts',
            'enter the void',
            'click to begin',
        ]
        let phraseIdx = 0
        let charIdx = 0
        let phase = 'typing' // 'typing' | 'holding' | 'deleting'

        const tick = () => {
            if (this._formRevealed) return
            const current = phrases[phraseIdx]

            if (phase === 'typing') {
                charIdx++
                textEl.textContent = current.slice(0, charIdx)
                if (charIdx >= current.length) {
                    phase = 'holding'
                    this._cycleTimer = setTimeout(tick, 2200)
                    return
                }
                this._cycleTimer = setTimeout(tick, 70 + Math.random() * 40)
            } else if (phase === 'holding') {
                phase = 'deleting'
                this._cycleTimer = setTimeout(tick, 40)
            } else {
                charIdx--
                textEl.textContent = current.slice(0, charIdx)
                if (charIdx <= 0) {
                    phase = 'typing'
                    phraseIdx = (phraseIdx + 1) % phrases.length
                    this._cycleTimer = setTimeout(tick, 500)
                    return
                }
                this._cycleTimer = setTimeout(tick, 35)
            }
        }
        tick()
    }

    _stopPromptAnimation() {
        if (this._cycleTimer) {
            clearTimeout(this._cycleTimer)
            this._cycleTimer = null
        }
    }

    _revealForm() {
        if (this._formRevealed) return
        this._formRevealed = true
        this._stopPromptAnimation()

        const prompt = this.container.querySelector('#auth-prompt')
        const form = this.container.querySelector('#auth-form')
        if (prompt) prompt.classList.add('auth-prompt-gone')
        if (form) form.classList.remove('auth-form-hidden')

        setTimeout(() => {
            const emailEl = this.container.querySelector('#auth-email')
            if (emailEl) emailEl.focus()
        }, 280)
    }

    _bindEvents() {
        this.container.querySelector('#auth-prompt').addEventListener('click', () => {
            this._revealForm()
        })

        this.container.querySelector('#auth-form').addEventListener('submit', (e) => {
            e.preventDefault()
            this._handleSubmit()
        })

        this.container.querySelector('#auth-docs-btn').addEventListener('click', () => {
            if (this.onShowDocs) this.onShowDocs()
        })

        this.container.querySelector('#toggle-mode').addEventListener('click', () => {
            this._mode = this._mode === 'login' ? 'signup' : 'login'
            const isSignup = this._mode === 'signup'
            this.container.querySelector('#auth-submit').querySelector('.btn-text').textContent =
                isSignup ? 'Create account' : 'Sign in'
            this.container.querySelector('#toggle-label').textContent =
                isSignup ? 'Have an account?' : 'New user?'
            this.container.querySelector('#toggle-mode').textContent =
                isSignup ? 'Sign in' : 'Create account'
            this.container.querySelector('#auth-error').classList.add('hidden')
        })
    }

    async _handleSubmit() {
        const email     = this.container.querySelector('#auth-email').value.trim()
        const password  = this.container.querySelector('#auth-password').value
        const submitBtn = this.container.querySelector('#auth-submit')
        const errorEl   = this.container.querySelector('#auth-error')

        if (!email || !password) {
            errorEl.textContent = 'Please fill in both fields'
            errorEl.classList.remove('hidden')
            return
        }

        submitBtn.disabled = true
        const btnText = submitBtn.querySelector('.btn-text')
        btnText.textContent = 'Connecting...'
        btnText.classList.add('auth-loading')
        errorEl.classList.add('hidden')
        errorEl.textContent = ''

        const startTime = performance.now()

        try {
            if (this._mode === 'login') {
                await auth.login(email, password)
            } else {
                await auth.signup(email, password)
            }
            // Smooth transition — ensure minimum 300ms so user sees feedback
            const elapsed = performance.now() - startTime
            if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed))
            btnText.textContent = 'Success!'
            setTimeout(() => this.onAuthSuccess(), 150)
        } catch (err) {
            const msg = err.message || 'Unknown error'
            const isConflict = err.status === 409 || msg.toLowerCase().includes('already exists')
            if (isConflict) {
                errorEl.innerHTML = `Email already registered — <button type="button" class="link-btn" id="err-switch-login">Sign in instead</button>`
            } else {
                errorEl.textContent = msg
            }
            errorEl.classList.remove('hidden')
            submitBtn.disabled = false
            btnText.textContent =
                this._mode === 'signup' ? 'Create account' : 'Sign in'
            btnText.classList.remove('auth-loading')
            this.container.querySelector('#auth-password').value = ''
            this.container.querySelector('#auth-password').focus()

            const switchBtn = this.container.querySelector('#err-switch-login')
            if (switchBtn) {
                switchBtn.addEventListener('click', () => {
                    this._mode = 'login'
                    this.render()
                })
            }
        }
    }
}

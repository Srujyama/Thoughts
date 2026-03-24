// src/auth.js
import { auth } from './api.js'

export class AuthController {
    constructor(containerEl, onAuthSuccess) {
        this.container = containerEl
        this.onAuthSuccess = onAuthSuccess
        this._mode = 'login'   // 'login' | 'signup'
    }

    render() {
        this.container.innerHTML = `
            <div class="auth-panel">
                <div class="auth-logo">
                    <h1 class="app-title" data-text="Thoughts">Thoughts</h1>
                    <p class="auth-subtitle">Your personal writing space</p>
                </div>

                <form class="auth-form" id="auth-form">
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
                        <span class="btn-text">Sign in</span>
                        <span class="btn-glow"></span>
                    </button>

                    <p class="auth-toggle">
                        <span id="toggle-label">New user?</span>
                        <button type="button" class="link-btn" id="toggle-mode">Create account</button>
                    </p>
                </form>

                <div class="scanlines"></div>
            </div>
        `

        this._bindEvents()
        this.container.querySelector('#auth-email').focus()
    }

    _bindEvents() {
        this.container.querySelector('#auth-form').addEventListener('submit', (e) => {
            e.preventDefault()
            this._handleSubmit()
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

        submitBtn.disabled = true
        submitBtn.querySelector('.btn-text').textContent = 'Connecting...'
        errorEl.classList.add('hidden')
        errorEl.textContent = ''

        try {
            if (this._mode === 'login') {
                await auth.login(email, password)
            } else {
                await auth.signup(email, password)
            }
            this.onAuthSuccess()
        } catch (err) {
            const msg = err.message || 'Unknown error'
            const isConflict = err.status === 409 || msg.toLowerCase().includes('already exists')
            errorEl.innerHTML = isConflict
                ? `Email already registered — <button type="button" class="link-btn" id="err-switch-login">Sign in instead</button>`
                : msg
            errorEl.classList.remove('hidden')
            submitBtn.disabled = false
            submitBtn.querySelector('.btn-text').textContent =
                this._mode === 'signup' ? 'Create account' : 'Sign in'
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

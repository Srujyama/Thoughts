// src/auth.js
import { authAPI, storage } from './api.js'

export class AuthController {
    constructor(containerEl, onAuthSuccess) {
        this.container = containerEl
        this.onAuthSuccess = onAuthSuccess
        this.mode = 'login'
    }

    render() {
        this.container.innerHTML = `
            <div class="auth-panel">
                <div class="auth-logo">
                    <h1 class="glitch-text" data-text="THOUGHTS.EXE">THOUGHTS.EXE</h1>
                    <p class="auth-subtitle">// NIGHT CITY NEURAL INTERFACE //</p>
                </div>

                <div class="auth-tabs">
                    <button class="auth-tab ${this.mode === 'login' ? 'active' : ''}" data-mode="login">LOGIN</button>
                    <button class="auth-tab ${this.mode === 'signup' ? 'active' : ''}" data-mode="signup">SIGNUP</button>
                </div>

                <form class="auth-form" id="auth-form">
                    <div class="field-group">
                        <label class="field-label">// EMAIL</label>
                        <input
                            type="email"
                            id="auth-email"
                            class="cyber-input"
                            placeholder="user@night.city"
                            autocomplete="${this.mode === 'login' ? 'username' : 'email'}"
                            required
                        />
                    </div>

                    <div class="field-group">
                        <label class="field-label">// PASSWORD</label>
                        <input
                            type="password"
                            id="auth-password"
                            class="cyber-input"
                            placeholder="••••••••"
                            autocomplete="${this.mode === 'login' ? 'current-password' : 'new-password'}"
                            minlength="8"
                            required
                        />
                    </div>

                    <div id="auth-error" class="auth-error hidden"></div>

                    <button type="submit" class="cyber-btn primary-btn" id="auth-submit">
                        <span class="btn-text">${this.mode === 'login' ? 'JACK IN' : 'CREATE IDENT'}</span>
                        <span class="btn-glow"></span>
                    </button>
                </form>

                <div class="scanlines"></div>
            </div>
        `

        this._bindEvents()
        this.container.querySelector('#auth-email').focus()
    }

    _bindEvents() {
        this.container.querySelectorAll('.auth-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                this.mode = tab.dataset.mode
                this.render()
            })
        })

        this.container.querySelector('#auth-form').addEventListener('submit', async (e) => {
            e.preventDefault()
            await this._handleSubmit()
        })
    }

    async _handleSubmit() {
        const email = this.container.querySelector('#auth-email').value.trim()
        const password = this.container.querySelector('#auth-password').value
        const submitBtn = this.container.querySelector('#auth-submit')
        const errorEl = this.container.querySelector('#auth-error')

        submitBtn.disabled = true
        submitBtn.querySelector('.btn-text').textContent = 'CONNECTING...'
        errorEl.classList.add('hidden')
        errorEl.textContent = ''

        try {
            const result =
                this.mode === 'login'
                    ? await authAPI.login(email, password)
                    : await authAPI.signup(email, password)

            storage.setToken(result.access_token)
            storage.setUser({ id: result.user_id, email: result.email })
            this.onAuthSuccess(result)
        } catch (err) {
            errorEl.textContent = `> ERROR: ${err.message}`
            errorEl.classList.remove('hidden')
            submitBtn.disabled = false
            submitBtn.querySelector('.btn-text').textContent =
                this.mode === 'login' ? 'JACK IN' : 'CREATE IDENT'
        }
    }
}

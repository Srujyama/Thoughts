// src/api.js
// All communication with the FastAPI backend lives here.

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const TOKEN_KEY = 'nc_access_token'
const USER_KEY = 'nc_user'

export const storage = {
    setToken: (token) => localStorage.setItem(TOKEN_KEY, token),
    getToken: () => localStorage.getItem(TOKEN_KEY),
    setUser: (user) => localStorage.setItem(USER_KEY, JSON.stringify(user)),
    getUser: () => {
        const u = localStorage.getItem(USER_KEY)
        return u ? JSON.parse(u) : null
    },
    clearAll: () => {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
    },
}

async function authFetch(path, options = {}) {
    const token = storage.getToken()
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
    }

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers })

    if (res.status === 401) {
        storage.clearAll()
        window.dispatchEvent(new CustomEvent('auth:expired'))
        throw new Error('Session expired. Please log in again.')
    }

    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'Request failed')
    }

    if (res.status === 204) return null
    return res.json()
}

export const authAPI = {
    signup: (email, password) =>
        authFetch('/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        }),

    login: (email, password) =>
        authFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        }),

    logout: async () => {
        await authFetch('/auth/logout', { method: 'POST' }).catch(() => {})
        storage.clearAll()
    },
}

export const thoughtsAPI = {
    list: () => authFetch('/thoughts'),

    create: (text) =>
        authFetch('/thoughts', {
            method: 'POST',
            body: JSON.stringify({ text }),
        }),

    delete: (id) => authFetch(`/thoughts/${id}`, { method: 'DELETE' }),
}

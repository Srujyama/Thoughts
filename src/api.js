// src/api.js
// All calls go to the FastAPI backend. JWT stored in localStorage.

const BASE_URL    = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const TOKEN_KEY   = 'nc_token'
const REFRESH_KEY = 'nc_refresh_token'
const USER_KEY    = 'nc_user'

// ── Session-expired callback (set by main.js to redirect to login) ──
let _onSessionExpired = null

export function setSessionExpiredHandler(handler) {
    _onSessionExpired = handler
}

// ── Token refresh (runs at most once at a time) ───────────────
let _refreshPromise = null
let _refreshTimer = null

// Parse JWT to read expiry without a library
function _parseJwtExp(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
        return payload.exp || 0
    } catch { return 0 }
}

// Schedule a proactive refresh ~60s before the access token expires
function _scheduleProactiveRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer)
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) return

    const exp = _parseJwtExp(token)
    if (!exp) return

    const nowSec = Math.floor(Date.now() / 1000)
    const ttl = exp - nowSec
    // Refresh 60 seconds before expiry (minimum 10s from now)
    const delay = Math.max((ttl - 60) * 1000, 10_000)

    _refreshTimer = setTimeout(async () => {
        try {
            if (!_refreshPromise) {
                _refreshPromise = _refreshToken().finally(() => { _refreshPromise = null })
            }
            await _refreshPromise
        } catch {
            // Proactive refresh failed — user will be prompted on next request
        }
    }, delay)
}

function _handleSessionExpired() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(USER_KEY)
    if (_refreshTimer) clearTimeout(_refreshTimer)
    if (_onSessionExpired) {
        _onSessionExpired()
    }
}

async function _refreshToken() {
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    if (!refreshToken) {
        _handleSessionExpired()
        throw new Error('__SESSION_EXPIRED__')
    }

    const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!res.ok) {
        _handleSessionExpired()
        throw new Error('__SESSION_EXPIRED__')
    }
    const data = await res.json()
    localStorage.setItem(TOKEN_KEY, data.access_token)
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token)
    // Schedule the next proactive refresh
    _scheduleProactiveRefresh()
    return data.access_token
}

// ── Internal fetch helper ─────────────────────────────────────

async function apiFetch(path, options = {}, _retry = true) {
    const token = localStorage.getItem(TOKEN_KEY)
    const headers = { 'Content-Type': 'application/json', ...options.headers }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })

    if (res.status === 204) return null

    // Auto-refresh on 401 then retry once
    if (res.status === 401 && _retry) {
        if (!_refreshPromise) _refreshPromise = _refreshToken().finally(() => { _refreshPromise = null })
        try {
            await _refreshPromise
        } catch (err) {
            if (err.message === '__SESSION_EXPIRED__') return null
            throw err
        }
        return apiFetch(path, options, false)
    }

    const data = await res.json().catch(() => null)

    if (!res.ok) {
        const msg = data?.detail || `HTTP ${res.status}`
        const err = new Error(Array.isArray(msg) ? msg.map(e => e.msg).join(', ') : msg)
        err.status = res.status
        throw err
    }

    return data
}

// ── Auth ──────────────────────────────────────────────────────

export const auth = {
    isAuthed: () => !!localStorage.getItem(TOKEN_KEY),

    getToken: () => localStorage.getItem(TOKEN_KEY),

    getUser: () => {
        try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null }
    },

    async login(email, password) {
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        })
        localStorage.setItem(TOKEN_KEY, data.access_token)
        if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token)
        localStorage.setItem(USER_KEY, JSON.stringify({ user_id: data.user_id, email: data.email }))
        _scheduleProactiveRefresh()
        return data
    },

    async signup(email, password) {
        const data = await apiFetch('/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        })
        localStorage.setItem(TOKEN_KEY, data.access_token)
        if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token)
        localStorage.setItem(USER_KEY, JSON.stringify({ user_id: data.user_id, email: data.email }))
        _scheduleProactiveRefresh()
        return data
    },

    // Call on app load to start proactive refresh cycle
    startRefreshCycle() {
        _scheduleProactiveRefresh()
    },

    async logout() {
        if (_refreshTimer) clearTimeout(_refreshTimer)
        try { await apiFetch('/auth/logout', { method: 'POST' }) } catch { /* no-op */ }
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(REFRESH_KEY)
        localStorage.removeItem(USER_KEY)
    },
}

// ── Thoughts API ──────────────────────────────────────────────

export const thoughtsAPI = {
    list: ()            => apiFetch('/thoughts'),
    create: (text)      => apiFetch('/thoughts', { method: 'POST', body: JSON.stringify({ text }) }),
    delete: (thoughtId) => apiFetch(`/thoughts/${thoughtId}`, { method: 'DELETE' }),
}

// ── Vault / Files API ─────────────────────────────────────────
// Files are stored as: {folderPath}/{title}.md  (folderPath can be nested: a/b/c)
// Folder list is derived from the file paths returned by the API.

export const vaultAPI = {
    // Returns raw flat list: [{ path, updated_at, size }, ...]
    listFiles: () => apiFetch('/vault/files'),

    // Returns file content as text (goes through apiFetch for auto-refresh)
    async readFile(path) {
        const doRead = async () => {
            const token = localStorage.getItem(TOKEN_KEY)
            return fetch(`${BASE_URL}/vault/files/${path}`, {
                headers: { Authorization: `Bearer ${token}` },
            })
        }
        let res = await doRead()
        if (res.status === 401) {
            if (!_refreshPromise) _refreshPromise = _refreshToken().finally(() => { _refreshPromise = null })
            try {
                await _refreshPromise
            } catch (err) {
                if (err.message === '__SESSION_EXPIRED__') return ''
                throw err
            }
            res = await doRead()
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
    },

    writeFile: (path, content) => apiFetch(`/vault/files/${path}`, {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
    }),

    deleteFile: (path) => apiFetch(`/vault/files/${path}`, { method: 'DELETE' }),
}

// ── Folders + Files abstraction ────────────────────────────────
// Meta structure (localStorage):
//   { folders: [ { id, name, path, parentId|null, created_at, files: [...] }, ... ] }
//
// folder.path  = full slug path, e.g. "notes" or "notes/archive"
// folder.parentId = id of parent folder, or null for root
// file.path    = full storage path, e.g. "notes/archive/my-file.md"

// ── In-memory meta cache (avoids repeated JSON.parse from localStorage) ──
let _metaCache = null
let _metaCacheKey = null

// ── Content cache (sessionStorage for recently opened files) ──
const CONTENT_CACHE_PREFIX = 'nc_fcache_'
const CONTENT_CACHE_MAX = 50

function _cacheContent(filePath, content) {
    try {
        sessionStorage.setItem(CONTENT_CACHE_PREFIX + filePath, content)
        // Evict oldest entries if too many
        const keys = []
        for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i)
            if (k.startsWith(CONTENT_CACHE_PREFIX)) keys.push(k)
        }
        if (keys.length > CONTENT_CACHE_MAX) {
            // Remove first (oldest) entries
            keys.slice(0, keys.length - CONTENT_CACHE_MAX).forEach(k => sessionStorage.removeItem(k))
        }
    } catch { /* quota exceeded — ignore */ }
}

function _getCachedContent(filePath) {
    try { return sessionStorage.getItem(CONTENT_CACHE_PREFIX + filePath) }
    catch { return null }
}

// ── Cloud sync dedup — only one sync in-flight at a time ──
let _syncPromise = null
let _lastSyncTime = 0
const SYNC_MIN_INTERVAL = 5000  // minimum 5s between syncs

function metaKey() {
    const user = auth.getUser()
    return user ? `nc_vault_meta_${user.user_id}` : 'nc_vault_meta_anon'
}

function loadMeta() {
    const key = metaKey()
    // Return in-memory cache if available and same user
    if (_metaCache && _metaCacheKey === key) return _metaCache
    try {
        _metaCache = JSON.parse(localStorage.getItem(key)) || { folders: [] }
    } catch {
        _metaCache = { folders: [] }
    }
    _metaCacheKey = key
    return _metaCache
}

function saveMeta(meta) {
    _metaCache = meta
    _metaCacheKey = metaKey()
    localStorage.setItem(_metaCacheKey, JSON.stringify(meta))
}

function uid() { return crypto.randomUUID() }

function slug(name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid()
}

// Ensure a folder exists for each segment of a path, returning the leaf folder.
// e.g. "notes/archive/2024" creates/finds folders for notes, notes/archive, notes/archive/2024
function ensureFolderPath(folderPath, meta) {
    const segments = folderPath.split('/')
    let parentId = null
    let currentPath = ''
    let folder = null

    for (const seg of segments) {
        currentPath = currentPath ? `${currentPath}/${seg}` : seg
        folder = meta.folders.find(f => f.path === currentPath)
        if (!folder) {
            folder = {
                id: uid(),
                name: seg.replace(/-/g, ' '),
                path: currentPath,
                parentId,
                created_at: new Date().toISOString(),
                files: [],
            }
            meta.folders.push(folder)
        }
        parentId = folder.id
    }
    return folder
}

// Merge a raw vault file list into the local folder/file meta cache
function syncMetaFromCloud(rawFiles, meta) {
    // Build a set of all known file paths
    const knownPaths = new Set()
    for (const folder of meta.folders) {
        for (const file of folder.files) knownPaths.add(file.path)
    }

    // Migrate old-style folders (no .path field) to new style
    for (const folder of meta.folders) {
        if (!folder.path) {
            folder.path = folder.slug || slug(folder.name)
            folder.parentId = folder.parentId ?? null
        }
    }

    for (const item of rawFiles) {
        const path = item.path
        if (!path || !path.includes('/')) continue   // skip root-level files
        if (path.endsWith('/.keep')) {
            // Ensure the folder exists in meta even if it has no files yet
            const folderPath = path.replace(/\/\.keep$/, '')
            ensureFolderPath(folderPath, meta)
            continue
        }
        // Only process .md files
        if (!path.endsWith('.md')) continue

        if (knownPaths.has(path)) {
            // Update timestamps from cloud
            for (const folder of meta.folders) {
                const file = folder.files.find(f => f.path === path)
                if (file) { file.updated_at = item.updated_at || file.updated_at; break }
            }
            continue
        }

        // New file from cloud — determine its folder (all segments except last)
        const parts = path.split('/')
        const fileName = parts[parts.length - 1]
        const folderPath = parts.slice(0, -1).join('/')

        const folder = ensureFolderPath(folderPath, meta)
        folder.files.unshift({
            id: uid(),
            title: fileName.replace(/\.md$/, '').replace(/-/g, ' '),
            path,
            content: '',
            contentLoaded: false,
            created_at: item.updated_at || new Date().toISOString(),
            updated_at: item.updated_at || new Date().toISOString(),
        })
    }

    return meta
}

export const foldersAPI = {
    async listFromCloud() {
        // Dedup: reuse in-flight sync if called multiple times quickly
        const now = Date.now()
        if (_syncPromise && (now - _lastSyncTime) < SYNC_MIN_INTERVAL) {
            return _syncPromise
        }
        _lastSyncTime = now
        _syncPromise = (async () => {
            try {
                const rawFiles = await vaultAPI.listFiles()
                let meta = loadMeta()
                meta = syncMetaFromCloud(rawFiles, meta)
                saveMeta(meta)
                return meta.folders
            } finally {
                _syncPromise = null
            }
        })()
        return _syncPromise
    },

    list() {
        return loadMeta().folders
    },

    // Returns only root-level folders (no parent)
    listRoots() {
        return loadMeta().folders.filter(f => !f.parentId)
    },

    // Returns direct children of a folder
    listChildren(parentId) {
        return loadMeta().folders.filter(f => f.parentId === parentId)
    },

    async create(name, parentId = null) {
        const meta = loadMeta()
        const parent = parentId ? meta.folders.find(f => f.id === parentId) : null
        const folderSlug = slug(name)
        const folderPath = parent ? `${parent.path}/${folderSlug}` : folderSlug

        const folder = {
            id: uid(),
            name: name.trim(),
            path: folderPath,
            parentId: parentId || null,
            created_at: new Date().toISOString(),
            files: [],
        }
        meta.folders.push(folder)
        saveMeta(meta)
        // Persist folder marker to cloud
        await vaultAPI.writeFile(folderPath + '/.keep', '')
        return folder
    },

    rename(folderId, newName) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        folder.name = newName.trim()
        // Note: renaming path would require moving all cloud files — keep path stable
        saveMeta(meta)
        return folder
    },

    // Move a folder to a new parent (or to root if newParentId is null)
    async move(folderId, newParentId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) return null  // silently no-op if folder is missing (stale reference)

        // Prevent moving into itself or a descendant
        const isDescendant = (parentId, targetId) => {
            if (!parentId) return false
            if (parentId === targetId) return true
            const parent = meta.folders.find(f => f.id === parentId)
            return parent ? isDescendant(parent.parentId, targetId) : false
        }
        if (newParentId && (newParentId === folderId || isDescendant(newParentId, folderId))) {
            throw new Error('Cannot move folder into itself or a descendant')
        }

        folder.parentId = newParentId || null

        // Recompute path
        const newParent = newParentId ? meta.folders.find(f => f.id === newParentId) : null
        const folderSlug = folder.path.split('/').pop()
        folder.path = newParent ? `${newParent.path}/${folderSlug}` : folderSlug

        saveMeta(meta)
        return folder
    },

    async delete(folderId) {
        const meta = loadMeta()
        const toDelete = []
        const collect = (id) => {
            const f = meta.folders.find(x => x.id === id)
            if (!f) return
            toDelete.push(f)
            meta.folders.filter(x => x.parentId === id).forEach(child => collect(child.id))
        }
        collect(folderId)

        const allFiles = toDelete.flatMap(f => f.files)
        const keepMarkers = toDelete.map(f => f.path + '/.keep')
        await Promise.all([
            ...allFiles.map(f => vaultAPI.deleteFile(f.path).catch(() => {})),
            ...keepMarkers.map(p => vaultAPI.deleteFile(p).catch(() => {})),
        ])

        const deleteIds = new Set(toDelete.map(f => f.id))
        meta.folders = meta.folders.filter(f => !deleteIds.has(f.id))
        saveMeta(meta)
    },

    async deleteWithProgress(folderId, onProgress) {
        const meta = loadMeta()
        const toDelete = []
        const collect = (id) => {
            const f = meta.folders.find(x => x.id === id)
            if (!f) return
            toDelete.push(f)
            meta.folders.filter(x => x.parentId === id).forEach(child => collect(child.id))
        }
        collect(folderId)

        const allFiles = toDelete.flatMap(f => f.files)
        const keepMarkers = toDelete.map(f => f.path + '/.keep')
        const allPaths = [...allFiles.map(f => f.path), ...keepMarkers]
        const total = allPaths.length || 1
        let done = 0

        for (const path of allPaths) {
            await vaultAPI.deleteFile(path).catch(() => {})
            done++
            if (onProgress) onProgress(done, total)
        }

        const deleteIds = new Set(toDelete.map(f => f.id))
        meta.folders = meta.folders.filter(f => !deleteIds.has(f.id))
        saveMeta(meta)
    },
}

export const filesAPI = {
    list(folderId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        return folder ? folder.files : []
    },

    async create(folderId, title, content = '') {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')

        const fileSlug = slug(title) + '.md'
        const path = `${folder.path}/${fileSlug}`

        await vaultAPI.writeFile(path, content)

        const file = {
            id: uid(),
            title: title.trim(),
            path,
            content,
            contentLoaded: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }
        folder.files.unshift(file)
        saveMeta(meta)
        return file
    },

    async loadContent(folderId, fileId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const file = folder.files.find(f => f.id === fileId)
        if (!file) throw new Error('File not found')

        // Show cached content instantly if available, then refresh from cloud
        const cached = _getCachedContent(file.path)
        if (cached !== null && !file.contentLoaded) {
            file.content = cached
            file.contentLoaded = true
        }

        // Always fetch fresh content from cloud so edits on other devices are visible
        const freshContent = await vaultAPI.readFile(file.path)
        file.content = freshContent
        file.contentLoaded = true
        _cacheContent(file.path, freshContent)
        saveMeta(meta)
        return file
    },

    async update(folderId, fileId, { title, content }) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const file = folder.files.find(f => f.id === fileId)
        if (!file) throw new Error('File not found')

        if (title !== undefined) file.title = title.trim()
        if (content !== undefined) {
            file.content = content
            _cacheContent(file.path, content)
            await vaultAPI.writeFile(file.path, content)
        }
        file.updated_at = new Date().toISOString()
        saveMeta(meta)
        return file
    },

    async delete(folderId, fileId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const file = folder.files.find(f => f.id === fileId)
        if (file) await vaultAPI.deleteFile(file.path).catch(() => {})
        folder.files = folder.files.filter(f => f.id !== fileId)
        saveMeta(meta)
    },

    // Move a file to a different folder
    async move(sourceFolderId, fileId, targetFolderId) {
        const meta = loadMeta()
        const sourceFolder = meta.folders.find(f => f.id === sourceFolderId)
        const targetFolder = meta.folders.find(f => f.id === targetFolderId)
        if (!sourceFolder || !targetFolder) return null  // silently no-op if folder is missing
        const fileIdx = sourceFolder.files.findIndex(f => f.id === fileId)
        if (fileIdx === -1) throw new Error('File not found')

        const file = sourceFolder.files[fileIdx]
        const fileName = file.path.split('/').pop()
        const newPath = `${targetFolder.path}/${fileName}`

        // Read content, write to new path, delete old
        let content = file.content || ''
        if (!file.contentLoaded) {
            try { content = await vaultAPI.readFile(file.path) } catch { /* use empty */ }
        }
        await vaultAPI.writeFile(newPath, content)
        await vaultAPI.deleteFile(file.path).catch(() => {})

        file.path = newPath
        sourceFolder.files.splice(fileIdx, 1)
        targetFolder.files.unshift(file)
        saveMeta(meta)
        return file
    },
}

// ── Sync status ──────────────────────────────────────────────
// Tracks whether the app can reach the backend and the session is valid.
// States: 'synced' | 'checking' | 'offline' | 'expired'

let _syncStatus = 'checking'
let _syncListeners = []
let _syncCheckTimer = null

export const syncStatus = {
    get() { return _syncStatus },

    onChange(fn) {
        _syncListeners.push(fn)
        return () => { _syncListeners = _syncListeners.filter(l => l !== fn) }
    },

    _set(status) {
        if (_syncStatus === status) return
        _syncStatus = status
        _syncListeners.forEach(fn => fn(status))
    },

    async check() {
        const token = localStorage.getItem(TOKEN_KEY)
        if (!token) { syncStatus._set('expired'); return }

        // Check if token is expired locally first
        const exp = _parseJwtExp(token)
        const nowSec = Math.floor(Date.now() / 1000)
        if (exp && exp < nowSec) {
            // Try refreshing
            try {
                if (!_refreshPromise) _refreshPromise = _refreshToken().finally(() => { _refreshPromise = null })
                await _refreshPromise
            } catch {
                syncStatus._set('expired')
                return
            }
        }

        syncStatus._set('checking')
        try {
            const res = await fetch(`${BASE_URL}/vault/files`, {
                headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}` },
            })
            if (res.ok) syncStatus._set('synced')
            else if (res.status === 401) syncStatus._set('expired')
            else syncStatus._set('offline')
        } catch {
            syncStatus._set('offline')
        }
    },

    startPolling() {
        syncStatus.check()
        if (_syncCheckTimer) clearInterval(_syncCheckTimer)
        _syncCheckTimer = setInterval(() => syncStatus.check(), 60_000)
    },

    stopPolling() {
        if (_syncCheckTimer) { clearInterval(_syncCheckTimer); _syncCheckTimer = null }
    },
}

// Update sync status on successful/failed API calls
const _origApiFetch = apiFetch
// We patch the internal flow by hooking into listFromCloud success/failure
const _origListFromCloud = foldersAPI.listFromCloud.bind(foldersAPI)
foldersAPI.listFromCloud = async function () {
    try {
        const result = await _origListFromCloud()
        syncStatus._set('synced')
        return result
    } catch (err) {
        if (err.message === '__SESSION_EXPIRED__') syncStatus._set('expired')
        else syncStatus._set('offline')
        throw err
    }
}

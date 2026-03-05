// src/api.js
// All calls go to the FastAPI backend. JWT stored in localStorage.

const BASE_URL    = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const TOKEN_KEY   = 'nc_token'
const REFRESH_KEY = 'nc_refresh_token'
const USER_KEY    = 'nc_user'

// ── Token refresh (runs at most once at a time) ───────────────
let _refreshPromise = null

async function _refreshToken() {
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    if (!refreshToken) throw new Error('No refresh token — please log in again.')

    const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!res.ok) {
        // Refresh failed — clear auth so the app shows the login screen
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(REFRESH_KEY)
        localStorage.removeItem(USER_KEY)
        throw new Error('Session expired. Please log in again.')
    }
    const data = await res.json()
    localStorage.setItem(TOKEN_KEY, data.access_token)
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token)
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
        await _refreshPromise
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
        return data
    },

    async logout() {
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
            await _refreshPromise
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

function metaKey() {
    const user = auth.getUser()
    return user ? `nc_vault_meta_${user.user_id}` : 'nc_vault_meta_anon'
}

function loadMeta() {
    try { return JSON.parse(localStorage.getItem(metaKey())) || { folders: [] } }
    catch { return { folders: [] } }
}

function saveMeta(meta) {
    localStorage.setItem(metaKey(), JSON.stringify(meta))
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
        const rawFiles = await vaultAPI.listFiles()
        let meta = loadMeta()
        meta = syncMetaFromCloud(rawFiles, meta)
        saveMeta(meta)
        return meta.folders
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

    async delete(folderId) {
        const meta = loadMeta()
        // Collect this folder and all descendants
        const toDelete = []
        const collect = (id) => {
            const f = meta.folders.find(x => x.id === id)
            if (!f) return
            toDelete.push(f)
            meta.folders.filter(x => x.parentId === id).forEach(child => collect(child.id))
        }
        collect(folderId)

        // Delete all files and .keep markers from cloud
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

        // Always fetch fresh content from cloud so edits on other devices are visible
        file.content = await vaultAPI.readFile(file.path)
        file.contentLoaded = true
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
}

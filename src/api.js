// src/api.js
// All calls go to the FastAPI backend. JWT stored in localStorage.

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const TOKEN_KEY = 'nc_token'
const USER_KEY  = 'nc_user'

// ── Internal fetch helper ─────────────────────────────────────

async function apiFetch(path, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY)
    const headers = { 'Content-Type': 'application/json', ...options.headers }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })

    if (res.status === 204) return null

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
        localStorage.setItem(USER_KEY, JSON.stringify({ user_id: data.user_id, email: data.email }))
        return data
    },

    async signup(email, password) {
        const data = await apiFetch('/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        })
        localStorage.setItem(TOKEN_KEY, data.access_token)
        localStorage.setItem(USER_KEY, JSON.stringify({ user_id: data.user_id, email: data.email }))
        return data
    },

    async logout() {
        try { await apiFetch('/auth/logout', { method: 'POST' }) } catch { /* no-op */ }
        localStorage.removeItem(TOKEN_KEY)
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
// Files are stored as: {folder}/{title}.md
// Folder list is derived from the file paths returned by the API.

export const vaultAPI = {
    // Returns raw flat list: [{ path, updated_at, size }, ...]
    listFiles: () => apiFetch('/vault/files'),

    // Returns file content as text
    async readFile(path) {
        const token = localStorage.getItem(TOKEN_KEY)
        const res = await fetch(`${BASE_URL}/vault/files/${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
    },

    writeFile: (path, content) => apiFetch(`/vault/files/${path}`, {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
    }),

    deleteFile: (path) => apiFetch(`/vault/files/${path}`, { method: 'DELETE' }),
}

// ── Folders + Files abstraction (maps vault paths → folder/file model) ────────
// A "folder" is the first path segment. Files live at "{folder}/{slug}.md".
// Folder and file metadata are kept in localStorage as lightweight cache
// so UI state (IDs, display names) survives across renders without round-trips.

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

// Merge a raw vault file list into the local folder/file meta cache
function syncMetaFromCloud(rawFiles, meta) {
    const knownPaths = new Set()
    for (const folder of meta.folders) {
        for (const file of folder.files) knownPaths.add(file.path)
    }

    for (const item of rawFiles) {
        const path = item.path
        if (!path || !path.includes('/')) continue          // skip root-level files
        if (path.endsWith('/.keep')) continue                           // skip folder markers
        const [folderSlug, ...rest] = path.split('/')
        const fileSlug = rest.join('/')

        if (knownPaths.has(path)) {
            // update timestamps from cloud
            for (const folder of meta.folders) {
                const file = folder.files.find(f => f.path === path)
                if (file) { file.updated_at = item.updated_at || file.updated_at; break }
            }
            continue
        }

        // New file from cloud — insert into meta
        let folder = meta.folders.find(f => f.slug === folderSlug)
        if (!folder) {
            folder = { id: uid(), name: folderSlug, slug: folderSlug, created_at: new Date().toISOString(), files: [] }
            meta.folders.push(folder)
        }
        folder.files.unshift({
            id: uid(),
            title: fileSlug.replace(/\.md$/, '').replace(/-/g, ' '),
            path,
            content: '',
            contentLoaded: false,
            created_at: item.updated_at || new Date().toISOString(),
            updated_at: item.updated_at || new Date().toISOString(),
        })
    }

    // Never remove local-only files or folders — cloud sync only adds, never deletes local state
    // Deletion is handled explicitly by the user via the delete button
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

    async create(name) {
        const meta = loadMeta()
        const folder = {
            id: uid(),
            name: name.trim(),
            slug: slug(name),
            created_at: new Date().toISOString(),
            files: [],
        }
        meta.folders.push(folder)
        saveMeta(meta)
        // Persist folder to cloud so it syncs across devices
        await vaultAPI.writeFile(folder.slug + '/.keep', '')
        return folder
    },

    rename(folderId, newName) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        folder.name = newName.trim()
        // Note: renaming a folder slug would require moving all cloud files — keep slug stable
        saveMeta(meta)
        return folder
    },

    async delete(folderId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) return
        // Delete all files from cloud
        await Promise.all(folder.files.map(f => vaultAPI.deleteFile(f.path).catch(() => {})))
        meta.folders = meta.folders.filter(f => f.id !== folderId)
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
        const path = `${folder.slug}/${fileSlug}`

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

        if (!file.contentLoaded) {
            file.content = await vaultAPI.readFile(file.path)
            file.contentLoaded = true
            saveMeta(meta)
        }
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

// src/api.js
// All data operations go straight to Firebase — Auth for sessions, Firestore
// for thoughts, Cloud Storage for vault files. Security rules enforce access;
// there is no application server.

import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
} from 'firebase/auth'
import {
    collection, query, where, orderBy, getDocs,
    addDoc, getDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore'
import {
    ref, listAll, getMetadata, getBytes, uploadString, deleteObject,
} from 'firebase/storage'
import { fbAuth, db, storage, authReady } from './firebase.js'

const USER_KEY = 'nc_user'

// Legacy keys from the FastAPI-backend era — clear stale JWTs.
localStorage.removeItem('nc_token')
localStorage.removeItem('nc_refresh_token')

// ── Session-expired callback (set by main.js to redirect to login) ──
let _onSessionExpired = null

export function setSessionExpiredHandler(handler) {
    _onSessionExpired = handler
}

function _sessionExpired() {
    localStorage.removeItem(USER_KEY)
    if (_onSessionExpired) _onSessionExpired()
}

// When the SDK finishes restoring the persisted session: if the app thought it
// was signed in but Firebase says otherwise, the session is gone — kick to login.
authReady.then(user => {
    if (user) {
        localStorage.setItem(USER_KEY, JSON.stringify({ user_id: user.uid, email: user.email }))
    } else if (localStorage.getItem(USER_KEY)) {
        _sessionExpired()
    }
})

// Wait for the restored session and return the signed-in user, or throw.
// Token refresh is handled inside the SDK — no manual JWT machinery needed.
async function _requireUser() {
    if (fbAuth.currentUser) return fbAuth.currentUser
    await authReady
    if (fbAuth.currentUser) return fbAuth.currentUser
    const err = new Error('Session expired. Please log in again.')
    err.status = 401
    _sessionExpired()
    throw err
}

// Map Firebase Auth error codes to the messages the login UI expects.
function _friendlyAuthError(err) {
    const code = (err && err.code) || ''
    const messages = {
        'auth/email-already-in-use': 'An account with this email already exists',
        'auth/invalid-credential': 'Invalid email or password',
        'auth/wrong-password': 'Invalid email or password',
        'auth/user-not-found': 'Invalid email or password',
        'auth/invalid-email': 'Invalid email address',
        'auth/weak-password': 'Password is too weak (minimum 6 characters)',
        'auth/user-disabled': 'This account has been disabled',
        'auth/too-many-requests': 'Too many attempts — try again in a few minutes',
        'auth/network-request-failed': 'Network error — check your connection',
    }
    if (!messages[code]) return err
    const friendly = new Error(messages[code])
    friendly.code = code
    if (code === 'auth/email-already-in-use') friendly.status = 409
    return friendly
}

function _storeUser(user) {
    const info = { user_id: user.uid, email: user.email }
    localStorage.setItem(USER_KEY, JSON.stringify(info))
    return info
}

// ── Auth ──────────────────────────────────────────────────────

export const auth = {
    // Synchronous hint for instant boot; the SDK restores the real session in
    // the background and the authReady check above corrects any mismatch.
    isAuthed: () => !!localStorage.getItem(USER_KEY),

    getUser: () => {
        try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null }
    },

    async login(email, password) {
        try {
            const cred = await signInWithEmailAndPassword(fbAuth, email, password)
            return _storeUser(cred.user)
        } catch (err) { throw _friendlyAuthError(err) }
    },

    async signup(email, password) {
        try {
            const cred = await createUserWithEmailAndPassword(fbAuth, email, password)
            return _storeUser(cred.user)
        } catch (err) { throw _friendlyAuthError(err) }
    },

    async loginWithGoogle() {
        const { signInWithGoogle } = await import('./firebase.js')
        const user = await signInWithGoogle()
        return _storeUser(user)
    },

    async logout() {
        try { await signOut(fbAuth) } catch { /* no-op */ }
        localStorage.removeItem(USER_KEY)
    },
}

// ── Thoughts API ──────────────────────────────────────────────

const THOUGHTS = 'thoughts'

function _thoughtFromDoc(snap) {
    const data = snap.data() || {}
    return {
        id: snap.id,
        text: data.text || '',
        created_at: data.created_at?.toDate?.().toISOString() ?? null,
        user_id: data.user_id || '',
    }
}

export const thoughtsAPI = {
    async list() {
        const user = await _requireUser()
        const snap = await getDocs(query(
            collection(db, THOUGHTS),
            where('user_id', '==', user.uid),
            orderBy('created_at', 'desc'),
        ))
        const thoughts = snap.docs.map(_thoughtFromDoc)
        return { thoughts, count: thoughts.length }
    },

    async create(text) {
        const user = await _requireUser()
        const docRef = await addDoc(collection(db, THOUGHTS), {
            text: text.trim(),
            user_id: user.uid,
            created_at: serverTimestamp(),
        })
        return _thoughtFromDoc(await getDoc(docRef))
    },

    async delete(thoughtId) {
        await _requireUser()
        await deleteDoc(doc(db, THOUGHTS, thoughtId))  // rules enforce ownership
        return null
    },
}

// ── Vault / Files API ─────────────────────────────────────────
// Files are stored as: {folderPath}/{title}.md  (folderPath can be nested: a/b/c)
// In Cloud Storage each object lives at "{uid}/{relative_path}"; storage.rules
// limit every user to their own prefix.

function _fileRef(user, path) {
    return ref(storage, `${user.uid}/${path}`)
}

export const vaultAPI = {
    // Returns raw flat list: [{ path, updated_at, size }, ...]
    async listFiles() {
        const user = await _requireUser()
        const prefixLen = user.uid.length + 1
        const files = []
        const walk = async (dirRef) => {
            const page = await listAll(dirRef)
            const metas = await Promise.all(page.items.map(item => getMetadata(item).catch(() => null)))
            page.items.forEach((item, i) => {
                files.push({
                    path: item.fullPath.slice(prefixLen),
                    updated_at: metas[i] ? metas[i].updated : null,
                    size: metas[i] ? Number(metas[i].size) : null,
                })
            })
            await Promise.all(page.prefixes.map(walk))
        }
        await walk(ref(storage, user.uid))
        return files
    },

    // Returns file content as text
    async readFile(path) {
        const user = await _requireUser()
        const bytes = await getBytes(_fileRef(user, path))
        return new TextDecoder().decode(bytes)
    },

    async writeFile(path, content) {
        const user = await _requireUser()
        await uploadString(_fileRef(user, path), content, 'raw', { contentType: 'text/markdown' })
        return { path, bytes: content.length }
    },

    async deleteFile(path) {
        const user = await _requireUser()
        try {
            await deleteObject(_fileRef(user, path))
        } catch (err) {
            if (err && err.code === 'storage/object-not-found') return null  // idempotent
            throw err
        }
        return null
    },
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
        if (!auth.isAuthed()) { syncStatus._set('expired'); return }

        syncStatus._set('checking')
        let user = fbAuth.currentUser
        if (!user) user = await authReady
        if (!user) { syncStatus._set('expired'); return }

        try {
            // Reachability + session probe: list at most one object from the
            // user's Storage prefix with a fresh ID token. The SDK refreshes
            // the token automatically if it's stale.
            const token = await user.getIdToken()
            const bucket = storage.app.options.storageBucket
            const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o` +
                `?prefix=${encodeURIComponent(user.uid + '/')}&maxResults=1`
            const res = await fetch(url, { headers: { Authorization: `Firebase ${token}` } })
            if (res.ok) {
                syncStatus._set('synced')
                // Connection is back — drain any saves queued while offline
                if (offlineQueue.getPending().length) offlineQueue.flush().catch(() => {})
            }
            else if (res.status === 401 || res.status === 403) syncStatus._set('expired')
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

// Update sync status on successful/failed cloud syncs by hooking into
// listFromCloud success/failure
const _origListFromCloud = foldersAPI.listFromCloud.bind(foldersAPI)
foldersAPI.listFromCloud = async function () {
    try {
        const result = await _origListFromCloud()
        syncStatus._set('synced')
        return result
    } catch (err) {
        if (err.status === 401) syncStatus._set('expired')
        else syncStatus._set('offline')
        throw err
    }
}

// ── Offline save queue ────────────────────────────────────────
// When a save fails while offline, stash {path, content} locally
// (last-write-wins per path) and replay it when the network returns.
const PENDING_SAVES_KEY = 'nc_pending_saves'

function _loadPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_SAVES_KEY)) || {} }
    catch { return {} }
}

function _savePending(map) {
    try { localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify(map)) } catch { /* quota */ }
}

export const offlineQueue = {
    // Returns array of pending file paths
    getPending() { return Object.keys(_loadPending()) },

    // Queue a write to retry later (keyed by path → last write wins)
    enqueue(path, content) {
        const map = _loadPending()
        map[path] = { content, queued_at: new Date().toISOString() }
        _savePending(map)
    },

    // Try to flush every queued write. Resolves to the number persisted.
    async flush() {
        const map = _loadPending()
        const paths = Object.keys(map)
        if (!paths.length) return 0
        let done = 0
        for (const path of paths) {
            try {
                await vaultAPI.writeFile(path, map[path].content)
                delete map[path]
                done++
            } catch {
                // Still failing — keep it queued and stop trying for now
                break
            }
        }
        _savePending(map)
        return done
    },
}

// ── Mobile foreground / network refresh ───────────────────────
// Background tabs on mobile have their timers suspended, so the 60s sync poll
// stops firing. Re-sync on foreground & online. (Token refresh needs no timers:
// the Firebase SDK refreshes ID tokens lazily whenever they're used.)
let _mobileHandlersEnabled = false

export function enableMobileRefreshHandlers() {
    if (_mobileHandlersEnabled) return  // register exactly once per session
    _mobileHandlersEnabled = true

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return
        syncStatus.check()
        offlineQueue.flush().then(n => { if (n) syncStatus.check() }).catch(() => {})
    })

    window.addEventListener('online', async () => {
        await offlineQueue.flush().catch(() => 0)
        syncStatus.check()
    })

    window.addEventListener('offline', () => syncStatus._set('offline'))
}

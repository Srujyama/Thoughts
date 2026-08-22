// src/api.js
// All data operations go straight to Firebase — Auth for sessions and Cloud
// Storage for vault files. Security rules enforce access; there is no
// application server.

import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
} from 'firebase/auth'
import {
    ref, listAll, getMetadata, uploadString, deleteObject,
} from 'firebase/storage'
import { fbAuth, storage, authReady, signInWithGoogle } from './firebase.js'
import { contentCache } from './cache.js'

const USER_KEY = 'nc_user'
const MAX_NOTE_BYTES = 5 * 1024 * 1024

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

// Point the content cache at the right account as soon as we know who it is,
// so a warm() at boot can only ever surface this user's notes.
const _cachedUser = (() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null }
})()
if (_cachedUser && _cachedUser.user_id) contentCache.setUser(_cachedUser.user_id)

// When the SDK finishes restoring the persisted session: if the app thought it
// was signed in but Firebase says otherwise, the session is gone — kick to login.
authReady.then(user => {
    if (user) {
        contentCache.setUser(user.uid)
        localStorage.setItem(USER_KEY, JSON.stringify({ user_id: user.uid, email: user.email }))
        // Warm the ID token now. Tokens live an hour, so the common "opened my
        // laptop the next morning" visit needs a securetoken round-trip — and
        // without this it happens *inside* the first vault listing, serialized
        // in front of it. Warming here overlaps it with bundle execution and
        // the first layout pass. Free when the token is still fresh: the SDK
        // answers from cache without issuing a request.
        user.getIdToken().catch(() => {})
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
    contentCache.setUser(user.uid)
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
        const user = await signInWithGoogle()
        return _storeUser(user)
    },

    async logout() {
        try { await signOut(fbAuth) } catch { /* no-op */ }
        localStorage.removeItem(USER_KEY)
        contentCache.clear().catch(() => {})
    },
}

// ── Vault / Files API ─────────────────────────────────────────
// Files are stored as: {folderPath}/{title}.md  (folderPath can be nested: a/b/c)
// In Cloud Storage each object lives at "{uid}/{relative_path}"; storage.rules
// limit every user to their own prefix.

function _fileRef(user, path) {
    return ref(storage, `${user.uid}/${path}`)
}

// Reject if a promise doesn't settle within `ms`, so a stalled network call
// can't leave the UI spinning forever.
function _withTimeout(promise, ms, message = 'Request timed out') {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(message)
            err.code = 'app/timeout'
            reject(err)
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Unlike Promise.race(), this actually cancels the network request when its
// deadline passes. That matters for note reads: Firebase Storage's SDK retries
// downloads internally, so racing getBytes() against a timer left the original
// requests alive. Six background prefetches could then keep retrying after the
// UI had reported a timeout and crowd out the note the user explicitly opened.
async function _fetchWithTimeout(url, options, ms, message) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
        return await fetch(url, { ...options, signal: controller.signal })
    } catch (err) {
        if (err && err.name === 'AbortError') {
            const timeout = new Error(message)
            timeout.code = 'app/timeout'
            throw timeout
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
}

function _storageObjectUrl(user, path) {
    const bucket = storage.app.options.storageBucket
    const objectName = `${user.uid}/${path}`
    return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}` +
        `/o/${encodeURIComponent(objectName)}?alt=media`
}

async function _readViaRest(user, path, forceRefresh = false) {
    const token = await _withTimeout(
        user.getIdToken(forceRefresh),
        10000,
        'Timed out refreshing your session',
    )
    const res = await _fetchWithTimeout(
        _storageObjectUrl(user, path),
        { headers: { Authorization: `Firebase ${token}` }, cache: 'no-store' },
        15000,
        `Timed out reading ${path}`,
    )

    // A stale token can survive in a long-running/backgrounded mobile tab.
    // Force one refresh, then surface a real auth failure if it still fails.
    if (res.status === 401 && !forceRefresh) return _readViaRest(user, path, true)
    if (res.status === 404) return { content: '', missing: true }
    if (!res.ok) {
        const err = new Error(`Could not read ${path} (${res.status})`)
        err.status = res.status
        throw err
    }
    return { content: await res.text(), missing: false }
}

// ── Listing the vault ─────────────────────────────────────────
// The SDK's listAll() walks one HTTP request per folder (it always passes
// delimiter='/') and then getMetadata() is another request per file — roughly
// 70 round-trips for this vault, all before a fresh browser can paint anything.
//
// The same REST endpoint with no delimiter returns the entire subtree flat in
// one response, so the whole vault arrives in a single request. Note the
// response carries only {name, bucket} per item — no size or mtime — so
// timestamps are backfilled later, off the critical path, by _backfillTimes().
// If the endpoint ever stops listing recursively we fall back to the SDK walk.
let _restListBroken = false

async function _listViaRest(user) {
    const token = await user.getIdToken()
    const bucket = storage.app.options.storageBucket
    const endpoint = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o`
    const prefix = `${user.uid}/`
    const files = []
    let pageToken = null
    let pages = 0

    do {
        let url = `${endpoint}?prefix=${encodeURIComponent(prefix)}&maxResults=1000`
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`

        const res = await _withTimeout(
            fetch(url, { headers: { Authorization: `Firebase ${token}` } }),
            20000,
            'Timed out listing your vault',
        )
        if (!res.ok) {
            const err = new Error(`Vault list failed (${res.status})`)
            err.status = res.status
            throw err
        }
        const data = await res.json()

        // A non-empty `prefixes` means the backend collapsed subfolders, i.e. it
        // applied a delimiter we didn't ask for — the listing would be missing
        // every nested note. Bail out to the SDK walk rather than show an empty
        // vault.
        if (Array.isArray(data.prefixes) && data.prefixes.length) {
            const err = new Error('Recursive listing not supported')
            err.code = 'app/list-delimited'
            throw err
        }

        for (const item of data.items || []) {
            const name = item && item.name
            if (typeof name !== 'string' || !name.startsWith(prefix)) continue
            files.push({
                path: name.slice(prefix.length),
                // Read defensively: these keys aren't on the wire today, but
                // costing nothing means we pick them up free if that changes.
                updated_at: item.updated || item.timeCreated || null,
                size: item.size != null ? Number(item.size) : null,
            })
        }
        pageToken = data.nextPageToken || null
    } while (pageToken && ++pages < 50)

    return files
}

// Fallback: the SDK's folder-by-folder walk. Still skips the per-file
// getMetadata() the old code did — that was one request per note for a
// timestamp label. _backfillTimes fetches those later, off the critical path.
async function _listViaSdk(user) {
    const prefixLen = user.uid.length + 1
    const files = []
    const walk = async (dirRef) => {
        const page = await listAll(dirRef)
        for (const item of page.items) {
            files.push({ path: item.fullPath.slice(prefixLen), updated_at: null, size: null })
        }
        await Promise.all(page.prefixes.map(walk))
    }
    await walk(ref(storage, user.uid))
    return files
}

export const vaultAPI = {
    // Returns raw flat list: [{ path, updated_at, size }, ...]
    async listFiles() {
        const user = await _requireUser()
        if (!_restListBroken) {
            try {
                return await _listViaRest(user)
            } catch (err) {
                // A 401/403 is a real auth problem, not a reason to retry the
                // slow path — surface it.
                if (err && (err.status === 401 || err.status === 403)) throw err
                // Only latch on evidence that the endpoint itself won't do what
                // we need. A timeout, a dropped connection, a 429 or a 5xx means
                // "try again", not "this API is unsupported" — latching on those
                // would strand the whole session on the ~70-request SDK walk.
                if (err && (err.code === 'app/list-delimited' || err.status === 400)) {
                    _restListBroken = true
                }
            }
        }
        return _withTimeout(_listViaSdk(user), 30000, 'Timed out listing your vault')
    },

    // Reads a file, reporting whether the object was actually there.
    // A missing object resolves to { content: '', missing: true } rather than
    // erroring — a freshly-created file whose upload hasn't propagated yet is
    // not a failure. Callers must not cache a `missing` result: treating "not
    // found" as "empty" is how a transient 404 blanks a real note. The read is
    // bounded by a timeout so a stalled request can't hang the UI forever.
    async readFileResult(path) {
        const user = await _requireUser()
        return _readViaRest(user, path)
    },

    // Returns file content as text (missing → ''), for callers that don't care
    // about the distinction.
    async readFile(path) {
        return (await vaultAPI.readFileResult(path)).content
    },

    async writeFile(path, content) {
        const user = await _requireUser()
        const bytes = assertNoteSize(content)
        await uploadString(_fileRef(user, path), content, 'raw', { contentType: 'text/markdown' })
        return { path, bytes }
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

// localStorage.setItem is synchronous and re-serialises the whole vault, so a
// burst of mutations (an import, a bulk delete) used to block the main thread
// once per file. Coalesce writes into the next frame instead; a pagehide flush
// keeps the last one from being lost.
let _metaWritePending = false
let _metaWriteScheduled = false

function _flushMeta() {
    if (!_metaWritePending) return
    _metaWritePending = false
    try { localStorage.setItem(_metaCacheKey, JSON.stringify(_metaCache)) }
    catch { /* quota — the in-memory copy is still authoritative this session */ }
}

window.addEventListener('pagehide', _flushMeta)
document.addEventListener('visibilitychange', () => { if (document.hidden) _flushMeta() })

// ── Cloud sync dedup — only one sync in-flight, and not more than one per
// SYNC_TTL, so navigating around the app doesn't re-list the vault repeatedly.
let _syncPromise = null
let _lastSyncAt = 0
const SYNC_TTL = 15_000

function metaKey() {
    const user = auth.getUser()
    return user ? `nc_vault_meta_${user.user_id}` : 'nc_vault_meta_anon'
}

function loadMeta() {
    const key = metaKey()
    // Return in-memory cache if available and same user
    if (_metaCache && _metaCacheKey === key) return _metaCache
    _flushMeta()
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
    _metaWritePending = true
    // Once the tab is hidden there may be no next frame — a save racing a tab
    // close has to land now, not on a callback that never fires.
    if (document.visibilityState === 'hidden') { _flushMeta(); return }
    if (_metaWriteScheduled) return
    _metaWriteScheduled = true
    requestAnimationFrame(() => { _metaWriteScheduled = false; _flushMeta() })
}

function uid() { return crypto.randomUUID() }

function slug(name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid()
}

function cleanLabel(value, kind, maxLength = 200) {
    const label = String(value ?? '').trim()
    if (!label) throw new Error(`${kind} cannot be empty`)
    if (label.length > maxLength) throw new Error(`${kind} must be ${maxLength} characters or fewer`)
    return label
}

function assertNoteSize(content) {
    const bytes = new TextEncoder().encode(String(content ?? '')).byteLength
    if (bytes > MAX_NOTE_BYTES) {
        const err = new Error('Note is too large to sync (5 MB maximum)')
        err.code = 'app/file-too-large'
        throw err
    }
    return bytes
}

// Ensure a folder exists for each segment of a path, returning the leaf folder.
// e.g. "notes/archive/2024" creates/finds folders for notes, notes/archive, notes/archive/2024
function ensureFolderPath(folderPath, meta, index) {
    const segments = folderPath.split('/')
    let parentId = null
    let currentPath = ''
    let folder = null

    for (const seg of segments) {
        currentPath = currentPath ? `${currentPath}/${seg}` : seg
        folder = index ? index.get(currentPath) : meta.folders.find(f => f.path === currentPath)
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
            if (index) index.set(currentPath, folder)
        }
        parentId = folder.id
    }
    return folder
}

// Merge a raw vault file list into the local folder/file meta cache.
// Indexed by path so a 70-object vault costs one pass, not one linear scan of
// every folder per file.
function syncMetaFromCloud(rawFiles, meta) {
    // Migrate old-style folders (no .path field) to new style
    for (const folder of meta.folders) {
        if (!folder.path) {
            folder.path = folder.slug || slug(folder.name)
            folder.parentId = folder.parentId ?? null
        }
    }

    // A successful cloud listing is authoritative. Remove stale local file
    // records (including deletions made on another device), but preserve any
    // optimistic writes that are still queued locally and therefore may not be
    // visible in Storage yet.
    const cloudPaths = new Set(rawFiles.map(item => item.path).filter(Boolean))
    const pendingPaths = new Set(offlineQueue.getPending())
    for (const folder of meta.folders) {
        folder.files = folder.files.filter(file => {
            const keep = cloudPaths.has(file.path) || pendingPaths.has(file.path)
            if (!keep) contentCache.delete(file.path)
            return keep
        })
    }

    const byFolderPath = new Map(meta.folders.map(f => [f.path, f]))
    const byFilePath = new Map()
    for (const folder of meta.folders) {
        for (const file of folder.files) byFilePath.set(file.path, file)
    }

    for (const item of rawFiles) {
        const path = item.path
        if (!path || !path.includes('/')) continue   // skip root-level files
        if (path.endsWith('/.keep')) {
            // Ensure the folder exists in meta even if it has no files yet
            ensureFolderPath(path.replace(/\/\.keep$/, ''), meta, byFolderPath)
            continue
        }
        // Only process .md files
        if (!path.endsWith('.md')) continue

        const known = byFilePath.get(path)
        if (known) {
            if (item.updated_at) known.updated_at = item.updated_at
            continue
        }

        // New file from cloud — determine its folder (all segments except last)
        const parts = path.split('/')
        const fileName = parts[parts.length - 1]
        const folder = ensureFolderPath(parts.slice(0, -1).join('/'), meta, byFolderPath)

        const file = {
            id: uid(),
            title: fileName.replace(/\.md$/, '').replace(/-/g, ' '),
            path,
            content: '',
            contentLoaded: false,
            created_at: item.updated_at || new Date().toISOString(),
            // Left null when the listing didn't carry a time — the files view
            // renders that as "—" rather than lying with "just now", and
            // _backfillTimes fills it in from the background pass.
            updated_at: item.updated_at || null,
        }
        folder.files.unshift(file)
        byFilePath.set(path, file)
    }

    return meta
}

// ── Background content prefetch ───────────────────────────────
// Once we know what's in the vault, quietly pull every note into the persistent
// cache. Notes are small (this vault is ~300KB in total), the requests are
// idle-scheduled so they don't compete with the first paint, and afterwards
// opening any note is a synchronous cache hit instead of a round-trip.
const PREFETCH_MAX_FILES = 400
const PREFETCH_CONCURRENCY = 6
let _prefetchBusy = false

function _onIdle(fn, timeout = 2000) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout })
    else setTimeout(fn, 250)
}

// Reads currently in flight, keyed by path, so the foreground folder prefetch
// and the background sweep never fetch the same note twice.
const _inFlightReads = new Map()

// Bumped whenever this browser writes a note. A prefetch response that comes
// back after a save has stale content, and caching it would silently roll the
// save back in memory and in IndexedDB — so compare the counter across the
// request and drop the response if it moved.
const _writeSeq = new Map()

function _noteLocalWrite(path) {
    _writeSeq.set(path, (_writeSeq.get(path) || 0) + 1)
}

function _prefetchOne(path, skip) {
    if (contentCache.getSync(path)) return Promise.resolve(false)
    if (skip && skip.has(path)) return Promise.resolve(false)
    const existing = _inFlightReads.get(path)
    if (existing) return existing

    const seqBefore = _writeSeq.get(path) || 0
    const p = (async () => {
        try {
            const { content, missing } = await vaultAPI.readFileResult(path)
            if (missing) return false                       // never cache a 404 as an empty note
            if ((_writeSeq.get(path) || 0) !== seqBefore) return false   // a save won the race
            contentCache.set(path, content)
            return true
        } catch {
            return false                                    // it'll just load on demand
        } finally {
            _inFlightReads.delete(path)
        }
    })()
    _inFlightReads.set(path, p)
    return p
}

async function _prefetchContents(paths, concurrency = PREFETCH_CONCURRENCY) {
    // Never race a write we already know about: anything queued for upload has
    // local content that is newer than whatever the cloud would hand back.
    const skip = new Set(offlineQueue.getPending())
    const todo = paths.filter(p => !contentCache.getSync(p) && !skip.has(p))
    if (!todo.length) return 0
    let i = 0
    let done = 0
    const worker = async () => {
        while (i < todo.length) {
            if (await _prefetchOne(todo[i++], skip)) done++
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, todo.length) }, worker),
    )
    return done
}

function _schedulePrefetch(folders) {
    if (_prefetchBusy) return
    const files = folders.flatMap(f => f.files).filter(f => f.path)
    if (!files.length || files.length > PREFETCH_MAX_FILES) return
    _prefetchBusy = true
    // Wait for the IndexedDB warm-up before deciding what's missing — otherwise
    // a browser that already has the whole vault cached re-downloads all of it
    // because getSync hasn't been populated yet.
    cacheReady
        .then(() => new Promise(resolve => _onIdle(resolve)))
        .then(() => {
            const paths = files.map(f => f.path)
            if (!paths.some(p => !contentCache.getSync(p))) return 0
            return _prefetchContents(paths)
        })
        .catch(() => {})
        .finally(() => { _prefetchBusy = false })
}

export const foldersAPI = {
    async listFromCloud() {
        // Reuse an in-flight sync rather than firing a second identical listing.
        if (_syncPromise) return _syncPromise
        // Every visit to the folders view calls this. Bouncing between views
        // shouldn't re-list the vault each time — the 60s poll and the
        // foreground/online handlers cover genuine freshness.
        if (Date.now() - _lastSyncAt < SYNC_TTL) return loadMeta().folders
        _syncPromise = (async () => {
            try {
                const rawFiles = await vaultAPI.listFiles()
                let meta = loadMeta()
                meta = syncMetaFromCloud(rawFiles, meta)
                saveMeta(meta)
                _lastSyncAt = Date.now()
                _schedulePrefetch(meta.folders)
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

    // Pull one folder's notes into the cache right now, ahead of the idle sweep.
    // The user's path is grid → folder → note, so by the time they've read the
    // filenames the note they click is already local — a same-frame open instead
    // of a spinner and a round-trip. Deliberately narrow and low-concurrency:
    // these share one HTTP/2 connection with whatever the user opens next.
    prefetchFolder(folderId) {
        const folder = loadMeta().folders.find(f => f.id === folderId)
        if (!folder) return Promise.resolve(0)
        const paths = folder.files.map(f => f.path).filter(Boolean)
        if (!paths.length) return Promise.resolve(0)
        return cacheReady
            .then(() => _prefetchContents(paths, 3))
            .catch(() => 0)
    },

    // Fill in modification times for one folder's notes. The flat listing
    // carries no timestamps, and fetching them for the whole vault cost one
    // request per note (plus a CORS preflight each) — about half of all
    // cold-load traffic, for a "3 days ago" label. Now only the folder actually
    // on screen pays, and only once.
    async backfillTimes(folderId, onDone) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) return
        const unknown = folder.files.filter(f => f.path && !f.updated_at)
        if (!unknown.length) return
        let user
        try { user = await _requireUser() } catch { return }

        let i = 0
        let filled = 0
        const worker = async () => {
            while (i < unknown.length) {
                const file = unknown[i++]
                try {
                    const stat = await getMetadata(_fileRef(user, file.path))
                    if (stat && stat.updated) { file.updated_at = stat.updated; filled++ }
                } catch { /* a note we can't stat just shows no timestamp */ }
            }
        }
        await Promise.all(
            Array.from({ length: Math.min(PREFETCH_CONCURRENCY, unknown.length) }, worker),
        )
        if (!filled) return
        saveMeta(meta)
        // Without this the labels stay "—" until something else happens to
        // repaint the view.
        if (onDone) onDone(folder)
    },

    // Optimistic: the folder shows up immediately and its cloud marker is
    // written in the background, so "New folder" doesn't wait on an upload.
    async create(name, parentId = null) {
        const meta = loadMeta()
        const parent = parentId ? meta.folders.find(f => f.id === parentId) : null
        const cleanName = cleanLabel(name, 'Folder name', 100)
        const base = slug(cleanName)
        const taken = new Set(meta.folders.map(f => f.path))
        const prefix = parent ? `${parent.path}/` : ''
        let folderPath = `${prefix}${base}`
        for (let n = 2; taken.has(folderPath); n++) folderPath = `${prefix}${base}-${n}`

        const folder = {
            id: uid(),
            name: cleanName,
            path: folderPath,
            parentId: parentId || null,
            created_at: new Date().toISOString(),
            files: [],
        }
        meta.folders.push(folder)
        saveMeta(meta)
        backgroundWrite(folderPath + '/.keep', '')
        return folder
    },

    rename(folderId, newName) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        folder.name = cleanLabel(newName, 'Folder name', 100)
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
        allFiles.forEach(f => contentCache.delete(f.path))
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

        // Delete in parallel batches instead of strictly one at a time — the
        // progress bar still ticks, but a 60-file folder no longer takes 60
        // sequential round-trips.
        const BATCH = 8
        for (let i = 0; i < allPaths.length; i += BATCH) {
            const batch = allPaths.slice(i, i + BATCH)
            await Promise.all(batch.map(async path => {
                await vaultAPI.deleteFile(path).catch(() => {})
                contentCache.delete(path)
                done++
                if (onProgress) onProgress(done, total)
            }))
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

    // Synchronous cache peek. Fills in `file.content` from the persistent cache
    // if we already have the note, so the editor can render on the same frame
    // as the click instead of showing "Loading file...". Returns true on a hit.
    peekCached(folderId, fileId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) return false
        const file = folder.files.find(f => f.id === fileId)
        if (!file || file.contentLoaded) return !!file?.contentLoaded
        const hit = contentCache.getSync(file.path)
        if (!hit) return false
        file.content = hit.content
        file.contentLoaded = true
        return true
    },

    // Optimistic: the note exists locally (and in the content cache) the moment
    // this returns, so the editor opens instantly. The upload happens in the
    // background and is queued for retry if it fails.
    async create(folderId, title, content = '') {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')

        // Two notes titled the same slug to the same object. Before, the second
        // upload silently overwrote the first; now that the write happens in the
        // background there'd be no error at all to notice. Pick a free name.
        const cleanTitle = cleanLabel(title, 'File title')
        assertNoteSize(content)
        const base = slug(cleanTitle)
        const taken = new Set(folder.files.map(f => f.path))
        let path = `${folder.path}/${base}.md`
        for (let n = 2; taken.has(path); n++) path = `${folder.path}/${base}-${n}.md`

        const now = new Date().toISOString()
        const file = {
            id: uid(),
            title: cleanTitle,
            path,
            content,
            contentLoaded: true,
            created_at: now,
            updated_at: now,
        }
        folder.files.unshift(file)
        saveMeta(meta)
        _noteLocalWrite(path)
        contentCache.set(path, content)
        backgroundWrite(path, content)
        return file
    },

    // Stale-while-revalidate: a cached note resolves on the next microtask and
    // the cloud copy is checked in the background, calling `onFresh` only if it
    // actually differs. Only a genuine cache miss waits on the network.
    async loadContent(folderId, fileId, onFresh) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const file = folder.files.find(f => f.id === fileId)
        if (!file) throw new Error('File not found')

        const cached = contentCache.getSync(file.path)
        if (cached) {
            file.content = cached.content
            file.contentLoaded = true
            saveMeta(meta)
            _revalidate(file, meta, onFresh)
            return file
        }

        const { content: fresh, missing } = await vaultAPI.readFileResult(file.path)
        if (missing) {
            const err = new Error('This note no longer exists in the cloud')
            err.code = 'app/file-missing'
            throw err
        }
        file.content = fresh
        file.contentLoaded = true
        // Don't cache a 404 as an empty note — the object may simply not have
        // propagated yet, and a cached '' would then be served forever.
        if (!missing) contentCache.set(file.path, fresh)
        saveMeta(meta)
        return file
    },

    async update(folderId, fileId, { title, content }) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const file = folder.files.find(f => f.id === fileId)
        if (!file) throw new Error('File not found')

        if (title !== undefined) file.title = cleanLabel(title, 'File title')
        if (content !== undefined) {
            assertNoteSize(content)
            file.content = content
            _noteLocalWrite(file.path)      // invalidate any prefetch in flight
            contentCache.set(file.path, content)
            try {
                await vaultAPI.writeFile(file.path, content)
            } catch (err) {
                // The IndexedDB cache already holds this edit; queue it now as
                // well so a tab close immediately after an offline save cannot
                // strand the only durable copy on this device.
                offlineQueue.enqueue(file.path, content)
                file.updated_at = new Date().toISOString()
                saveMeta(meta)
                throw err
            }
            // This save supersedes anything still queued for the path — an
            // optimistic create's queued body, or an earlier failed save.
            // Leaving it queued would let a later flush overwrite what we just
            // wrote with older content.
            offlineQueue.dequeue(file.path)
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
        if (file) {
            await vaultAPI.deleteFile(file.path)
            contentCache.delete(file.path)
        }
        folder.files = folder.files.filter(f => f.id !== fileId)
        saveMeta(meta)
    },

    // Drop a stale local record after an authoritative 404 without issuing a
    // second cloud delete. Used by the editor recovery path.
    forgetLocal(folderId, fileId) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) return
        const file = folder.files.find(f => f.id === fileId)
        if (file) contentCache.delete(file.path)
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
        const oldPath = file.path
        const taken = new Set(targetFolder.files.map(f => f.path))
        const stem = fileName.replace(/\.md$/, '')
        let newPath = `${targetFolder.path}/${fileName}`
        for (let n = 2; taken.has(newPath); n++) newPath = `${targetFolder.path}/${stem}-${n}.md`

        // Read content, write to new path, delete old
        let content = file.content || ''
        if (!file.contentLoaded) {
            const cached = contentCache.getSync(oldPath)
            if (cached) content = cached.content
            else {
                const result = await vaultAPI.readFileResult(oldPath)
                if (result.missing) throw new Error('Cannot move a note that no longer exists in the cloud')
                content = result.content
            }
        }
        await vaultAPI.writeFile(newPath, content)
        try {
            await vaultAPI.deleteFile(oldPath)
        } catch (err) {
            // Keep a failed move atomic from the user's point of view. If the
            // old object could not be removed, roll back the newly-written copy
            // instead of creating a duplicate on the next cloud sync.
            await vaultAPI.deleteFile(newPath).catch(() => {})
            throw err
        }
        contentCache.rename(oldPath, newPath)

        file.path = newPath
        sourceFolder.files.splice(fileIdx, 1)
        targetFolder.files.unshift(file)
        saveMeta(meta)
        return file
    },
}

// The body of a note, wherever it currently lives. The background prefetch
// fills the content cache without touching the meta records, so anything that
// reads `file.content` straight off a meta record (backlinks, the graph, tag
// search) would see '' for every note the user hasn't opened — even with the
// whole vault cached locally. Read through here instead.
export function contentFor(file) {
    if (!file) return ''
    if (file.content) return file.content
    if (!file.path) return ''
    const hit = contentCache.getSync(file.path)
    return hit ? hit.content : ''
}

// Check the cloud copy of an already-cached note without making the caller wait.
function _revalidate(file, meta, onFresh) {
    vaultAPI.readFileResult(file.path)
        .then(({ content: fresh, missing }) => {
            // The object isn't there (yet). That is not evidence the note is
            // empty — keep what we have rather than blanking it.
            if (missing) return
            if (fresh === file.content) return
            // Likewise never let an empty read replace content we already hold.
            if (fresh === '' && file.content) return
            file.content = fresh
            file.contentLoaded = true
            contentCache.set(file.path, fresh)
            saveMeta(meta)
            if (onFresh) onFresh(file)
        })
        .catch(() => { /* offline — the cached copy stands */ })
}

// ── Sync status ──────────────────────────────────────────────
// Tracks whether the app can reach the backend and the session is valid.
// States: 'synced' | 'checking' | 'offline' | 'expired'

let _syncStatus = 'checking'
let _syncListeners = []
let _syncCheckTimer = null
let _syncInitialTimer = null

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
        // Don't probe on the same tick as boot: the first vault listing is the
        // request that matters and it reports the same information. Hold the
        // probe until the critical path is clear.
        if (_syncCheckTimer) clearInterval(_syncCheckTimer)
        if (_syncInitialTimer) clearTimeout(_syncInitialTimer)
        _syncInitialTimer = setTimeout(() => {
            _syncInitialTimer = null
            if (_syncStatus === 'checking') syncStatus.check()
            // Replay anything stranded by a previous session.
            if (offlineQueue.getPending().length) offlineQueue.flush().catch(() => {})
        }, 3000)
        _syncCheckTimer = setInterval(() => syncStatus.check(), 60_000)
    },

    stopPolling() {
        if (_syncCheckTimer) { clearInterval(_syncCheckTimer); _syncCheckTimer = null }
        if (_syncInitialTimer) { clearTimeout(_syncInitialTimer); _syncInitialTimer = null }
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
const LEGACY_PENDING_SAVES_KEY = 'nc_pending_saves'

function pendingSavesKey() {
    const user = auth.getUser()
    return user ? `nc_pending_saves_${user.user_id}` : 'nc_pending_saves_anon'
}

function _loadPending() {
    try {
        const key = pendingSavesKey()
        const scoped = localStorage.getItem(key)
        if (scoped) return JSON.parse(scoped) || {}

        // One-time migration from the original global queue. Attribute it only
        // when a user is currently known; otherwise leave it untouched until
        // authentication restoration completes.
        const user = auth.getUser()
        const legacy = user && localStorage.getItem(LEGACY_PENDING_SAVES_KEY)
        if (!legacy) return {}
        const parsed = JSON.parse(legacy) || {}
        localStorage.setItem(key, JSON.stringify(parsed))
        localStorage.removeItem(LEGACY_PENDING_SAVES_KEY)
        return parsed
    } catch { return {} }
}

function _savePending(map) {
    try { localStorage.setItem(pendingSavesKey(), JSON.stringify(map)) } catch { /* quota */ }
}

let _flushPromise = null

export const offlineQueue = {
    // Returns array of pending file paths
    getPending() { return Object.keys(_loadPending()) },

    // Queue a write to retry later (keyed by path → last write wins)
    enqueue(path, content) {
        const map = _loadPending()
        map[path] = { content, queued_at: new Date().toISOString() }
        _savePending(map)
    },

    dequeue(path) {
        const map = _loadPending()
        if (!(path in map)) return
        delete map[path]
        _savePending(map)
    },

    // Drop a queued write only if it is still the one we just persisted. A newer
    // edit that landed in the queue meanwhile must survive, or replaying the
    // queue would resurrect stale content over it.
    dequeueIfUnchanged(path, content) {
        const map = _loadPending()
        const entry = map[path]
        if (!entry || entry.content !== content) return
        delete map[path]
        _savePending(map)
    },

    // Try to flush every queued write. Resolves to the number persisted.
    //
    // Three separate triggers can call this (visibilitychange, online, and a
    // successful reachability probe), so it has to be re-entrant-safe: two
    // overlapping flushes each holding a snapshot of the queue would let the
    // slower one write its stale snapshot back, resurrecting writes the other
    // already drained and replaying them over newer content.
    flush() {
        if (_flushPromise) return _flushPromise
        _flushPromise = (async () => {
            let done = 0
            try {
                for (const path of Object.keys(_loadPending())) {
                    // Re-read per iteration: an edit saved mid-flush may have
                    // superseded or removed this entry.
                    const entry = _loadPending()[path]
                    if (!entry) continue
                    try {
                        await vaultAPI.writeFile(path, entry.content)
                    } catch {
                        // Still failing — keep it queued and stop trying for now
                        break
                    }
                    offlineQueue.dequeueIfUnchanged(path, entry.content)
                    done++
                }
            } finally {
                _flushPromise = null
            }
            return done
        })()
        return _flushPromise
    },
}

// Fire-and-forget upload used by the optimistic create paths. The write is
// queued *before* it's attempted, so closing the tab mid-upload leaves it to be
// replayed next session rather than losing it; a success dequeues it.
function backgroundWrite(path, content) {
    offlineQueue.enqueue(path, content)
    vaultAPI.writeFile(path, content)
        .then(() => offlineQueue.dequeueIfUnchanged(path, content))
        .catch(() => { syncStatus._set('offline') })
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
        _lastSyncAt = 0     // the vault may have moved on — re-list on the next view
        syncStatus.check()
        offlineQueue.flush().then(n => { if (n) syncStatus.check() }).catch(() => {})
    })

    window.addEventListener('online', async () => {
        _lastSyncAt = 0
        await offlineQueue.flush().catch(() => 0)
        syncStatus.check()
    })

    window.addEventListener('offline', () => syncStatus._set('offline'))
}

// ── Boot: warm the note cache ─────────────────────────────────
// One IndexedDB pass pulls this browser's cached notes into memory before the
// user can click anything, so a returning visit opens notes with no network at
// all. Exported so the app can await it when it needs to be sure.
export const cacheReady = contentCache.warm().catch(() => 0)

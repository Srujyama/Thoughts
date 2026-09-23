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

// ── Storage-full callback (set by main.js to warn the user) ──
// localStorage is a hard ~5 MB per origin. Once it is full every write here
// fails, including the offline queue's rescue copies, and the user has no way
// of knowing unless we tell them.
let _onStorageFull = null

export function setStorageFullHandler(handler) {
    _onStorageFull = handler
}

function _storageFull(err) {
    if (_onStorageFull) _onStorageFull(err)
}

// Point the content cache at the right account as soon as we know who it is,
// so a warm() at boot can only ever surface this user's notes.
const _cachedUser = (() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null }
})()
if (_cachedUser && _cachedUser.user_id) contentCache.setUser(_cachedUser.user_id)

// Whose vault this browser holds. Every localStorage key is derived from this
// rather than from the live session, because an expiring token clears the
// session synchronously: keys read after that point would flip to "anon", and
// the rescue copy of a save that failed for the very same reason would land
// under a key nothing ever reads again. An expiry means "sign in again as the
// same person", so only an explicit sign-out clears it.
let _lastKnownUid = (_cachedUser && _cachedUser.user_id) || null

function _currentUid() {
    return _lastKnownUid || auth.getUser()?.user_id || null
}

// When the SDK finishes restoring the persisted session: if the app thought it
// was signed in but Firebase says otherwise, the session is gone — kick to login.
authReady.then(user => {
    if (user) {
        _lastKnownUid = user.uid
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
    // Signing in as somebody else happens without a reload, so the module-level
    // sync state has to be dropped by hand — otherwise the new account inherits
    // the previous one's freshness window (and sees an empty vault reported as
    // a successful sync) or its in-flight listing (and gets the other account's
    // folder names written into its own meta).
    if ((auth.getUser()?.user_id || null) !== user.uid) _resetSyncState()
    _lastKnownUid = user.uid
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
        _flushMeta()   // land any coalesced meta write under the outgoing user's key
        try { await signOut(fbAuth) } catch { /* no-op */ }
        localStorage.removeItem(USER_KEY)
        _lastKnownUid = null
        _resetSyncState()
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

    // A truncated listing must never be returned: syncMetaFromCloud treats a
    // successful listing as authoritative and deletes every local record that
    // isn't in it, so handing back a partial page would erase the tail of the
    // vault from this device. Fail instead and let the SDK walk take over.
    if (pageToken) {
        const err = new Error('Vault listing was truncated')
        err.code = 'app/list-truncated'
        throw err
    }

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
    // Note bodies belong to the content cache, which is backed by IndexedDB and
    // has room for them. Persisting a second copy of every note the user has
    // ever opened into this one localStorage key pushed a real vault past the
    // origin's ~5 MB budget, after which every write here — and every rescue
    // copy the offline queue tried to make — failed. Bodies stay in the
    // in-memory meta; only the records are written to disk.
    const payload = JSON.stringify(
        _metaCache,
        (key, value) => (key === 'content' || key === 'contentLoaded' ? undefined : value),
    )
    try { localStorage.setItem(_metaCacheKey, payload) }
    catch (err) { _storageFull(err) }   // the in-memory copy is still authoritative this session
}

window.addEventListener('pagehide', _flushMeta)
document.addEventListener('visibilitychange', () => { if (document.hidden) _flushMeta() })

// ── Cloud sync dedup — only one sync in-flight, and not more than one per
// SYNC_TTL, so navigating around the app doesn't re-list the vault repeatedly.
let _syncPromise = null
let _syncUid = null
let _lastSyncAt = 0
const SYNC_TTL = 15_000

// Everything here describes one account's vault, so it must not outlive that
// account's session.
function _resetSyncState() {
    _syncPromise = null
    _syncUid = null
    _lastSyncAt = 0
    _inFlightReads.clear()   // keyed by path alone: a read started as A must not be handed to B
    _writeSeq.clear()
}

function metaKey() {
    const uid = _currentUid()
    return uid ? `nc_vault_meta_${uid}` : 'nc_vault_meta_anon'
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
function syncMetaFromCloud(rawFiles, meta, listedAt = Date.now()) {
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
            // A note created after the listing was taken cannot be in it, and
            // an optimistic upload that finished in the meantime has already
            // left the queue — so neither set vouches for it. Pruning it threw
            // away a note the user had just made, deleted its cached body, and
            // left the open editor saving to a record that no longer existed.
            if (isTrashPath(file.path)) return false
            const createdAfterListing = file.created_at && Date.parse(file.created_at) >= listedAt
            const keep = cloudPaths.has(file.path) || pendingPaths.has(file.path) || createdAfterListing
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
        if (isTrashPath(path)) continue              // the recycle bin is not a folder
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

// Cloud Storage has no preconditions on an upload, so two PUTs to one object
// are resolved by arrival order, not by age: a queued write replayed by a flush
// could land *after* the save that superseded it and leave the older body in
// the cloud while the editor shows the newer one. Every writer takes this lock
// for the path it touches, so writes to one note are strictly ordered.
const _writeLocks = new Map()

function _withPathLock(path, fn) {
    const prev = _writeLocks.get(path) || Promise.resolve()
    const result = prev.then(() => fn(), () => fn())
    const tail = result.catch(() => {})
    _writeLocks.set(path, tail)
    tail.then(() => { if (_writeLocks.get(path) === tail) _writeLocks.delete(path) })
    return result
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

// ── Recycle bin ───────────────────────────────────────────────
// Deleting a note moves its object under `.trash/` instead of destroying it.
// The object's NAME carries everything the bin needs — when it was deleted and
// where it came from — so listing the bin costs one request rather than one per
// item, and nothing about it lives in localStorage where a cache clear could
// lose it. Items older than the retention window are swept on the next listing.
const TRASH_PREFIX = '.trash'
const TRASH_RETENTION_DAYS = 30
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

export const trashRetentionDays = TRASH_RETENTION_DAYS

// base64url: an original path's slashes would otherwise create real folders
// inside `.trash/`, and its name has to survive a round trip exactly.
function _b64urlEncode(str) {
    let bin = ''
    for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b)
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function _b64urlDecode(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
}

function _trashPathFor(originalPath, deletedAt) {
    return `${TRASH_PREFIX}/${deletedAt}__${_b64urlEncode(originalPath)}.md`
}

export function isTrashPath(path) {
    return typeof path === 'string' && path.startsWith(TRASH_PREFIX + '/')
}

function _parseTrashPath(path) {
    if (!isTrashPath(path) || !path.endsWith('.md')) return null
    const stem = path.slice(TRASH_PREFIX.length + 1, -3)
    const sep = stem.indexOf('__')
    if (sep === -1) return null
    const deletedAt = Number(stem.slice(0, sep))
    if (!Number.isFinite(deletedAt) || deletedAt <= 0) return null
    try {
        const originalPath = _b64urlDecode(stem.slice(sep + 2))
        if (!originalPath) return null
        return { trashPath: path, deletedAt, originalPath }
    } catch { return null }
}

// Send one object to the bin: copy it under `.trash/`, prove the copy landed,
// and only then remove the original — the same discipline as a move, because a
// delete that cannot be undone is exactly what the bin exists to prevent.
async function _trashObject(path, knownBody = null) {
    const queued = _loadPending()[path]
    let body = queued ? queued.content : knownBody
    if (body == null) {
        const result = await vaultAPI.readFileResult(path)
        if (result.missing) return null          // already gone; nothing to keep
        body = result.content
    }

    const trashPath = _trashPathFor(path, Date.now())
    await vaultAPI.writeFile(trashPath, body)
    const check = await vaultAPI.readFileResult(trashPath)
    if (check.missing || check.content !== body) {
        await vaultAPI.deleteFile(trashPath).catch(() => {})
        throw new Error(`Could not move "${path}" to the recycle bin — it was left in place`)
    }

    offlineQueue.dequeue(path)
    try {
        await _withPathLock(path, () => vaultAPI.deleteFile(path))
    } catch (err) {
        // The original could not be removed, so the bin copy is a duplicate.
        await vaultAPI.deleteFile(trashPath).catch(() => {})
        if (queued) offlineQueue.enqueue(path, queued.content)
        throw err
    }
    contentCache.delete(path)
    return { path, trashPath, body }
}

export const trashAPI = {
    retentionDays: TRASH_RETENTION_DAYS,

    // Everything in the bin, newest first. Anything past its retention window
    // is swept here rather than on a timer — the app has no server to run one.
    async list({ sweep = true } = {}) {
        const raw = await vaultAPI.listFiles()
        const now = Date.now()
        const items = []
        const expired = []
        for (const item of raw) {
            const parsed = _parseTrashPath(item.path)
            if (!parsed) continue
            if (now - parsed.deletedAt >= TRASH_RETENTION_MS) { expired.push(parsed.trashPath); continue }
            const name = parsed.originalPath.split('/').pop()
            items.push({
                ...parsed,
                title: name.replace(/\.md$/, '').replace(/-/g, ' '),
                folderPath: parsed.originalPath.split('/').slice(0, -1).join('/'),
                size: item.size,
                expiresAt: parsed.deletedAt + TRASH_RETENTION_MS,
            })
        }
        if (sweep && expired.length) {
            await Promise.all(expired.map(p => vaultAPI.deleteFile(p).catch(() => {})))
        }
        items.sort((a, b) => b.deletedAt - a.deletedAt)
        return items
    },

    // Put a note back where it came from. If something has since taken that
    // name, the restored copy gets a free one rather than overwriting it.
    async restore(trashPath) {
        const parsed = _parseTrashPath(trashPath)
        if (!parsed) throw new Error('Not a recycle bin item')
        const result = await vaultAPI.readFileResult(trashPath)
        if (result.missing) throw new Error('That item is no longer in the recycle bin')

        const dir = parsed.originalPath.split('/').slice(0, -1).join('/')
        const name = parsed.originalPath.split('/').pop()
        const stem = name.replace(/\.md$/, '')
        const target = await _freeCloudPath(dir, stem, parsed.originalPath, null)

        await vaultAPI.writeFile(target, result.content)
        const check = await vaultAPI.readFileResult(target)
        if (check.missing || check.content !== result.content) {
            await vaultAPI.deleteFile(target).catch(() => {})
            throw new Error('Could not restore that note — it is still in the recycle bin')
        }
        // The folder may have been deleted along with it; its marker has to
        // come back or the folder won't exist on any other device.
        if (dir) await vaultAPI.writeFile(`${dir}/.keep`, '').catch(() => {})

        const meta = loadMeta()
        const folder = ensureFolderPath(dir, meta)
        if (!folder.files.some(f => f.path === target)) {
            folder.files.unshift({
                id: uid(),
                title: target.split('/').pop().replace(/\.md$/, '').replace(/-/g, ' '),
                path: target,
                content: result.content,
                contentLoaded: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
        }
        saveMeta(meta)
        contentCache.set(target, result.content)
        _noteLocalWrite(target)

        await vaultAPI.deleteFile(trashPath).catch(() => {})
        return { path: target, renamed: target !== parsed.originalPath }
    },

    // Permanently remove one item. Past this point only the bucket's own
    // soft-delete window can bring it back.
    async purge(trashPath) {
        if (!_parseTrashPath(trashPath)) throw new Error('Not a recycle bin item')
        await vaultAPI.deleteFile(trashPath)
    },

    async empty() {
        const items = await trashAPI.list({ sweep: false })
        await Promise.all(items.map(i => vaultAPI.deleteFile(i.trashPath).catch(() => {})))
        return items.length
    },
}

// ── Folder relocation ─────────────────────────────────────────
// Cloud Storage has no folders: a "folder" is a path prefix plus a .keep
// marker, so moving or renaming one means rewriting every object underneath it.
// Everything is copied and verified BEFORE anything is deleted, so a failure
// part-way through leaves the original tree untouched rather than half-moved.

function _uniqueFolderPath(meta, wanted, selfId) {
    const taken = new Set(meta.folders.filter(f => f.id !== selfId).map(f => f.path))
    if (!taken.has(wanted)) return wanted
    const parent = wanted.includes('/') ? wanted.slice(0, wanted.lastIndexOf('/') + 1) : ''
    const leaf = wanted.slice(parent.length)
    for (let n = 2; ; n++) {
        const candidate = `${parent}${leaf}-${n}`
        if (!taken.has(candidate)) return candidate
    }
}

// Newest body for a note, preferring an unflushed local write over the cloud.
async function _authoritativeBody(file) {
    const queued = _loadPending()[file.path]
    if (queued) return queued.content
    const result = await vaultAPI.readFileResult(file.path)
    if (result.missing) {
        const local = (file.contentLoaded && file.content) || contentCache.getSync(file.path)?.content
        if (local) return local
        return null            // genuinely gone — skip it rather than write a blank
    }
    if (file.contentLoaded && file.content && file.content !== result.content) return file.content
    return result.content
}

async function _relocateFolder(meta, folder, newPath) {
    const oldPath = folder.path
    if (oldPath === newPath) return

    // Every folder in the moved subtree, with its new path. Collected by path
    // prefix rather than by parentId: a folder restored from an older meta
    // format can sit at a nested path with parentId still null, and walking
    // links alone would leave it (and its notes) behind at the old location.
    const subtree = meta.folders
        .filter(f => f.path === oldPath || f.path.startsWith(oldPath + '/'))
        .map(f => ({ folder: f, oldPath: f.path, newPath: newPath + f.path.slice(oldPath.length) }))
        .sort((a, b) => a.oldPath.length - b.oldPath.length)   // parents before children

    // Phase 1 — copy every note and .keep to its new location, and verify.
    // Destination names are checked against Storage, not just against this
    // browser's meta: a note another device put at the wanted path would
    // otherwise be overwritten with no trace, which is the same class of silent
    // loss the single-note move already guards against.
    const moved = []
    const keepsCreated = []
    try {
        for (const node of subtree) {
            const keep = `${node.newPath}/.keep`
            if ((await vaultAPI.readFileResult(keep)).missing) {
                await vaultAPI.writeFile(keep, '')
                keepsCreated.push(keep)
            }
            for (const file of node.folder.files) {
                const from = file.path
                const name = from.split('/').pop()
                const to = await _freeCloudPath(
                    node.newPath, name.replace(/\.md$/, ''), `${node.newPath}/${name}`, from,
                )
                if (from === to) continue
                const body = await _authoritativeBody(file)
                if (body === null) continue          // nothing in the cloud to move
                const check = await _withPathLock(to, async () => {
                    await vaultAPI.writeFile(to, body)
                    return vaultAPI.readFileResult(to)
                })
                if (check.missing || check.content !== body) {
                    throw new Error(`Could not copy "${file.title || from}" — the move was cancelled and nothing was deleted`)
                }
                moved.push({ file, from, to, body })
            }
        }
    } catch (err) {
        // Roll the copies back; the originals were never touched. Only remove
        // the .keep markers this call actually created — one that was already
        // there belongs to a folder we did not make.
        await Promise.all(moved.map(m => vaultAPI.deleteFile(m.to).catch(() => {})))
        await Promise.all(keepsCreated.map(k => vaultAPI.deleteFile(k).catch(() => {})))
        throw err
    }

    // Phase 2 — the copies are verified, so the originals can go.
    const stranded = []
    for (const m of moved) {
        const queued = _loadPending()[m.from]
        if (queued) { offlineQueue.enqueue(m.to, queued.content); offlineQueue.dequeue(m.from) }
        try {
            await _withPathLock(m.from, () => vaultAPI.deleteFile(m.from))
        } catch {
            // The copy is good, so the note is safe — but the original is still
            // there and the next sync would show it as a duplicate. Say so
            // rather than leaving the user to discover it.
            stranded.push(m.from)
        }
        contentCache.set(m.to, m.body)
        contentCache.delete(m.from)
        _noteLocalWrite(m.to)
        m.file.path = m.to
        m.file.content = m.body
        m.file.contentLoaded = true
    }
    await Promise.all(subtree.map(n => vaultAPI.deleteFile(`${n.oldPath}/.keep`).catch(() => {})))

    // Phase 3 — point the meta records at the new locations. Descendants too:
    // leaving them behind is what produced ghost folders on the next sync.
    for (const node of subtree) node.folder.path = node.newPath

    if (stranded.length) {
        throw new Error(
            `Moved, but ${stranded.length} old ${stranded.length === 1 ? 'copy' : 'copies'} ` +
            'could not be removed and may reappear on the next sync',
        )
    }
}

// A name nothing else occupies. The `taken` sets callers build come from this
// browser's meta, and writeFile overwrites unconditionally, so a note another
// device created at the wanted name would be replaced with no trace and no
// error — ask Storage before pointing anything at a path.
async function _freeCloudPath(dir, stem, wanted, selfPath) {
    let candidate = wanted
    for (let n = 2; n < 50; n++) {
        if (candidate === selfPath) return candidate
        const probe = await vaultAPI.readFileResult(candidate)
        if (probe.missing) return candidate
        candidate = `${dir}/${stem}-${n}.md`
    }
    throw new Error(`Could not find a free name for "${stem}" in ${dir}`)
}

// Move one note's object to `newPath`: write the body, prove it landed, carry
// any queued write across, and only then remove the original. Shared by move
// and rename because both must never end up as a delete — on 2026-09-15 a move
// that trusted an unverified copy turned a 15,779-byte note into a 0-byte file.
async function _relocateObject(file, newPath, content) {
    const oldPath = file.path
    const queued = _loadPending()[oldPath]

    const verify = await _withPathLock(newPath, async () => {
        await vaultAPI.writeFile(newPath, content)
        return vaultAPI.readFileResult(newPath)
    })
    if (verify.missing || verify.content !== content) {
        await vaultAPI.deleteFile(newPath).catch(() => {})
        throw new Error(`Could not verify the copy of "${file.title || oldPath}" — nothing was deleted`)
    }

    // Re-point any queued write before the old path stops existing, or the
    // flush would recreate the note at its old location as a duplicate.
    if (queued) {
        offlineQueue.enqueue(newPath, queued.content)
        offlineQueue.dequeue(oldPath)
    }

    try {
        await _withPathLock(oldPath, () => vaultAPI.deleteFile(oldPath))
    } catch (err) {
        // The delete failed — but "failed" can also mean it was applied and the
        // response was lost. Rolling back blind would then delete the copy we
        // just verified, leaving no copy at all. Ask Storage which world we are
        // in, and only undo the copy if the original is provably still there.
        let originalSurvives = false
        try {
            originalSurvives = !(await vaultAPI.readFileResult(oldPath)).missing
        } catch {
            originalSurvives = false     // can't prove it — keep both copies
        }
        if (originalSurvives) {
            await vaultAPI.deleteFile(newPath).catch(() => {})
            if (queued) { offlineQueue.enqueue(oldPath, queued.content); offlineQueue.dequeue(newPath) }
            throw err
        }
        // The original is gone and the copy is verified, so the relocation
        // actually succeeded. Commit it rather than destroying the last copy.
    }

    contentCache.set(newPath, content)
    contentCache.delete(oldPath)
    _noteLocalWrite(newPath)

    file.path = newPath
    file.content = content
    file.contentLoaded = true
}

// Everything that has to go when a folder is deleted: the subtree's own
// records, plus every object that currently lives under its prefixes in
// Storage. Deleting only what this browser has synced leaves behind notes
// another device created, and the next listing rebuilds the "deleted" folder
// out of them.
async function _collectFolderDeletion(meta, folderId) {
    const root = meta.folders.find(f => f.id === folderId)
    if (!root) return null

    // By path prefix as well as by parentId, for the same reason
    // _relocateFolder walks prefixes: a folder restored from an older meta
    // format can sit at a nested path with parentId still null, and following
    // links alone would skip it and every note inside it.
    const folders = new Map()
    const collect = (folder) => {
        if (!folder || folders.has(folder.id)) return
        folders.set(folder.id, folder)
        meta.folders
            .filter(f => f.parentId === folder.id || f.path.startsWith(folder.path + '/'))
            .forEach(collect)
    }
    collect(root)

    const paths = new Set()
    for (const folder of folders.values()) {
        paths.add(`${folder.path}/.keep`)
        for (const file of folder.files) if (file.path) paths.add(file.path)
    }

    // Throws if the vault can't be listed, which aborts the delete — better
    // than telling the user a folder is gone while its notes survive.
    const cloud = await vaultAPI.listFiles()
    const prefixes = [...folders.values()].map(f => f.path + '/')
    for (const item of cloud) {
        if (!item.path || isTrashPath(item.path)) continue
        if (prefixes.some(prefix => item.path.startsWith(prefix))) paths.add(item.path)
    }

    return { root, folders: [...folders.values()], paths: [...paths] }
}

// Remove a set of objects, keeping the offline queue in step: a queued write
// left behind would be replayed by the next flush and put the note back.
// Entries are dropped before the deletes so a flush racing this can't re-add
// the object, and restored for anything that could not actually be deleted.
async function _deleteObjects(paths, onDeleted) {
    const queued = _loadPending()
    const snapshot = paths.filter(p => queued[p]).map(p => [p, queued[p].content])

    const failed = []
    await Promise.all(paths.map(async path => {
        try {
            // A `.keep` is a folder marker, not content — there is nothing to
            // recover, so it goes straight out. Notes go to the recycle bin.
            if (path.endsWith('/.keep')) {
                offlineQueue.dequeue(path)
                await vaultAPI.deleteFile(path)
                contentCache.delete(path)
            } else {
                await _trashObject(path)
            }
        } catch {
            failed.push(path)
        }
        if (onDeleted) onDeleted()
    }))

    const stillThere = new Set(failed)
    for (const [path, content] of snapshot) {
        if (stillThere.has(path)) offlineQueue.enqueue(path, content)
    }
    return failed
}

export const foldersAPI = {
    async listFromCloud() {
        // Both short-circuits below answer for whoever asked last, so they are
        // held to the account that asked: handing account B the listing (or the
        // freshness) of account A is how B ended up looking at A's folder names.
        const me = _currentUid()
        // Reuse an in-flight sync rather than firing a second identical listing.
        if (_syncPromise && _syncUid === me) return _syncPromise
        // Every visit to the folders view calls this. Bouncing between views
        // shouldn't re-list the vault each time — the 60s poll and the
        // foreground/online handlers cover genuine freshness.
        if (Date.now() - _lastSyncAt < SYNC_TTL && _syncUid === me) return loadMeta().folders
        _syncUid = me
        _syncPromise = (async () => {
            try {
                // Stamped before the request: anything created while it is in
                // flight must not be judged by a listing that predates it.
                const listedAt = Date.now()
                const rawFiles = await vaultAPI.listFiles()
                // The listing was made under `me`; if the page has switched
                // accounts since, writing it into the meta now would file one
                // account's notes under the other's key.
                if (_currentUid() !== me) return loadMeta().folders
                let meta = loadMeta()
                meta = syncMetaFromCloud(rawFiles, meta, listedAt)
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

    async rename(folderId, newName) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const name = cleanLabel(newName, 'Folder name', 100)
        const parent = folder.parentId ? meta.folders.find(f => f.id === folder.parentId) : null
        const newPath = _uniqueFolderPath(meta, parent ? `${parent.path}/${slug(name)}` : slug(name), folder.id)
        // The name lives only in localStorage, so a rename that didn't also move
        // the storage objects vanished on any other device and on any cache
        // clear. Relocate for real, then record the label.
        if (newPath !== folder.path) await _relocateFolder(meta, folder, newPath)
        folder.name = name
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
        if ((folder.parentId || null) === (newParentId || null)) return folder

        const newParent = newParentId ? meta.folders.find(f => f.id === newParentId) : null
        if (newParentId && !newParent) throw new Error('Destination folder not found')
        const folderSlug = folder.path.split('/').pop()
        const oldFolderPath = folder.path
        const newPath = _uniqueFolderPath(meta, newParent ? `${newParent.path}/${folderSlug}` : folderSlug, folder.id)

        // This used to rewrite folder.path and nothing else: descendant folders
        // kept their old paths, every file inside still pointed at the old
        // location, and not one storage object moved. The next cloud sync then
        // resurrected the old tree from its .keep markers, so the move both
        // failed to stick and left ghost folders behind. Move the objects.
        // Re-parent BEFORE awaiting: _relocateFolder commits its path rewrite
        // and only then reports a partial failure, and an early return there
        // used to leave folder.path at the new location while parentId still
        // named the old parent — a folder that the tree and the storage prefix
        // disagreed about, which then dragged the wrong children into a delete.
        const previousParent = folder.parentId || null
        folder.parentId = newParentId || null
        try {
            await _relocateFolder(meta, folder, newPath)
        } catch (err) {
            if (folder.path === oldFolderPath) folder.parentId = previousParent
            saveMeta(meta)
            throw err
        }
        saveMeta(meta)
        return folder
    },

    async delete(folderId) {
        const meta = loadMeta()
        const target = await _collectFolderDeletion(meta, folderId)
        if (!target) return

        const failed = await _deleteObjects(target.paths)
        // Dropping the records now would report a clean delete over objects
        // that are still in Storage — and the next sync would bring the folder
        // back anyway, minus whatever the user thinks they deleted.
        if (failed.length) {
            throw new Error(`Could not delete ${failed.length} of ${target.paths.length} items in "${target.root.name}" — the folder was left in place`)
        }

        const deleteIds = new Set(target.folders.map(f => f.id))
        meta.folders = meta.folders.filter(f => !deleteIds.has(f.id))
        saveMeta(meta)
    },

    async deleteWithProgress(folderId, onProgress) {
        const meta = loadMeta()
        const target = await _collectFolderDeletion(meta, folderId)
        if (!target) return

        const allPaths = target.paths
        const total = allPaths.length || 1
        let done = 0
        const tick = () => { done++; if (onProgress) onProgress(done, total) }

        // Delete in parallel batches instead of strictly one at a time — the
        // progress bar still ticks, but a 60-file folder no longer takes 60
        // sequential round-trips.
        const BATCH = 8
        const failed = []
        for (let i = 0; i < allPaths.length; i += BATCH) {
            failed.push(...await _deleteObjects(allPaths.slice(i, i + BATCH), tick))
        }
        if (failed.length) {
            throw new Error(`Could not delete ${failed.length} of ${allPaths.length} items in "${target.root.name}" — the folder was left in place`)
        }

        const deleteIds = new Set(target.folders.map(f => f.id))
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
        const taken = new Set(meta.folders.flatMap(f => f.files.map(x => x.path)))
        let path = `${folder.path}/${base}.md`
        for (let n = 2; taken.has(path); n++) path = `${folder.path}/${base}-${n}.md`
        // `taken` only knows what this browser has synced. Storage overwrites
        // unconditionally, so a note another device created under this name —
        // or one a pruned record left behind — would be replaced with no error
        // and no trace. That is how an import of "groceries.md" could wipe an
        // existing Groceries note. Ask Storage before claiming the path.
        path = await _freeCloudPath(folder.path, base, path, null)

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

        // getSync only answers for notes held in memory; a note evicted from
        // the LRU (or too big to have been warmed) still has its body on disk.
        const cached = contentCache.getSync(file.path) || await contentCache.get(file.path)
        if (cached) {
            file.content = cached.content
            file.contentLoaded = true
            saveMeta(meta)
            _revalidate(file, meta, onFresh)
            return file
        }

        // A queued write is by definition newer than anything Storage can hand
        // back, and the cache entry that held it may since have been evicted.
        // Reading the cloud here would quietly restore the pre-edit body.
        const pending = _loadPending()[file.path]
        if (pending) {
            file.content = pending.content
            file.contentLoaded = true
            contentCache.set(file.path, pending.content)
            saveMeta(meta)
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

        // A title-only update is the rename action. The label lives in
        // localStorage alone, so unless the storage object follows it the note
        // shows up under its creation slug on every other device and after any
        // cache clear. The editor's save sends content too and is left alone —
        // a save must not turn into a copy-verify-delete.
        if (title !== undefined && content === undefined) return filesAPI.rename(folderId, fileId, title)
        // A save carrying both is the editor's. Write the body first, then let
        // the rename below relocate the object — doing it the other way round
        // would write the note to a path the rename is about to delete.
        const renameTo = title !== undefined && cleanLabel(title, 'File title') !== file.title
            ? cleanLabel(title, 'File title')
            : null
        if (content !== undefined) {
            assertNoteSize(content)
            file.content = content
            _noteLocalWrite(file.path)      // invalidate any prefetch in flight
            contentCache.set(file.path, content)
            // Queue BEFORE the upload, not only when it fails. A save that is
            // still in flight when the tab closes never reaches its catch, so
            // the edit would exist nowhere durable; the entry below is dropped
            // again the moment the write is confirmed. This also settles the
            // race with a concurrent flush: two PUTs to one object are ordered
            // by arrival, so an older queued body could otherwise land last.
            offlineQueue.enqueue(file.path, content)
            try {
                await _withPathLock(file.path, () => vaultAPI.writeFile(file.path, content))
            } catch (err) {
                // The entry queued before the upload is the durable copy; make
                // sure it is still there (a concurrent flush may have drained it).
                const rescued = _loadPending()[file.path] ? true : offlineQueue.enqueue(file.path, content)
                file.updated_at = new Date().toISOString()
                saveMeta(meta)
                // Without a queue entry nothing will ever retry this upload, so
                // the edit would live on this device only — silently.
                if (!rescued) {
                    const stranded = new Error(`${err.message} — and this browser's storage is full, so the edit could not be queued for upload`)
                    stranded.status = err.status
                    throw stranded
                }
                throw err
            }
            // The upload is confirmed, so the rescue entry has done its job.
            // Drop it only if it is still the body we just wrote: an edit made
            // during the upload must stay queued, or it would be lost.
            offlineQueue.dequeueIfUnchanged(file.path, content)
        }
        file.updated_at = new Date().toISOString()
        saveMeta(meta)
        // Retitling from the editor has to reach storage too, or the note keeps
        // its original slug everywhere but this browser. It runs after the body
        // is safely written, and a failure here leaves the note intact under its
        // old name rather than losing the save.
        if (renameTo) return filesAPI.rename(folderId, fileId, renameTo)
        return file
    },

    // Rename a note, object and all. Same copy-verify-delete as a move: the
    // body that gets copied must be the newest one that exists, and the
    // original only goes once the copy has been read back.
    async rename(folderId, fileId, newTitle) {
        const meta = loadMeta()
        const folder = meta.folders.find(f => f.id === folderId)
        if (!folder) throw new Error('Folder not found')
        const file = folder.files.find(f => f.id === fileId)
        if (!file) throw new Error('File not found')

        const title = cleanLabel(newTitle, 'File title')
        const oldPath = file.path
        const base = slug(title)
        const taken = new Set(
            meta.folders.flatMap(f => f.files.map(x => x.path)).filter(p => p !== oldPath),
        )
        let newPath = `${folder.path}/${base}.md`
        for (let n = 2; taken.has(newPath); n++) newPath = `${folder.path}/${base}-${n}.md`
        newPath = await _freeCloudPath(folder.path, base, newPath, oldPath)

        if (newPath !== oldPath) {
            const content = await _authoritativeBody(file)
            if (content === null) throw new Error('Cannot rename a note that no longer exists in the cloud')
            await _relocateObject(file, newPath, content)
        }

        file.title = title
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
            // Deleting a note moves it to the recycle bin. _trashObject owns
            // the queue handling and throws if the note could not be binned, in
            // which case it is still where it was.
            const body = (file.contentLoaded && file.content) || null
            await _trashObject(file.path, body)
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
        if (file) {
            // The 404 is authoritative, so a queued write for this path would
            // only recreate a note the cloud has already lost.
            offlineQueue.dequeue(file.path)
            contentCache.delete(file.path)
        }
        folder.files = folder.files.filter(f => f.id !== fileId)
        saveMeta(meta)
    },

    // Move a file to a different folder.
    //
    // A move is a copy-then-delete, so the body it copies MUST be the newest
    // one that exists. The old version trusted `file.content` and then the
    // in-memory cache, and deleted the original regardless of what it had
    // written. Both of those can be empty or stale — a note whose body was
    // never loaded, or one evicted from the cache — and on 2026-09-15 that
    // turned a 15,779-byte note into a 0-byte file and silently dropped four
    // lines from another. Now: take the newest body, refuse to write a blank
    // over a non-blank note, verify the copy landed, and only then delete.
    async move(sourceFolderId, fileId, targetFolderId) {
        const meta = loadMeta()
        const sourceFolder = meta.folders.find(f => f.id === sourceFolderId)
        const targetFolder = meta.folders.find(f => f.id === targetFolderId)
        if (!sourceFolder || !targetFolder) return null  // silently no-op if folder is missing
        if (sourceFolderId === targetFolderId) return null
        const fileIdx = sourceFolder.files.findIndex(f => f.id === fileId)
        if (fileIdx === -1) throw new Error('File not found')

        const file = sourceFolder.files[fileIdx]
        const fileName = file.path.split('/').pop()
        const oldPath = file.path
        const taken = new Set(meta.folders.flatMap(f => f.files.map(x => x.path)))
        const stem = fileName.replace(/\.md$/, '')
        let newPath = `${targetFolder.path}/${fileName}`
        for (let n = 2; taken.has(newPath); n++) newPath = `${targetFolder.path}/${stem}-${n}.md`
        newPath = await _freeCloudPath(targetFolder.path, stem, newPath, oldPath)
        if (newPath === oldPath) return file

        // ── Pick the authoritative body ───────────────────────────
        // A queued write is by definition newer than anything in the cloud.
        const queued = _loadPending()[oldPath]
        let content
        if (queued) {
            content = queued.content
        } else {
            // Otherwise the cloud object is the source of truth. The local copy
            // may be an unsaved draft that is newer, so keep whichever is longer
            // only when the cloud read fails outright.
            const result = await vaultAPI.readFileResult(oldPath)
            if (result.missing) throw new Error('Cannot move a note that no longer exists in the cloud')
            content = result.content
            if (file.contentLoaded && file.content && file.content !== content) {
                // An unsaved edit is in the editor. Never discard it.
                content = file.content
            }
        }

        // Last line of defence: never let a move blank a note.
        const localBody = (file.contentLoaded && file.content) || contentCache.getSync(oldPath)?.content || ''
        if (!content && localBody) content = localBody
        if (!content && !queued) {
            const probe = await vaultAPI.readFileResult(oldPath)
            if (!probe.missing && probe.content) content = probe.content
        }

        await _relocateObject(file, newPath, content)

        // Re-resolve the position: `fileIdx` was read before several awaits,
        // and another move completing in the meantime shifts the array — the
        // stale index would splice out whichever note had moved up into it.
        const liveMeta = loadMeta()
        const liveSource = liveMeta.folders.find(f => f.id === sourceFolderId) || sourceFolder
        const liveTarget = liveMeta.folders.find(f => f.id === targetFolderId) || targetFolder
        const idx = liveSource.files.findIndex(f => f.id === fileId)
        if (idx !== -1) liveSource.files.splice(idx, 1)
        if (!liveTarget.files.some(f => f.id === fileId)) liveTarget.files.unshift(file)
        saveMeta(liveMeta)
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
    // A queued write means the local copy is strictly newer than the cloud's;
    // adopting the cloud body here would revert the editor to the pre-edit text
    // and the next save would then drop the queue entry that still held it.
    if (_loadPending()[file.path]) return
    const seqBefore = _writeSeq.get(file.path) || 0
    vaultAPI.readFileResult(file.path)
        .then(({ content: fresh, missing }) => {
            // The object isn't there (yet). That is not evidence the note is
            // empty — keep what we have rather than blanking it.
            if (missing) return
            if ((_writeSeq.get(file.path) || 0) !== seqBefore) return   // a save won the race
            if (_loadPending()[file.path]) return                       // queued while we read
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
    const uid = _currentUid()
    return uid ? `nc_pending_saves_${uid}` : 'nc_pending_saves_anon'
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
    try { localStorage.setItem(pendingSavesKey(), JSON.stringify(map)); return true }
    catch (err) { _storageFull(err); return false }
}

// True when a queued write names an object this browser no longer has a record
// of — a note or folder deleted since it was queued. Replaying it would put the
// object back in Storage and the next listing would mint a fresh record for it.
// An empty meta means "nothing synced yet", not "everything was deleted", so it
// never condemns an entry.
function _isOrphanedQueueEntry(path, meta) {
    if (!meta.folders.length) return false
    if (path.endsWith('/.keep')) {
        const folderPath = path.slice(0, -'/.keep'.length)
        return !meta.folders.some(f => f.path === folderPath)
    }
    return !meta.folders.some(f => f.files.some(x => x.path === path))
}

let _flushPromise = null

export const offlineQueue = {
    // Returns array of pending file paths
    getPending() { return Object.keys(_loadPending()) },

    // Queue a write to retry later (keyed by path → last write wins)
    enqueue(path, content) {
        const map = _loadPending()
        map[path] = { content, queued_at: new Date().toISOString() }
        return _savePending(map)
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
            // Yield before touching the queue, so the assignment above lands
            // first. An empty queue runs this body to completion synchronously,
            // and the `finally` would then clear a slot that is filled a moment
            // later with an already-resolved promise — parking it there and
            // turning every flush for the rest of the session into a no-op.
            await Promise.resolve()
            let done = 0
            try {
                for (const path of Object.keys(_loadPending())) {
                    // Re-read per iteration: an edit saved mid-flush may have
                    // superseded or removed this entry.
                    const entry = _loadPending()[path]
                    if (!entry) continue
                    if (_isOrphanedQueueEntry(path, loadMeta())) {
                        offlineQueue.dequeue(path)
                        continue
                    }
                    const seq = _writeSeq.get(path) || 0
                    let wrote
                    try {
                        wrote = await _withPathLock(path, async () => {
                            // A foreground save that landed while this entry
                            // waited for the lock holds newer content: it has
                            // either dropped the entry or repointed it.
                            const current = _loadPending()[path]
                            if (!current || current.content !== entry.content) return false
                            if ((_writeSeq.get(path) || 0) !== seq) return false
                            await vaultAPI.writeFile(path, entry.content)
                            return true
                        })
                    } catch {
                        // Still failing — keep it queued and stop trying for now
                        break
                    }
                    offlineQueue.dequeueIfUnchanged(path, entry.content)
                    if (wrote) done++
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
    const seq = _writeSeq.get(path) || 0
    _withPathLock(path, async () => {
        // A real save landing first makes this optimistic body stale, and an
        // optimistic body is usually empty — writing it now would blank the note.
        if ((_writeSeq.get(path) || 0) !== seq) return
        await vaultAPI.writeFile(path, content)
        // The note may have been moved or deleted while this upload was in
        // flight, in which case the object just written is a resurrection: the
        // next listing would mint a second record for it.
        if (_isOrphanedQueueEntry(path, loadMeta())) await vaultAPI.deleteFile(path).catch(() => {})
    })
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

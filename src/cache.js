// src/cache.js
// Persistent per-user cache of note contents.
//
// The old cache lived in sessionStorage, so it died with the tab and every fresh
// browser paid a network round-trip per note. IndexedDB survives restarts, holds
// far more than the ~5MB string quota, and can be read in one shot at boot —
// `warm()` pulls the whole vault into a Map so `getSync()` answers with no await
// and a note opens with zero latency.
//
// Everything here degrades quietly: private-mode browsers that refuse IndexedDB
// fall back to the in-memory Map, which is still better than nothing.

const DB_NAME = 'nc_vault'
const DB_VERSION = 1
const STORE = 'contents'

// Don't hold more than this in memory after a warm(). There is deliberately no
// per-entry ceiling: `getSync` is what every reader gates on, so an entry this
// Map refuses is written to IndexedDB and then unreachable — the vault's
// biggest notes were re-fetched on every sync and folder visit, and counted for
// nothing in backlinks, the graph or tag search. The LRU below is what keeps a
// large note from holding the working set hostage.
const MAX_MEMORY_BYTES = 12 * 1024 * 1024

let _dbPromise = null
let _uid = null
const _mem = new Map()        // "uid/path" → { content, updated_at }
let _memBytes = 0

function _openDb() {
    if (_dbPromise) return _dbPromise
    _dbPromise = new Promise(resolve => {
        let req
        try { req = indexedDB.open(DB_NAME, DB_VERSION) } catch { resolve(null); return }
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
    })
    return _dbPromise
}

function _key(path) { return `${_uid || 'anon'}/${path}` }

function _remember(key, entry) {
    const size = (entry.content || '').length
    const prev = _mem.get(key)
    const prevSize = prev ? (prev.content || '').length : 0
    if (_memBytes - prevSize + size > MAX_MEMORY_BYTES) {
        // Over the cap — evict rather than refuse, so the newest note stays
        // reachable and a stale body can never outlive the write that replaced it.
        _forget(key)
        _evictUntil(MAX_MEMORY_BYTES - size)
        if (_memBytes + size > MAX_MEMORY_BYTES) return
    } else {
        _memBytes -= prevSize
    }
    _mem.set(key, entry)
    _memBytes += size
}

function _forget(key) {
    const prev = _mem.get(key)
    if (!prev) return
    _memBytes -= (prev.content || '').length
    _mem.delete(key)
}

// Drop least-recently-inserted entries until we're under `target`. Map iterates
// in insertion order, and every set() re-inserts, so this is a rough LRU.
function _evictUntil(target) {
    for (const key of _mem.keys()) {
        if (_memBytes <= target) return
        _forget(key)
    }
}

export const contentCache = {
    // Scope every key to a user so switching accounts can't leak notes.
    setUser(uid) {
        if (_uid === uid) return
        _uid = uid
        _mem.clear()
        _memBytes = 0
    },

    // Synchronous hit — only answers for notes already in memory (warmed at boot,
    // or read/written earlier this session). This is what makes opening a note
    // feel instant instead of showing "Loading file...".
    getSync(path) {
        return _mem.get(_key(path)) || null
    },

    async get(path) {
        const hit = contentCache.getSync(path)
        if (hit) return hit
        const db = await _openDb()
        if (!db) return null
        return new Promise(resolve => {
            let req
            try { req = db.transaction(STORE, 'readonly').objectStore(STORE).get(_key(path)) }
            catch { resolve(null); return }
            req.onsuccess = () => {
                const entry = req.result || null
                if (entry) _remember(_key(path), entry)
                resolve(entry)
            }
            req.onerror = () => resolve(null)
        })
    },

    set(path, content, updated_at = null) {
        const key = _key(path)
        const entry = { content, updated_at, cached_at: Date.now() }
        _forget(key)         // re-insert at the tail so eviction stays LRU-ish
        _remember(key, entry)
        _openDb().then(db => {
            if (!db) return
            try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry, key) }
            catch { /* quota or closed db — memory cache still holds it */ }
        })
    },

    delete(path) {
        const key = _key(path)
        _forget(key)
        _openDb().then(db => {
            if (!db) return
            try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key) }
            catch { /* ignore */ }
        })
    },

    // Rename/move: carry the cached body across so the note doesn't re-download.
    rename(oldPath, newPath) {
        const entry = _mem.get(_key(oldPath))
        if (entry) contentCache.set(newPath, entry.content, entry.updated_at)
        contentCache.delete(oldPath)
    },

    // One IndexedDB pass at boot that loads this user's notes into memory, so
    // every later open is a synchronous Map hit. Resolves with the entry count.
    async warm() {
        const db = await _openDb()
        if (!db) return 0
        const prefix = `${_uid || 'anon'}/`
        return new Promise(resolve => {
            let store
            try { store = db.transaction(STORE, 'readonly').objectStore(STORE) }
            catch { resolve(0); return }
            // Bounded to this user's key range so other accounts stay untouched.
            let range = null
            try { range = IDBKeyRange.bound(prefix, prefix + '￿') } catch { /* full scan */ }
            let count = 0
            const req = store.openCursor(range)
            req.onsuccess = () => {
                const cursor = req.result
                if (!cursor) { resolve(count); return }
                if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
                    _remember(cursor.key, cursor.value)
                    count++
                }
                cursor.continue()
            }
            req.onerror = () => resolve(count)
        })
    },

    // Drop the signed-out user's notes (called on logout). Scoped to their key
    // range — a shared browser's other accounts keep their own cache, the same
    // way they keep their own localStorage meta.
    async clear() {
        const prefix = `${_uid || 'anon'}/`
        _mem.clear()
        _memBytes = 0
        const db = await _openDb()
        if (!db) return
        return new Promise(resolve => {
            let store
            try { store = db.transaction(STORE, 'readwrite').objectStore(STORE) }
            catch { resolve(); return }
            let range = null
            try { range = IDBKeyRange.bound(prefix, prefix + '￿') } catch { /* full scan */ }
            const req = store.openCursor(range)
            req.onsuccess = () => {
                const cursor = req.result
                if (!cursor) { resolve(); return }
                if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete()
                cursor.continue()
            }
            req.onerror = () => resolve()
        })
    },
}

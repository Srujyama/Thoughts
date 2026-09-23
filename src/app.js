// src/app.js
import { foldersAPI, filesAPI, auth, vaultAPI, syncStatus, offlineQueue, contentFor, cacheReady, trashAPI } from './api.js'
import { ensureMarked, ensureHljs, ensureKatex, ensureMermaid, warmMarked, needsMath } from './lazy.js'
import { contentCache } from './cache.js'
import DOMPurify from 'dompurify'

const EDITOR_MODE_KEY     = 'nc_editor_mode'
const THEME_KEY           = 'nc_theme'
const AUTOSAVE_KEY        = 'nc_autosave'
const SIDEBAR_OPEN_KEY    = 'nc_sidebar_open'
const STARRED_KEY         = 'nc_starred'
const RECENT_KEY          = 'nc_recent'
const AUTOLOGOUT_KEY      = 'nc_autologout'
const AUTOLOGOUT_MIN_KEY  = 'nc_autologout_minutes'

const THEMES = [
    { id: 'system',     label: 'System' },
    { id: 'white',      label: 'White' },
    { id: 'black',      label: 'Black' },
    { id: 'cyberpunk',  label: 'Cyberpunk' },
    { id: 'typewriter', label: 'Typewriter' },
    { id: 'nord',       label: 'Nord' },
    { id: 'dracula',    label: 'Dracula' },
    { id: 'solarized',  label: 'Solarized' },
    { id: 'monokai',    label: 'Monokai' },
    { id: 'ocean',      label: 'Ocean' },
]

// ── System theme media query watcher ──────────────────────────
let _systemThemeListener = null

function _resolveSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'black' : 'white'
}

// ── Hash routing helpers ──────────────────────────────────────
// The note part of the hash is the file's slug (its storage basename), not its
// local id. Ids are minted with crypto.randomUUID() by whichever browser first
// syncs a note, so an id-based URL is meaningless anywhere else — reloading a
// note in a fresh browser could never reopen that note, only its folder.
// Slugs come from the storage path, so they're the same everywhere.
function fileSlugOf(file) {
    if (!file) return null
    if (file.path) return file.path.split('/').pop().replace(/\.md$/, '')
    return file.id || null
}

// `replace` is for a URL the app is *correcting* rather than one the user asked
// for. A history entry can point at a note that has since been deleted, or at a
// folder that has since been renamed; the renderers then downgrade to the
// nearest view they can show and write that back. Pushing the correction stacks
// a new entry on top of the one the user just went back to, so the next Back
// lands on the unresolvable entry again and the trip repeats forever.
function pushHash(folderPath, fileRef, { replace = false } = {}) {
    let hash
    if (!folderPath) {
        hash = '#/'
    } else if (!fileRef) {
        hash = '#/' + folderPath
    } else {
        hash = '#/' + folderPath + '//' + fileRef
    }
    if (location.hash === hash) return
    if (replace) history.replaceState(null, '', hash)
    else history.pushState(null, '', hash)
}

function readHash() {
    const raw = location.hash.replace(/^#\/?/, '')
    if (!raw) return { folderPath: null, fileRef: null }
    const sep = raw.indexOf('//')
    if (sep !== -1) {
        return { folderPath: raw.slice(0, sep) || null, fileRef: raw.slice(sep + 2) || null }
    }
    return { folderPath: raw || null, fileRef: null }
}

// Resolve the note part of a hash. Accepts a slug (what we write now) or a raw
// id (older bookmarks and in-session history entries).
function findFileByRef(folder, ref) {
    if (!folder || !ref) return null
    return folder.files.find(f => fileSlugOf(f) === ref)
        || folder.files.find(f => f.id === ref)
        || null
}

export class ThoughtCollector {
    constructor(containerEl, onLogout) {
        this.container = containerEl
        this.onLogout = onLogout
        this.view = 'folders'
        this.currentFolder = null
        this.currentFile = null
        this.editorDirty = false
        this._saving = false
        this.editorMode = this._isMobile()
            ? 'edit'
            : (localStorage.getItem(EDITOR_MODE_KEY) || 'split')
        // Autosave: default ON for mobile (work is easily lost when backgrounding
        // Safari), opt-out via explicit 'false'. Desktop stays opt-in.
        this.autosave = this._isMobile()
            ? (localStorage.getItem(AUTOSAVE_KEY) !== 'false')
            : (localStorage.getItem(AUTOSAVE_KEY) === 'true')
        this._autosaveTimer = null
        // Autologout: off by default; interval stored in minutes
        this.autologout = localStorage.getItem(AUTOLOGOUT_KEY) === 'true'
        const storedMins = parseInt(localStorage.getItem(AUTOLOGOUT_MIN_KEY), 10)
        this.autologoutMinutes = Number.isFinite(storedMins) && storedMins > 0 ? storedMins : 15
        this._autologoutTimer = null
        this._autologoutActivityHandler = null
        // Track which sidebar folders are collapsed (set of folder ids)
        this._collapsedFolders = new Set(JSON.parse(localStorage.getItem(SIDEBAR_OPEN_KEY) || '[]'))
        // Starred (favorited) file ids
        this._starred = new Set(JSON.parse(localStorage.getItem(STARRED_KEY) || '[]'))
        // Recent files [{folderId, fileId, title}] (max 10)
        this._recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
        // Document-level listeners owned by the current shell (see _onDocument)
        this._docListeners = []
        // Cold-boot state: on a browser that has never synced, local meta is
        // empty and every view has to distinguish "nothing here" from "not
        // loaded yet". Must be set before _restoreFromHash runs.
        this._hasSynced = foldersAPI.list().length > 0
        this._syncFailed = false
        this._pendingHash = null
        // True for the duration of a popstate-driven restore, so the renderers
        // can tell "the user asked for this" from "we are tidying up the URL".
        this._restoring = false
        // Dismiss callbacks for dialogs currently on screen (see _trapModal)
        this._openModals = new Set()
        // Outline panel open state
        this._outlineOpen = false
        // Backlinks panel open state
        this._backlinksOpen = false

        // Apply saved theme (default: system)
        const savedTheme = localStorage.getItem(THEME_KEY) || 'system'
        this._applyTheme(savedTheme)

        this._restoreFromHash()
        // A history navigation — browser Back, the iOS edge swipe — cannot be
        // cancelled, and the re-render below throws the editor's DOM away, so
        // whatever is in the textarea has to be written out here or it is gone.
        // The flag is cleared either way: left standing it resurfaced later as
        // an "unsaved changes" prompt about a note the user had already left.
        this._popstateHandler = () => {
            if (this.view === 'editor' && this.editorDirty) this.flushSave({ force: true })
            this.editorDirty = false
            this._restoring = true
            try { this._restoreFromHash() } finally { this._restoring = false }
        }
        window.addEventListener('popstate', this._popstateHandler)

        // Global keyboard shortcuts. Each branch swallows the browser's own
        // shortcut before deciding whether to act: with a dialog already up we
        // open nothing (a second palette would only stack on the first), but
        // handing Cmd+P back to the browser would raise the print dialog over
        // the box the user is looking at.
        this._globalKeyHandler = (e) => {
            // Command palette: Ctrl/Cmd+P
            if (e.key === 'p' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (this._overlayOpen()) return
                this._showCommandPalette()
                return
            }
            // Quick switcher: Ctrl/Cmd+O
            if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (this._overlayOpen()) return
                this._showQuickSwitcher()
                return
            }
            // Graph view: Ctrl/Cmd+G (when not in textarea)
            if (e.key === 'g' && (e.metaKey || e.ctrlKey) && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
                e.preventDefault()
                if (this._overlayOpen()) return
                this._showGraphView()
                return
            }
        }
        document.addEventListener('keydown', this._globalKeyHandler)

        // Leaving the note / walking back up the folder tree. A dialog on screen
        // owns Escape outright: acting on it down here as well would throw the
        // user out of the note behind the command palette, and would reopen the
        // "unsaved changes" confirm in the same keypress that dismissed it.
        this._escHandler = async (e) => {
            if (e.key === 'Escape') {
                if (this._overlayOpen()) return
                if (this._saving) {
                    this._toast('Please wait — save in progress...')
                    return
                }
                if (this.view === 'editor') {
                    if (this.editorDirty) {
                        const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                        if (!ok) return
                    }
                    this.editorDirty = false
                    this._navigate('files', { replace: true })
                } else if (this.view === 'files') {
                    const parent = this.currentFolder?.parentId
                        ? foldersAPI.list().find(f => f.id === this.currentFolder.parentId)
                        : null
                    if (parent) this._navigate('files', { folder: parent, replace: true })
                    else this._navigate('folders', { replace: true })
                }
            }
        }
        document.addEventListener('keydown', this._escHandler)

        // Flush unsaved editor changes when the tab is hidden/closed (iOS uses
        // pagehide; desktop uses beforeunload to warn). Registered once.
        this._pagehideHandler = () => {
            if (this.view === 'editor' && this.editorDirty) this.flushSave()
        }
        this._beforeunloadHandler = (e) => {
            if (this.view === 'editor' && this.editorDirty && !this._saving) {
                e.preventDefault()
                e.returnValue = ''
            }
        }
        window.addEventListener('pagehide', this._pagehideHandler)
        window.addEventListener('beforeunload', this._beforeunloadHandler)

        // Start fetching the markdown renderer now — every preview needs it, and
        // downloading it alongside the vault listing keeps it off the critical
        // path without making the first preview wait for a cold fetch.
        warmMarked()

        // Loading the note cache out of IndexedDB is asynchronous, so a panel
        // that reads note bodies can render before it lands and come up empty.
        // Repaint it once the cache is actually there.
        cacheReady.then(() => {
            if (this._backlinksOpen && this.view === 'editor') this._updateBacklinksPanel()
        }).catch(() => {})

        // Start sync status polling
        syncStatus.startPolling()

        // Apply autologout setting
        this._applyAutologout()
    }

    // ── Flush the current editor's content to cloud (or offline queue) ──
    // Used by pagehide/visibility paths where we can't await a full save.
    // Returns the write promise for the paths that can wait for it.
    // `force` is for the paths that are about to destroy the editor's DOM
    // (history navigation, tab close). A save already in flight only carries
    // the snapshot it took when it started; anything typed since then lives
    // only in the textarea, so it has to be queued now rather than skipped.
    flushSave({ force = false } = {}) {
        if (!this.editorDirty) return
        if (this._saving && !force) return
        if (this.view !== 'editor' || !this.currentFolder || !this.currentFile) return
        // A note whose body we never managed to read has nothing to write back;
        // a save here would push an empty document over the real one.
        if (!this.currentFile.contentLoaded) return
        const titleInput  = this.container.querySelector('#file-title')
        const contentArea = this.container.querySelector('#file-content')
        if (!contentArea) return
        const content = contentArea.value
        const title = titleInput ? titleInput.value : this.currentFile.title
        const path = this.currentFile.path
        // Optimistically clear the dirty flag so we don't double-fire.
        this.editorDirty = false
        if (this._saving) {
            // Can't start a second write; park the newest text where it will be
            // replayed, and let the in-flight save finish on its own.
            if (path) offlineQueue.enqueue(path, content)
            return
        }
        // The page is on its way out, so the promise below may never settle:
        // neither .then nor .catch is guaranteed to run once the tab is gone.
        // Queueing is a synchronous localStorage write and does survive that,
        // so park the body there first — a completed update clears it again.
        if (path) offlineQueue.enqueue(path, content)
        return filesAPI.update(this.currentFolder.id, this.currentFile.id, { title, content })
            .catch(() => {
                // Offline / failed — refresh the queued copy so it replays on reconnect.
                if (path) offlineQueue.enqueue(path, content)
            })
    }

    // ── Autologout (inactivity-based) ─────────────────────────
    _applyAutologout() {
        this._clearAutologoutTimer()
        if (this._autologoutActivityHandler) {
            const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
            events.forEach(ev => document.removeEventListener(ev, this._autologoutActivityHandler, true))
            this._autologoutActivityHandler = null
        }
        if (!this.autologout) return

        const resetTimer = () => {
            this._clearAutologoutTimer()
            const ms = Math.max(1, this.autologoutMinutes) * 60 * 1000
            this._autologoutTimer = setTimeout(() => this._triggerAutologout(), ms)
        }

        this._autologoutActivityHandler = resetTimer
        const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
        events.forEach(ev => document.addEventListener(ev, this._autologoutActivityHandler, true))
        resetTimer()
    }

    _clearAutologoutTimer() {
        if (this._autologoutTimer) {
            clearTimeout(this._autologoutTimer)
            this._autologoutTimer = null
        }
    }

    // Remove the window-level lifecycle handlers (called on any logout path)
    _removeLifecycleHandlers() {
        if (this._pagehideHandler) window.removeEventListener('pagehide', this._pagehideHandler)
        if (this._beforeunloadHandler) window.removeEventListener('beforeunload', this._beforeunloadHandler)
    }

    destroy() {
        document.removeEventListener('keydown', this._escHandler)
        document.removeEventListener('keydown', this._globalKeyHandler)
        if (this._popstateHandler) window.removeEventListener('popstate', this._popstateHandler)
        this._removeLifecycleHandlers()
        this._clearDocumentListeners()
        this._clearAutologoutTimer()
        clearTimeout(this._autosaveTimer)
        clearTimeout(this._previewTimer)
        if (this._vvCleanup) { this._vvCleanup(); this._vvCleanup = null }
        if (this._syncUnsub) { this._syncUnsub(); this._syncUnsub = null }
        if (this._scrollMirror) { this._scrollMirror.remove(); this._scrollMirror = null }
        if (this._autologoutActivityHandler) {
            const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
            events.forEach(ev => document.removeEventListener(ev, this._autologoutActivityHandler, true))
            this._autologoutActivityHandler = null
        }
        syncStatus.stopPolling()
        // Someone is awaiting the answer to each of these. Ripping the nodes out
        // without resolving leaves that await pending for the life of the page.
        Array.from(this._openModals).forEach(dismiss => dismiss())
        document.querySelectorAll('.modal-overlay, .move-menu-overlay').forEach(el => el.remove())
    }

    async _triggerAutologout() {
        // destroy() drops the editor's DOM and every timer pointing at it, so an
        // unsaved note has to be written before that — and before auth.logout()
        // invalidates the credentials the write needs.
        await this.flushSave()
        this.destroy()
        try { await auth.logout() } catch (e) { /* ignore */ }
        this._toast('Logged out due to inactivity')
        this.onLogout()
    }

    // ── Sync status UI ───────────────────────────────────────
    _updateSyncUI(status) {
        const dot = this.container.querySelector('#sync-dot')
        const label = this.container.querySelector('#sync-label')
        const btn = this.container.querySelector('#sync-status-btn')
        if (!dot || !label || !btn) return

        dot.className = 'sync-dot'
        switch (status) {
            case 'synced':
                dot.classList.add('sync-ok')
                label.textContent = 'Synced'
                btn.title = 'Connected and in sync — click to re-check'
                break
            case 'checking':
                dot.classList.add('sync-checking')
                label.textContent = 'Checking...'
                btn.title = 'Checking connection...'
                break
            case 'offline':
                dot.classList.add('sync-offline')
                label.textContent = 'Offline'
                btn.title = 'Cannot reach server — click to retry'
                break
            case 'expired':
                dot.classList.add('sync-expired')
                label.textContent = 'Session expired'
                btn.title = 'Session expired — please log in again'
                break
        }
    }

    // ── Theme ─────────────────────────────────────────────────
    _applyTheme(themeId) {
        // Migrate old theme IDs to new ones
        const migrations = { light: 'white', dark: 'black', docs: 'white' }
        if (migrations[themeId]) themeId = migrations[themeId]

        const valid = THEMES.find(t => t.id === themeId)
        if (!valid) themeId = 'system'

        // Remove old system theme listener
        if (_systemThemeListener) {
            window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _systemThemeListener)
            _systemThemeListener = null
        }

        localStorage.setItem(THEME_KEY, themeId)

        if (themeId === 'system') {
            const apply = () => {
                const resolved = _resolveSystemTheme()
                document.documentElement.setAttribute('data-theme', resolved)
            }
            apply()
            _systemThemeListener = apply
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', _systemThemeListener)
        } else {
            document.documentElement.setAttribute('data-theme', themeId)
        }
    }

    // Bring the header's theme control back in step after the theme was changed
    // from somewhere else. Themes are nothing but CSS custom properties, so the
    // switch itself needs no re-render — and a re-render while a note is open
    // would repaint the textarea from the last saved body, discarding whatever
    // has been typed since.
    _syncThemePicker(themeId) {
        const swatch = this.container.querySelector('.theme-toggle-swatch')
        const label = this.container.querySelector('.theme-toggle-label')
        if (swatch) swatch.setAttribute('data-theme', themeId)
        if (label) label.textContent = THEMES.find(t => t.id === themeId)?.label || ''
        this.container.querySelectorAll('.theme-dropdown-item').forEach(b => {
            b.classList.toggle('active', b.dataset.theme === themeId)
        })
    }

    _isMobile() {
        // Width alone misclassifies modern iPhones in landscape (up to 932px)
        // as desktop. Keep the desktop layout for short laptop windows by also
        // requiring touch input for the landscape exception.
        const touchLandscape = window.innerWidth <= 950
            && window.innerHeight <= 500
            && (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches)
        return window.innerWidth <= 768 || touchLandscape
    }

    // ── Routing ───────────────────────────────────────────────
    // `replace` belongs to the back-style controls. Pushing an entry for the
    // view you just backed out of leaves the note you left sitting ahead of you
    // in history, so the browser's own Back button walks straight into it again.
    _navigate(view, { folder, file, replace = false } = {}) {
        // A deliberate navigation overrides wherever the cold-boot URL was
        // headed — don't teleport the user afterwards.
        this._pendingHash = null
        this.view = view
        if (folder !== undefined) this.currentFolder = folder
        if (file   !== undefined) this.currentFile   = file

        if (view === 'folders') {
            this.currentFolder = null
            this.currentFile   = null
            pushHash(null, null, { replace })
        } else if (view === 'files' && this.currentFolder) {
            this.currentFile = null
            pushHash(this.currentFolder.path, null, { replace })
        } else if (view === 'editor' && this.currentFolder && this.currentFile) {
            pushHash(this.currentFolder.path, fileSlugOf(this.currentFile), { replace })
        }
        this._render()
    }

    _restoreFromHash() {
        const { folderPath, fileRef } = readHash()
        const allFolders = foldersAPI.list()

        if (!folderPath) {
            this._pendingHash = null
            this.view = 'folders'
            this.currentFolder = null
            this.currentFile   = null
            this._render()
            return
        }

        const folder = allFolders.find(f => f.path === folderPath)
        if (!folder) {
            // On a browser that has never synced, meta is empty, so EVERY
            // deep link lands here and silently drops the user at the folder
            // grid — reloading the tab on an open note used to mean navigating
            // back down two levels by hand. Remember where they were headed and
            // resolve it once the first listing arrives.
            if (!this._hasSynced) this._pendingHash = { folderPath, fileRef }
            this.view = 'folders'
            this._render()
            return
        }

        this._pendingHash = null
        this.currentFolder = folder

        if (!fileRef) {
            this.view = 'files'
            this._render()
            return
        }

        const file = findFileByRef(folder, fileRef)
        if (!file) {
            if (!this._hasSynced) this._pendingHash = { folderPath, fileRef }
            this.view = 'files'
            this._render()
            return
        }

        this._openFile(file)
    }

    // After the first cloud listing lands, finish the navigation the cold boot
    // couldn't. Runs at most once, and only if the user hasn't gone somewhere
    // else in the meantime — being teleported out of whatever you just opened
    // would be worse than the problem it fixes.
    _resolvePendingHash() {
        const pending = this._pendingHash
        if (!pending) return
        this._pendingHash = null
        if (this.view !== 'folders' && this.view !== 'files') return
        const now = readHash()
        if (now.folderPath !== pending.folderPath || now.fileRef !== pending.fileRef) return
        if (!foldersAPI.list().some(f => f.path === pending.folderPath)) return
        this._restoreFromHash()
    }

    // ── Top-level render dispatcher ───────────────────────────
    _render() {
        // Tear down any editor-specific viewport listener before re-rendering
        // so handlers don't stack across views.
        if (this._vvCleanup) { this._vvCleanup(); this._vvCleanup = null }
        // Timers armed by the view we are leaving still hold references to its
        // note. Letting an autosave fire after navigation overwrote
        // this.currentFile with the note the user had just left, so renames and
        // saves afterwards targeted the wrong file.
        clearTimeout(this._autosaveTimer)
        clearTimeout(this._previewTimer)
        // Rescue whatever is in the editor before the DOM holding it goes away.
        // A re-render reached from inside the editor — creating a folder, an
        // import, a drop on the sidebar — would otherwise repaint the textarea
        // from the last saved body and drop everything typed since.
        if (this.view === 'editor' && this.editorDirty) {
            const live = this.container.querySelector('#file-content')
            if (live) this._liveBody = live.value
        }
        if (this.view === 'folders') this._renderFolders()
        else if (this.view === 'files') this._renderFiles()
        else if (this.view === 'trash') this._renderTrash()
        else if (this.view === 'editor') this._renderEditor()
    }

    // ── Recycle bin ───────────────────────────────────────────
    // Notes deleted in the last 30 days, newest first. The list comes from
    // Storage rather than local state, so it is the same on every device and a
    // cleared browser cache cannot lose it.
    _renderTrash() {
        const body = `
            <div class="toolbar">
                <span class="section-label">Recycle bin</span>
                <div class="toolbar-actions">
                    <button class="cyber-btn compact-btn" id="trash-back-btn">
                        <span class="btn-text">&larr; Folders</span>
                        <span class="btn-glow"></span>
                    </button>
                    <button class="cyber-btn compact-btn danger" id="trash-empty-btn" disabled>
                        <span class="btn-text">Empty bin</span>
                        <span class="btn-glow"></span>
                    </button>
                </div>
            </div>
            <p class="trash-note">Deleted notes stay here for ${trashAPI.retentionDays} days, then go for good.</p>
            <div class="trash-list" id="trash-list">
                <div class="empty-state"><p class="empty-title">Loading&hellip;</p></div>
            </div>`

        this.container.innerHTML = this._shell(body)
        this._bindShell()

        this.container.querySelector('#trash-back-btn')
            .addEventListener('click', () => this._navigate('folders'))

        const list = this.container.querySelector('#trash-list')
        const emptyBtn = this.container.querySelector('#trash-empty-btn')

        const paint = (items) => {
            emptyBtn.disabled = items.length === 0
            if (!items.length) {
                list.innerHTML = `
                    <div class="empty-state">
                        <p class="empty-title">Recycle bin is empty</p>
                        <p class="empty-sub">Notes you delete will wait here for ${trashAPI.retentionDays} days</p>
                    </div>`
                return
            }
            const now = Date.now()
            list.innerHTML = items.map(item => {
                const left = Math.max(0, Math.ceil((item.expiresAt - now) / 86400000))
                return `
                <div class="trash-card" data-path="${this._esc(item.trashPath)}">
                    <div class="trash-card-main">
                        <div class="trash-title">${this._esc(item.title)}</div>
                        <div class="trash-meta">
                            <span class="trash-origin">${this._esc(item.folderPath || 'root')}</span>
                            <span class="trash-sep">&middot;</span>
                            <span class="trash-left">${left} day${left === 1 ? '' : 's'} left</span>
                        </div>
                    </div>
                    <div class="trash-actions">
                        <button class="icon-btn trash-restore-btn" aria-label="Restore ${this._esc(item.title)}">restore</button>
                        <button class="icon-btn trash-purge-btn" aria-label="Delete ${this._esc(item.title)} permanently">delete</button>
                    </div>
                </div>`
            }).join('')

            list.querySelectorAll('.trash-restore-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const card = btn.closest('.trash-card')
                    btn.disabled = true
                    try {
                        const res = await trashAPI.restore(card.dataset.path)
                        this._toast(res.renamed
                            ? `Restored as "${res.path.split('/').pop().replace(/\.md$/, '')}" — the old name was taken`
                            : 'Restored')
                        await refresh()
                    } catch (err) {
                        btn.disabled = false
                        this._toast(`Restore failed: ${err.message}`)
                    }
                })
            })

            list.querySelectorAll('.trash-purge-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const card = btn.closest('.trash-card')
                    const title = card.querySelector('.trash-title').textContent
                    const ok = await this._showModal({
                        type: 'confirm',
                        title: 'DELETE PERMANENTLY',
                        message: `Delete "${title}" for good? This cannot be undone.`,
                        danger: true,
                    })
                    if (!ok) return
                    try {
                        await trashAPI.purge(card.dataset.path)
                        await refresh()
                    } catch (err) {
                        this._toast(`Delete failed: ${err.message}`)
                    }
                })
            })
        }

        const refresh = async () => {
            try {
                paint(await trashAPI.list())
            } catch (err) {
                list.innerHTML = `
                    <div class="empty-state">
                        <p class="empty-title">Could not load the recycle bin</p>
                        <p class="empty-sub">${this._esc(err.message)}</p>
                    </div>`
                emptyBtn.disabled = true
            }
            // The view can be left while the listing is in flight.
            if (this.view !== 'trash') return
        }

        emptyBtn.addEventListener('click', async () => {
            const ok = await this._showModal({
                type: 'confirm',
                title: 'EMPTY RECYCLE BIN',
                message: 'Delete everything in the bin for good? This cannot be undone.',
                danger: true,
            })
            if (!ok) return
            try {
                const n = await trashAPI.empty()
                this._toast(`Deleted ${n} item${n === 1 ? '' : 's'}`)
                await refresh()
            } catch (err) {
                this._toast(`Could not empty the bin: ${err.message}`)
            }
        })

        refresh()
    }

    // ── Shared shell ──────────────────────────────────────────
    _shell(bodyHtml, { sidebar = true } = {}) {
        const currentTheme = localStorage.getItem(THEME_KEY) || 'system'
        const currentLabel = THEMES.find(t => t.id === currentTheme)?.label || 'System'

        const themeOptions = THEMES.map(t => `
            <button class="theme-dropdown-item ${t.id === currentTheme ? 'active' : ''}"
                    data-theme="${t.id}">
                <span class="theme-dropdown-swatch" data-theme="${t.id}"></span>
                <span class="theme-dropdown-label">${t.label}</span>
            </button>
        `).join('')

        const sidebarHtml = this._buildSidebarTree(null, 0)

        const sidebarEl = sidebar ? `
            <nav class="app-sidebar" id="app-sidebar">
                <div class="sidebar-header">
                    <span class="sidebar-title">Folders</span>
                    <button class="sidebar-new-btn" id="sidebar-new-folder" title="New folder">+</button>
                </div>
                <div class="sidebar-list">${sidebarHtml || this._sidebarEmpty()}</div>
                <div class="sidebar-footer">
                    <button class="sidebar-settings-btn" id="sidebar-settings-btn" title="Settings">
                        <span class="sidebar-settings-icon">&#9881;</span>
                        <span class="sidebar-settings-label">Settings</span>
                    </button>
                </div>
            </nav>
        ` : ''

        return `
            <div class="app-shell">
                <header class="app-header">
                    <div class="header-left">
                        ${sidebar ? `<button class="mobile-hamburger" id="mobile-menu-btn" title="Menu" aria-label="Open folder menu" aria-expanded="false" aria-controls="app-sidebar">
                            <span></span><span></span><span></span>
                        </button>` : ''}
                        <button class="breadcrumb-back-btn" id="breadcrumb-back" title="Back" aria-label="Back">&larr;</button>
                        <button class="app-logo-btn" id="go-home" title="Home">
                            <h1 class="app-title small" data-text="Thoughts">Thoughts</h1>
                        </button>
                        <nav class="breadcrumb" id="breadcrumb">${this._buildBreadcrumb()}</nav>
                    </div>
                    <div class="header-right">
                        <button class="sync-status-btn" id="sync-status-btn" title="Sync status">
                            <span class="sync-dot" id="sync-dot"></span>
                            <span class="sync-label" id="sync-label">Checking...</span>
                        </button>
                        <div class="header-actions-desktop">
                            <button class="header-icon-btn" id="graph-view-btn" title="Graph view (${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+G)">&#9672;</button>
                            <button class="header-icon-btn" id="cmd-palette-btn" title="Command palette (${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+P)">&#8984;</button>
                            <div class="theme-picker" id="theme-picker">
                                <button class="theme-toggle-btn" id="theme-toggle-btn" title="Change theme">
                                    <span class="theme-toggle-swatch" data-theme="${currentTheme}"></span>
                                    <span class="theme-toggle-label">${currentLabel}</span>
                                </button>
                                <div class="theme-dropdown" id="theme-dropdown">
                                    ${themeOptions}
                                </div>
                            </div>
                            <button class="header-logout-btn" id="logout-btn" title="Log out">
                                <span class="btn-text">LOG OUT</span>
                            </button>
                        </div>
                        <div class="header-overflow" id="header-overflow">
                            <button class="header-overflow-btn" id="header-overflow-btn" title="More" aria-label="More options" aria-expanded="false" aria-controls="header-overflow-menu">&#8942;</button>
                            <div class="header-overflow-menu" id="header-overflow-menu" role="menu">
                                <button class="overflow-item" id="overflow-graph">Graph view</button>
                                <button class="overflow-item" id="overflow-cmd">Command palette</button>
                                <button class="overflow-item" id="overflow-theme">Theme</button>
                                <button class="overflow-item" id="overflow-settings">Settings</button>
                                <button class="overflow-item overflow-logout" id="overflow-logout">Log out</button>
                            </div>
                        </div>
                    </div>
                </header>
                <div class="sidebar-scrim" id="sidebar-scrim"></div>
                <div class="app-body">
                    ${sidebarEl}
                    <main class="app-main">${bodyHtml}</main>
                </div>
                <div class="scanlines"></div>
                <div class="noise-overlay"></div>
            </div>
        `
    }

    // Recursively build sidebar folder tree with collapsible sections and .md file dots
    _buildSidebarTree(parentId, depth) {
        const children = parentId === null
            ? foldersAPI.listRoots()
            : foldersAPI.listChildren(parentId)
        if (!children.length) return ''

        return children.map(f => {
            const isActive = this.currentFolder?.id === f.id
            const subChildren = foldersAPI.listChildren(f.id)
            const hasChildren = subChildren.length > 0 || f.files.length > 0
            const isCollapsed = this._collapsedFolders.has(f.id)
            const indent = depth * 12

            // Build file dots (one dot per .md file)
            const fileDots = !isCollapsed && f.files.length > 0
                ? f.files.map(file => {
                    const isFileActive = this.currentFile?.id === file.id
                    const isStarred = this._starred.has(file.id)
                    return `
                    <button class="sidebar-file-dot ${isFileActive ? 'active' : ''}" data-folder-id="${f.id}" data-file-id="${file.id}"
                            title="${this._esc(file.title)}"
                            style="padding-left: calc(0.75rem + ${indent + 20}px)">
                        <span class="sidebar-dot-icon">${isStarred ? '&#9733;' : '·'}</span>
                        <span class="sidebar-dot-name">${this._esc(file.title)}</span>
                    </button>
                `}).join('')
                : ''

            const chevron = hasChildren
                ? `<span class="sidebar-chevron ${isCollapsed ? 'collapsed' : ''}">${isCollapsed ? '▶' : '▼'}</span>`
                : `<span class="sidebar-chevron-spacer"></span>`

            return `
                <div class="sidebar-folder-group">
                    <button class="sidebar-folder ${isActive ? 'active' : ''}"
                            data-folder-id="${f.id}"
                            data-drop-folder-id="${f.id}"
                            ${hasChildren ? `aria-expanded="${!isCollapsed}"` : ''}
                            style="padding-left: calc(0.75rem + ${indent}px)"
                            title="${this._esc(f.path)}">
                        <span class="sidebar-toggle" data-toggle-id="${f.id}">${hasChildren ? chevron : ''}</span>
                        <span class="sidebar-name">${this._esc(f.name)}</span>
                        <span class="sidebar-count">${f.files.length}</span>
                    </button>
                    ${!isCollapsed ? `
                        ${fileDots}
                        ${this._buildSidebarTree(f.id, depth + 1)}
                    ` : ''}
                </div>
            `
        }).join('')
    }

    _getAncestors(folder) {
        const chain = []
        let current = folder
        while (current) {
            chain.unshift(current)
            current = current.parentId
                ? foldersAPI.list().find(f => f.id === current.parentId)
                : null
        }
        return chain
    }

    _buildBreadcrumb() {
        if (this.view === 'folders') return ''

        if (this.view === 'files' && this.currentFolder) {
            const ancestors = this._getAncestors(this.currentFolder)
            const parts = ancestors.map((f, i) => {
                if (i === ancestors.length - 1) {
                    return `<span class="breadcrumb-current">${this._esc(f.name)}</span>`
                }
                return `<button class="breadcrumb-link" data-folder-id="${f.id}">${this._esc(f.name)}</button>`
            })
            return '/ ' + parts.join(' / ')
        }

        if (this.view === 'editor' && this.currentFolder && this.currentFile) {
            const ancestors = this._getAncestors(this.currentFolder)
            const folderParts = ancestors.map(f =>
                `<button class="breadcrumb-link" data-folder-id="${f.id}">${this._esc(f.name)}</button>`
            )
            return '/ ' + folderParts.join(' / ') +
                ` / <span class="breadcrumb-current">${this._esc(this.currentFile.title)}</span>`
        }

        return ''
    }

    _loading(message = 'Loading...') {
        return `<div class="empty-state"><p class="empty-headline loading-text">${message}</p></div>`
    }

    // An empty sidebar on a browser that has never synced means "not loaded
    // yet", not "you have no folders" — don't assert the second one.
    _sidebarEmpty() {
        return this._hasSynced
            ? '<p class="sidebar-empty">No folders yet</p>'
            : '<p class="sidebar-empty loading-text">Loading…</p>'
    }

    // Register a document-level listener that belongs to the current shell, so
    // the next render can take it back down. Every navigation used to leave two
    // more anonymous click handlers on `document`, each closing over a detached
    // menu element — they piled up for the life of the session and every click
    // ran all of them.
    _onDocument(type, handler) {
        document.addEventListener(type, handler)
        this._docListeners.push([type, handler])
    }

    // Same contract as _onDocument, for listeners that only exist on `window`.
    _onWindow(type, handler) {
        window.addEventListener(type, handler)
        this._winListeners = this._winListeners || []
        this._winListeners.push([type, handler])
    }

    _clearDocumentListeners() {
        if (this._docListeners) {
            this._docListeners.forEach(([type, fn]) => document.removeEventListener(type, fn))
        }
        this._docListeners = []
        if (this._winListeners) {
            this._winListeners.forEach(([type, fn]) => window.removeEventListener(type, fn))
        }
        this._winListeners = []
    }

    _bindShell() {
        // The shell is rebuilt from scratch on every render; drop the previous
        // one's document listeners before installing this one's.
        this._clearDocumentListeners()
        if (this._vvCleanup) { this._vvCleanup(); this._vvCleanup = null }

        // Sync status indicator
        this._updateSyncUI(syncStatus.get())
        if (this._syncUnsub) this._syncUnsub()
        this._syncUnsub = syncStatus.onChange(s => this._updateSyncUI(s))

        const syncBtn = this.container.querySelector('#sync-status-btn')
        if (syncBtn) syncBtn.addEventListener('click', () => {
            syncStatus.check()
            const pending = offlineQueue.getPending().length
            this._toast(`Sync: ${syncStatus.get()}${pending ? ` · ${pending} pending` : ''}`)
        })

        // ── Mobile slide-in drawer (replaces hidden sidebar) ──
        const hamburger = this.container.querySelector('#mobile-menu-btn')
        const drawer = this.container.querySelector('#app-sidebar')
        const scrim = this.container.querySelector('#sidebar-scrim')
        // The drawer only overlays the page on narrow screens; on a wide one it
        // is an ordinary column and must stay interactive.
        const mainEl = this.container.querySelector('.app-main') || this.container.querySelector('main')
        const setDrawerOpen = (open) => {
            if (!drawer) return
            drawer.classList.toggle('open', open)
            if (scrim) scrim.classList.toggle('open', open)
            if (hamburger) {
                hamburger.classList.toggle('open', open)
                hamburger.setAttribute('aria-expanded', String(open))
            }
            // While it covers the page it is modal: everything behind it leaves
            // the tab order, and a closed drawer takes its own buttons with it.
            const overlaying = this._isMobile()
            if (mainEl) mainEl.inert = overlaying && open
            drawer.inert = overlaying && !open
            if (open) drawer.querySelector('button, [href], input')?.focus?.({ preventScroll: true })
        }
        this._setDrawerOpen = setDrawerOpen
        this._closeDrawer = () => setDrawerOpen(false)
        if (hamburger && drawer && scrim) {
            setDrawerOpen(drawer.classList.contains('open'))
            hamburger.addEventListener('click', () => {
                setDrawerOpen(!drawer.classList.contains('open'))
            })
            scrim.addEventListener('click', () => this._closeDrawer())
            // Rotating to a wide layout turns the drawer back into an ordinary
            // column; without this it would stay inert and unclickable.
            this._onWindow('resize', () => setDrawerOpen(drawer.classList.contains('open')))
        }

        // ── Header overflow (kebab) menu — mobile ──
        const overflowBtn = this.container.querySelector('#header-overflow-btn')
        const overflowMenu = this.container.querySelector('#header-overflow-menu')
        if (overflowBtn && overflowMenu) {
            overflowBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                const open = overflowMenu.classList.toggle('open')
                overflowBtn.setAttribute('aria-expanded', String(open))
            })
            this._onDocument('click', (e) => {
                if (!overflowMenu.contains(e.target) && e.target !== overflowBtn) {
                    overflowMenu.classList.remove('open')
                    overflowBtn.setAttribute('aria-expanded', 'false')
                }
            })
            const route = (id, fn) => {
                const el = this.container.querySelector(id)
                if (el) el.addEventListener('click', () => {
                    overflowMenu.classList.remove('open')
                    overflowBtn.setAttribute('aria-expanded', 'false')
                    fn()
                })
            }
            // Overflow items delegate to the real (desktop-hidden) controls / handlers
            route('#overflow-graph', () => this._showGraphView())
            route('#overflow-cmd', () => this._showCommandPalette())
            route('#overflow-theme', () => this._showSettingsPanel())
            route('#overflow-settings', () => this._showSettingsPanel())
            route('#overflow-logout', () => this.container.querySelector('#logout-btn')?.click())
        }

        // ── Mobile back button (header) ──
        const backBtn = this.container.querySelector('#breadcrumb-back')
        if (backBtn) {
            // Hidden on the root folders view (nothing to go back to)
            backBtn.style.display = this.view === 'folders' ? 'none' : ''
            backBtn.addEventListener('click', async () => {
                if (this._saving) { this._toast('Please wait — save in progress...'); return }
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                if (this.view === 'editor') { this._navigate('files', { replace: true }); return }
                const parent = this.currentFolder?.parentId
                    ? foldersAPI.list().find(f => f.id === this.currentFolder.parentId)
                    : null
                if (parent) this._navigate('files', { folder: parent, replace: true })
                else this._navigate('folders', { replace: true })
            })
        }

        // Logout
        this.container.querySelector('#logout-btn').addEventListener('click', async () => {
            if (this._saving) { this._toast('Please wait — save in progress...'); return }
            if (this.view === 'editor' && this.editorDirty) {
                const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                if (!ok) return
            }
            this.editorDirty = false
            this.destroy()
            await auth.logout()
            this.onLogout()
        })

        // Home logo
        this.container.querySelector('#go-home').addEventListener('click', async () => {
            if (this._saving) { this._toast('Please wait — save in progress...'); return }
            if (this.editorDirty) {
                const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                if (!ok) return
            }
            this.editorDirty = false
            this._navigate('folders')
        })

        // Breadcrumb folder links
        this.container.querySelectorAll('.breadcrumb-link[data-folder-id]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (this._saving) { this._toast('Please wait — save in progress...'); return }
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (folder) this._navigate('files', { folder })
            })
        })

        // Theme picker (dropdown)
        const themeToggleBtn = this.container.querySelector('#theme-toggle-btn')
        const themeDropdown = this.container.querySelector('#theme-dropdown')
        if (themeToggleBtn && themeDropdown) {
            themeToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                themeDropdown.classList.toggle('open')
            })
            // Close dropdown when clicking outside
            this._onDocument('click', (e) => {
                if (!themeDropdown.contains(e.target) && e.target !== themeToggleBtn) {
                    themeDropdown.classList.remove('open')
                }
            })
            this.container.querySelectorAll('.theme-dropdown-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    this._applyTheme(btn.dataset.theme)
                    themeDropdown.classList.remove('open')
                    this._syncThemePicker(btn.dataset.theme)
                })
            })
        }

        // Sidebar folder clicks (navigate to folder)
        this.container.querySelectorAll('.sidebar-folder').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                // Check if user clicked the toggle chevron
                const toggle = e.target.closest('.sidebar-toggle')
                if (toggle) {
                    e.stopPropagation()
                    const folderId = toggle.dataset.toggleId || btn.dataset.folderId
                    this._toggleSidebarFolder(folderId)
                    return
                }
                if (this._saving) { this._toast('Please wait — save in progress...'); return }
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (folder) this._navigate('files', { folder })
            })
            this._bindSidebarFolderKeys(btn)
        })

        // Sidebar toggle buttons (chevrons without folder-id on the span)
        this.container.querySelectorAll('.sidebar-toggle[data-toggle-id]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._toggleSidebarFolder(btn.dataset.toggleId)
            })
        })

        // Sidebar file dots - open file directly
        this.container.querySelectorAll('.sidebar-file-dot').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation()
                if (this._saving) { this._toast('Please wait — save in progress...'); return }
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (!folder) return
                const file = folder.files.find(f => f.id === btn.dataset.fileId)
                if (file) {
                    this.currentFolder = folder
                    await this._openFile(file)
                }
            })
        })

        // Header action buttons (graph view, command palette)
        const graphViewBtn = this.container.querySelector('#graph-view-btn')
        if (graphViewBtn) graphViewBtn.addEventListener('click', () => this._showGraphView())
        const cmdPaletteBtn = this.container.querySelector('#cmd-palette-btn')
        if (cmdPaletteBtn) cmdPaletteBtn.addEventListener('click', () => this._showCommandPalette())

        // Sidebar new root folder button
        const sidebarNewBtn = this.container.querySelector('#sidebar-new-folder')
        if (sidebarNewBtn) {
            sidebarNewBtn.addEventListener('click', () => this._promptNewFolder(null))
        }

        // Sidebar settings button
        const sidebarSettingsBtn = this.container.querySelector('#sidebar-settings-btn')
        if (sidebarSettingsBtn) {
            sidebarSettingsBtn.addEventListener('click', () => this._showSettingsPanel())
        }

        // Sidebar drag-and-drop (drop folders/files onto sidebar items)
        this._bindSidebarDragDrop()
    }

    // ── Sidebar drag-and-drop ─────────────────────────────────
    _bindSidebarDragDrop() {
        this.container.querySelectorAll('.sidebar-folder[data-drop-folder-id]').forEach(btn => {
            btn.addEventListener('dragover', (e) => {
                const hasFolderDrag = e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('application/folder-id')
                const hasFileDrag = e.dataTransfer.types.includes('application/file-id')
                if (hasFolderDrag || hasFileDrag) {
                    e.preventDefault()
                    e.stopPropagation()
                    btn.classList.add('sidebar-drop-target')
                }
            })
            btn.addEventListener('dragleave', (e) => {
                // Only remove if actually leaving the button (not entering a child)
                if (!btn.contains(e.relatedTarget)) {
                    btn.classList.remove('sidebar-drop-target')
                }
            })
            btn.addEventListener('drop', async (e) => {
                e.preventDefault()
                e.stopPropagation()
                btn.classList.remove('sidebar-drop-target')
                const targetFolderId = btn.dataset.dropFolderId

                const fileId = e.dataTransfer.getData('application/file-id')
                if (fileId) {
                    // Moving a file into this sidebar folder
                    const sourceFolderId = this.currentFolder?.id
                        || foldersAPI.list().find(f => f.files.some(fi => fi.id === fileId))?.id
                    if (!sourceFolderId || sourceFolderId === targetFolderId) return
                    try {
                        await filesAPI.move(sourceFolderId, fileId, targetFolderId)
                        this.currentFolder = foldersAPI.list().find(f => f.id === sourceFolderId)
                        this._render()
                    } catch (err) {
                        this._toast(`Move error: ${err.message}`)
                    }
                    return
                }

                const folderId = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('application/folder-id')
                if (folderId && folderId !== targetFolderId) {
                    // Moving a folder into this sidebar folder
                    try {
                        await foldersAPI.move(folderId, targetFolderId)
                        this._render()
                    } catch (err) {
                        this._toast(`Move error: ${err.message}`)
                    }
                }
            })
        })
    }

    // The collapse chevron is a plain span inside the folder button, so a mouse
    // can aim at it but a keyboard cannot: activating the button always reports
    // the button itself as the target, and therefore always navigates. Left and
    // Right are the tree-widget convention for collapsing and expanding a node.
    _bindSidebarFolderKeys(btn) {
        btn.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            // Only folders with something to show carry aria-expanded, and only
            // those have a chevron to operate.
            if (!btn.hasAttribute('aria-expanded')) return
            const id = btn.dataset.folderId
            const collapsed = this._collapsedFolders.has(id)
            if (e.key === 'ArrowLeft' ? collapsed : !collapsed) return
            e.preventDefault()
            this._toggleSidebarFolder(id)
            // The list is rebuilt from scratch, taking the focused node with it.
            this.container.querySelector(`.sidebar-folder[data-folder-id="${id}"]`)?.focus()
        })
    }

    _toggleSidebarFolder(folderId) {
        if (this._collapsedFolders.has(folderId)) {
            this._collapsedFolders.delete(folderId)
        } else {
            this._collapsedFolders.add(folderId)
        }
        localStorage.setItem(SIDEBAR_OPEN_KEY, JSON.stringify([...this._collapsedFolders]))
        // Re-render just the sidebar list
        const sidebarList = this.container.querySelector('.sidebar-list')
        if (sidebarList) {
            sidebarList.innerHTML = this._buildSidebarTree(null, 0) || this._sidebarEmpty()
            // Re-bind sidebar events
            this.container.querySelectorAll('.sidebar-folder').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const toggle = e.target.closest('.sidebar-toggle')
                    if (toggle) {
                        e.stopPropagation()
                        this._toggleSidebarFolder(toggle.dataset.toggleId || btn.dataset.folderId)
                        return
                    }
                    if (this.editorDirty) {
                        const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                        if (!ok) return
                    }
                    this.editorDirty = false
                    const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                    if (folder) this._navigate('files', { folder })
                })
                this._bindSidebarFolderKeys(btn)
            })
            this.container.querySelectorAll('.sidebar-toggle[data-toggle-id]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    this._toggleSidebarFolder(btn.dataset.toggleId)
                })
            })
            this.container.querySelectorAll('.sidebar-file-dot').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation()
                    const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                    if (!folder) return
                    const file = folder.files.find(f => f.id === btn.dataset.fileId)
                    if (file) {
                        this.currentFolder = folder
                        await this._openFile(file)
                    }
                })
            })
            // Re-bind sidebar drag-and-drop after re-render
            this._bindSidebarDragDrop()
        }
    }

    // ── Folders view (root level) ──────────────────────────────
    _renderFolders() {
        // Keep the URL intact while a cold-boot destination is still pending —
        // rewriting it to "#/" here would erase the note the user asked for
        // before the listing arrives to resolve it.
        if (!this._pendingHash) pushHash(null, null, { replace: this._restoring })
        this._paintFolders(foldersAPI.listRoots())

        let retried = false
        const doSync = () => foldersAPI.listFromCloud()
            .then(() => {
                this._hasSynced = true
                this._syncFailed = false
                if (this.view === 'folders') this._paintFolders(foldersAPI.listRoots())
                this._resolvePendingHash()
            })
            .catch(err => {
                if (retried) {
                    // Out of retries: say so. Falling back to the empty state
                    // would claim the vault is empty when we simply couldn't
                    // reach it.
                    this._syncFailed = true
                    if (this.view === 'folders') this._paintFolders(foldersAPI.listRoots())
                    return
                }
                retried = true
                setTimeout(doSync, 5000)
                throw err
            })
        doSync().catch(() => {})
    }

    _paintFolders(folders) {
        const folderCards = folders.length
            ? folders.map((f) => `
                <div class="folder-card" data-id="${f.id}" draggable="true">
                    <div class="folder-icon">▶</div>
                    <div class="folder-info">
                        <span class="folder-name">${this._esc(f.name)}</span>
                        <span class="folder-meta">${f.files.length} file${f.files.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="folder-actions">
                        <button class="icon-btn move-item-btn" data-id="${f.id}" data-type="folder" title="Move" aria-label="Move folder ${this._esc(f.name)}">mv</button>
                        <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename" aria-label="Rename folder ${this._esc(f.name)}">rn</button>
                        <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete" aria-label="Delete folder ${this._esc(f.name)}">x</button>
                    </div>
                </div>
            `).join('')
            // Nothing to show yet. Which of the three reasons matters: a
            // browser that has never synced has an empty meta store, and
            // claiming "No folders yet" there tells the user their vault is
            // empty while it is still loading.
            : !this._hasSynced && !this._syncFailed
                ? Array.from({ length: 3 }, () => `
                    <div class="folder-card folder-card-skeleton" aria-hidden="true">
                        <div class="folder-icon">▶</div>
                        <div class="folder-info">
                            <span class="folder-name skeleton-bar"></span>
                            <span class="folder-meta skeleton-bar skeleton-bar-short"></span>
                        </div>
                    </div>
                `).join('')
            : this._syncFailed
                ? `<div class="empty-state">
                    <p class="empty-headline">Couldn't reach your vault</p>
                    <p class="empty-sub">Check your connection — your notes are safe.</p>
                    <button class="cyber-btn compact-btn" id="retry-sync-btn" style="margin-top:1rem;">
                        <span class="btn-text">Retry</span><span class="btn-glow"></span>
                    </button>
                   </div>`
            : `<div class="empty-state">
                <p class="empty-headline">No folders yet</p>
                <p class="empty-sub">Create a folder to get started</p>
               </div>`

        const body = `
            <div class="toolbar">
                <span class="section-label">Folders</span>
                <div class="toolbar-actions">
                    <button class="cyber-btn compact-btn" id="upload-root-folder-btn" title="Import an Obsidian vault or folder of .md files">
                        <span class="btn-text">Import vault</span>
                        <span class="btn-glow"></span>
                    </button>
                    <input type="file" id="root-folder-file-input" webkitdirectory multiple style="display:none">
                    <button class="cyber-btn compact-btn" id="trash-btn" title="Recently deleted notes">
                        <span class="btn-text">Recycle bin</span>
                        <span class="btn-glow"></span>
                    </button>
                    <button class="cyber-btn compact-btn" id="new-folder-btn">
                        <span class="btn-text">+ New folder</span>
                        <span class="btn-glow"></span>
                    </button>
                </div>
            </div>
            <div class="folder-grid" id="folder-grid">${folderCards}</div>
        `

        this.container.innerHTML = this._shell(body)
        this._bindShell()

        this.container.querySelector('#new-folder-btn').addEventListener('click', () => {
            this._promptNewFolder(null)
        })

        this.container.querySelector('#trash-btn').addEventListener('click', () => {
            this._navigate('trash')
        })

        const retryBtn = this.container.querySelector('#retry-sync-btn')
        if (retryBtn) retryBtn.addEventListener('click', () => {
            this._syncFailed = false
            this._renderFolders()
        })

        // Upload folder(s) to root
        const uploadRootBtn = this.container.querySelector('#upload-root-folder-btn')
        const rootFolderInput = this.container.querySelector('#root-folder-file-input')
        uploadRootBtn.addEventListener('click', () => rootFolderInput.click())
        rootFolderInput.addEventListener('change', () => this._handleRootFolderUpload(rootFolderInput))

        this.container.querySelectorAll('.folder-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.folder-actions')) return
                const folder = foldersAPI.list().find((f) => f.id === card.dataset.id)
                if (folder) this._navigate('files', { folder })
            })
        })

        this.container.querySelectorAll('.rename-folder-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._renameFolder(btn.dataset.id)
            })
        })

        this.container.querySelectorAll('.delete-folder-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._deleteFolder(btn.dataset.id)
            })
        })

        this.container.querySelectorAll('.move-item-btn[data-type="folder"]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._promptMoveFolder(btn.dataset.id)
            })
        })

        // Drag-and-drop reordering / reparenting on folder cards
        this._bindFolderDragDrop(this.container.querySelector('#folder-grid'), 'root')
    }

    // Once a folder's contents are on screen, pull its notes down and fill in
    // their timestamps. The user is reading filenames for a second or two —
    // that's exactly the window in which to make the note they're about to
    // click already local.
    _warmFolder(folder) {
        if (!folder) return
        foldersAPI.prefetchFolder(folder.id).catch(() => {})
        // Write the times straight into the cards that are already on screen.
        // Repainting the view instead would land a second or two after the user
        // started reading it: the scroll position jumps back to the top, an open
        // menu closes, and a drag in flight is cut because the handler holding
        // the dragged id belongs to the DOM that just went away.
        foldersAPI.backfillTimes(folder.id, (f) => {
            if (this.view !== 'files' || this.currentFolder?.id !== f.id) return
            for (const file of f.files) {
                const meta = this.container.querySelector(`.file-card[data-id="${file.id}"] .file-meta`)
                if (meta) meta.textContent = this._relTime(file.updated_at)
            }
        }).catch(() => {})
    }

    async _promptNewFolder(parentId) {
        const title = parentId ? 'NEW SUBFOLDER' : 'NEW FOLDER'
        const name = await this._showModal({ type: 'input', title, placeholder: 'Folder name...' })
        if (!name) return
        try {
            await foldersAPI.create(name, parentId)
            this._render()
        } catch (err) {
            this._toast(`Error: ${err.message}`)
        }
    }

    async _renameFolder(id) {
        const folder = foldersAPI.list().find((f) => f.id === id)
        if (!folder) return
        const name = await this._showModal({ type: 'input', title: 'RENAME FOLDER', placeholder: 'New name...', defaultValue: folder.name })
        if (!name) return
        try {
            // Renaming now relocates the folder's cloud objects, so it is async
            // and can fail — surface that instead of silently rendering a name
            // change that never reached storage.
            await foldersAPI.rename(id, name)
            this._render()
        } catch (err) {
            this._toast(`Error: ${err.message}`)
        }
    }

    async _renameFile(fileId) {
        const file = this.currentFolder?.files.find((f) => f.id === fileId)
            || foldersAPI.list().flatMap(f => f.files).find(f => f.id === fileId)
        if (!file) return
        const name = await this._showModal({ type: 'input', title: 'RENAME FILE', placeholder: 'New name...', defaultValue: file.title })
        if (!name) return
        try {
            await filesAPI.update(this.currentFolder.id, fileId, { title: name })
            this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
            this._render()
        } catch (err) {
            this._toast(`Error: ${err.message}`)
        }
    }

    async _deleteFolder(id) {
        const folder = foldersAPI.list().find((f) => f.id === id)
        if (!folder) return
        const childCount = foldersAPI.listChildren(id).length
        const what = childCount
            ? `"${folder.name}", all its subfolders, and all their notes`
            : `"${folder.name}" and all its notes`
        const msg = `Delete ${what}? The notes go to the recycle bin for ${trashAPI.retentionDays} days.`
        const ok = await this._showModal({ type: 'confirm', title: 'DELETE FOLDER', message: msg })
        if (!ok) return

        // Collect all files to show progress
        const allFiles = this._collectFolderFiles(id)
        const total = allFiles.length

        const isViewingDeleted = (this.view === 'files' || this.view === 'editor') &&
            this.currentFolder && (this.currentFolder.id === id || this._isDescendantOf(this.currentFolder.id, id))

        if (total > 0) {
            this._showProgressToast('Deleting', total)
            foldersAPI.deleteWithProgress(id, (done, t) => {
                this._updateProgressToast('Deleting', done, t)
            })
                .then(() => {
                    this._hideProgressToast()
                    if (isViewingDeleted) {
                        this.editorDirty = false
                        this._navigate('folders')
                    } else {
                        this._render()
                    }
                })
                .catch(err => {
                    this._hideProgressToast()
                    this._toast(`Delete error: ${err.message}`)
                })
        } else {
            foldersAPI.delete(id)
                .then(() => {
                    if (isViewingDeleted) {
                        this.editorDirty = false
                        this._navigate('folders')
                    } else {
                        this._render()
                    }
                })
                .catch(err => this._toast(`Delete error: ${err.message}`))
        }
    }

    _isDescendantOf(folderId, ancestorId) {
        const folder = foldersAPI.list().find(f => f.id === folderId)
        if (!folder || !folder.parentId) return false
        if (folder.parentId === ancestorId) return true
        return this._isDescendantOf(folder.parentId, ancestorId)
    }

    _collectFolderFiles(folderId) {
        const all = []
        const collect = (id) => {
            const f = foldersAPI.list().find(x => x.id === id)
            if (!f) return
            all.push(...f.files)
            foldersAPI.listChildren(id).forEach(c => collect(c.id))
        }
        collect(folderId)
        return all
    }

    // ── Files view (shows subfolders + files) ──────────────────
    _renderFiles() {
        this.currentFolder = foldersAPI.list().find((f) => f.id === this.currentFolder.id)
        if (!this.currentFolder) { this._navigate('folders'); return }
        pushHash(this.currentFolder.path, null, { replace: this._restoring })
        this._paintFiles()
        this._warmFolder(this.currentFolder)
    }

    _paintFiles() {
        const folder = this.currentFolder
        const subfolders = foldersAPI.listChildren(folder.id)
        const files = folder.files

        const subfolderCards = subfolders.map(f => `
            <div class="folder-card subfolder-card" data-id="${f.id}" draggable="true">
                <div class="folder-icon">▶</div>
                <div class="folder-info">
                    <span class="folder-name">${this._esc(f.name)}</span>
                    <span class="folder-meta">${f.files.length} file${f.files.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="folder-actions">
                    <button class="icon-btn move-item-btn" data-id="${f.id}" data-type="folder" title="Move" aria-label="Move folder ${this._esc(f.name)}">mv</button>
                    <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename" aria-label="Rename folder ${this._esc(f.name)}">rn</button>
                    <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete" aria-label="Delete folder ${this._esc(f.name)}">x</button>
                </div>
            </div>
        `).join('')

        const fileCards = files.map((f) => `
            <div class="file-card" data-id="${f.id}" draggable="true">
                <div class="file-icon">#</div>
                <div class="file-info">
                    <span class="file-title">${this._esc(f.title)}</span>
                    <span class="file-meta">${this._relTime(f.updated_at)}</span>
                </div>
                <div class="file-actions">
                    <button class="icon-btn move-item-btn" data-id="${f.id}" data-type="file" title="Move" aria-label="Move note ${this._esc(f.title)}">mv</button>
                    <button class="icon-btn rename-file-btn" data-id="${f.id}" title="Rename" aria-label="Rename note ${this._esc(f.title)}">rn</button>
                    <button class="icon-btn delete-file-btn" data-id="${f.id}" title="Delete" aria-label="Delete note ${this._esc(f.title)}">x</button>
                </div>
            </div>
        `).join('')

        const isEmpty = !subfolders.length && !files.length
        const contentHtml = isEmpty
            ? `<div class="empty-state">
                <p class="empty-headline">Empty folder</p>
                <p class="empty-sub">Create a file or subfolder to get started</p>
               </div>`
            : (subfolderCards + fileCards)

        const body = `
            <div class="toolbar">
                <span class="section-label">${this._esc(folder.name)}</span>
                <div class="toolbar-actions">
                    <button class="cyber-btn compact-btn" id="upload-folder-btn" title="Upload folder of .md files">
                        <span class="btn-text">Upload folder</span>
                        <span class="btn-glow"></span>
                    </button>
                    <input type="file" id="folder-file-input" webkitdirectory multiple style="display:none">
                    <button class="cyber-btn compact-btn" id="upload-md-btn" title="Upload .md files">
                        <span class="btn-text">Upload .md</span>
                        <span class="btn-glow"></span>
                    </button>
                    <input type="file" id="md-file-input" accept=".md,text/markdown" multiple style="display:none">
                    <button class="cyber-btn compact-btn" id="new-subfolder-btn">
                        <span class="btn-text">+ Subfolder</span>
                        <span class="btn-glow"></span>
                    </button>
                    <button class="cyber-btn compact-btn" id="new-file-btn">
                        <span class="btn-text">+ New file</span>
                        <span class="btn-glow"></span>
                    </button>
                </div>
            </div>
            <div class="file-list" id="file-list">${contentHtml}</div>
        `

        this.container.innerHTML = this._shell(body)
        this._bindShell()

        // Upload folder
        const uploadFolderBtn = this.container.querySelector('#upload-folder-btn')
        const folderFileInput = this.container.querySelector('#folder-file-input')
        uploadFolderBtn.addEventListener('click', () => folderFileInput.click())
        folderFileInput.addEventListener('change', () => this._handleFolderUpload(folderFileInput))

        // Upload .md files
        const uploadBtn = this.container.querySelector('#upload-md-btn')
        const fileInput = this.container.querySelector('#md-file-input')
        uploadBtn.addEventListener('click', () => fileInput.click())
        fileInput.addEventListener('change', () => this._handleMdUpload(fileInput))

        // New subfolder
        this.container.querySelector('#new-subfolder-btn').addEventListener('click', () => {
            this._promptNewFolder(folder.id)
        })

        // New file
        this.container.querySelector('#new-file-btn').addEventListener('click', () => {
            this._promptNewFile()
        })

        // Drag-and-drop
        const fileList = this.container.querySelector('#file-list')
        fileList.addEventListener('dragover', e => { e.preventDefault(); fileList.classList.add('drag-over') })
        fileList.addEventListener('dragleave', () => fileList.classList.remove('drag-over'))
        fileList.addEventListener('drop', e => {
            e.preventDefault()
            fileList.classList.remove('drag-over')
            const dt = e.dataTransfer
            if (dt?.files?.length) {
                const mdFiles = Array.from(dt.files).filter(f => f.name.endsWith('.md'))
                if (mdFiles.length) this._handleMdUpload({ files: mdFiles })
            }
        })

        // Subfolder card clicks
        this.container.querySelectorAll('.subfolder-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.folder-actions')) return
                const sub = foldersAPI.list().find((f) => f.id === card.dataset.id)
                if (sub) this._navigate('files', { folder: sub })
            })
        })

        this.container.querySelectorAll('.rename-folder-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._renameFolder(btn.dataset.id)
            })
        })

        this.container.querySelectorAll('.delete-folder-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._deleteFolder(btn.dataset.id)
            })
        })

        // File card clicks
        this.container.querySelectorAll('.file-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.file-actions')) return
                const file = this.currentFolder.files.find((f) => f.id === card.dataset.id)
                if (file) this._openFile(file)
            })
        })

        this.container.querySelectorAll('.delete-file-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._deleteFile(btn.dataset.id)
            })
        })

        this.container.querySelectorAll('.rename-file-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._renameFile(btn.dataset.id)
            })
        })

        // Move buttons
        this.container.querySelectorAll('.move-item-btn[data-type="folder"]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._promptMoveFolder(btn.dataset.id)
            })
        })

        this.container.querySelectorAll('.move-item-btn[data-type="file"]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                this._promptMoveFile(btn.dataset.id, folder.id)
            })
        })

        // Drag-and-drop. Subfolder cards live inside this list too, and the
        // binding below already accepts a note dropped onto one. A second drop
        // listener on those cards would run the move twice for a single drop,
        // which splices a bystander note out of the folder and leaves the moved
        // note listed twice in the destination.
        this._bindFolderDragDrop(fileList, folder.id)
    }

    // ── .md file upload with progress ────────────────────────
    async _handleMdUpload(input) {
        const files = Array.from(input.files || []).filter(f => f.name.endsWith('.md'))
        if (!files.length) return

        const total = files.length
        this._showProgressToast('Uploading', total)
        let succeeded = 0

        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            try {
                const content = await f.text()
                const title   = f.name.replace(/\.md$/i, '').replace(/-/g, ' ')
                await filesAPI.create(this.currentFolder.id, title, content)
                succeeded++
                this._updateProgressToast('Uploading', i + 1, total)
            } catch (err) {
                this._toast(`Upload error: ${f.name}: ${err.message}`)
                this._updateProgressToast('Uploading', i + 1, total)
            }
        }

        this._hideProgressToast()
        if (succeeded) {
            this._toast(`Uploaded ${succeeded} file${succeeded > 1 ? 's' : ''}`)
            this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
            this._render()
        }
        if (input.value !== undefined) input.value = ''
    }

    // ── Folder upload with progress ───────────────────────────
    async _handleFolderUpload(input) {
        const allFiles = Array.from(input.files || [])
        const mdFiles = allFiles.filter(f => f.name.endsWith('.md'))
        if (!mdFiles.length) {
            this._toast('No .md files found in folder')
            if (input.value !== undefined) input.value = ''
            return
        }

        const total = mdFiles.length
        this._showProgressToast('Uploading', total)
        let succeeded = 0
        let errors = 0

        for (let i = 0; i < mdFiles.length; i++) {
            const f = mdFiles[i]
            try {
                const relPath = f.webkitRelativePath || f.name
                const parts = relPath.split('/')
                const subParts = parts.slice(1)
                const fileName = subParts[subParts.length - 1]
                const subFolderParts = subParts.slice(0, -1)

                let targetFolder = this.currentFolder
                for (const seg of subFolderParts) {
                    if (!seg) continue
                    let child = foldersAPI.listChildren(targetFolder.id)
                        .find(c => c.name.toLowerCase() === seg.toLowerCase()
                                || c.path.endsWith('/' + seg.toLowerCase().replace(/\s+/g, '-')))
                    if (!child) {
                        child = await foldersAPI.create(seg, targetFolder.id)
                    }
                    targetFolder = foldersAPI.list().find(x => x.id === child.id) || child
                }

                const content = await f.text()
                const title   = fileName.replace(/\.md$/i, '').replace(/-/g, ' ')
                await filesAPI.create(targetFolder.id, title, content)
                succeeded++
                this._updateProgressToast('Uploading', i + 1, total)
            } catch (err) {
                errors++
                this._toast(`Error: ${f.name}: ${err.message}`)
                this._updateProgressToast('Uploading', i + 1, total)
            }
        }

        this._hideProgressToast()
        if (succeeded) {
            this._toast(`Uploaded ${succeeded} file${succeeded > 1 ? 's' : ''}${errors ? `, ${errors} failed` : ''}`)
            this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
            this._render()
        }
        if (input.value !== undefined) input.value = ''
    }

    // ── Root folder upload (multiple folders → root level) ────────
    _triggerVaultImport() {
        const input = document.createElement('input')
        input.type = 'file'
        input.webkitdirectory = true
        input.multiple = true
        input.addEventListener('change', () => this._handleRootFolderUpload(input))
        input.click()
    }

    async _handleRootFolderUpload(input) {
        const allFiles = Array.from(input.files || [])
        const mdFiles = allFiles.filter(f => f.name.endsWith('.md'))
        if (!mdFiles.length) {
            this._toast('No .md files found in selected folder(s)')
            if (input.value !== undefined) input.value = ''
            return
        }

        const total = mdFiles.length
        this._showProgressToast('Importing', total)
        let succeeded = 0
        let errors = 0

        for (let i = 0; i < mdFiles.length; i++) {
            const f = mdFiles[i]
            try {
                const relPath = f.webkitRelativePath || f.name
                const parts = relPath.split('/')
                // parts[0] is the selected root folder name, parts[1..n-1] are subfolders, last is file
                const folderParts = parts.slice(0, -1)  // all segments except filename
                const fileName = parts[parts.length - 1]

                // Skip Obsidian config files
                if (folderParts.some(seg => seg === '.obsidian' || seg === '.trash')) {
                    this._updateProgressToast('Importing', i + 1, total)
                    continue
                }

                // Build/find folder hierarchy starting at root (parentId = null)
                let targetFolder = null
                let parentId = null

                for (const seg of folderParts) {
                    if (!seg) continue
                    let existing = parentId
                        ? foldersAPI.listChildren(parentId).find(c =>
                            c.name.toLowerCase() === seg.toLowerCase() ||
                            c.path.endsWith('/' + seg.toLowerCase().replace(/\s+/g, '-')))
                        : foldersAPI.listRoots().find(c =>
                            c.name.toLowerCase() === seg.toLowerCase() ||
                            c.path === seg.toLowerCase().replace(/\s+/g, '-'))

                    if (!existing) {
                        existing = await foldersAPI.create(seg, parentId)
                    }
                    targetFolder = foldersAPI.list().find(x => x.id === existing.id) || existing
                    parentId = targetFolder.id
                }

                if (!targetFolder) {
                    errors++
                    this._updateProgressToast('Importing', i + 1, total)
                    continue
                }

                const content = await f.text()
                const title = fileName.replace(/\.md$/i, '').replace(/-/g, ' ')
                await filesAPI.create(targetFolder.id, title, content)
                succeeded++
                this._updateProgressToast('Importing', i + 1, total)
            } catch (err) {
                errors++
                this._toast(`Error: ${f.name}: ${err.message}`)
                this._updateProgressToast('Importing', i + 1, total)
            }
        }

        this._hideProgressToast()
        if (succeeded) {
            this._toast(`Imported ${succeeded} file${succeeded > 1 ? 's' : ''}${errors ? `, ${errors} failed` : ''}`)
            this._render()
        } else if (errors) {
            this._toast(`Import failed: ${errors} error${errors > 1 ? 's' : ''}`)
        }
        if (input.value !== undefined) input.value = ''
    }

    // ── Move folder dialog ─────────────────────────────────────
    async _promptMoveFolder(folderId) {
        const folder = foldersAPI.list().find(f => f.id === folderId)
        if (!folder) return

        const allFolders = foldersAPI.list().filter(f => f.id !== folderId)
        const target = await this._showMoveMenu(
            `MOVE FOLDER: ${folder.name}`,
            allFolders,
            true   // include "Root" option
        )
        if (target === undefined) return  // cancelled

        try {
            await foldersAPI.move(folderId, target)
            this._render()
        } catch (err) {
            this._toast(`Move error: ${err.message}`)
        }
    }

    // ── Move file dialog ───────────────────────────────────────
    async _promptMoveFile(fileId, sourceFolderId) {
        const file = this.currentFolder?.files.find(f => f.id === fileId)
            || foldersAPI.list().flatMap(f => f.files).find(f => f.id === fileId)
        if (!file) return

        const allFolders = foldersAPI.list().filter(f => f.id !== sourceFolderId)
        const target = await this._showMoveMenu(
            `MOVE FILE: ${file.title}`,
            allFolders,
            false  // no "Root" for files (they must live in a folder)
        )
        if (target === undefined || target === null) return

        try {
            await filesAPI.move(sourceFolderId, fileId, target)
            this.currentFolder = foldersAPI.list().find(f => f.id === sourceFolderId)
            this._render()
        } catch (err) {
            this._toast(`Move error: ${err.message}`)
        }
    }

    // ── Generic move-target menu ───────────────────────────────
    _showMoveMenu(title, folders, includeRoot = false) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div')
            overlay.className = 'move-menu-overlay'

            // Sort folders by path depth then name
            const sorted = [...folders].sort((a, b) => {
                const da = a.path.split('/').length
                const db = b.path.split('/').length
                if (da !== db) return da - db
                return a.name.localeCompare(b.name)
            })

            const rootOption = includeRoot
                ? `<button class="move-menu-item" data-id="__root__">
                    <span class="move-menu-depth">/ </span>
                    <span class="move-menu-name">Root (top level)</span>
                   </button>`
                : ''

            const folderItems = sorted.map(f => {
                const depth = f.path.split('/').length
                const prefix = '  '.repeat(depth - 1)
                return `<button class="move-menu-item" data-id="${f.id}">
                    <span class="move-menu-depth">${prefix}</span>
                    <span class="move-menu-name">${this._esc(f.name)}</span>
                   </button>`
            }).join('')

            overlay.innerHTML = `
                <div class="move-menu-box" role="dialog" aria-modal="true" aria-labelledby="move-menu-title">
                    <div class="move-menu-title" id="move-menu-title">${this._esc(title)}</div>
                    <label class="sr-only" for="move-menu-search">Search folders</label>
                    <input type="text" id="move-menu-search" class="move-menu-search" placeholder="Search folders...">
                    <div class="move-menu-list">${rootOption}${folderItems}</div>
                    <div class="move-menu-actions">
                        <button class="modal-btn modal-cancel">CANCEL</button>
                    </div>
                </div>
            `
            document.body.appendChild(overlay)

            const searchInput = overlay.querySelector('.move-menu-search')
            const listEl = overlay.querySelector('.move-menu-list')

            const cancel = () => { release(); overlay.remove(); resolve(undefined) }
            const release = this._trapModal(overlay, () => cancel())

            searchInput.focus()

            searchInput.addEventListener('input', () => {
                const q = searchInput.value.toLowerCase()
                overlay.querySelectorAll('.move-menu-item').forEach(btn => {
                    const name = btn.querySelector('.move-menu-name').textContent.toLowerCase()
                    btn.style.display = (!q || name.includes(q)) ? '' : 'none'
                })
            })

            overlay.querySelectorAll('.move-menu-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    release()
                    overlay.remove()
                    const id = btn.dataset.id
                    resolve(id === '__root__' ? null : id)
                })
            })

            overlay.querySelector('.modal-cancel').addEventListener('click', cancel)

            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
            })
        })
    }

    // ── Drag-and-drop folder/file card reordering ──────────────
    _bindFolderDragDrop(container, contextParentId) {
        if (!container) return
        let draggingCard = null
        let draggingId = null

        container.querySelectorAll('.folder-card, .subfolder-card').forEach(card => {
            card.addEventListener('dragstart', (e) => {
                draggingCard = card
                draggingId = card.dataset.id
                card.classList.add('drag-dragging')
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', draggingId)
            })
            card.addEventListener('dragend', () => {
                card.classList.remove('drag-dragging')
                container.querySelectorAll('.drag-target-over').forEach(el => el.classList.remove('drag-target-over'))
                draggingCard = null
                draggingId = null
            })
            card.addEventListener('dragover', (e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (card !== draggingCard) {
                    container.querySelectorAll('.drag-target-over').forEach(el => el.classList.remove('drag-target-over'))
                    card.classList.add('drag-target-over')
                }
            })
            card.addEventListener('dragleave', () => {
                card.classList.remove('drag-target-over')
            })
            card.addEventListener('drop', async (e) => {
                e.preventDefault()
                card.classList.remove('drag-target-over')
                const targetId = card.dataset.id
                if (!draggingId || draggingId === targetId) return
                // If a file card was dragged onto a folder card, handle as file move (not folder move)
                if (e.dataTransfer.types.includes('application/file-id')) {
                    const fileId = e.dataTransfer.getData('application/file-id')
                    if (!fileId) return
                    const sourceFolderId = this.currentFolder?.id
                        || foldersAPI.list().find(f => f.files.some(fi => fi.id === fileId))?.id
                    if (!sourceFolderId || sourceFolderId === targetId) return
                    try {
                        await filesAPI.move(sourceFolderId, fileId, targetId)
                        this.currentFolder = foldersAPI.list().find(f => f.id === sourceFolderId)
                        this._render()
                    } catch (err) {
                        this._toast(`Move error: ${err.message}`)
                    }
                    return
                }
                // Folder drag onto folder
                const folder = foldersAPI.list().find(f => f.id === draggingId)
                if (!folder) return  // silently ignore if folder not found (stale drag)
                try {
                    await foldersAPI.move(draggingId, targetId)
                    this._render()
                } catch (err) {
                    this._toast(`Move error: ${err.message}`)
                }
            })
        })

        // File cards inside the same container
        container.querySelectorAll('.file-card').forEach(card => {
            card.setAttribute('draggable', 'true')
            card.addEventListener('dragstart', (e) => {
                draggingCard = card
                draggingId = card.dataset.id
                card.classList.add('drag-dragging')
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('application/file-id', card.dataset.id)
            })
            card.addEventListener('dragend', () => {
                card.classList.remove('drag-dragging')
                draggingCard = null
                draggingId = null
            })
        })
    }

    async _promptNewFile() {
        const title = await this._showModal({ type: 'input', title: 'NEW FILE', placeholder: 'File title...' })
        if (!title) return
        filesAPI.create(this.currentFolder.id, title)
            .then(file => this._openFile(file))
            .catch(err => this._toast(`Error: ${err.message}`))
    }

    async _deleteFile(fileId) {
        const file = this.currentFolder.files.find((f) => f.id === fileId)
        if (!file) return
        const ok = await this._showModal({
            type: 'confirm',
            title: 'DELETE NOTE',
            message: `Delete "${file.title}"? It goes to the recycle bin for ${trashAPI.retentionDays} days.`,
        })
        if (!ok) return
        filesAPI.delete(this.currentFolder.id, fileId)
            .then(() => {
                this.currentFolder = foldersAPI.list().find((f) => f.id === this.currentFolder.id)
                if (this.view === 'editor' && this.currentFile && this.currentFile.id === fileId) {
                    this.editorDirty = false
                    this._navigate('files')
                } else {
                    this._render()
                }
            })
            .catch(err => this._toast(`Delete error: ${err.message}`))
    }

    // ── Open file ─────────────────────────────────────────────
    // Every route into the editor comes through here — the file list, the
    // sidebar, the quick switcher, a wikilink, a backlink, a search hit, the
    // graph. Each one replaces the editor's DOM, so the guard belongs here
    // rather than at the call sites: only three of ten used to carry it, and
    // the rest silently threw away whatever was unsaved.
    async _openFile(file) {
        if (this.editorDirty && this.currentFile && this.currentFile.id !== file.id) {
            const keep = await this._showModal({
                type: 'confirm',
                title: 'UNSAVED CHANGES',
                message: `Save "${this.currentFile.title}" before opening "${file.title}"?`,
            })
            if (keep) {
                try { await this.flushSave() } catch { /* queued for retry */ }
            }
        }
        // The autosave armed for the note we are leaving must not fire against
        // the one we are opening.
        clearTimeout(this._autosaveTimer)
        clearTimeout(this._previewTimer)
        this.currentFile = file
        this.view = 'editor'
        this.editorDirty = false
        pushHash(this.currentFolder.path, fileSlugOf(file), { replace: this._restoring })
        // Track in recent files
        this._addRecent(this.currentFolder.id, file.id, file.title)

        // A note we already hold — just created, opened earlier this session, or
        // pulled down by the background prefetch — can be filled in from the
        // persistent cache synchronously, so the editor paints on this frame
        // instead of showing a spinner while the network answers.
        if (!file.contentLoaded) filesAPI.peekCached(this.currentFolder.id, file.id)

        // Called if the cloud copy turns out to differ from what we rendered.
        const applyFresh = (loaded) => {
            if (this.view !== 'editor' || !this.currentFile || this.currentFile.id !== file.id) return
            if (this.editorDirty) return
            this.currentFile = loaded
            const contentArea = this.container.querySelector('#file-content')
            const preview = this.container.querySelector('#editor-preview')
            if (contentArea) {
                contentArea.value = loaded.content || ''
                if (preview) this._renderPreview(preview, contentArea.value)
            }
        }

        if (file.contentLoaded) {
            this._renderEditor()
            // Still revalidate against the cloud so edits from another device land.
            // The resolved record matters as much as the onFresh callback: when
            // the body is fetched rather than served from cache, loadContent
            // fills it in on the record and returns, without calling back — and
            // the editor would keep showing whatever stale body it painted with.
            filesAPI.loadContent(this.currentFolder.id, file.id, applyFresh)
                .then(applyFresh)
                .catch(() => {})
        } else {
            this.container.innerHTML = this._shell(this._loading('Loading file...'))
            this._bindShell()

            filesAPI.loadContent(this.currentFolder.id, file.id, applyFresh)
                .then(loaded => {
                    if (this.view === 'editor' && this.currentFile.id === file.id) {
                        this.currentFile = loaded
                        this._renderEditor()
                    }
                })
                .catch(err => {
                    if (err && err.code === 'app/file-missing') {
                        filesAPI.forgetLocal(this.currentFolder.id, file.id)
                        this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
                        this.currentFile = null
                        this.editorDirty = false
                        this._navigate('files', { folder: this.currentFolder })
                        this._toast('That note was deleted on another device and has been removed here.')
                        return
                    }
                    // Never leave the editor stuck on "Loading file...", but do
                    // not pretend the note is empty either. Marking the record
                    // loaded with a blank body outlives the session — it is
                    // written to local meta — and the next save or move would
                    // then copy that blank over the real note in the cloud.
                    if (this.view === 'editor' && this.currentFile.id === file.id) {
                        this._renderLoadFailed(file, err)
                    }
                    this._toast(`Load error: ${err.message}`)
                })
        }
    }

    // ── Note we couldn't read ─────────────────────────────────
    // Shown instead of the editor when the body never arrived. There is no
    // textarea here on purpose: an editor primed with a blank body invites the
    // user to type into it, and the save that follows replaces the note in the
    // cloud with what they typed.
    _renderLoadFailed(file, err) {
        const detail = err && err.message ? err.message : 'The note could not be read.'
        const body = `
            <div class="empty-state">
                <p class="empty-headline">Couldn't load this note</p>
                <p class="empty-sub">${this._esc(detail)} — nothing has been changed.</p>
                <button class="cyber-btn compact-btn" id="retry-load-btn" style="margin-top:1rem;">
                    <span class="btn-text">Retry</span><span class="btn-glow"></span>
                </button>
            </div>
        `
        this.container.innerHTML = this._shell(body)
        this._bindShell()
        const retryBtn = this.container.querySelector('#retry-load-btn')
        if (retryBtn) retryBtn.addEventListener('click', () => this._openFile(file))
    }

    // ── Editor view ───────────────────────────────────────────
    _renderEditor() {
        const file = this.currentFile
        const folder = this.currentFolder
        // Any repaint of the editor — a move elsewhere in the tree, a settings
        // change — must honour the same rule as the first one: without a body
        // we know to be the note's own, there is nothing safe to edit.
        if (!file.contentLoaded) { this._renderLoadFailed(file); return }
        const mode = this._isMobile() ? 'edit' : this.editorMode
        const autosaveChecked = this.autosave ? 'checked' : ''

        const modeButtons = `
            <div class="mode-toggle" id="mode-toggle">
                ${!this._isMobile() ? `
                <button class="mode-btn ${mode === 'split' ? 'active' : ''}" data-mode="split" title="Split view" aria-pressed="${mode === 'split'}">Split</button>
                ` : ''}
                <button class="mode-btn ${mode === 'edit' ? 'active' : ''}" data-mode="edit" title="Edit only" aria-pressed="${mode === 'edit'}">Edit</button>
                <button class="mode-btn ${mode === 'preview' ? 'active' : ''}" data-mode="preview" title="Preview only" aria-pressed="${mode === 'preview'}">Preview</button>
            </div>
        `

        const contentLen = (file.content || '').length
        const wordCount = (file.content || '').trim() ? (file.content || '').trim().split(/\s+/).length : 0
        const lineCount = (file.content || '').split('\n').length
        const readTime = Math.max(1, Math.ceil(wordCount / 200))

        const body = `
            <div class="editor-zone" data-mode="${mode}" id="editor-zone">
                <div class="editor-toolbar">
                    <input
                        type="text"
                        id="file-title"
                        class="cyber-input title-input"
                        placeholder="File title..."
                        aria-label="File title"
                        maxlength="200"
                    />
                    <div class="editor-actions">
                        <button class="editor-back-btn" id="editor-back-btn" title="Back (ESC)">&larr; Back</button>
                        ${modeButtons}
                        <label class="autosave-toggle" title="Toggle autosave">
                            <input type="checkbox" id="autosave-check" ${autosaveChecked}>
                            <span class="autosave-label">AUTO</span>
                        </label>
                        <button class="cyber-btn compact-btn" id="pdf-btn" title="Export as PDF">
                            <span class="btn-text">PDF</span>
                            <span class="btn-glow"></span>
                        </button>
                        <button class="cyber-btn compact-btn" id="focus-btn" title="Focus mode (distraction-free)">
                            <span class="btn-text">Focus</span>
                            <span class="btn-glow"></span>
                        </button>
                        <button class="cyber-btn compact-btn" id="star-btn" title="Star this note">
                            <span class="btn-text">${this._starred.has(file.id) ? '&#9733;' : '&#9734;'}</span>
                            <span class="btn-glow"></span>
                        </button>
                        <button class="cyber-btn compact-btn" id="outline-btn" title="Toggle outline">
                            <span class="btn-text">Outline</span>
                            <span class="btn-glow"></span>
                        </button>
                        <button class="cyber-btn compact-btn" id="backlinks-btn" title="Toggle backlinks">
                            <span class="btn-text">Backlinks</span>
                            <span class="btn-glow"></span>
                        </button>
                        <button class="cyber-btn compact-btn" id="shortcuts-btn" title="Keyboard shortcuts">
                            <span class="btn-text">?</span>
                            <span class="btn-glow"></span>
                        </button>
                        <span class="save-status" id="save-status"></span>
                        <button class="cyber-btn compact-btn" id="save-btn">
                            <span class="btn-text">Save</span>
                            <span class="btn-glow"></span>
                        </button>
                        <div class="editor-actions-menu-wrap">
                            <button class="editor-actions-menu-btn" id="editor-menu-btn" title="More" aria-label="More editor actions" aria-expanded="false" aria-controls="editor-actions-menu">&#8942;</button>
                            <div class="editor-actions-menu hidden" id="editor-actions-menu">
                                <button class="menu-item" data-action="pdf">Export PDF</button>
                                <button class="menu-item" data-action="focus">Focus mode</button>
                                <button class="menu-item" data-action="star">Star note</button>
                                <button class="menu-item" data-action="outline">Toggle outline</button>
                                <button class="menu-item" data-action="backlinks">Toggle backlinks</button>
                                <button class="menu-item" data-action="shortcuts">Shortcuts</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="format-toolbar" id="format-toolbar" role="toolbar" aria-label="Markdown formatting">
                    <button class="fmt-btn" data-fmt="bold" title="Bold (Ctrl+B)"><b>B</b></button>
                    <button class="fmt-btn" data-fmt="italic" title="Italic (Ctrl+I)"><i>I</i></button>
                    <button class="fmt-btn" data-fmt="strikethrough" title="Strikethrough"><s>S</s></button>
                    <span class="fmt-sep"></span>
                    <button class="fmt-btn" data-fmt="h1" title="Heading 1">H1</button>
                    <button class="fmt-btn" data-fmt="h2" title="Heading 2">H2</button>
                    <button class="fmt-btn" data-fmt="h3" title="Heading 3">H3</button>
                    <span class="fmt-sep"></span>
                    <button class="fmt-btn" data-fmt="code" title="Inline code">&lt;/&gt;</button>
                    <button class="fmt-btn" data-fmt="codeblock" title="Code block">{ }</button>
                    <button class="fmt-btn" data-fmt="quote" title="Blockquote">&gt;</button>
                    <span class="fmt-sep"></span>
                    <button class="fmt-btn" data-fmt="ul" title="Bullet list">&#8226; List</button>
                    <button class="fmt-btn" data-fmt="ol" title="Numbered list">1. List</button>
                    <button class="fmt-btn" data-fmt="task" title="Task list">&#9744; Task</button>
                    <span class="fmt-sep"></span>
                    <button class="fmt-btn" data-fmt="link" title="Insert link">Link</button>
                    <button class="fmt-btn" data-fmt="image" title="Insert image">Img</button>
                    <button class="fmt-btn" data-fmt="hr" title="Horizontal rule">---</button>
                    <span class="fmt-sep"></span>
                    <button class="fmt-btn" data-fmt="table" title="Insert table">Table</button>
                    <span class="fmt-sep"></span>
                    <button class="fmt-btn" data-fmt="wikilink" title="Internal link [[...]]">[[]]</button>
                    <button class="fmt-btn" data-fmt="tag" title="Tag">#tag</button>
                    <button class="fmt-btn" data-fmt="callout" title="Callout block">Callout</button>
                    <button class="fmt-btn" data-fmt="highlight" title="Highlight">==</button>
                    <button class="fmt-btn" data-fmt="footnote" title="Footnote">[^]</button>
                    <button class="fmt-btn fmt-more-btn" id="fmt-more" title="More formatting" aria-label="More formatting" aria-expanded="false">+</button>
                </div>
                <div class="editor-body">
                    <div class="editor-pane">
                        <textarea
                            id="file-content"
                            class="cyber-textarea editor-textarea"
                            placeholder="Start writing..."
                            aria-label="Note content"
                        ></textarea>
                    </div>
                    <div class="editor-divider"></div>
                    <div class="preview-pane">
                        <div class="editor-preview" id="editor-preview"></div>
                    </div>
                </div>
                <div class="editor-footer">
                    <div class="editor-stats" id="editor-stats">
                        <span class="char-count" id="char-count">${contentLen} chars</span>
                        <span class="word-count" id="word-count">${wordCount} words</span>
                        <span class="line-count" id="line-count">${lineCount} lines</span>
                        <span class="read-time" id="read-time">${readTime} min read</span>
                    </div>
                    <div class="editor-footer-right">
                        <button class="editor-hint-btn" id="heading-jump-btn" title="Jump to heading">Headings</button>
                        <span class="editor-hint">ESC to go back</span>
                    </div>
                </div>
            </div>
            <div class="find-replace-bar hidden" id="find-replace-bar">
                <div class="find-replace-row">
                    <input type="text" class="find-input" id="find-input" placeholder="Find..." aria-label="Find text" />
                    <span class="find-count" id="find-count">0/0</span>
                    <button class="find-nav-btn" id="find-prev" title="Previous">&uarr;</button>
                    <button class="find-nav-btn" id="find-next" title="Next">&darr;</button>
                    <button class="find-nav-btn" id="find-toggle-replace" title="Toggle replace">&#8597;</button>
                    <button class="find-close-btn" id="find-close" aria-label="Close find and replace">&times;</button>
                </div>
                <div class="find-replace-row replace-row hidden" id="replace-row">
                    <input type="text" class="find-input" id="replace-input" placeholder="Replace..." aria-label="Replacement text" />
                    <button class="find-nav-btn" id="replace-one" title="Replace">Replace</button>
                    <button class="find-nav-btn" id="replace-all" title="Replace all">All</button>
                </div>
            </div>
        `

        this.container.innerHTML = this._shell(body)
        this._bindShell()

        const titleInput  = this.container.querySelector('#file-title')
        const contentArea = this.container.querySelector('#file-content')
        const saveBtn     = this.container.querySelector('#save-btn')
        const saveStatus  = this.container.querySelector('#save-status')
        const charCount   = this.container.querySelector('#char-count')
        const wordCountEl = this.container.querySelector('#word-count')
        const lineCountEl = this.container.querySelector('#line-count')
        const readTimeEl  = this.container.querySelector('#read-time')
        const preview     = this.container.querySelector('#editor-preview')
        const editorZone  = this.container.querySelector('#editor-zone')
        const autosaveChk = this.container.querySelector('#autosave-check')
        const pdfBtn      = this.container.querySelector('#pdf-btn')
        const focusBtn    = this.container.querySelector('#focus-btn')
        const shortcutsBtn = this.container.querySelector('#shortcuts-btn')
        const headingJumpBtn = this.container.querySelector('#heading-jump-btn')
        const starBtn = this.container.querySelector('#star-btn')
        const outlineBtn = this.container.querySelector('#outline-btn')
        const backlinksBtn = this.container.querySelector('#backlinks-btn')

        // Assigned rather than written into the markup: a title containing a
        // quote would come back truncated at that quote, and the next save
        // writes the truncation back as the note's real name.
        titleInput.value = file.title || ''
        // A re-render triggered from inside the editor (a new folder, an
        // import, a sidebar drop) rebuilds this textarea. Repainting it from
        // the last SAVED body would silently revert whatever is unsaved, so
        // carry the live text across instead.
        const carried = this.editorDirty && this._liveBody != null ? this._liveBody : null
        contentArea.value = carried != null ? carried : (file.content || '')
        this._liveBody = null
        this._renderPreview(preview, contentArea.value)

        // Autosave toggle
        autosaveChk.addEventListener('change', () => {
            this.autosave = autosaveChk.checked
            localStorage.setItem(AUTOSAVE_KEY, this.autosave)
        })

        // PDF export
        pdfBtn.addEventListener('click', () => this._exportPDF(titleInput.value, preview))

        // Focus mode toggle
        focusBtn.addEventListener('click', () => this._toggleFocusMode(editorZone))

        // Shortcuts help
        shortcutsBtn.addEventListener('click', () => this._showShortcutsPanel())

        // Heading jump navigation
        headingJumpBtn.addEventListener('click', () => this._showHeadingJump(contentArea))

        // Star/favorite toggle
        starBtn.addEventListener('click', () => {
            this._toggleStar(file.id)
            starBtn.querySelector('.btn-text').innerHTML = this._starred.has(file.id) ? '&#9733;' : '&#9734;'
        })

        // Outline panel
        outlineBtn.addEventListener('click', () => {
            this._outlineOpen = !this._outlineOpen
            this._updateOutlinePanel()
        })

        // Backlinks panel
        backlinksBtn.addEventListener('click', () => {
            this._backlinksOpen = !this._backlinksOpen
            this._updateBacklinksPanel()
        })

        // Show outline/backlinks if they were open
        if (this._outlineOpen) this._updateOutlinePanel()
        if (this._backlinksOpen) this._updateBacklinksPanel()

        // ── Mobile editor back button (ESC has no key on touch keyboards) ──
        const editorBack = this.container.querySelector('#editor-back-btn')
        if (editorBack) {
            editorBack.addEventListener('click', async () => {
                if (this._saving) { this._toast('Please wait — save in progress...'); return }
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                this._navigate('files', { replace: true })
            })
        }

        // ── Editor actions overflow (kebab) menu — mobile ──
        const editorMenuBtn = this.container.querySelector('#editor-menu-btn')
        const editorMenu = this.container.querySelector('#editor-actions-menu')
        if (editorMenuBtn && editorMenu) {
            editorMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                editorMenu.classList.toggle('hidden')
                editorMenuBtn.setAttribute('aria-expanded', String(!editorMenu.classList.contains('hidden')))
            })
            this._onDocument('click', (e) => {
                if (!editorMenu.contains(e.target) && e.target !== editorMenuBtn) {
                    editorMenu.classList.add('hidden')
                    editorMenuBtn.setAttribute('aria-expanded', 'false')
                }
            })
            // Menu items delegate to the real (mobile-hidden) action buttons
            const delegate = { pdf: pdfBtn, focus: focusBtn, star: starBtn, outline: outlineBtn, backlinks: backlinksBtn, shortcuts: shortcutsBtn }
            editorMenu.querySelectorAll('.menu-item').forEach(item => {
                item.addEventListener('click', () => {
                    editorMenu.classList.add('hidden')
                    editorMenuBtn.setAttribute('aria-expanded', 'false')
                    const target = delegate[item.dataset.action]
                    if (target) target.click()
                })
            })
        }

        // ── Format toolbar "more" toggle — reveal secondary buttons on mobile ──
        const fmtMore = this.container.querySelector('#fmt-more')
        const fmtToolbar = this.container.querySelector('#format-toolbar')
        if (fmtMore && fmtToolbar) {
            fmtMore.addEventListener('click', (e) => {
                e.preventDefault()
                const expanded = fmtToolbar.classList.toggle('fmt-expanded')
                fmtMore.textContent = expanded ? '−' : '+'
                fmtMore.setAttribute('aria-expanded', String(expanded))
            })
        }

        // ── Robust editor height on iOS via visualViewport ──
        // Fixed calc(100dvh - …) fights the dynamic URL bar + software keyboard.
        if (this._isMobile() && window.visualViewport && editorZone) {
            const vv = window.visualViewport
            // The keyboard is measured against the tallest viewport seen while
            // no field was focused. Comparing against window.innerHeight cannot
            // work: the page asks for interactive-widget=resizes-content, so the
            // layout viewport shrinks with the keyboard too and the two heights
            // stay equal — the keyboard would look permanently shut, and the
            // rules that fold away the header and title to make room never fire.
            let baseline = vv.height
            const adjust = () => {
                const focused = document.activeElement
                if (!focused || (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA')) {
                    baseline = Math.max(baseline, vv.height)
                }
                const keyboardOpen = baseline - vv.height > 120
                editorZone.classList.toggle('keyboard-open', keyboardOpen)
                // The keyboard state can hide surrounding chrome; measure only
                // after that layout change so the canvas receives every free px.
                // getBoundingClientRect is in layout-viewport coordinates, so
                // subtract however far iOS has scrolled the visual viewport
                // inside it — otherwise the zone is sized that much too short
                // and its bottom edge floats above the keyboard.
                const top = editorZone.getBoundingClientRect().top - vv.offsetTop
                editorZone.style.height = Math.max(200, vv.height - top) + 'px'
            }
            const onOrientation = () => { baseline = vv.height }
            vv.addEventListener('resize', adjust)
            vv.addEventListener('scroll', adjust)
            window.addEventListener('orientationchange', onOrientation)
            this._vvCleanup = () => {
                vv.removeEventListener('resize', adjust)
                vv.removeEventListener('scroll', adjust)
                window.removeEventListener('orientationchange', onOrientation)
                editorZone.classList.remove('keyboard-open')
            }
            adjust()
        }

        preview.addEventListener('click', (e) => {
            // Checkbox click in preview → sync to editor
            if (e.target.type === 'checkbox') {
                e.preventDefault()
                this._syncCheckboxToEditor(e.target, contentArea)
                return
            }
            if (editorZone.dataset.mode === 'preview') this._setEditorMode('edit', editorZone)
        })

        // Click in preview → jump to editor position
        preview.addEventListener('mouseup', (e) => {
            if (e.target.type === 'checkbox') return
            if (editorZone.dataset.mode === 'split') {
                this._syncPreviewClickToEditor(e, preview, contentArea)
            }
        })

        this.container.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => this._setEditorMode(btn.dataset.mode, editorZone))
        })

        const updateStats = () => {
            const val = contentArea.value
            const words = val.trim() ? val.trim().split(/\s+/).length : 0
            const lines = val.split('\n').length
            const rt = Math.max(1, Math.ceil(words / 200))
            charCount.textContent = `${val.length} chars`
            wordCountEl.textContent = `${words} words`
            lineCountEl.textContent = `${lines} lines`
            readTimeEl.textContent = `${rt} min read`
        }

        const markDirty = () => {
            this.editorDirty = true
            saveStatus.textContent = 'unsaved'
            saveStatus.className = 'save-status unsaved'
        }

        titleInput.addEventListener('input', markDirty)
        contentArea.addEventListener('input', () => {
            markDirty()
            updateStats()
            clearTimeout(this._previewTimer)
            this._previewTimer = setTimeout(() => {
                this._renderPreview(preview, contentArea.value)
                if (this._outlineOpen) this._updateOutlinePanel()
            }, 100)
            // Schedule autosave
            if (this.autosave) {
                clearTimeout(this._autosaveTimer)
                this._autosaveTimer = setTimeout(() => doSave(), this._isMobile() ? 1000 : 2000)
            }
        })

        // Obsidian-style editor key behaviors
        contentArea.addEventListener('keydown', (e) => {
            this._handleEditorKeydown(e, contentArea)
        })

        // Smart link insertion (paste URL over selection)
        contentArea.addEventListener('paste', (e) => {
            this._handleSmartPaste(e, contentArea, markDirty, preview)
        })

        const doSave = () => {
            // A save requested while one is in flight used to be dropped on the
            // floor. Remember it and run it when the current one lands, or the
            // keystrokes typed during a slow save were never written.
            if (this._saving) { this._saveAgain = true; return }
            this._saving = true
            this._saveAgain = false
            saveBtn.disabled = true
            saveBtn.querySelector('.btn-text').textContent = 'Saving...'
            saveStatus.textContent = 'saving...'
            saveStatus.className = 'save-status unsaved'

            // Show saving overlay to prevent accidental navigation
            this._showSavingOverlay()

            // Snapshot what we are actually writing. Anything typed after this
            // point is still unsaved, so the dirty flag must survive.
            const sentContent = contentArea.value
            const sentTitle = titleInput.value
            const sentFileId = file.id

            filesAPI.update(folder.id, file.id, {
                title: sentTitle,
                content: sentContent,
            })
                .then(updated => {
                    // The user may have navigated away while this was in flight.
                    // Adopting the result then pointed this.currentFile at the
                    // note they had just left.
                    const stillHere = this.view === 'editor' && this.currentFile?.id === sentFileId
                    if (!stillHere) return
                    this.currentFile = updated
                    if (contentArea.value === sentContent && titleInput.value === sentTitle) {
                        this.editorDirty = false
                        saveStatus.textContent = 'saved'
                        saveStatus.className = 'save-status saved'
                        setTimeout(() => { if (!this.editorDirty) saveStatus.textContent = '' }, 2000)
                    }
                })
                .catch(err => this._toast(`Save error: ${err.message}`))
                .finally(() => {
                    this._saving = false
                    saveBtn.disabled = false
                    saveBtn.querySelector('.btn-text').textContent = 'Save'
                    this._hideSavingOverlay()
                    if (this._saveAgain && this.view === 'editor' && this.currentFile?.id === sentFileId) {
                        this._saveAgain = false
                        doSave()
                    }
                })
        }

        saveBtn.addEventListener('click', doSave)

        const handleSaveKey = (e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave() }
        }
        contentArea.addEventListener('keydown', handleSaveKey)
        titleInput.addEventListener('keydown', handleSaveKey)

        // ── Format toolbar bindings ──────────────────────────
        this._bindFormatToolbar(contentArea, markDirty, preview)

        // ── Find & Replace (Cmd/Ctrl+F) ─────────────────────
        this._bindFindReplace(contentArea, markDirty, preview)

        // ── Keyboard shortcuts for formatting (Cmd/Ctrl+B, I, etc.) ──
        contentArea.addEventListener('keydown', (e) => {
            this._handleFormatShortcuts(e, contentArea, markDirty, preview)
        })

        // Link insertion button (shown on text selection)
        this._setupLinkToolbar(contentArea, markDirty, preview)

        // Wikilink autocomplete (triggers on [[)
        this._setupWikilinkAutocomplete(contentArea, markDirty, preview)
    }

    // ── Format toolbar ──────────────────────────────────────────
    _bindFormatToolbar(textarea, markDirty, preview) {
        // Exclude the "more" toggle — it has no data-fmt and owns its own handler.
        this.container.querySelectorAll('.fmt-btn[data-fmt]').forEach(btn => {
            // Compact toolbar glyphs such as "B" and "[[]]" need a useful
            // spoken name; the tooltip already carries the full action name.
            if (!btn.hasAttribute('aria-label')) {
                btn.setAttribute('aria-label', btn.title.replace(/\s*\([^)]*\)\s*$/, ''))
            }
            btn.addEventListener('pointerdown', (e) => {
                // Preserve the textarea selection on touch as well as mouse.
                // iOS otherwise collapses the selection when the toolbar gains
                // focus, so formatting lands at the wrong caret position.
                e.preventDefault()
            })
            btn.addEventListener('click', () => {
                const fmt = btn.dataset.fmt
                this._applyFormat(fmt, textarea)
                markDirty()
                this._renderPreview(preview, textarea.value)
            })
        })
    }

    _applyFormat(fmt, textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const val = textarea.value
        const selected = val.slice(start, end)
        let replacement = ''
        let cursorOffset = 0
        let placeholderRange = null

        switch (fmt) {
            case 'bold':
                replacement = `**${selected || 'bold text'}**`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [2, 11]
                break
            case 'italic':
                replacement = `*${selected || 'italic text'}*`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [1, 12]
                break
            case 'strikethrough':
                replacement = `~~${selected || 'strikethrough'}~~`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [2, 15]
                break
            case 'h1':
                this._prependLine(textarea, '# ')
                textarea.focus()
                return
            case 'h2':
                this._prependLine(textarea, '## ')
                textarea.focus()
                return
            case 'h3':
                this._prependLine(textarea, '### ')
                textarea.focus()
                return
            case 'code':
                replacement = `\`${selected || 'code'}\``
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [1, 5]
                break
            case 'codeblock':
                replacement = `\n\`\`\`\n${selected || 'code here'}\n\`\`\`\n`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [5, 14]
                break
            case 'quote':
                this._prependLine(textarea, '> ')
                textarea.focus()
                return
            case 'ul':
                this._toggleList(textarea, 'ul')
                textarea.focus()
                return
            case 'ol':
                this._toggleList(textarea, 'ol')
                textarea.focus()
                return
            case 'task':
                this._toggleList(textarea, 'task')
                textarea.focus()
                return
            case 'link':
                replacement = `[${selected || 'link text'}](url)`
                cursorOffset = replacement.length
                placeholderRange = selected
                    ? [replacement.length - 4, replacement.length - 1]
                    : [1, 10]
                break
            case 'image':
                replacement = `![${selected || 'alt text'}](url)`
                cursorOffset = replacement.length
                placeholderRange = selected
                    ? [replacement.length - 4, replacement.length - 1]
                    : [2, 10]
                break
            case 'hr':
                replacement = '\n---\n'
                cursorOffset = replacement.length
                break
            case 'table':
                replacement = '\n| Header 1 | Header 2 | Header 3 |\n| --- | --- | --- |\n| Cell 1 | Cell 2 | Cell 3 |\n'
                cursorOffset = replacement.length
                break
            case 'wikilink':
                replacement = `[[${selected || 'note name'}]]`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [2, 11]
                break
            case 'tag':
                replacement = `#${selected || 'tag'}`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [1, 4]
                break
            case 'callout':
                this._prependLine(textarea, '> [!note] ')
                textarea.focus()
                return
            case 'highlight':
                replacement = `==${selected || 'highlighted text'}==`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [2, 18]
                break
            case 'footnote':
                replacement = `[^${selected || '1'}]`
                cursorOffset = replacement.length
                if (!selected) placeholderRange = [2, 3]
                break
            default:
                return
        }

        const selStart = placeholderRange ? start + placeholderRange[0] : start + cursorOffset
        const selEnd = placeholderRange ? start + placeholderRange[1] : selStart
        this._applyEdit(textarea, start, end, replacement, selStart, selEnd)
        textarea.focus()
    }

    // Toggle a line prefix (heading, quote, callout) on the caret's line.
    // Applied through _applyEdit so the change stays on the native undo stack.
    _prependLine(textarea, prefix) {
        const val = textarea.value
        const cursorPos = textarea.selectionStart
        const { lineStart, lineEnd: endIdx } = this._lineBounds(val, cursorPos)
        const currentLine = val.slice(lineStart, endIdx)

        // Preserve any leading indentation; operate on the content after it.
        const { indent, rest: body } = this._splitIndent(currentLine)

        // If line already has the prefix (after indent), remove it (toggle off).
        if (body.startsWith(prefix)) {
            this._applyEdit(textarea, lineStart, endIdx, indent + body.slice(prefix.length),
                Math.max(lineStart, cursorPos - prefix.length))
            return
        }

        // Strip any existing heading/list/quote prefix before adding the new one.
        const stripped = body.replace(/^(#{1,6}\s+|- \[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '')
        const newLine = indent + prefix + stripped
        this._applyEdit(textarea, lineStart, endIdx, newLine, lineStart + newLine.length)
    }

    // ── Format keyboard shortcuts (Cmd/Ctrl+B, I, K) ──────────
    _handleFormatShortcuts(e, textarea, markDirty, preview) {
        if (!(e.metaKey || e.ctrlKey)) return
        const key = e.key.toLowerCase()
        if (key === 'b') {
            e.preventDefault()
            this._applyFormat('bold', textarea)
            markDirty()
            this._renderPreview(preview, textarea.value)
        } else if (key === 'i') {
            e.preventDefault()
            this._applyFormat('italic', textarea)
            markDirty()
            this._renderPreview(preview, textarea.value)
        } else if (key === 'k') {
            e.preventDefault()
            this._applyFormat('link', textarea)
            markDirty()
            this._renderPreview(preview, textarea.value)
        } else if (key === 'e') {
            e.preventDefault()
            this._applyFormat('code', textarea)
            markDirty()
            this._renderPreview(preview, textarea.value)
        } else if (key === 'l') {
            // Toggle current line(s) as a bullet list.
            e.preventDefault()
            this._toggleList(textarea, 'ul')
            markDirty()
            this._renderPreview(preview, textarea.value)
        } else if (e.key === 'Enter') {
            // Toggle task done on the current line(s).
            e.preventDefault()
            this._toggleDone(textarea)
            markDirty()
            this._renderPreview(preview, textarea.value)
        } else if (key === '/' || key === '?') {
            e.preventDefault()
            this._showShortcutsPanel()
        }
    }

    // ── Find & Replace ────────────────────────────────────────
    _bindFindReplace(textarea, markDirty, preview) {
        const bar = this.container.querySelector('#find-replace-bar')
        const findInput = this.container.querySelector('#find-input')
        const replaceInput = this.container.querySelector('#replace-input')
        const findCount = this.container.querySelector('#find-count')
        const replaceRow = this.container.querySelector('#replace-row')
        if (!bar) return

        let matches = []
        let currentMatch = -1

        const doFind = () => {
            const query = findInput.value
            if (!query) { matches = []; currentMatch = -1; findCount.textContent = '0/0'; return }
            const val = textarea.value.toLowerCase()
            const q = query.toLowerCase()
            matches = []
            let idx = val.indexOf(q)
            while (idx !== -1) {
                matches.push(idx)
                idx = val.indexOf(q, idx + 1)
            }
            if (matches.length > 0) {
                currentMatch = 0
                highlightMatch()
            } else {
                currentMatch = -1
            }
            findCount.textContent = matches.length > 0 ? `${currentMatch + 1}/${matches.length}` : '0/0'
        }

        // `focusEditor` is false while the user is typing in the find box.
        // Calling textarea.focus() on every keystroke used to yank the caret
        // back into the note, so the second character of a search term — and
        // every one after it — was typed into the note instead of the box.
        const highlightMatch = (focusEditor = false) => {
            if (currentMatch < 0 || currentMatch >= matches.length) return
            const pos = matches[currentMatch]
            const len = findInput.value.length
            textarea.setSelectionRange(pos, pos + len)
            this._scrollTextareaTo(textarea, pos)
            if (focusEditor) textarea.focus()
            findCount.textContent = `${currentMatch + 1}/${matches.length}`
        }

        // Open find bar with Cmd/Ctrl+F. Bound on the editor zone rather than
        // the textarea: with focus in the preview, the title field or on a
        // button, Cmd+F fell through to the browser's own find bar, which can't
        // see past the visible viewport of the note.
        const openFind = (e) => {
            if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.altKey) {
                e.preventDefault()
                bar.classList.remove('hidden')
                const sel = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
                if (sel && !sel.includes('\n')) findInput.value = sel
                findInput.focus()
                findInput.select()
                if (findInput.value) doFind()
            }
        }
        const editorZoneEl = this.container.querySelector('#editor-zone') || this.container
        editorZoneEl.addEventListener('keydown', openFind)

        findInput.addEventListener('input', doFind)
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                if (!matches.length) return
                if (e.shiftKey) { currentMatch = (currentMatch - 1 + matches.length) % matches.length }
                else { currentMatch = (currentMatch + 1) % matches.length }
                highlightMatch()
            }
        })

        // Escape must close the bar from anywhere inside it — the replace field
        // and the nav buttons are focusable too, and left unhandled the key
        // reached the document handler and closed the whole note instead.
        bar.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            bar.classList.add('hidden')
            textarea.focus()
        })

        this.container.querySelector('#find-prev').addEventListener('click', () => {
            if (!matches.length) return
            currentMatch = (currentMatch - 1 + matches.length) % matches.length
            highlightMatch()
        })
        this.container.querySelector('#find-next').addEventListener('click', () => {
            if (!matches.length) return
            currentMatch = (currentMatch + 1) % matches.length
            highlightMatch()
        })
        this.container.querySelector('#find-toggle-replace').addEventListener('click', () => {
            replaceRow.classList.toggle('hidden')
            if (!replaceRow.classList.contains('hidden')) replaceInput.focus()
        })
        this.container.querySelector('#find-close').addEventListener('click', () => {
            bar.classList.add('hidden')
            textarea.focus()
        })

        this.container.querySelector('#replace-one').addEventListener('click', () => {
            if (currentMatch < 0 || !matches.length) return
            const pos = matches[currentMatch]
            const query = findInput.value
            if (!query) return
            // The note may have changed since the last search. Replacing a stale
            // offset would overwrite whatever now sits there, so re-check first.
            if (textarea.value.substr(pos, query.length).toLowerCase() !== query.toLowerCase()) {
                doFind()
                return
            }
            const wasAt = currentMatch
            this._applyEdit(textarea, pos, pos + query.length, replaceInput.value,
                pos + replaceInput.value.length)
            markDirty()
            this._renderPreview(preview, textarea.value)
            doFind()
            // doFind restarts at the first match; stay where the user was, on
            // the hit that has taken the replaced one's place.
            if (matches.length) {
                currentMatch = Math.min(wasAt, matches.length - 1)
                highlightMatch()
            }
        })
        this.container.querySelector('#replace-all').addEventListener('click', () => {
            if (!findInput.value) return
            const query = findInput.value
            const rep = replaceInput.value
            // Case-insensitive replace all
            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
            // Replace via a function: as a pattern string, "$&" / "$1" / "$`" in
            // the user's replacement text would be expanded instead of inserted.
            const next = textarea.value.replace(regex, () => rep)
            if (next === textarea.value) return
            const caret = Math.min(textarea.selectionStart, next.length)
            this._applyEdit(textarea, 0, textarea.value.length, next, caret)
            markDirty()
            this._renderPreview(preview, textarea.value)
            doFind()
        })
    }

    // ── Focus / Zen mode ──────────────────────────────────────
    _toggleFocusMode(editorZone) {
        const shell = this.container.querySelector('.app-shell')
        if (!shell) return
        shell.classList.toggle('focus-mode')
        const isActive = shell.classList.contains('focus-mode')
        const btn = this.container.querySelector('#focus-btn')
        if (btn) btn.querySelector('.btn-text').textContent = isActive ? 'Exit Focus' : 'Focus'
    }

    // ── Keyboard Shortcuts Panel ──────────────────────────────
    _showShortcutsPanel() {
        const isMac = navigator.platform.includes('Mac')
        const mod = isMac ? 'Cmd' : 'Ctrl'
        const shortcuts = [
            { keys: `${mod}+S`, desc: 'Save' },
            { keys: `${mod}+P`, desc: 'Command palette' },
            { keys: `${mod}+O`, desc: 'Quick switcher' },
            { keys: `${mod}+G`, desc: 'Graph view' },
            { keys: `${mod}+B`, desc: 'Bold' },
            { keys: `${mod}+I`, desc: 'Italic' },
            { keys: `${mod}+K`, desc: 'Insert link' },
            { keys: `${mod}+E`, desc: 'Inline code' },
            { keys: `${mod}+F`, desc: 'Find & replace' },
            { keys: `${mod}+/`, desc: 'This help panel' },
            { keys: 'Tab', desc: 'Indent list item' },
            { keys: 'Shift+Tab', desc: 'Outdent list item' },
            { keys: 'Enter', desc: 'Continue list / blockquote' },
            { keys: 'Esc', desc: 'Go back' },
            { keys: `Select + \``, desc: 'Wrap in backticks' },
            { keys: `Select + *`, desc: 'Wrap in asterisks' },
            { keys: '[[note]]', desc: 'Internal link (wikilink)' },
            { keys: '![[note]]', desc: 'Embed another note' },
            { keys: '#tag', desc: 'Add a tag (clickable)' },
            { keys: '> [!note]', desc: 'Callout block' },
            { keys: '==text==', desc: 'Highlight text' },
            { keys: 'Paste URL on selection', desc: 'Create markdown link' },
        ]

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay'
        overlay.innerHTML = `
            <div class="modal-box shortcuts-panel">
                <div class="modal-title">KEYBOARD SHORTCUTS</div>
                <div class="shortcuts-list">
                    ${shortcuts.map(s => `
                        <div class="shortcut-row">
                            <kbd class="shortcut-key">${s.keys}</kbd>
                            <span class="shortcut-desc">${s.desc}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="modal-actions">
                    <button class="modal-btn modal-confirm">CLOSE</button>
                </div>
            </div>
        `
        document.body.appendChild(overlay)
        const close = () => { release(); overlay.remove() }
        const release = this._trapModal(overlay, () => close())
        overlay.querySelector('.modal-confirm').addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } })
        overlay.setAttribute('tabindex', '-1')
        overlay.focus()
    }

    // ── Settings Panel ────────────────────────────────────────
    _showSettingsPanel() {
        const currentTheme = localStorage.getItem(THEME_KEY) || 'system'
        const themeOpts = THEMES.map(t =>
            `<option value="${t.id}" ${t.id === currentTheme ? 'selected' : ''}>${t.label}</option>`
        ).join('')

        const editorModeOpts = [
            { id: 'edit',    label: 'Edit only' },
            { id: 'split',   label: 'Split (edit + preview)' },
            { id: 'preview', label: 'Preview only' },
        ].map(o =>
            `<option value="${o.id}" ${o.id === this.editorMode ? 'selected' : ''}>${o.label}</option>`
        ).join('')

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay'
        overlay.innerHTML = `
            <div class="modal-box settings-panel">
                <div class="modal-title">SETTINGS</div>
                <div class="settings-list">
                    <div class="settings-row">
                        <label class="settings-label" for="settings-theme">Theme</label>
                        <select class="settings-select" id="settings-theme">${themeOpts}</select>
                    </div>
                    <div class="settings-row">
                        <label class="settings-label" for="settings-editor-mode">Editor mode</label>
                        <select class="settings-select" id="settings-editor-mode">${editorModeOpts}</select>
                    </div>
                    <div class="settings-row">
                        <label class="settings-label" for="settings-autosave">Autosave</label>
                        <label class="settings-toggle">
                            <input type="checkbox" id="settings-autosave" ${this.autosave ? 'checked' : ''} />
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="settings-divider"></div>
                    <div class="settings-row">
                        <label class="settings-label" for="settings-autologout">Auto-logout on inactivity</label>
                        <label class="settings-toggle">
                            <input type="checkbox" id="settings-autologout" ${this.autologout ? 'checked' : ''} />
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="settings-row settings-subrow" id="settings-autologout-interval-row" style="${this.autologout ? '' : 'display:none;'}">
                        <label class="settings-label" for="settings-autologout-minutes">Inactivity interval (minutes)</label>
                        <input type="number" min="1" max="1440" step="1" class="settings-input" id="settings-autologout-minutes" value="${this.autologoutMinutes}" />
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="modal-btn modal-confirm">CLOSE</button>
                </div>
            </div>
        `
        document.body.appendChild(overlay)

        const themeSel = overlay.querySelector('#settings-theme')
        const editorSel = overlay.querySelector('#settings-editor-mode')
        const autosaveChk = overlay.querySelector('#settings-autosave')
        const autologoutChk = overlay.querySelector('#settings-autologout')
        const intervalRow = overlay.querySelector('#settings-autologout-interval-row')
        const intervalInput = overlay.querySelector('#settings-autologout-minutes')

        themeSel.addEventListener('change', () => {
            this._applyTheme(themeSel.value)
            this._syncThemePicker(themeSel.value)
        })

        editorSel.addEventListener('change', () => {
            const mode = editorSel.value
            const editorZone = this.container.querySelector('#editor-zone')
            this._setEditorMode(mode, editorZone)
        })

        autosaveChk.addEventListener('change', () => {
            this.autosave = autosaveChk.checked
            localStorage.setItem(AUTOSAVE_KEY, this.autosave)
            this._toast(`Autosave ${this.autosave ? 'on' : 'off'}`)
        })

        autologoutChk.addEventListener('change', () => {
            this.autologout = autologoutChk.checked
            localStorage.setItem(AUTOLOGOUT_KEY, this.autologout)
            intervalRow.style.display = this.autologout ? '' : 'none'
            this._applyAutologout()
            this._toast(`Auto-logout ${this.autologout ? `on (${this.autologoutMinutes} min)` : 'off'}`)
        })

        intervalInput.addEventListener('change', () => {
            const mins = parseInt(intervalInput.value, 10)
            if (!Number.isFinite(mins) || mins < 1) {
                intervalInput.value = this.autologoutMinutes
                return
            }
            this.autologoutMinutes = Math.min(mins, 1440)
            intervalInput.value = this.autologoutMinutes
            localStorage.setItem(AUTOLOGOUT_MIN_KEY, this.autologoutMinutes)
            if (this.autologout) this._applyAutologout()
        })

        const close = () => { release(); overlay.remove() }
        const release = this._trapModal(overlay, () => close())
        overlay.querySelector('.modal-confirm').addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } })
        overlay.setAttribute('tabindex', '-1')
        overlay.focus()
    }

    // ── Heading Jump Navigation ───────────────────────────────
    _showHeadingJump(textarea) {
        const lines = textarea.value.split('\n')
        const headings = []
        lines.forEach((line, i) => {
            const match = line.match(/^(#{1,6})\s+(.+)/)
            if (match) {
                headings.push({ level: match[1].length, text: match[2], lineIndex: i })
            }
        })

        if (!headings.length) {
            this._toast('No headings found')
            return
        }

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay'
        overlay.innerHTML = `
            <div class="modal-box heading-jump-panel">
                <div class="modal-title">JUMP TO HEADING</div>
                <div class="heading-list">
                    ${headings.map((h, idx) => `
                        <button class="heading-item" data-idx="${idx}"
                                style="padding-left: ${(h.level - 1) * 16 + 8}px">
                            <span class="heading-level">H${h.level}</span>
                            <span class="heading-text">${this._esc(h.text)}</span>
                        </button>
                    `).join('')}
                </div>
                <div class="modal-actions">
                    <button class="modal-btn modal-cancel">CLOSE</button>
                </div>
            </div>
        `
        document.body.appendChild(overlay)

        const close = () => overlay.remove()
        overlay.querySelector('.modal-cancel').addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } })

        overlay.querySelectorAll('.heading-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const h = headings[parseInt(btn.dataset.idx)]
                let pos = 0
                for (let i = 0; i < h.lineIndex; i++) pos += lines[i].length + 1
                textarea.focus()
                textarea.setSelectionRange(pos, pos)
                this._scrollTextareaTo(textarea, pos)
                close()
            })
        })

        overlay.setAttribute('tabindex', '-1')
        overlay.focus()
    }

    // ── Indentation primitives (canonical unit = literal tab) ──────
    // One indent level = one '\t'. TABSTOP = visual columns a tab spans.
    // These make every list/indent op deterministic on mixed tab/2-space/4-space files.

    _lineBounds(val, pos) {
        const lineStart = val.lastIndexOf('\n', pos - 1) + 1
        const nl = val.indexOf('\n', pos)
        const lineEnd = nl === -1 ? val.length : nl
        return { lineStart, lineEnd }
    }

    // Scroll a textarea so the character at `pos` sits mid-viewport.
    // Measured with a mirror element rather than counting "\n" times a line
    // height: in a soft-wrapped note one logical line can occupy many visual
    // rows, so the arithmetic version landed further off the more the note
    // wrapped — which is why jumping to a search hit showed the wrong place.
    _scrollTextareaTo(textarea, pos) {
        let mirror = this._scrollMirror
        if (!mirror) {
            mirror = document.createElement('div')
            mirror.setAttribute('aria-hidden', 'true')
            mirror.style.cssText =
                'position:absolute;visibility:hidden;pointer-events:none;' +
                'left:-9999px;top:0;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;'
            document.body.appendChild(mirror)
            this._scrollMirror = mirror
        }
        const cs = getComputedStyle(textarea)
        for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
            'lineHeight', 'textTransform', 'textIndent', 'paddingTop', 'paddingRight',
            'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
            'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'tabSize', 'wordSpacing']) {
            mirror.style[prop] = cs[prop]
        }
        mirror.style.width = cs.width
        // A trailing newline collapses without something after it to hold the box open.
        mirror.textContent = textarea.value.slice(0, pos) || ''
        const marker = document.createElement('span')
        marker.textContent = '\u200b'
        mirror.appendChild(marker)
        const offset = marker.offsetTop
        const target = offset - textarea.clientHeight / 2
        textarea.scrollTop = Math.max(0, Math.min(target, textarea.scrollHeight - textarea.clientHeight))
    }

    // ── The one way this file is allowed to edit the textarea ──────
    // Assigning `textarea.value` directly wipes the browser's native undo
    // stack, so after any list operation Cmd+Z could no longer step back —
    // it jumped past every edit at once and could blank the whole note.
    // Routing edits through execCommand('insertText') keeps them on the undo
    // stack, keeps the caret and scroll stable, and fires `input` natively.
    // Returns true when the undoable path was used.
    _applyEdit(textarea, from, to, text, selStart = null, selEnd = null) {
        const before = textarea.value
        const expected = before.slice(0, from) + text + before.slice(to)
        const scrollTop = textarea.scrollTop
        if (document.activeElement !== textarea) textarea.focus({ preventScroll: true })
        textarea.setSelectionRange(from, to)

        let undoable = false
        try {
            undoable = (text === '' && to > from)
                ? document.execCommand('delete')
                : document.execCommand('insertText', false, text)
        } catch { undoable = false }

        // Trust the result, not the return value: execCommand can report success
        // and leave the field untouched. If the text isn't what we asked for,
        // fall back to a direct write — a lost undo step beats a lost edit.
        if (textarea.value !== expected) {
            undoable = false
            textarea.value = expected
            textarea.scrollTop = scrollTop
        }

        const s = Math.max(0, Math.min(selStart == null ? from + text.length : selStart, expected.length))
        const e = Math.max(s, Math.min(selEnd == null ? s : selEnd, expected.length))
        textarea.setSelectionRange(s, e)
        // On the undoable path the browser has already kept the caret in view;
        // forcing the old scrollTop back would hide it while typing at the
        // bottom edge of the pane.
        // execCommand already emitted `input`; only synthesise one for the fallback.
        if (!undoable) textarea.dispatchEvent(new Event('input', { bubbles: true }))
        return undoable
    }

    // Replace whole lines [fromLine, toLine] of `textarea` with `newLines`,
    // as one undoable edit. Returns the char offset the replaced block starts at.
    _replaceLines(textarea, lines, fromLine, toLine, newLines, selStart, selEnd) {
        let from = 0
        for (let i = 0; i < fromLine; i++) from += lines[i].length + 1
        let to = from
        for (let i = fromLine; i <= toLine; i++) to += lines[i].length + (i < toLine ? 1 : 0)
        this._applyEdit(textarea, from, to, newLines.join('\n'), selStart, selEnd)
        return from
    }

    // Rewrite the textarea into `next` with the smallest edit that does it, so
    // the undo entry covers only the text that actually moved.
    _applyDiff(textarea, next, caret) {
        const val = textarea.value
        if (val === next) {
            textarea.setSelectionRange(caret, caret)
            return
        }
        let p = 0
        const max = Math.min(val.length, next.length)
        while (p < max && val[p] === next[p]) p++
        let q = 0
        while (q < max - p && val[val.length - 1 - q] === next[next.length - 1 - q]) q++
        this._applyEdit(textarea, p, val.length - q, next.slice(p, next.length - q), caret, caret)
    }

    // Where a caret sitting in `before` lands in `after`, given the two differ
    // only in the markers at the head of some lines — which is all renumbering
    // ever changes.
    _shiftCaret(before, after, caret) {
        const b = before.split('\n')
        const a = after.split('\n')
        if (a.length !== b.length) return Math.min(caret, after.length)
        let i = 0, acc = 0
        while (i < b.length - 1 && acc + b[i].length < caret) { acc += b[i].length + 1; i++ }
        const col = caret - acc
        let base = 0
        for (let k = 0; k < i; k++) base += a[k].length + 1
        const shifted = col === 0 ? 0 : col + (a[i].length - b[i].length)
        return base + Math.max(0, Math.min(shifted, a[i].length))
    }

    // Apply a structural list edit together with the renumbering it forces, as a
    // SINGLE undoable step. `ops` are renumber requests ({ at, following }) run
    // against the text as it will be after the edit. Emitting the renumber
    // separately put a second entry on the browser's undo stack, so one Cmd+Z
    // rolled back only the numbers and left the list holding a duplicate marker.
    _applyListEdit(textarea, from, to, text, caret, ops = null) {
        const val = textarea.value
        let next = val.slice(0, from) + text + val.slice(to)
        let pos = caret
        for (const op of ops || []) {
            if (!op) continue
            const renumbered = this._renumberedText(next, op.at, !!op.following)
            if (renumbered === null) continue
            pos = this._shiftCaret(next, renumbered, pos)
            next = renumbered
        }
        this._applyDiff(textarea, next, pos)
    }

    // Parse a list item line into its parts, or null when it isn't one.
    // Accepts "- ", "* ", "+ ", "1. ", "1) " with an optional "[ ] " task box.
    _parseListLine(line) {
        const m = line.match(/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/)
        if (!m) return null
        // A thematic break is not a list item. CommonMark allows spaces between
        // the characters, so "* * *" and "- - -" count as well — without this
        // they parsed as a bullet whose text is another bullet.
        const bare = line.trim()
        if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(bare)) return null
        return {
            indent: m[1],
            bullet: m[2],
            gap: m[3],
            task: m[4] || '',
            prefix: m[0],
            prefixLen: m[0].length,
            content: line.slice(m[0].length),
            ordered: /^\d/.test(m[2]),
        }
    }

    _splitIndent(line) {
        const m = line.match(/^[ \t]*/)
        return { indent: m[0], rest: line.slice(m[0].length) }
    }

    // Visual column width of an indent string (tab advances to next 4-col stop).
    _indentWidth(indent) {
        const TABSTOP = 4
        let col = 0
        for (const ch of indent) {
            if (ch === '\t') col += TABSTOP - (col % TABSTOP)
            else col += 1
        }
        return col
    }

    // Indent depth in levels — used only by subtree detection and renumber grouping.
    _indentLevels(indent) {
        return Math.round(this._indentWidth(indent) / 4)
    }

    // Remove one indent level from an indent string, handling tab / 4-space / legacy 2-space.
    _removeOneLevel(indent) {
        if (indent.startsWith('\t')) return indent.slice(1)
        const n = (indent.match(/^ */) || [''])[0].length
        if (n === 0) return indent
        const remove = (n % 4 === 2) ? 2 : Math.min(4, n)
        return indent.slice(remove)
    }

    _addOneLevel(indent) {
        return '\t' + indent
    }

    // Take `cols` visual columns off the head of an indent string, leaving the
    // rest of it as it was. Outdenting a subtree has to move every line by the
    // same amount: deriving the step per line collapses a list indented in
    // 2-space steps, where a grandchild's 4 spaces read as one 4-column step.
    _removeIndentCols(indent, cols) {
        if (cols <= 0) return indent
        let col = 0, i = 0
        for (; i < indent.length && col < cols; i++) {
            col += indent[i] === '\t' ? 4 - (col % 4) : 1
        }
        // A tab straddling the cut leaves its remainder behind as spaces.
        return ' '.repeat(Math.max(0, col - cols)) + indent.slice(i)
    }

    // Mark each line that is inside a fenced code block (``` or ~~~), so indent
    // normalization / multi-line indent never touches code.
    _fenceMask(lines) {
        const mask = new Array(lines.length).fill(false)
        let fence = null // {char, len}
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^([ \t]*)(`{3,}|~{3,})(.*)$/)
            if (!fence && m && !(m[2][0] === '`' && m[3].includes('`'))) {
                fence = { char: m[2][0], len: m[2].length }
                mask[i] = true
            } else if (fence && m && m[2][0] === fence.char && m[2].length >= fence.len &&
                       lines[i].slice(m[1].length + m[2].length).trim() === '') {
                mask[i] = true
                fence = null
            } else if (fence) {
                mask[i] = true
            }
        }
        return mask
    }

    // True when the line starting at `lineStart` sits inside a fenced code block.
    // The Enter/Backspace/Tab handling has to ask: inside a fence, "1. step" and
    // "> x" are code the user typed, not structure to continue or resequence.
    _caretInFence(val, lineStart) {
        const lines = val.split('\n')
        const mask = this._fenceMask(lines)
        return !!mask[val.slice(0, lineStart).split('\n').length - 1]
    }

    // Measure leading indentation in visual columns; returns where content starts.
    _measureCols(line, tabSize = 4) {
        let col = 0, idx = 0
        for (; idx < line.length; idx++) {
            const ch = line[idx]
            if (ch === '\t') col += tabSize - (col % tabSize)
            else if (ch === ' ') col += 1
            else break
        }
        return { cols: col, idx, rest: line.slice(idx) }
    }

    // True when the list item at `lineStart` may legally be nested one level
    // deeper — i.e. it has a preceding sibling at its own level (or shallower)
    // in the same list to become a child of. Markdown has no way to express a
    // first item that is already indented, so allowing it produced a list the
    // renderer flattened, which is why nested bullets looked disconnected.
    _canIndentListLine(val, lineStart) {
        const { lineEnd } = this._lineBounds(val, lineStart)
        const level = this._indentLevels(this._splitIndent(val.slice(lineStart, lineEnd)).indent)
        let p = lineStart
        let blanks = 0
        while (p > 0) {
            const prevEnd = p - 1
            const prevStart = val.lastIndexOf('\n', prevEnd - 1) + 1
            const line = val.slice(prevStart, prevEnd)
            p = prevStart
            // A blank line makes a list "loose", it does not end it. Treating it
            // as a terminator meant Tab silently did nothing on every list with
            // spacing between its items.
            if (line.trim() === '') {
                if (++blanks > 2) return false
                continue
            }
            const lvl = this._indentLevels(this._splitIndent(line).indent)
            if (lvl > level) { blanks = 0; continue }     // a deeper cousin — keep looking
            if (!this._parseListLine(line)) return false  // prose above, not a list
            return lvl === level                          // sibling → may become its child
        }
        return false                                       // first line of the note
    }

    // Range of a list item's whole subtree (itself + deeper descendants + interleaved blanks).
    _subtreeRange(val, lineStart) {
        const { lineEnd } = this._lineBounds(val, lineStart)
        // Compare raw indent columns rather than rounded levels: a 2-space list
        // (what most Markdown tools emit) nests its child at column 4, which
        // rounds to the same level as its parent at column 2 — the subtree then
        // ended at the parent and Tab moved an item away from its own children.
        const baseCol = this._indentWidth(this._splitIndent(val.slice(lineStart, lineEnd)).indent)
        let endLine = lineEnd
        let p = lineEnd
        while (p < val.length) {
            const ns = p + 1
            if (ns > val.length) break
            const nlPos = val.indexOf('\n', ns)
            const ne = nlPos === -1 ? val.length : nlPos
            const ln = val.slice(ns, ne)
            if (ln.trim() === '') { endLine = ne; p = ne; continue }
            const col = this._indentWidth(this._splitIndent(ln).indent)
            if (col <= baseCol) break
            endLine = ne; p = ne
        }
        return { start: lineStart, end: endLine }
    }

    // Renumber the contiguous ordered-list run containing the line at `offset`
    // (or, with `following`, the first run at or after it), keeping numbers
    // sequential. Children (deeper lines) are transparent; blanks, shallower
    // lines, same-level non-ordered items and fenced code end the run.
    //
    // Pure — it takes and returns text, and answers null when the numbers are
    // already right. Keeping the arithmetic away from the textarea is what lets
    // a structural edit and the renumbering it forces be applied as one step.
    _renumberedText(val, offset, following = false) {
        const lines = val.split('\n')
        const mask = this._fenceMask(lines)
        // Map char offset -> line index. An offset past the end means there is
        // no run to resequence; falling through with idx still 0 rewrote the
        // numbering at the TOP of the note, which the user never touched.
        if (offset > val.length) return null
        let idx = -1, acc = 0
        for (let i = 0; i < lines.length; i++) {
            if (acc === offset) { idx = i; break }
            acc += lines[i].length + 1
            if (acc > offset) { idx = i; break }
        }
        if (idx === -1) return null
        const ordRe = /^([ \t]*)(\d+)([.)])(\s+)/
        if (following) {
            // An item that was just deleted or demoted leaves blank lines behind;
            // step over them to the run that now starts there.
            while (idx < lines.length && !mask[idx] && lines[idx].trim() === '') idx++
        }
        if (idx >= lines.length || mask[idx]) return null
        const editM = lines[idx].match(ordRe)
        if (!editM) return null
        const runCol = this._indentWidth(editM[1])

        // Walk up to the run start. A run is bounded by a blank line, a shallower
        // level, or a same-level non-ordered item; deeper children are transparent.
        let s = idx
        let hasOrderedAbove = false
        for (let i = idx - 1; i >= 0; i--) {
            const ln = lines[i]
            if (mask[i] || ln.trim() === '') break
            const col = this._indentWidth(this._splitIndent(ln).indent)
            if (col > runCol) continue // deeper child, skip
            if (col < runCol) break
            if (!ordRe.test(ln)) break
            s = i
            hasOrderedAbove = true
        }
        // Walk down to the run end
        let eLine = idx
        for (let i = idx + 1; i < lines.length; i++) {
            const ln = lines[i]
            if (mask[i] || ln.trim() === '') break
            const col = this._indentWidth(this._splitIndent(ln).indent)
            if (col > runCol) continue // deeper child, skip
            if (col < runCol) break
            if (!ordRe.test(ln)) break
            eLine = i
        }

        const startM = lines[s].match(ordRe)
        // A run with no ordered sibling above it is a fresh (possibly nested) list →
        // restart at 1, matching Obsidian. Otherwise keep the existing start number.
        // Keep whatever number the run actually starts with. Restarting at 1
        // rewrote a deliberately-numbered list ("1999. a year", a list resumed
        // at 5.) the moment anything in it was edited.
        let num = parseInt(startM[2], 10)
        if (!Number.isFinite(num)) num = 1
        let changed = false
        for (let i = s; i <= eLine; i++) {
            const mm = lines[i].match(ordRe)
            if (!mm) continue                                        // a deeper child line
            if (this._indentWidth(mm[1]) !== runCol) continue
            const newLine = mm[1] + num + mm[3] + mm[4] + lines[i].slice(mm[0].length)
            if (newLine !== lines[i]) { lines[i] = newLine; changed = true }
            num++
        }
        // Already sequential — don't burn an undo step rewriting identical text.
        if (!changed) return null
        return lines.join('\n')
    }

    // Renumber the run containing `anyLineStart` as an edit of its own.
    _renumberRun(textarea, anyLineStart) {
        const next = this._renumberedText(textarea.value, anyLineStart)
        if (next === null) return
        this._applyDiff(textarea, next, this._shiftCaret(textarea.value, next, textarea.selectionStart))
    }

    // After an ordered item is deleted or demoted at `fromOffset`, resequence the
    // run that now starts there so the numbers don't skip.
    _renumberFollowingRun(textarea, fromOffset) {
        const next = this._renumberedText(textarea.value, fromOffset, true)
        if (next === null) return
        this._applyDiff(textarea, next, this._shiftCaret(textarea.value, next, textarea.selectionStart))
    }

    // ── In-memory render normalization (NEVER mutates the file) ─────
    // Converts mixed tab/2-space/4-space list indentation into canonical
    // space-based indentation sized to each parent's content column, so
    // `marked` nests reliably. Code fences and YAML frontmatter pass verbatim.
    _normaliseIndentForRender(md) {
        if (!md) return md
        const EOL = md.includes('\r\n') ? '\r\n' : '\n'
        const lines = md.split(/\r\n|\r|\n/)
        const mask = this._fenceMask(lines)
        const out = []
        const stack = [] // {srcCol, contentCol}
        let inFrontmatter = false
        const TAB = 4, tol = 1

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i]
            if (i === 0 && raw.trim() === '---') { inFrontmatter = true; out.push(raw); continue }
            if (inFrontmatter) {
                out.push(raw)
                if (raw.trim() === '---' || raw.trim() === '...') inFrontmatter = false
                continue
            }
            if (mask[i]) { out.push(raw); continue }

            const { cols, rest } = this._measureCols(raw, TAB)
            // Two trailing spaces are Markdown's hard line break. Trimming them
            // here, before marked ever saw them, silently joined the lines the
            // user had deliberately broken.
            const hardBreak = /  +$/.test(rest) && rest.trim() !== ''
            const keep = t => t.replace(/[ \t]+$/, '') + (hardBreak ? '  ' : '')
            const restR = keep(rest)
            if (rest.trim() === '') { out.push(''); continue }

            // Four columns of indent outside any list is an indented code
            // block. Re-indenting its lines because one happens to start with
            // "- " turned the code into a bullet list.
            if (!stack.length && cols >= 4) { out.push(raw); continue }

            const isThematic = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest.trim())
            const lm = isThematic ? null : rest.match(/^([-*+]|\d{1,9}[.)])(\s+)/)

            if (lm) {
                // "- [ ]" with nothing after it isn't a task list item to the
                // renderer — it falls back to literal "[ ]" text. A zero-width
                // space gives it the content it needs so a freshly-made task
                // shows an empty checkbox. Render-time only; the file is
                // untouched.
                const emptyTask = /^([-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*$/.test(restR)
                if (emptyTask) {
                    while (stack.length && cols < stack[stack.length - 1].srcCol - tol) stack.pop()
                    const outCol = stack.length
                        ? (cols >= stack[stack.length - 1].srcCol + 1
                            ? stack[stack.length - 1].contentCol
                            : (stack.pop(), stack.length ? stack[stack.length - 1].contentCol : 0))
                        : 0
                    stack.push({ srcCol: cols, contentCol: outCol + lm[1].length + 1 })
                    out.push(' '.repeat(outCol) + restR.replace(/[ \t]*$/, '') + ' \u200b')
                    continue
                }
                const marker = lm[1]
                const markerW = marker.length
                const contentOffset = markerW + 1
                while (stack.length && cols < stack[stack.length - 1].srcCol - tol) stack.pop()
                let outCol
                if (stack.length === 0) {
                    outCol = 0
                } else if (cols >= stack[stack.length - 1].srcCol + 1) {
                    outCol = stack[stack.length - 1].contentCol
                } else {
                    stack.pop()
                    outCol = stack.length ? stack[stack.length - 1].contentCol : 0
                }
                stack.push({ srcCol: cols, contentCol: outCol + contentOffset })
                out.push(' '.repeat(outCol) + restR)
                continue
            }

            if (stack.length === 0) { out.push(keep(raw)); continue }
            let host = null
            for (let s = stack.length - 1; s >= 0; s--) {
                if (cols >= stack[s].contentCol - tol) { host = stack[s]; break }
            }
            if (host) {
                if (cols >= host.contentCol + 4) {
                    out.push(keep(raw))
                } else {
                    out.push(' '.repeat(host.contentCol) + restR)
                }
            } else {
                stack.length = 0
                out.push(keep(raw))
            }
        }
        return out.join(EOL)
    }

    // Run `fn` over the prose of `md` only. Fenced code blocks pass through
    // untouched and inline code spans are parked on placeholders, so a rule that
    // spans lines still sees the prose around them as one piece of text. The
    // passes below are plain global regexes: without this, `#include`, a CSS
    // colour, `a == b` or a Windows path inside a code block is rewritten into
    // markup, and since `marked` escapes code the reader sees that markup
    // verbatim where their code should be.
    _outsideCode(md, fn) {
        const lines = md.split('\n')
        const mask = this._fenceMask(lines)
        const out = []
        let run = []
        const flush = () => {
            if (!run.length) return
            const spans = []
            const parked = run.join('\n').replace(/`+[^`\n]*`+/g, (m) => {
                spans.push(m)
                return `\u0000${spans.length - 1}\u0000`
            })
            out.push(fn(parked).replace(/\u0000(\d+)\u0000/g, (_, i) => spans[+i]))
            run = []
        }
        for (let i = 0; i < lines.length; i++) {
            if (mask[i]) { flush(); out.push(lines[i]) }
            else run.push(lines[i])
        }
        flush()
        return out.join('\n')
    }

    // Shared markdown→HTML pipeline (indent fix FIRST, then math, then Obsidian preprocess).
    _mdToHtml(str) {
        let s = this._normaliseIndentForRender(str || '')
        s = this._outsideCode(s, t => this._preprocessMarkdown(this._normaliseMath(t)))
        if (typeof marked === 'undefined') return this._esc(s)
        return DOMPurify.sanitize(marked.parse(s), {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
        })
    }

    // ── Obsidian-style editor keydown behaviors ────────────────
    _handleEditorKeydown(e, textarea) {
        const val = textarea.value
        const start = textarea.selectionStart
        const end = textarea.selectionEnd

        // Let the wikilink autocomplete dropdown own Enter/Tab while it is open.
        // The dropdown owns Enter while it is open. It also owns Tab — but it
        // only listens for Enter, so returning here let Tab move focus out of
        // the editor entirely; preventing it keeps the caret where it is.
        if (e.key === 'Enter' && this._wikilinkOpen) return
        if (e.key === 'Tab' && this._wikilinkOpen) { e.preventDefault(); return }

        // ── Enter: continue lists / tasks / ordered / quotes ──────
        // Cmd/Ctrl+Enter is "toggle task done" — let it fall through to the shortcut handler.
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && start === end) {
            const { lineStart, lineEnd } = this._lineBounds(val, start)
            // The WHOLE line, not just what precedes the caret. Matching on the
            // text before the caret made "- |foo" look like an empty item, so
            // Enter at the start of an item deleted its bullet instead of
            // pushing the item down — the bug the user hit every time.
            const fullLine = val.slice(lineStart, lineEnd)
            const caretCol = start - lineStart
            // Inside a fenced code block "1. step" and "> x" are code the user
            // typed, not a list or a quote to continue: hand Enter back to the
            // browser rather than writing a bullet into their code and
            // resequencing the numbered lines around it.
            if (this._caretInFence(val, lineStart)) return
            const item = this._parseListLine(fullLine)

            if (item) {
                const tail = fullLine.slice(Math.max(caretCol, item.prefixLen))
                const atOrBeforeContent = caretCol <= item.prefixLen

                // Shift+Enter → a continuation line inside the same item,
                // aligned under its text so wrapped prose stays in the bullet.
                if (e.shiftKey) {
                    e.preventDefault()
                    const pad = ' '.repeat(this._indentWidth(item.indent) + item.bullet.length + item.gap.length + item.task.length)
                    // A bare newline inside an item is a Markdown *soft* break:
                    // the preview joins the two lines back into one, so the
                    // continuation the user just made was invisible there. The
                    // trailing backslash is a hard break, and unlike the
                    // two-trailing-spaces form it survives the whitespace trim
                    // in _normaliseIndentForRender.
                    this._applyEdit(textarea, start, start, '\\\n' + pad)
                    return
                }

                // Empty item (marker only, nothing either side of the caret) →
                // outdent a level, or leave the list entirely at the top level.
                if (!item.content.trim()) {
                    e.preventDefault()
                    if (this._indentLevels(item.indent) >= 1) {
                        const newIndent = this._removeOneLevel(item.indent)
                        const newLine = newIndent + item.bullet + ' ' + item.task
                        this._applyListEdit(textarea, lineStart, lineEnd, newLine,
                            lineStart + newLine.length,
                            item.ordered ? [{ at: lineStart }] : null)
                    } else {
                        this._applyListEdit(textarea, lineStart, lineEnd, '', lineStart,
                            [{ at: lineStart, following: true }])
                    }
                    return
                }

                e.preventDefault()
                const marker = item.indent + item.bullet + item.gap + (item.task ? '[ ] ' : '')

                if (atOrBeforeContent) {
                    // Caret sits at the start of the item's text: open an empty
                    // item ABOVE and let this one slide down, keeping the caret
                    // on the text the user was standing in front of.
                    // Keep the trailing space: a bare "-" is not a marker the
                    // ordered-list renumberer recognises, and the empty item
                    // should be typable the moment the user clicks into it.
                    // A new item is never pre-ticked, even above a done task.
                    const blank = item.indent + item.bullet + item.gap + (item.task ? '[ ] ' : '')
                    // A marker-only line directly below a paragraph is read by
                    // CommonMark as a setext underline — "Notes\n- " renders the
                    // paragraph as an <h2>. A blank separator keeps it a list,
                    // and a blank line before a list is canonical Markdown.
                    const prevEnd = lineStart - 1
                    const needsGap = lineStart > 0 && (() => {
                        const prevStart = val.lastIndexOf('\n', prevEnd - 1) + 1
                        const prev = val.slice(prevStart, prevEnd)
                        return prev.trim() !== '' && !this._parseListLine(prev)
                    })()
                    const insertion = (needsGap ? '\n' : '') + blank + '\n'
                    this._applyListEdit(
                        textarea, lineStart, lineStart, insertion,
                        lineStart + insertion.length + item.prefixLen,
                        item.ordered ? [{ at: lineStart + (needsGap ? 1 : 0) }] : null,
                    )
                    return
                }

                // Caret inside the text: split the item, carrying the tail down.
                this._applyListEdit(
                    textarea, start, lineEnd, '\n' + marker + tail,
                    start + 1 + marker.length,
                    item.ordered ? [{ at: lineStart }] : null,
                )
                return
            }

            // Blockquote continuation (allow leading indent before >).
            const blockquoteMatch = fullLine.match(/^([ \t]*>[ \t]?)+/)
            if (blockquoteMatch) {
                const prefix = blockquoteMatch[0]
                if (!fullLine.slice(prefix.length).trim()) {
                    e.preventDefault()
                    this._applyEdit(textarea, lineStart, lineEnd, '', lineStart)
                    return
                }
                e.preventDefault()
                if (e.shiftKey) {
                    this._applyEdit(textarea, start, start, '\n' + prefix)
                    return
                }
                const tail = fullLine.slice(Math.max(start - lineStart, prefix.length))
                this._applyEdit(textarea, start, lineEnd, '\n' + prefix + tail, start + 1 + prefix.length)
                return
            }
        }

        // ── Backspace at the start of a list item's text ──────────
        // Removes one level of nesting, then the marker itself, instead of
        // silently eating the space between the bullet and the word.
        if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey && start === end) {
            const { lineStart, lineEnd } = this._lineBounds(val, start)
            const fullLine = val.slice(lineStart, lineEnd)
            const item = this._caretInFence(val, lineStart) ? null : this._parseListLine(fullLine)
            if (item && start - lineStart === item.prefixLen) {
                e.preventDefault()
                // Move the item's descendants with it, exactly as Shift+Tab
                // does. Outdenting the one line left its sub-items behind at
                // their old depth, where the renderer re-hosted them under
                // whatever now sat above them.
                const { start: rStart, end: rEnd } = this._subtreeRange(val, lineStart)
                const blines = val.slice(rStart, rEnd).split('\n')
                const mask = this._fenceMask(blines)
                if (this._indentLevels(item.indent) >= 1) {
                    const newIndent = this._removeOneLevel(item.indent)
                    const delta = item.indent.length - newIndent.length
                    const cut = this._indentWidth(item.indent) - this._indentWidth(newIndent)
                    const moved = blines.map((ln, idx) => {
                        if (mask[idx] || ln.trim() === '') return ln
                        const { indent, rest } = this._splitIndent(ln)
                        return (idx === 0 ? newIndent : this._removeIndentCols(indent, cut)) + rest
                    })
                    this._applyListEdit(
                        textarea, rStart, rEnd, moved.join('\n'),
                        Math.max(lineStart, start - delta),
                        item.ordered ? [{ at: lineStart }] : null,
                    )
                } else {
                    // Top level → drop the marker, keep the text. The children
                    // still come up a level, so they aren't left hanging off a
                    // line that is no longer a list item at all.
                    const moved = blines.map((ln, idx) => {
                        if (idx === 0) return item.content
                        if (mask[idx] || ln.trim() === '') return ln
                        const { indent, rest } = this._splitIndent(ln)
                        return this._removeOneLevel(indent) + rest
                    })
                    this._applyListEdit(
                        textarea, rStart, rEnd, moved.join('\n'), lineStart,
                        [{ at: lineStart, following: true }],
                    )
                }
                return
            }
        }

        // ── Tab / Shift+Tab: indent / outdent ─────────────────────
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault()
            const selSpansLines = start !== end &&
                val.slice(start, end).includes('\n')
            const { lineStart, lineEnd } = this._lineBounds(val, start)
            const currentLine = val.slice(lineStart, lineEnd)
            // A "- foo" line inside a code fence is code: let it fall through to
            // the plain tab insert below instead of being re-indented as a list.
            const isListLine = /^[ \t]*([-*+]|\d+[.)]) /.test(currentLine) &&
                !this._caretInFence(val, lineStart)

            if (selSpansLines) {
                this._indentSelection(textarea, e.shiftKey)
                return
            }

            if (isListLine) {
                // Markdown only nests a list item one level below its previous
                // sibling. Indenting further produces a list `marked` refuses to
                // nest, which is what made sub-bullets "not connect" in the
                // preview — so refuse the keystroke instead of writing a
                // structure that can't render.
                if (!e.shiftKey && !this._canIndentListLine(val, lineStart)) return

                // Indent / outdent the whole subtree (item + deeper descendants).
                const { start: rStart, end: rEnd } = this._subtreeRange(val, lineStart)
                const block = val.slice(rStart, rEnd)
                const blines = block.split('\n')
                const mask = this._fenceMask(blines)
                // Outdent every line of the subtree by the same number of
                // columns the item itself loses, so the nesting keeps its shape.
                const firstIndent = this._splitIndent(blines[0]).indent
                const cut = this._indentWidth(firstIndent) - this._indentWidth(this._removeOneLevel(firstIndent))
                let deltaOnFirst = 0
                const newLines = blines.map((ln, idx) => {
                    if (mask[idx] || ln.trim() === '') return ln
                    if (e.shiftKey) {
                        const { indent, rest } = this._splitIndent(ln)
                        const newIndent = (idx > 0 && cut > 0)
                            ? this._removeIndentCols(indent, cut)
                            : this._removeOneLevel(indent)
                        if (idx === 0) deltaOnFirst = newIndent.length - indent.length
                        return newIndent + rest
                    }
                    if (idx === 0) deltaOnFirst = 1
                    return '\t' + ln
                })
                const newBlock = newLines.join('\n')
                if (newBlock === block) return
                const np = Math.max(lineStart, start + deltaOnFirst)
                // Renumber both the moved item's (new) run and the run it left behind.
                const ordered = /^[ \t]*\d{1,9}[.)][ \t]+/.test(currentLine)
                this._applyListEdit(textarea, rStart, rEnd, newBlock, np, ordered
                    ? [{ at: lineStart }, { at: rStart + newBlock.length + 1, following: true }]
                    : null)
                return
            }

            // Non-list line: insert / remove one tab at line start.
            if (e.shiftKey) {
                const { indent, rest } = this._splitIndent(currentLine)
                const newIndent = this._removeOneLevel(indent)
                const removed = indent.length - newIndent.length
                if (removed === 0) return
                this._applyEdit(textarea, lineStart, lineEnd, newIndent + rest,
                    Math.max(lineStart, start - removed))
            } else {
                this._applyEdit(textarea, lineStart, lineStart, '\t', start + 1)
            }
            return
        }

        // ── Auto-pairs and wrap-selection ─────────────────────────
        if (!e.metaKey && !e.ctrlKey && !e.altKey) {
            const OPEN = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
            const EMPH = { '*': '*', '_': '_', '~': '~', '=': '=' }
            // Wrap selection with any pair/emphasis char.
            if (start !== end && (e.key in OPEN || e.key in EMPH)) {
                e.preventDefault()
                const close = OPEN[e.key] ?? EMPH[e.key]
                const selected = val.slice(start, end)
                this._applyEdit(textarea, start, end, e.key + selected + close, start + 1, end + 1)
                return
            }
            // Type-through: if the very next character is the closer we put
            // there, step over it instead of adding a second one. Without this,
            // typing "(a note)" left "(a note))" and "[a](b)" left "[a](b))]".
            const CLOSERS = new Set([')', ']', '}', '"', "'", '`'])
            if (start === end && CLOSERS.has(e.key) && val[start] === e.key) {
                e.preventDefault()
                textarea.setSelectionRange(start + 1, start + 1)
                return
            }
            // Empty caret: auto-close brackets/quotes only (not emphasis, so ** still works).
            if (start === end && e.key in OPEN) {
                // A quote or backtick right after a word is an apostrophe or a
                // closing quote, not the start of a pair — "don't" should not
                // become "don''t". Brackets are always paired.
                const prev = val[start - 1]
                const quoteLike = e.key === '"' || e.key === "'" || e.key === '`'
                if (quoteLike && prev && /[\w)\]}"'`]/.test(prev)) return
                e.preventDefault()
                const close = OPEN[e.key]
                this._applyEdit(textarea, start, end, e.key + close, start + 1)
                return
            }
            // Backspace between an adjacent auto-pair removes both chars.
            if (e.key === 'Backspace' && start === end && start > 0) {
                const prev = val[start - 1]
                const next = val[start]
                if (OPEN[prev] && OPEN[prev] === next) {
                    e.preventDefault()
                    this._applyEdit(textarea, start - 1, start + 1, '', start - 1)
                    return
                }
            }
        }
    }

    // Indent / outdent every line touched by a multi-line selection, preserving the
    // selection range. Fenced-code lines inside the selection are left untouched.
    _indentSelection(textarea, outdent) {
        const val = textarea.value
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const firstLineStart = val.lastIndexOf('\n', start - 1) + 1
        // If the selection ends exactly at a line start, don't include that empty trailing line.
        let blockEnd = end
        if (end > start && val[end - 1] === '\n') blockEnd = end - 1
        const lastLineEnd = val.indexOf('\n', blockEnd) === -1 ? val.length : val.indexOf('\n', blockEnd)
        const block = val.slice(firstLineStart, lastLineEnd)
        const blines = block.split('\n')
        // Mask the whole document and slice out this block. Masking the block on
        // its own means a selection that STARTS inside a fence reads that
        // fence's closing ``` as an opening one and gets the protection exactly
        // backwards: it re-indents the code and skips the prose after it.
        const firstIdx = val.slice(0, firstLineStart).split('\n').length - 1
        const mask = this._fenceMask(val.split('\n')).slice(firstIdx, firstIdx + blines.length)
        let deltaFirst = 0, deltaTotal = 0
        const newLines = blines.map((ln, idx) => {
            if (mask[idx]) return ln
            if (outdent) {
                const { indent, rest } = this._splitIndent(ln)
                const newIndent = this._removeOneLevel(indent)
                const d = newIndent.length - indent.length
                if (idx === 0) deltaFirst = d
                deltaTotal += d
                return newIndent + rest
            }
            if (ln === '') return ln // don't indent truly empty lines on indent
            if (idx === 0) deltaFirst = 1
            deltaTotal += 1
            return '\t' + ln
        })
        this._applyEdit(textarea, firstLineStart, lastLineEnd, newLines.join('\n'),
            Math.max(firstLineStart, start + deltaFirst), end + deltaTotal)
    }

    // ── Toggle selected line(s) as bullet / ordered / task list ────
    _toggleList(textarea, type = 'ul') {
        const val = textarea.value
        const selStart = textarea.selectionStart
        const selEnd = textarea.selectionEnd
        const firstLineStart = val.lastIndexOf('\n', selStart - 1) + 1
        const lastLineEnd = val.indexOf('\n', selEnd === selStart ? selEnd : selEnd - 1) === -1
            ? val.length
            : val.indexOf('\n', selEnd === selStart ? selEnd : selEnd - 1)
        const block = val.slice(firstLineStart, lastLineEnd)
        const blines = block.split('\n')
        // Document-wide mask, sliced to this block — see _indentSelection.
        const firstIdx = val.slice(0, firstLineStart).split('\n').length - 1
        const mask = this._fenceMask(val.split('\n')).slice(firstIdx, firstIdx + blines.length)
        const stripRe = /^([ \t]*)(?:#{1,6} +|>[ \t]?|(?:[-*+]|\d+[.)]) (?:\[[ xX]\] )?)/
        const typeRe = type === 'ul'
            ? /^[ \t]*[-*+] (?!\[[ xX]\] )/
            : type === 'ol'
                ? /^[ \t]*\d+[.)] (?!\[[ xX]\] )/
                : /^[ \t]*[-*+] \[[ xX]\] /
        // Toggle OFF only if every non-blank/non-code line already is this exact type.
        const relevant = blines.filter((ln, i) => !mask[i] && ln.trim() !== '')
        const allAreType = relevant.length > 0 && relevant.every(ln => typeRe.test(ln))
        // One counter per indent column. A single counter running through the
        // whole selection gives a nested item its parent's next number, and
        // `marked` then starts the nested list at that number instead of at 1.
        const counters = new Map()
        const newLines = blines.map((ln, idx) => {
            if (mask[idx] || ln.trim() === '') return ln
            const { indent } = this._splitIndent(ln)
            const stripped = ln.replace(stripRe, '$1')
            const bare = stripped.slice(indent.length)
            if (allAreType) return indent + bare // toggle off
            if (type === 'ul') return indent + '- ' + bare
            if (type === 'ol') {
                const col = this._indentWidth(indent)
                for (const k of [...counters.keys()]) if (k > col) counters.delete(k)
                const n = (counters.get(col) || 0) + 1
                counters.set(col, n)
                return indent + n + '. ' + bare
            }
            return indent + '- [ ] ' + bare
        })
        const joined = newLines.join('\n')
        // Leaving the whole rewritten block selected meant the next character
        // typed replaced the line. With a collapsed caret the block is a single
        // line, so the caret just moves by the block's change in length.
        const collapsed = selStart === selEnd
        const caret = Math.max(firstLineStart,
            Math.min(selStart + (joined.length - block.length), firstLineStart + joined.length))
        this._applyEdit(textarea, firstLineStart, lastLineEnd, joined,
            collapsed ? caret : firstLineStart,
            collapsed ? caret : firstLineStart + joined.length)
    }

    // Toggle the done state of any task line(s) in the selection.
    _toggleDone(textarea) {
        const val = textarea.value
        const selStart = textarea.selectionStart
        const selEnd = textarea.selectionEnd
        const firstLineStart = val.lastIndexOf('\n', selStart - 1) + 1
        const lastLineEnd = val.indexOf('\n', selEnd === selStart ? selEnd : selEnd - 1) === -1
            ? val.length
            : val.indexOf('\n', selEnd === selStart ? selEnd : selEnd - 1)
        const block = val.slice(firstLineStart, lastLineEnd)
        const blines = block.split('\n')
        // Accept every marker the renderer draws a checkbox for: a tab or a
        // double space after the bullet, an ordered "1." marker, and a bare
        // "- [ ]" whose line ends right after the bracket. Read narrowly,
        // Cmd+Enter simply did nothing on such a line.
        const taskRe = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?=[ \t]|$))/
        const tasks = blines.filter(ln => taskRe.test(ln))
        if (tasks.length === 0) return
        const allDone = tasks.every(ln => taskRe.exec(ln)[2].toLowerCase() === 'x')
        const newLines = blines.map(ln => {
            const m = ln.match(taskRe)
            if (!m) return ln
            return m[1] + (allDone ? ' ' : 'x') + m[3] + ln.slice(m[0].length)
        })
        const caret = textarea.selectionStart
        this._applyEdit(textarea, firstLineStart, lastLineEnd, newLines.join('\n'), caret, caret)
    }

    // ── Smart paste: URL over selection → link ────────────────
    _handleSmartPaste(e, textarea, markDirty, preview) {
        const clipText = (e.clipboardData || window.clipboardData)?.getData('text') || ''
        if (!clipText) return

        const isUrl = /^https?:\/\/\S+$/.test(clipText.trim())
        const start = textarea.selectionStart
        const end = textarea.selectionEnd

        if (isUrl && start !== end) {
            e.preventDefault()
            const selected = textarea.value.slice(start, end)
            // If selection looks like an existing URL, replace it
            const isSelectedUrl = /^https?:\/\/\S+$/.test(selected.trim())
            let replacement
            if (isSelectedUrl) {
                replacement = clipText.trim()
            } else {
                replacement = `[${selected}](${clipText.trim()})`
            }
            this._applyEdit(textarea, start, end, replacement)
            markDirty()
            clearTimeout(this._previewTimer)
            this._previewTimer = setTimeout(() => this._renderPreview(preview, textarea.value), 100)
        }
    }

    // ── Link toolbar (floats over selection) ──────────────────
    _setupLinkToolbar(textarea, markDirty, preview) {
        // Create a floating toolbar
        const toolbar = document.createElement('div')
        toolbar.className = 'link-toolbar'
        toolbar.innerHTML = `<button class="link-toolbar-btn" title="Insert link">🔗 Link</button>`
        toolbar.style.display = 'none'
        document.body.appendChild(toolbar)

        const showToolbar = () => {
            const start = textarea.selectionStart
            const end = textarea.selectionEnd
            if (start === end) { toolbar.style.display = 'none'; return }

            const rect = textarea.getBoundingClientRect()
            // Estimate position from caret
            toolbar.style.display = 'flex'
            toolbar.style.left = `${rect.left + 8}px`
            toolbar.style.top = `${rect.top - 36}px`
        }

        textarea.addEventListener('mouseup', showToolbar)
        textarea.addEventListener('keyup', (e) => {
            if (e.shiftKey) showToolbar()
            else toolbar.style.display = 'none'
        })
        this._onDocument('mousedown', (e) => {
            if (!toolbar.contains(e.target) && e.target !== textarea) {
                toolbar.style.display = 'none'
            }
        })

        toolbar.querySelector('.link-toolbar-btn').addEventListener('mousedown', async (e) => {
            e.preventDefault()
            const start = textarea.selectionStart
            const end   = textarea.selectionEnd
            const selected = textarea.value.slice(start, end)
            toolbar.style.display = 'none'

            const url = await this._showModal({ type: 'input', title: 'INSERT LINK', placeholder: 'https://...', defaultValue: '' })
            if (!url) return
            const link = `[${selected}](${url.trim()})`
            this._applyEdit(textarea, start, end, link)
            textarea.focus()
            markDirty()
            this._renderPreview(preview, textarea.value)
        })

        // Cleanup on re-render
        const zone = this.container.querySelector('#editor-zone')
        if (zone) {
            const obs = new MutationObserver(() => {
                if (!document.body.contains(textarea)) {
                    toolbar.remove()
                    obs.disconnect()
                }
            })
            obs.observe(document.body, { childList: true, subtree: true })
        }
    }

    // ── Wikilink autocomplete ───────────────────────────────────
    _setupWikilinkAutocomplete(textarea, markDirty, preview) {
        let dropdown = null
        let selectedIdx = 0
        let candidates = []

        const close = () => {
            if (dropdown) { dropdown.remove(); dropdown = null }
            candidates = []
            this._wikilinkOpen = false
        }

        const show = (query) => {
            const allFiles = this._getAllFiles()
            const q = query.toLowerCase()
            candidates = allFiles.filter(f => f.title.toLowerCase().includes(q)).slice(0, 8)
            if (!candidates.length) { close(); return }

            if (!dropdown) {
                dropdown = document.createElement('div')
                dropdown.className = 'wikilink-autocomplete'
                document.body.appendChild(dropdown)
            }

            selectedIdx = 0
            const rect = textarea.getBoundingClientRect()
            // Position near cursor
            const textBefore = textarea.value.slice(0, textarea.selectionStart)
            const lines = textBefore.split('\n')
            const lineNum = lines.length - 1
            const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24
            const top = rect.top + (lineNum * lineHeight) - textarea.scrollTop + lineHeight + 4
            const left = rect.left + 16

            dropdown.style.top = `${Math.min(top, window.innerHeight - 200)}px`
            dropdown.style.left = `${Math.min(left, window.innerWidth - 260)}px`

            this._wikilinkOpen = true
            render()
        }

        const render = () => {
            if (!dropdown) return
            dropdown.innerHTML = candidates.map((f, i) => `
                <div class="wikilink-ac-item ${i === selectedIdx ? 'selected' : ''}" data-idx="${i}">
                    ${this._esc(f.title)}
                    <span class="wikilink-ac-path">${this._esc(f.folderPath)}</span>
                </div>
            `).join('')
            dropdown.querySelectorAll('.wikilink-ac-item').forEach((el, i) => {
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault()
                    accept(candidates[i])
                })
                el.addEventListener('mouseenter', () => {
                    selectedIdx = i
                    render()
                })
            })
        }

        const accept = (file) => {
            // Find the [[ before cursor and replace up to cursor
            const val = textarea.value
            const pos = textarea.selectionStart
            const before = val.slice(0, pos)
            const openBracket = before.lastIndexOf('[[')
            if (openBracket === -1) { close(); return }
            // Only swallow a "]]" that can plausibly close the caret's own
            // brackets: on this line, with no other "[" in between. The dropdown
            // is open precisely when the "[[" before the caret is unclosed — after
            // retyping a link's name, or on pasted text — so an unbounded search
            // finds the closing brackets of an unrelated link further down the
            // note and accepting the suggestion deletes everything in between.
            const lineEnd = val.indexOf('\n', pos)
            const segment = val.slice(pos, lineEnd === -1 ? val.length : lineEnd)
            const rel = segment.indexOf(']]')
            const endPos = (rel !== -1 && !segment.slice(0, rel).includes('[')) ? pos + rel + 2 : pos
            const replacement = `[[${file.title}]]`
            this._applyEdit(textarea, openBracket, endPos, replacement)
            markDirty()
            this._renderPreview(preview, textarea.value)
            close()
            textarea.focus()
        }

        textarea.addEventListener('input', () => {
            const val = textarea.value
            const pos = textarea.selectionStart
            const before = val.slice(0, pos)
            // Check if cursor is inside [[ ... (no closing ]])
            const lastOpen = before.lastIndexOf('[[')
            const lastClose = before.lastIndexOf(']]')
            if (lastOpen > lastClose && lastOpen !== -1) {
                const query = before.slice(lastOpen + 2)
                if (query.length > 0 && !query.includes('\n')) {
                    show(query)
                    return
                }
            }
            close()
        })

        textarea.addEventListener('keydown', (e) => {
            if (!dropdown) return
            if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = (selectedIdx + 1) % candidates.length; render() }
            else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = (selectedIdx - 1 + candidates.length) % candidates.length; render() }
            else if (e.key === 'Enter' && candidates.length) { e.preventDefault(); accept(candidates[selectedIdx]) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
        })

        textarea.addEventListener('blur', () => setTimeout(close, 200))

        // Cleanup on re-render
        const zone = this.container.querySelector('#editor-zone')
        if (zone) {
            const obs = new MutationObserver(() => {
                if (!document.body.contains(textarea)) { close(); obs.disconnect() }
            })
            obs.observe(document.body, { childList: true, subtree: true })
        }
    }

    // ── Sync checkbox click in preview → editor text ──────────
    _syncCheckboxToEditor(checkbox, textarea) {
        // Match by POSITION, not by text. The old code looked for the first
        // source line whose text overlapped the clicked item, so two tasks with
        // the same (or one containing the other's) wording toggled each other —
        // ticking "buy milk" would tick "buy milk tomorrow" further up instead.
        // Only this note's own checkboxes count. A transcluded note (![[other]])
        // renders its tasks into the same preview element, and including those
        // would shift every index past the embed.
        const root = checkbox.closest('.editor-preview')
        if (!root || checkbox.closest('.embed-block')) return
        const boxes = Array.from(root.querySelectorAll('input[type="checkbox"]'))
            .filter(cb => !cb.closest('.embed-block'))
        const nth = boxes.indexOf(checkbox)
        if (nth === -1) return

        const val = textarea.value
        const lines = val.split('\n')
        const mask = this._fenceMask(lines)
        // The `]` may be followed by whitespace or end the line: an item the user
        // has only just created ("- [ ]") is rendered as a checkbox, so it has to
        // be counted here too or every checkbox below it maps one line too high.
        const taskRe = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?=[ \t]|$))/
        let seen = -1
        for (let i = 0; i < lines.length; i++) {
            if (mask[i]) continue
            const m = lines[i].match(taskRe)
            if (!m) continue
            if (++seen !== nth) continue
            const lineStart = lines.slice(0, i).reduce((n, ln) => n + ln.length + 1, 0)
            const currentlyChecked = m[2].toLowerCase() === 'x'
            const caret = textarea.selectionStart
            // _applyEdit focuses the textarea to run the edit; in split view the
            // user clicked in the preview and expects to stay there.
            const wasActive = document.activeElement
            this._applyEdit(
                textarea,
                lineStart + m[1].length, lineStart + m[1].length + 1,
                currentlyChecked ? ' ' : 'x',
                caret, caret,
            )
            if (wasActive && wasActive !== textarea && wasActive.isConnected) {
                wasActive.focus({ preventScroll: true })
            }
            return
        }
    }

    // ── Click in preview → jump to matching text in editor ────
    _syncPreviewClickToEditor(e, preview, textarea) {
        const target = e.target.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, td')
        if (!target) return
        // Get the plain text of the clicked element (truncated for search)
        const previewText = target.textContent.trim().slice(0, 60).replace(/\s+/g, ' ')
        if (!previewText) return

        const lines = textarea.value.split('\n')
        // Find the best matching line
        let bestLine = -1
        let bestScore = 0
        for (let i = 0; i < lines.length; i++) {
            const stripped = lines[i].replace(/^#{1,6}\s+|^[-*+]\s+|^\d+[.)]\s+|^\s*>\s+/, '').trim()
            if (!stripped) continue
            // Compute overlap
            const overlap = this._textOverlap(previewText.toLowerCase(), stripped.toLowerCase())
            if (overlap > bestScore) {
                bestScore = overlap
                bestLine = i
            }
        }

        if (bestLine < 0 || bestScore < 8) return

        let pos = 0
        for (let i = 0; i < bestLine; i++) {
            pos += lines[i].length + 1
        }
        textarea.focus()
        textarea.setSelectionRange(pos, pos)
        this._scrollTextareaTo(textarea, pos)
    }

    _textOverlap(a, b) {
        // Count matching characters in common prefix of longest substring
        let count = 0
        const minLen = Math.min(a.length, b.length, 40)
        for (let i = 0; i < minLen; i++) {
            if (a[i] === b[i]) count++
            else break
        }
        return count
    }

    // ── PDF Export ────────────────────────────────────────────
    _exportPDF(title, previewEl) {
        const printWindow = window.open('', '_blank')
        if (!printWindow) {
            alert('Popup blocked — allow popups for this site to export PDFs.')
            return
        }
        const theme = document.documentElement.getAttribute('data-theme') || 'cyberpunk'
        // Carry the app's stylesheets into the print document (theme variables,
        // .editor-preview rules, hljs token colors, KaTeX, fonts) so the export
        // matches the live preview under the active theme.
        const headAssets = Array.from(
            document.querySelectorAll('head style, head link[rel="stylesheet"], head link[rel="preconnect"]')
        ).map(n => n.outerHTML).join('\n')

        printWindow.document.write(`
<!DOCTYPE html>
<html data-theme="${theme}">
<head>
    <meta charset="UTF-8">
    <title>${this._esc(title)}</title>
    ${headAssets}
    <style>
        /* Zero page margin suppresses the browser's printed headers/footers
           (date, title, URL, page numbers). Real page margins come from the
           .print-layout table below — its thead/tfoot repeat on every page. */
        @page { margin: 0; }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        html, body { margin: 0; padding: 0; overflow: visible; }
        html { background: var(--t-body-bg, #fff); }
        /* Scanline/noise overlays don't belong on paper */
        body::before, body::after { display: none !important; }
        table.print-layout { width: 100%; border-collapse: collapse; }
        table.print-layout > thead > tr > td,
        table.print-layout > tbody > tr > td,
        table.print-layout > tfoot > tr > td { border: none; padding: 0; background: none; }
        .page-margin { height: 15mm; }
        /* The content div carries .editor-preview so every theme rule applies;
           strip only its on-screen panel chrome (border, box bg, scroll) */
        .pdf-content { max-width: 800px; margin: 0 auto; padding: 0 18mm; border: none; background: transparent; border-radius: 0; overflow: visible; }
        .pdf-content h1, .pdf-content h2, .pdf-content h3,
        .pdf-content h4, .pdf-content h5, .pdf-content h6 { break-after: avoid; }
        .pdf-content pre { break-inside: avoid; white-space: pre-wrap; word-wrap: break-word; overflow-x: visible; }
        .pdf-content blockquote, .pdf-content table,
        .pdf-content .katex-display, .pdf-content .mermaid { break-inside: avoid; }
        h1.pdf-title { font-size: 2rem; border-bottom-width: 2px; border-bottom-style: solid; padding-bottom: 0.5rem; margin-bottom: 2rem; }
    </style>
</head>
<body>
    <table class="print-layout">
        <thead><tr><td><div class="page-margin"></div></td></tr></thead>
        <tbody><tr><td>
            <div class="editor-preview pdf-content">
                <h1 class="pdf-title">${this._esc(title)}</h1>
                ${previewEl.innerHTML}
            </div>
        </td></tr></tbody>
        <tfoot><tr><td><div class="page-margin"></div></td></tr></tfoot>
    </table>
    <script>
        window.onload = function() {
            var go = function() { window.print(); };
            // Wait for web fonts so printing doesn't race font loading
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(function() { setTimeout(go, 100); });
            } else { go(); }
        };
        window.onafterprint = function() { window.close(); };
    <\/script>
</body>
</html>
        `)
        printWindow.document.close()
    }

    // ── Wikilink helpers ────────────────────────────────────────
    // Backlinks, the graph view and tag search all read `content` off these
    // copies. The prefetch fills the content cache without writing bodies back
    // into the meta records, so read through contentFor — otherwise a browser
    // holding the entire vault still shows an empty graph and no backlinks
    // until each note has been opened by hand.
    _getAllFiles() {
        const allFolders = foldersAPI.list()
        const files = []
        for (const f of allFolders) {
            for (const file of f.files) {
                files.push({
                    ...file,
                    content: contentFor(file),
                    folderId: f.id, folderName: f.name, folderPath: f.path,
                })
            }
        }
        return files
    }

    _findFileByTitle(title) {
        const lower = title.toLowerCase().trim()
        const allFiles = this._getAllFiles()
        return allFiles.find(f => f.title.toLowerCase() === lower)
            || allFiles.find(f => f.path.replace(/\.md$/, '').split('/').pop().replace(/-/g, ' ').toLowerCase() === lower)
    }

    _getBacklinks(currentFile) {
        if (!currentFile) return []
        const title = currentFile.title.toLowerCase()
        const allFiles = this._getAllFiles()
        const backlinks = []
        for (const f of allFiles) {
            if (f.id === currentFile.id) continue
            const content = f.content || ''
            // Match [[title]] or [[title|alias]]
            const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
            let match
            while ((match = wikiRe.exec(content)) !== null) {
                if (match[1].trim().toLowerCase() === title) {
                    backlinks.push(f)
                    break
                }
            }
        }
        return backlinks
    }

    // ── Star/favorite files ──────────────────────────────────────
    _toggleStar(fileId) {
        if (this._starred.has(fileId)) this._starred.delete(fileId)
        else this._starred.add(fileId)
        localStorage.setItem(STARRED_KEY, JSON.stringify([...this._starred]))
    }

    _addRecent(folderId, fileId, title) {
        this._recent = this._recent.filter(r => r.fileId !== fileId)
        this._recent.unshift({ folderId, fileId, title })
        if (this._recent.length > 10) this._recent = this._recent.slice(0, 10)
        localStorage.setItem(RECENT_KEY, JSON.stringify(this._recent))
    }

    // ── Command Palette ─────────────────────────────────────────
    _showCommandPalette() {
        const isMac = navigator.platform.includes('Mac')
        const mod = isMac ? 'Cmd' : 'Ctrl'
        const commands = [
            { name: 'Quick Switcher: Open file...', key: `${mod}+O`, action: () => this._showQuickSwitcher() },
            { name: 'Graph View: Show connections', key: `${mod}+G`, action: () => this._showGraphView() },
            { name: 'Settings', action: () => this._showSettingsPanel() },
            { name: 'New File', action: () => { if (this.currentFolder) this._promptNewFile(); else this._toast('Open a folder first') } },
            { name: 'New Folder', action: () => this._promptNewFolder(null) },
            { name: 'Import Obsidian Vault', action: () => this._triggerVaultImport() },
            { name: 'Toggle Focus Mode', action: () => { const z = this.container.querySelector('#editor-zone'); if (z) this._toggleFocusMode(z) } },
            { name: 'Export as PDF', action: () => { const p = this.container.querySelector('#editor-preview'); const t = this.container.querySelector('#file-title'); if (p && t) this._exportPDF(t.value, p) } },
            { name: 'Toggle Autosave', action: () => { this.autosave = !this.autosave; localStorage.setItem(AUTOSAVE_KEY, this.autosave); this._toast(`Autosave ${this.autosave ? 'on' : 'off'}`) } },
            { name: 'Toggle Outline Panel', action: () => { this._outlineOpen = !this._outlineOpen; this._updateOutlinePanel() } },
            { name: 'Toggle Backlinks Panel', action: () => { this._backlinksOpen = !this._backlinksOpen; this._updateBacklinksPanel() } },
            { name: 'Keyboard Shortcuts', key: `${mod}+/`, action: () => this._showShortcutsPanel() },
            ...THEMES.map(t => ({ name: `Theme: ${t.label}`, action: () => { this._applyTheme(t.id); this._syncThemePicker(t.id) } })),
            { name: 'Log Out', action: () => this.container.querySelector('#logout-btn')?.click() },
        ]

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay command-palette-overlay'
        overlay.innerHTML = `
            <div class="command-palette">
                <input class="command-palette-input" placeholder="Type a command..." autofocus />
                <div class="command-palette-list"></div>
            </div>
        `
        document.body.appendChild(overlay)

        const input = overlay.querySelector('.command-palette-input')
        const list = overlay.querySelector('.command-palette-list')
        let selectedIdx = 0

        const renderList = (filter = '') => {
            const q = filter.toLowerCase()
            const filtered = commands.filter(c => c.name.toLowerCase().includes(q))
            selectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1))
            list.innerHTML = filtered.map((c, i) => `
                <button class="command-palette-item ${i === selectedIdx ? 'selected' : ''}" data-idx="${i}">
                    <span class="command-name">${c.name}</span>
                    ${c.key ? `<kbd class="command-key">${c.key}</kbd>` : ''}
                </button>
            `).join('')
            list.querySelectorAll('.command-palette-item').forEach((btn, i) => {
                btn.addEventListener('click', () => { close(); filtered[i].action() })
                btn.addEventListener('mouseenter', () => {
                    selectedIdx = i
                    list.querySelectorAll('.command-palette-item').forEach((b, j) => b.classList.toggle('selected', j === i))
                })
            })
            return filtered
        }

        const close = () => overlay.remove()
        overlay.addEventListener('click', e => { if (e.target === overlay) close() })

        let filteredCommands = renderList()
        input.addEventListener('input', () => { selectedIdx = 0; filteredCommands = renderList(input.value) })
        // Bound on the overlay, not the input: with focus on a row, Escape
        // used to fall through to the document handler and close the note.
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); close() }
        })
        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = (selectedIdx + 1) % filteredCommands.length; renderList(input.value) }
            if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = (selectedIdx - 1 + filteredCommands.length) % filteredCommands.length; renderList(input.value) }
            if (e.key === 'Enter') { close(); if (filteredCommands[selectedIdx]) filteredCommands[selectedIdx].action() }
        })
        input.focus()
    }

    // ── Quick Switcher ──────────────────────────────────────────
    _showQuickSwitcher() {
        const allFiles = this._getAllFiles()
        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay command-palette-overlay'
        overlay.innerHTML = `
            <div class="command-palette quick-switcher">
                <input class="command-palette-input" placeholder="Search notes..." autofocus />
                <div class="command-palette-list"></div>
            </div>
        `
        document.body.appendChild(overlay)

        const input = overlay.querySelector('.command-palette-input')
        const list = overlay.querySelector('.command-palette-list')
        let selectedIdx = 0

        const fuzzyMatch = (query, text) => {
            const q = query.toLowerCase()
            const t = text.toLowerCase()
            if (!q) return true
            let qi = 0
            for (let ti = 0; ti < t.length && qi < q.length; ti++) {
                if (t[ti] === q[qi]) qi++
            }
            return qi === q.length
        }

        const renderList = (filter = '') => {
            let filtered
            if (!filter) {
                // Show recent files first, then starred, then all
                const recentIds = new Set(this._recent.map(r => r.fileId))
                const starredNotRecent = allFiles.filter(f => this._starred.has(f.id) && !recentIds.has(f.id))
                const recent = this._recent.map(r => allFiles.find(f => f.id === r.fileId)).filter(Boolean)
                const rest = allFiles.filter(f => !recentIds.has(f.id) && !this._starred.has(f.id))
                filtered = [...recent, ...starredNotRecent, ...rest]
            } else {
                filtered = allFiles.filter(f => fuzzyMatch(filter, f.title) || fuzzyMatch(filter, f.folderPath + '/' + f.title))
            }
            filtered = filtered.slice(0, 20)
            selectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1))

            list.innerHTML = filtered.map((f, i) => `
                <button class="command-palette-item ${i === selectedIdx ? 'selected' : ''}" data-idx="${i}">
                    <span class="command-name">
                        ${this._starred.has(f.id) ? '<span class="star-icon">&#9733;</span> ' : ''}${this._esc(f.title)}
                    </span>
                    <span class="command-key switcher-path">${this._esc(f.folderPath)}</span>
                </button>
            `).join('')

            list.querySelectorAll('.command-palette-item').forEach((btn, i) => {
                btn.addEventListener('click', () => { close(); openFile(filtered[i]) })
                btn.addEventListener('mouseenter', () => {
                    selectedIdx = i
                    list.querySelectorAll('.command-palette-item').forEach((b, j) => b.classList.toggle('selected', j === i))
                })
            })
            return filtered
        }

        const openFile = async (f) => {
            const folder = foldersAPI.list().find(fl => fl.id === f.folderId)
            if (!folder) return
            this.currentFolder = folder
            this._openFile(f)
        }

        const close = () => overlay.remove()
        overlay.addEventListener('click', e => { if (e.target === overlay) close() })

        let filteredFiles = renderList()
        input.addEventListener('input', () => { selectedIdx = 0; filteredFiles = renderList(input.value) })
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); close() }
        })
        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = (selectedIdx + 1) % filteredFiles.length; renderList(input.value) }
            if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = (selectedIdx - 1 + filteredFiles.length) % filteredFiles.length; renderList(input.value) }
            if (e.key === 'Enter') { close(); if (filteredFiles[selectedIdx]) openFile(filteredFiles[selectedIdx]) }
        })
        input.focus()
    }

    // ── Graph View ──────────────────────────────────────────────
    _showGraphView() {
        const allFiles = this._getAllFiles()
        // Build adjacency map from wikilinks
        const nodes = allFiles.map(f => ({ id: f.id, title: f.title, folderId: f.folderId }))
        const edges = []
        const titleToId = {}
        for (const f of allFiles) {
            titleToId[f.title.toLowerCase()] = f.id
        }
        for (const f of allFiles) {
            const content = f.content || ''
            const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
            let match
            while ((match = wikiRe.exec(content)) !== null) {
                const target = match[1].trim().toLowerCase()
                const targetId = titleToId[target]
                if (targetId && targetId !== f.id) {
                    edges.push({ from: f.id, to: targetId })
                }
            }
        }

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay graph-view-overlay'
        overlay.innerHTML = `
            <div class="graph-view-container">
                <div class="graph-view-header">
                    <span class="graph-view-title">Graph View</span>
                    <span class="graph-view-stats">${nodes.length} notes, ${edges.length} links</span>
                    <button class="graph-view-close">&times;</button>
                </div>
                <canvas id="graph-canvas" class="graph-canvas"></canvas>
            </div>
        `
        document.body.appendChild(overlay)

        const close = () => overlay.remove()
        overlay.querySelector('.graph-view-close').addEventListener('click', close)
        overlay.addEventListener('click', e => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close() } })
        overlay.setAttribute('tabindex', '-1')
        overlay.focus()

        // Render graph with force-directed layout
        const canvas = overlay.querySelector('#graph-canvas')
        const container = overlay.querySelector('.graph-view-container')
        const rect = container.getBoundingClientRect()
        canvas.width = rect.width
        canvas.height = rect.height - 50
        const ctx = canvas.getContext('2d')

        if (nodes.length === 0) {
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--nc-text-dim').trim() || '#666'
            ctx.font = '14px sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText('No notes yet', canvas.width / 2, canvas.height / 2)
            return
        }

        // Initialize positions randomly
        const positions = {}
        const velocities = {}
        for (const n of nodes) {
            positions[n.id] = { x: Math.random() * canvas.width * 0.6 + canvas.width * 0.2, y: Math.random() * canvas.height * 0.6 + canvas.height * 0.2 }
            velocities[n.id] = { x: 0, y: 0 }
        }

        // Connected nodes set (for sizing)
        const connected = new Set()
        for (const e of edges) { connected.add(e.from); connected.add(e.to) }

        const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--t-accent').trim() || '#ff003c'
        const accent2Color = getComputedStyle(document.documentElement).getPropertyValue('--t-accent2').trim() || '#00f5ff'
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--nc-text').trim() || '#c8d8e4'
        const dimColor = getComputedStyle(document.documentElement).getPropertyValue('--nc-text-dim').trim() || '#4a5568'

        let hoveredNode = null
        let dragNode = null

        canvas.addEventListener('mousemove', (e) => {
            const r = canvas.getBoundingClientRect()
            const mx = e.clientX - r.left, my = e.clientY - r.top
            hoveredNode = null
            for (const n of nodes) {
                const p = positions[n.id]
                const dist = Math.sqrt((p.x - mx) ** 2 + (p.y - my) ** 2)
                if (dist < 12) { hoveredNode = n; break }
            }
            canvas.style.cursor = hoveredNode ? 'pointer' : 'default'
            if (dragNode) {
                positions[dragNode.id].x = mx
                positions[dragNode.id].y = my
            }
        })
        canvas.addEventListener('mousedown', () => { if (hoveredNode) dragNode = hoveredNode })
        canvas.addEventListener('mouseup', () => { dragNode = null })
        canvas.addEventListener('dblclick', () => {
            if (hoveredNode) {
                close()
                const f = allFiles.find(fi => fi.id === hoveredNode.id)
                if (f) {
                    const folder = foldersAPI.list().find(fl => fl.id === f.folderId)
                    if (folder) { this.currentFolder = folder; this._openFile(f) }
                }
            }
        })

        // Force simulation
        let animFrame
        const simulate = () => {
            // Not every way out of this view runs the close handlers below —
            // a logout tears the overlay off the document directly — and a loop
            // left running against a detached canvas pins a core forever.
            if (!overlay.isConnected) return
            // Repulsion between all nodes
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = positions[nodes[i].id], b = positions[nodes[j].id]
                    let dx = b.x - a.x, dy = b.y - a.y
                    let dist = Math.sqrt(dx * dx + dy * dy) || 1
                    const force = 800 / (dist * dist)
                    const fx = (dx / dist) * force, fy = (dy / dist) * force
                    velocities[nodes[i].id].x -= fx; velocities[nodes[i].id].y -= fy
                    velocities[nodes[j].id].x += fx; velocities[nodes[j].id].y += fy
                }
            }
            // Attraction along edges
            for (const e of edges) {
                const a = positions[e.from], b = positions[e.to]
                let dx = b.x - a.x, dy = b.y - a.y
                let dist = Math.sqrt(dx * dx + dy * dy) || 1
                const force = (dist - 100) * 0.005
                const fx = (dx / dist) * force, fy = (dy / dist) * force
                velocities[e.from].x += fx; velocities[e.from].y += fy
                velocities[e.to].x -= fx; velocities[e.to].y -= fy
            }
            // Center gravity
            for (const n of nodes) {
                const p = positions[n.id], v = velocities[n.id]
                v.x += (canvas.width / 2 - p.x) * 0.0005
                v.y += (canvas.height / 2 - p.y) * 0.0005
                v.x *= 0.85; v.y *= 0.85
                if (dragNode?.id !== n.id) { p.x += v.x; p.y += v.y }
                p.x = Math.max(20, Math.min(canvas.width - 20, p.x))
                p.y = Math.max(20, Math.min(canvas.height - 20, p.y))
            }

            // Draw
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            // Edges
            for (const e of edges) {
                const a = positions[e.from], b = positions[e.to]
                ctx.beginPath()
                ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
                ctx.strokeStyle = dimColor
                ctx.lineWidth = (hoveredNode && (e.from === hoveredNode.id || e.to === hoveredNode.id)) ? 2 : 0.5
                if (hoveredNode && (e.from === hoveredNode.id || e.to === hoveredNode.id)) ctx.strokeStyle = accent2Color
                ctx.stroke()
            }
            // Nodes
            for (const n of nodes) {
                const p = positions[n.id]
                const isHovered = hoveredNode?.id === n.id
                const isConnected = connected.has(n.id)
                const radius = isHovered ? 8 : (isConnected ? 5 : 3)
                ctx.beginPath()
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
                ctx.fillStyle = isHovered ? accentColor : (isConnected ? accent2Color : dimColor)
                ctx.fill()
                if (isHovered || (hoveredNode && edges.some(e => (e.from === hoveredNode.id && e.to === n.id) || (e.to === hoveredNode.id && e.from === n.id)))) {
                    ctx.font = '11px sans-serif'
                    ctx.fillStyle = textColor
                    ctx.textAlign = 'center'
                    ctx.fillText(n.title, p.x, p.y - radius - 4)
                }
            }
            animFrame = requestAnimationFrame(simulate)
        }
        simulate()

        // Cleanup on close
        const origClose = close
        const cleanClose = () => { cancelAnimationFrame(animFrame); origClose() }
        overlay.querySelector('.graph-view-close').removeEventListener('click', origClose)
        overlay.querySelector('.graph-view-close').addEventListener('click', cleanClose)
        overlay.removeEventListener('click', origClose)
        overlay.addEventListener('click', e => { if (e.target === overlay) cleanClose() })
        overlay.removeEventListener('keydown', close)
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); cleanClose() } })
    }

    // ── Outline Panel ───────────────────────────────────────────
    _updateOutlinePanel() {
        const existing = this.container.querySelector('.outline-panel')
        if (!this._outlineOpen || this.view !== 'editor') {
            if (existing) existing.remove()
            return
        }
        const textarea = this.container.querySelector('#file-content')
        if (!textarea) return

        const lines = textarea.value.split('\n')
        const headings = []
        lines.forEach((line, i) => {
            const match = line.match(/^(#{1,6})\s+(.+)/)
            if (match) headings.push({ level: match[1].length, text: match[2], lineIndex: i })
        })

        if (existing) existing.remove()
        const panel = document.createElement('div')
        panel.className = 'outline-panel'
        panel.innerHTML = `
            <div class="outline-header">
                <span>Outline</span>
                <button class="outline-close">&times;</button>
            </div>
            <div class="outline-list">
                ${headings.length ? headings.map((h, idx) => `
                    <button class="outline-item" data-idx="${idx}" style="padding-left: ${(h.level - 1) * 12 + 8}px">
                        <span class="outline-level">H${h.level}</span>
                        <span class="outline-text">${this._esc(h.text)}</span>
                    </button>
                `).join('') : '<p class="outline-empty">No headings</p>'}
            </div>
        `
        const editorZone = this.container.querySelector('#editor-zone')
        if (editorZone) editorZone.appendChild(panel)

        panel.querySelector('.outline-close').addEventListener('click', () => {
            this._outlineOpen = false
            panel.remove()
        })
        panel.querySelectorAll('.outline-item').forEach(btn => {
            btn.addEventListener('click', () => {
                // The panel stays up while the note is edited, so the offsets it
                // was built from drift with every character typed above a
                // heading. Locate the heading in the text as it is now.
                const idx = parseInt(btn.dataset.idx)
                const live = textarea.value.split('\n')
                const at = []
                live.forEach((line, i) => { if (/^(#{1,6})\s+(.+)/.test(line)) at.push(i) })
                const lineIndex = at[idx]
                if (lineIndex === undefined) return
                let pos = 0
                for (let i = 0; i < lineIndex; i++) pos += live[i].length + 1
                textarea.focus()
                textarea.setSelectionRange(pos, pos)
                this._scrollTextareaTo(textarea, pos)
            })
        })
    }

    // ── Backlinks Panel ─────────────────────────────────────────
    _updateBacklinksPanel() {
        const existing = this.container.querySelector('.backlinks-panel')
        if (!this._backlinksOpen || this.view !== 'editor' || !this.currentFile) {
            if (existing) existing.remove()
            return
        }
        const backlinks = this._getBacklinks(this.currentFile)

        if (existing) existing.remove()
        const panel = document.createElement('div')
        panel.className = 'backlinks-panel'
        panel.innerHTML = `
            <div class="backlinks-header">
                <span>Backlinks (${backlinks.length})</span>
                <button class="backlinks-close">&times;</button>
            </div>
            <div class="backlinks-list">
                ${backlinks.length ? backlinks.map(f => `
                    <button class="backlinks-item" data-folder-id="${f.folderId}" data-file-id="${f.id}">
                        <span class="backlinks-name">${this._esc(f.title)}</span>
                        <span class="backlinks-path">${this._esc(f.folderPath)}</span>
                    </button>
                `).join('') : '<p class="backlinks-empty">No backlinks found</p>'}
            </div>
        `
        const editorZone = this.container.querySelector('#editor-zone')
        if (editorZone) editorZone.appendChild(panel)

        panel.querySelector('.backlinks-close').addEventListener('click', () => {
            this._backlinksOpen = false
            panel.remove()
        })
        panel.querySelectorAll('.backlinks-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (!folder) return
                const file = folder.files.find(f => f.id === btn.dataset.fileId)
                if (!file) return
                this.currentFolder = folder
                await this._openFile(file)
            })
        })
    }

    // ── Tag extraction ──────────────────────────────────────────
    _extractTags(content) {
        const tags = new Set()
        const tagRe = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g
        let match
        while ((match = tagRe.exec(content)) !== null) {
            tags.add(match[1].toLowerCase())
        }
        return [...tags]
    }

    // ── Math normalisation ────────────────────────────────────
    _normaliseMath(md) {
        md = md.replace(/^\s*\[\s*\n([\s\S]*?)\n\s*\]\s*$/gm, (_, inner) => `$$${inner.trim()}$$`)
        md = md.replace(/^\s*\[\s*(.*?\\.*?)\s*\]\s*$/gm, (_, inner) => `$$${inner.trim()}$$`)
        md = md.replace(/\(([^()]*\\[^()]*)\)/g, (_, inner) => `$${inner.trim()}$`)
        return md
    }

    // ── Pre-process markdown for Obsidian features ─────────────
    _preprocessMarkdown(md) {
        // Wikilinks: [[note]] → clickable link, [[note|alias]] → alias text
        md = md.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
            return `<div class="embed-block" data-embed="${this._esc(target.trim())}">${alias || target.trim()}</div>`
        })
        md = md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
            const display = alias || target.trim()
            return `<a class="wikilink" data-target="${this._esc(target.trim())}">${this._esc(display)}</a>`
        })

        // Tags: #tag → styled span
        md = md.replace(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g, (match, tag) => {
            const prefix = match.startsWith(' ') || match.startsWith('\n') ? match[0] : ''
            return `${prefix}<span class="tag-pill" data-tag="${tag.toLowerCase()}">#${tag}</span>`
        })

        // Callout blocks: > [!type] title
        md = md.replace(/^(>\s*)\[!(note|tip|warning|danger|info|abstract|todo|example|quote|bug|success|failure|question)\]\s*(.*)$/gim, (_, prefix, type, title) => {
            return `${prefix}<div class="callout callout-${type.toLowerCase()}"><div class="callout-title">${type.toUpperCase()}${title ? ': ' + title : ''}</div>`
        })

        // Highlight ==text== → <mark>text</mark>
        md = md.replace(/==(.*?)==/g, '<mark>$1</mark>')

        // Footnotes: [^1] → superscript link, [^1]: → definition
        md = md.replace(/\[\^(\w+)\](?!:)/g, '<sup class="footnote-ref"><a href="#fn-$1" id="fnref-$1">$1</a></sup>')
        md = md.replace(/^\[\^(\w+)\]:\s*(.+)$/gm, '<div class="footnote" id="fn-$1"><sup>$1</sup> $2 <a href="#fnref-$1" class="footnote-back">&#x21A9;</a></div>')

        return md
    }

    // The body of an embedded note, fetched at most once per path. Several
    // blocks (and several repaints) can ask at the same time, so concurrent
    // callers share one request and the answer goes into the note cache. A
    // missing file does not: caching '' would make the note look empty to
    // everything else that reads through the cache.
    _readEmbedBody(path) {
        const hit = contentCache.getSync(path)
        if (hit) return Promise.resolve(hit.content)
        if (!this._embedReads) this._embedReads = new Map()
        const inflight = this._embedReads.get(path)
        if (inflight) return inflight
        const read = vaultAPI.readFileResult(path).then(({ content, missing }) => {
            if (!missing) contentCache.set(path, content)
            return content
        })
        this._embedReads.set(path, read)
        read.catch(() => {}).then(() => this._embedReads.delete(path))
        return read
    }

    // ── Render preview with source line tracking ──────────────
    _renderPreview(previewEl, markdown) {
        const source = markdown || ''

        // marked is fetched on demand rather than blocking the page load. Until
        // it lands, show the raw text (never a blank pane) and re-render once
        // it's there.
        if (typeof marked === 'undefined') {
            previewEl.textContent = source
            ensureMarked().then(ok => {
                if (ok && previewEl.isConnected) this._renderPreview(previewEl, markdown)
            })
            return
        }

        // _mdToHtml runs indent normalization FIRST (on pure markdown, before any
        // HTML injection), then math + Obsidian preprocessing, then marked.
        previewEl.innerHTML = this._mdToHtml(source)

        // Make checkboxes interactive (GFM task lists)
        previewEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.removeAttribute('disabled')
            cb.style.cursor = 'pointer'
            // Wrap the item's own text so a completed task can be struck
            // through without the line also running across its sub-tasks —
            // text-decoration inherits and a descendant cannot cancel it, so
            // the only way to scope it is to give the text its own element.
            // In a loose list marked wraps the item in a <p>, so the checkbox's
            // parent is that <p> rather than the <li>. Wrap inside whichever it is.
            const host = cb.parentElement
            if (!host || !/^(LI|P)$/.test(host.tagName)) return
            if (host.querySelector(':scope > .task-text')) return
            const span = document.createElement('span')
            span.className = 'task-text'
            let node = cb.nextSibling
            while (node && !(node.nodeType === 1 && /^(UL|OL)$/.test(node.tagName))) {
                const next = node.nextSibling
                span.appendChild(node)
                node = next
            }
            cb.after(span)
        })

        // Style inline code with extra LaTeX-like monospace emphasis
        previewEl.querySelectorAll('code:not(pre code)').forEach(el => {
            el.classList.add('inline-code-tt')
        })

        // Split diagram blocks out of the code blocks before highlighting. This
        // used to live inside the "is highlight.js loaded" branch, so diagrams
        // silently didn't render whenever hljs was missing.
        const toHighlight = []
        let hasMermaid = false
        previewEl.querySelectorAll('pre code').forEach(block => {
            const text = block.textContent.trim()
            if (block.className.includes('language-mermaid') || text.startsWith('graph ')
                || text.startsWith('sequenceDiagram') || text.startsWith('flowchart')) {
                const mermaidDiv = document.createElement('div')
                mermaidDiv.className = 'mermaid'
                mermaidDiv.textContent = block.textContent
                block.closest('pre').replaceWith(mermaidDiv)
                hasMermaid = true
                return
            }
            toHighlight.push(block)
        })

        // Syntax highlighting — highlight.js is only fetched for a note that
        // actually has code in it.
        if (toHighlight.length) {
            const highlight = () => toHighlight.forEach(b => {
                if (b.isConnected) window.hljs.highlightElement(b)
            })
            if (window.hljs) highlight()
            else ensureHljs().then(ok => { if (ok && previewEl.isConnected) highlight() })
        }

        // Mermaid is the heaviest library of the lot; a note without a diagram
        // never downloads it.
        if (hasMermaid) {
            const runMermaid = () => {
                try {
                    window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
                    window.mermaid.run({ nodes: previewEl.querySelectorAll('.mermaid') })
                } catch { /* mermaid parse errors are non-fatal */ }
            }
            if (window.mermaid) runMermaid()
            else ensureMermaid().then(ok => { if (ok && previewEl.isConnected) runMermaid() })
        }

        // Wikilink click handling
        previewEl.querySelectorAll('.wikilink').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault()
                const target = link.dataset.target
                const file = this._findFileByTitle(target)
                if (file) {
                    const folder = foldersAPI.list().find(f => f.id === file.folderId)
                    if (folder) {
                        this.currentFolder = folder
                        this._openFile(file)
                    }
                } else {
                    // Offer to create the note
                    this._showModal({ type: 'confirm', title: 'CREATE NOTE', message: `"${target}" doesn't exist. Create it?` })
                        .then(ok => {
                            if (!ok || !this.currentFolder) return
                            filesAPI.create(this.currentFolder.id, target)
                                .then(newFile => {
                                    this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
                                    this._openFile(newFile)
                                })
                                .catch(err => this._toast(`Error: ${err.message}`))
                        })
                }
            })
        })

        // Tag click handling
        previewEl.querySelectorAll('.tag-pill').forEach(tag => {
            tag.addEventListener('click', () => {
                this._searchByTag(tag.dataset.tag)
            })
        })

        // Handle embeds - load referenced note content inline
        previewEl.querySelectorAll('.embed-block').forEach(async (block) => {
            const target = block.dataset.embed
            const file = this._findFileByTitle(target)
            if (file) {
                try {
                    // `file.content` is already read through the note cache, so
                    // only a note this browser has never held needs the network.
                    // Gating on `contentLoaded` instead meant every repaint — one
                    // per typing pause — re-downloaded the embedded note.
                    let content = file.content || ''
                    if (!content && file.path) content = await this._readEmbedBody(file.path)
                    // A later repaint may have replaced this block while the read
                    // was in flight; painting into the detached node is what made
                    // embeds flicker between placeholder and content while typing.
                    if (!block.isConnected) return
                    const embedHtml = typeof marked !== 'undefined' ? this._mdToHtml(content) : content
                    block.innerHTML = `<div class="embed-content"><div class="embed-title">${this._esc(file.title)}</div>${embedHtml}</div>`
                } catch {
                    block.innerHTML = `<div class="embed-error">Could not load: ${this._esc(target)}</div>`
                }
            } else {
                block.innerHTML = `<div class="embed-error">Note not found: ${this._esc(target)}</div>`
            }
        })

        // Render math with KaTeX — fetched only for notes that contain math.
        // Gate on the NORMALISED text, not the raw source: _normaliseMath turns
        // pasted `[ \frac{a}{b} ]` and `(x \le y)` into real $-delimiters, and
        // testing the source would miss those and never load KaTeX for them.
        if (needsMath(this._normaliseMath(source))) {
            const runMath = () => window.renderMathInElement(previewEl, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$',  right: '$',  display: false },
                    { left: '\\[', right: '\\]', display: true },
                    { left: '\\(', right: '\\)', display: false },
                ],
                throwOnError: false,
                ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
            })
            if (window.renderMathInElement) runMath()
            else ensureKatex().then(ok => { if (ok && previewEl.isConnected) runMath() })
        }
    }

    // ── Search by tag ───────────────────────────────────────────
    _searchByTag(tag) {
        const allFiles = this._getAllFiles()
        const matching = allFiles.filter(f => {
            const content = f.content || ''
            const tagRe = new RegExp(`(?:^|\\s)#${tag}(?:\\s|$)`, 'im')
            return tagRe.test(content)
        })

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay command-palette-overlay'
        overlay.innerHTML = `
            <div class="command-palette">
                <div class="tag-search-header">
                    <span class="tag-pill" style="pointer-events:none">#${this._esc(tag)}</span>
                    <span class="tag-search-count">${matching.length} note${matching.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="command-palette-list">
                    ${matching.map(f => `
                        <button class="command-palette-item" data-folder-id="${f.folderId}" data-file-id="${f.id}">
                            <span class="command-name">${this._esc(f.title)}</span>
                            <span class="command-key switcher-path">${this._esc(f.folderPath)}</span>
                        </button>
                    `).join('') || '<p class="outline-empty">No matching notes</p>'}
                </div>
            </div>
        `
        document.body.appendChild(overlay)
        const close = () => overlay.remove()
        overlay.addEventListener('click', e => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close() } })
        overlay.setAttribute('tabindex', '-1')
        overlay.focus()

        overlay.querySelectorAll('.command-palette-item').forEach(btn => {
            btn.addEventListener('click', () => {
                close()
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (!folder) return
                const file = folder.files.find(f => f.id === btn.dataset.fileId)
                if (!file) return
                this.currentFolder = folder
                this._openFile(file)
            })
        })
    }

    _setEditorMode(mode, editorZone) {
        if (mode === 'split' && this._isMobile()) mode = 'edit'
        this.editorMode = mode
        localStorage.setItem(EDITOR_MODE_KEY, mode)
        if (!editorZone) return
        editorZone.dataset.mode = mode
        editorZone.querySelectorAll('.mode-btn').forEach(btn => {
            const active = btn.dataset.mode === mode
            btn.classList.toggle('active', active)
            btn.setAttribute('aria-pressed', String(active))
        })
        if (mode === 'preview') {
            const contentArea = editorZone.querySelector('#file-content')
            const preview = editorZone.querySelector('#editor-preview')
            if (contentArea && preview) this._renderPreview(preview, contentArea.value)
        }
        if (mode === 'edit') {
            const contentArea = editorZone.querySelector('#file-content')
            if (contentArea) setTimeout(() => contentArea.focus(), 50)
        }
    }

    // ── Saving indicator (non-blocking) ─────────────────────────
    _showSavingOverlay() {
        // A chained save starts the moment the previous one settles, while the
        // old node is still fading out on its removal timer. Reusing the node
        // without cancelling that timer let the second save's overlay vanish
        // 200ms in, leaving no indicator while the write was still running.
        clearTimeout(this._savingOverlayTimer)
        const existing = document.getElementById('saving-overlay')
        if (existing) { existing.classList.add('visible'); return }
        const el = document.createElement('div')
        el.id = 'saving-overlay'
        el.className = 'saving-indicator'
        el.setAttribute('role', 'status')
        el.setAttribute('aria-live', 'polite')
        el.innerHTML = '<span class="saving-label">Saving...</span>'
        document.body.appendChild(el)
        this._savingOverlayTimer = setTimeout(() => el.classList.add('visible'), 10)
    }

    _hideSavingOverlay() {
        clearTimeout(this._savingOverlayTimer)
        const el = document.getElementById('saving-overlay')
        if (!el) return
        el.classList.remove('visible')
        this._savingOverlayTimer = setTimeout(() => el.remove(), 200)
    }

    // ── Progress toast ────────────────────────────────────────
    _showProgressToast(action, total) {
        const existing = document.getElementById('progress-toast')
        if (existing) existing.remove()

        const toast = document.createElement('div')
        toast.id = 'progress-toast'
        toast.className = 'progress-toast'
        toast.setAttribute('role', 'status')
        toast.setAttribute('aria-live', 'polite')
        toast.innerHTML = `
            <div class="progress-header">
                <span class="progress-action">> ${action.toUpperCase()} <span id="progress-fraction">0/${total}</span></span>
                <span class="progress-pct" id="progress-pct">0%</span>
            </div>
            <div class="progress-bar-outer">
                <div class="progress-bar-inner" id="progress-bar-inner" style="width:0%"></div>
            </div>
            <div class="progress-tracks" id="progress-tracks"></div>
        `
        document.body.appendChild(toast)
        setTimeout(() => toast.classList.add('visible'), 10)
        this._progressTotal = total
        this._progressDone = 0
    }

    _updateProgressToast(action, done, total) {
        const pct = Math.round((done / total) * 100)
        const fraction = document.getElementById('progress-fraction')
        const pctEl = document.getElementById('progress-pct')
        const bar = document.getElementById('progress-bar-inner')
        const tracks = document.getElementById('progress-tracks')

        if (fraction) fraction.textContent = `${done}/${total}`
        if (pctEl) pctEl.textContent = `${pct}%`
        if (bar) bar.style.width = `${pct}%`
        if (tracks) {
            // Add a track dot for each completed file
            const dot = document.createElement('span')
            dot.className = 'progress-track-dot done'
            dot.title = `File ${done}`
            tracks.appendChild(dot)
        }
    }

    _hideProgressToast() {
        const toast = document.getElementById('progress-toast')
        if (!toast) return
        toast.classList.remove('visible')
        setTimeout(() => toast.remove(), 400)
    }

    // ── Utilities ─────────────────────────────────────────────
    // Is a dialog on screen? Document-level keys stand down while one is.
    _overlayOpen() {
        return !!document.querySelector('.modal-overlay, .move-menu-overlay')
    }

    // A dialog owns the keyboard for as long as it is up. Tab is kept inside
    // the box: a dialog you can tab out of leaves the page behind it operable,
    // and strands the dialog's own Enter/Escape, which only fire while focus is
    // within it. `dismiss` is what a teardown (logging out, say) calls so the
    // promise the caller is awaiting gets an answer instead of hanging. The
    // returned release must be run on every path that removes the overlay.
    _trapModal(overlay, dismiss) {
        const previous = document.activeElement
        const onKeydown = (e) => {
            if (!overlay.isConnected) { release(); return }
            if (e.key !== 'Tab') return
            const els = Array.from(overlay.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'))
                .filter(el => !el.disabled && el.offsetParent !== null)
            if (!els.length) return
            const first = els[0]
            const last = els[els.length - 1]
            const active = document.activeElement
            // Focus that is outside the box, or on the box itself (the confirm
            // variant parks it there to hear Enter), has no neighbour to step
            // to — without this, one Shift+Tab lands on the page behind.
            if (!els.includes(active)) {
                e.preventDefault()
                const edge = e.shiftKey ? last : first
                edge.focus()
            } else if (e.shiftKey && active === first) {
                e.preventDefault()
                last.focus()
            } else if (!e.shiftKey && active === last) {
                e.preventDefault()
                first.focus()
            }
        }
        const release = () => {
            document.removeEventListener('keydown', onKeydown, true)
            this._openModals.delete(dismiss)
            if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus()
        }
        document.addEventListener('keydown', onKeydown, true)
        this._openModals.add(dismiss)
        return release
    }

    // `danger` styles the primary button as destructive. It used to be set on
    // every confirm dialog, which made it mean nothing — an irreversible delete
    // looked exactly like "leave without saving?".
    _showModal({ type = 'confirm', title = '', message = '', placeholder = '', defaultValue = '', danger = false } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div')
            overlay.className = 'modal-overlay'
            const safeTitle = this._esc(title)
            const safeMessage = this._esc(message)
            const safePlaceholder = this._esc(placeholder)

            if (type === 'input') {
                overlay.innerHTML = `
                    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title">
                        <div class="modal-title" id="modal-title">${safeTitle}</div>
                        <label class="sr-only" for="modal-input">${safeTitle || 'Value'}</label>
                        <input class="modal-input" id="modal-input" type="text" maxlength="200" placeholder="${safePlaceholder}" />
                        <div class="modal-actions">
                            <button class="modal-btn modal-cancel">CANCEL</button>
                            <button class="modal-btn modal-confirm">OK</button>
                        </div>
                    </div>`
                document.body.appendChild(overlay)
                const input = overlay.querySelector('.modal-input')
                // Set rather than interpolated: a name carrying a quote would be
                // cut off at that quote on its way through the attribute, and the
                // truncated remainder is what OK writes back.
                input.value = defaultValue == null ? '' : String(defaultValue)
                const release = this._trapModal(overlay, () => cancel())
                input.focus(); input.select()
                const confirm = () => { const v = input.value.trim(); release(); overlay.remove(); resolve(v || null) }
                const cancel  = () => { release(); overlay.remove(); resolve(null) }
                overlay.querySelector('.modal-confirm').addEventListener('click', confirm)
                overlay.querySelector('.modal-cancel').addEventListener('click', cancel)
                overlay.addEventListener('click', e => { if (e.target === overlay) cancel() })
                // On the overlay, not the input: once focus moves to a button the
                // input's handler no longer runs, and Escape would fall through
                // to the document and navigate the view behind this dialog.
                overlay.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && e.target === input) { e.preventDefault(); confirm() }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
                })
            } else {
                overlay.innerHTML = `
                    <div class="modal-box" role="alertdialog" aria-modal="true" aria-labelledby="modal-title"${message ? ' aria-describedby="modal-message"' : ''}>
                        <div class="modal-title" id="modal-title">${safeTitle}</div>
                        ${message ? `<div class="modal-message" id="modal-message">${safeMessage}</div>` : ''}
                        <div class="modal-actions">
                            <button class="modal-btn modal-cancel">CANCEL</button>
                            <button class="modal-btn modal-confirm${danger ? ' danger' : ''}">OK</button>
                        </div>
                    </div>`
                document.body.appendChild(overlay)
                const release = this._trapModal(overlay, () => no())
                const yes = () => { release(); overlay.remove(); resolve(true) }
                const no  = () => { release(); overlay.remove(); resolve(false) }
                overlay.querySelector('.modal-confirm').addEventListener('click', yes)
                overlay.querySelector('.modal-cancel').addEventListener('click', no)
                overlay.addEventListener('click', e => { if (e.target === overlay) no() })
                overlay.setAttribute('tabindex', '-1')
                overlay.focus()
                overlay.addEventListener('keydown', e => {
                    if (e.key === 'Enter') yes()
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); no() }
                })
            }
        })
    }

    _toast(message) {
        const toast = document.createElement('div')
        toast.className = 'cyber-toast'
        toast.setAttribute('role', 'status')
        toast.setAttribute('aria-live', 'polite')
        toast.textContent = message
        document.body.appendChild(toast)
        setTimeout(() => toast.classList.add('visible'), 10)
        setTimeout(() => {
            toast.classList.remove('visible')
            setTimeout(() => toast.remove(), 300)
        }, 4000)
    }

    // Escapes for text and for quoted-attribute positions alike. Quotes matter
    // as much as angle brackets here: the results land in `title="..."` and
    // similar, where an unescaped quote ends the attribute early — the text is
    // silently truncated there, and whatever follows it becomes markup.
    _esc(text) {
        if (text === null || text === undefined || text === '') return ''
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
    }

    _relTime(iso) {
        // A note synced from the cloud has no known mtime until the background
        // pass fills it in — show nothing rather than a made-up time.
        if (!iso) return '—'
        const t = new Date(iso).getTime()
        if (!Number.isFinite(t)) return '—'
        const diff = Date.now() - t
        const m = Math.floor(diff / 60000)
        const h = Math.floor(diff / 3600000)
        const d = Math.floor(diff / 86400000)
        if (m < 1) return 'just now'
        if (m < 60) return `${m}m ago`
        if (h < 24) return `${h}h ago`
        if (d < 7) return `${d}d ago`
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
}

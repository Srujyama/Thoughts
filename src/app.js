// src/app.js
import { foldersAPI, filesAPI, auth, vaultAPI, syncStatus } from './api.js'

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
function pushHash(folderPath, fileId) {
    let hash
    if (!folderPath) {
        hash = '#/'
    } else if (!fileId) {
        hash = '#/' + folderPath
    } else {
        hash = '#/' + folderPath + '//' + fileId
    }
    if (location.hash !== hash) history.pushState(null, '', hash)
}

function readHash() {
    const raw = location.hash.replace(/^#\/?/, '')
    if (!raw) return { folderPath: null, fileId: null }
    const sep = raw.indexOf('//')
    if (sep !== -1) {
        return { folderPath: raw.slice(0, sep) || null, fileId: raw.slice(sep + 2) || null }
    }
    return { folderPath: raw || null, fileId: null }
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
        this.autosave = localStorage.getItem(AUTOSAVE_KEY) === 'true'
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
        // Outline panel open state
        this._outlineOpen = false
        // Backlinks panel open state
        this._backlinksOpen = false

        // Apply saved theme (default: system)
        const savedTheme = localStorage.getItem(THEME_KEY) || 'system'
        this._applyTheme(savedTheme)

        this._restoreFromHash()
        window.addEventListener('popstate', () => this._restoreFromHash())

        // Global keyboard shortcuts
        this._globalKeyHandler = (e) => {
            // Command palette: Ctrl/Cmd+P
            if (e.key === 'p' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                this._showCommandPalette()
                return
            }
            // Quick switcher: Ctrl/Cmd+O
            if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                this._showQuickSwitcher()
                return
            }
            // Graph view: Ctrl/Cmd+G (when not in textarea)
            if (e.key === 'g' && (e.metaKey || e.ctrlKey) && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
                e.preventDefault()
                this._showGraphView()
                return
            }
        }
        document.addEventListener('keydown', this._globalKeyHandler)

        this._escHandler = async (e) => {
            if (e.key === 'Escape') {
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
                    this._navigate('files')
                } else if (this.view === 'files') {
                    const parent = this.currentFolder?.parentId
                        ? foldersAPI.list().find(f => f.id === this.currentFolder.parentId)
                        : null
                    if (parent) this._navigate('files', { folder: parent })
                    else this._navigate('folders')
                }
            }
        }
        document.addEventListener('keydown', this._escHandler)

        // Start sync status polling
        syncStatus.startPolling()

        // Apply autologout setting
        this._applyAutologout()
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

    async _triggerAutologout() {
        this._clearAutologoutTimer()
        if (this._autologoutActivityHandler) {
            const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
            events.forEach(ev => document.removeEventListener(ev, this._autologoutActivityHandler, true))
            this._autologoutActivityHandler = null
        }
        document.removeEventListener('keydown', this._escHandler)
        document.removeEventListener('keydown', this._globalKeyHandler)
        syncStatus.stopPolling()
        if (this._syncUnsub) this._syncUnsub()
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

    _isMobile() { return window.innerWidth <= 768 }

    // ── Routing ───────────────────────────────────────────────
    _navigate(view, { folder, file } = {}) {
        this.view = view
        if (folder !== undefined) this.currentFolder = folder
        if (file   !== undefined) this.currentFile   = file

        if (view === 'folders') {
            this.currentFolder = null
            this.currentFile   = null
            pushHash(null, null)
        } else if (view === 'files' && this.currentFolder) {
            this.currentFile = null
            pushHash(this.currentFolder.path, null)
        } else if (view === 'editor' && this.currentFolder && this.currentFile) {
            pushHash(this.currentFolder.path, this.currentFile.id)
        }
        this._render()
    }

    _restoreFromHash() {
        const { folderPath, fileId } = readHash()
        const allFolders = foldersAPI.list()

        if (!folderPath) {
            this.view = 'folders'
            this.currentFolder = null
            this.currentFile   = null
            this._render()
            return
        }

        const folder = allFolders.find(f => f.path === folderPath)
        if (!folder) {
            this.view = 'folders'
            this._render()
            return
        }

        this.currentFolder = folder

        if (!fileId) {
            this.view = 'files'
            this._render()
            return
        }

        const file = folder.files.find(f => f.id === fileId)
        if (!file) {
            this.view = 'files'
            this._render()
            return
        }

        this._openFile(file)
    }

    // ── Top-level render dispatcher ───────────────────────────
    _render() {
        if (this.view === 'folders') this._renderFolders()
        else if (this.view === 'files') this._renderFiles()
        else if (this.view === 'editor') this._renderEditor()
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
                <div class="sidebar-list">${sidebarHtml || '<p class="sidebar-empty">No folders yet</p>'}</div>
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
                        <button class="app-logo-btn" id="go-home" title="Home">
                            <h1 class="app-title small" data-text="Thoughts">Thoughts</h1>
                        </button>
                        <nav class="breadcrumb" id="breadcrumb">${this._buildBreadcrumb()}</nav>
                    </div>
                    <div class="header-right">
                        <button class="header-icon-btn" id="graph-view-btn" title="Graph view (${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+G)">&#9672;</button>
                        <button class="header-icon-btn" id="cmd-palette-btn" title="Command palette (${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+P)">&#8984;</button>
                        <button class="sync-status-btn" id="sync-status-btn" title="Sync status">
                            <span class="sync-dot" id="sync-dot"></span>
                            <span class="sync-label" id="sync-label">Checking...</span>
                        </button>
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
                </header>
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

    _bindShell() {
        // Sync status indicator
        this._updateSyncUI(syncStatus.get())
        if (this._syncUnsub) this._syncUnsub()
        this._syncUnsub = syncStatus.onChange(s => this._updateSyncUI(s))

        const syncBtn = this.container.querySelector('#sync-status-btn')
        if (syncBtn) syncBtn.addEventListener('click', () => syncStatus.check())

        // Logout
        this.container.querySelector('#logout-btn').addEventListener('click', async () => {
            document.removeEventListener('keydown', this._escHandler)
            document.removeEventListener('keydown', this._globalKeyHandler)
            syncStatus.stopPolling()
            if (this._syncUnsub) this._syncUnsub()
            this._clearAutologoutTimer()
            if (this._autologoutActivityHandler) {
                const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
                events.forEach(ev => document.removeEventListener(ev, this._autologoutActivityHandler, true))
                this._autologoutActivityHandler = null
            }
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
            document.addEventListener('click', (e) => {
                if (!themeDropdown.contains(e.target) && e.target !== themeToggleBtn) {
                    themeDropdown.classList.remove('open')
                }
            })
            this.container.querySelectorAll('.theme-dropdown-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    this._applyTheme(btn.dataset.theme)
                    themeDropdown.classList.remove('open')
                    // Update toggle button appearance
                    const swatch = themeToggleBtn.querySelector('.theme-toggle-swatch')
                    const label = themeToggleBtn.querySelector('.theme-toggle-label')
                    if (swatch) swatch.setAttribute('data-theme', btn.dataset.theme)
                    if (label) label.textContent = THEMES.find(t => t.id === btn.dataset.theme)?.label || ''
                    // Update active state
                    this.container.querySelectorAll('.theme-dropdown-item').forEach(b => {
                        b.classList.toggle('active', b.dataset.theme === btn.dataset.theme)
                    })
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
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (!folder) return
                const file = folder.files.find(f => f.id === btn.dataset.fileId)
                if (file) {
                    this.currentFolder = folder
                    this._openFile(file)
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
            sidebarList.innerHTML = this._buildSidebarTree(null, 0) || '<p class="sidebar-empty">No folders yet</p>'
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
                    if (this.editorDirty) {
                        const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                        if (!ok) return
                    }
                    this.editorDirty = false
                    const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                    if (!folder) return
                    const file = folder.files.find(f => f.id === btn.dataset.fileId)
                    if (file) {
                        this.currentFolder = folder
                        this._openFile(file)
                    }
                })
            })
            // Re-bind sidebar drag-and-drop after re-render
            this._bindSidebarDragDrop()
        }
    }

    // ── Folders view (root level) ──────────────────────────────
    _renderFolders() {
        pushHash(null, null)
        const folders = foldersAPI.listRoots()
        this._paintFolders(folders)
        const doSync = () => foldersAPI.listFromCloud()
            .then(() => { if (this.view === 'folders') this._paintFolders(foldersAPI.listRoots()) })
        doSync().catch(() => setTimeout(() => doSync().catch(() => {}), 5000))
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
                        <button class="icon-btn move-item-btn" data-id="${f.id}" data-type="folder" title="Move">mv</button>
                        <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename">rn</button>
                        <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete">x</button>
                    </div>
                </div>
            `).join('')
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
            foldersAPI.rename(id, name)
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
        const msg = childCount
            ? `Delete "${folder.name}", all its subfolders, and all files?`
            : `Delete "${folder.name}" and all its files?`
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
        pushHash(this.currentFolder.path, null)
        this._paintFiles()
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
                    <button class="icon-btn move-item-btn" data-id="${f.id}" data-type="folder" title="Move">mv</button>
                    <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename">rn</button>
                    <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete">x</button>
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
                    <button class="icon-btn move-item-btn" data-id="${f.id}" data-type="file" title="Move">mv</button>
                    <button class="icon-btn rename-file-btn" data-id="${f.id}" title="Rename">rn</button>
                    <button class="icon-btn delete-file-btn" data-id="${f.id}" title="Delete">x</button>
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

        // Drag-and-drop
        this._bindFolderDragDrop(fileList, folder.id)

        // Allow dropping files onto folder cards to move them
        this.container.querySelectorAll('.subfolder-card').forEach(card => {
            card.addEventListener('dragover', (e) => {
                // If dragging a file over a folder, allow drop
                if (e.dataTransfer.types.includes('application/file-id')) {
                    e.preventDefault()
                    card.classList.add('drag-target-over')
                }
            })
            card.addEventListener('dragleave', () => {
                card.classList.remove('drag-target-over')
            })
            card.addEventListener('drop', async (e) => {
                card.classList.remove('drag-target-over')
                const fileId = e.dataTransfer.getData('application/file-id')
                if (!fileId) return
                e.preventDefault()
                const targetFolderId = card.dataset.id
                try {
                    await filesAPI.move(folder.id, fileId, targetFolderId)
                    this.currentFolder = foldersAPI.list().find(f => f.id === folder.id)
                    this._render()
                } catch (err) {
                    this._toast(`Move error: ${err.message}`)
                }
            })
        })
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
                <div class="move-menu-box">
                    <div class="move-menu-title">${title}</div>
                    <input type="text" class="move-menu-search" placeholder="Search folders...">
                    <div class="move-menu-list">${rootOption}${folderItems}</div>
                    <div class="move-menu-actions">
                        <button class="modal-btn modal-cancel">CANCEL</button>
                    </div>
                </div>
            `
            document.body.appendChild(overlay)

            const searchInput = overlay.querySelector('.move-menu-search')
            const listEl = overlay.querySelector('.move-menu-list')

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
                    overlay.remove()
                    const id = btn.dataset.id
                    resolve(id === '__root__' ? null : id)
                })
            })

            overlay.querySelector('.modal-cancel').addEventListener('click', () => {
                overlay.remove()
                resolve(undefined)
            })

            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { overlay.remove(); resolve(undefined) }
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
        const ok = await this._showModal({ type: 'confirm', title: 'DELETE FILE', message: `Delete "${file.title}"?` })
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
    _openFile(file) {
        this.currentFile = file
        this.view = 'editor'
        this.editorDirty = false
        pushHash(this.currentFolder.path, file.id)
        // Track in recent files
        this._addRecent(this.currentFolder.id, file.id, file.title)

        // If content is already loaded (cached), render editor immediately
        if (file.contentLoaded && file.content) {
            this._renderEditor()
            // Still refresh from cloud in background for freshness
            filesAPI.loadContent(this.currentFolder.id, file.id)
                .then(loaded => {
                    // Only update if content actually changed and we're still viewing the same file
                    if (loaded.content !== this.currentFile.content && this.view === 'editor' && this.currentFile.id === file.id) {
                        this.currentFile = loaded
                        const contentArea = this.container.querySelector('#file-content')
                        const preview = this.container.querySelector('#editor-preview')
                        if (contentArea && !this.editorDirty) {
                            contentArea.value = loaded.content || ''
                            if (preview) this._renderPreview(preview, contentArea.value)
                        }
                    }
                })
                .catch(() => {})
        } else {
            this.container.innerHTML = this._shell(this._loading('Loading file...'))
            this._bindShell()

            filesAPI.loadContent(this.currentFolder.id, file.id)
                .then(loaded => {
                    if (this.view === 'editor' && this.currentFile.id === file.id) {
                        this.currentFile = loaded
                        this._renderEditor()
                    }
                })
                .catch(err => this._toast(`Load error: ${err.message}`))
        }
    }

    // ── Editor view ───────────────────────────────────────────
    _renderEditor() {
        const file = this.currentFile
        const folder = this.currentFolder
        const mode = this._isMobile() ? 'edit' : this.editorMode
        const autosaveChecked = this.autosave ? 'checked' : ''

        const modeButtons = `
            <div class="mode-toggle" id="mode-toggle">
                ${!this._isMobile() ? `
                <button class="mode-btn ${mode === 'split' ? 'active' : ''}" data-mode="split" title="Split view">Split</button>
                ` : ''}
                <button class="mode-btn ${mode === 'edit' ? 'active' : ''}" data-mode="edit" title="Edit only">Edit</button>
                <button class="mode-btn ${mode === 'preview' ? 'active' : ''}" data-mode="preview" title="Preview only">Preview</button>
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
                        value="${this._esc(file.title)}"
                        placeholder="File title..."
                    />
                    <div class="editor-actions">
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
                    </div>
                </div>
                <div class="format-toolbar" id="format-toolbar">
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
                </div>
                <div class="editor-body">
                    <div class="editor-pane">
                        <textarea
                            id="file-content"
                            class="cyber-textarea editor-textarea"
                            placeholder="Start writing..."
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
                    <input type="text" class="find-input" id="find-input" placeholder="Find..." />
                    <span class="find-count" id="find-count">0/0</span>
                    <button class="find-nav-btn" id="find-prev" title="Previous">&uarr;</button>
                    <button class="find-nav-btn" id="find-next" title="Next">&darr;</button>
                    <button class="find-nav-btn" id="find-toggle-replace" title="Toggle replace">&#8597;</button>
                    <button class="find-close-btn" id="find-close">&times;</button>
                </div>
                <div class="find-replace-row replace-row hidden" id="replace-row">
                    <input type="text" class="find-input" id="replace-input" placeholder="Replace..." />
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

        contentArea.value = file.content || ''
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

        let previewTimer = null
        titleInput.addEventListener('input', markDirty)
        contentArea.addEventListener('input', () => {
            markDirty()
            updateStats()
            clearTimeout(previewTimer)
            previewTimer = setTimeout(() => this._renderPreview(preview, contentArea.value), 100)
            // Schedule autosave
            if (this.autosave) {
                clearTimeout(this._autosaveTimer)
                this._autosaveTimer = setTimeout(() => doSave(), 2000)
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
            if (this._saving) return  // prevent concurrent saves
            this._saving = true
            saveBtn.disabled = true
            saveBtn.querySelector('.btn-text').textContent = 'Saving...'
            saveStatus.textContent = 'saving...'
            saveStatus.className = 'save-status unsaved'

            // Show saving overlay to prevent accidental navigation
            this._showSavingOverlay()

            filesAPI.update(folder.id, file.id, {
                title: titleInput.value,
                content: contentArea.value,
            })
                .then(updated => {
                    this.currentFile = updated
                    this.editorDirty = false
                    saveStatus.textContent = 'saved'
                    saveStatus.className = 'save-status saved'
                    setTimeout(() => { if (!this.editorDirty) saveStatus.textContent = '' }, 2000)
                })
                .catch(err => this._toast(`Save error: ${err.message}`))
                .finally(() => {
                    this._saving = false
                    saveBtn.disabled = false
                    saveBtn.querySelector('.btn-text').textContent = 'Save'
                    this._hideSavingOverlay()
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
        this.container.querySelectorAll('.fmt-btn').forEach(btn => {
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault()  // prevent textarea blur
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

        switch (fmt) {
            case 'bold':
                replacement = `**${selected || 'bold text'}**`
                cursorOffset = selected ? replacement.length : 2
                break
            case 'italic':
                replacement = `*${selected || 'italic text'}*`
                cursorOffset = selected ? replacement.length : 1
                break
            case 'strikethrough':
                replacement = `~~${selected || 'strikethrough'}~~`
                cursorOffset = selected ? replacement.length : 2
                break
            case 'h1':
                replacement = this._prependLine('# ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'h2':
                replacement = this._prependLine('## ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'h3':
                replacement = this._prependLine('### ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'code':
                replacement = `\`${selected || 'code'}\``
                cursorOffset = selected ? replacement.length : 1
                break
            case 'codeblock':
                replacement = `\n\`\`\`\n${selected || 'code here'}\n\`\`\`\n`
                cursorOffset = selected ? replacement.length : 5
                break
            case 'quote':
                replacement = this._prependLine('> ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'ul':
                replacement = this._prependLine('- ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'ol':
                replacement = this._prependLine('1. ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'task':
                replacement = this._prependLine('- [ ] ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'link':
                replacement = `[${selected || 'link text'}](url)`
                cursorOffset = selected ? replacement.length - 4 : 1
                break
            case 'image':
                replacement = `![${selected || 'alt text'}](url)`
                cursorOffset = selected ? replacement.length - 4 : 2
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
                cursorOffset = selected ? replacement.length : 2
                break
            case 'tag':
                replacement = `#${selected || 'tag'}`
                cursorOffset = replacement.length
                break
            case 'callout':
                replacement = this._prependLine('> [!note] ', start, val, selected)
                textarea.value = replacement.val
                textarea.setSelectionRange(replacement.cursor, replacement.cursor)
                textarea.dispatchEvent(new Event('input'))
                textarea.focus()
                return
            case 'highlight':
                replacement = `==${selected || 'highlighted text'}==`
                cursorOffset = selected ? replacement.length : 2
                break
            case 'footnote':
                replacement = `[^${selected || '1'}]`
                cursorOffset = replacement.length
                break
            default:
                return
        }

        textarea.value = val.slice(0, start) + replacement + val.slice(end)
        textarea.setSelectionRange(start + cursorOffset, start + cursorOffset)
        textarea.dispatchEvent(new Event('input'))
        textarea.focus()
    }

    _prependLine(prefix, cursorPos, val, selected) {
        const lineStart = val.lastIndexOf('\n', cursorPos - 1) + 1
        const lineEnd = val.indexOf('\n', cursorPos)
        const endIdx = lineEnd === -1 ? val.length : lineEnd
        const currentLine = val.slice(lineStart, endIdx)

        // If line already has the prefix, remove it
        if (currentLine.startsWith(prefix)) {
            const newVal = val.slice(0, lineStart) + currentLine.slice(prefix.length) + val.slice(endIdx)
            return { val: newVal, cursor: cursorPos - prefix.length }
        }

        // Strip any existing heading/list prefix before adding new one
        const stripped = currentLine.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|- \[[ xX]\]\s+|>\s+)/, '')
        const newLine = prefix + stripped
        const newVal = val.slice(0, lineStart) + newLine + val.slice(endIdx)
        return { val: newVal, cursor: lineStart + newLine.length }
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

        const highlightMatch = () => {
            if (currentMatch < 0 || currentMatch >= matches.length) return
            const pos = matches[currentMatch]
            const len = findInput.value.length
            textarea.focus()
            textarea.setSelectionRange(pos, pos + len)
            // Scroll into view
            const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24
            const textBefore = textarea.value.slice(0, pos)
            const lineNum = textBefore.split('\n').length - 1
            textarea.scrollTop = lineNum * lineHeight - textarea.clientHeight / 2
            findCount.textContent = `${currentMatch + 1}/${matches.length}`
        }

        // Open find bar with Cmd/Ctrl+F
        const openFind = (e) => {
            if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                bar.classList.remove('hidden')
                findInput.focus()
                const sel = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
                if (sel) { findInput.value = sel; doFind() }
            }
        }
        textarea.addEventListener('keydown', openFind)

        findInput.addEventListener('input', doFind)
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) { currentMatch = (currentMatch - 1 + matches.length) % matches.length }
                else { currentMatch = (currentMatch + 1) % matches.length }
                highlightMatch()
            }
            if (e.key === 'Escape') { bar.classList.add('hidden'); textarea.focus() }
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
            const len = findInput.value.length
            const rep = replaceInput.value
            textarea.value = textarea.value.slice(0, pos) + rep + textarea.value.slice(pos + len)
            textarea.dispatchEvent(new Event('input'))
            markDirty()
            this._renderPreview(preview, textarea.value)
            doFind()
        })
        this.container.querySelector('#replace-all').addEventListener('click', () => {
            if (!findInput.value) return
            const query = findInput.value
            const rep = replaceInput.value
            // Case-insensitive replace all
            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
            textarea.value = textarea.value.replace(regex, rep)
            textarea.dispatchEvent(new Event('input'))
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
        const close = () => overlay.remove()
        overlay.querySelector('.modal-confirm').addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
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
            this._render()
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

        const close = () => overlay.remove()
        overlay.querySelector('.modal-confirm').addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
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
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

        overlay.querySelectorAll('.heading-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const h = headings[parseInt(btn.dataset.idx)]
                let pos = 0
                for (let i = 0; i < h.lineIndex; i++) pos += lines[i].length + 1
                textarea.focus()
                textarea.setSelectionRange(pos, pos)
                const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24
                textarea.scrollTop = h.lineIndex * lineHeight - textarea.clientHeight / 3
                close()
            })
        })

        overlay.setAttribute('tabindex', '-1')
        overlay.focus()
    }

    // ── Obsidian-style editor keydown behaviors ────────────────
    _handleEditorKeydown(e, textarea) {
        const val = textarea.value
        const start = textarea.selectionStart
        const end = textarea.selectionEnd

        if (e.key === 'Enter') {
            const lineStart = val.lastIndexOf('\n', start - 1) + 1
            const currentLine = val.slice(lineStart, start)

            // Match list prefixes: -, *, +, numbers, or task lists
            const listMatch = currentLine.match(/^(\s*)([-*+]|\d+[.)]) (\[[ xX]\] )?/)
            if (listMatch) {
                const indent = listMatch[1]
                const bullet = listMatch[2]
                const taskPart = listMatch[3] || ''
                const lineContent = currentLine.slice(listMatch[0].length)

                // If line is empty (just the bullet), remove the bullet and dedent / exit list
                if (!lineContent.trim()) {
                    e.preventDefault()
                    if (indent.length >= 2) {
                        // Dedent one level instead of exiting
                        const newIndent = indent.slice(2)
                        const newLine = newIndent + bullet + ' ' + (taskPart || '')
                        const newVal = val.slice(0, lineStart) + newLine + val.slice(start)
                        const newPos = lineStart + newLine.length
                        textarea.value = newVal
                        textarea.setSelectionRange(newPos, newPos)
                    } else {
                        // Exit list — remove bullet, leave blank line
                        const newVal = val.slice(0, lineStart) + '\n' + val.slice(start)
                        textarea.value = newVal
                        textarea.setSelectionRange(lineStart + 1, lineStart + 1)
                    }
                    textarea.dispatchEvent(new Event('input'))
                    return
                }

                // If cursor is at the very start of the line content (right after bullet),
                // pressing Enter pushes current bullet content down and leaves blank first bullet
                if (start === lineStart + listMatch[0].length - (lineContent.length > 0 ? lineContent.length : 0)) {
                    // cursor is at the beginning of text after bullet
                    // handled normally — fall through to continue-list
                }

                // If cursor is at the beginning of the line (before bullet content),
                // split: first bullet stays with text from cursor onward, new bullet above has no content
                // This is the standard "Enter pushes content down" behavior which the continue-list handles
                e.preventDefault()
                // Continue the list
                let nextBullet = bullet
                if (/^\d+[.)]$/.test(bullet)) {
                    nextBullet = (parseInt(bullet) + 1) + bullet.slice(-1)
                }
                const nextTask = taskPart ? '[ ] ' : ''
                const insertion = '\n' + indent + nextBullet + ' ' + nextTask
                const newVal = val.slice(0, start) + insertion + val.slice(end)
                textarea.value = newVal
                const newPos = start + insertion.length
                textarea.setSelectionRange(newPos, newPos)
                textarea.dispatchEvent(new Event('input'))
                return
            }

            // Blockquote continuation
            const blockquoteMatch = currentLine.match(/^(\s*> )/)
            if (blockquoteMatch) {
                const lineContent = currentLine.slice(blockquoteMatch[0].length)
                if (!lineContent.trim()) {
                    e.preventDefault()
                    const newVal = val.slice(0, lineStart) + '\n' + val.slice(start)
                    textarea.value = newVal
                    textarea.setSelectionRange(lineStart + 1, lineStart + 1)
                    textarea.dispatchEvent(new Event('input'))
                    return
                }
                e.preventDefault()
                const insertion = '\n' + blockquoteMatch[0]
                const newVal = val.slice(0, start) + insertion + val.slice(end)
                textarea.value = newVal
                const newPos = start + insertion.length
                textarea.setSelectionRange(newPos, newPos)
                textarea.dispatchEvent(new Event('input'))
                return
            }
        }

        // Tab key: indent/dedent list items, or insert spaces
        if (e.key === 'Tab') {
            e.preventDefault()
            const lineStart = val.lastIndexOf('\n', start - 1) + 1
            const lineEnd = val.indexOf('\n', start) === -1 ? val.length : val.indexOf('\n', start)
            const currentLine = val.slice(lineStart, lineEnd)
            const listItemMatch = currentLine.match(/^(\s*)([-*+]|\d+[.)]) /)

            if (listItemMatch) {
                const currentIndent = listItemMatch[1]
                if (e.shiftKey) {
                    // Dedent: remove 2 spaces from start (one indent level)
                    if (currentIndent.length < 2) return  // already at root level
                    const dedented = currentLine.slice(2)
                    const removed = 2
                    const newVal = val.slice(0, lineStart) + dedented + val.slice(lineEnd)
                    textarea.value = newVal
                    textarea.setSelectionRange(Math.max(lineStart, start - removed), Math.max(lineStart, start - removed))
                    textarea.dispatchEvent(new Event('input'))
                } else {
                    // Indent: prepend 2 spaces (one level deeper)
                    const newVal = val.slice(0, lineStart) + '  ' + currentLine + val.slice(lineEnd)
                    textarea.value = newVal
                    textarea.setSelectionRange(start + 2, start + 2)
                    textarea.dispatchEvent(new Event('input'))
                }
            } else {
                // Regular tab: insert 2 spaces or shift-tab dedents
                if (e.shiftKey) {
                    const dedented = currentLine.replace(/^  /, '')
                    if (dedented !== currentLine) {
                        const removed = currentLine.length - dedented.length
                        const newVal = val.slice(0, lineStart) + dedented + val.slice(lineEnd)
                        textarea.value = newVal
                        textarea.setSelectionRange(Math.max(lineStart, start - removed), Math.max(lineStart, start - removed))
                        textarea.dispatchEvent(new Event('input'))
                    }
                } else {
                    const insertion = '  '
                    const newVal = val.slice(0, start) + insertion + val.slice(end)
                    textarea.value = newVal
                    textarea.setSelectionRange(start + 2, start + 2)
                    textarea.dispatchEvent(new Event('input'))
                }
            }
            return
        }

        // Auto-close markdown pairs: **, __, ~~, ==, ``
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const pairs = { '`': '`', '*': '*', '_': '_', '~': '~', '=': '=' }
            if (e.key in pairs && start !== end) {
                // Wrap selection
                e.preventDefault()
                const selected = val.slice(start, end)
                const wrapped = e.key + selected + pairs[e.key]
                textarea.value = val.slice(0, start) + wrapped + val.slice(end)
                textarea.setSelectionRange(start + 1, end + 1)
                textarea.dispatchEvent(new Event('input'))
                return
            }
        }
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
            const newVal = textarea.value.slice(0, start) + replacement + textarea.value.slice(end)
            textarea.value = newVal
            textarea.setSelectionRange(start + replacement.length, start + replacement.length)
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
        document.addEventListener('mousedown', (e) => {
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
            const newVal = textarea.value.slice(0, start) + link + textarea.value.slice(end)
            textarea.value = newVal
            textarea.setSelectionRange(start + link.length, start + link.length)
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
            const after = val.slice(pos)
            const closeBracketIdx = after.indexOf(']]')
            const endPos = closeBracketIdx !== -1 ? pos + closeBracketIdx + 2 : pos
            const replacement = `[[${file.title}]]`
            textarea.value = val.slice(0, openBracket) + replacement + val.slice(endPos)
            const newPos = openBracket + replacement.length
            textarea.setSelectionRange(newPos, newPos)
            textarea.dispatchEvent(new Event('input'))
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
            else if (e.key === 'Escape') { e.preventDefault(); close() }
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
        const isChecked = !checkbox.checked  // it was prevented, so state is pre-click
        const taskItem = checkbox.closest('.task-list-item') || checkbox.parentElement
        // Get the text content to find it in the editor
        const itemText = taskItem.textContent.trim().replace(/^[\s✓x✗]*/, '').trim()

        const val = textarea.value
        // Find the matching task in the markdown
        // Pattern: - [ ] or - [x] followed by the text
        const lines = val.split('\n')
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            const taskMatch = line.match(/^(\s*[-*+] \[)([ xX])(\] )(.*)$/)
            if (taskMatch) {
                const lineText = taskMatch[4].trim()
                if (itemText.includes(lineText) || lineText.includes(itemText.slice(0, 30))) {
                    const currentlyChecked = taskMatch[2].toLowerCase() === 'x'
                    // Toggle
                    lines[i] = taskMatch[1] + (currentlyChecked ? ' ' : 'x') + taskMatch[3] + taskMatch[4]
                    textarea.value = lines.join('\n')
                    textarea.dispatchEvent(new Event('input'))
                    break
                }
            }
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
        const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24
        textarea.scrollTop = bestLine * lineHeight - textarea.clientHeight / 2
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
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'cyberpunk'
        // Get computed styles for the preview
        const previewStyle = getComputedStyle(previewEl)

        printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${this._esc(title)}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
    <style>
        body {
            font-family: ${previewStyle.fontFamily};
            font-size: 14px;
            line-height: 1.8;
            color: #000;
            background: #fff;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px;
        }
        h1, h2, h3, h4, h5, h6 { color: #111; margin: 1.5rem 0 0.75rem; }
        h2 { border-bottom: 1px solid #ccc; padding-bottom: 0.4rem; }
        p { margin: 0.75rem 0; }
        strong { font-weight: bold; }
        em { font-style: italic; }
        a { color: #1a73e8; }
        code { background: #f5f5f5; padding: 0.1em 0.4em; font-family: 'Courier New', monospace; font-size: 0.9em; border: 1px solid #ddd; border-radius: 3px; }
        pre { background: #f5f5f5; border: 1px solid #ddd; padding: 1rem; overflow-x: auto; }
        pre code { background: none; border: none; padding: 0; }
        blockquote { border-left: 3px solid #999; padding-left: 1rem; color: #555; margin: 1rem 0; }
        ul, ol { padding-left: 1.5rem; margin: 0.75rem 0; }
        li { margin: 0.3rem 0; }
        hr { border: none; border-top: 1px solid #ccc; margin: 1.5rem 0; }
        table { border-collapse: collapse; width: 100%; }
        th { background: #f5f5f5; padding: 0.5rem 0.75rem; border: 1px solid #ddd; text-align: left; }
        td { padding: 0.5rem 0.75rem; border: 1px solid #ddd; }
        .task-list-item { list-style: none; }
        .task-list-item input[type="checkbox"] { margin-right: 0.4em; }
        h1.pdf-title { font-size: 2rem; border-bottom: 2px solid #333; padding-bottom: 0.5rem; margin-bottom: 2rem; }
        @media print { body { padding: 20px; } }
    </style>
</head>
<body>
    <h1 class="pdf-title">${this._esc(title)}</h1>
    ${previewEl.innerHTML}
    <script>window.onload = function() { window.print(); }<\/script>
</body>
</html>
        `)
        printWindow.document.close()
    }

    // ── Wikilink helpers ────────────────────────────────────────
    _getAllFiles() {
        const allFolders = foldersAPI.list()
        const files = []
        for (const f of allFolders) {
            for (const file of f.files) {
                files.push({ ...file, folderId: f.id, folderName: f.name, folderPath: f.path })
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
            ...THEMES.map(t => ({ name: `Theme: ${t.label}`, action: () => { this._applyTheme(t.id); this._render() } })),
            { name: 'Log Out', action: async () => { await auth.logout(); this.onLogout() } },
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
        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') { close(); return }
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
        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') { close(); return }
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
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
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
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') cleanClose() })
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
                const h = headings[parseInt(btn.dataset.idx)]
                let pos = 0
                for (let i = 0; i < h.lineIndex; i++) pos += lines[i].length + 1
                textarea.focus()
                textarea.setSelectionRange(pos, pos)
                const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24
                textarea.scrollTop = h.lineIndex * lineHeight - textarea.clientHeight / 3
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
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                this.currentFolder = folder
                this._openFile(file)
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

    // ── Render preview with source line tracking ──────────────
    _renderPreview(previewEl, markdown) {
        let normalised = this._normaliseMath(markdown || '')
        normalised = this._preprocessMarkdown(normalised)

        if (typeof marked !== 'undefined') {
            previewEl.innerHTML = marked.parse(normalised)
        } else {
            previewEl.textContent = normalised
        }

        // Make checkboxes interactive (GFM task lists)
        previewEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.removeAttribute('disabled')
            cb.style.cursor = 'pointer'
        })

        // Style inline code with extra LaTeX-like monospace emphasis
        previewEl.querySelectorAll('code:not(pre code)').forEach(el => {
            el.classList.add('inline-code-tt')
        })

        // Syntax highlighting with highlight.js
        if (typeof hljs !== 'undefined') {
            previewEl.querySelectorAll('pre code').forEach(block => {
                // Check for mermaid blocks
                if (block.className.includes('language-mermaid') || block.textContent.trim().startsWith('graph ') || block.textContent.trim().startsWith('sequenceDiagram') || block.textContent.trim().startsWith('flowchart')) {
                    const mermaidDiv = document.createElement('div')
                    mermaidDiv.className = 'mermaid'
                    mermaidDiv.textContent = block.textContent
                    block.closest('pre').replaceWith(mermaidDiv)
                    return
                }
                hljs.highlightElement(block)
            })
        }

        // Render mermaid diagrams
        if (typeof mermaid !== 'undefined') {
            try {
                mermaid.initialize({ startOnLoad: false, theme: 'dark' })
                mermaid.run({ nodes: previewEl.querySelectorAll('.mermaid') })
            } catch { /* mermaid parse errors are non-fatal */ }
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
                    let content = file.content || ''
                    if (!file.contentLoaded && file.path) {
                        content = await vaultAPI.readFile(file.path)
                    }
                    const embedHtml = typeof marked !== 'undefined' ? marked.parse(content) : content
                    block.innerHTML = `<div class="embed-content"><div class="embed-title">${this._esc(file.title)}</div>${embedHtml}</div>`
                } catch {
                    block.innerHTML = `<div class="embed-error">Could not load: ${this._esc(target)}</div>`
                }
            } else {
                block.innerHTML = `<div class="embed-error">Note not found: ${this._esc(target)}</div>`
            }
        })

        // Render math with KaTeX
        if (typeof renderMathInElement !== 'undefined') {
            renderMathInElement(previewEl, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$',  right: '$',  display: false },
                    { left: '\\[', right: '\\]', display: true },
                    { left: '\\(', right: '\\)', display: false },
                ],
                throwOnError: false,
                ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
            })
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
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
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
            btn.classList.toggle('active', btn.dataset.mode === mode)
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
        if (document.getElementById('saving-overlay')) return
        const el = document.createElement('div')
        el.id = 'saving-overlay'
        el.className = 'saving-indicator'
        el.innerHTML = '<span class="saving-label">Saving...</span>'
        document.body.appendChild(el)
        setTimeout(() => el.classList.add('visible'), 10)
    }

    _hideSavingOverlay() {
        const el = document.getElementById('saving-overlay')
        if (!el) return
        el.classList.remove('visible')
        setTimeout(() => el.remove(), 200)
    }

    // ── Progress toast ────────────────────────────────────────
    _showProgressToast(action, total) {
        const existing = document.getElementById('progress-toast')
        if (existing) existing.remove()

        const toast = document.createElement('div')
        toast.id = 'progress-toast'
        toast.className = 'progress-toast'
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
    _showModal({ type = 'confirm', title = '', message = '', placeholder = '', defaultValue = '' } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div')
            overlay.className = 'modal-overlay'

            if (type === 'input') {
                overlay.innerHTML = `
                    <div class="modal-box">
                        <div class="modal-title">${title}</div>
                        <input class="modal-input" type="text" placeholder="${placeholder}" value="${this._esc(defaultValue)}" />
                        <div class="modal-actions">
                            <button class="modal-btn modal-cancel">CANCEL</button>
                            <button class="modal-btn modal-confirm">OK</button>
                        </div>
                    </div>`
                document.body.appendChild(overlay)
                const input = overlay.querySelector('.modal-input')
                input.focus(); input.select()
                const confirm = () => { const v = input.value.trim(); overlay.remove(); resolve(v || null) }
                const cancel  = () => { overlay.remove(); resolve(null) }
                overlay.querySelector('.modal-confirm').addEventListener('click', confirm)
                overlay.querySelector('.modal-cancel').addEventListener('click', cancel)
                overlay.addEventListener('click', e => { if (e.target === overlay) cancel() })
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') confirm()
                    if (e.key === 'Escape') cancel()
                })
            } else {
                overlay.innerHTML = `
                    <div class="modal-box">
                        <div class="modal-title">${title}</div>
                        ${message ? `<div class="modal-message">${message}</div>` : ''}
                        <div class="modal-actions">
                            <button class="modal-btn modal-cancel">CANCEL</button>
                            <button class="modal-btn modal-confirm danger">OK</button>
                        </div>
                    </div>`
                document.body.appendChild(overlay)
                const yes = () => { overlay.remove(); resolve(true) }
                const no  = () => { overlay.remove(); resolve(false) }
                overlay.querySelector('.modal-confirm').addEventListener('click', yes)
                overlay.querySelector('.modal-cancel').addEventListener('click', no)
                overlay.addEventListener('click', e => { if (e.target === overlay) no() })
                overlay.setAttribute('tabindex', '-1')
                overlay.focus()
                overlay.addEventListener('keydown', e => {
                    if (e.key === 'Enter') yes()
                    if (e.key === 'Escape') no()
                })
            }
        })
    }

    _toast(message) {
        const toast = document.createElement('div')
        toast.className = 'cyber-toast'
        toast.textContent = message
        document.body.appendChild(toast)
        setTimeout(() => toast.classList.add('visible'), 10)
        setTimeout(() => {
            toast.classList.remove('visible')
            setTimeout(() => toast.remove(), 300)
        }, 4000)
    }

    _esc(text) {
        if (!text) return ''
        const div = document.createElement('div')
        div.textContent = text
        return div.innerHTML
    }

    _relTime(iso) {
        const diff = Date.now() - new Date(iso).getTime()
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

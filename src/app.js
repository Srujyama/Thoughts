// src/app.js
import { foldersAPI, filesAPI, auth } from './api.js'

const EDITOR_MODE_KEY  = 'nc_editor_mode'
const THEME_KEY        = 'nc_theme'
const AUTOSAVE_KEY     = 'nc_autosave'
const SIDEBAR_OPEN_KEY = 'nc_sidebar_open'

const THEMES = [
    { id: 'system',     label: 'System' },
    { id: 'light',      label: 'Light' },
    { id: 'dark',       label: 'Dark' },
    { id: 'cyberpunk',  label: 'Cyberpunk' },
    { id: 'docs',       label: 'Docs' },
    { id: 'typewriter', label: 'Typewriter' },
    { id: 'nord',       label: 'Nord' },
    { id: 'solarized',  label: 'Solarized' },
]

// ── System theme media query watcher ──────────────────────────
let _systemThemeListener = null

function _resolveSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
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
        this.editorMode = this._isMobile()
            ? 'edit'
            : (localStorage.getItem(EDITOR_MODE_KEY) || 'split')
        this.autosave = localStorage.getItem(AUTOSAVE_KEY) === 'true'
        this._autosaveTimer = null
        // Track which sidebar folders are collapsed (set of folder ids)
        this._collapsedFolders = new Set(JSON.parse(localStorage.getItem(SIDEBAR_OPEN_KEY) || '[]'))

        // Apply saved theme (default: system)
        const savedTheme = localStorage.getItem(THEME_KEY) || 'system'
        this._applyTheme(savedTheme)

        this._restoreFromHash()
        window.addEventListener('popstate', () => this._restoreFromHash())

        this._escHandler = async (e) => {
            if (e.key === 'Escape') {
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
    }

    // ── Theme ─────────────────────────────────────────────────
    _applyTheme(themeId) {
        const valid = THEMES.find(t => t.id === themeId)
        if (!valid) return

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
        } else if (themeId === 'light') {
            document.documentElement.setAttribute('data-theme', 'docs')
        } else if (themeId === 'dark') {
            document.documentElement.setAttribute('data-theme', 'nord')
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
        const swatches = THEMES.map(t => `
            <button
                class="theme-swatch ${t.id === currentTheme ? 'active' : ''}"
                data-theme="${t.id}"
                title="${t.label}"
                aria-label="Switch to ${t.label} theme"
            ></button>
        `).join('')

        const sidebarHtml = this._buildSidebarTree(null, 0)

        const sidebarEl = sidebar ? `
            <nav class="app-sidebar" id="app-sidebar">
                <div class="sidebar-header">
                    <span class="sidebar-title">FOLDERS</span>
                    <button class="sidebar-new-btn" id="sidebar-new-folder" title="New folder">+</button>
                </div>
                <div class="sidebar-list">${sidebarHtml || '<p class="sidebar-empty">No folders yet</p>'}</div>
            </nav>
        ` : ''

        return `
            <div class="app-shell">
                <header class="app-header">
                    <div class="header-left">
                        <button class="app-logo-btn" id="go-home" title="Home">
                            <h1 class="glitch-text small" data-text="THOUGHTS.EXE">THOUGHTS.EXE</h1>
                        </button>
                        <nav class="breadcrumb" id="breadcrumb">${this._buildBreadcrumb()}</nav>
                    </div>
                    <div class="header-right">
                        <div class="theme-picker" id="theme-picker">${swatches}</div>
                        <button class="cyber-btn logout-btn" id="logout-btn">
                            <span class="btn-text">JACK OUT</span>
                            <span class="btn-glow"></span>
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
                ? f.files.map(file => `
                    <button class="sidebar-file-dot" data-folder-id="${f.id}" data-file-id="${file.id}"
                            title="${this._esc(file.title)}"
                            style="padding-left: calc(0.75rem + ${indent + 20}px)">
                        <span class="sidebar-dot-icon">·</span>
                        <span class="sidebar-dot-name">${this._esc(file.title)}</span>
                    </button>
                `).join('')
                : ''

            const chevron = hasChildren
                ? `<span class="sidebar-chevron ${isCollapsed ? 'collapsed' : ''}">${isCollapsed ? '▶' : '▼'}</span>`
                : `<span class="sidebar-chevron-spacer"></span>`

            return `
                <div class="sidebar-folder-group">
                    <button class="sidebar-folder ${isActive ? 'active' : ''}"
                            data-folder-id="${f.id}"
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

    _loading(message = 'LOADING...') {
        return `<div class="empty-state"><p class="blink">> ${message}_</p></div>`
    }

    _bindShell() {
        // Logout
        this.container.querySelector('#logout-btn').addEventListener('click', async () => {
            document.removeEventListener('keydown', this._escHandler)
            await auth.logout()
            this.onLogout()
        })

        // Home logo
        this.container.querySelector('#go-home').addEventListener('click', async () => {
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
                if (this.editorDirty) {
                    const ok = await this._showModal({ type: 'confirm', title: 'UNSAVED CHANGES', message: 'Leave without saving?' })
                    if (!ok) return
                }
                this.editorDirty = false
                const folder = foldersAPI.list().find(f => f.id === btn.dataset.folderId)
                if (folder) this._navigate('files', { folder })
            })
        })

        // Theme picker
        this.container.querySelectorAll('.theme-swatch').forEach(btn => {
            btn.addEventListener('click', () => {
                this._applyTheme(btn.dataset.theme)
                this.container.querySelectorAll('.theme-swatch').forEach(b => {
                    b.classList.toggle('active', b.dataset.theme === btn.dataset.theme)
                })
            })
        })

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

        // Sidebar new root folder button
        const sidebarNewBtn = this.container.querySelector('#sidebar-new-folder')
        if (sidebarNewBtn) {
            sidebarNewBtn.addEventListener('click', () => this._promptNewFolder(null))
        }
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
                <div class="folder-card" data-id="${f.id}">
                    <div class="folder-icon">▶</div>
                    <div class="folder-info">
                        <span class="folder-name">${this._esc(f.name)}</span>
                        <span class="folder-meta">${f.files.length} file${f.files.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="folder-actions">
                        <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename">rn</button>
                        <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete">x</button>
                    </div>
                </div>
            `).join('')
            : `<div class="empty-state">
                <p class="blink">> NO FOLDERS FOUND_</p>
                <p class="empty-sub">// CREATE A FOLDER TO BEGIN</p>
               </div>`

        const body = `
            <div class="toolbar">
                <span class="section-label">// FOLDERS</span>
                <button class="cyber-btn compact-btn" id="new-folder-btn">
                    <span class="btn-text">+ NEW FOLDER</span>
                    <span class="btn-glow"></span>
                </button>
            </div>
            <div class="folder-grid" id="folder-grid">${folderCards}</div>
        `

        this.container.innerHTML = this._shell(body)
        this._bindShell()

        this.container.querySelector('#new-folder-btn').addEventListener('click', () => {
            this._promptNewFolder(null)
        })

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
    }

    async _promptNewFolder(parentId) {
        const title = parentId ? 'NEW SUBFOLDER' : 'NEW FOLDER'
        const name = await this._showModal({ type: 'input', title, placeholder: 'Folder name...' })
        if (!name) return
        try {
            await foldersAPI.create(name, parentId)
            this._render()
        } catch (err) {
            this._toast(`> ERROR: ${err.message}`)
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
            this._toast(`> ERROR: ${err.message}`)
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

        if (total > 0) {
            this._showProgressToast('Deleting', total)
            foldersAPI.deleteWithProgress(id, (done, t) => {
                this._updateProgressToast('Deleting', done, t)
            })
                .then(() => {
                    this._hideProgressToast()
                    this._render()
                })
                .catch(err => {
                    this._hideProgressToast()
                    this._toast(`> DELETE ERROR: ${err.message}`)
                })
        } else {
            foldersAPI.delete(id)
                .then(() => { this._render() })
                .catch(err => this._toast(`> DELETE ERROR: ${err.message}`))
        }
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
            <div class="folder-card subfolder-card" data-id="${f.id}">
                <div class="folder-icon">▶</div>
                <div class="folder-info">
                    <span class="folder-name">${this._esc(f.name)}</span>
                    <span class="folder-meta">${f.files.length} file${f.files.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="folder-actions">
                    <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename">rn</button>
                    <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete">x</button>
                </div>
            </div>
        `).join('')

        const fileCards = files.map((f) => `
            <div class="file-card" data-id="${f.id}">
                <div class="file-icon">#</div>
                <div class="file-info">
                    <span class="file-title">${this._esc(f.title)}</span>
                    <span class="file-meta">// ${this._relTime(f.updated_at)}</span>
                </div>
                <div class="file-actions">
                    <button class="icon-btn delete-file-btn" data-id="${f.id}" title="Delete">x</button>
                </div>
            </div>
        `).join('')

        const isEmpty = !subfolders.length && !files.length
        const contentHtml = isEmpty
            ? `<div class="empty-state">
                <p class="blink">> EMPTY FOLDER_</p>
                <p class="empty-sub">// CREATE A FILE OR SUBFOLDER TO BEGIN</p>
               </div>`
            : (subfolderCards + fileCards)

        const body = `
            <div class="toolbar">
                <span class="section-label">// ${this._esc(folder.name).toUpperCase()}</span>
                <div class="toolbar-actions">
                    <button class="cyber-btn compact-btn" id="upload-folder-btn" title="Upload folder of .md files">
                        <span class="btn-text">↑ UPLOAD FOLDER</span>
                        <span class="btn-glow"></span>
                    </button>
                    <input type="file" id="folder-file-input" webkitdirectory multiple style="display:none">
                    <button class="cyber-btn compact-btn" id="upload-md-btn" title="Upload .md files">
                        <span class="btn-text">↑ UPLOAD .MD</span>
                        <span class="btn-glow"></span>
                    </button>
                    <input type="file" id="md-file-input" accept=".md,text/markdown" multiple style="display:none">
                    <button class="cyber-btn compact-btn" id="new-subfolder-btn">
                        <span class="btn-text">+ SUBFOLDER</span>
                        <span class="btn-glow"></span>
                    </button>
                    <button class="cyber-btn compact-btn" id="new-file-btn">
                        <span class="btn-text">+ NEW FILE</span>
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
                this._toast(`> UPLOAD ERROR: ${f.name}: ${err.message}`)
                this._updateProgressToast('Uploading', i + 1, total)
            }
        }

        this._hideProgressToast()
        if (succeeded) {
            this._toast(`> UPLOADED ${succeeded} FILE${succeeded > 1 ? 'S' : ''}`)
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
            this._toast('> NO .MD FILES FOUND IN FOLDER')
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
                this._toast(`> ERROR: ${f.name}: ${err.message}`)
                this._updateProgressToast('Uploading', i + 1, total)
            }
        }

        this._hideProgressToast()
        if (succeeded) {
            this._toast(`> UPLOADED ${succeeded} FILE${succeeded > 1 ? 'S' : ''}${errors ? `, ${errors} FAILED` : ''}`)
            this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
            this._render()
        }
        if (input.value !== undefined) input.value = ''
    }

    async _promptNewFile() {
        const title = await this._showModal({ type: 'input', title: 'NEW FILE', placeholder: 'File title...' })
        if (!title) return
        filesAPI.create(this.currentFolder.id, title)
            .then(file => this._openFile(file))
            .catch(err => this._toast(`> ERROR: ${err.message}`))
    }

    async _deleteFile(fileId) {
        const file = this.currentFolder.files.find((f) => f.id === fileId)
        if (!file) return
        const ok = await this._showModal({ type: 'confirm', title: 'DELETE FILE', message: `Delete "${file.title}"?` })
        if (!ok) return
        filesAPI.delete(this.currentFolder.id, fileId)
            .then(() => {
                this.currentFolder = foldersAPI.list().find((f) => f.id === this.currentFolder.id)
                if (this.view === 'files') this._render()
            })
            .catch(err => this._toast(`> DELETE ERROR: ${err.message}`))
    }

    // ── Open file ─────────────────────────────────────────────
    _openFile(file) {
        this.currentFile = file
        this.view = 'editor'
        this.editorDirty = false
        pushHash(this.currentFolder.path, file.id)

        this.container.innerHTML = this._shell(this._loading('LOADING FILE'))
        this._bindShell()

        filesAPI.loadContent(this.currentFolder.id, file.id)
            .then(loaded => {
                this.currentFile = loaded
                if (this.view === 'editor') this._renderEditor()
            })
            .catch(err => this._toast(`> LOAD ERROR: ${err.message}`))
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
                <button class="mode-btn ${mode === 'split' ? 'active' : ''}" data-mode="split" title="Split view">[ | ]</button>
                ` : ''}
                <button class="mode-btn ${mode === 'edit' ? 'active' : ''}" data-mode="edit" title="Edit only">[&nbsp;e&nbsp;]</button>
                <button class="mode-btn ${mode === 'preview' ? 'active' : ''}" data-mode="preview" title="Preview only">[&nbsp;p&nbsp;]</button>
            </div>
        `

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
                        <span class="save-status" id="save-status"></span>
                        <button class="cyber-btn compact-btn" id="save-btn">
                            <span class="btn-text">SAVE</span>
                            <span class="btn-glow"></span>
                        </button>
                    </div>
                </div>
                <div class="editor-body">
                    <div class="editor-pane">
                        <textarea
                            id="file-content"
                            class="cyber-textarea editor-textarea"
                            placeholder="> write your thoughts here_"
                        ></textarea>
                    </div>
                    <div class="editor-divider"></div>
                    <div class="preview-pane">
                        <div class="editor-preview" id="editor-preview"></div>
                    </div>
                </div>
                <div class="editor-footer">
                    <span class="char-count" id="char-count">${(file.content || '').length} chars</span>
                    <span class="editor-hint">ESC to go back</span>
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
        const preview     = this.container.querySelector('#editor-preview')
        const editorZone  = this.container.querySelector('#editor-zone')
        const autosaveChk = this.container.querySelector('#autosave-check')
        const pdfBtn      = this.container.querySelector('#pdf-btn')

        contentArea.value = file.content || ''
        this._renderPreview(preview, contentArea.value)

        // Autosave toggle
        autosaveChk.addEventListener('change', () => {
            this.autosave = autosaveChk.checked
            localStorage.setItem(AUTOSAVE_KEY, this.autosave)
        })

        // PDF export
        pdfBtn.addEventListener('click', () => this._exportPDF(titleInput.value, preview))

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

        const markDirty = () => {
            this.editorDirty = true
            saveStatus.textContent = '// unsaved'
            saveStatus.className = 'save-status unsaved'
        }

        let previewTimer = null
        titleInput.addEventListener('input', markDirty)
        contentArea.addEventListener('input', () => {
            markDirty()
            charCount.textContent = `${contentArea.value.length} chars`
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
            saveBtn.disabled = true
            saveBtn.querySelector('.btn-text').textContent = 'SAVING...'
            filesAPI.update(folder.id, file.id, {
                title: titleInput.value,
                content: contentArea.value,
            })
                .then(updated => {
                    this.currentFile = updated
                    this.editorDirty = false
                    saveStatus.textContent = '// saved'
                    saveStatus.className = 'save-status saved'
                    setTimeout(() => { if (!this.editorDirty) saveStatus.textContent = '' }, 2000)
                })
                .catch(err => this._toast(`> SAVE ERROR: ${err.message}`))
                .finally(() => {
                    saveBtn.disabled = false
                    saveBtn.querySelector('.btn-text').textContent = 'SAVE'
                })
        }

        saveBtn.addEventListener('click', doSave)

        const handleSaveKey = (e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave() }
        }
        contentArea.addEventListener('keydown', handleSaveKey)
        titleInput.addEventListener('keydown', handleSaveKey)

        // Link insertion button (shown on text selection)
        this._setupLinkToolbar(contentArea, markDirty, preview)
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

                // If line is empty (just the bullet), remove the bullet and dedent
                if (!lineContent.trim()) {
                    e.preventDefault()
                    // Remove the empty list marker
                    const newVal = val.slice(0, lineStart) + '\n' + val.slice(start)
                    textarea.value = newVal
                    const newPos = lineStart + 1
                    textarea.setSelectionRange(newPos, newPos)
                    textarea.dispatchEvent(new Event('input'))
                    return
                }

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
            const currentLine = val.slice(lineStart, val.indexOf('\n', start) === -1 ? val.length : val.indexOf('\n', start))
            const isList = /^\s*([-*+]|\d+[.)]) /.test(currentLine)

            if (isList) {
                if (e.shiftKey) {
                    // Dedent: remove up to 2 spaces or 1 tab from start of line
                    const dedented = currentLine.replace(/^  |^\t/, '')
                    if (dedented !== currentLine) {
                        const removed = currentLine.length - dedented.length
                        const lineEnd = val.indexOf('\n', lineStart)
                        const newVal = val.slice(0, lineStart) + dedented + (lineEnd === -1 ? '' : val.slice(lineEnd))
                        textarea.value = newVal
                        const newPos = Math.max(lineStart, start - removed)
                        textarea.setSelectionRange(newPos, newPos)
                        textarea.dispatchEvent(new Event('input'))
                    }
                } else {
                    // Indent: add 2 spaces
                    const lineEnd = val.indexOf('\n', lineStart)
                    const newVal = val.slice(0, lineStart) + '  ' + currentLine + (lineEnd === -1 ? '' : val.slice(lineEnd))
                    textarea.value = newVal
                    textarea.setSelectionRange(start + 2, start + 2)
                    textarea.dispatchEvent(new Event('input'))
                }
            } else {
                // Regular tab: insert 4 spaces or shift-tab dedents
                if (e.shiftKey) {
                    const dedented = currentLine.replace(/^    |^\t/, '')
                    if (dedented !== currentLine) {
                        const removed = currentLine.length - dedented.length
                        const lineEnd = val.indexOf('\n', lineStart)
                        const newVal = val.slice(0, lineStart) + dedented + (lineEnd === -1 ? '' : val.slice(lineEnd))
                        textarea.value = newVal
                        textarea.setSelectionRange(Math.max(lineStart, start - removed), Math.max(lineStart, start - removed))
                        textarea.dispatchEvent(new Event('input'))
                    }
                } else {
                    const insertion = '    '
                    const newVal = val.slice(0, start) + insertion + val.slice(end)
                    textarea.value = newVal
                    textarea.setSelectionRange(start + 4, start + 4)
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

    // ── Math normalisation ────────────────────────────────────
    _normaliseMath(md) {
        md = md.replace(/^\s*\[\s*\n([\s\S]*?)\n\s*\]\s*$/gm, (_, inner) => `$$${inner.trim()}$$`)
        md = md.replace(/^\s*\[\s*(.*?\\.*?)\s*\]\s*$/gm, (_, inner) => `$$${inner.trim()}$$`)
        md = md.replace(/\(([^()]*\\[^()]*)\)/g, (_, inner) => `$${inner.trim()}$`)
        return md
    }

    // ── Render preview with source line tracking ──────────────
    _renderPreview(previewEl, markdown) {
        const normalised = this._normaliseMath(markdown || '')
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

        // Apply special monospace formatting for ==code== (highlight) - already handled by marked
        // Style inline code with extra LaTeX-like monospace emphasis
        previewEl.querySelectorAll('code:not(pre code)').forEach(el => {
            el.classList.add('inline-code-tt')
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

// src/app.js
import { foldersAPI, filesAPI, auth } from './api.js'

const EDITOR_MODE_KEY = 'nc_editor_mode'
const THEME_KEY       = 'nc_theme'

const THEMES = [
    { id: 'cyberpunk',  label: 'Cyberpunk' },
    { id: 'docs',       label: 'Docs' },
    { id: 'typewriter', label: 'Typewriter' },
    { id: 'nord',       label: 'Nord' },
    { id: 'solarized',  label: 'Solarized' },
]

// ── Hash routing helpers ──────────────────────────────────────
// Scheme: #/  |  #/folder/path  |  #/folder/path//file-id
// We use "//" as separator between folder path and file id to support
// nested folder paths that already contain "/"
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
    // Check for "//" separator (folder path // file id)
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

        // Apply saved theme (default: typewriter)
        this._applyTheme(localStorage.getItem(THEME_KEY) || 'typewriter')

        // Restore position from hash, then render
        this._restoreFromHash()

        // Browser back/forward
        window.addEventListener('popstate', () => this._restoreFromHash())

        // Keyboard shortcuts: Escape to navigate back
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
                    // Go to parent folder, or root folders view
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
        document.documentElement.setAttribute('data-theme', themeId)
        localStorage.setItem(THEME_KEY, themeId)
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
        const currentTheme = localStorage.getItem(THEME_KEY) || 'typewriter'
        const swatches = THEMES.map(t => `
            <button
                class="theme-swatch ${t.id === currentTheme ? 'active' : ''}"
                data-theme="${t.id}"
                title="${t.label}"
                aria-label="Switch to ${t.label} theme"
            ></button>
        `).join('')

        // Build sidebar tree (root folders + indented children)
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

    // Recursively build sidebar folder tree with indentation
    _buildSidebarTree(parentId, depth) {
        const children = parentId === null
            ? foldersAPI.listRoots()
            : foldersAPI.listChildren(parentId)
        if (!children.length) return ''

        return children.map(f => {
            const isActive = this.currentFolder?.id === f.id
            const subChildren = foldersAPI.listChildren(f.id)
            const indent = depth * 12  // px indent per level
            return `
                <button class="sidebar-folder ${isActive ? 'active' : ''}"
                        data-folder-id="${f.id}"
                        style="padding-left: calc(0.75rem + ${indent}px)"
                        title="${this._esc(f.path)}">
                    <span class="sidebar-icon">${subChildren.length ? '▶' : '·'}</span>
                    <span class="sidebar-name">${this._esc(f.name)}</span>
                    <span class="sidebar-count">${f.files.length}</span>
                </button>
                ${this._buildSidebarTree(f.id, depth + 1)}
            `
        }).join('')
    }

    // Build ancestor chain for breadcrumb
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

        // Breadcrumb folder links (any depth)
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

        // Sidebar folder clicks
        this.container.querySelectorAll('.sidebar-folder').forEach(btn => {
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

        // Sidebar new root folder button
        const sidebarNewBtn = this.container.querySelector('#sidebar-new-folder')
        if (sidebarNewBtn) {
            sidebarNewBtn.addEventListener('click', () => this._promptNewFolder(null))
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
        foldersAPI.delete(id)
            .then(() => { this._render() })
            .catch(err => this._toast(`> DELETE ERROR: ${err.message}`))
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

        // Subfolder cards
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

        // File cards
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

        // Drag-and-drop on the file list
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

    // ── .md file upload ───────────────────────────────────────
    async _handleMdUpload(input) {
        const files = Array.from(input.files || []).filter(f => f.name.endsWith('.md'))
        if (!files.length) return

        let succeeded = 0
        for (const f of files) {
            try {
                const content = await f.text()
                const title   = f.name.replace(/\.md$/i, '').replace(/-/g, ' ')
                await filesAPI.create(this.currentFolder.id, title, content)
                succeeded++
            } catch (err) {
                this._toast(`> UPLOAD ERROR: ${f.name}: ${err.message}`)
            }
        }
        if (succeeded) {
            this._toast(`> UPLOADED ${succeeded} FILE${succeeded > 1 ? 'S' : ''}`)
            this.currentFolder = foldersAPI.list().find(f => f.id === this.currentFolder.id)
            this._render()
        }
        if (input.value !== undefined) input.value = ''
    }

    // ── Folder upload (webkitdirectory) ───────────────────────
    // Reads all .md files from the selected directory tree.
    // Recreates the subfolder structure under the current folder.
    async _handleFolderUpload(input) {
        const allFiles = Array.from(input.files || [])
        // Filter to .md only — skip images and other files
        const mdFiles = allFiles.filter(f => f.name.endsWith('.md'))
        if (!mdFiles.length) {
            this._toast('> NO .MD FILES FOUND IN FOLDER')
            if (input.value !== undefined) input.value = ''
            return
        }

        // Show progress toast
        this._toast(`> UPLOADING ${mdFiles.length} FILE${mdFiles.length !== 1 ? 'S' : ''}...`)

        let succeeded = 0
        let errors = 0

        for (const f of mdFiles) {
            try {
                // f.webkitRelativePath = "FolderName/sub/file.md"
                // We strip the top-level folder name (it becomes the current folder)
                // and treat everything else as subpath
                const relPath = f.webkitRelativePath || f.name
                const parts = relPath.split('/')

                // parts[0] is the selected folder name — skip it, we're already inside currentFolder
                // parts[1..n-1] are subfolder names, parts[n] is the filename
                const subParts = parts.slice(1)   // drop the top-level folder name
                const fileName = subParts[subParts.length - 1]
                const subFolderParts = subParts.slice(0, -1)  // any intermediate subfolders

                // Find or create the target folder
                let targetFolder = this.currentFolder
                for (const seg of subFolderParts) {
                    if (!seg) continue
                    // Look for an existing child with this name
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
            } catch (err) {
                errors++
                this._toast(`> ERROR: ${f.name}: ${err.message}`)
            }
        }

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

        contentArea.value = file.content || ''
        this._renderPreview(preview, contentArea.value)

        preview.addEventListener('click', () => {
            if (editorZone.dataset.mode === 'preview') this._setEditorMode('edit', editorZone)
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
    }

    _normaliseMath(md) {
        // Convert standalone [ ... ] lines (ChatGPT-style display math) to $$...$$
        // e.g.  "[ y = \sin(x) ]"  →  "$$y = \sin(x)$$"
        md = md.replace(/^\s*\[\s*(\\[^[\]]+)\s*\]\s*$/gm, (_, inner) => `$$${inner.trim()}$$`)
        return md
    }

    _renderPreview(previewEl, markdown) {
        const normalised = this._normaliseMath(markdown || '')
        if (typeof marked !== 'undefined') {
            previewEl.innerHTML = marked.parse(normalised)
        } else {
            previewEl.textContent = normalised
        }
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

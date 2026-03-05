// src/app.js
import { foldersAPI, filesAPI, auth } from './api.js'

const EDITOR_MODE_KEY = 'nc_editor_mode'

export class ThoughtCollector {
    constructor(containerEl, onLogout) {
        this.container = containerEl
        this.onLogout = onLogout
        // view: 'folders' | 'files' | 'editor'
        this.view = 'folders'
        this.currentFolder = null
        this.currentFile = null
        this.editorDirty = false
        // editorMode: 'split' | 'edit' | 'preview'
        // On mobile we force 'edit', on desktop persist preference
        this.editorMode = this._isMobile()
            ? 'edit'
            : (localStorage.getItem(EDITOR_MODE_KEY) || 'split')

        this._render()
    }

    _isMobile() {
        return window.innerWidth <= 768
    }

    // ── Top-level render dispatcher ───────────────────────────
    _render() {
        if (this.view === 'folders') this._renderFolders()
        else if (this.view === 'files') this._renderFiles()
        else if (this.view === 'editor') this._renderEditor()
    }

    // ── Shared shell ──────────────────────────────────────────
    _shell(breadcrumb, bodyHtml) {
        return `
            <div class="app-shell">
                <header class="app-header">
                    <div class="header-left">
                        <h1 class="glitch-text small" data-text="THOUGHTS.EXE">THOUGHTS.EXE</h1>
                        <nav class="breadcrumb">${breadcrumb}</nav>
                    </div>
                    <button class="cyber-btn logout-btn" id="logout-btn">
                        <span class="btn-text">JACK OUT</span>
                        <span class="btn-glow"></span>
                    </button>
                </header>
                <main class="app-main">${bodyHtml}</main>
                <div class="scanlines"></div>
                <div class="noise-overlay"></div>
            </div>
        `
    }

    _loading(message = 'LOADING...') {
        return `<div class="empty-state"><p class="blink">> ${message}_</p></div>`
    }

    _bindLogout() {
        this.container.querySelector('#logout-btn').addEventListener('click', async () => {
            await auth.logout()
            this.onLogout()
        })
    }

    // ── Folders view ──────────────────────────────────────────
    _renderFolders() {
        // Show cached folders immediately, then refresh from cloud in background
        const folders = foldersAPI.list()
        this._paintFolders(folders)

        // Background sync with cloud (retry once on network errors / cold starts)
        const doSync = () => foldersAPI.listFromCloud()
            .then(updated => {
                if (this.view === 'folders') this._paintFolders(updated)
            })
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
                        <button class="icon-btn rename-folder-btn" data-id="${f.id}" title="Rename">✎</button>
                        <button class="icon-btn delete-folder-btn" data-id="${f.id}" title="Delete">✕</button>
                    </div>
                </div>
            `).join('')
            : `<div class="empty-state">
                <p class="blink">> NO FOLDERS FOUND IN NEURAL DATABASE_</p>
                <p class="empty-sub">// CREATE A FOLDER TO BEGIN</p>
               </div>`

        const body = `
            <div class="toolbar">
                <span class="section-label">// NEURAL_FOLDERS</span>
                <button class="cyber-btn compact-btn" id="new-folder-btn">
                    <span class="btn-text">+ NEW FOLDER</span>
                    <span class="btn-glow"></span>
                </button>
            </div>
            <div class="folder-grid" id="folder-grid">${folderCards}</div>
        `

        this.container.innerHTML = this._shell('ROOT', body)
        this._bindLogout()

        this.container.querySelector('#new-folder-btn').addEventListener('click', () => {
            this._promptNewFolder()
        })

        this.container.querySelectorAll('.folder-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.folder-actions')) return
                const folder = foldersAPI.list().find((f) => f.id === card.dataset.id)
                if (folder) this._openFolder(folder)
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

    async _promptNewFolder() {
        const name = prompt('Folder name:')
        if (!name || !name.trim()) return
        try {
            await foldersAPI.create(name)
            this._render()
        } catch (err) {
            this._toast(`> ERROR: ${err.message}`)
        }
    }

    _renameFolder(id) {
        const folder = foldersAPI.list().find((f) => f.id === id)
        if (!folder) return
        const name = prompt('New name:', folder.name)
        if (!name || !name.trim()) return
        try {
            foldersAPI.rename(id, name)
            this._render()
        } catch (err) {
            this._toast(`> ERROR: ${err.message}`)
        }
    }

    _deleteFolder(id) {
        const folder = foldersAPI.list().find((f) => f.id === id)
        if (!folder) return
        if (!confirm(`Delete folder "${folder.name}" and all its files?`)) return
        foldersAPI.delete(id)
            .then(() => { if (this.view === 'folders') this._render() })
            .catch(err => this._toast(`> DELETE ERROR: ${err.message}`))
    }

    _openFolder(folder) {
        this.currentFolder = folder
        this.view = 'files'
        this._render()
    }

    // ── Files view ────────────────────────────────────────────
    _renderFiles() {
        this.currentFolder = foldersAPI.list().find((f) => f.id === this.currentFolder.id)
        if (!this.currentFolder) {
            this.view = 'folders'
            this._render()
            return
        }
        this._paintFiles(this.currentFolder.files)
    }

    _paintFiles(files) {
        const folder = this.currentFolder

        const fileCards = files.length
            ? files.map((f) => `
                <div class="file-card" data-id="${f.id}">
                    <div class="file-icon">◈</div>
                    <div class="file-info">
                        <span class="file-title">${this._esc(f.title)}</span>
                        <span class="file-meta">// ${this._relTime(f.updated_at)}</span>
                    </div>
                    <div class="file-actions">
                        <button class="icon-btn delete-file-btn" data-id="${f.id}" title="Delete">✕</button>
                    </div>
                </div>
            `).join('')
            : `<div class="empty-state">
                <p class="blink">> NO FILES IN THIS FOLDER_</p>
                <p class="empty-sub">// CREATE A FILE TO BEGIN</p>
               </div>`

        const body = `
            <div class="toolbar">
                <span class="section-label">// ${this._esc(folder.name).toUpperCase()}</span>
                <button class="cyber-btn compact-btn" id="new-file-btn">
                    <span class="btn-text">+ NEW FILE</span>
                    <span class="btn-glow"></span>
                </button>
            </div>
            <div class="file-list" id="file-list">${fileCards}</div>
        `

        const breadcrumb = `<button class="breadcrumb-link" id="back-to-folders">ROOT</button> / ${this._esc(folder.name)}`
        this.container.innerHTML = this._shell(breadcrumb, body)
        this._bindLogout()

        this.container.querySelector('#back-to-folders').addEventListener('click', () => {
            this.view = 'folders'
            this.currentFolder = null
            this._render()
        })

        this.container.querySelector('#new-file-btn').addEventListener('click', () => {
            this._promptNewFile()
        })

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

    _promptNewFile() {
        const title = prompt('File title:')
        if (!title || !title.trim()) return
        filesAPI.create(this.currentFolder.id, title)
            .then(file => this._openFile(file))
            .catch(err => this._toast(`> ERROR: ${err.message}`))
    }

    _deleteFile(fileId) {
        const file = this.currentFolder.files.find((f) => f.id === fileId)
        if (!file) return
        if (!confirm(`Delete file "${file.title}"?`)) return
        filesAPI.delete(this.currentFolder.id, fileId)
            .then(() => {
                this.currentFolder = foldersAPI.list().find((f) => f.id === this.currentFolder.id)
                if (this.view === 'files') this._render()
            })
            .catch(err => this._toast(`> DELETE ERROR: ${err.message}`))
    }

    _openFile(file) {
        // Always fetch fresh content from cloud — never render stale cached content
        this.currentFile = file
        this.view = 'editor'
        this.editorDirty = false
        const breadcrumb = `
            <button class="breadcrumb-link" id="back-to-folders">ROOT</button>
            / <button class="breadcrumb-link" id="back-to-files">${this._esc(this.currentFolder.name)}</button>
            / ${this._esc(file.title)}
        `
        this.container.innerHTML = this._shell(breadcrumb, this._loading('LOADING FILE'))
        this._bindLogout()
        this.container.querySelector('#back-to-folders').addEventListener('click', () => {
            this.view = 'folders'; this.currentFolder = null; this.currentFile = null; this._render()
        })
        this.container.querySelector('#back-to-files').addEventListener('click', () => {
            this.view = 'files'; this.currentFile = null; this._render()
        })

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

        // Mode toggle buttons — hide SPLIT on mobile
        const modeButtons = `
            <div class="mode-toggle" id="mode-toggle">
                ${!this._isMobile() ? `
                <button class="mode-btn ${mode === 'split' ? 'active' : ''}" data-mode="split" title="Split view">⬜</button>
                ` : ''}
                <button class="mode-btn ${mode === 'edit' ? 'active' : ''}" data-mode="edit" title="Edit only">✎</button>
                <button class="mode-btn ${mode === 'preview' ? 'active' : ''}" data-mode="preview" title="Preview only">👁</button>
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
                </div>
            </div>
        `

        const breadcrumb = `
            <button class="breadcrumb-link" id="back-to-folders">ROOT</button>
            / <button class="breadcrumb-link" id="back-to-files">${this._esc(folder.name)}</button>
            / ${this._esc(file.title)}
        `
        this.container.innerHTML = this._shell(breadcrumb, body)
        this._bindLogout()

        const titleInput  = this.container.querySelector('#file-title')
        const contentArea = this.container.querySelector('#file-content')
        const saveBtn     = this.container.querySelector('#save-btn')
        const saveStatus  = this.container.querySelector('#save-status')
        const charCount   = this.container.querySelector('#char-count')
        const preview     = this.container.querySelector('#editor-preview')
        const editorZone  = this.container.querySelector('#editor-zone')

        // Set textarea value directly (avoids HTML encoding issues with innerHTML)
        contentArea.value = file.content || ''

        // Initial preview render
        this._renderPreview(preview, contentArea.value)

        // Click preview to switch to edit mode
        preview.addEventListener('click', () => {
            if (editorZone.dataset.mode === 'preview') {
                this._setEditorMode('edit', editorZone)
            }
        })

        // Mode toggle buttons
        this.container.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._setEditorMode(btn.dataset.mode, editorZone)
            })
        })

        this.container.querySelector('#back-to-folders').addEventListener('click', () => {
            if (this.editorDirty && !confirm('Unsaved changes. Leave anyway?')) return
            this.view = 'folders'
            this.currentFolder = null
            this.currentFile = null
            this.editorDirty = false
            this._render()
        })

        this.container.querySelector('#back-to-files').addEventListener('click', () => {
            if (this.editorDirty && !confirm('Unsaved changes. Leave anyway?')) return
            this.view = 'files'
            this.currentFile = null
            this.editorDirty = false
            this._render()
        })

        const markDirty = () => {
            this.editorDirty = true
            saveStatus.textContent = '// unsaved'
            saveStatus.className = 'save-status unsaved'
        }

        // Live preview update (debounced)
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

        // Cmd/Ctrl+S
        const handleSaveKey = (e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave() }
        }
        contentArea.addEventListener('keydown', handleSaveKey)
        titleInput.addEventListener('keydown', handleSaveKey)
    }

    _renderPreview(previewEl, markdown) {
        if (typeof marked !== 'undefined') {
            previewEl.innerHTML = marked.parse(markdown || '')
        } else {
            // fallback: show raw text
            previewEl.textContent = markdown || ''
        }
    }

    _setEditorMode(mode, editorZone) {
        // Ignore split on mobile
        if (mode === 'split' && this._isMobile()) mode = 'edit'
        this.editorMode = mode
        localStorage.setItem(EDITOR_MODE_KEY, mode)
        if (!editorZone) return
        editorZone.dataset.mode = mode
        // Update active button highlight
        editorZone.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode)
        })
        // If switching to preview, focus the preview pane
        if (mode === 'preview') {
            const contentArea = editorZone.querySelector('#file-content')
            const preview = editorZone.querySelector('#editor-preview')
            if (contentArea && preview) this._renderPreview(preview, contentArea.value)
        }
        // If switching to edit, focus textarea
        if (mode === 'edit') {
            const contentArea = editorZone.querySelector('#file-content')
            if (contentArea) setTimeout(() => contentArea.focus(), 50)
        }
    }

    // ── Utilities ─────────────────────────────────────────────
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

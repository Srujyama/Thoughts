// src/lazy.js
// On-demand loading for the heavy rendering libraries.
//
// These used to sit in <head> as blocking <script> tags, so a first-ever visit
// downloaded and parsed marked + KaTeX + highlight.js + Mermaid (well over a
// megabyte, Mermaid being most of it) before the page could paint — even for a
// user who only ever writes plain prose. Now nothing loads until a preview
// actually contains code, math, or a diagram.
//
// Every loader is memoised, so N previews cost at most one fetch each, and a
// failed load resolves to false rather than rejecting: a missing diagram library
// should degrade the preview, not break it.

const _scripts = new Map()
const _styles = new Map()

export function loadScript(src) {
    if (_scripts.has(src)) return _scripts.get(src)
    const p = new Promise(resolve => {
        const el = document.createElement('script')
        el.src = src
        el.async = true
        el.crossOrigin = 'anonymous'
        el.onload = () => resolve(true)
        el.onerror = () => resolve(false)
        document.head.appendChild(el)
    })
    _scripts.set(src, p)
    return p
}

export function loadStyle(href) {
    if (_styles.has(href)) return _styles.get(href)
    const p = new Promise(resolve => {
        const el = document.createElement('link')
        el.rel = 'stylesheet'
        el.href = href
        el.crossOrigin = 'anonymous'
        el.onload = () => resolve(true)
        el.onerror = () => resolve(false)
        document.head.appendChild(el)
    })
    _styles.set(href, p)
    return p
}

// ── marked ────────────────────────────────────────────────────
// Bundled from npm rather than a CDN: it ships as its own chunk from our own
// origin, so it rides the already-warm connection instead of a fresh DNS + TLS
// handshake to jsdelivr. Published on `window.marked` because the render code
// checks for the global.
let _markedPromise = null

export function ensureMarked() {
    if (window.marked) return Promise.resolve(true)
    if (_markedPromise) return _markedPromise
    _markedPromise = import('marked')
        .then(mod => {
            window.marked = mod.marked || mod.default || mod
            return true
        })
        .catch(() => false)
    return _markedPromise
}

// Kick the download off early (it is needed by every preview) without blocking
// anything: the browser fetches it while Firebase is still listing the vault.
export function warmMarked() {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => ensureMarked())
    else setTimeout(() => ensureMarked(), 0)
}

// ── highlight.js ──────────────────────────────────────────────
const HLJS_BASE = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build'
let _hljsPromise = null

export function ensureHljs() {
    if (window.hljs) return Promise.resolve(true)
    if (_hljsPromise) return _hljsPromise
    _hljsPromise = Promise.all([
        loadScript(`${HLJS_BASE}/highlight.min.js`),
        loadStyle(`${HLJS_BASE}/styles/github-dark.min.css`),
    ]).then(([js]) => !!js && !!window.hljs)
    return _hljsPromise
}

// ── KaTeX ─────────────────────────────────────────────────────
const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist'
let _katexPromise = null

export function ensureKatex() {
    if (window.renderMathInElement) return Promise.resolve(true)
    if (_katexPromise) return _katexPromise
    // auto-render depends on katex itself, so it has to come second.
    _katexPromise = Promise.all([
        loadStyle(`${KATEX_BASE}/katex.min.css`),
        loadScript(`${KATEX_BASE}/katex.min.js`),
    ])
        .then(() => loadScript(`${KATEX_BASE}/contrib/auto-render.min.js`))
        .then(() => !!window.renderMathInElement)
    return _katexPromise
}

// ── Mermaid ───────────────────────────────────────────────────
// By far the biggest of the four. Only ever fetched for a note that actually
// contains a diagram.
let _mermaidPromise = null

export function ensureMermaid() {
    if (window.mermaid) return Promise.resolve(true)
    if (_mermaidPromise) return _mermaidPromise
    // Pin the exact release: a floating major tag can change behavior or ship a
    // regression without this app changing at all. 11.16.0 includes the 2026
    // class/style injection fixes from the 11.15 security release.
    _mermaidPromise = loadScript('https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js')
        .then(ok => ok && !!window.mermaid)
    return _mermaidPromise
}

// ── Content sniffing ──────────────────────────────────────────
// Cheap tests that decide whether a given note needs a given library at all.

export function needsMath(md) {
    if (!md) return false
    return /\$[^$\n]+\$|\$\$|\\\(|\\\[/.test(md)
}

export function needsCode(md) {
    if (!md) return false
    return /```|^\s{4}\S/m.test(md)
}

export function needsMermaid(md) {
    if (!md) return false
    return /```\s*mermaid|^\s*(graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie\s|journey|mindmap)/m.test(md)
}

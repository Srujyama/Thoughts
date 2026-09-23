// Theme contrast auditor.
//
// src/style.css carries nine themes as [data-theme="..."] blocks of custom
// properties, and most interactive rules set colours through var() chains. That
// makes it very easy to ship a hover state that is perfectly readable in the
// theme you happened to be looking at and invisible in the other eight. This
// resolves every var() chain per theme, alpha-composites translucent layers
// over what they actually sit on, and reports the WCAG 2.1 contrast ratio.
//
//   node test/contrast-check.mjs            # only failures
//   node test/contrast-check.mjs --all      # every checked pair
//   node test/contrast-check.mjs --theme nord
//
// Exits non-zero if any checked pair falls below its threshold.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CSS = fs.readFileSync(path.join(here, '..', 'src', 'style.css'), 'utf8')

const args = process.argv.slice(2)
const SHOW_ALL = args.includes('--all')
const ONLY_THEME = (args.find(a => a.startsWith('--theme')) || '').split('=')[1]
    || (args.includes('--theme') ? args[args.indexOf('--theme') + 1] : null)

// ── Colour maths ──────────────────────────────────────────────
const NAMED = { white: '#ffffff', black: '#000000', transparent: 'rgba(0,0,0,0)' }

function parseColor(raw) {
    if (!raw) return null
    const v = raw.trim().toLowerCase()
    if (NAMED[v]) return parseColor(NAMED[v])
    let m = v.match(/^#([0-9a-f]{3,8})$/)
    if (m) {
        let h = m[1]
        if (h.length === 3) h = [...h].map(c => c + c).join('')
        if (h.length === 4) h = [...h].map(c => c + c).join('')
        const n = parseInt(h.slice(0, 6), 16)
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
    }
    m = v.match(/^rgba?\(([^)]+)\)$/)
    if (m) {
        const p = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean)
        if (p.length < 3) return null
        const c = p.slice(0, 3).map(s => (s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : parseFloat(s)))
        const a = p[3] == null ? 1 : (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]))
        if (c.some(Number.isNaN)) return null
        return [...c, Number.isNaN(a) ? 1 : a]
    }
    return null
}

// Paint `fg` (which may be translucent) onto the opaque `bg`.
function over(fg, bg) {
    const a = fg[3]
    if (a >= 1) return [fg[0], fg[1], fg[2], 1]
    return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1)
}

function luminance([r, g, b]) {
    const f = c => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
    const l1 = luminance(a), l2 = luminance(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

// ── Extract each theme's custom properties ────────────────────
// Declarations in a `:root, [data-theme="cyberpunk"] { ... }` style selector
// belong to every theme listed in it.
// A real brace walker: a regex can't see past @media, and roughly a third of
// this stylesheet's rules live inside one.
function declBlocks(css) {
    const out = []
    const stack = []
    let i = 0, head = ''
    while (i < css.length) {
        const c = css[i]
        if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i) + 2 || css.length; continue }
        if (c === '{') {
            const sel = head.trim()
            head = ''
            if (sel.startsWith('@')) { stack.push(null); i++; continue }
            // Find this rule's body, stopping at a nested block.
            let depth = 1, j = i + 1
            while (j < css.length && depth) {
                if (css[j] === '{') depth++
                else if (css[j] === '}') depth--
                j++
            }
            const body = css.slice(i + 1, j - 1)
            if (!body.includes('{')) out.push({ selector: sel, body })
            i = j
            continue
        }
        if (c === '}') { stack.pop(); head = ''; i++; continue }
        head += c
        i++
    }
    return out
}

const BLOCKS = declBlocks(CSS)
const THEMES = new Set(['cyberpunk'])
for (const b of BLOCKS) {
        for (const t of b.selector.matchAll(/\[data-theme="([^"]+)"\]/g)) {
        // Swatch selectors name pseudo-themes ("system") that have no block.
        if (/--nc-|--t-/.test(b.body)) THEMES.add(t[1])
    }
}
// Swatch-only selectors name themes that aren't real theme blocks.
const themeVars = {}
for (const t of THEMES) themeVars[t] = {}

for (const b of BLOCKS) {
    const sels = b.selector.split(',').map(s => s.trim())
    const targets = new Set()
    for (const s of sels) {
        if (s === ':root') targets.add('cyberpunk')
        const m = s.match(/^\[data-theme="([^"]+)"\]$/)
        if (m && themeVars[m[1]]) targets.add(m[1])
    }
    if (!targets.size) continue
    for (const d of b.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        for (const t of targets) themeVars[t][d[1]] = d[2].trim()
    }
}
// Every theme inherits anything it doesn't define from the :root defaults.
for (const t of THEMES) {
    if (t === 'cyberpunk') continue
    themeVars[t] = { ...themeVars.cyberpunk, ...themeVars[t] }
}

// Resolve a value that may be a var() chain with fallbacks.
function resolve(value, theme, depth = 0) {
    if (!value || depth > 12) return null
    const v = value.replace(/\s*!important\s*/g, '').trim()
    const m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/)
    if (m) {
        const own = themeVars[theme][m[1]]
        if (own != null) return resolve(own, theme, depth + 1)
        return m[2] ? resolve(m[2], theme, depth + 1) : null
    }
    return parseColor(v)
}

// ── The pairs we check ────────────────────────────────────────
// Each entry says: this selector's text sits on these layers (nearest first,
// ending in something opaque). Layers are CSS values resolved per theme.
const PAGE = 'var(--t-body-bg)'
const CARD = 'var(--t-card-bg)'
const INPUT = 'var(--t-input-bg)'
// A modal paints its own surface rather than sitting on a card.
const MODAL = 'var(--nc-bg-dark)'

function matchingBodies(selector) {
    return BLOCKS
        .filter(b => b.selector.split(',').some(s => {
            const t = s.trim()
            return t === selector || t.endsWith(' ' + selector)
        }))
        .map(b => b.body)
}

// Last declaration wins, across every rule that targets the selector — the
// same order the cascade would apply for rules of equal specificity.
function decl(selector, prop) {
    let last = null
    for (const body of matchingBodies(selector)) {
        const re = new RegExp(`(?:^|;|\\{)\\s*${prop}\\s*:\\s*([^;]+)`, 'g')
        let m
        while ((m = re.exec(body))) last = m[1].trim()
    }
    return last
}

const CHECKS = [
    // [label, selector supplying colour, selector supplying background, base layers, largeText]
    // The label is now pinned on .google-btn itself; the generic
    // .cyber-btn:hover rule is scoped away from it with :not(.google-btn).
    ['Google button label (hover)', '.google-btn', '.google-btn:hover:not(:disabled)', [CARD, PAGE]],
    ['Overflow menu item (hover)', '.overflow-item', '.overflow-item:hover', [CARD, PAGE]],
    ['Editor menu item (hover)', '.menu-item', '.menu-item:hover', [CARD, PAGE]],
    ['Sidebar folder (hover)', '.sidebar-folder', '.sidebar-folder:hover', [CARD, PAGE]],
    ['Sidebar drop target', '.sidebar-folder.sidebar-drop-target', '.sidebar-folder.sidebar-drop-target', [CARD, PAGE]],
    ['Move-menu row (hover)', '.move-menu-item', '.move-menu-item:hover', [CARD, PAGE]],
    ['Command palette row (selected)', '.command-palette-item.selected', '.command-palette-item.selected', [CARD, PAGE]],
    ['Mode toggle (active)', '.mode-btn.active', '.mode-btn.active', [CARD, PAGE]],
    ['Mode toggle (hover)', '.mode-btn:hover', '.mode-btn:hover', [CARD, PAGE]],
    ['Tag pill (hover)', '.tag-pill', '.tag-pill:hover', [CARD, PAGE]],
    ['Modal confirm (resting)', '.modal-btn.modal-confirm', '.modal-btn.modal-confirm', [MODAL, PAGE]],
    ['Modal confirm (hover)', '.modal-btn.modal-confirm:hover', '.modal-btn.modal-confirm:hover', [MODAL, PAGE]],
    ['Modal danger (resting)', '.modal-btn.modal-confirm.danger', '.modal-btn.modal-confirm.danger', [MODAL, PAGE]],
    ['Recycle bin item title', '.trash-title', '.trash-card:hover', [CARD, PAGE]],
    ['Recycle bin restore (hover)', '.trash-restore-btn:hover', '.trash-restore-btn:hover', [CARD, PAGE]],
    ['Recycle bin delete (hover)', '.trash-purge-btn:hover', '.trash-purge-btn:hover', [CARD, PAGE]],
    ['Wikilink (hover)', '.wikilink:hover', null, [INPUT, PAGE]],
    ['Breadcrumb link (hover)', '.breadcrumb-link:hover', null, [CARD, PAGE]],
]

function opaqueBase(layers, theme) {
    // Walk from the far layer inward so translucent layers composite correctly.
    let base = [255, 255, 255, 1]
    for (let i = layers.length - 1; i >= 0; i--) {
        const c = resolve(layers[i], theme)
        if (c) base = over(c, base)
    }
    return base
}

let failures = 0, checked = 0, skipped = 0
const themeList = [...THEMES].filter(t => !ONLY_THEME || t === ONLY_THEME).sort()

console.log(`\nthemes: ${themeList.join(', ')}\n`)

for (const [label, fgSel, bgSel, layers, large] of CHECKS) {
    const fgRaw = fgSel && decl(fgSel, 'color')
    if (!fgRaw) {
        // Silently skipping here is how this suite once reported "0 below
        // threshold" while auditing barely half of its own list.
        console.log(`\x1b[33mSKIP\x1b[0m ${label} — "${fgSel}" declares no colour`)
        skipped++
        continue
    }
    const bgRaw = bgSel && decl(bgSel, 'background')
    const threshold = large ? 3 : 4.5
    const rows = []
    for (const theme of themeList) {
        const base = opaqueBase(layers, theme)
        const bgCol = bgRaw ? resolve(bgRaw, theme) : null
        const bg = bgCol ? over(bgCol, base) : base
        const fg = resolve(fgRaw, theme)
        if (!fg) continue
        const ratio = contrast(over(fg, bg), bg)
        checked++
        const bad = ratio < threshold
        if (bad) failures++
        if (bad || SHOW_ALL) rows.push([theme, ratio, bad])
    }
    if (!rows.length) continue
    console.log(`${label}`)
    console.log(`   fg ${fgRaw}${bgRaw ? `  |  bg ${bgRaw}` : ''}`)
    for (const [theme, ratio, bad] of rows) {
        const tag = bad ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32m ok \x1b[0m'
        console.log(`   ${tag} ${theme.padEnd(11)} ${ratio.toFixed(2)}:1`)
    }
    console.log()
}

console.log(`${checked} (rule, theme) pairs checked — ${failures} below threshold` +
    (skipped ? `, ${skipped} checks SKIPPED (see above)` : '') + '\n')
process.exit(failures || skipped ? 1 : 0)

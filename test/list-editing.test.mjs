// Harness: pull the real list-editing methods out of src/app.js and exercise
// them against a simulated <textarea>, so the behaviour under test is the
// shipped code and not a re-implementation of it.
import fs from 'node:fs'

const SRC = new URL('../src/app.js', import.meta.url)
const src = fs.readFileSync(SRC, 'utf8')

const NAMES = [
    '_lineBounds', '_applyEdit', '_applyDiff', '_shiftCaret', '_applyListEdit',
    '_replaceLines', '_parseListLine', '_splitIndent',
    '_indentWidth', '_indentLevels', '_removeOneLevel', '_addOneLevel', '_fenceMask',
    '_caretInFence', '_measureCols', '_canIndentListLine', '_subtreeRange',
    '_removeIndentCols', '_outsideCode', '_normaliseMath', '_preprocessMarkdown', '_esc',
    '_renumberedText', '_renumberRun',
    '_renumberFollowingRun', '_handleEditorKeydown', '_indentSelection', '_toggleList',
    '_toggleDone', '_normaliseIndentForRender', '_syncCheckboxToEditor',
]

// Extract "    name(args) {  ...balanced... }" at class-method indentation.
function extract(name) {
    const re = new RegExp(`\\n    ${name}\\(`)
    const m = re.exec(src)
    if (!m) throw new Error('not found: ' + name)
    let i = src.indexOf('{', m.index + m[0].length - 1)
    let depth = 0, inStr = null, inTpl = 0, inCmt = null, prev = ''
    for (let p = i; p < src.length; p++) {
        const c = src[p], n = src[p + 1]
        if (inCmt === 'line') { if (c === '\n') inCmt = null; prev = c; continue }
        if (inCmt === 'block') { if (c === '*' && n === '/') { inCmt = null; p++ } prev = c; continue }
        if (inStr) {
            if (c === '\\') { p++; prev = ''; continue }
            if (c === inStr) inStr = null
            prev = c; continue
        }
        // Template literals first: a `</div>` inside one would otherwise look
        // like the start of a regex literal and swallow the rest of the method.
        if (c === '`') { inTpl ^= 1; prev = c; continue }
        if (inTpl) { prev = c; continue }
        if (c === '/' && n === '/') { inCmt = 'line'; p++; prev = ''; continue }
        if (c === '/' && n === '*') { inCmt = 'block'; p++; prev = ''; continue }
        if (c === '/' && /[=(,:[!&|?{};+\-*%<>~^]|return|typeof/.test(prev.trim() || '=')) {
            // regex literal — skip to its unescaped closing slash
            let q = p + 1, cls = false
            for (; q < src.length; q++) {
                if (src[q] === '\\') { q++; continue }
                if (src[q] === '[') cls = true
                else if (src[q] === ']') cls = false
                else if (src[q] === '/' && !cls) break
            }
            p = q; prev = '/'; continue
        }
        if (c === '"' || c === "'") { inStr = c; prev = c; continue }
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index + 1, p + 1) }
        if (!/\s/.test(c)) prev = c
    }
    throw new Error('unbalanced: ' + name)
}

const body = NAMES.map(extract).join('\n\n')
const Editor = new Function(`return class Editor {\n${body}\n}`)()

// ── Simulated textarea + execCommand ──────────────────────────
class FakeTextarea {
    constructor(value, selStart, selEnd = selStart) {
        this.value = value
        this.selectionStart = selStart
        this.selectionEnd = selEnd
        this.scrollTop = 0
        this.inputs = 0
    }
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e }
    focus() {}
    dispatchEvent() { this.inputs++; return true }
}
globalThis.Event = class { constructor(t) { this.type = t } }
globalThis.document = {
    get activeElement() { return globalThis.__ta },
    // Enough of an element for _esc(): text in, escaped HTML out.
    createElement() {
        return {
            innerHTML: '',
            set textContent(v) {
                this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            },
        }
    },
    execCommand(cmd, _ui, text) {
        const ta = globalThis.__ta
        const { selectionStart: s, selectionEnd: e } = ta
        const ins = cmd === 'delete' ? '' : text
        ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e)
        ta.selectionStart = ta.selectionEnd = s + ins.length
        ta.inputs++
        return true
    },
}

const ed = new Editor()

// ── Scenario runner ───────────────────────────────────────────
// Notation: "|" marks the caret in both input and expected output.
let pass = 0, fail = 0
function press(key, text, opts = {}) {
    const start = text.indexOf('|')
    if (start === -1) throw new Error('no caret in: ' + text)
    const ta = new FakeTextarea(text.replace('|', ''), start)
    globalThis.__ta = ta
    const e = {
        key, shiftKey: !!opts.shift, metaKey: false, ctrlKey: false, altKey: false,
        preventDefault() { this.defaultPrevented = true }, defaultPrevented: false,
    }
    ed._handleEditorKeydown(e, ta)
    lastPrevented = e.defaultPrevented
    return ta.value.slice(0, ta.selectionStart) + '|' + ta.value.slice(ta.selectionStart)
}
// Whether the last press() consumed the key. A handler that declines to act
// leaves the browser to insert the character natively, which this harness
// cannot simulate — so "untouched text + not prevented" is the pass condition.
let lastPrevented = false
function check(name, got, want) {
    const ok = got === want
    if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
    else {
        fail++
        console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
        console.log(`       want ${JSON.stringify(want)}`)
        console.log(`       got  ${JSON.stringify(got)}`)
    }
}
const T = (name, key, input, want, opts) => check(name, press(key, input, opts), want)
// For the methods that are called directly rather than through a keystroke:
// "|" marks a collapsed caret, «...» marks a selection.
function fake(text) {
    const selStart = text.indexOf('«')
    if (selStart !== -1) {
        const body = text.replace('«', '')
        const selEnd = body.indexOf('»')
        const ta = new FakeTextarea(body.replace('»', ''), selStart, selEnd)
        globalThis.__ta = ta
        return ta
    }
    const pos = text.indexOf('|')
    const ta = new FakeTextarea(text.replace('|', ''), pos)
    globalThis.__ta = ta
    return ta
}
function show(ta) {
    const { value: v, selectionStart: s, selectionEnd: e } = ta
    return s === e ? v.slice(0, s) + '|' + v.slice(s)
        : v.slice(0, s) + '«' + v.slice(s, e) + '»' + v.slice(e)
}
function ok(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '\n       ' + detail : ''}`) }
}

console.log('\n── Enter at the START of an item (the reported bug) ──')
T('new empty bullet above, item slides down', 'Enter',
    '- |foo', '- \n- |foo')
T('second item in a list', 'Enter',
    '- one\n- |two', '- one\n- \n- |two')
T('nested item keeps its indent', 'Enter',
    '- one\n\t- |two', '- one\n\t- \n\t- |two')
T('task item gets an unchecked box above', 'Enter',
    '- [ ] |buy milk', '- [ ] \n- [ ] |buy milk')
T('done task gets an UNCHECKED box above', 'Enter',
    '- [x] |shipped', '- [ ] \n- [x] |shipped')
T('ordered list renumbers', 'Enter',
    '1. one\n2. |two', '1. one\n2. \n3. |two')

console.log('\n── Enter in the MIDDLE of an item (split) ──')
T('splits, tail moves to a new bullet', 'Enter',
    '- foo|bar', '- foo\n- |bar')
T('split keeps the task box unchecked', 'Enter',
    '- [x] don|e', '- [x] don\n- [ ] |e')
T('split at end of item = plain new bullet', 'Enter',
    '- foo|', '- foo\n- |')
T('nested split keeps indent', 'Enter',
    '\t- ab|cd', '\t- ab\n\t- |cd')

console.log('\n── Enter on an EMPTY item ──')
T('nested empty item outdents', 'Enter',
    '- one\n\t- |', '- one\n- |')
T('top-level empty item leaves the list', 'Enter',
    '- one\n- |', '- one\n|')

console.log('\n── Shift+Enter: continuation line inside the item ──')
T('aligns under the item text', 'Enter',
    '- foo|', '- foo\\\n  |', { shift: true })
T('task continuation clears the box width too', 'Enter',
    '- [ ] foo|', '- [ ] foo\\\n      |', { shift: true })

console.log('\n── Backspace at the start of an item ──')
T('nested item outdents', 'Backspace',
    '- one\n\t- |two', '- one\n- |two')
T('top-level item loses its marker', 'Backspace',
    '- |foo', '|foo')
T('mid-word backspace is left to the browser', 'Backspace',
    '- fo|o', '- fo|o')

console.log('\n── Tab / Shift+Tab ──')
T('indents under a previous sibling', 'Tab',
    '- one\n- |two', '- one\n\t- |two')
T('refuses to indent the first item of a list', 'Tab',
    '- |one', '- |one')
T('refuses to indent past parent+1', 'Tab',
    '- one\n\t- two\n- |three', '- one\n\t- two\n\t- |three')
T('Shift+Tab outdents', 'Tab',
    '- one\n\t- |two', '- one\n- |two', { shift: true })
T('indent carries the subtree along', 'Tab',
    '- one\n- |two\n\t- child', '- one\n\t- two\n\t\t- child'.replace('- two', '- |two'))

console.log('\n── Blockquotes ──')
T('continues a quote', 'Enter', '> quoted|', '> quoted\n> |')
T('empty quote exits', 'Enter', '> |', '|')

console.log('\n── Regression: plain prose is untouched ──')
T('Enter in prose is left to the browser', 'Enter', 'hello |world', 'hello |world')
T('thematic break is not a list item', 'Enter', '---|', '---|')
T('a spaced thematic break is not one either', 'Enter', '* * *|', '* * *|')
T('a dashed spaced break is not one either', 'Enter', '- - -|', '- - -|')

// ── Rendering: what the preview actually shows ────────────────
// These caught three regressions that the unit assertions above could not:
// the editor produced perfectly reasonable Markdown that `marked` then read as
// something else entirely.
const { marked } = await import('../node_modules/marked/lib/marked.esm.js')
const render = md => marked.parse(ed._normaliseIndentForRender(md), { gfm: true })
    .replace(/\n+/g, ' ').trim()

console.log('\n── Rendered output after Enter at the start of an item ──')
{
    const after = press('Enter', 'Some intro\n- |foo').replace('|', '')
    const html = render(after)
    ok('a new bullet above a list after prose does not make an H2',
        !html.includes('<h2>'), `editor produced ${JSON.stringify(after)} -> ${html}`)
    ok('the paragraph survives as a paragraph', html.includes('<p>Some intro</p>'), html)
    ok('both items are present', (html.match(/<li>/g) || []).length === 2, html)
}
{
    const after = press('Enter', 'Some intro\n1. |foo').replace('|', '')
    const html = render(after)
    ok('the ordered variant does not swallow the marker into the paragraph',
        !/Some intro\s*1\./.test(html), `editor produced ${JSON.stringify(after)} -> ${html}`)
}
{
    const after = press('Enter', '- one\n- |two').replace('|', '')
    ok('inside an existing list no blank separator is added',
        after === '- one\n- \n- two', JSON.stringify(after))
}

console.log('\n── Rendered output for an empty task item ──')
{
    const after = press('Enter', '- [ ] |buy milk').replace('|', '')
    const html = render(after)
    ok('the empty task renders as a checkbox, not literal "[ ]"',
        !html.includes('[ ]') && (html.match(/type="checkbox"/g) || []).length === 2, html)
}

console.log('\n── Tab on a loose list (blank lines between items) ──')
T('indents an item that follows a blank line', 'Tab',
    '- one\n\n- |two', '- one\n\n\t- |two')
T('still refuses when prose sits between', 'Tab',
    '- one\n\nsome prose\n\n- |two', '- one\n\nsome prose\n\n- |two')

console.log('\n── Code fences are code, not structure ──')
T('Enter inside a fence does not continue a numbered list', 'Enter',
    '```\n1. do the thing|\n```', '```\n1. do the thing|\n```')
T('Backspace inside a fence keeps the bullet', 'Backspace',
    '```\n- |code\n```', '```\n- |code\n```')
T('Tab inside a fence indents the line instead of nesting it', 'Tab',
    '- one\n\n```\n- |code\n```', '- one\n\n```\n\t- |code\n```')

console.log('\n── Backspace outdent takes the sub-items with it ──')
T('children follow the item up a level', 'Backspace',
    '- a\n\t- |b\n\t\t- c\n\t\t- d', '- a\n- |b\n\t- c\n\t- d')
T('dropping a top-level marker lifts its children too', 'Backspace',
    '- |a\n\t- b', '|a\n- b')

console.log('\n── 2-space indentation (what most Markdown tools emit) ──')
T('Tab moves the whole subtree, not just the item', 'Tab',
    '- a\n  - b\n  - |c\n    - c1', '- a\n  - b\n\t  - |c\n\t    - c1')
T('Shift+Tab keeps the grandchild attached', 'Tab',
    '- parent\n  - |child\n    - grandchild', '- parent\n- |child\n  - grandchild', { shift: true })

console.log('\n── One keystroke, one undo step ──')
{
    const ta = fake('1. one\n2. |two\n3. three')
    ed._handleEditorKeydown({
        key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
        preventDefault() {},
    }, ta)
    ok('Enter in an ordered list touches the textarea once', ta.inputs === 1,
        `${ta.inputs} edits -> ${JSON.stringify(ta.value)}`)
    ok('and the run is still resequenced',
        ta.value === '1. one\n2. \n3. two\n4. three', JSON.stringify(ta.value))
}

console.log('\n── A selection that starts inside a code fence ──')
{
    const ta = fake('```\nco«de A\ncode B\n```\nafter»')
    ed._indentSelection(ta, false)
    ok('Tab indents the prose and leaves the code alone',
        ta.value === '```\ncode A\ncode B\n```\n\tafter', JSON.stringify(ta.value))
}
{
    const ta = fake('```\nco«de A\n```\nafter»')
    ed._toggleList(ta, 'ul')
    ok('the list toggle bullets the prose, not the code',
        ta.value === '```\ncode A\n```\n- after', JSON.stringify(ta.value))
}

console.log('\n── Toggling a list ──')
{
    const ta = fake('some pr|ose')
    ed._toggleList(ta, 'ul')
    ok('leaves a caret behind, not the whole line selected',
        show(ta) === '- some pr|ose', show(ta))
}
{
    const ta = fake('«alpha\n\tbeta\n\tgamma\ndelta»')
    ed._toggleList(ta, 'ol')
    ok('numbers each nesting level from 1',
        ta.value === '1. alpha\n\t1. beta\n\t2. gamma\n2. delta', JSON.stringify(ta.value))
}

console.log('\n── Tasks written with wider markers ──')
{
    const ta = fake('«- [ ] a\n-  [ ] b\n1. [ ] c»')
    ed._toggleDone(ta)
    ok('every task in the selection ticks',
        ta.value === '- [x] a\n-  [x] b\n1. [x] c', JSON.stringify(ta.value))
}
{
    const md = '- [ ] a\n-  [ ] b\n- [ ] c'
    const boxes = (render(md).match(/type="checkbox"/g) || []).length
    const ta = fake('«' + md + '»')
    ed._toggleDone(ta)
    const ticked = (ta.value.match(/\[x\]/g) || []).length
    ok('the editor sees every task the preview draws a checkbox for',
        boxes === ticked, `${boxes} checkboxes rendered, ${ticked} source lines ticked`)
}

console.log('\n── Preprocessing leaves code alone ──')
{
    const md = '# Title\n\n```c\n#include <stdio.h>\nif (a == b) printf("x\\ny");\n```\n\nA #tag and ==mark== in prose.\n'
    const out = ed._outsideCode(md, t => ed._preprocessMarkdown(ed._normaliseMath(t)))
    ok('the fenced code comes through verbatim',
        out.includes('#include <stdio.h>') && out.includes('if (a == b) printf("x\\ny");'), out)
    ok('prose outside the fence is still rewritten',
        out.includes('tag-pill') && out.includes('<mark>mark</mark>'), out)
}
{
    const line = 'Use `#define` and `a == b` inline.\n'
    const out = ed._outsideCode(line, t => ed._preprocessMarkdown(ed._normaliseMath(t)))
    ok('inline code spans are spared too', out === line, JSON.stringify(out))
}

// ── Preview checkbox -> source line mapping ───────────────────
// The renderer draws a checkbox for a bare "- [ ]" too, so the source scanner
// has to count that line or every checkbox below it ticks the wrong task.
console.log('\n── Clicking a checkbox in the preview ──')
{
    const NOTE = '- [ ] alpha\n- [ ]\n- [ ] gamma\n- [x] delta\n'
    const html = render(NOTE)
    const rendered = (html.match(/type="checkbox"/g) || []).length
    ok('the renderer draws one checkbox per task line', rendered === 4, `${rendered} in ${html}`)

    // Simulate clicking the Nth rendered checkbox and see which line changes.
    const toggled = n => {
        const ta = new FakeTextarea(NOTE, 0)
        globalThis.__ta = ta
        const boxes = Array.from({ length: 4 }, (_, i) => ({ i }))
        const fake = boxes[n]
        fake.closest = sel => (sel === '.embed-block' ? null : {
            querySelectorAll: () => boxes.map(b => Object.assign(b, {
                closest: s2 => (s2 === '.embed-block' ? null : {}),
            })),
        })
        ed._syncCheckboxToEditor(fake, ta)
        const before = NOTE.split('\n'), after = ta.value.split('\n')
        return before.findIndex((l, i) => l !== after[i])
    }
    ok('clicking box 0 toggles line 0', toggled(0) === 0, `line ${toggled(0)}`)
    ok('clicking box 2 toggles line 2, not line 1', toggled(2) === 2, `line ${toggled(2)}`)
    ok('clicking box 3 toggles line 3', toggled(3) === 3, `line ${toggled(3)}`)
}

console.log('\n── The render normalizer preserves what it should ──')
{
    const hb = render('line one  \nline two\n')
    ok('a two-space hard break survives to the preview', hb.includes('<br'), hb)
    const code = render('para\n\n    - not a bullet\n    - still code\n')
    ok('an indented code block is not turned into a list',
        code.includes('<pre') && !/<ul>/.test(code), code)
    const thematic = render('a\n\n* * *\n\nb\n')
    ok('a spaced thematic break still renders as a rule', thematic.includes('<hr'), thematic)
}

console.log('\n── Auto-pairs: type-through and apostrophes ──')
T('typing the closer steps over the auto-inserted one', ')', '(a note|)', '(a note)|')
T('typing ] steps over it too', ']', '[link|]', '[link]|')
press("'", 'don|')
ok('an apostrophe after a word is left to the browser, not paired', !lastPrevented)
press("'", 'he said |')
ok('a quote after a space is handled as a pair', lastPrevented)
T('a quote after a space still pairs', '"', 'he said |', 'he said "|"')
T('an opening bracket still pairs', '(', 'call|', 'call(|)')

console.log('\n── Tab on the last item of a note ──')
{
    // The renumber op for "the run left behind" pointed past the end of the
    // text; falling through to line 0 resequenced the run at the TOP.
    const before = '7. seven\n8. eight\n\nnotes\n\n1. a\n2. b|'
    const after = press('Tab', before)
    ok('the untouched run at the top keeps its numbering',
        after.startsWith('7. seven\n8. eight'), JSON.stringify(after))
}

console.log('\n── Checkbox mapping with a quoted checklist above ──')
{
    const NOTE = '> - [ ] quoted\n\n- [ ] mine\n- [ ] also mine\n'
    const html = render(NOTE)
    const rendered = (html.match(/type="checkbox"/g) || []).length
    const ta = new FakeTextarea(NOTE, 0)
    globalThis.__ta = ta
    const boxes = Array.from({ length: rendered }, (_, i) => ({ i }))
    boxes.forEach(b => {
        b.closest = sel => (sel === '.embed-block' ? null : {
            querySelectorAll: () => boxes,
        })
    })
    ed._syncCheckboxToEditor(boxes[rendered - 1], ta)
    const changed = NOTE.split('\n').findIndex((l, i) => l !== ta.value.split('\n')[i])
    ok('the last checkbox toggles the last task line',
        changed === 3, `rendered=${rendered} changed line ${changed}`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)

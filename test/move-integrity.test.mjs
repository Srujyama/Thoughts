// Exercises the real src/api.js move paths against an in-memory stand-in for
// Cloud Storage. These are the paths that lost a 15,779-byte note on
// 2026-09-15, so they are tested against the shipped code rather than a model
// of it: api.js is bundled with the Firebase modules aliased to stubs.
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'thoughts-test-'))

// ── The fake bucket ───────────────────────────────────────────
const bucket = new Map()          // objectPath -> string
let uploads = 0, deletes = 0
const UID = 'u1'

fs.writeFileSync(path.join(tmp, 'stub-storage.js'), `
export function ref(_s, p) { return { fullPath: p } }
export async function listAll(r) {
    const prefix = r.fullPath.replace(/\\/?$/, '/')
    const items = [], prefixes = new Set()
    for (const k of globalThis.__bucket.keys()) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        if (rest.includes('/')) prefixes.add({ fullPath: prefix + rest.split('/')[0] })
        else items.push({ fullPath: k })
    }
    return { items, prefixes: [...prefixes] }
}
export async function getMetadata() { return {} }
export async function uploadString(r, content) {
    await globalThis.__onUpload()          // awaited so a test can delay one upload
    globalThis.__bucket.set(r.fullPath, String(content))
}
export async function deleteObject(r) {
    globalThis.__onDelete()
    if (!globalThis.__bucket.has(r.fullPath)) {
        const e = new Error('not found'); e.code = 'storage/object-not-found'; throw e
    }
    globalThis.__bucket.delete(r.fullPath)
}
`)
fs.writeFileSync(path.join(tmp, 'stub-auth.js'), `
export async function signInWithEmailAndPassword() { throw new Error('nope') }
export async function createUserWithEmailAndPassword() { throw new Error('nope') }
export async function signOut() {}
`)
fs.writeFileSync(path.join(tmp, 'stub-firebase.js'), `
const user = { uid: '${UID}', email: 'a@b.c', getIdToken: async () => 'tok' }
export const fbAuth = { currentUser: user }
export const storage = { app: { options: { storageBucket: 'test-bucket' } } }
export const authReady = Promise.resolve(user)
export async function signInWithGoogle() { return user }
`)

// ── Browser globals api.js/cache.js expect ────────────────────
const store = new Map()
globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
}
globalThis.__bucket = bucket
globalThis.__onUpload = () => { uploads++ }
globalThis.__onDelete = () => { deletes++ }
globalThis.window = { addEventListener() {} }
globalThis.document = { addEventListener() {}, visibilityState: 'visible', hidden: false }
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0)
globalThis.requestIdleCallback = undefined
globalThis.indexedDB = undefined          // cache.js degrades to its memory Map
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'id-' + Math.random() }, configurable: true })

// _readViaRest / _listViaRest go over fetch.
globalThis.fetch = async (url) => {
    const u = new URL(url)
    const m = u.pathname.match(/\/o\/([^?]+)$/)
    if (m && u.searchParams.get('alt') === 'media') {
        const name = decodeURIComponent(m[1])
        if (!bucket.has(name)) return { ok: false, status: 404, async text() { return 'nf' } }
        return { ok: true, status: 200, async text() { return bucket.get(name) } }
    }
    // listing
    const prefix = u.searchParams.get('prefix') || ''
    return {
        ok: true, status: 200,
        async json() {
            return { items: [...bucket.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }
        },
    }
}

const entry = path.join(tmp, 'entry.js')
fs.writeFileSync(entry, `
export * from ${JSON.stringify(pathToFileURL(path.join(root, 'src/api.js')).pathname)}
export { contentCache } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/cache.js')).pathname)}
`)
const out = path.join(tmp, 'api.bundle.mjs')
await esbuild.build({
    entryPoints: [entry],
    bundle: true, format: 'esm', outfile: out, platform: 'neutral',
    alias: {
        'firebase/auth': path.join(tmp, 'stub-auth.js'),
        'firebase/storage': path.join(tmp, 'stub-storage.js'),
    },
    plugins: [{
        name: 'fb', setup(b) {
            b.onResolve({ filter: /\/firebase\.js$|^\.\/firebase\.js$/ },
                () => ({ path: path.join(tmp, 'stub-firebase.js') }))
        },
    }],
    logLevel: 'silent',
})

const api = await import(pathToFileURL(out).href)
const { foldersAPI, filesAPI, contentCache, auth, offlineQueue, trashAPI } = api

// ── Helpers ───────────────────────────────────────────────────
let pass = 0, fail = 0
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '\n       ' + detail : ''}`) }
}
function obj(p) { return bucket.get(`${UID}/${p}`) }
// api.js keeps an in-memory meta cache keyed by user, and pins its localStorage
// keys to the last signed-in uid so that an expiring session cannot strand a
// rescue copy under the "anon" key. Signing out is what clears that pin, so it
// is also what lets the next case start from an empty meta — dropping nc_user
// alone no longer changes which key is read.
async function reset() {
    await new Promise(r => setTimeout(r, 5))   // let any coalesced meta write land
    bucket.clear(); store.clear(); uploads = 0; deletes = 0
    await auth.logout()
    foldersAPI.list()                          // forces a re-read under the anon key
    await new Promise(r => setTimeout(r, 5))
    store.clear()
    contentCache.setUser('anon'); contentCache.setUser(UID)
}
function seedMeta(folders) {
    store.set(`nc_vault_meta_${UID}`, JSON.stringify({ folders }))
    store.set('nc_user', JSON.stringify({ user_id: UID, email: 'a@b.c' }))
}

// ══ 1. The exact scenario that destroyed long-note.md ═════════
// A note whose body was never loaded into memory and is not in the cache:
// the old code wrote '' to the destination and deleted the original.
console.log('\n── File move with an unloaded body (the long-note.md case) ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'long note', path: 'main/long-note.md', content: '', contentLoaded: false },
        ] },
        { id: 'F2', name: 'lists', path: 'main/lists', parentId: 'F1', files: [] },
    ])
    const BODY = '# heading\n- an item\n'.repeat(500)        // a long, real note
    bucket.set(`${UID}/main/long-note.md`, BODY)

    await filesAPI.move('F1', 'N1', 'F2')
    check('destination holds the full body', obj('main/lists/long-note.md') === BODY,
        `got ${JSON.stringify(String(obj('main/lists/long-note.md')).slice(0, 40))} (${(obj('main/lists/long-note.md') || '').length} bytes, expected ${BODY.length})`)
    check('original is gone', obj('main/long-note.md') === undefined)
    check('meta points at the new path',
        foldersAPI.list().find(f => f.id === 'F2').files[0].path === 'main/lists/long-note.md')
}

// ══ 2. A stale cache must not win over the cloud (edited-note.md) ══
console.log('\n── File move when the cache holds an older body (the edited-note.md case) ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'edited note', path: 'main/edited-note.md', content: 'OLD SHORT BODY', contentLoaded: false },
        ] },
        { id: 'F2', name: 'lists', path: 'main/lists', parentId: 'F1', files: [] },
    ])
    const CLOUD = 'line A\nline B\nline C\nline D — added on another device\n'
    bucket.set(`${UID}/main/edited-note.md`, CLOUD)
    // A stale cache entry is seeded through the bundle's own cache instance so
    // the code under test really reads it.
    contentCache.set('main/edited-note.md', 'OLD SHORT BODY')

    await filesAPI.move('F1', 'N1', 'F2')
    check('the cloud body wins over the stale cache', obj('main/lists/edited-note.md') === CLOUD,
        `got ${JSON.stringify(String(obj('main/lists/edited-note.md')))}`)
}

// ══ 3. A move must never delete when the copy did not land ═════
console.log('\n── A move that cannot copy must not delete ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
        { id: 'F2', name: 'lists', path: 'main/lists', parentId: 'F1', files: [] },
    ])
    bucket.set(`${UID}/main/note.md`, 'precious')
    const realUpload = globalThis.__onUpload
    globalThis.__onUpload = () => { throw new Error('storage is down') }
    let threw = false
    try { await filesAPI.move('F1', 'N1', 'F2') } catch { threw = true }
    globalThis.__onUpload = realUpload
    check('the move reports the failure', threw)
    check('the original survives', obj('main/note.md') === 'precious')
}

// ══ 4. Folder move relocates descendants AND their objects ═════
console.log('\n── Folder move (the "moving subfolders removes file contents" report) ──')
{
    await reset()
    seedMeta([
        { id: 'A', name: 'main', path: 'main', parentId: null, files: [] },
        { id: 'B', name: 'coding', path: 'main/coding', parentId: 'A', files: [] },
        { id: 'S', name: 'archive', path: 'main/archive', parentId: 'A', files: [
            { id: 'N1', title: 'random', path: 'main/archive/random.md', content: '', contentLoaded: false },
        ] },
        { id: 'S2', name: 'deep', path: 'main/archive/deep', parentId: 'S', files: [
            { id: 'N2', title: 'notes', path: 'main/archive/deep/notes.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/archive/.keep`, '')
    bucket.set(`${UID}/main/archive/random.md`, 'RANDOM BODY')
    bucket.set(`${UID}/main/archive/deep/.keep`, '')
    bucket.set(`${UID}/main/archive/deep/notes.md`, 'DEEP BODY')

    await foldersAPI.move('S', 'B')

    check('the folder itself moved in storage', obj('main/coding/archive/.keep') !== undefined)
    check('its note moved WITH its content', obj('main/coding/archive/random.md') === 'RANDOM BODY',
        `got ${JSON.stringify(obj('main/coding/archive/random.md'))}`)
    check('the nested subfolder moved too', obj('main/coding/archive/deep/.keep') !== undefined)
    check('the nested note moved with its content', obj('main/coding/archive/deep/notes.md') === 'DEEP BODY',
        `got ${JSON.stringify(obj('main/coding/archive/deep/notes.md'))}`)
    check('no object left behind at the old prefix',
        ![...bucket.keys()].some(k => k.startsWith(`${UID}/main/archive/`)),
        `left: ${[...bucket.keys()].filter(k => k.startsWith(`${UID}/main/archive/`)).join(', ')}`)

    const folders = foldersAPI.list()
    check('descendant folder meta was repointed',
        folders.find(f => f.id === 'S2').path === 'main/coding/archive/deep',
        `got ${folders.find(f => f.id === 'S2').path}`)
    check('file meta was repointed',
        folders.find(f => f.id === 'S2').files[0].path === 'main/coding/archive/deep/notes.md')
}

// ══ 5. A failing folder move leaves the original tree intact ═══
console.log('\n── A folder move that fails half-way must not destroy anything ──')
{
    await reset()
    seedMeta([
        { id: 'A', name: 'main', path: 'main', parentId: null, files: [] },
        { id: 'B', name: 'dest', path: 'main/dest', parentId: 'A', files: [] },
        { id: 'S', name: 'src', path: 'main/src', parentId: 'A', files: [
            { id: 'N1', title: 'one', path: 'main/src/one.md', content: '', contentLoaded: false },
            { id: 'N2', title: 'two', path: 'main/src/two.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/src/.keep`, '')
    bucket.set(`${UID}/main/src/one.md`, 'ONE')
    bucket.set(`${UID}/main/src/two.md`, 'TWO')

    let n = 0
    const realUpload = globalThis.__onUpload
    globalThis.__onUpload = () => { if (++n > 2) throw new Error('storage died mid-move') }
    let threw = false
    try { await foldersAPI.move('S', 'B') } catch { threw = true }
    globalThis.__onUpload = realUpload

    check('the failure is reported', threw)
    check('both originals survive', obj('main/src/one.md') === 'ONE' && obj('main/src/two.md') === 'TWO',
        `one=${JSON.stringify(obj('main/src/one.md'))} two=${JSON.stringify(obj('main/src/two.md'))}`)
    check('no half-written copies were left at the destination',
        ![...bucket.keys()].some(k => k.startsWith(`${UID}/main/dest/src/`)),
        `left: ${[...bucket.keys()].filter(k => k.startsWith(`${UID}/main/dest/src/`)).join(', ')}`)
}

// ══ 5b. A folder move must not overwrite an unsynced note ══════
console.log('\n── Folder move into a destination holding an unknown note ──')
{
    await reset()
    seedMeta([
        { id: 'A', name: 'main', path: 'main', parentId: null, files: [] },
        { id: 'B', name: 'dest', path: 'main/dest', parentId: 'A', files: [] },
        { id: 'S', name: 'src', path: 'main/src', parentId: 'A', files: [
            { id: 'N1', title: 'notes', path: 'main/src/notes.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/src/.keep`, '')
    bucket.set(`${UID}/main/src/notes.md`, 'MINE')
    bucket.set(`${UID}/main/dest/.keep`, '')
    // Written by another device, so it is absent from this browser's meta.
    bucket.set(`${UID}/main/dest/src/notes.md`, 'FROM ANOTHER DEVICE')

    await foldersAPI.move('S', 'B')

    check('the note this browser never saw is left intact',
        obj('main/dest/src/notes.md') === 'FROM ANOTHER DEVICE',
        `got ${JSON.stringify(obj('main/dest/src/notes.md'))}`)
    check('the moved note lands beside it under a free name',
        obj('main/dest/src/notes-2.md') === 'MINE',
        `keys: ${[...bucket.keys()].filter(k => k.includes('/dest/')).join(', ')}`)
}

// ══ 5c. Two moves at once must not evict a bystander ═══════════
console.log('\n── Two concurrent file moves out of one folder ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'A', title: 'a', path: 'main/a.md', content: '', contentLoaded: false },
            { id: 'B', title: 'b', path: 'main/b.md', content: '', contentLoaded: false },
            { id: 'C', title: 'c', path: 'main/c.md', content: '', contentLoaded: false },
        ] },
        { id: 'F2', name: 'lists', path: 'main/lists', parentId: 'F1', files: [] },
    ])
    bucket.set(`${UID}/main/a.md`, 'AAA')
    bucket.set(`${UID}/main/b.md`, 'BBB')
    bucket.set(`${UID}/main/c.md`, 'CCC')

    await Promise.all([
        filesAPI.move('F1', 'A', 'F2'),
        filesAPI.move('F1', 'C', 'F2'),
    ])

    const folders = foldersAPI.list()
    const left = folders.find(f => f.id === 'F1').files.map(f => f.id)
    const moved = folders.find(f => f.id === 'F2').files.map(f => f.id).sort()
    check('the note nobody moved is still in its folder', left.join(',') === 'B', `left: ${left.join(',')}`)
    check('both moved notes landed', moved.join(',') === 'A,C', `moved: ${moved.join(',')}`)
    check('the bystander keeps its body', obj('main/b.md') === 'BBB', `got ${JSON.stringify(obj('main/b.md'))}`)
}

// ══ 5d. Retitling in the editor must reach storage ═════════════
console.log('\n── Editor save that also changes the title ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'draft', path: 'main/draft.md', content: 'old body', contentLoaded: true },
        ] },
    ])
    bucket.set(`${UID}/main/draft.md`, 'old body')

    await filesAPI.update('F1', 'N1', { title: 'Shipping Plan', content: 'new body' })

    const file = foldersAPI.list().find(f => f.id === 'F1').files[0]
    check('the object moved to a path derived from the new title',
        file.path !== 'main/draft.md' && obj(file.path) === 'new body',
        `path=${file.path} body=${JSON.stringify(obj(file.path))}`)
    check('the old object is gone', obj('main/draft.md') === undefined)
    check('the new title is recorded', file.title === 'Shipping Plan', file.title)
}

// ══ 5e. Creating a note must not clobber an unsynced one ═══════
console.log('\n── New note whose name is already taken in the cloud ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [] }])
    // Written by another device, so this browser's meta knows nothing about it.
    bucket.set(`${UID}/main/groceries.md`, 'EIGHT THOUSAND BYTES OF SHOPPING')

    const made = await filesAPI.create('F1', 'Groceries', '')
    check('the existing note is untouched',
        obj('main/groceries.md') === 'EIGHT THOUSAND BYTES OF SHOPPING',
        `got ${JSON.stringify(obj('main/groceries.md'))}`)
    check('the new note took a free name', made.path === 'main/groceries-2.md', made.path)
}
console.log('\n── Importing a .md over an unsynced note of the same name ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [] }])
    bucket.set(`${UID}/main/notes.md`, 'THE REAL NOTE')

    await filesAPI.create('F1', 'notes', 'imported junk')
    await new Promise(r => setTimeout(r, 5))   // create uploads in the background
    check('the import does not overwrite it', obj('main/notes.md') === 'THE REAL NOTE',
        `got ${JSON.stringify(obj('main/notes.md'))}`)
    check('the import landed beside it', obj('main/notes-2.md') === 'imported junk',
        `keys: ${[...bucket.keys()].join(', ')}`)
}

// ══ 5f. A lost DELETE response must not destroy both copies ════
console.log('\n── The source delete is applied but the response is lost ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
        { id: 'F2', name: 'lists', path: 'main/lists', parentId: 'F1', files: [] },
    ])
    const BODY = 'fifteen thousand bytes of irreplaceable notes'
    bucket.set(`${UID}/main/note.md`, BODY)

    // Delete removes the object, then reports a network failure anyway.
    const realDelete = globalThis.__onDelete
    globalThis.__onDelete = () => {}
    const origDel = bucket.delete.bind(bucket)
    let armed = true
    bucket.delete = (k) => {
        const r = origDel(k)
        if (armed && k === `${UID}/main/note.md`) {
            armed = false
            const e = new Error('Max retry time exceeded')
            e.code = 'storage/retry-limit-exceeded'
            throw e
        }
        return r
    }
    let threw = false
    try { await filesAPI.move('F1', 'N1', 'F2') } catch { threw = true }
    bucket.delete = origDel
    globalThis.__onDelete = realDelete

    check('the note still exists somewhere',
        obj('main/lists/note.md') === BODY || obj('main/note.md') === BODY,
        `new=${JSON.stringify(obj('main/lists/note.md'))} old=${JSON.stringify(obj('main/note.md'))} threw=${threw}`)
    check('specifically, the verified copy was kept', obj('main/lists/note.md') === BODY,
        `got ${JSON.stringify(obj('main/lists/note.md'))}`)
}

// ══ 7. The recycle bin ═════════════════════════════════════════
console.log('\n── Deleting a note puts it in the recycle bin ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [
        { id: 'N1', title: 'keepme', path: 'main/keepme.md', content: '', contentLoaded: false },
    ] }])
    bucket.set(`${UID}/main/keepme.md`, 'PRECIOUS')

    await filesAPI.delete('F1', 'N1')
    check('the note is out of its folder', obj('main/keepme.md') === undefined)
    check('the record is gone from meta',
        foldersAPI.list().find(f => f.id === 'F1').files.length === 0)

    const items = await trashAPI.list()
    check('the bin holds exactly one item', items.length === 1, JSON.stringify(items.map(i => i.trashPath)))
    check('it remembers where it came from', items[0]?.originalPath === 'main/keepme.md', items[0]?.originalPath)
    check('its body is intact', bucket.get(`${UID}/${items[0]?.trashPath}`) === 'PRECIOUS')
    check('it is not treated as a vault note',
        !foldersAPI.list().some(f => f.path.startsWith('.trash')),
        foldersAPI.list().map(f => f.path).join(', '))
}

console.log('\n── Restoring puts it back where it was ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [
        { id: 'N1', title: 'notes', path: 'main/notes.md', content: '', contentLoaded: false },
    ] }])
    bucket.set(`${UID}/main/notes.md`, 'BODY TEXT')
    await filesAPI.delete('F1', 'N1')
    const [item] = await trashAPI.list()

    const res = await trashAPI.restore(item.trashPath)
    check('the note is back at its original path', obj('main/notes.md') === 'BODY TEXT',
        `restored to ${res.path}: ${JSON.stringify(obj('main/notes.md'))}`)
    check('the bin copy is gone', bucket.get(`${UID}/${item.trashPath}`) === undefined)
    check('the bin is empty', (await trashAPI.list()).length === 0)
    check('the folder lists it again',
        foldersAPI.list().find(f => f.path === 'main').files.some(f => f.path === 'main/notes.md'))
}

console.log('\n── Restoring over a name that is taken again ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [
        { id: 'N1', title: 'notes', path: 'main/notes.md', content: '', contentLoaded: false },
    ] }])
    bucket.set(`${UID}/main/notes.md`, 'THE OLD ONE')
    await filesAPI.delete('F1', 'N1')
    const [item] = await trashAPI.list()
    bucket.set(`${UID}/main/notes.md`, 'A NEW NOTE WITH THE SAME NAME')

    const res = await trashAPI.restore(item.trashPath)
    check('the newer note is untouched', obj('main/notes.md') === 'A NEW NOTE WITH THE SAME NAME',
        JSON.stringify(obj('main/notes.md')))
    check('the restored copy took a free name', obj('main/notes-2.md') === 'THE OLD ONE' && res.renamed,
        `res.path=${res.path}`)
}

console.log('\n── Deleting a folder bins its notes ──')
{
    await reset()
    seedMeta([
        { id: 'A', name: 'main', path: 'main', parentId: null, files: [] },
        { id: 'S', name: 'sub', path: 'main/sub', parentId: 'A', files: [
            { id: 'N1', title: 'one', path: 'main/sub/one.md', content: '', contentLoaded: false },
            { id: 'N2', title: 'two', path: 'main/sub/two.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/sub/.keep`, '')
    bucket.set(`${UID}/main/sub/one.md`, 'ONE')
    bucket.set(`${UID}/main/sub/two.md`, 'TWO')

    await foldersAPI.delete('S')
    const items = await trashAPI.list()
    check('both notes are in the bin', items.length === 2, items.map(i => i.originalPath).join(', '))
    const bodies = items.map(i => bucket.get(`${UID}/${i.trashPath}`)).sort()
    check('with their bodies', bodies.join(',') === 'ONE,TWO', bodies.join(','))
    check('the folder marker is gone for good', obj('main/sub/.keep') === undefined)
    check('the folder record is gone', !foldersAPI.list().some(f => f.id === 'S'))
}

console.log('\n── Retention ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [] }])
    const DAY = 24 * 60 * 60 * 1000
    const enc = p => btoa(p).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fresh = `.trash/${Date.now() - 29 * DAY}__${enc('main/fresh.md')}.md`
    const stale = `.trash/${Date.now() - 31 * DAY}__${enc('main/stale.md')}.md`
    bucket.set(`${UID}/${fresh}`, 'STILL HERE')
    bucket.set(`${UID}/${stale}`, 'PAST ITS WINDOW')

    const items = await trashAPI.list()
    check(`an item ${trashAPI.retentionDays - 1} days old is still listed`,
        items.length === 1 && items[0].originalPath === 'main/fresh.md',
        items.map(i => i.originalPath).join(', '))
    check(`one past ${trashAPI.retentionDays} days is swept`,
        bucket.get(`${UID}/${stale}`) === undefined)
    check('the fresh one survives the sweep', bucket.get(`${UID}/${fresh}`) === 'STILL HERE')
    check('it reports when it expires',
        Math.round((items[0].expiresAt - items[0].deletedAt) / DAY) === trashAPI.retentionDays,
        String(items[0].expiresAt - items[0].deletedAt))
}

console.log('\n── A delete that cannot be binned leaves the note alone ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [
        { id: 'N1', title: 'safe', path: 'main/safe.md', content: '', contentLoaded: false },
    ] }])
    bucket.set(`${UID}/main/safe.md`, 'DO NOT LOSE ME')
    const realUpload = globalThis.__onUpload
    globalThis.__onUpload = () => { throw new Error('storage is down') }
    let threw = false
    try { await filesAPI.delete('F1', 'N1') } catch { threw = true }
    globalThis.__onUpload = realUpload
    check('the delete reports the failure', threw)
    check('the note is still there', obj('main/safe.md') === 'DO NOT LOSE ME',
        JSON.stringify(obj('main/safe.md')))
}

// ══ 6. A folder cannot swallow itself ══════════════════════════
console.log('\n── Guards ──')
{
    await reset()
    seedMeta([
        { id: 'A', name: 'a', path: 'a', parentId: null, files: [] },
        { id: 'B', name: 'b', path: 'a/b', parentId: 'A', files: [] },
    ])
    let threw = false
    try { await foldersAPI.move('A', 'B') } catch { threw = true }
    check('refuses to move a folder into its own descendant', threw)
}

// ══ 7. A delete must take the note's queued write with it ══════
console.log('\n── Deleting a note with a queued write ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/note.md`, 'BODY')
    offlineQueue.enqueue('main/note.md', 'AN EDIT THAT NEVER UPLOADED')

    await filesAPI.delete('F1', 'N1')
    check('the queue no longer holds the deleted note',
        !offlineQueue.getPending().includes('main/note.md'))
    await offlineQueue.flush()
    check('a later flush does not resurrect it', obj('main/note.md') === undefined,
        `got ${JSON.stringify(obj('main/note.md'))}`)
}

// ══ 8. …but a delete that fails must keep the rescue copy ══════
console.log('\n── A delete that fails keeps the queued edit ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/note.md`, 'BODY')
    offlineQueue.enqueue('main/note.md', 'UNSAVED WORK')

    const realDelete = globalThis.__onDelete
    globalThis.__onDelete = () => { throw new Error('storage is down') }
    let threw = false
    try { await filesAPI.delete('F1', 'N1') } catch { threw = true }
    globalThis.__onDelete = realDelete

    check('the failure is reported', threw)
    check('the note still exists, so its unsaved edit is still queued',
        offlineQueue.getPending().includes('main/note.md'))
}

// ══ 9. A queued write for a note this browser lost is not replayed ══
console.log('\n── A stale queue entry cannot recreate a note ──')
{
    await reset()
    seedMeta([{ id: 'F1', name: 'main', path: 'main', parentId: null, files: [] }])
    offlineQueue.enqueue('main/deleted-elsewhere.md', 'ZOMBIE')

    const written = await offlineQueue.flush()
    check('the entry is not uploaded', obj('main/deleted-elsewhere.md') === undefined && written === 0,
        `wrote ${written}, object ${JSON.stringify(obj('main/deleted-elsewhere.md'))}`)
    check('and it is dropped rather than retried forever',
        !offlineQueue.getPending().includes('main/deleted-elsewhere.md'))
}

// ══ 10. A folder delete covers objects this browser never synced ══
console.log('\n── Folder delete against the cloud, not just local meta ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'archive', path: 'archive', parentId: null, files: [
            { id: 'N1', title: 'known', path: 'archive/known.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/archive/.keep`, '')
    bucket.set(`${UID}/archive/known.md`, 'KNOWN')
    bucket.set(`${UID}/archive/from-phone.md`, 'MADE ON ANOTHER DEVICE')
    bucket.set(`${UID}/archive/sub/.keep`, '')
    bucket.set(`${UID}/archive/sub/deep.md`, 'ALSO UNKNOWN HERE')

    await foldersAPI.delete('F1')
    check('nothing survives under the deleted prefix',
        ![...bucket.keys()].some(k => k.startsWith(`${UID}/archive/`)),
        `left: ${[...bucket.keys()].filter(k => k.startsWith(`${UID}/archive/`)).join(', ')}`)
    check('the folder record is gone', !foldersAPI.list().some(f => f.id === 'F1'))
}

// ══ 11. A folder delete that can't finish says so ══════════════
console.log('\n── A folder delete that cannot remove everything ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'archive', path: 'archive', parentId: null, files: [
            { id: 'N1', title: 'one', path: 'archive/one.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/archive/.keep`, '')
    bucket.set(`${UID}/archive/one.md`, 'ONE')

    const realDelete = globalThis.__onDelete
    globalThis.__onDelete = () => { throw new Error('storage is down') }
    let threw = false
    try { await foldersAPI.deleteWithProgress('F1', () => {}) } catch { threw = true }
    globalThis.__onDelete = realDelete

    check('the failure is reported', threw)
    check('the folder is still there to retry', foldersAPI.list().some(f => f.id === 'F1'))
    check('its notes are still in storage', obj('archive/one.md') === 'ONE')
}

// ══ 12. A move must not overwrite a note it has never seen ═════
console.log('\n── Move into a folder holding an unsynced note of the same name ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'ideas', path: 'main/ideas.md', content: '', contentLoaded: false },
        ] },
        { id: 'F2', name: 'archive', path: 'main/archive', parentId: 'F1', files: [] },
    ])
    bucket.set(`${UID}/main/ideas.md`, 'LAPTOP IDEAS')
    bucket.set(`${UID}/main/archive/ideas.md`, 'PHONE IDEAS')   // created elsewhere, not in meta

    await filesAPI.move('F1', 'N1', 'F2')
    check('the note that was already there is untouched',
        obj('main/archive/ideas.md') === 'PHONE IDEAS',
        `got ${JSON.stringify(obj('main/archive/ideas.md'))}`)
    check('the moved note took a free name', obj('main/archive/ideas-2.md') === 'LAPTOP IDEAS',
        `keys: ${[...bucket.keys()].join(', ')}`)
}

// ══ 13. Renaming a note renames the object ═════════════════════
console.log('\n── Rename reaches storage ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'commands', path: 'main/commands.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/commands.md`, 'CHEATSHEET BODY')

    await filesAPI.update('F1', 'N1', { title: 'Shell Cheatsheet' })
    check('the object moved, with its body', obj('main/shell-cheatsheet.md') === 'CHEATSHEET BODY',
        `keys: ${[...bucket.keys()].join(', ')}`)
    check('the old object is gone', obj('main/commands.md') === undefined)
    const renamed = foldersAPI.list().find(f => f.id === 'F1').files[0]
    check('meta keeps the label and follows the path',
        renamed.title === 'Shell Cheatsheet' && renamed.path === 'main/shell-cheatsheet.md',
        `got ${renamed.title} @ ${renamed.path}`)
}

// ══ 14. Revalidation must not revert an unsynced edit ══════════
console.log('\n── Opening a note whose newer body has not reached the cloud ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/note.md`, 'OLD CLOUD BODY')
    offlineQueue.enqueue('main/note.md', 'NEW LOCAL EDIT')
    contentCache.set('main/note.md', 'NEW LOCAL EDIT')

    let pushedToEditor = null
    const opened = await filesAPI.loadContent('F1', 'N1', f => { pushedToEditor = f.content })
    await new Promise(r => setTimeout(r, 20))        // let the background revalidation run
    check('the unsynced edit is what opens', opened.content === 'NEW LOCAL EDIT')
    check('the stale cloud body is not pushed into the editor', pushedToEditor === null,
        `got ${JSON.stringify(pushedToEditor)}`)
    check('and it does not overwrite the cached copy',
        contentCache.getSync('main/note.md').content === 'NEW LOCAL EDIT')
}

// ══ 15. …including when the cached copy has been evicted ═══════
console.log('\n── The same note after its cache entry is gone ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/note.md`, 'OLD CLOUD BODY')
    offlineQueue.enqueue('main/note.md', 'NEW LOCAL EDIT')

    const opened = await filesAPI.loadContent('F1', 'N1')
    check('the queued body wins over the cloud read', opened.content === 'NEW LOCAL EDIT',
        `got ${JSON.stringify(opened.content)}`)
}

// ══ 16. A flush must never land on top of a newer save ═════════
console.log('\n── A queued flush racing a foreground save ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/note.md`, 'OLD')
    offlineQueue.enqueue('main/note.md', 'OLD QUEUED BODY')

    // Hold the flush's upload open long enough for the save to be issued and
    // finish first — the ordering that used to leave the older body in place.
    const realUpload = globalThis.__onUpload
    let slowFirst = true
    globalThis.__onUpload = async () => {
        if (slowFirst) { slowFirst = false; await new Promise(r => setTimeout(r, 20)) }
        realUpload()
    }
    const flushing = offlineQueue.flush()
    await new Promise(r => setTimeout(r, 0))      // let the flush reach its upload
    const saving = filesAPI.update('F1', 'N1', { content: 'NEWEST TEXT' })
    await Promise.all([flushing, saving])
    globalThis.__onUpload = realUpload

    check('the newest text is what the cloud keeps', obj('main/note.md') === 'NEWEST TEXT',
        `got ${JSON.stringify(obj('main/note.md'))}`)
    check('the superseded entry is not left queued',
        !offlineQueue.getPending().includes('main/note.md'))
}

// ══ 17. Note bodies stay out of the localStorage meta ══════════
console.log('\n── The persisted meta carries records, not bodies ──')
{
    await reset()
    seedMeta([
        { id: 'F1', name: 'main', path: 'main', parentId: null, files: [
            { id: 'N1', title: 'note', path: 'main/note.md', content: '', contentLoaded: false },
        ] },
    ])
    bucket.set(`${UID}/main/note.md`, 'A BODY WORTH KILOBYTES')

    await filesAPI.loadContent('F1', 'N1')
    await new Promise(r => setTimeout(r, 20))        // the meta write is coalesced into a frame
    const persisted = store.get(`nc_vault_meta_${UID}`) || ''
    check('the body is not written to localStorage', !persisted.includes('A BODY WORTH KILOBYTES'),
        persisted.slice(0, 160))
    check('the record itself still is', persisted.includes('main/note.md'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)

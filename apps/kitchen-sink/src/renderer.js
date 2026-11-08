// Kitchen sink UI. Talks to the main process only through window.kitchen
// (see preload.mjs), like a context-isolated Electron renderer.
const kitchen = window.kitchen
const params = new URLSearchParams(location.search)
const smoke = params.get('smoke') === '1'

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// Checks that run in the renderer (IPC from the renderer's point of view).
const rendererChecks = [
  { id: 'contextBridge.exposeInMainWorld', run: () => { assert(typeof window.kitchen?.invoke === 'function', 'api exposed'); return 'window.kitchen' } },
  { id: 'ipcRenderer.invoke (round-trip types)', run: async () => {
    const args = [1, 'two', { three: [3] }, true, null]
    const result = await kitchen.invoke('kitchen:echo', ...args)
    assert(JSON.stringify(result) === JSON.stringify(args), JSON.stringify(result))
    return JSON.stringify(result)
  } },
  { id: 'ipcRenderer.invoke rejects when the handler throws', run: async () => {
    try {
      await kitchen.invoke('kitchen:throw')
    } catch (error) {
      assert(/boom/.test(error.message), error.message)
      return error.message
    }
    throw new Error('did not reject')
  } },
  { id: 'ipcRenderer.invoke rejects without a handler', run: async () => {
    try {
      await kitchen.invoke('kitchen:no-such-channel')
    } catch (error) {
      return error.message
    }
    throw new Error('did not reject')
  } },
  { id: 'ipcRenderer.send → event.reply → ipcRenderer.once', run: () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply')), 3000)
    kitchen.once('kitchen:pong', (value) => {
      clearTimeout(timer)
      value === 'hello' ? resolve(value) : reject(new Error(`got ${value}`))
    })
    kitchen.send('kitchen:ping', 'hello')
  }) },
  { id: 'ipcRenderer.sendSync', run: () => { const v = kitchen.sendSync('kitchen:sync'); assert(v === 'sync-ok', `got ${v}`); return v } },
  { id: 'ipcRenderer.invoke (structured clone)', run: async () => {
    const [bytes, date, map, missing, big] = await kitchen.invoke('kitchen:echo', new Uint8Array([1, 2, 255]), new Date(0), new Map([['a', 1]]), undefined, 10n)
    assert(bytes instanceof Uint8Array && bytes[2] === 255, `bytes ${bytes}`)
    assert(date instanceof Date && date.getTime() === 0, `date ${date}`)
    assert(map instanceof Map && map.get('a') === 1, 'map')
    assert(missing === undefined && big === 10n, 'undefined / bigint')
    return 'Uint8Array, Date, Map, undefined, BigInt'
  } },
  { id: 'ipcRenderer.postMessage (MessagePort → main)', run: async () => {
    const reply = await kitchen.portRoundTrip(21)
    assert(reply?.doubled === 42, JSON.stringify(reply))
    return JSON.stringify(reply)
  } },
  { id: 'BrowserWindow.loadFile({ query })', run: () => { assert(params.get('from') === 'main', location.search); return location.search } },
]

const state = new Map() // id -> { manual, where, status, detail }

function group(id) {
  return id.match(/^(new )?([A-Za-z]+)/)?.[2] ?? 'other'
}

function render() {
  const container = document.querySelector('#checks')
  const groups = new Map()
  for (const [id, entry] of state) {
    const name = group(id)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push([id, entry])
  }
  container.replaceChildren(
    ...[...groups].map(([name, rows]) => {
      const section = document.createElement('section')
      const heading = document.createElement('h2')
      heading.textContent = name
      const table = document.createElement('table')
      for (const [id, entry] of rows) {
        const tr = table.insertRow()
        tr.dataset.status = entry.status
        const button = document.createElement('button')
        button.textContent = 'Run'
        button.addEventListener('click', () => run(id))
        tr.insertCell().append(button)
        tr.insertCell().textContent = id
        const status = document.createElement('span')
        status.className = `status ${entry.status}`
        status.textContent = entry.status
        tr.insertCell().append(status)
        const detail = tr.insertCell()
        detail.className = 'detail'
        detail.textContent = entry.detail ?? ''
      }
      section.append(heading, table)
      return section
    }),
  )
  const counts = {}
  for (const entry of state.values()) counts[entry.status] = (counts[entry.status] ?? 0) + 1
  document.querySelector('#summary').textContent = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')
}

async function run(id) {
  const entry = state.get(id)
  entry.status = 'pending'
  entry.detail = 'running…'
  render()
  if (entry.where === 'main') {
    Object.assign(entry, await kitchen.runMainCheck(id))
  } else {
    if (smoke) kitchen.progress({ id, status: 'running' })
    try {
      const value = await rendererChecks.find((c) => c.id === id).run()
      Object.assign(entry, { status: 'pass', detail: typeof value === 'string' ? value : JSON.stringify(value) })
    } catch (error) {
      const unsupported = error?.name === 'NotImplementedError' || /is not (implemented|supported) /.test(error?.message)
      Object.assign(entry, { status: unsupported ? 'unsupported' : 'fail', detail: String(error?.message ?? error) })
    }
    if (smoke) kitchen.progress({ id, status: entry.status, detail: entry.detail })
  }
  render()
}

async function runAuto() {
  for (const [id, entry] of state) {
    if (!entry.manual) await run(id)
  }
}

async function init() {
  document.querySelector('#runtime').textContent = navigator.userAgent.includes('Electron') ? 'Electron' : 'Tauri (tauri-electron)'
  for (const check of rendererChecks) state.set(check.id, { where: 'renderer', manual: false, status: 'pending' })
  for (const check of await kitchen.listMainChecks()) {
    state.set(check.id, { where: 'main', manual: check.manual, status: check.manual ? 'manual' : 'pending' })
  }
  render()
  await runAuto()
  if (smoke) {
    const results = [...state].map(([id, entry]) => ({ id, ...entry }))
    await kitchen.report(results)
  }
}

document.querySelector('#run-auto').addEventListener('click', runAuto)
document.querySelector('#hide-pass').addEventListener('change', (event) => {
  document.body.classList.toggle('hide-pass', event.target.checked)
})
window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  kitchen.showContextMenu(event.clientX, event.clientY)
})

init()

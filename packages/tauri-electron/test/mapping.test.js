import { describe, expect, it, vi } from 'vitest'

// The dialog module imports the Tauri plugin; only its pure helpers are tested.
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(), message: vi.fn() }))

const { toTauriAccelerator } = await import('../src/internal/accelerator.js')
const { toOpenOptions, toMessageOptions, messageResultToIndex } = await import('../src/main/dialog.js')
const { fileToUrl, fileUrlToAppUrl } = await import('../src/main/browser-window.js')

describe('accelerators', () => {
  it('maps Electron aliases to Tauri syntax', () => {
    expect(toTauriAccelerator('CmdOrCtrl+Shift+Z')).toBe('CommandOrControl+Shift+Z')
    expect(toTauriAccelerator('CommandOrControl+Plus')).toBe('CommandOrControl+=')
    expect(toTauriAccelerator('CmdOrCtrl++')).toBe('CommandOrControl+=')
    expect(toTauriAccelerator('Option+Up')).toBe('Alt+ArrowUp')
    expect(toTauriAccelerator('Meta+Esc')).toBe('Super+Escape')
    expect(toTauriAccelerator(undefined)).toBeUndefined()
  })
})

describe('dialog option mapping', () => {
  it('maps open dialog properties', () => {
    expect(toOpenOptions({ properties: ['openDirectory', 'multiSelections'] })).toMatchObject({ directory: true, multiple: true })
    expect(toOpenOptions({ filters: [{ name: 'Images', extensions: ['.png', 'jpg'] }] }).filters).toEqual([
      { name: 'Images', extensions: ['png', 'jpg'] },
    ])
    expect(toOpenOptions({}).directory).toBe(false)
  })

  it('maps message box buttons and results', () => {
    const one = toMessageOptions({ message: 'Hi', detail: 'There', type: 'warning' })
    expect(one.text).toBe('Hi\n\nThere')
    expect(one.options).toMatchObject({ kind: 'warning', buttons: { ok: 'OK' } })
    const three = toMessageOptions({ message: 'Save?', buttons: ['Save', "Don't Save", 'Cancel'] })
    expect(three.options.buttons).toEqual({ yes: 'Save', no: "Don't Save", cancel: 'Cancel' })
    expect(messageResultToIndex("Don't Save", three.buttons)).toBe(1)
    expect(messageResultToIndex('Cancel', ['OK', 'Cancel'])).toBe(1)
    expect(messageResultToIndex('Ok', ['Go'])).toBe(0)
  })
})

describe('loadFile URL mapping', () => {
  it('produces app-relative URLs', () => {
    expect(fileToUrl('/index.html')).toBe('index.html')
    expect(fileToUrl('/src/renderer/page one.html', { query: { a: '1' }, hash: 'top' })).toBe('src/renderer/page%20one.html?a=1#top')
    expect(fileToUrl('file:///index.html', { search: 'x=1' })).toBe('index.html?x=1')
    expect(fileUrlToAppUrl('file:///src/renderer/index.html?a=1#b')).toBe('src/renderer/index.html?a=1#b')
    expect(fileUrlToAppUrl('file:///src/my%20page.html')).toBe('src/my%20page.html')
    expect(fileUrlToAppUrl('https://example.com/')).toBe('https://example.com/')
  })

  it('maps real paths under app.getAppPath() back to the project', () => {
    globalThis.__TAURI_ELECTRON_APP__ = { root: '/home/me/app', entries: ['src', 'index.html'] }
    try {
      expect(fileToUrl('/home/me/app/index.html')).toBe('index.html')
      expect(fileToUrl('/home/me/app/src/page.html')).toBe('src/page.html')
      expect(fileToUrl('/home/me/application/x.html')).toBe('home/me/application/x.html') // not under the root
      globalThis.__TAURI_ELECTRON_APP__ = { root: 'C:\\Users\\me\\app', entries: ['src'] }
      expect(fileToUrl('c:\\users\\me\\app\\src\\page.html')).toBe('src/page.html')
    } finally {
      delete globalThis.__TAURI_ELECTRON_APP__
    }
  })
})

describe('window.open features', async () => {
  const { parseWindowFeatures } = await import('../src/main/browser-window.js')
  it('maps the features Electron understands', () => {
    expect(parseWindowFeatures('width=400,height=300,left=10,top=20,resizable=no,show=yes')).toEqual({
      width: 400, height: 300, x: 10, y: 20, resizable: false, show: true,
    })
    expect(parseWindowFeatures('')).toEqual({})
  })
})

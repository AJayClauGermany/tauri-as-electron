import { describe, expect, it } from 'vitest'
import { NotImplementedError, REASONS, explainError, isPermissionError } from '../src/internal/runtime.js'

describe('NotImplementedError', () => {
  it('names the API and the reason', () => {
    const plain = new NotImplementedError('webContents.capturePage')
    expect(plain.name).toBe('NotImplementedError')
    expect(plain.reason).toBe('unimplemented')
    expect(plain.message).toBe('webContents.capturePage is not implemented by tauri-electron yet')

    const hinted = new NotImplementedError('x.y', 'Do z instead.')
    expect(hinted.message).toBe('x.y is not implemented by tauri-electron yet. Do z instead.')

    for (const reason of Object.keys(REASONS)) {
      const error = new NotImplementedError('a.b', { reason, hint: 'hint' })
      expect(error.reason).toBe(reason)
      expect(error.message).toBe(`a.b is ${REASONS[reason]}. hint`)
    }
  })
})

describe('explainError', () => {
  const denied = new Error('dialog.open not allowed. Permissions associated with this command: dialog:allow-open, dialog:default')

  it('recognizes Tauri permission denials', () => {
    expect(isPermissionError(denied)).toBe(true)
    expect(isPermissionError(new Error('boom'))).toBe(false)
  })

  it('turns a denial into a NotImplementedError that names the capability model', () => {
    const explained = explainError('dialog.showOpenDialog', denied)
    expect(explained).toBeInstanceOf(NotImplementedError)
    expect(explained.reason).toBe('permission')
    expect(explained.message).toContain('dialog.showOpenDialog is denied by Tauri\'s capability model')
    expect(explained.message).toContain('`dialog.open`')
    expect(explained.message).toMatch(/main process|capabilit/)
    expect(explained.cause).toBe(denied)
  })

  it('maps a missing Tauri plugin to the Cargo feature, and a missing tauri-plugin-electron to its setup', () => {
    const feature = explainError('autoUpdater.checkForUpdates', new Error('plugin updater not found'))
    expect(feature.reason).toBe('feature')
    expect(feature.message).toContain('`updater`')
    const plugin = explainError('process.argv', new Error('plugin electron not found'))
    expect(plugin.reason).toBe('plugin')
    expect(plugin.message).toContain('tauri_plugin_electron::Builder')
  })

  it('leaves other errors alone', () => {
    const error = new Error('boom')
    expect(explainError('x', error)).toBe(error)
  })
})

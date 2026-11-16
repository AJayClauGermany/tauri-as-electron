// What the fork-entry scanner looks for: static paths passed to fork().
import { utilityProcess } from 'electron'
import { fork } from 'node:child_process'
import path from 'node:path'

const dirname = import.meta.dirname

export function startUtility() {
  return utilityProcess.fork(path.join(dirname, 'utility.js'), ['--flag'], { stdio: 'pipe' })
}

const childPath = path.resolve(dirname, 'workers', 'child.js')

export function startChild() {
  return fork(childPath, ['a', 'b'], { silent: true })
}

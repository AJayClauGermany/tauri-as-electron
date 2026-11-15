/**
 * Node's `fs/promises`: the same functions as `fs.promises` (./fs.js).
 */
import { promises } from './fs.js'

export const {
  readFile, writeFile, appendFile, stat, lstat, access, mkdir, readdir, rm, unlink, rmdir, rename, copyFile,
  realpath, mkdtemp, truncate, chmod, utimes, readlink, symlink, constants, open, opendir, cp, watch, link,
  chown, lchown, lchmod, lutimes, statfs,
} = promises

export default promises

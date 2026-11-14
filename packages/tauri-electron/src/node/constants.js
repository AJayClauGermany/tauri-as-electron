/**
 * Node's deprecated `constants` module: os.constants (errno, signals,
 * priority) and fs.constants in one object.
 */
import { constants as osConstants } from './os.js'
import { constants as fsConstants } from './fs.js'

const constants = Object.freeze({
  ...osConstants.dlopen,
  ...osConstants.errno,
  ...osConstants.priority,
  ...osConstants.signals,
  ...fsConstants,
})

export default constants

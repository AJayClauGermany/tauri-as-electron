/**
 * Node's `assert` and `assert/strict`: the same checks, AssertionError
 * (`code: 'ERR_ASSERTION'`, `actual`, `expected`, `operator`,
 * `generatedMessage`) and messages, including the `+ actual - expected`
 * diff of the deep comparisons.
 *
 * Unlike Node, `assert.ok(false)` cannot quote the failing expression (that
 * needs the source file), so it shows the value instead.
 */
import { inspect, isDeepStrictEqual } from './util.js'
import * as types from './util-types.js'

export class AssertionError extends Error {
  constructor({ message, actual, expected, operator, stackStartFn, generatedMessage } = {}) {
    super(message ?? 'Failed')
    this.name = 'AssertionError'
    this.generatedMessage = generatedMessage ?? !message
    this.code = 'ERR_ASSERTION'
    this.actual = actual
    this.expected = expected
    this.operator = operator
    Error.captureStackTrace?.(this, stackStartFn)
  }
}

const view = (value) => inspect(value, { compact: false, customInspect: false, depth: 1000, maxArrayLength: Infinity, sorted: true, getters: true })

/** Line diff (LCS) of the inspected values, Node's `+ actual - expected` form. */
function diff(actual, expected) {
  const a = view(actual).split('\n')
  const b = view(expected).split('\n')
  const lengths = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i++]}`)
      j++
    } else if (j >= b.length || (i < a.length && lengths[i + 1][j] >= lengths[i][j + 1])) {
      out.push(`+ ${a[i++]}`)
    } else {
      out.push(`- ${b[j++]}`)
    }
  }
  return `+ actual - expected\n\n${out.join('\n')}\n`
}

/** Throw for a failed check: the user's message (or Error) if given, else `generated`. */
function fail(options, message, generated) {
  if (message instanceof Error) throw message
  throw new AssertionError({ ...options, message: message ?? generated, generatedMessage: message === undefined })
}

// --- comparisons -----------------------------------------------------------------------------------

function looseEqual(a, b) {
  // eslint-disable-next-line eqeqeq
  return a == b || (Number.isNaN(a) && Number.isNaN(b))
}

/** `assert.deepEqual`: `==` for primitives, prototypes ignored. */
function looseDeepEqual(a, b, memo = new Map()) {
  if (looseEqual(a, b) && (a === null || typeof a !== 'object') && (b === null || typeof b !== 'object')) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (memo.get(a) === b) return true
  memo.set(a, b)
  if (types.isDate(a) && types.isDate(b)) return a.getTime() === b.getTime()
  if (types.isRegExp(a) && types.isRegExp(b)) return String(a) === String(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    return x.every((byte, index) => byte === y[index])
  }
  if (types.isMap(a) && types.isMap(b)) {
    if (a.size !== b.size) return false
    for (const [key, value] of a) if (!b.has(key) || !looseDeepEqual(value, b.get(key), memo)) return false
    return true
  }
  if (types.isSet(a) && types.isSet(b)) {
    if (a.size !== b.size) return false
    for (const value of a) if (!b.has(value) && ![...b].some((other) => looseDeepEqual(value, other, memo))) return false
    return true
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && looseDeepEqual(a[key], b[key], memo))
}

export function ok(value, message) {
  if (arguments.length === 0) fail({ actual: undefined, expected: true, operator: '==', stackStartFn: ok }, undefined, 'No value argument passed to `assert.ok()`')
  if (!value) {
    fail({ actual: value, expected: true, operator: '==', stackStartFn: ok }, message, `The expression evaluated to a falsy value:\n\n  ${inspect(value)}\n`)
  }
}

export function equal(actual, expected, message) {
  if (!looseEqual(actual, expected)) fail({ actual, expected, operator: '==', stackStartFn: equal }, message, `${inspect(actual)} == ${inspect(expected)}`)
}

export function notEqual(actual, expected, message) {
  if (looseEqual(actual, expected)) fail({ actual, expected, operator: '!=', stackStartFn: notEqual }, message, `${inspect(actual)} != ${inspect(expected)}`)
}

export function strictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) return
  const detail = `${inspect(actual)} !== ${inspect(expected)}\n`
  // Node appends the comparison to a custom message too.
  const custom = message === undefined || message instanceof Error ? message : `${message}\n\n${detail}`
  fail({ actual, expected, operator: 'strictEqual', stackStartFn: strictEqual }, custom, `Expected values to be strictly equal:\n\n${detail}`)
}

export function notStrictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) return
  fail({ actual, expected, operator: 'notStrictEqual', stackStartFn: notStrictEqual }, message, `Expected "actual" to be strictly unequal to: ${inspect(expected)}`)
}

export function deepEqual(actual, expected, message) {
  if (looseDeepEqual(actual, expected)) return
  fail(
    { actual, expected, operator: 'deepEqual', stackStartFn: deepEqual },
    message, `Expected values to be loosely deep-equal:\n\n${view(actual)}\n\nshould loosely deep-equal\n\n${view(expected)}`,
  )
}

export function notDeepEqual(actual, expected, message) {
  if (!looseDeepEqual(actual, expected)) return
  fail({ actual, expected, operator: 'notDeepEqual', stackStartFn: notDeepEqual }, message, `Expected "actual" not to be loosely deep-equal to:\n\n${view(expected)}\n`)
}

export function deepStrictEqual(actual, expected, message) {
  if (isDeepStrictEqual(actual, expected)) return
  fail({ actual, expected, operator: 'deepStrictEqual', stackStartFn: deepStrictEqual }, message, `Expected values to be strictly deep-equal:\n${diff(actual, expected)}`)
}

export function notDeepStrictEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) return
  fail({ actual, expected, operator: 'notDeepStrictEqual', stackStartFn: notDeepStrictEqual }, message, `Expected "actual" not to be strictly deep-equal to:\n\n${view(expected)}\n`)
}

// --- exceptions ---------------------------------------------------------------------------------------

class Comparison {}

/** Does `error` satisfy `expected` (a class, RegExp, validation function or object)? */
function matches(error, expected, operator, stackStartFn) {
  if (expected === undefined) return true
  if (types.isRegExp(expected)) return expected.test(String(error))
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && error instanceof expected) return true
    if (Error.isPrototypeOf(expected) || expected === Error) return false
    return expected.call({}, error) === true
  }
  if (expected && typeof expected === 'object') {
    const keys = Object.keys(expected)
    const differs = keys.some((key) => {
      const want = expected[key]
      const got = error?.[key]
      return !(types.isRegExp(want) && typeof got === 'string' ? want.test(got) : isDeepStrictEqual(got, want))
    })
    if (differs) {
      // Like Node: compare `Comparison` objects holding just the expected keys.
      const actualView = new Comparison()
      const expectedView = new Comparison()
      for (const key of keys) {
        actualView[key] = error?.[key]
        expectedView[key] = expected[key]
      }
      fail({ actual: error, expected, operator, stackStartFn }, undefined, `Expected values to be strictly deep-equal:\n${diff(actualView, expectedView)}`)
    }
    return true
  }
  return false
}

function expectedName(expected) {
  return typeof expected === 'function' && expected.name ? ` (${expected.name})` : ''
}

function splitMessage(expected, message) {
  return typeof expected === 'string' ? [undefined, expected] : [expected, message]
}

export function throws(fn, expectedOrMessage, maybeMessage) {
  const [expected, message] = splitMessage(expectedOrMessage, maybeMessage)
  let threw = false
  let error
  try {
    fn()
  } catch (e) {
    threw = true
    error = e
  }
  if (!threw) {
    throw new AssertionError({ message: `Missing expected exception${expectedName(expected)}.${message ? `: ${message}` : ''}`, operator: 'throws', expected, stackStartFn: throws })
  }
  if (!matches(error, expected, 'throws', throws)) throw error
}

export async function rejects(promiseOrFn, expectedOrMessage, maybeMessage) {
  const [expected, message] = splitMessage(expectedOrMessage, maybeMessage)
  let rejected = false
  let error
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn)
  } catch (e) {
    rejected = true
    error = e
  }
  if (!rejected) {
    throw new AssertionError({ message: `Missing expected rejection${expectedName(expected)}.${message ? `: ${message}` : ''}`, operator: 'rejects', expected, stackStartFn: rejects })
  }
  if (!matches(error, expected, 'rejects', rejects)) throw error
}

export function doesNotThrow(fn, expectedOrMessage, maybeMessage) {
  const [, message] = splitMessage(expectedOrMessage, maybeMessage)
  try {
    fn()
  } catch (error) {
    throw new AssertionError({ message: `Got unwanted exception${message ? `: ${message}` : '.'}\nActual message: "${error?.message}"`, actual: error, operator: 'doesNotThrow', stackStartFn: doesNotThrow })
  }
}

export async function doesNotReject(promiseOrFn, expectedOrMessage, maybeMessage) {
  const [, message] = splitMessage(expectedOrMessage, maybeMessage)
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn)
  } catch (error) {
    throw new AssertionError({ message: `Got unwanted rejection${message ? `: ${message}` : '.'}\nActual message: "${error?.message}"`, actual: error, operator: 'doesNotReject', stackStartFn: doesNotReject })
  }
}

export function match(string, regexp, message) {
  if (typeof string === 'string' && regexp.test(string)) return
  fail({ actual: string, expected: regexp, operator: 'match', stackStartFn: match }, message, `The input did not match the regular expression ${inspect(regexp)}. Input:\n\n${inspect(string)}\n`)
}

export function doesNotMatch(string, regexp, message) {
  if (typeof string === 'string' && !regexp.test(string)) return
  fail({ actual: string, expected: regexp, operator: 'doesNotMatch', stackStartFn: doesNotMatch }, message, `The input was expected to not match the regular expression ${inspect(regexp)}. Input:\n\n${inspect(string)}\n`)
}

function failAssertion(message) {
  if (message instanceof Error) throw message
  throw new AssertionError({ message: message ?? 'Failed', operator: 'fail', stackStartFn: failAssertion, generatedMessage: message === undefined })
}
export { failAssertion as fail }

export function ifError(value) {
  if (value === null || value === undefined) return
  const text = typeof value === 'object' && typeof value.message === 'string' ? (value.message ? value.message : value.constructor?.name ?? 'Error') : inspect(value)
  const error = new AssertionError({ message: `ifError got unwanted exception: ${text}`, actual: value, expected: null, operator: 'ifError', stackStartFn: ifError })
  throw error
}

// --- the module objects ----------------------------------------------------------------------------

/** `assert(value)` is `assert.ok(value)`; the strict variant compares strictly under every name. */
function build(strict) {
  const fn = function assert(...args) {
    return ok(...args)
  }
  Object.assign(fn, {
    AssertionError,
    ok,
    fail: failAssertion,
    equal: strict ? strictEqual : equal,
    notEqual: strict ? notStrictEqual : notEqual,
    deepEqual: strict ? deepStrictEqual : deepEqual,
    notDeepEqual: strict ? notDeepStrictEqual : notDeepEqual,
    strictEqual,
    notStrictEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    throws,
    doesNotThrow,
    rejects,
    doesNotReject,
    match,
    doesNotMatch,
    ifError,
  })
  return fn
}

export const strict = build(true)
strict.strict = strict
const assert = build(false)
assert.strict = strict

export default assert

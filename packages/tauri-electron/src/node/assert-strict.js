/**
 * Node's `assert/strict`: `assert` with strict comparisons under every name.
 */
import { strict } from './assert.js'

export const {
  AssertionError, ok, fail, equal, notEqual, deepEqual, notDeepEqual, strictEqual, notStrictEqual, deepStrictEqual,
  notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, ifError,
} = strict

export default strict

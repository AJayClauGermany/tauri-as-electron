/**
 * Node's (deprecated) `punycode`, from the `punycode` npm package, imported
 * by file so the bundler alias for the bare `punycode` specifier (which
 * points here) does not apply to it.
 */
import punycode from 'punycode/punycode.es6.js'

export const { decode, encode, toASCII, toUnicode, ucs2, version } = punycode

export default punycode

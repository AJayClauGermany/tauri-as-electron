/**
 * Node's `util/types`: type checks by internal tag, so they also hold for
 * values from another realm (an iframe), as in Node.
 */
const tag = (value) => Object.prototype.toString.call(value).slice(8, -1)
const isObjectLike = (value) => value !== null && (typeof value === 'object' || typeof value === 'function')
const typedArrayTag = (value) => (ArrayBuffer.isView(value) && !(value instanceof DataView) ? tag(value) : undefined)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor
const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor

export const isPromise = (value) => tag(value) === 'Promise'
export const isRegExp = (value) => tag(value) === 'RegExp'
export const isDate = (value) => tag(value) === 'Date'
export const isMap = (value) => tag(value) === 'Map'
export const isSet = (value) => tag(value) === 'Set'
export const isWeakMap = (value) => tag(value) === 'WeakMap'
export const isWeakSet = (value) => tag(value) === 'WeakSet'
export const isMapIterator = (value) => tag(value) === 'Map Iterator'
export const isSetIterator = (value) => tag(value) === 'Set Iterator'
export const isArrayBuffer = (value) => tag(value) === 'ArrayBuffer'
export const isSharedArrayBuffer = (value) => tag(value) === 'SharedArrayBuffer'
export const isAnyArrayBuffer = (value) => isArrayBuffer(value) || isSharedArrayBuffer(value)
export const isArrayBufferView = (value) => ArrayBuffer.isView(value)
export const isDataView = (value) => tag(value) === 'DataView'
export const isTypedArray = (value) => typedArrayTag(value) !== undefined
export const isUint8Array = (value) => typedArrayTag(value) === 'Uint8Array'
export const isUint8ClampedArray = (value) => typedArrayTag(value) === 'Uint8ClampedArray'
export const isUint16Array = (value) => typedArrayTag(value) === 'Uint16Array'
export const isUint32Array = (value) => typedArrayTag(value) === 'Uint32Array'
export const isInt8Array = (value) => typedArrayTag(value) === 'Int8Array'
export const isInt16Array = (value) => typedArrayTag(value) === 'Int16Array'
export const isInt32Array = (value) => typedArrayTag(value) === 'Int32Array'
export const isFloat32Array = (value) => typedArrayTag(value) === 'Float32Array'
export const isFloat64Array = (value) => typedArrayTag(value) === 'Float64Array'
export const isBigInt64Array = (value) => typedArrayTag(value) === 'BigInt64Array'
export const isBigUint64Array = (value) => typedArrayTag(value) === 'BigUint64Array'
export const isNativeError = (value) => tag(value) === 'Error' || value instanceof Error
export const isArgumentsObject = (value) => tag(value) === 'Arguments'
export const isGeneratorObject = (value) => tag(value) === 'Generator'
export const isAsyncFunction = (value) => value instanceof AsyncFunction || value instanceof AsyncGeneratorFunction || tag(value) === 'AsyncFunction' || tag(value) === 'AsyncGeneratorFunction'
export const isGeneratorFunction = (value) => value instanceof GeneratorFunction || value instanceof AsyncGeneratorFunction || tag(value) === 'GeneratorFunction' || tag(value) === 'AsyncGeneratorFunction'
export const isNumberObject = (value) => isObjectLike(value) && tag(value) === 'Number'
export const isStringObject = (value) => isObjectLike(value) && tag(value) === 'String'
export const isBooleanObject = (value) => isObjectLike(value) && tag(value) === 'Boolean'
export const isBigIntObject = (value) => isObjectLike(value) && tag(value) === 'BigInt'
export const isSymbolObject = (value) => isObjectLike(value) && tag(value) === 'Symbol'
export const isBoxedPrimitive = (value) => isNumberObject(value) || isStringObject(value) || isBooleanObject(value) || isBigIntObject(value) || isSymbolObject(value)
export const isModuleNamespaceObject = (value) => isObjectLike(value) && tag(value) === 'Module'
export const isCryptoKey = (value) => tag(value) === 'CryptoKey'
// Not observable from JavaScript in a webview.
export const isProxy = () => false
export const isExternal = () => false
export const isKeyObject = () => false

const types = {
  isPromise, isRegExp, isDate, isMap, isSet, isWeakMap, isWeakSet, isMapIterator, isSetIterator,
  isArrayBuffer, isSharedArrayBuffer, isAnyArrayBuffer, isArrayBufferView, isDataView, isTypedArray,
  isUint8Array, isUint8ClampedArray, isUint16Array, isUint32Array, isInt8Array, isInt16Array, isInt32Array,
  isFloat32Array, isFloat64Array, isBigInt64Array, isBigUint64Array, isNativeError, isArgumentsObject,
  isGeneratorObject, isAsyncFunction, isGeneratorFunction, isNumberObject, isStringObject, isBooleanObject,
  isBigIntObject, isSymbolObject, isBoxedPrimitive, isModuleNamespaceObject, isCryptoKey, isProxy,
  isExternal, isKeyObject,
}

export default types

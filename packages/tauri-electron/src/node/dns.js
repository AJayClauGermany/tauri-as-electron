/**
 * Node's `dns`, backed by tauri-plugin-electron (Cargo feature `node-net`).
 *
 * - `lookup()` asks the operating system (getaddrinfo, /etc/hosts), like Node.
 * - `resolve*()` / `reverse()` query DNS servers directly: the system's, or
 *   those given to `setServers()` (per Resolver, as in Node).
 *
 * Errors are Node's: `getaddrinfo ENOTFOUND host`, `queryMx ENODATA host`.
 * `lookupService()` is not implemented.
 */
import { native } from '../internal/native.js'
import { NotImplementedError } from '../internal/runtime.js'
import { nodeCallSync, parseJson } from '../internal/node-bridge.js'
import { checkNet, socketError, isIP } from './net.js'

export const NODATA = 'ENODATA'
export const FORMERR = 'EFORMERR'
export const SERVFAIL = 'ESERVFAIL'
export const NOTFOUND = 'ENOTFOUND'
export const NOTIMP = 'ENOTIMP'
export const REFUSED = 'EREFUSED'
export const BADQUERY = 'EBADQUERY'
export const BADNAME = 'EBADNAME'
export const BADFAMILY = 'EBADFAMILY'
export const BADRESP = 'EBADRESP'
export const CONNREFUSED = 'ECONNREFUSED'
export const TIMEOUT = 'ETIMEOUT'
export const EOF = 'EOF'
export const FILE = 'EFILE'
export const NOMEM = 'ENOMEM'
export const DESTRUCTION = 'EDESTRUCTION'
export const BADSTR = 'EBADSTR'
export const BADFLAGS = 'EBADFLAGS'
export const NONAME = 'ENONAME'
export const BADHINTS = 'EBADHINTS'
export const NOTINITIALIZED = 'ENOTINITIALIZED'
export const LOADIPHLPAPI = 'ELOADIPHLPAPI'
export const ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS'
export const CANCELLED = 'ECANCELLED'
export const ADDRCONFIG = 1024
export const V4MAPPED = 2048
export const ALL = 256

let resultOrder = 'verbatim'
export const getDefaultResultOrder = () => resultOrder
export function setDefaultResultOrder(order) {
  if (!['verbatim', 'ipv4first', 'ipv6first'].includes(order)) {
    throw Object.assign(new TypeError(`The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received '${order}'`), { code: 'ERR_INVALID_ARG_VALUE' })
  }
  resultOrder = order
}

/** Node's lookup error (`getaddrinfo ENOTFOUND host`), or a query error (`queryMx ENODATA host`). */
function dnsError(body, api) {
  if (body?.syscall === 'getaddrinfo') return socketError(body, api)
  if (body && typeof body === 'object' && body.syscall) {
    const error = new Error(`${body.syscall} ${body.code} ${body.hostname ?? ''}`.trimEnd())
    return Object.assign(error, { code: body.code, syscall: body.syscall, hostname: body.hostname })
  }
  return socketError(body, api)
}

function order(list, how) {
  if (how === 'ipv4first') return [...list.filter((a) => a.family === 4), ...list.filter((a) => a.family === 6)]
  if (how === 'ipv6first') return [...list.filter((a) => a.family === 6), ...list.filter((a) => a.family === 4)]
  return list
}

/** The promise form of lookup: `{ address, family }` or, with `all`, a list. */
export async function lookupAsync(hostname, options = {}) {
  if (typeof options === 'number') options = { family: options }
  const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family) || 0
  if (!hostname) return options.all ? [] : { address: null, family: family === 6 ? 6 : 4 }
  const literal = isIP(hostname)
  let list
  if (literal) {
    list = [{ address: hostname, family: literal }]
  } else {
    checkNet('dns.lookup')
    try {
      list = await native('dns_lookup', { hostname, family })
    } catch (error) {
      throw dnsError(error, 'dns.lookup')
    }
  }
  const how = options.order ?? (options.verbatim === false ? 'ipv4first' : resultOrder)
  list = order(list, how)
  return options.all ? list : list[0]
}

/** `dns.lookup(hostname, [options], callback)`. */
export function lookup(hostname, options, callback) {
  if (typeof options === 'function') [callback, options] = [options, {}]
  if (typeof callback !== 'function') throw Object.assign(new TypeError('The "callback" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' })
  const all = typeof options === 'object' && options?.all
  lookupAsync(hostname, options).then(
    (result) => (all ? callback(null, result) : callback(null, result.address, result.family)),
    (error) => callback(error),
  )
  return {}
}

function lookupServiceNotYet() {
  throw new NotImplementedError('dns.lookupService', { reason: 'unimplemented', hint: 'Reverse service lookup is not implemented yet: use dns.reverse() for the host name.' })
}
export const lookupService = lookupServiceNotYet

let systemServers = null
function defaultServers() {
  if (systemServers === null) {
    try {
      systemServers = parseJson(nodeCallSync({ api: 'dns.getServers', module: 'dns', feature: 'node-net', op: 'servers' }))
    } catch {
      systemServers = []
    }
  }
  return systemServers
}

/** Promise-based resolver: the base of both `Resolver` classes. */
class PromiseResolverBase {
  constructor(options = {}) {
    this._servers = null
    this._timeout = options.timeout === undefined || options.timeout === -1 ? undefined : options.timeout
    this._tries = options.tries
  }

  getServers() {
    return [...(this._servers ?? defaultServers())]
  }

  setServers(servers) {
    for (const server of servers) {
      const host = String(server).replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1')
      if (!isIP(host)) throw Object.assign(new TypeError(`Invalid IP address: ${server}`), { code: 'ERR_INVALID_IP_ADDRESS' })
    }
    this._servers = servers.map(String)
  }

  setLocalAddress() {}

  cancel() {}

  async _query(hostname, rrtype, options = {}) {
    checkNet('dns.resolve')
    try {
      return await native('dns_resolve', {
        hostname,
        rrtype,
        ttl: Boolean(options.ttl),
        servers: this._servers ?? [],
        timeout: this._timeout ?? null,
        tries: this._tries ?? null,
      })
    } catch (error) {
      throw dnsError(error, `dns.resolve${rrtype}`)
    }
  }

  resolve(hostname, rrtype = 'A') {
    return this._query(hostname, rrtype)
  }

  async reverse(ip) {
    checkNet('dns.reverse')
    try {
      return await native('dns_reverse', { ip, servers: this._servers ?? [], timeout: this._timeout ?? null, tries: this._tries ?? null })
    } catch (error) {
      throw dnsError(error, 'dns.reverse')
    }
  }
}

const RECORDS = { resolve4: 'A', resolve6: 'AAAA', resolveAny: 'ANY', resolveCaa: 'CAA', resolveCname: 'CNAME', resolveMx: 'MX', resolveNaptr: 'NAPTR', resolveNs: 'NS', resolvePtr: 'PTR', resolveSoa: 'SOA', resolveSrv: 'SRV', resolveTxt: 'TXT' }
for (const [method, rrtype] of Object.entries(RECORDS)) {
  PromiseResolverBase.prototype[method] = function (hostname, options) {
    return this._query(hostname, rrtype, options)
  }
}

/** `dns.promises.Resolver`. */
export class PromiseResolver extends PromiseResolverBase {}

/** `dns.Resolver`: the callback form. */
export class Resolver extends PromiseResolverBase {}
for (const method of ['resolve', 'reverse', ...Object.keys(RECORDS)]) {
  const promised = PromiseResolverBase.prototype[method]
  Resolver.prototype[method] = function (...args) {
    const callback = args.pop()
    if (typeof callback !== 'function') throw Object.assign(new TypeError('The "callback" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' })
    promised.apply(this, args).then((result) => callback(null, result), (error) => callback(error))
    return {}
  }
}

const defaultResolver = new Resolver()
const defaultPromiseResolver = new PromiseResolver()

export const getServers = () => defaultResolver.getServers()
export function setServers(servers) {
  defaultResolver.setServers(servers)
  defaultPromiseResolver.setServers(servers)
}
export const resolve = (...args) => defaultResolver.resolve(...args)
export const reverse = (...args) => defaultResolver.reverse(...args)
export const resolve4 = (...args) => defaultResolver.resolve4(...args)
export const resolve6 = (...args) => defaultResolver.resolve6(...args)
export const resolveAny = (...args) => defaultResolver.resolveAny(...args)
export const resolveCaa = (...args) => defaultResolver.resolveCaa(...args)
export const resolveCname = (...args) => defaultResolver.resolveCname(...args)
export const resolveMx = (...args) => defaultResolver.resolveMx(...args)
export const resolveNaptr = (...args) => defaultResolver.resolveNaptr(...args)
export const resolveNs = (...args) => defaultResolver.resolveNs(...args)
export const resolvePtr = (...args) => defaultResolver.resolvePtr(...args)
export const resolveSoa = (...args) => defaultResolver.resolveSoa(...args)
export const resolveSrv = (...args) => defaultResolver.resolveSrv(...args)
export const resolveTxt = (...args) => defaultResolver.resolveTxt(...args)

export const promises = {
  Resolver: PromiseResolver,
  lookup: lookupAsync,
  lookupService: async () => lookupServiceNotYet(),
  getServers: () => defaultPromiseResolver.getServers(),
  setServers,
  getDefaultResultOrder,
  setDefaultResultOrder,
  resolve: (...args) => defaultPromiseResolver.resolve(...args),
  reverse: (...args) => defaultPromiseResolver.reverse(...args),
  ...Object.fromEntries(Object.keys(RECORDS).map((method) => [method, (...args) => defaultPromiseResolver[method](...args)])),
  NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY, BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT,
  EOF, FILE, NOMEM, DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED, LOADIPHLPAPI, ADDRGETNETWORKPARAMS,
  CANCELLED,
}

const dns = {
  Resolver, lookup, lookupService, getServers, setServers, resolve, reverse, resolve4, resolve6, resolveAny,
  resolveCaa, resolveCname, resolveMx, resolveNaptr, resolveNs, resolvePtr, resolveSoa, resolveSrv, resolveTxt,
  getDefaultResultOrder, setDefaultResultOrder, promises, ADDRCONFIG, V4MAPPED, ALL,
  NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY, BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT,
  EOF, FILE, NOMEM, DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED, LOADIPHLPAPI, ADDRGETNETWORKPARAMS,
  CANCELLED,
}

export default dns

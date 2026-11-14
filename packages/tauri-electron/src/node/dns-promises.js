/**
 * Node's `dns/promises`, see ./dns.js.
 */
import { promises } from './dns.js'

export const {
  Resolver, lookup, lookupService, getServers, setServers, getDefaultResultOrder, setDefaultResultOrder, resolve,
  reverse, resolve4, resolve6, resolveAny, resolveCaa, resolveCname, resolveMx, resolveNaptr, resolveNs, resolvePtr,
  resolveSoa, resolveSrv, resolveTxt,
} = promises

export default promises

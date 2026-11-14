/**
 * Node's `https` (client side), see ./http-client.js.
 */
import { createHttpModule } from './http-client.js'

const https = createHttpModule('https:')

export const {
  METHODS, STATUS_CODES, Agent, globalAgent, ClientRequest, IncomingMessage, request, get, validateHeaderName,
  validateHeaderValue, maxHeaderSize, createServer, Server, ServerResponse, OutgoingMessage, setMaxIdleHTTPParsers,
} = https

export default https

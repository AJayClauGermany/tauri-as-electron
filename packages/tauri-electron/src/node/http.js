/**
 * Node's `http` (client side), see ./http-client.js.
 */
import { createHttpModule } from './http-client.js'

const http = createHttpModule('http:')

export const {
  METHODS, STATUS_CODES, Agent, globalAgent, ClientRequest, IncomingMessage, request, get, validateHeaderName,
  validateHeaderValue, maxHeaderSize, createServer, Server, ServerResponse, OutgoingMessage, setMaxIdleHTTPParsers,
} = http

export default http

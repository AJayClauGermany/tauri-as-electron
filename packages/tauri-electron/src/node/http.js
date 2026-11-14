/**
 * Node's `http`: the client in ./http-client.js (tauri-plugin-http), the
 * server in ./http-server.js (tauri-plugin-electron's `node-net`).
 */
import { createHttpModule } from './http-client.js'
import { createServer, Server, ServerResponse, OutgoingMessage } from './http-server.js'

const http = { ...createHttpModule('http:'), createServer, Server, ServerResponse, OutgoingMessage }

export const {
  METHODS, STATUS_CODES, Agent, globalAgent, ClientRequest, IncomingMessage, request, get, validateHeaderName,
  validateHeaderValue, maxHeaderSize, setMaxIdleHTTPParsers,
} = http
export { createServer, Server, ServerResponse, OutgoingMessage }

export default http

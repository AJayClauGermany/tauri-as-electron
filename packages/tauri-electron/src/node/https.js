/**
 * Node's `https`: the client in ./http-client.js (tauri-plugin-http), the
 * server in ./http-server.js over tls (tauri-plugin-electron's `node-tls`).
 */
import { createHttpModule } from './http-client.js'
import { createHttpsServer as createServer, HttpsServer as Server, ServerResponse, OutgoingMessage } from './http-server.js'

const https = { ...createHttpModule('https:'), createServer, Server, ServerResponse, OutgoingMessage }

export const {
  METHODS, STATUS_CODES, Agent, globalAgent, ClientRequest, IncomingMessage, request, get, validateHeaderName,
  validateHeaderValue, maxHeaderSize, setMaxIdleHTTPParsers,
} = https
export { createServer, Server, ServerResponse, OutgoingMessage }

export default https

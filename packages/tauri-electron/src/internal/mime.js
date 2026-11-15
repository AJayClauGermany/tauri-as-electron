/** Content types by file extension, for files served by net.fetch('file://…') and file protocols. */
const TYPES = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', js: 'text/javascript', mjs: 'text/javascript',
  cjs: 'text/javascript', css: 'text/css', json: 'application/json', map: 'application/json', txt: 'text/plain',
  md: 'text/markdown', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', wasm: 'application/wasm', pdf: 'application/pdf', zip: 'application/zip',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mov: 'video/quicktime',
}

/** The content type for a path, `application/octet-stream` when unknown. */
export function mimeType(path) {
  const match = /\.([^./\\]+)$/.exec(String(path))
  return (match && TYPES[match[1].toLowerCase()]) || 'application/octet-stream'
}

/**
 * Electron's `Certificate` object, read from the PEM certificates the
 * webview reports (tauri-plugin-electron's certificate errors): a small DER
 * reader for the fields Electron exposes, and Chromium's fingerprint format
 * (`sha256/` + base64 of the SHA-256 of the DER bytes).
 */
import { sha256 } from '@noble/hashes/sha2.js'

const OIDS = {
  '2.5.4.3': 'commonName',
  '2.5.4.10': 'organizations',
  '2.5.4.11': 'organizationUnits',
  '2.5.4.7': 'locality',
  '2.5.4.8': 'state',
  '2.5.4.6': 'country',
}

/** `-----BEGIN CERTIFICATE-----` blocks → their DER bytes. */
export function pemBlocks(pem) {
  const blocks = []
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g
  for (let match = re.exec(String(pem ?? '')); match; match = re.exec(String(pem))) {
    const base64 = match[1].replace(/\s+/g, '')
    blocks.push({ pem: `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`, der: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) })
  }
  return blocks
}

/** One DER element at `offset`: { tag, start (of the content), end }. */
function element(bytes, offset) {
  const tag = bytes[offset]
  let length = bytes[offset + 1]
  let start = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i]
    start += count
  }
  if (start + length > bytes.length) throw new Error('truncated DER')
  return { tag, start, end: start + length }
}

function children(bytes, { start, end }) {
  const out = []
  for (let offset = start; offset < end;) {
    const child = element(bytes, offset)
    out.push(child)
    offset = child.end
  }
  return out
}

function oid(bytes, { start, end }) {
  const parts = [Math.floor(bytes[start] / 40), bytes[start] % 40]
  let value = 0
  for (let i = start + 1; i < end; i++) {
    value = value * 128 + (bytes[i] & 0x7f)
    if (!(bytes[i] & 0x80)) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

function text(bytes, { tag, start, end }) {
  const slice = bytes.subarray(start, end)
  if (tag === 0x1e) {
    // BMPString: UTF-16BE
    let out = ''
    for (let i = 0; i + 1 < slice.length; i += 2) out += String.fromCharCode((slice[i] << 8) | slice[i + 1])
    return out
  }
  return new TextDecoder().decode(slice)
}

function principal(bytes, name) {
  const out = { commonName: '', organizations: [], organizationUnits: [], locality: '', state: '', country: '' }
  for (const rdn of children(bytes, name)) {
    for (const attribute of children(bytes, rdn)) {
      const [type, value] = children(bytes, attribute)
      const key = OIDS[oid(bytes, type)]
      if (!key) continue
      if (Array.isArray(out[key])) out[key].push(text(bytes, value))
      else out[key] = text(bytes, value)
    }
  }
  return out
}

function time(bytes, node) {
  const value = text(bytes, node)
  const match = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(value) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(value)
  if (!match) return 0
  let year = Number(match[1])
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900
  return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)) / 1000
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Chromium's fingerprint: `sha256/<base64 of the DER's SHA-256>`. */
export function fingerprint(der) {
  return `sha256/${btoa(String.fromCharCode(...sha256(der)))}`
}

/** One certificate (DER) → Electron's fields, without issuerCert. */
export function parseCertificate(der) {
  const cert = element(der, 0)
  const [tbs] = children(der, cert)
  const fields = children(der, tbs)
  const offset = fields[0].tag === 0xa0 ? 1 : 0 // [0] version
  const serial = fields[offset]
  const issuer = principal(der, fields[offset + 2])
  const [notBefore, notAfter] = children(der, fields[offset + 3])
  const subject = principal(der, fields[offset + 4])
  return {
    issuer,
    issuerName: issuer.commonName,
    subject,
    subjectName: subject.commonName,
    serialNumber: hex(der.subarray(serial.start, serial.end)),
    validStart: time(der, notBefore),
    validExpiry: time(der, notAfter),
    fingerprint: fingerprint(der),
  }
}

/**
 * A PEM chain (leaf first, as the webview reports it) → Electron's
 * Certificate, with `issuerCert` for each certificate that is not
 * self-signed. Fields that cannot be read stay empty rather than throwing.
 */
export function certificateFromPem(pem) {
  const blocks = Array.isArray(pem) ? pem.flatMap((p) => pemBlocks(p)) : pemBlocks(pem)
  const build = (index) => {
    const block = blocks[index]
    if (!block) return undefined
    let fields
    try {
      fields = parseCertificate(block.der)
    } catch {
      const empty = { commonName: '', organizations: [], organizationUnits: [], locality: '', state: '', country: '' }
      fields = { issuer: empty, issuerName: '', subject: empty, subjectName: '', serialNumber: '', validStart: 0, validExpiry: 0, fingerprint: fingerprint(block.der) }
    }
    const certificate = { data: block.pem, ...fields }
    const selfSigned = fields.issuerName === fields.subjectName && JSON.stringify(fields.issuer) === JSON.stringify(fields.subject)
    const issuerCert = selfSigned ? undefined : build(index + 1)
    if (issuerCert) certificate.issuerCert = issuerCert
    return certificate
  }
  return build(0) ?? { data: '', issuer: {}, issuerName: '', subject: {}, subjectName: '', serialNumber: '', validStart: 0, validExpiry: 0, fingerprint: '' }
}

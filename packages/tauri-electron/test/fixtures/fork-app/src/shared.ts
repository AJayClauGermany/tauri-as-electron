export function describe(kind: string): string {
  return `${kind} in ${process.versions.node ? 'Node.js' : 'somewhere else'}`
}

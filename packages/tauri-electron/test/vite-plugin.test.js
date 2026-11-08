import { describe, expect, it } from 'vitest'
import { rewritePathGlobals } from '../vite.js'

describe('rewritePathGlobals', () => {
  const rewrite = (code) => rewritePathGlobals(code, '/src', '/src/main.js')

  it('rewrites identifiers and import.meta properties', () => {
    expect(rewrite("path.join(__dirname, 'a.html')")).toBe(`path.join("/src", 'a.html')`)
    expect(rewrite('const f = __filename')).toBe('const f = "/src/main.js"')
    expect(rewrite('import.meta.dirname + import.meta.filename')).toBe('"/src" + "/src/main.js"')
    expect(rewrite('`${__dirname}/x`')).toBe('`${"/src"}/x`')
  })

  it('leaves strings, comments and member accesses alone', () => {
    const code = `const a = "path.join(__dirname)"; // __dirname\nconst b = 'import.meta.dirname'; /* __filename */ obj.__dirname`
    expect(rewrite(code)).toBe(code)
  })
})

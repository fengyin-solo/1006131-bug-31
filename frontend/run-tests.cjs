#!/usr/bin/env node
/**
 * 离线测试构建：环境里装不了 vitest，esbuild 又是别的平台二进制。
 * 用 typescript 把 test/ + src/ 转成 CJS 到 .test-build，再把 @/ 别名相对化后直接 node 跑。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = __dirname
const outDir = path.join(root, '.test-build')
fs.rmSync(outDir, { recursive: true, force: true })

execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    path.join(root, 'tsconfig.test.json'),
  ],
  { stdio: 'inherit' },
)

// tsc 不会改写运行时 require('@/...')，统一在产物里做字符串替换。
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.js')) {
      const source = fs.readFileSync(full, 'utf8')
      const fixed = source.replace(/require\("@\/([^"]+)"\)/g, (_match, spec) => {
        const from = path.dirname(full)
        const target = path.join(outDir, 'src', spec)
        return `require(${JSON.stringify(path.relative(from, target))})`
      })
      fs.writeFileSync(full, fixed)
    }
  }
}
walk(outDir)
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n')

execFileSync(process.execPath, [path.join(outDir, 'test/cutter.test.js')], {
  stdio: 'inherit',
})

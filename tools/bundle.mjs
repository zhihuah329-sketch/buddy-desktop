/**
 * Bundle the whole app into one file for the single-executable build.
 *
 * ## Why a hand-written bundler
 *
 * The app ships as `core` + `server` + a built Vue page. A single-executable
 * application (SEA) needs one script, so the modules have to be flattened.
 *
 * Adding esbuild/rollup to do this would be one more dependency for a job that is
 * fully determined here: the module graph is small, every import is relative or a
 * Node builtin, and the page is already a static asset. So the graph is walked,
 * each module is wrapped in a function, and the imports become lookups in a
 * registry — which is also what makes the output readable when something breaks.
 *
 * @module buddy-desktop/tools/bundle
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Node's own modules are left as real imports. */
const isBuiltin = (specifier) => specifier.startsWith('node:')

/**
 * Resolve an import specifier to a file on disk.
 *
 * Only the forms this project uses are handled; anything else is a build error
 * rather than a silent guess.
 *
 * @param specifier - what the module wrote.
 * @param fromFile - the importing file.
 * @returns the absolute path.
 */
function resolveImport(specifier, fromFile) {
  if (specifier.startsWith('@buddy-desktop/core')) {
    return join(ROOT, 'packages', 'core', 'src', 'index.js')
  }
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier)
    for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    throw new Error(`无法解析 ${specifier}（来自 ${relative(ROOT, fromFile)}）`)
  }
  throw new Error(`不支持的导入 ${specifier}（来自 ${relative(ROOT, fromFile)}）`)
}

/** Collect every module reachable from the entry points. */
function collect(entries) {
  const modules = new Map()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()
    if (modules.has(file)) continue
    const source = readFileSync(file, 'utf8')
    modules.set(file, source)

    for (const match of source.matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      if (isBuiltin(specifier)) continue
      queue.push(resolveImport(specifier, file))
    }
    for (const match of source.matchAll(/^\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      if (isBuiltin(specifier)) continue
      queue.push(resolveImport(specifier, file))
    }
  }
  return modules
}

/**
 * Turn one module's source into a registry body.
 *
 * Imports become registry lookups and exports become properties of a module
 * object, which is the same contract the original files had.
 *
 * @param file - the module path.
 * @param source - its text.
 * @param id - its registry id.
 * @param modules - every module, for resolving specifiers.
 * @returns the transformed body.
 */
function transform(file, source, id, modules) {
  const idOf = (specifier) => {
    const target = resolveImport(specifier, file)
    return modules.has(target) ? JSON.stringify(relative(ROOT, target).split(sep).join('/')) : null
  }

  let body = source

  // `import.meta.url` is a module-only construct. Every use in this project feeds
  // it to a path helper, so a placeholder URL keeps those helpers working under
  // CommonJS. The packaged build embeds its page and locates the credential
  // package by absolute path, so no real file position is needed.
  body = body.replace(/import\.meta\.url/g, "require('node:url').pathToFileURL(__filename).href")

  // `import { a, b as c } from './x.js'`  →  const { a, b: c } = __require('./x.js')
  body = body.replace(
    /^\s*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
    (whole, names, specifier) => {
      if (isBuiltin(specifier)) {
        const list = names
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
          .map((n) => n.replace(/\s+as\s+/, ': '))
          .join(', ')
        return `const { ${list} } = require(${JSON.stringify(specifier)});`
      }
      const target = idOf(specifier)
      if (target === null) throw new Error(`未收录的模块 ${specifier}`)
      const list = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.replace(/\s+as\s+/, ': '))
        .join(', ')
      return `const { ${list} } = __require(${target});`
    }
  )

  // `import x from './y.js'`  →  const x = __require('./y.js')
  body = body.replace(
    /^\s*import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (whole, name, specifier) => {
      if (isBuiltin(specifier)) return `const ${name} = require(${JSON.stringify(specifier)});`
      const target = idOf(specifier)
      if (target === null) throw new Error(`未收录的模块 ${specifier}`)
      return `const ${name} = __require(${target});`
    }
  )

  // `export { a, b } from './x.js'` — re-exports. The names must become real
  // properties of this module's exports; stashing them under one key (which an
  // earlier version did) satisfies the syntax but leaves every consumer with
  // `undefined`.
  let reexportSeq = 0
  body = body.replace(
    /^\s*export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
    (whole, names, specifier) => {
      const target = idOf(specifier)
      if (target === null) throw new Error(`未收录的模块 ${specifier}`)
      reexportSeq += 1
      const holder = `__from${reexportSeq}`
      const pairs = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => n.split(/\s+as\s+/))
      const list = pairs.map(([from, as]) => (as === undefined ? from : `${as}: ${from}`)).join(', ')
      const forwarded = pairs
        .map(([from, as]) => `exports.${as ?? from} = ${holder}.${from};`)
        .join('\n')
      return `const ${holder} = __require(${target});\nconst { ${list} } = ${holder};\n${forwarded}`
    }
  )

  // `export const a = ...` / `export function f()` / `export class C` — declared
  // locally and attached to the module object at the end.
  //
  // The generator star and the `async` modifier are both optional and can appear
  // together (`export async function* f()`), so they are matched as a group; an
  // earlier version only handled plain functions and left a stray `export` behind.
  const exported = []
  body = body.replace(
    /^\s*export\s+(async\s+)?function\s*(\*)?\s*(\w+)/gm,
    (whole, async, star, name) => {
      exported.push(name)
      return `${async ?? ''}function${star ?? ''} ${name}`
    }
  )
  body = body.replace(/^\s*export\s+class\s+(\w+)/gm, (whole, name) => {
    exported.push(name)
    return `class ${name}`
  })
  body = body.replace(/^\s*export\s+(const|let|var)\s+(\w+)/gm, (whole, kind, name) => {
    exported.push(name)
    return `${kind} ${name}`
  })

  // `export { a, b as c }` with no source — attached at the end.
  body = body.replace(/^\s*export\s*\{([^}]+)\}\s*;?/gm, (whole, names) => {
    for (const entry of names.split(',')) {
      const trimmed = entry.trim()
      if (trimmed.length === 0) continue
      const [local, alias] = trimmed.split(/\s+as\s+/)
      exported.push(alias === undefined ? local : `${local}:${alias}`)
    }
    return ''
  })

  const attachment = exported
    .map((entry) => {
      if (entry.includes(':')) {
        const [local, alias] = entry.split(':')
        return `exports.${alias} = ${local};`
      }
      return `exports.${entry} = ${entry};`
    })
    .join('\n')

  // Safety net: any surviving ESM syntax would surface only as a syntax error in
  // the packaged file, where the line number points at generated code. Failing
  // here names the module instead.
  const leftover = body.match(/^\s*(export|import)\s/m)
  if (leftover !== null) {
    throw new Error(
      `打包后仍残留 ESM 语法（${leftover[1]}）：${relative(ROOT, file)}`
    )
  }

  // CommonJS modules have no top-level `await`, but the entry point is written as
  // an ES module and uses it. The registry therefore invokes each factory through
  // an async wrapper and exposes the promise, so awaited entry code runs.
  return { body: `${body}\n${attachment}`, isAsyncEntry: true }
}

/** Flatten the app into one CommonJS script. */
export function buildBundle() {
  const entry = join(ROOT, 'packages', 'server', 'src', 'sea-entry.js')
  const modules = collect([entry])

  const parts = []
  for (const [file, source] of modules) {
    const id = relative(ROOT, file).split(sep).join('/')
    const { body } = transform(file, source, id, modules)
    // Ordinary factories stay synchronous: modules reference each other's exports
    // during initialisation, and an async factory would hand back an empty object
    // to whoever required it first.
    const isEntry = file === entry
    const wrapped = isEntry
      ? // The entry is an ES module and uses top-level `await`, which CommonJS
        // does not allow. Its body is moved into an async function instead.
        `async function (exports, require, module, __filename, __dirname) {\n${body}\n}`
      : `function (exports, require, module, __filename, __dirname) {\n${body}\n}`
    parts.push(`${JSON.stringify(id)}: ${wrapped}`)
  }

  const entryId = relative(ROOT, entry).split(sep).join('/')
  return `#!/usr/bin/env node
'use strict';
// Generated by tools/bundle.mjs — do not edit.
const REGISTRY = {
${parts.join(',\n')}
};
const CACHE = {};
// Node's own modules are not part of the bundle, so a request for one is handed
// to the real loader. Without this the registry lookup fails on 'node:fs'.
const nodeRequire = require;
function __require(id) {
  if (id.startsWith('node:') || nodeRequire('node:module').builtinModules.includes(id)) {
    return nodeRequire(id);
  }
  if (CACHE[id] !== undefined) return CACHE[id].exports;
  const factory = REGISTRY[id];
  if (factory === undefined) throw new Error('模块不在打包结果里: ' + id);
  const module = { exports: {} };
  CACHE[id] = module;
  const result = factory(module.exports, __require, module, id, id.replace(/\\/[^/]+$/, ''));
  // Only the async entry returns a promise; ordinary modules return undefined.
  if (result !== undefined && typeof result.then === 'function') module.promise = result;
  return module.exports;
}
const started = __require(${JSON.stringify(entryId)});
const pending = CACHE[${JSON.stringify(entryId)}].promise;
if (pending !== undefined) {
  pending.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
`
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('bundle.mjs')) {
  const outDir = join(ROOT, 'build')
  mkdirSync(outDir, { recursive: true })
  const code = buildBundle()
  const out = join(outDir, 'buddy-desktop.cjs')
  writeFileSync(out, code, 'utf8')
  console.log(`已生成 ${relative(ROOT, out)}（${Math.round(code.length / 1024)} KB）`)
}

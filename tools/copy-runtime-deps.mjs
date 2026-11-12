import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function copyRuntimeDependencies(fromManifest, targetModules) {
  const copied = new Set()
  function copy(name, from) {
    if (name.startsWith('@buddy-desktop/') || copied.has(name)) return
    const manifest = createRequire(from).resolve(name + '/package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const target = join(targetModules, name)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(dirname(manifest), target, { recursive: true, dereference: true, filter: source => basename(source) !== 'node_modules' })
    copied.add(name)
    for (const dep of Object.keys(pkg.dependencies ?? {})) copy(dep, manifest)
  }
  const pkg = JSON.parse(readFileSync(fromManifest, 'utf8'))
  for (const name of Object.keys(pkg.dependencies ?? {})) copy(name, fromManifest)
  return [...copied]
}

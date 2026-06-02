// Post-install fixup for the in-development class-XDR @stellar/stellar-sdk,
// which we install straight from its git branch (see the pnpm override).
//
// That branch's rollup build inlines @stellar/js-xdr's ESM source under
// lib/esm/node_modules/.pnpm/…/@stellar/js-xdr/ (a documented stopgap until
// js-xdr ships ESM). Plain Node loads these via the SDK's root `type:module`,
// but tsx/esbuild's nearest-package.json walk stops at the js-xdr boundary and
// treats the ESM-syntax files as CJS — which breaks every tsx-run example/demo
// (`UnsignedHyper` "is not exported"). Dropping a `{"type":"module"}` marker at
// each inlined js-xdr package root makes every loader treat it as ESM.
import { existsSync, readdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const esmRoot = realpathSync('node_modules/@stellar/stellar-sdk/lib/esm')
const inlinedDeps = join(esmRoot, 'node_modules')

if (!existsSync(inlinedDeps)) {
  // Published builds (or a different build layout) don't inline deps — nothing to do.
  console.log('patch-classxdr-esm: no inlined deps under lib/esm/node_modules; skipping')
  process.exit(0)
}

let marked = 0
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (entry.name === 'js-xdr') {
      writeFileSync(join(full, 'package.json'), '{ "type": "module" }\n')
      marked++
    } else {
      walk(full)
    }
  }
}
walk(inlinedDeps)
console.log(`patch-classxdr-esm: marked ${marked} inlined js-xdr package root(s) as ESM`)

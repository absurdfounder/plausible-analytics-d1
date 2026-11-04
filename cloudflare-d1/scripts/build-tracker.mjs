import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileFile } from '../../tracker/compiler/index.js'
import variants from '../../tracker/compiler/variants.json' with { type: 'json' }

const here = dirname(fileURLToPath(import.meta.url))
process.chdir(resolve(here, '../../tracker'))
const variant = variants.legacyVariants.find((item) => item.name === 'plausible.js')
const output = resolve(here, '../public/js/script.js')
await mkdir(dirname(output), { recursive: true })
const code = await compileFile(variant, { returnCode: true })
await import('node:fs/promises').then(({ writeFile }) => writeFile(output, code))
console.log(`Built official Plausible tracker at ${output}`)

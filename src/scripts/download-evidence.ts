import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDatabase } from '../db/client.js'
import { downloadObject } from '../lib/storage.js'

const key = process.argv[2]
if (!key) throw new Error('storage key required')
const out = process.argv[3] ?? path.join('/tmp', path.basename(key))
const body = await downloadObject(key)
await writeFile(out, body)
console.log(out, body.length)
await closeDatabase()

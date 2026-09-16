import assert from 'node:assert/strict'
import { it } from 'node:test'
import { db, runWithDatabase, type DatabaseTransaction } from './client.js'

it('nested services reuse the transaction and concurrent async contexts stay isolated', async () => {
  const fake = (name: string) => ({ select: () => name }) as unknown as DatabaseTransaction
  const results = await Promise.all(['a', 'b'].map((name) => runWithDatabase(fake(name), async () => {
    await new Promise((resolve) => setTimeout(resolve, 2))
    return db.select() as unknown as string
  })))
  assert.deepEqual(results, ['a', 'b'])
})

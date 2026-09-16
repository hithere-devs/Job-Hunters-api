import { sql } from 'drizzle-orm'
import { conflict } from '../lib/errors.js'
import { db, runWithDatabase } from '../db/client.js'

/** Cross-process lifecycle mutex. Held only while starting/stopping, never for the whole application. */
export type BrowserTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function withBrowserLifecycle<T>(userId: string, work: (tx: BrowserTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${`browser-lifecycle:${userId}`})) as locked`)
    if (!result.rows[0]?.locked) throw conflict('Your browser is starting or stopping. Try again in a moment.')
    return runWithDatabase(tx, () => work(tx))
  })
}

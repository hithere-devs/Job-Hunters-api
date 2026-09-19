import { sql } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'

await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS visa_sponsorship text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS work_mode text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS gender text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS sexual_orientation text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS ethnicity text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS veteran_status text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS disability_status text`)
await db.execute(sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS bound_by_agreements text`)
console.log('kit preference columns ready')
await closeDatabase()

import { eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { kits, users } from '../db/schema.js'

const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'mywritingfrenzy@gmail.com')).limit(1)
if (!user) throw new Error('no user')
await db.update(kits).set({
  gender: 'Male',
  sexualOrientation: 'Heterosexual / Straight',
  ethnicity: 'Indian',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'No, I do not have a disability',
  visaSponsorship: 'Required outside India',
  workMode: 'hybrid',
  boundByAgreements: 'No',
  updatedAt: new Date(),
}).where(eq(kits.userId, user.id))
console.log('seeded kit preferences for', user.id)
await closeDatabase()

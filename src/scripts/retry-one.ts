import { closeDatabase } from '../db/client.js'
import { retryApplication } from '../modules/applications/actions.js'

const userId = process.argv[2]
const applicationId = process.argv[3]
if (!userId || !applicationId) throw new Error('userId applicationId required')
const result = await retryApplication(userId, applicationId, { confirmedNotSubmitted: true })
console.log(result)
await closeDatabase()

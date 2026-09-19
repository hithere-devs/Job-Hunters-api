import { retryApplication } from '../modules/applications/actions.js'
import { closeDatabase } from '../db/client.js'
import { closeRedis } from '../lib/redis.js'

const userId = '1d4f5036-09a1-4df5-8509-e3ac99626b80'
const BLOCKED = new Set([
  '1215137d-7a69-409d-9cac-3c38ebc9c0cd', // Mercor Infra
  'a9dc23be-8471-41a2-8806-67d576c4ace6', // Fullstack spam
  '06c96dcc-39d3-469c-8f16-09551e91af73', // Atlan
  'a4690856-ca0f-4a03-ab90-7d9b6c7eb8d6', // Render Ashby spam
  'f7f035cc-1f21-40ca-a3c4-c218cfe10bdd', // Render application
  '93316a1c-cc04-4e94-8b52-7fb328e06c0a', // Meesho Lever submit clicked
  'd1555caa-7e71-44bd-9c32-4186fce5d156', // Weekday Workable submit clicked
])
const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
  'f06ced0a-4879-44fa-a621-9165c4e77e36', // GitLab
  '38db9f06-fdc3-4134-93aa-a4a856daa45c', // Elastic
  '1be3def6-6a3f-4a53-a8f6-7243b70419f3', // MongoDB
]

const results = []
for (const id of ids) {
  if (BLOCKED.has(id)) {
    results.push({ id, skipped: 'blocked' })
    continue
  }
  try {
    results.push({ id, ...(await retryApplication(userId, id)) })
  } catch (error) {
    results.push({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
console.log(JSON.stringify(results, null, 2))
await closeRedis().catch(() => undefined)
await closeDatabase().catch(() => undefined)

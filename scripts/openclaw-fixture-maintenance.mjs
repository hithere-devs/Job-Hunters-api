import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
/** No state-changing commands. Refuse to race a production worker or policy. */
export async function assertOpenClawMaintenance(tenant, approvalVariable = 'HUNTLY_FIXTURE_AUTHORIZED') {
  assert.ok([2, 9].includes(tenant), 'Only explicitly authorized test tenants 2 and 9 are supported; tenant3 is protected')
  assert.equal(process.env[approvalVariable], `tenant-${tenant}`, 'Explicit tenant maintenance authorization is required')
  assert.equal(await access(`/run/huntly-openclaw/tenant-${tenant}.json`).then(() => true, () => false), false, 'An application already owns this tenant')
  const require = createRequire('/opt/huntly/api/package.json')
  const settings = require('dotenv').parse(await readFile('/etc/huntly/runner.env'))
  const { Queue } = require('bullmq'), Redis = require('ioredis')
  const redis = new Redis(settings.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000 })
  redis.on('error', () => {})
  const queue = new Queue(settings.APPLICATION_QUEUE_NAME || 'hunt-apply', { connection: redis })
  queue.on('error', () => {})
  try {
    assert.equal(await queue.isPaused(), true)
    assert.equal(await queue.getActiveCount(), 0)
  } catch { throw new Error('Fixture requires a reachable paused application queue with no active jobs') }
  finally { redis.disconnect(); await queue.close().catch(() => {}) }
}

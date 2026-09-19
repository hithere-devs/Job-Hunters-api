import { and, eq } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, huntCandidates } from '../db/schema.js'

async function main() {
  const ids = ['38db9f06-fdc3-4134-93aa-a4a856daa45c','f06ced0a-4879-44fa-a621-9165c4e77e36','1be3def6-6a3f-4a53-a8f6-7243b70419f3']
  const out = []
  for (const id of ids) {
    const [app] = await db.select().from(applications).where(eq(applications.id, id)).limit(1)
    const [candidate] = await db.select({ sourcePortal: huntCandidates.sourcePortal, status: huntCandidates.status })
      .from(huntCandidates).where(and(eq(huntCandidates.userId, app!.userId), eq(huntCandidates.jobId, app!.jobId!), eq(huntCandidates.runId, app!.huntRunId!))).limit(1)
    out.push({ company: app!.company, portalId: app!.portalId, sourcePortal: candidate?.sourcePortal })
  }
  console.log(JSON.stringify(out, null, 2))
}
main().finally(() => closeDatabase())

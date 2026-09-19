import { and, eq } from 'drizzle-orm'
import { db, closeDatabase } from '../db/client.js'
import { applications, jobSources, jobs } from '../db/schema.js'

const ids = [
  '38db9f06-fdc3-4134-93aa-a4a856daa45c',
  'f06ced0a-4879-44fa-a621-9165c4e77e36',
  '1be3def6-6a3f-4a53-a8f6-7243b70419f3',
]

async function main() {
  const rows = []
  for (const id of ids) {
    const [app] = await db.select({
      id: applications.id,
      company: applications.company,
      jobId: applications.jobId,
      jobUrl: applications.jobUrl,
    }).from(applications).where(eq(applications.id, id)).limit(1)
    const [job] = app?.jobId
      ? await db.select({ applyUrl: jobs.applyUrl, canonicalUrl: jobs.canonicalUrl }).from(jobs).where(eq(jobs.id, app.jobId)).limit(1)
      : []
    const sources = app?.jobId
      ? await db.select({ portalId: jobSources.portalId, sourceId: jobSources.sourceId, applyUrl: jobSources.applyUrl })
        .from(jobSources).where(eq(jobSources.jobId, app.jobId))
      : []
    rows.push({ company: app?.company, jobUrl: app?.jobUrl, jobApplyUrl: job?.applyUrl, canonicalUrl: job?.canonicalUrl, sources })
  }
  console.log(JSON.stringify(rows, null, 2))
}

main().finally(() => closeDatabase())

import { sql } from 'drizzle-orm'
import { db } from '../../db/client.js'

/**
 * Where applications succeed and where they stop, by ATS, failure class and
 * runner build. The number that matters is started → confirmed, per
 * application (not per attempt: a transient retry that later succeeds is a
 * success). Deferred rows (nothing ran) are excluded.
 */
export async function applicationMetrics(userId: string, days = 30) {
  const since = sql`now() - make_interval(days => ${Math.max(1, Math.min(180, days))})`
  const scope = sql`a.user_id = ${userId} and a.created_at > ${since} and coalesce(a.failure_class, '') <> 'deferred'`
  const host = sql`regexp_replace(coalesce(nullif(j.apply_url, ''), j.canonical_url), '^https?://([^/]+).*$', '\\1')`

  const [summary] = (await db.execute(sql`
    with per_app as (
      select hc.id as candidate_id,
             bool_or(a.status = 'submitted') as submitted,
             bool_or(a.failure_class = 'uncertain_submit' and a.status <> 'submitted') as uncertain,
             bool_or(a.failure_class = 'needs_answer') as needs_answer,
             bool_or(a.failure_class in ('posting_closed', 'unsupported')) as not_applicable
      from apply_attempts a join hunt_candidates hc on hc.id = a.candidate_id
      where ${scope}
      group by hc.id
    )
    select count(*)::int as applications,
           count(*) filter (where submitted)::int as submitted,
           count(*) filter (where uncertain and not submitted)::int as uncertain,
           count(*) filter (where needs_answer and not submitted)::int as needs_answer,
           count(*) filter (where not_applicable and not submitted)::int as not_applicable
    from per_app`)).rows as Array<{ applications: number; submitted: number; uncertain: number; needs_answer: number; not_applicable: number }>

  const byHost = (await db.execute(sql`
    select ${host} as host,
           count(distinct hc.id)::int as applications,
           count(distinct hc.id) filter (where a.status = 'submitted')::int as submitted,
           count(*) filter (where a.failure_class = 'needs_answer')::int as needs_answer,
           count(*) filter (where a.failure_class = 'automation')::int as automation,
           count(*) filter (where a.failure_class = 'uncertain_submit')::int as uncertain,
           count(*) filter (where a.failure_class = 'transient')::int as transient
    from apply_attempts a join hunt_candidates hc on hc.id = a.candidate_id join jobs j on j.id = hc.job_id
    where ${scope}
    group by 1 order by 2 desc limit 25`)).rows

  const byFailure = (await db.execute(sql`
    select coalesce(a.failure_class, case when a.status = 'submitted' then 'submitted' else 'unclassified' end) as failure_class,
           count(*)::int as attempts
    from apply_attempts a where ${scope} group by 1 order by 2 desc`)).rows

  const byVersion = (await db.execute(sql`
    select coalesce(a.runner_version, 'unknown') as runner_version, coalesce(a.schema_source, 'none') as schema_source,
           count(*)::int as attempts, count(*) filter (where a.status = 'submitted')::int as submitted
    from apply_attempts a where ${scope} group by 1, 2 order by 3 desc limit 20`)).rows

  const topBlockers = (await db.execute(sql`
    select left(f->>'label', 120) as label, f->>'why' as why, count(*)::int as attempts
    from apply_attempts a, jsonb_array_elements(case when jsonb_typeof(a.unresolved_fields) = 'array' then a.unresolved_fields else '[]'::jsonb end) f
    where ${scope} and a.status <> 'submitted'
    group by 1, 2 order by 3 desc limit 20`)).rows

  const base = summary ?? { applications: 0, submitted: 0, uncertain: 0, needs_answer: 0, not_applicable: 0 }
  const eligible = Math.max(0, base.applications - base.not_applicable)
  return {
    days,
    ...base,
    /** Started → confirmed, excluding closed postings and account walls. */
    successRate: eligible ? Number((base.submitted / eligible).toFixed(3)) : null,
    byHost,
    byFailure,
    byVersion,
    topBlockers,
  }
}

import { and, eq } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { applications, employments, jobs, kits, pendingApplicationQuestions } from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { draftApplicationAnswer } from '../../hunt/apply/answer-draft.js'

export async function draftForOwnedQuestion(userId: string, questionId: string) {
  const [row] = await db.select({ question: pendingApplicationQuestions, application: applications }).from(pendingApplicationQuestions).innerJoin(applications, and(eq(applications.id, pendingApplicationQuestions.applicationId), eq(applications.userId, userId))).where(and(eq(pendingApplicationQuestions.id, questionId), eq(pendingApplicationQuestions.userId, userId))).limit(1)
  if (!row) throw notFound('Application question not found.')
  const [[kit], experience, jobRows] = await Promise.all([
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db.select().from(employments).where(eq(employments.userId, userId)).orderBy(employments.sortOrder).limit(3),
    row.application.jobId ? db.select({ skills: jobs.skills }).from(jobs).where(eq(jobs.id, row.application.jobId)).limit(1) : [],
  ])
  const q = row.question
  return draftApplicationAnswer({ label: q.label, name: q.fieldName ?? undefined, type: q.type, required: q.required, options: q.options }, {
    role: row.application.role, company: row.application.company, headline: kit?.headline, skills: kit?.skills ?? [], jobSkills: jobRows[0]?.skills ?? [], experience: experience.map((entry) => ({ role: entry.role, company: entry.company, description: entry.blurb })),
  })
}

/** Mount at /applications. Drafting never saves an answer or resumes a queue. */
export const questionDraftsRouter: Router = Router()
questionDraftsRouter.use(requireAuth)
questionDraftsRouter.post('/questions/:questionId/draft', validate({ params: z.object({ questionId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  ok(res, await draftForOwnedQuestion(currentUser(req).id, pathParam(req, 'questionId')))
}))

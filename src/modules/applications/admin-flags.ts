import { Router } from 'express'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { attemptFlags, applyAttempts, attemptEvents } from '../../db/schema.js'
import { env } from '../../config/env.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
import { conflict, forbidden, notFound } from '../../lib/errors.js'
import { validate } from '../../middleware/validate.js'
import { createSignedUrl } from '../../lib/storage.js'

export function isFlagAdministrator(userId: string, allowlist: string | undefined) {
  return (allowlist ?? '').split(',').map(id => id.trim()).filter(id => z.string().uuid().safeParse(id).success).includes(userId)
}
export const adminFlagsRouter = Router()
adminFlagsRouter.use(requireAuth, (req, _res, next) => {
  if (!isFlagAdministrator(currentUser(req).id, env.ADMIN_USER_IDS)) return next(forbidden('Administrator access required.'))
  next()
})
adminFlagsRouter.get('/flags', asyncHandler(async (_req,res) => {
  const rows = await db.select({flag:attemptFlags,attempt:applyAttempts}).from(attemptFlags)
    .innerJoin(applyAttempts, eq(applyAttempts.id,attemptFlags.attemptId))
    .where(eq(attemptFlags.status,'open')).orderBy(asc(attemptFlags.createdAt)).limit(100)
  const result = await Promise.all(rows.map(async row => ({...row.flag,
    attemptStatus:row.attempt.status,
    evidenceUrl:row.attempt.evidenceStoragePath ? await createSignedUrl(row.attempt.evidenceStoragePath) : null,
    events:await db.select().from(attemptEvents).where(eq(attemptEvents.attemptId,row.attempt.id)).orderBy(desc(attemptEvents.at)).limit(100),
  })))
  ok(res,result)
}))
adminFlagsRouter.post('/flags/:id/resolve', validate({params:z.object({id:z.string().uuid()}),body:z.object({note:z.string().trim().min(1).max(1000)})}), asyncHandler(async(req,res) => {
  const [row] = await db.select({flag:attemptFlags,attempt:applyAttempts}).from(attemptFlags).innerJoin(applyAttempts,eq(applyAttempts.id,attemptFlags.attemptId)).where(eq(attemptFlags.id,pathParam(req,'id'))).limit(1)
  if (!row) throw notFound('Flag not found')
  if (['pending','submitting'].includes(row.attempt.status)) throw conflict('Wait for the current attempt to stop before resuming future applications.')
  await db.update(attemptFlags).set({status:'resolved',resolvedAt:new Date(),note:`${row.flag.note ?? ''}\nResolved by ${currentUser(req).id}: ${req.body.note}`}).where(and(eq(attemptFlags.id,row.flag.id),eq(attemptFlags.status,'open')))
  const [remaining] = await db.select({id:attemptFlags.id}).from(attemptFlags).where(and(eq(attemptFlags.userId,row.flag.userId),eq(attemptFlags.status,'open'))).limit(1)
  ok(res,{resolved:true,queuePaused:Boolean(remaining)})
}))

import { and, eq } from 'drizzle-orm'
import { Router } from 'express'
import { db } from '../../db/client.js'
import { kits, portalAccounts, resumes, userBrowserSessions, users, type Kit } from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { asyncHandler, created, noContent, ok, pathParam } from '../../lib/http.js'
import { buildObjectKey, createSignedUrl, downloadObject, removeObject, uploadObject } from '../../lib/storage.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { photoUpload } from '../../middleware/upload.js'
import { disconnectTenant, ensureTenantConnected, getTenantScreenshot, uploadTenantResume } from '../../browser/vm-client.js'
import { PROVIDERS, providerById, verifyProviders } from '../../browser/providers.js'
import { verifyFromScreen } from '../../browser/verify-screen.js'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import { validate } from '../../middleware/validate.js'
import {
  serializeEmployment,
  serializeKit,
  serializeUserWithKit,
} from '../../serializers/user.js'
import {
  completeOnboardingSchema,
  employmentSchema,
  employmentUpdateSchema,
  idParamSchema,
  updateKitSchema,
  updateProfileSchema,
} from './schemas.js'
import {
  completeOnboarding,
  createEmployment,
  deleteEmployment,
  getEmployments,
  getKit,
  getOnboardingSubmissions,
  updateEmployment,
  updateKit,
  updateProfile,
} from './service.js'

export const meRouter: Router = Router()

meRouter.use(requireAuth)

async function browserSessionFor(userId: string) {
  const [row] = await db.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1)
  return row
}

async function allocateBrowserSession(userId: string) {
  const existing = await browserSessionFor(userId)
  if (existing) return existing
  const occupied = await db.select({ tenantIndex: userBrowserSessions.tenantIndex }).from(userBrowserSessions).where(eq(userBrowserSessions.vmId, env.VM_ID))
  const used = new Set(occupied.map((r) => r.tenantIndex))
  const tenantIndex = Array.from({ length: 10 }, (_, n) => n + 1).find((n) => !used.has(n))
  if (!tenantIndex) throw badRequest('All browser session slots are in use.')
  const [createdRow] = await db.insert(userBrowserSessions).values({ userId, vmId: env.VM_ID, tenantIndex }).returning()
  if (!createdRow) throw badRequest('Could not allocate a browser session slot.')
  return createdRow
}

function accessTokenFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}

meRouter.post('/browser-session/connect', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  const session = await allocateBrowserSession(auth.id)
  // Reconnect to the window that is already open; close anything in another
  // mode first. See `ensureTenantConnected` for why that is the only sane
  // policy for a slot owned by exactly one user.
  const { expiresAt, outcome } = await ensureTenantConnected(session.tenantIndex)
  await db.update(userBrowserSessions).set({ status: 'connecting', updatedAt: new Date() }).where(eq(userBrowserSessions.id, session.id))
  const token = accessTokenFromRequest(req)
  ok(res, {
    streamUrl: `/me/browser-session/stream?token=${encodeURIComponent(token)}&sessionId=${session.id}`,
    tenantIndex: session.tenantIndex,
    expiresAt,
    outcome,
  })
}))

meRouter.post('/browser-session/disconnect', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  const session = await browserSessionFor(auth.id)
  if (!session) return ok(res, { connected: false, cookieDomains: [], providers: [] })

  // The screen is captured *before* the browser stops — afterwards there is
  // nothing left to photograph.
  const expectedId = typeof req.query.provider === 'string' ? req.query.provider : null
  const expected = expectedId ? providerById(expectedId) : null
  const shot = expected ? await getTenantScreenshot(session.tenantIndex) : null

  const result = await disconnectTenant(session.tenantIndex)
  const domains = result.cookieDomains
  // An older agent answers with hosts only. Fail closed rather than guessing:
  // a host proves the page was loaded, not that anyone signed in.
  const cookies = result.cookies ?? []
  let providers = verifyProviders(cookies)

  // Screen check, only where cookies came up short. It can rescue a
  // verification, never overrule one — see `verify-screen.ts`.
  if (expected && shot && !providers.find((p) => p.id === expected.id)?.verified) {
    const verdict = await verifyFromScreen({ png: shot, provider: expected })
    if (verdict?.signedIn) {
      logger.info({ provider: expected.id, reason: verdict.reason }, 'verified from the screen, not cookies')
      providers = providers.map((p) => (p.id === expected.id ? { ...p, verified: true } : p))
    }
    // The names we saw but did not recognise are how the registry gets fixed.
    const seen = providers.find((p) => p.id === expected.id)?.unmatched ?? []
    if (seen.length > 0) {
      logger.info({ provider: expected.id, unmatched: seen }, 'cookie names on this provider that are not in the registry')
    }
  }

  const now = new Date()
  await db.update(userBrowserSessions).set({ status: 'ready', cookieDomains: domains, lastVerifiedAt: now, updatedAt: now }).where(eq(userBrowserSessions.id, session.id))
  const profileId = `vm:${session.vmId}:${session.tenantIndex}`
  for (const provider of providers) {
    if (!provider.verified) continue
    await db.update(portalAccounts).set({ status: 'ready', browserProfileId: profileId, lastVerifiedAt: now, updatedAt: now }).where(and(eq(portalAccounts.userId, auth.id), eq(portalAccounts.portalId, provider.id)))
  }
  ok(res, { connected: false, cookieDomains: domains, providers })
}))

meRouter.get('/browser-session', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  const session = await browserSessionFor(auth.id)
  // Verified state is read back from `portal_accounts`, which is where the
  // disconnect handler recorded it after a real cookie or screen check. The
  // stored cookie domains cannot be re-checked here — they carry no cookie
  // names, and a domain alone proves nothing.
  const connected = session
    ? await db.select({ portalId: portalAccounts.portalId }).from(portalAccounts).where(and(eq(portalAccounts.userId, auth.id), eq(portalAccounts.status, 'ready')))
    : []
  const ready = new Set(connected.map((row) => row.portalId))
  ok(res, {
    status: session?.status ?? 'absent',
    cookieDomains: session?.cookieDomains ?? [],
    lastVerifiedAt: session?.lastVerifiedAt ?? null,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      url: provider.url,
      verified: ready.has(provider.id),
      setup: provider.setup,
      signupMethod: provider.signupMethod,
      supportsScraping: provider.supportsScraping,
      supportsApplying: provider.supportsApplying,
      emailConfirmationRelevant: provider.emailConfirmationRelevant,
    })),
  })
}))

/** Copy the user's stored base resume to the VM profile's private run folder.
 * The browser UI can then choose this file in a native upload dialog; the API
 * never exposes the storage object publicly or stores a second credential. */
meRouter.post('/browser-session/resume', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  const session = await browserSessionFor(auth.id)
  if (!session) throw badRequest('Connect your browser session before preparing a resume upload.')
  const [resume] = await db.select().from(resumes).where(and(eq(resumes.userId, auth.id), eq(resumes.isBase, true))).limit(1)
  if (!resume) throw notFound('Upload a base resume to Huntly first.')
  const bytes = await downloadObject(resume.storagePath)
  const uploaded = await uploadTenantResume(session.tenantIndex, bytes)
  ok(res, { ...uploaded, fileName: resume.fileName })
}))

async function serializeKitResponse(kit: Kit | undefined) {
  const data = serializeKit(kit)
  if (!kit?.photoStoragePath) return data
  return { ...data, photoUrl: await createSignedUrl(kit.photoStoragePath) }
}

function validPhotoSignature(file: Express.Multer.File): boolean {
  const bytes = file.buffer
  if (file.mimetype === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (file.mimetype === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

/**
 * `GET /me` is what the UI's AuthProvider calls on boot to restore a session,
 * so its shape has to match the `User` type in `src/auth/context.ts` exactly —
 * including the flattened `kit` projection.
 */
meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db.select().from(users).where(eq(users.id, auth.id)).limit(1)
    if (!row) throw notFound('User not found')
    ok(res, await serializeUserWithKit(row))
  }),
)

meRouter.patch(
  '/',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const row = await updateProfile(auth.id, req.body)
    ok(res, await serializeUserWithKit(row))
  }),
)

/* ---------------------------------------------------------------- the kit */

/** The full Kit screen: personal details, links, the awkward questions. */
meRouter.get(
  '/kit',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [kit, history] = await Promise.all([getKit(auth.id), getEmployments(auth.id)])
    ok(res, {
      ...(await serializeKitResponse(kit)),
      employments: history.map(serializeEmployment),
    })
  }),
)

/**
 * PUT rather than PATCH by name, but partial by behaviour: the UI saves the
 * whole form at once, and omitted keys are left alone rather than nulled.
 * Sending `null` explicitly is how a field gets cleared.
 */
meRouter.put(
  '/kit',
  validate({ body: updateKitSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const kit = await updateKit(auth.id, req.body)
    const history = await getEmployments(auth.id)
    ok(res, { ...(await serializeKitResponse(kit)), employments: history.map(serializeEmployment) })
  }),
)

meRouter.post(
  '/kit/photo',
  photoUpload.single('photo'),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const file = req.file
    if (!file) throw badRequest('Attach the profile photo as a `photo` field.')
    if (!validPhotoSignature(file)) throw badRequest('Profile photo bytes do not match its file type.')

    const [existing] = await db.select().from(kits).where(eq(kits.userId, auth.id)).limit(1)
    if (!existing) throw notFound('Kit not found')

    const key = buildObjectKey(auth.id, 'profile-photo', file.originalname)
    await uploadObject({ key, body: file.buffer, mimeType: file.mimetype })

    let updated: Kit | undefined
    try {
      ;[updated] = await db
        .update(kits)
        .set({
          photoStoragePath: key,
          photoFileName: file.originalname,
          photoMimeType: file.mimetype,
          updatedAt: new Date(),
        })
        .where(eq(kits.userId, auth.id))
        .returning()
    } catch (error) {
      await removeObject(key)
      throw error
    }

    if (!updated) throw notFound('Kit not found')
    if (existing.photoStoragePath) await removeObject(existing.photoStoragePath)
    const history = await getEmployments(auth.id)
    ok(res, { ...(await serializeKitResponse(updated)), employments: history.map(serializeEmployment) })
  }),
)

meRouter.delete(
  '/kit/photo',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [existing] = await db.select().from(kits).where(eq(kits.userId, auth.id)).limit(1)
    if (!existing) throw notFound('Kit not found')
    await db
      .update(kits)
      .set({
        photoStoragePath: null,
        photoFileName: null,
        photoMimeType: null,
        updatedAt: new Date(),
      })
      .where(eq(kits.userId, auth.id))
    if (existing.photoStoragePath) await removeObject(existing.photoStoragePath)
    noContent(res)
  }),
)

/* --------------------------------------------------------- employment rows */

meRouter.get(
  '/kit/employments',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const rows = await getEmployments(auth.id)
    ok(res, rows.map(serializeEmployment))
  }),
)

meRouter.post(
  '/kit/employments',
  validate({ body: employmentSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    created(res, serializeEmployment(await createEmployment(auth.id, req.body)))
  }),
)

meRouter.patch(
  '/kit/employments/:id',
  validate({ params: idParamSchema, body: employmentUpdateSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const row = await updateEmployment(auth.id, pathParam(req, 'id'), req.body)
    ok(res, serializeEmployment(row))
  }),
)

meRouter.delete(
  '/kit/employments/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    await deleteEmployment(auth.id, pathParam(req, 'id'))
    noContent(res)
  }),
)

/* -------------------------------------------------------------- onboarding */

/**
 * Replaces `completeOnboarding` in the demo AuthContext. Returns the whole
 * user so the client can swap its state in one assignment, exactly as the
 * demo's `setUser` did.
 */
meRouter.post(
  '/onboarding',
  validate({ body: completeOnboardingSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const result = await completeOnboarding(auth.id, req.body)
    ok(
      res,
      await serializeUserWithKit(result.user),
      // Surfaced rather than swallowed: a portal id the UI knows about but the
      // catalogue does not is a bug worth seeing.
      result.unknownPortals.length > 0 ? { unknownPortals: result.unknownPortals } : undefined,
    )
  }),
)

/** The raw wizard answers, kept for audit. Not used by any screen. */
meRouter.get(
  '/onboarding/submissions',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    ok(res, await getOnboardingSubmissions(auth.id))
  }),
)

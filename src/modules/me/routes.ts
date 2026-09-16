import { withBrowserLifecycle } from '../../browser/lifecycle.js'
import { providerCatalogue } from '../../browser/provider-catalogue.js'
import { and, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { db } from '../../db/client.js'
import { kits, portalAccounts, resumes, userBrowserSessions, users, type Kit } from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { asyncHandler, created, noContent, ok, pathParam } from '../../lib/http.js'
import { buildObjectKey, createSignedUrl, downloadObject, removeObject, uploadObject } from '../../lib/storage.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { photoUpload } from '../../middleware/upload.js'
import { disconnectTenant, ensureTenantConnected, getTenantStatus, uploadTenantResume, VmAgentBusyError } from '../../browser/vm-client.js'
import { PROVIDERS, hostMatchesDomain, sessionVerificationStatus, verifyProviders } from '../../browser/providers.js'
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
  // Serialize slot assignment across API processes, not just this Node instance.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`browser-slots:${env.VM_ID}`}))`)
    const [existing] = await tx.select().from(userBrowserSessions).where(eq(userBrowserSessions.userId, userId)).limit(1)
    if (existing) {
      if (existing.vmId !== env.VM_ID) throw badRequest('Your browser host is unavailable. Contact support; your profile has been preserved.')
      return existing
    }
    const occupied = await tx.select({ tenantIndex: userBrowserSessions.tenantIndex }).from(userBrowserSessions).where(eq(userBrowserSessions.vmId, env.VM_ID))
    const used = new Set(occupied.map((row) => row.tenantIndex))
    // Tenant 3 has a protected human-created profile; never assign it automatically.
    used.add(3)
    const tenantIndex = Array.from({ length: 10 }, (_, n) => n + 1).find((n) => !used.has(n))
    if (!tenantIndex) throw badRequest('All browser session slots are in use. Please contact support.')
    const [row] = await tx.insert(userBrowserSessions).values({ userId, vmId: env.VM_ID, tenantIndex }).returning()
    if (!row) throw badRequest('Could not allocate a browser session slot.')
    return row
  })
}

function accessTokenFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}

meRouter.post('/browser-session/connect', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  return withBrowserLifecycle(auth.id, async () => {
  const session = await allocateBrowserSession(auth.id)
  // Reuse an interactive window; an active application returns 409 untouched.
  const { expiresAt, outcome } = await ensureTenantConnected(session.tenantIndex)
  await db.update(userBrowserSessions).set({ status: 'connecting', updatedAt: new Date() }).where(eq(userBrowserSessions.id, session.id))
  const token = accessTokenFromRequest(req)
  ok(res, {
    streamUrl: `/me/browser-session/stream?token=${encodeURIComponent(token)}&sessionId=${session.id}`,
    tenantIndex: session.tenantIndex,
    expiresAt,
    outcome,
  })
  })
}))

meRouter.post('/browser-session/disconnect', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  return withBrowserLifecycle(auth.id, async () => {
  const session = await browserSessionFor(auth.id)
  if (!session) return ok(res, { connected: false, cookieDomains: [], providers: [] })

  if (session.vmId !== env.VM_ID) throw badRequest('Your browser host is unavailable.')
  const live = await getTenantStatus(session.tenantIndex)
  if (live.mode === 'apply') throw new VmAgentBusyError('apply')
  const result = await disconnectTenant(session.tenantIndex)
  const domains = result.cookieDomains
  const providers = verifyProviders(result.cookies ?? [])
  const now = new Date()
  const status = sessionVerificationStatus(providers, session.lastVerifiedAt !== null)
  const profileId = `vm:${session.vmId}:${session.tenantIndex}`
  await db.transaction(async (tx) => {
    await tx.update(userBrowserSessions).set({ status, cookieDomains: domains, lastVerifiedAt: now, updatedAt: now }).where(eq(userBrowserSessions.id, session.id))
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, auth.id)).limit(1)
    for (const provider of providers) {
      const state = {
        status: provider.verified ? 'ready' as const : 'pending_verification' as const,
        browserProfileId: profileId,
        lastVerifiedAt: provider.verified ? now : null,
        actionRequired: provider.verified ? null : 'Reconnect and verify this provider in your browser session.',
        updatedAt: now,
      }
      await tx.insert(portalAccounts).values({ userId: auth.id, portalId: provider.id, email: user!.email, ...state }).onConflictDoUpdate({ target: [portalAccounts.userId, portalAccounts.portalId], set: state })
    }
  })
  ok(res, { connected: false, status, cookieDomains: domains, providers })
  })
}))

/** Disable Huntly access without deleting credentials or releasing a dirty tenant to another user. */
meRouter.post('/browser-session/remove', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  return withBrowserLifecycle(auth.id, async () => {
  if (req.body?.confirm !== true) throw badRequest('Confirm removal before disconnecting this session.')
  const session = await browserSessionFor(auth.id)
  if (!session) return ok(res, { removed: true, profileDeleted: false })
  if (session.vmId !== env.VM_ID) throw badRequest('Your browser host is unavailable.')
  const live = await getTenantStatus(session.tenantIndex)
  if (live.mode === 'apply') throw new VmAgentBusyError('apply')
  if (live.mode === 'connect') await disconnectTenant(session.tenantIndex)
  const profileId = `vm:${session.vmId}:${session.tenantIndex}`
  await db.transaction(async (tx) => {
    await tx.update(userBrowserSessions).set({ status: 'absent', cookieDomains: [], lastVerifiedAt: null, updatedAt: new Date() }).where(eq(userBrowserSessions.id, session.id))
    await tx.update(portalAccounts).set({ status: 'absent', browserProfileId: null, lastVerifiedAt: null, actionRequired: 'Session disconnected from Huntly. Reconnect to use it again.', updatedAt: new Date() }).where(and(eq(portalAccounts.userId, auth.id), eq(portalAccounts.browserProfileId, profileId)))
  })
  ok(res, { removed: true, profileDeleted: false, historyRetained: true })
  })
}))

meRouter.get('/browser-session', asyncHandler(async (req, res) => {
  const auth = currentUser(req)
  const session = await browserSessionFor(auth.id)
  // Verified state is read back from `portal_accounts`, which is where the
  // disconnect handler recorded it after a cookie-evidence check. The
  // stored cookie domains cannot be re-checked here — they carry no cookie
  // names, and a domain alone proves nothing.
  const connected = session
    ? await db.select({ portalId: portalAccounts.portalId, lastVerifiedAt: portalAccounts.lastVerifiedAt }).from(portalAccounts).where(and(eq(portalAccounts.userId, auth.id), eq(portalAccounts.status, 'ready'), eq(portalAccounts.browserProfileId, `vm:${session.vmId}:${session.tenantIndex}`)))
    : []
  const ready = new Set(connected.map((row) => row.portalId))
  ok(res, {
    catalogue: providerCatalogue(),
    status: session?.status ?? 'absent',
    cookieDomains: session?.cookieDomains ?? [],
    lastVerifiedAt: session?.lastVerifiedAt ?? null,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      url: provider.url,
      verified: session?.status !== 'absent' && ready.has(provider.id),
      status: session?.status === 'absent' ? 'disconnected' : ready.has(provider.id) ? 'ready' : session?.lastVerifiedAt ? 'stale' : 'disconnected',
      domain: provider.domain,
      cookieDomains: (session?.cookieDomains ?? []).filter((host) => hostMatchesDomain(host, provider.domain)),
      lastVerifiedAt: connected.find((row) => row.portalId === provider.id)?.lastVerifiedAt ?? null,
      verificationEvidence: 'session_cookie_present',
      verificationNote: 'Cookie evidence can expire or be rejected by the provider. Login challenges are checked again during application.',
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
  if (!session || session.status === 'absent') throw badRequest('Connect your browser session before preparing a resume upload.')
  if (session.vmId !== env.VM_ID) throw badRequest('Your browser host is unavailable.')
  const live = await getTenantStatus(session.tenantIndex)
  if (live.mode !== 'connect') throw new VmAgentBusyError(live.mode)
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

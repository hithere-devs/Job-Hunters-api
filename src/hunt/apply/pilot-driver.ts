import type { Page } from 'playwright-core'
import { logger } from '../../lib/logger.js'
import { candidateState, compactCandidate, type JobContext } from './candidate-state.js'
import { publishAttemptEvent } from './events.js'
import { attachResume, hasSubmissionConfirmation, postingIsClosed, type FillResult, type FilledField } from './fill.js'
import { fillVerificationCode, readGmailVerificationCode } from './gmail-code.js'
import { jevDecide, jevRead } from './jev-client.js'
import { kitSuggestion } from './apply-preferences.js'
import { pickOptionWithJev, resolvePilotAnswer } from './pilot-answers.js'
import { decidePilotTerminal, filterPilotUnresolved, pageHasVerificationGate } from './pilot-outcome.js'
import { applyIsStalled, applyMadeProgress, leftoverSignature, stallMoveFromJev } from './apply-stall.js'
import { fieldsToRepairAfterSubmit } from './submit-errors.js'
import {
  actOnPage,
  clickListedDropdownOption,
  clickRadioOption,
  DROPDOWN_AFTER_TYPE_MS,
  ensureApplyPilot,
  snapshotPage,
  typeAndListDropdownOptions,
  type PilotElement,
  type PilotSnapshot,
} from './pilot-page.js'
import type { PortalProfile } from '../portal-profile.js'
import type { BlockedReason } from './state.js'

const MAX_STEPS = 48
const FIELD_ROLES = new Set(['textbox', 'textarea', 'email', 'tel', 'url', 'combobox', 'select', 'radio', 'checkbox', 'yesno', 'file', 'text', 'number'])

function failKey(element: { role: string; label: string }): string {
  return `${element.role}:${element.label}`
}

async function rethinkStalledApply(params: {
  userId: string
  leftover: string[]
  history: string[]
  url: string
  pageText: string
}): Promise<ReturnType<typeof stallMoveFromJev>> {
  const errorSeen = /error processing your application|incorrect security code|this field is required|invalid/i.test(params.pageText)
  const decision = await jevDecide({
    userId: params.userId,
    state: {
      stalled: true,
      leftover: params.leftover,
      recent_actions: params.history.slice(-8),
      url: params.url,
      error_seen: errorSeen,
      page_error: errorSeen ? params.pageText.slice(0, 400) : null,
    },
    questions: {
      stall_move: {
        type: 'choice',
        instructions: 'Nothing has changed on this application for 30 seconds, or a form error is still showing. Decide how to continue. Prefer retrying the same leftover field unless it is clearly impossible.',
        criteria: {
          retry_same: 'Retry filling the same leftover field, including typing again and waiting for the dropdown list',
          try_next: 'Leave this field and fill a different leftover field',
          wait: 'The page is still loading; wait and then continue',
          click: 'Click a visible option, Next, Continue, or cookie button',
          submit: 'The form looks complete enough to submit',
          fail: 'This application cannot continue',
        },
      },
    },
  }).catch(() => null)
  return stallMoveFromJev(jevRead.choice(decision?.answers.stall_move))
}

async function fillComboboxByJevPick(params: {
  page: Page
  element: PilotElement
  query: string
  candidate: ReturnType<typeof candidateState>
  userId: string
}): Promise<{ ok: boolean; picked: string | null }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listed = await typeAndListDropdownOptions(params.page, params.element.id, params.query)
    if (!listed.length) continue
    const fromJev = listed.length === 1
      ? listed[0]!
      : await pickOptionWithJev({
        element: { ...params.element, options: listed },
        candidate: params.candidate,
        userId: params.userId,
      }).catch(() => null)
    const fromKit = kitSuggestion({ label: params.element.label, options: listed, candidate: params.candidate }).value
    const picked = fromJev
      ?? fromKit
      ?? listed.find((option) => option.toLowerCase().includes(params.query.split(',')[0]!.trim().toLowerCase()))
      ?? null
    if (!picked) continue
    const clicked = await clickListedDropdownOption(params.page, picked)
    if (clicked) return { ok: true, picked }
    await new Promise((resolve) => setTimeout(resolve, DROPDOWN_AFTER_TYPE_MS))
  }
  return { ok: false, picked: null }
}

function mergePageAnswers(filledById: Map<string, FilledField>, snap: { elements: PilotElement[] } | null) {
  if (!snap) return
  for (const element of snap.elements) {
    if (!FIELD_ROLES.has(element.role) || element.role === 'file' || element.role === 'button' || element.role === 'link') continue
    if (!element.value) continue
    const existing = [...filledById.values()].find((row) => row.label === element.label)
    if (existing) {
      existing.value = element.value.slice(0, 500)
      existing.filled = element.filled || existing.filled
    } else if (element.filled) {
      filledById.set(element.id, {
        label: element.label,
        via: 'heuristic',
        filled: true,
        value: element.value.slice(0, 500),
        source: 'page',
      })
    }
  }
}

export interface PilotJobContext extends JobContext {
  applicationId?: string
  role?: string
}

function compactElements(elements: PilotElement[]) {
  const fields = elements.filter((element) => FIELD_ROLES.has(element.role))
  const buttons = elements.filter((element) => element.role === 'button' || element.role === 'link')
  const unfilled = fields.filter((element) => !element.filled)
  const filled = fields.filter((element) => element.filled)
  const picked = [...unfilled, ...buttons.slice(0, 12), ...filled.slice(0, 8)].slice(0, 36)
  return picked.map((element) => ({
    id: element.id,
    role: element.role,
    label: element.label.slice(0, 160),
    required: element.required,
    filled: element.filled,
    value: element.filled ? String(element.value || '').slice(0, 60) : '',
    options: element.options.slice(0, 12),
  }))
}

function targetCriteria(elements: ReturnType<typeof compactElements>): Record<string, string> {
  const criteria: Record<string, string> = { none: 'No specific control. Use WAIT, ASK, DONE, or FAIL.' }
  for (const element of elements) {
    const status = element.filled ? 'filled' : element.required ? 'required empty' : 'empty'
    criteria[element.id] = `${element.role} · ${element.label} · ${status}`
  }
  return criteria
}

async function harvestMissingOptions(
  page: Page,
  snap: PilotSnapshot,
  done: Set<string>,
  cache: Map<string, string[]>,
): Promise<PilotSnapshot> {
  for (const element of snap.elements) {
    const cached = cache.get(element.id)
    if (cached?.length && element.options.length === 0) element.options = cached
  }
  const hungry = snap.elements.filter((element) =>
    (element.role === 'combobox' || element.role === 'select')
    && !element.filled
    && element.options.length === 0
    && !done.has(element.id)
    && !/phone country|country code/i.test(element.label),
  ).slice(0, 2)
  for (const element of hungry) {
    done.add(element.id)
    const harvested = await actOnPage(page, { op: 'harvest', id: element.id }).catch(() => null)
    if (harvested?.options?.length) {
      element.options = harvested.options
      cache.set(element.id, harvested.options)
    }
  }
  return snap
}

function unresolvedFrom(elements: PilotElement[], why: BlockedReason = 'needs_input'): FillResult['unresolved'] {
  return filterPilotUnresolved(elements, why)
}

async function fillKnownAnswers(params: {
  page: Page
  elements: PilotElement[]
  candidate: ReturnType<typeof candidateState>
  userId: string
  filledById: Map<string, FilledField>
  answerCache: Map<string, string>
  failCounts: Map<string, number>
  history: string[]
}): Promise<number> {
  let wrote = 0
  for (const element of params.elements) {
    if (!FIELD_ROLES.has(element.role) || element.filled || element.role === 'file') continue
    if ((params.failCounts.get(failKey(element)) ?? 0) >= 2) continue
    const cached = params.answerCache.get(element.label)
    const answered = cached
      ? { value: cached, source: 'profile' as const }
      : await resolvePilotAnswer({ element, candidate: params.candidate, userId: params.userId }).catch(() => null)
    if (!answered?.value) {
      params.failCounts.set(failKey(element), (params.failCounts.get(failKey(element)) ?? 0) + 1)
      continue
    }
    params.answerCache.set(element.label, answered.value)
    let ok = false
    let picked = answered.value
    let source: FilledField['source'] = answered.source === 'profile' ? 'kit' : answered.source === 'jev' ? 'jev' : 'llm'
    if (element.role === 'radio' || element.role === 'yesno') {
      ok = await clickRadioOption(params.page, element.label, answered.value)
    }
    if (!ok && (element.role === 'combobox' || element.role === 'select')) {
      const listed = await fillComboboxByJevPick({
        page: params.page,
        element,
        query: answered.value,
        candidate: params.candidate,
        userId: params.userId,
      })
      ok = listed.ok
      if (listed.picked) {
        picked = listed.picked
        source = 'jev'
        params.answerCache.set(element.label, listed.picked)
      }
    }
    if (!ok) {
      const written = await actOnPage(params.page, { op: 'fill', id: element.id, value: answered.value }).catch(() => null)
      ok = Boolean(written?.ok && written.filled !== false)
    }
    params.filledById.set(element.id, {
      label: element.label,
      via: answered.source === 'profile' ? 'heuristic' : 'model',
      filled: ok,
      value: picked.slice(0, 500),
      source,
    })
    params.history.push(`kit-fill:${element.label}`)
    if (!ok) params.failCounts.set(failKey(element), (params.failCounts.get(failKey(element)) ?? 0) + 1)
    if (ok) wrote += 1
  }
  return wrote
}

export async function applyWithPilot(params: {
  page: Page
  url: string
  userId: string
  attemptId: string
  profile: PortalProfile
  resumePath: string
  job?: PilotJobContext
  authorisation?: unknown
}): Promise<FillResult & { submitted?: boolean; canSubmit?: boolean }> {
  const { page, userId, attemptId, profile, resumePath } = params
  const candidate = candidateState(profile, params.job)
  await ensureApplyPilot(page, { injectIfMissing: false }).catch(async () => {
    await ensureApplyPilot(page, { injectIfMissing: true })
  })

  const filledById = new Map<string, FilledField>()
  const answerCache = new Map<string, string>()
  const harvestedIds = new Set<string>()
  const harvestedOptions = new Map<string, string[]>()
  const failCounts = new Map<string, number>()
  const history: string[] = []
  const applyStartedAt = Date.now()
  let lastProgressAt = Date.now()
  let lastLeftoverSig = ''
  let stallRethinks = 0
  let uploaded = false
  let confirmed = false

  if (await postingIsClosed(page, [params.url, page.url()])) {
    return {
      fields: [],
      unresolved: [{ label: 'This posting is no longer accepting applications.', type: 'automation', why: 'posting_closed' }],
      recipe: 'jev',
    }
  }

  await attachResume(page, resumePath).catch(() => undefined)
  uploaded = true

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (await hasSubmissionConfirmation(page, page.url())) {
      confirmed = true
      break
    }
    let snap = await snapshotPage(page)
    if (pageHasVerificationGate(snap.text) || snap.elements.some((element) => /security code|verification code|one[- ]time/i.test(element.label))) {
      const code = await readGmailVerificationCode(page, applyStartedAt)
      if (code && await fillVerificationCode(page, code)) {
        history.push('gmail-code')
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        continue
      }
      if (step < 8) {
        history.push('gmail-code-wait')
        await new Promise((resolve) => setTimeout(resolve, 3_500))
        continue
      }
      return {
        fields: [...filledById.values()],
        unresolved: [{ label: 'Email verification code', type: 'automation', why: 'login_required' }],
        recipe: 'jev',
      }
    }
    snap = await harvestMissingOptions(page, snap, harvestedIds, harvestedOptions)
    const kitWrote = await fillKnownAnswers({
      page,
      elements: snap.elements,
      candidate,
      userId,
      filledById,
      answerCache,
      failCounts,
      history,
    })
    if (kitWrote > 0) {
      await new Promise((resolve) => setTimeout(resolve, 280))
      snap = await snapshotPage(page)
      snap = await harvestMissingOptions(page, snap, harvestedIds, harvestedOptions)
    }
    const leftoverNow = unresolvedFrom(snap.elements)
    const leftoverSig = leftoverSignature(leftoverNow.map((row) => row.label))
    if (applyMadeProgress({
      before: lastLeftoverSig,
      after: leftoverSig,
      filledBefore: filledById.size,
      filledAfter: filledById.size,
    }) || leftoverSig !== lastLeftoverSig) {
      lastProgressAt = Date.now()
      lastLeftoverSig = leftoverSig
    }
    if (applyIsStalled(lastProgressAt) && stallRethinks < 4 && leftoverNow.length > 0) {
      stallRethinks += 1
      const move = await rethinkStalledApply({
        userId,
        leftover: leftoverNow.map((row) => row.label),
        history,
        url: snap.url,
        pageText: snap.text,
      })
      history.push(`stall:${move}`)
      lastProgressAt = Date.now()
      if (move === 'retry_same' || move === 'wait') {
        for (const row of leftoverNow) {
          const element = snap.elements.find((item) => item.label === row.label)
          if (element) failCounts.delete(failKey(element))
        }
        if (move === 'wait') await new Promise((resolve) => setTimeout(resolve, DROPDOWN_AFTER_TYPE_MS))
        continue
      }
      if (move === 'submit' && leftoverNow.length === 0) {
        mergePageAnswers(filledById, snap)
        return { fields: [...filledById.values()], unresolved: [], recipe: 'jev', canSubmit: true }
      }
      if (move === 'fail' && stallRethinks >= 4) {
        mergePageAnswers(filledById, snap)
        return { fields: [...filledById.values()], unresolved: leftoverNow, recipe: 'jev' }
      }
      for (const row of leftoverNow) {
        const element = snap.elements.find((item) => item.label === row.label)
        if (element) failCounts.delete(failKey(element))
      }
    }
    const requiredCount = snap.elements.filter((element) => element.required && FIELD_ROLES.has(element.role) && element.role !== 'file').length
    const verificationNow = pageHasVerificationGate(snap.text) || snap.elements.some((element) => /security code|verification code|one[- ]time/i.test(element.label))
    if (requiredCount > 0 && leftoverNow.length === 0 && !verificationNow) {
      mergePageAnswers(filledById, snap)
      return { fields: [...filledById.values()], unresolved: [], recipe: 'jev', canSubmit: true }
    }
    if (requiredCount > 0 && leftoverNow.length === 0 && verificationNow) {
      const code = await readGmailVerificationCode(page, applyStartedAt)
      if (code && await fillVerificationCode(page, code)) {
        history.push('gmail-code-ready')
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        continue
      }
    }
    const compact = compactElements(snap.elements)
    const targets = targetCriteria(compact)
    const decision = await jevDecide({
      userId,
      state: {
        url: snap.url,
        title: snap.title,
        text: snap.text.slice(0, 1400),
        looksLikeForm: snap.looksLikeForm,
        job: compactCandidate(candidate).job,
        candidate: compactCandidate(candidate),
        recent_actions: history.slice(-8),
        elements: compact,
      },
      questions: {
        page_kind: {
          type: 'choice',
          instructions: 'What kind of page is this?',
          criteria: {
            form: 'A job application form with fields to fill',
            listing: 'A job listing. Application form is not open yet',
            login: 'Login, sign-in, or account creation is required',
            captcha: 'CAPTCHA or bot check',
            confirmation: 'Application already submitted or thank-you page',
            closed: 'Posting closed or not accepting applications',
            cookie: 'Cookie or consent banner is blocking the form',
            other: 'None of the above',
          },
        },
        next_action: {
          type: 'choice',
          instructions: `This is the application for ${candidate.job?.title ?? 'this role'} at ${candidate.job?.company ?? 'this company'}. Do not decide whether the form is complete enough to submit. CLICK for Next, Continue, Apply on a listing, or cookie accept. FILL the next empty field. UPLOAD the resume. DONE if already submitted.`,
          criteria: {
            fill: 'Fill or correct one form field',
            click: 'Click Next, Continue, Apply, cookie accept, or similar',
            upload: 'Attach the resume file',
            wait: 'Page is still loading',
            submit: 'Form is complete and ready to submit',
            ask: 'Need a human to answer a question',
            done: 'Application is confirmed submitted',
            fail: 'Cannot proceed',
          },
        },
        target_id: {
          type: 'choice',
          instructions: 'Which control should the next action use? none if the action needs no control.',
          criteria: targets,
        },
      },
    })

    const pageKind = jevRead.choice(decision.answers.page_kind)
    const next = jevRead.choice(decision.answers.next_action)
    const targetId = jevRead.choice(decision.answers.target_id)
    let target = snap.elements.find((element) => element.id === targetId) ?? null

    logger.info({
      attemptId,
      step,
      pageKind,
      next,
      targetId,
      leftover: leftoverNow.map((row) => row.label).slice(0, 6),
      combos: snap.elements.filter((element) => element.role === 'combobox').map((element) => ({
        id: element.id,
        required: element.required,
        filled: element.filled,
        value: String(element.value || '').slice(0, 40),
        label: element.label.slice(0, 48),
      })),
      url: snap.url,
    }, 'pilot step')
    publishAttemptEvent(userId, {
      type: 'state',
      attemptId,
      state: 'filling',
      reason: null,
      detail: { tier: 'jev', step, pageKind, next, target: target?.label ?? targetId },
      at: new Date().toISOString(),
    })

    if (pageKind === 'confirmation' || next === 'done') {
      confirmed = true
      break
    }
    if (pageKind === 'closed') {
      return {
        fields: [...filledById.values()],
        unresolved: [{ label: 'This posting is no longer accepting applications.', type: 'automation', why: 'posting_closed' }],
        recipe: 'jev',
      }
    }
    if (pageKind === 'login') {
      return {
        fields: [...filledById.values()],
        unresolved: [{ label: 'Provider requires sign-in.', type: 'automation', why: 'login_required' }],
        recipe: 'jev',
      }
    }
    if (next === 'ask') {
      history.push(`ask:${target?.label ?? 'unknown'}`)
      continue
    }
    if (pageKind === 'captcha') {
      return {
        fields: [...filledById.values()],
        unresolved: [{ label: 'CAPTCHA', type: 'automation', why: 'captcha' }],
        recipe: 'jev',
      }
    }
    if (next === 'fail' && !snap.looksLikeForm && leftoverNow.length === 0) {
      return {
        fields: [...filledById.values()],
        unresolved: [{ label: 'Could not continue this application.', type: 'automation', why: 'no_form' }],
        recipe: 'jev',
      }
    }
    if (next === 'fail') {
      history.push('jev-fail-on-form')
    }
    const submitClick = next === 'click' && target && /submit|apply now|send application/i.test(target.label)
    if ((next === 'submit' || submitClick) && leftoverNow.length === 0) {
      mergePageAnswers(filledById, snap)
      return { fields: [...filledById.values()], unresolved: [], recipe: 'jev', canSubmit: true }
    }
    if (next === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, 800))
      history.push('wait')
      continue
    }
    if (next === 'upload' || target?.role === 'file') {
      if (uploaded) {
        history.push('upload-already')
        continue
      }
      await attachResume(page, resumePath)
      uploaded = true
      history.push('upload:resume')
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }
    if (next === 'click' && target) {
      await actOnPage(page, { op: 'click', id: target.id })
      history.push(`click:${target.label}`)
      await new Promise((resolve) => setTimeout(resolve, 700))
      continue
    }
    if ((next === 'fill' || next === 'click') && !target) {
      const firstEmpty = snap.elements.find((element) => FIELD_ROLES.has(element.role) && element.required && !element.filled && element.role !== 'file')
      if (!firstEmpty) {
        history.push('fill-without-target')
        continue
      }
      const answered = await resolvePilotAnswer({ element: firstEmpty, candidate, userId })
      if (!answered.value) {
        history.push(`skip:${firstEmpty.label}`)
        continue
      }
      const written = await actOnPage(page, { op: 'fill', id: firstEmpty.id, value: answered.value })
      filledById.set(firstEmpty.id, {
        label: firstEmpty.label,
        via: answered.source === 'model' ? 'model' : answered.source === 'jev' ? 'model' : 'heuristic',
        filled: Boolean(written.ok && written.filled !== false),
        value: answered.value.slice(0, 500),
        source: answered.source === 'profile' ? 'kit' : answered.source === 'jev' ? 'jev' : 'llm',
      })
      history.push(`fill:${firstEmpty.label}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    if (next === 'fill' && target) {
      const blocked = target.filled || (failCounts.get(failKey(target)) ?? 0) >= 2
      if (blocked) {
        history.push(target.filled ? `already-filled:${target.label}` : `skip-failed:${target.label}`)
        const nextEl = leftoverNow
          .map((row) => snap.elements.find((item) => item.label === row.label))
          .find((element) => element && !element.filled && (failCounts.get(failKey(element)) ?? 0) < 2)
        if (!nextEl) {
          history.push(`all-failed:${leftoverNow.map((row) => row.label).join('|').slice(0, 120)}`)
          if (!applyIsStalled(lastProgressAt) || stallRethinks < 4) {
            await new Promise((resolve) => setTimeout(resolve, DROPDOWN_AFTER_TYPE_MS))
            continue
          }
          return {
            fields: [...filledById.values()],
            unresolved: leftoverNow,
            recipe: 'jev',
          }
        }
        target = nextEl
      }
      if (target.role === 'file') {
        await attachResume(page, resumePath)
        uploaded = true
        history.push('upload:resume')
        continue
      }
      const cached = answerCache.get(target.label)
      const answered = cached
        ? { value: cached, source: 'profile' as const }
        : await resolvePilotAnswer({ element: target, candidate, userId })
      if (answered.value) answerCache.set(target.label, answered.value)
      if (!answered.value) {
        history.push(`skip:${target.label}`)
        failCounts.set(failKey(target), (failCounts.get(failKey(target)) ?? 0) + 1)
        continue
      }
      let ok = false
      let picked = answered.value
      if (target.role === 'combobox' || target.role === 'select') {
        const listed = await fillComboboxByJevPick({
          page,
          element: target,
          query: answered.value,
          candidate,
          userId,
        })
        ok = listed.ok
        if (listed.picked) picked = listed.picked
      }
      if (!ok) {
        let written = await actOnPage(page, { op: 'fill', id: target.id, value: answered.value })
        ok = Boolean(written.ok && written.filled !== false)
        if (!ok && answered.value.includes(',')) {
          written = await actOnPage(page, { op: 'fill', id: target.id, value: answered.value.split(',')[0]!.trim() })
          ok = Boolean(written.ok && written.filled !== false)
        }
      }
      filledById.set(target.id, {
        label: target.label,
        via: answered.source === 'profile' ? 'heuristic' : 'model',
        filled: ok,
        value: picked.slice(0, 500),
        source: answered.source === 'profile' ? 'kit' : answered.source === 'jev' ? 'jev' : 'llm',
      })
      const fails = (failCounts.get(failKey(target)) ?? 0) + 1
      failCounts.set(failKey(target), fails)
      if (!ok && fails >= 2) history.push(`give-up:${target.label}`)
      history.push(`fill:${target.label}=${String(answered.value).slice(0, 40)}`)
      publishAttemptEvent(userId, {
        type: 'field',
        attemptId,
        label: target.label,
        via: answered.source === 'profile' ? 'heuristic' : 'model',
        filled: ok,
      })
      await new Promise((resolve) => setTimeout(resolve, 220))
      continue
    }
    history.push(`noop:${next}:${targetId}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  const sweep = await snapshotPage(page).catch(() => null)
  if (sweep) {
    for (const element of unresolvedFrom(sweep.elements)) {
      const row = sweep.elements.find((item) => item.label === element.label)
      if (!row) continue
      const answered = await resolvePilotAnswer({ element: row, candidate, userId }).catch(() => null)
      if (!answered?.value) continue
      await actOnPage(page, { op: 'fill', id: row.id, value: answered.value }).catch(() => undefined)
    }
    await attachResume(page, resumePath).catch(() => undefined)
    uploaded = true
  }
  if (!uploaded) await attachResume(page, resumePath).catch(() => undefined)
  let finalSnap = await snapshotPage(page).catch(() => null)
  let verificationPending = Boolean(finalSnap && pageHasVerificationGate(finalSnap.text))
  if (verificationPending) {
    const code = await readGmailVerificationCode(page, applyStartedAt)
    if (code && await fillVerificationCode(page, code)) {
      history.push('gmail-code-final')
      finalSnap = await snapshotPage(page).catch(() => finalSnap)
      verificationPending = Boolean(finalSnap && pageHasVerificationGate(finalSnap.text))
    }
  }
  const confirmedNow = confirmed || await hasSubmissionConfirmation(page, page.url())
  const leftover = finalSnap ? unresolvedFrom(finalSnap.elements) : []
  mergePageAnswers(filledById, finalSnap)
  const terminal = decidePilotTerminal({
    leftover,
    confirmed: confirmedNow,
    verificationPending,
    looksLikeForm: Boolean(finalSnap?.looksLikeForm),
    filledCount: filledById.size,
  })
  return {
    fields: [...filledById.values()],
    unresolved: terminal.unresolved,
    recipe: 'jev',
    submitted: terminal.submitted,
    canSubmit: terminal.canSubmit,
  }
}

export async function repairPilotAfterSubmitError(params: {
  page: Page
  userId: string
  profile: PortalProfile
  job?: PilotJobContext
}): Promise<number> {
  const pageText = await params.page.locator('body').innerText().catch(() => '')
  let snap = await snapshotPage(params.page).catch(() => null)
  if (!snap) return 0
  snap = await harvestMissingOptions(params.page, snap, new Set(), new Map())
  const targets = fieldsToRepairAfterSubmit({ pageText, elements: snap.elements })
  if (!targets.length) return 0
  const candidate = candidateState(params.profile, params.job)
  let wrote = 0
  for (const element of targets.slice(0, 8)) {
    const answered = await resolvePilotAnswer({ element, candidate, userId: params.userId }).catch(() => null)
    const value = answered?.value
    if (!value) continue
    let ok = false
    if (element.role === 'radio' || element.role === 'yesno') {
      ok = await clickRadioOption(params.page, element.label, value)
    }
    if (!ok && (element.role === 'combobox' || element.role === 'select')) {
      const listed = await fillComboboxByJevPick({
        page: params.page,
        element,
        query: value,
        candidate,
        userId: params.userId,
      })
      ok = listed.ok
    }
    if (!ok) {
      const written = await actOnPage(params.page, { op: 'fill', id: element.id, value }).catch(() => null)
      ok = Boolean(written?.ok && written.filled !== false)
    }
    if (ok) wrote += 1
  }
  return wrote
}

export async function remeasurePilotApplication(page: Page, url: string): Promise<{ unresolved: FillResult['unresolved']; canSubmit: boolean; confirmed?: boolean }> {
  if (await postingIsClosed(page, [url, page.url()])) {
    return { canSubmit: false, unresolved: [{ label: 'This posting is no longer accepting applications.', type: 'automation', why: 'posting_closed' }] }
  }
  if (await hasSubmissionConfirmation(page, url)) {
    return { canSubmit: true, confirmed: true, unresolved: [] }
  }
  const snap = await snapshotPage(page)
  const leftover = unresolvedFrom(snap.elements)
  const terminal = decidePilotTerminal({
    leftover,
    confirmed: false,
    verificationPending: pageHasVerificationGate(snap.text),
    looksLikeForm: snap.looksLikeForm,
    filledCount: snap.elements.filter((element) => FIELD_ROLES.has(element.role) && element.filled).length,
  })
  return { canSubmit: terminal.canSubmit, unresolved: terminal.unresolved, confirmed: terminal.submitted }
}

export const applyWithExtension = applyWithPilot
export const remeasureExtensionApplication = remeasurePilotApplication

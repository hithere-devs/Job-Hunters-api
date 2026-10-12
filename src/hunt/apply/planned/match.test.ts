import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { PilotElement } from '../pilot-page.js'
import { unclaimedRequired } from './match.js'

it('a hidden required mirror of a claimed question is not a new question', () => {
  const element = (id: string, label: string): PilotElement => ({ id, role: 'combobox', label, required: true, value: '', filled: false, options: [], enabled: true } as PilotElement)
  const question = element('e5', 'Are you located in one of the following countries?')
  const mirror = element('e20', 'Are you located in one of the following countries?*')
  const other = element('e21', 'Something new')
  const field = { key: 'gh:q1', label: question.label, kind: 'select' as const, required: true, options: [], section: 'question' as const }
  const left = unclaimedRequired([question, mirror, other], [{ field, element: question, score: 100 } as never])
  assert.deepEqual(left.map((row) => row.id), ['e21'])
})

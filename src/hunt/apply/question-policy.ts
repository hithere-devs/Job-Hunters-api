import { z } from 'zod'
import type { FormField } from './fields.js'

export const liveAnswerSchema = z.object({answer:z.string().trim().max(4000).optional(),remember:z.boolean().default(true),skip:z.boolean().default(false)}).strict()
export function forbiddenQuestion(field:Pick<FormField,'label'|'type'|'name'>):string|null {
  if (/^(password|file|hidden)$/i.test(field.type)) return 'This field must be completed in the provider browser, not in chat.'
  if (/\b(password|passcode|one[- ]time|otp|verification\s+code|security\s+code|captcha|recaptcha|authenticator|2fa|two[- ]factor)\b/i.test(`${field.label} ${field.name??''}`)) return 'Sign-in, verification codes, and CAPTCHA must be handled by the account owner in browser setup.'
  if(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|client[_ -]?secret|secret[_ -]?key|recovery[_ -]?(?:key|code|secret))\b/i.test(`${field.label} ${field.name??''}`))return 'Credential values must stay in the provider browser and cannot be collected in chat.'
  return null
}
export function readableQuestionLabel(label:string,options:string[]=[]):boolean {
  const text=label.trim()
  return text.length>=3 && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(text) && !/^\d+$/.test(text) && !(options.length>1 && options.includes(text))
}
export function validateLiveAnswer(field:FormField,input:z.infer<typeof liveAnswerSchema>):string|null {
  const forbidden=forbiddenQuestion(field)
  if(forbidden)throw new Error(forbidden)
  if(input.skip){if(field.required)throw new Error('This question is required and cannot be skipped.');return null}
  const answer=input.answer?.trim()
  if(!answer)throw new Error('Enter an answer or skip this optional question.')
  if(answer.length>4000)throw new Error('Answer must be 4,000 characters or fewer.')
  if(field.options?.length && !field.options.includes(answer))throw new Error('Choose one of the options shown by this provider.')
  if(field.type==='checkbox' && !field.options?.length && !['true','false'].includes(answer))throw new Error('Choose true or false.')
  return answer
}

/** A review summary is not a DOM capture; missing required/options metadata is unknown. */
export function incompleteLegacyField(field:Partial<FormField>):boolean {
  return typeof field.required !== 'boolean' || !field.name ||
    (['radio','select','select-one'].includes(field.type??'') && !field.options?.length)
}
export function looksLikeLegacyQuestion(row:{fieldName:string|null;options:string[];expiresAt:Date;createdAt:Date}):boolean {
  return row.fieldName===null && row.options.length===0 && Math.abs(row.expiresAt.getTime()-row.createdAt.getTime())<=60_000
}
export function mayRepairLegacyQuestion(row:{answer:string|null;status:string;fieldName:string|null;options:string[];expiresAt:Date;createdAt:Date}):boolean {
  return row.answer===null && row.status==='expired' && looksLikeLegacyQuestion(row)
}

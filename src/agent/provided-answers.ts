import type { FormField } from '../hunt/apply/fields.js'
import { normaliseLabel } from '../hunt/apply/fields.js'
export interface ProvidedFormAnswer {label:string;name?:string;type:string;host:string;value:string;source:'user'|'profile_ai'}
/** Exact captured-field permission, not permission for a model to infer a sensitive answer. */
export function providedAnswerMatches(answers:ProvidedFormAnswer[]|undefined,field:FormField,host:string,value:string){
 return Boolean(answers?.some(answer=>answer.host===host&&answer.type===field.type&&answer.name===field.name&&normaliseLabel(answer.label).toLowerCase()===normaliseLabel(field.label).toLowerCase()&&answer.value===value))
}

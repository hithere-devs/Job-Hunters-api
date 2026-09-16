export function salaryOf(job: {
  salaryText: string | null
  salaryMin: string | null
  salaryMax: string | null
  salaryCurrency: string | null
  salaryPeriod: string | null
}): string | null {
  if (job.salaryText) return job.salaryText
  const min = job.salaryMin === null ? null : Number(job.salaryMin)
  const max = job.salaryMax === null ? null : Number(job.salaryMax)
  if (min === null && max === null) return null
  const format = (value: number): string => Math.round(value).toLocaleString('en-US')
  const body = min !== null && max !== null && min !== max
    ? `${format(min)}–${format(max)}`
    : format((min ?? max) as number)
  return `${job.salaryCurrency ? `${job.salaryCurrency} ` : ''}${body}${job.salaryPeriod ? ` per ${job.salaryPeriod}` : ''}`
}

export function experienceOf(job: { experienceMin: number | null; experienceMax: number | null }): string | null {
  const { experienceMin: min, experienceMax: max } = job
  if (min === null && max === null) return null
  const unit = (value: number): string => (value === 1 ? 'year' : 'years')
  if (min !== null && max !== null && min !== max) return `${min}–${max} ${unit(max)}`
  if (min === 0 && max === null) return 'No experience required'
  if (min !== null && max === null) return `${min}+ ${unit(min)}`
  const only = (max ?? min) as number
  return `${only} ${unit(only)}`
}


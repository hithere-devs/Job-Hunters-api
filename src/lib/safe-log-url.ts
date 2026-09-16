/** Never write OAuth codes or browser-stream bearer tokens into request logs. */
export function safeLogUrl(value: string | undefined): string {
  if(!value)return '/'
  try {
    const url=new URL(value,'http://localhost')
    for(const key of [...url.searchParams.keys()]) if(/token|password|secret|authorization|code|state/i.test(key)) url.searchParams.set(key,'[redacted]')
    return url.pathname+url.search
  }catch{return '[invalid URL]'}
}

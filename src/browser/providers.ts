/**
 * The platforms a user connects, and how we know a sign-in actually took.
 *
 * One registry, one matcher, one verifier. Adding a platform is adding an entry
 * to `PROVIDERS` — nothing else in the API or the UI carries a hardcoded list.
 *
 * The first version spread this across five places with three different
 * algorithms: the UI's `steps` array, three inline `endsWith` checks, and a
 * `d.includes(`${id}.com`)` in the session route that only worked while every
 * provider's id happened to match its domain.
 */

export interface CookieRow {
  host: string
  name: string
}

export interface Provider {
  id: string
  label: string
  /** Where the user goes to sign in. */
  url: string
  /** Registrable domain. Cookies on this or any subdomain belong to it. */
  domain: string
  /** Human-facing setup context, kept with the registry so the UI cannot drift. */
  setup: string
  signupMethod: 'email' | 'google' | 'google-or-email'
  supportsScraping: boolean
  supportsApplying: boolean
  emailConfirmationRelevant: boolean
  /**
   * Cookie names that exist only once signed in.
   *
   * This is the part that has to be right. Checking the *domain* cannot work:
   * loading wellfound.com while logged out still sets `.wellfound.com`
   * analytics cookies, so domain presence proves the page was visited, not
   * that anyone signed in.
   */
  sessionCookies: string[]
}

export const PROVIDERS: Provider[] = [
  {
    id: 'google',
    label: 'Google',
    url: 'https://accounts.google.com',
    domain: 'google.com',
    setup: 'Connect first; the other providers can reuse this Google session.',
    signupMethod: 'google-or-email',
    supportsScraping: false,
    supportsApplying: false,
    emailConfirmationRelevant: false,
    // `SID` and its `__Secure-` variants are the account session. `LSID` is set
    // on accounts.google.com specifically and is the strongest single signal.
    sessionCookies: ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LSID', 'SSID', 'HSID'],
  },
  {
    id: 'wellfound',
    label: 'Wellfound',
    url: 'https://wellfound.com/jobs',
    domain: 'wellfound.com',
    setup: 'Use Sign in with Google after Google is connected.',
    signupMethod: 'google-or-email',
    supportsScraping: false,
    supportsApplying: true,
    emailConfirmationRelevant: true,
    // Rails session cookie, set host-only on the apex — which is exactly the
    // case a naive `host.endsWith('.wellfound.com')` misses.
    sessionCookies: ['_wellfound'],
  },
  {
    id: 'instahyre',
    label: 'Instahyre',
    url: 'https://www.instahyre.com',
    domain: 'instahyre.com',
    setup: 'Use Sign in with Google after Google is connected.',
    signupMethod: 'google-or-email',
    supportsScraping: true,
    supportsApplying: true,
    emailConfirmationRelevant: true,
    // Django session evidence only. CSRF cookies also exist when logged out.
    // The application must still detect login challenges before filling.
    sessionCookies: ['sessionid'],
  },
]

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

/**
 * Whether a cookie host belongs to a registrable domain.
 *
 * Chrome writes two shapes into `host_key`: `.example.com` for a cookie scoped
 * to the domain and its subdomains, and `example.com` for a host-only cookie.
 * `'example.com'.endsWith('.example.com')` is **false**, so a matcher built on
 * `endsWith` alone silently misses every host-only cookie on the apex — which
 * is where session cookies most often live.
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const bare = host.startsWith('.') ? host.slice(1) : host
  return bare === domain || bare.endsWith(`.${domain}`)
}

export interface ProviderVerdict {
  id: string
  label: string
  url: string
  verified: boolean
  /**
   * Cookie names seen on this provider's domain that are not in
   * `sessionCookies`. Nothing reads this at runtime — it is how you find the
   * right cookie name for a platform whose session cookie we guessed wrong.
   */
  unmatched: string[]
}

/** Which providers this cookie store shows a real session for. */
export function verifyProviders(cookies: CookieRow[]): ProviderVerdict[] {
  return PROVIDERS.map((provider) => {
    const owned = cookies.filter((cookie) => hostMatchesDomain(cookie.host, provider.domain))
    const wanted = new Set(provider.sessionCookies)
    return {
      id: provider.id,
      label: provider.label,
      url: provider.url,
      verified: owned.some((cookie) => wanted.has(cookie.name)),
      unmatched: owned.filter((cookie) => !wanted.has(cookie.name)).map((cookie) => cookie.name),
    }
  })
}

/**
 * Backwards-compatible bridge for callers holding only a list of hosts.
 *
 * Domain-only evidence cannot distinguish "signed in" from "visited", so this
 * deliberately reports nothing as verified. It exists so a caller that has not
 * been migrated fails closed rather than reporting a false success.
 */
export function verifyFromDomainsOnly(domains: string[]): ProviderVerdict[] {
  return verifyProviders(domains.map((host) => ({ host, name: '' })))
}

/** Readiness means matching session-cookie evidence, not guaranteed server-side authentication. */
export function sessionVerificationStatus(verdicts: Pick<ProviderVerdict, 'verified'>[], hadVerification: boolean): 'ready' | 'stale' | 'absent' {
  if (verdicts.length > 0 && verdicts.every((provider) => provider.verified)) return 'ready'
  return hadVerification || verdicts.some((provider) => provider.verified) ? 'stale' : 'absent'
}

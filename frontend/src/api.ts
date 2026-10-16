// Alle kald til backenden. Login-tilstanden er en httpOnly-cookie, som browseren selv
// sender med til samme origin — frontenden ser og håndterer aldrig et token.

let onUnauthorized: (() => void) | null = null

// App registrerer her hvad der skal ske når sessionen er væk (udløbet, logget ud i en
// anden fane, slettet): tilbage til login-skærmen. Ét sted, ikke i hver komponent.
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler
}

// fetch til de beskyttede endpoints. Ved 401 kaldes handleren, og svaret returneres
// stadig, så kalderen kan vise sin egen fejl hvis komponenten ikke nåede at forsvinde.
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) onUnauthorized?.()
  return res
}

// Login-kaldene bruger almindelig fetch, ikke apiFetch: forkert adgangskode giver også
// 401, og det må ikke sende brugeren "tilbage" til den login-skærm de allerede står på.

async function errorFrom(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null)
  return new Error(typeof body?.error === 'string' ? body.error : fallback)
}

async function postJSON(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// null = ikke logget ind. Andre fejl kastes, så de ikke forveksles med "log ind igen".
export async function fetchCurrentUser(): Promise<string | null> {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) return null
  if (!res.ok) throw await errorFrom(res, `Kunne ikke nå serveren (HTTP ${res.status})`)
  return (await res.json()).username
}

export async function login(username: string, password: string): Promise<string> {
  const res = await postJSON('/api/auth/login', { username, password })
  if (!res.ok) throw await errorFrom(res, 'Login fejlede')
  return (await res.json()).username
}

export async function register(username: string, password: string, invite: string): Promise<string> {
  const res = await postJSON('/api/auth/register', { username, password, invite })
  if (!res.ok) throw await errorFrom(res, 'Kunne ikke oprette brugeren')
  return (await res.json()).username
}

export async function logout(): Promise<void> {
  const res = await postJSON('/api/auth/logout', {})
  if (!res.ok) throw await errorFrom(res, 'Kunne ikke logge ud')
}

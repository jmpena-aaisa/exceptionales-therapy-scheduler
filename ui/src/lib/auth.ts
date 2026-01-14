export const AUTH_STORAGE_KEY = 'therapy-scheduler:auth'

export type StoredAuth = {
  token: string
  userId: string
  email: string
  expiresAt?: string
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  const timestamp = Date.parse(expiresAt)
  if (Number.isNaN(timestamp)) return false
  return timestamp <= Date.now()
}

export function readAuthFromStorage(): StoredAuth | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredAuth
    if (!parsed?.token || !parsed?.userId) return null
    if (isExpired(parsed.expiresAt)) {
      clearAuthStorage()
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function writeAuthToStorage(auth: StoredAuth) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth))
}

export function clearAuthStorage() {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(AUTH_STORAGE_KEY)
}

export function getAuthToken(): string | null {
  return readAuthFromStorage()?.token ?? null
}

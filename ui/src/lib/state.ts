import { create } from 'zustand'
import { scheduleResultSchema, type ScheduleResult, type LoginResponse } from './schema'
import { clearAuthStorage, readAuthFromStorage, writeAuthToStorage } from './auth'

const emptySchedule: ScheduleResult = {
  status: 'idle',
  sessions: [],
}

type ScheduleStore = {
  result: ScheduleResult
  setResult: (result: ScheduleResult) => void
  clearResult: () => void
}

export const useScheduleStore = create<ScheduleStore>((set) => ({
  result: emptySchedule,
  setResult: (result) => set({ result: scheduleResultSchema.parse(result) }),
  clearResult: () => set({ result: emptySchedule }),
}))

const emptyAuth = {
  token: null,
  userId: null,
  email: null,
  expiresAt: null,
}

type AuthStore = {
  token: string | null
  userId: string | null
  email: string | null
  expiresAt: string | null
  setAuth: (payload: LoginResponse) => void
  clearAuth: () => void
}

const storedAuth = readAuthFromStorage()
const initialAuthState = storedAuth
  ? {
      token: storedAuth.token,
      userId: storedAuth.userId,
      email: storedAuth.email,
      expiresAt: storedAuth.expiresAt ?? null,
    }
  : emptyAuth

export const useAuthStore = create<AuthStore>((set) => ({
  ...initialAuthState,
  setAuth: (payload) => {
    const next = {
      token: payload.token,
      userId: payload.userId,
      email: payload.email,
      expiresAt: payload.expiresAt,
    }
    writeAuthToStorage(next)
    set(next)
  },
  clearAuth: () => {
    clearAuthStorage()
    set(emptyAuth)
  },
}))

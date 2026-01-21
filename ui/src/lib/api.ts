import {
  entitiesSchema,
  importPayloadSchema,
  loginResponseSchema,
  scheduleResultSchema,
  runSummaryListSchema,
  type Entities,
  type ImportPayload,
  type LoginResponse,
  type ScheduleResult,
  type RunSummary,
  type Therapist,
  type Patient,
  type Room,
  type Specialty,
  type Therapy,
} from './schema'
import { readAuthFromStorage } from './auth'
import { downloadFile } from './utils'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
const STORAGE_KEY_PREFIX = 'therapy-scheduler:entities'

const seedEntities: Entities = {
  therapists: [],
  patients: [],
  rooms: [],
  specialties: [],
  therapies: [],
}

function storageKey(): string {
  const auth = readAuthFromStorage()
  const suffix = auth?.userId ? `:${auth.userId}` : ''
  return `${STORAGE_KEY_PREFIX}${suffix}`
}

function readFromStorage(): Entities {
  if (typeof localStorage === 'undefined') return seedEntities
  const raw = localStorage.getItem(storageKey())
  if (!raw) return seedEntities
  try {
    return entitiesSchema.parse(JSON.parse(raw))
  } catch (error) {
    console.warn('Invalid saved entities, resetting', error)
    return seedEntities
  }
}

function writeToStorage(entities: Entities) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(storageKey(), JSON.stringify(entities))
}

function buildAuthHeaders(): Record<string, string> {
  const auth = readAuthFromStorage()
  if (!auth) return {}
  if (auth.token) {
    return { Authorization: `Bearer ${auth.token}` }
  }
  if (auth.userId) {
    return { 'X-User-Id': auth.userId }
  }
  return {}
}

export async function fetchEntities(): Promise<Entities> {
  const authHeaders = buildAuthHeaders()
  if (Object.keys(authHeaders).length > 0) {
    const response = await fetch(`${API_BASE}/api/entities`, { headers: authHeaders })
    if (response.ok) {
      const json = await response.json()
      const parsed = entitiesSchema.parse(json)
      writeToStorage(parsed)
      return parsed
    }
    if (response.status !== 404) {
      const text = await response.text()
      throw new Error(text || 'No se pudo cargar las entidades.')
    }
  }
  return readFromStorage()
}

export async function saveEntities(next: Entities): Promise<Entities> {
  const parsed = entitiesSchema.parse(next)
  const authHeaders = buildAuthHeaders()
  if (Object.keys(authHeaders).length > 0) {
    const response = await fetch(`${API_BASE}/api/entities`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(parsed),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || 'No se pudo guardar las entidades.')
    }
    const json = await response.json()
    const saved = entitiesSchema.parse(json)
    writeToStorage(saved)
    return saved
  }
  writeToStorage(parsed)
  return parsed
}

export async function upsertTherapist(input: Therapist): Promise<Entities> {
  const data = readFromStorage()
  const index = data.therapists.findIndex((t) => t.id === input.id)
  if (index >= 0) data.therapists[index] = input
  else data.therapists.push(input)
  return saveEntities(data)
}

export async function upsertPatient(input: Patient): Promise<Entities> {
  const data = readFromStorage()
  const index = data.patients.findIndex((p) => p.id === input.id)
  if (index >= 0) data.patients[index] = input
  else data.patients.push(input)
  return saveEntities(data)
}

export async function upsertRoom(input: Room): Promise<Entities> {
  const data = readFromStorage()
  const index = data.rooms.findIndex((r) => r.id === input.id)
  if (index >= 0) data.rooms[index] = input
  else data.rooms.push(input)
  return saveEntities(data)
}

export async function upsertSpecialty(input: Specialty): Promise<Entities> {
  const data = readFromStorage()
  const index = data.specialties.findIndex((s) => s.id === input.id)
  if (index >= 0) data.specialties[index] = input
  else data.specialties.push(input)
  return saveEntities(data)
}

export async function upsertTherapy(input: Therapy): Promise<Entities> {
  const data = readFromStorage()
  const index = data.therapies.findIndex((t) => t.id === input.id)
  if (index >= 0) data.therapies[index] = input
  else data.therapies.push(input)
  return saveEntities(data)
}

export async function deleteEntity(type: keyof Entities, id: string): Promise<Entities> {
  const data = readFromStorage()
  data[type] = data[type].filter((item) => item.id !== id) as Entities[typeof type]
  return saveEntities(data)
}

export async function importEntities(payload: ImportPayload): Promise<Entities> {
  const parsed = importPayloadSchema.parse(payload)
  return saveEntities(parsed)
}

export async function exportEntities(): Promise<string> {
  const data = await fetchEntities()
  return JSON.stringify(data, null, 2)
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'No se pudo iniciar sesión.')
  }
  const json = await response.json()
  return loginResponseSchema.parse(json)
}

export async function runModel(): Promise<ScheduleResult> {
  const entities = await fetchEntities()
  const response = await fetch(`${API_BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
    body: JSON.stringify({ entities }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'No se pudo ejecutar el modelo.')
  }
  const json = await response.json()
  return scheduleResultSchema.parse(json)
}

export async function getResults(sessionId?: string): Promise<ScheduleResult> {
  const url = new URL(`${API_BASE}/api/results`)
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId)
  }
  const response = await fetch(url.toString(), { headers: buildAuthHeaders() })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'No se pudo cargar el resultado.')
  }
  const json = await response.json()
  return scheduleResultSchema.parse(json)
}

export async function fetchRuns(limit = 20): Promise<RunSummary[]> {
  const url = new URL(`${API_BASE}/api/runs`)
  url.searchParams.set('limit', limit.toString())
  const response = await fetch(url.toString(), { headers: buildAuthHeaders() })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'No se pudo cargar el historial.')
  }
  const json = await response.json()
  return runSummaryListSchema.parse(json)
}

export async function deleteRun(sessionId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/runs/${sessionId}`, {
    method: 'DELETE',
    headers: buildAuthHeaders(),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'No se pudo eliminar la ejecución.')
  }
}

export async function downloadExcel(sessionId?: string): Promise<void> {
  const url = new URL(`${API_BASE}/api/download/excel`)
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId)
  }
  const response = await fetch(url.toString(), { headers: buildAuthHeaders() })
  if (!response.ok) throw new Error('Excel no disponible todavía.')
  const blob = await response.blob()
  downloadFile('schedule.xlsx', blob)
}

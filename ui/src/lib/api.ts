import { entitiesSchema, importPayloadSchema, scheduleResultSchema, type Entities, type ImportPayload, type ScheduleResult, type Therapist, type Patient, type Room, type Specialty, type Therapy } from './schema'
import { downloadFile } from './utils'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
const STORAGE_KEY = 'therapy-scheduler:entities'

const seedEntities: Entities = {
  therapists: [],
  patients: [],
  rooms: [],
  specialties: [],
  therapies: [],
}

function readFromStorage(): Entities {
  if (typeof localStorage === 'undefined') return seedEntities
  const raw = localStorage.getItem(STORAGE_KEY)
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entities))
}

export async function fetchEntities(): Promise<Entities> {
  return readFromStorage()
}

export async function saveEntities(next: Entities): Promise<Entities> {
  const parsed = entitiesSchema.parse(next)
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
  const data = readFromStorage()
  return JSON.stringify(data, null, 2)
}

export async function runModel(): Promise<ScheduleResult> {
  const entities = readFromStorage()
  const response = await fetch(`${API_BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entities }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || 'No se pudo ejecutar el modelo.')
  }
  const json = await response.json()
  return scheduleResultSchema.parse(json)
}

export async function downloadExcel(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/download/excel`)
  if (!response.ok) throw new Error('Excel no disponible todavía.')
  const blob = await response.blob()
  downloadFile('schedule.xlsx', blob)
}

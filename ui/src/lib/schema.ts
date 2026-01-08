import { z } from 'zod'

export const availabilitySchema = z.record(z.string(), z.array(z.string()))

export const therapistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  specialties: z.array(z.string()).default([]),
  availability: availabilitySchema.optional(),
})

export const patientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  requirements: z.record(z.string(), z.number().nonnegative()).default({}),
  availability: availabilitySchema.optional(),
  maxContinuousHours: z.number().optional(),
  noSameDaySpecialties: z.array(z.string()).optional(),
})

export const roomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  specialties: z.array(z.string()).default([]),
  capacity: z.number().int().positive().default(1),
  availability: availabilitySchema.optional(),
})

export const specialtySchema = z.object({
  id: z.string().min(1),
  minQuorum: z.number().int().nonnegative().default(1),
  maxQuorum: z.number().int().positive().default(4),
})

export const entitiesSchema = z.object({
  therapists: z.array(therapistSchema),
  patients: z.array(patientSchema),
  rooms: z.array(roomSchema),
  specialties: z.array(specialtySchema),
})

export type Entities = z.infer<typeof entitiesSchema>
export type Therapist = z.infer<typeof therapistSchema>
export type Patient = z.infer<typeof patientSchema>
export type Room = z.infer<typeof roomSchema>
export type Specialty = z.infer<typeof specialtySchema>

export const scheduleSessionSchema = z.object({
  id: z.string(),
  day: z.string(),
  start: z.string(),
  end: z.string(),
  roomId: z.string(),
  therapistId: z.string(),
  patientIds: z.array(z.string()),
  specialty: z.string(),
})

export type ScheduleSession = z.infer<typeof scheduleSessionSchema>

export const scheduleResultSchema = z.object({
  status: z.enum(['idle', 'running', 'success', 'failed']).default('idle'),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  objectiveValue: z.number().optional(),
  diagnostics: z.array(z.string()).optional(),
  sessions: z.array(scheduleSessionSchema).default([]),
})

export type ScheduleResult = z.infer<typeof scheduleResultSchema>

export const importPayloadSchema = entitiesSchema
export type ImportPayload = z.infer<typeof importPayloadSchema>

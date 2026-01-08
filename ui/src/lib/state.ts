import { create } from 'zustand'
import { scheduleResultSchema, type ScheduleResult } from './schema'

const emptySchedule: ScheduleResult = {
  status: 'idle',
  sessions: [],
}

type ScheduleStore = {
  result: ScheduleResult
  setResult: (result: ScheduleResult) => void
}

export const useScheduleStore = create<ScheduleStore>((set) => ({
  result: emptySchedule,
  setResult: (result) => set({ result: scheduleResultSchema.parse(result) }),
}))

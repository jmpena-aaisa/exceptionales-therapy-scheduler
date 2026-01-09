import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { Availability } from '@/lib/utils'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const HOUR_SLOTS = createHourSlots(8, 18)

type AvailabilityGridProps = {
  value?: Availability
  onChange: (next: Availability) => void
}

export function AvailabilityGrid({ value = {}, onChange }: AvailabilityGridProps) {
  const selected = useMemo(() => buildSelectedSet(value), [value])

  const applySelection = (nextSelected: Set<string>) => {
    const nextValue: Availability = {}
    DAYS.forEach((d) => {
      const daySlots = Array.from(nextSelected)
        .filter((entry) => entry.startsWith(`${d}|`))
        .map((entry) => entry.split('|')[1])
      const ranges = collapseSlotsToRanges(daySlots)
      if (ranges.length) nextValue[d] = ranges
    })
    onChange(nextValue)
  }

  const toggle = (day: string, slot: string) => {
    const key = `${day}|${slot}`
    const nextSelected = new Set(selected)
    if (nextSelected.has(key)) nextSelected.delete(key)
    else nextSelected.add(key)
    applySelection(nextSelected)
  }

  const toggleDay = (day: string) => {
    const keys = HOUR_SLOTS.map((slot) => `${day}|${slot}`)
    const allSelected = keys.every((key) => selected.has(key))
    const nextSelected = new Set(selected)
    keys.forEach((key) => {
      if (allSelected) nextSelected.delete(key)
      else nextSelected.add(key)
    })
    applySelection(nextSelected)
  }

  const toggleSlotColumn = (slot: string) => {
    const keys = DAYS.map((day) => `${day}|${slot}`)
    const allSelected = keys.every((key) => selected.has(key))
    const nextSelected = new Set(selected)
    keys.forEach((key) => {
      if (allSelected) nextSelected.delete(key)
      else nextSelected.add(key)
    })
    applySelection(nextSelected)
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px] overflow-hidden rounded-lg border border-border/70">
        <div className="grid grid-cols-[120px_repeat(10,1fr)] text-xs">
          <div className="bg-secondary px-3 py-2 font-semibold text-foreground">Día</div>
          {HOUR_SLOTS.map((slot) => (
            <button
              type="button"
              key={`head-${slot}`}
              onClick={() => toggleSlotColumn(slot)}
              className="border-l border-border/70 bg-secondary/60 px-2 py-2 text-center font-semibold text-muted-foreground transition-colors hover:bg-secondary"
            >
              {slot.split('-')[0]}
            </button>
          ))}
        </div>
        {DAYS.map((day) => (
          <div key={day} className="grid grid-cols-[120px_repeat(10,1fr)] border-t border-border/70 text-xs">
            <button
              type="button"
              onClick={() => toggleDay(day)}
              className="flex items-center bg-secondary/40 px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60"
            >
              {day}
            </button>
            {HOUR_SLOTS.map((slot) => {
              const isSelected = selected.has(`${day}|${slot}`)
              return (
                <button
                  type="button"
                  key={`${day}-${slot}`}
                  aria-pressed={isSelected}
                  onClick={() => toggle(day, slot)}
                  className={cn(
                    'flex h-10 items-center justify-center border-l border-border/60 text-[11px] transition-colors',
                    isSelected ? 'bg-primary/10 text-primary ring-1 ring-primary/60' : 'hover:bg-secondary/80 text-muted-foreground',
                  )}
                >
                  {slot.replace(':00', '')}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function buildSelectedSet(value: Availability): Set<string> {
  const selected = new Set<string>()
  Object.entries(value || {}).forEach(([day, ranges]) => {
    ranges.forEach((range) => {
      expandRangeToSlots(range).forEach((slot) => selected.add(`${day}|${slot}`))
    })
  })
  return selected
}

function expandRangeToSlots(range: string): string[] {
  const [startRaw, endRaw] = range.split('-').map((s) => s.trim())
  if (!startRaw || !endRaw) return []
  const startHour = parseInt(startRaw.split(':')[0] ?? '0', 10)
  const endHour = parseInt(endRaw.split(':')[0] ?? '0', 10)
  const slots: string[] = []
  for (let h = startHour; h < endHour; h += 1) {
    slots.push(formatSlot(h))
  }
  return slots
}

function collapseSlotsToRanges(slots: string[]): string[] {
  if (!slots.length) return []
  const sorted = [...slots].sort((a, b) => slotStart(a) - slotStart(b))
  const ranges: string[] = []
  let rangeStart = slotStart(sorted[0])
  let previous = slotStart(sorted[0])

  for (let i = 1; i < sorted.length; i += 1) {
    const current = slotStart(sorted[i])
    if (current !== previous + 1) {
      ranges.push(`${pad(rangeStart)}:00-${pad(previous + 1)}:00`)
      rangeStart = current
    }
    previous = current
  }
  ranges.push(`${pad(rangeStart)}:00-${pad(previous + 1)}:00`)
  return ranges
}

function createHourSlots(startHour: number, endHour: number): string[] {
  const slots: string[] = []
  for (let h = startHour; h < endHour; h += 1) {
    slots.push(formatSlot(h))
  }
  return slots
}

function formatSlot(startHour: number): string {
  return `${pad(startHour)}:00-${pad(startHour + 1)}:00`
}

function slotStart(slot: string): number {
  const [start] = slot.split('-')
  return parseInt(start.split(':')[0] ?? '0', 10)
}

function pad(num: number): string {
  return num.toString().padStart(2, '0')
}

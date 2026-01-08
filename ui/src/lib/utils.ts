import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export type Availability = Record<string, string[]>

export function parseAvailability(input: string): Availability {
  const lines = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  return lines.reduce<Availability>((acc, line) => {
    const [dayPart, slotsPart] = line.split(':').map((p) => p.trim())
    if (!dayPart || !slotsPart) return acc
    const slots = slotsPart
      .split(',')
      .map((slot) => slot.trim())
      .filter(Boolean)
    if (slots.length) {
      acc[dayPart] = slots
    }
    return acc
  }, {})
}

export function formatAvailability(avail?: Availability): string {
  if (!avail) return ''
  return Object.entries(avail)
    .map(([day, slots]) => `${day}: ${slots.join(', ')}`)
    .join('\n')
}

export function parseRequirements(input: string): Record<string, number> {
  const pairs = input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  const result: Record<string, number> = {}
  pairs.forEach((pair) => {
    const [key, rawValue] = pair.split(':').map((p) => p.trim())
    const value = Number(rawValue)
    if (key && !Number.isNaN(value)) {
      result[key] = value
    }
  })
  return result
}

export function formatRequirements(reqs?: Record<string, number>): string {
  if (!reqs) return ''
  return Object.entries(reqs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
}

export function downloadFile(filename: string, content: Blob | string) {
  const blob = typeof content === 'string' ? new Blob([content], { type: 'application/json' }) : content
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

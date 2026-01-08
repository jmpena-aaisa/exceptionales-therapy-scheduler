import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useScheduleStore } from '@/lib/state'
import type { ScheduleSession } from '@/lib/schema'

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const BASE_START_HOUR = 8
const BASE_END_HOUR = 18

export function ResultsPanel() {
  const { result } = useScheduleStore()
  const statusVariant: 'success' | 'destructive' | 'outline' =
    result.status === 'success' ? 'success' : result.status === 'failed' ? 'destructive' : 'outline'

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle>Resultados</CardTitle>
          <CardDescription>Visualiza el horario por sala, terapeuta o paciente.</CardDescription>
        </div>
        <Badge variant={statusVariant}>
          {result.status === 'idle' && 'Sin ejecutar'}
          {result.status === 'running' && 'Ejecutando...'}
          {result.status === 'success' && 'OK'}
          {result.status === 'failed' && 'Con errores'}
        </Badge>
      </CardHeader>
      <CardContent>
        {result.sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ejecuta el modelo para ver un horario.</p>
        ) : (
          <Tabs defaultValue="rooms">
            <TabsList>
              <TabsTrigger value="rooms">Por sala</TabsTrigger>
              <TabsTrigger value="therapists">Por terapeuta</TabsTrigger>
              <TabsTrigger value="patients">Por paciente</TabsTrigger>
            </TabsList>
            <TabsContent value="rooms">
              <GroupedScheduleView sessions={result.sessions} mode="rooms" />
            </TabsContent>
            <TabsContent value="therapists">
              <GroupedScheduleView sessions={result.sessions} mode="therapists" />
            </TabsContent>
            <TabsContent value="patients">
              <GroupedScheduleView sessions={result.sessions} mode="patients" />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  )
}

type GroupMode = 'rooms' | 'therapists' | 'patients'
type GroupedScheduleViewProps = { sessions: ScheduleSession[]; mode: GroupMode }

function GroupedScheduleView({ sessions, mode }: GroupedScheduleViewProps) {
  const groups = useMemo(() => buildGroups(sessions, mode), [sessions, mode])
  const [selectedId, setSelectedId] = useState(groups[0]?.id ?? '')

  useEffect(() => {
    if (!groups.length) return
    if (!selectedId || !groups.some((g) => g.id === selectedId)) {
      setSelectedId(groups[0].id)
    }
  }, [groups, selectedId])

  const selectedSessions = useMemo(
    () =>
      sessions.filter((s) => {
        const ids = pickGroupIds(s, mode)
        return ids.includes(selectedId || groups[0]?.id)
      }),
    [sessions, selectedId, mode],
  )

  if (!groups.length) {
    return <p className="text-sm text-muted-foreground">Sin bloques para esta vista.</p>
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-muted-foreground">
          {labelForMode(mode)}: <span className="font-semibold text-foreground">{selectedId || groups[0].id}</span>
        </div>
        <Select value={selectedId || groups[0].id} onValueChange={setSelectedId}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={`Selecciona ${labelForMode(mode).toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="outline">{selectedSessions.length} bloques</Badge>
      </div>

      <ScheduleGrid sessions={selectedSessions} />
    </div>
  )
}

type ScheduleGridProps = { sessions: ScheduleSession[] }
function ScheduleGrid({ sessions }: ScheduleGridProps) {
  const days = DAY_ORDER

  const slots = useMemo(() => buildSlots(sessions), [sessions])
  const byDaySlot = useMemo(() => buildDaySlotMap(sessions), [sessions])

  const columnTemplate = `120px repeat(${days.length}, minmax(160px, 1fr))`

  return (
    <ScrollArea className="rounded-lg border border-border/70">
      <div className="min-w-[720px]">
        <div className="grid" style={{ gridTemplateColumns: columnTemplate }}>
          <div className="bg-secondary px-3 py-2 text-xs font-semibold text-muted-foreground">Hora</div>
          {days.map((day) => (
            <div
              key={`head-${day}`}
              className="border-l border-border/60 bg-secondary/60 px-3 py-2 text-xs font-semibold text-foreground"
            >
              {day}
            </div>
          ))}
          {slots.map((slot) => (
            <SlotRow key={slot} slot={slot} days={days} byDaySlot={byDaySlot} />
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

type SlotRowProps = {
  slot: string
  days: string[]
  byDaySlot: Record<string, Record<string, ScheduleSession[]>>
}

function SlotRow({ slot, days, byDaySlot }: SlotRowProps) {
  return (
    <>
      <div className="border-t border-border/60 bg-secondary/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
        {slot.replace(':00', '')}
      </div>
      {days.map((day) => {
        const items = byDaySlot[day]?.[slot] ?? []
        return (
          <div
            key={`${day}-${slot}`}
            className="border-t border-l border-border/60 bg-white/60 px-2 py-2 text-xs text-muted-foreground"
          >
            {items.length === 0 ? (
              <span className="text-[11px] text-muted-foreground/60">—</span>
            ) : (
              <div className="space-y-2">
                {items.map((s) => (
                  <div
                    key={s.id + s.start + s.day}
                    className="rounded-lg border border-border/70 bg-secondary/70 px-2 py-2 text-[11px] leading-tight text-foreground shadow-sm"
                  >
                    <div className="flex items-center justify-between text-[11px] font-semibold">
                      <span>{s.specialty}</span>
                      <span className="text-muted-foreground">n={s.patientIds.length}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {s.start} - {s.end}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      <span>Terapeuta: {s.therapistId}</span>
                      <span>Sala: {s.roomId}</span>
                      <span>Pacientes: {s.patientIds.join(', ') || '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

type GroupInfo = { id: string; label: string }

function buildGroups(sessions: ScheduleSession[], mode: GroupMode): GroupInfo[] {
  const map = new Map<string, GroupInfo>()
  sessions.forEach((s) => {
    const ids = pickGroupIds(s, mode)
    ids.forEach((id) => {
      if (!id) return
      if (!map.has(id)) {
        map.set(id, { id, label: `${labelForMode(mode)} ${id}` })
      }
    })
  })
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id))
}

function pickGroupIds(session: ScheduleSession, mode: GroupMode): string[] {
  switch (mode) {
    case 'rooms':
      return [session.roomId]
    case 'therapists':
      return [session.therapistId]
    case 'patients':
      return session.patientIds.length ? session.patientIds : ['—']
    default:
      return []
  }
}

function labelForMode(mode: GroupMode): string {
  if (mode === 'rooms') return 'Sala'
  if (mode === 'therapists') return 'Terapeuta'
  return 'Paciente'
}

function buildSlots(sessions: ScheduleSession[]): string[] {
  if (!sessions.length) {
    return createHourSlots(BASE_START_HOUR, BASE_END_HOUR)
  }
  const starts = sessions.map((s) => toMinutes(s.start))
  const ends = sessions.map((s) => toMinutes(s.end))
  const minStart = Math.min(...starts, BASE_START_HOUR * 60)
  const maxEnd = Math.max(...ends, BASE_END_HOUR * 60)
  return createHourSlots(Math.floor(minStart / 60), Math.ceil(maxEnd / 60))
}

function buildDaySlotMap(sessions: ScheduleSession[]): Record<string, Record<string, ScheduleSession[]>> {
  const map: Record<string, Record<string, ScheduleSession[]>> = {}
  sessions.forEach((s) => {
    if (!map[s.day]) map[s.day] = {}
    const key = `${s.start}-${s.end}`
    if (!map[s.day][key]) map[s.day][key] = []
    map[s.day][key].push(s)
  })
  return map
}

function createHourSlots(startHour: number, endHour: number): string[] {
  const slots: string[] = []
  for (let h = startHour; h < endHour; h += 1) {
    slots.push(`${pad(h)}:00-${pad(h + 1)}:00`)
  }
  return slots
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map((t) => parseInt(t, 10))
  return (hour || 0) * 60 + (minute || 0)
}

function pad(num: number): string {
  return num.toString().padStart(2, '0')
}

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  deleteEntity,
  exportEntities,
  fetchEntities,
  importEntities,
  upsertPatient,
  upsertRoom,
  upsertSpecialty,
  upsertTherapist,
} from '@/lib/api'
import { formatAvailability, formatRequirements } from '@/lib/utils'
import type { Availability } from '@/lib/utils'
import type { Entities, Patient, Room, Specialty, Therapist } from '@/lib/schema'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { downloadFile } from '@/lib/utils'
import { AvailabilityGrid } from './availability-grid'
import { SpecialtySelect } from './specialty-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const ENTITY_KEY = ['entities']

type TherapistForm = { id: string; name: string; specialties: string[]; availability: Availability }
type PatientForm = {
  id: string
  name: string
  requirements: { specialty: string; hours: number }[]
  availability: Availability
  maxContinuousHours?: number
  noSameDaySpecialties: string[]
}
type RoomForm = { id: string; name: string; specialties: string[]; capacity: number; availability: Availability }
type SpecialtyForm = { id: string; minQuorum: number; maxQuorum: number }

const FULL_AVAILABILITY: Availability = buildFullAvailability()

function formFromTherapist(t?: Therapist): TherapistForm {
  return {
    id: t?.id ?? '',
    name: t?.name ?? '',
    specialties: t?.specialties ?? [],
    availability: t?.availability ?? FULL_AVAILABILITY,
  }
}

function formFromPatient(p?: Patient): PatientForm {
  return {
    id: p?.id ?? '',
    name: p?.name ?? '',
    requirements: p
      ? Object.entries(p.requirements).map(([specialty, hours]) => ({ specialty, hours }))
      : [],
    availability: p?.availability ?? FULL_AVAILABILITY,
    maxContinuousHours: p?.maxContinuousHours,
    noSameDaySpecialties: p?.noSameDaySpecialties ?? [],
  }
}

function formFromRoom(r?: Room): RoomForm {
  return {
    id: r?.id ?? '',
    name: r?.name ?? '',
    specialties: r?.specialties ?? [],
    capacity: r?.capacity ?? 1,
    availability: r?.availability ?? FULL_AVAILABILITY,
  }
}

function formFromSpecialty(s?: Specialty): SpecialtyForm {
  return { id: s?.id ?? '', minQuorum: s?.minQuorum ?? 1, maxQuorum: s?.maxQuorum ?? 4 }
}

export function EntitiesPanel() {
  const queryClient = useQueryClient()
  const entitiesQuery = useQuery({ queryKey: ENTITY_KEY, queryFn: fetchEntities })

  const upsertTherapistMutation = useMutation({
    mutationFn: upsertTherapist,
    onSuccess: (data) => queryClient.setQueryData(ENTITY_KEY, data),
  })
  const upsertPatientMutation = useMutation({
    mutationFn: upsertPatient,
    onSuccess: (data) => queryClient.setQueryData(ENTITY_KEY, data),
  })
  const upsertRoomMutation = useMutation({
    mutationFn: upsertRoom,
    onSuccess: (data) => queryClient.setQueryData(ENTITY_KEY, data),
  })
  const upsertSpecialtyMutation = useMutation({
    mutationFn: upsertSpecialty,
    onSuccess: (data) => queryClient.setQueryData(ENTITY_KEY, data),
  })
  const deleteMutation = useMutation({
    mutationFn: ({ type, id }: { type: keyof Entities; id: string }) => deleteEntity(type, id),
    onSuccess: (data) => queryClient.setQueryData(ENTITY_KEY, data),
  })

  const [activeTab, setActiveTab] = useState<keyof Entities>('specialties')

  const [therapistForm, setTherapistForm] = useState<TherapistForm>(formFromTherapist())
  const [patientForm, setPatientForm] = useState<PatientForm>(formFromPatient())
  const [roomForm, setRoomForm] = useState<RoomForm>(formFromRoom())
  const [specialtyForm, setSpecialtyForm] = useState<SpecialtyForm>(formFromSpecialty())

  const [openDialog, setOpenDialog] = useState<null | keyof Entities>(null)
  const [editId, setEditId] = useState<string | null>(null)

  const data = useMemo(() => entitiesQuery.data, [entitiesQuery.data])
  const specialtyOptions = useMemo(() => (data?.specialties ?? []).map((s) => s.id), [data])

  const addRequirementRow = () => {
    setPatientForm((prev) => ({
      ...prev,
      requirements: [...prev.requirements, { specialty: specialtyOptions[0] ?? '', hours: 1 }],
    }))
  }

  const updateRequirement = (index: number, field: 'specialty' | 'hours', value: string | number) => {
    setPatientForm((prev) => {
      const next = [...prev.requirements]
      const req = next[index]
      if (!req) return prev
      next[index] = { ...req, [field]: field === 'hours' ? Number(value) : value }
      return { ...prev, requirements: next }
    })
  }

  const removeRequirement = (index: number) => {
    setPatientForm((prev) => {
      const next = prev.requirements.filter((_, i) => i !== index)
      return { ...prev, requirements: next }
    })
  }

  async function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const raw = await file.text()
      const parsed = JSON.parse(raw)
      await importEntities(parsed)
      queryClient.invalidateQueries({ queryKey: ENTITY_KEY })
      toast.success('Datos importados')
    } catch (error) {
      console.error(error)
      toast.error('No se pudo importar el JSON')
    }
  }

  async function handleExport() {
    try {
      const json = await exportEntities()
      downloadFile('entities.json', json)
      toast.success('JSON exportado')
    } catch (error) {
      console.error(error)
      toast.error('No se pudo exportar')
    }
  }

  function startEdit(type: keyof Entities, id?: string) {
    setEditId(id ?? null)
    setOpenDialog(type)
    if (!data) return
    switch (type) {
      case 'therapists': {
        const found = data.therapists.find((t) => t.id === id)
        setTherapistForm(formFromTherapist(found))
        break
      }
      case 'patients': {
        const found = data.patients.find((p) => p.id === id)
        setPatientForm(formFromPatient(found))
        break
      }
      case 'rooms': {
        const found = data.rooms.find((r) => r.id === id)
        setRoomForm(formFromRoom(found))
        break
      }
      case 'specialties': {
        const found = data.specialties.find((s) => s.id === id)
        setSpecialtyForm(formFromSpecialty(found))
        break
      }
      default:
        break
    }
  }

  function resetForm() {
    setTherapistForm(formFromTherapist())
    setPatientForm(formFromPatient())
    setRoomForm(formFromRoom())
    setSpecialtyForm(formFromSpecialty())
    setEditId(null)
  }

  async function handleTherapistSave() {
    await upsertTherapistMutation.mutateAsync({
      id: therapistForm.id,
      name: therapistForm.name,
      specialties: therapistForm.specialties,
      availability: therapistForm.availability,
    })
    toast.success('Terapeuta guardado')
    setOpenDialog(null)
    resetForm()
  }

  async function handlePatientSave() {
    const requirements: Record<string, number> = {}
    patientForm.requirements.forEach((req) => {
      if (!req.specialty) return
      const hours = Number(req.hours)
      if (Number.isNaN(hours) || hours <= 0) return
      requirements[req.specialty] = hours
    })
    await upsertPatientMutation.mutateAsync({
      id: patientForm.id,
      name: patientForm.name,
      requirements,
      availability: patientForm.availability,
      maxContinuousHours: patientForm.maxContinuousHours ? Number(patientForm.maxContinuousHours) : undefined,
      noSameDaySpecialties: patientForm.noSameDaySpecialties,
    })
    toast.success('Paciente guardado')
    setOpenDialog(null)
    resetForm()
  }

  async function handleRoomSave() {
    await upsertRoomMutation.mutateAsync({
      id: roomForm.id,
      name: roomForm.name,
      specialties: roomForm.specialties,
      capacity: Number(roomForm.capacity || 1),
      availability: roomForm.availability,
    })
    toast.success('Sala guardada')
    setOpenDialog(null)
    resetForm()
  }

  async function handleSpecialtySave() {
    await upsertSpecialtyMutation.mutateAsync({
      id: specialtyForm.id,
      minQuorum: Number(specialtyForm.minQuorum || 1),
      maxQuorum: Number(specialtyForm.maxQuorum || 1),
    })
    toast.success('Especialidad guardada')
    setOpenDialog(null)
    resetForm()
  }

  async function handleDelete(type: keyof Entities, id: string) {
    await deleteMutation.mutateAsync({ type, id })
    toast.success('Eliminado')
  }

  if (entitiesQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Entidades</CardTitle>
          <CardDescription>Cargando datos locales...</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Preparando UI</CardContent>
      </Card>
    )
  }

  const entities = data ?? { therapists: [], patients: [], rooms: [], specialties: [] }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle>Entidades</CardTitle>
          <CardDescription>Primero define especialidades y luego asigna a terapeutas, pacientes y salas.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <input id="import-json" type="file" accept="application/json" className="hidden" onChange={handleImport} />
          <label htmlFor="import-json">
            <Button variant="outline" asChild>
              <span>Importar JSON</span>
            </Button>
          </label>
          <Button variant="outline" onClick={handleExport}>
            Exportar JSON
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={activeTab} value={activeTab} onValueChange={(v) => setActiveTab(v as keyof Entities)}>
          <TabsList>
            <TabsTrigger value="specialties">Especialidades</TabsTrigger>
            <TabsTrigger value="therapists">Terapeutas</TabsTrigger>
            <TabsTrigger value="patients">Pacientes</TabsTrigger>
            <TabsTrigger value="rooms">Salas</TabsTrigger>
          </TabsList>

          <TabsContent value="specialties">
            <div className="mb-3 flex justify-end">
              <Dialog open={openDialog === 'specialties'} onOpenChange={(open) => (open ? startEdit('specialties') : setOpenDialog(null))}>
                <DialogTrigger asChild>
                  <Button onClick={() => startEdit('specialties')}>Añadir especialidad</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editId ? 'Editar especialidad' : 'Nueva especialidad'}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label>ID</Label>
                      <Input value={specialtyForm.id} onChange={(e) => setSpecialtyForm({ ...specialtyForm, id: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Min quorum</Label>
                        <Input
                          type="number"
                          value={specialtyForm.minQuorum}
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            setSpecialtyForm({ ...specialtyForm, minQuorum: Number.isNaN(value) ? 1 : value })
                          }}
                        />
                      </div>
                      <div>
                        <Label>Max quorum</Label>
                        <Input
                          type="number"
                          value={specialtyForm.maxQuorum}
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            setSpecialtyForm({ ...specialtyForm, maxQuorum: Number.isNaN(value) ? 1 : value })
                          }}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpenDialog(null)}>
                        Cancelar
                      </Button>
                      <Button onClick={handleSpecialtySave} disabled={upsertSpecialtyMutation.isPending}>
                        Guardar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <EntityTable
              headers={['ID', 'Min', 'Max', 'Acciones']}
              rows={entities.specialties.map((s) => [
                s.id,
                s.minQuorum,
                s.maxQuorum,
                <RowActions key={s.id} onEdit={() => startEdit('specialties', s.id)} onDelete={() => handleDelete('specialties', s.id)} />,
              ])}
            />
          </TabsContent>

          <TabsContent value="therapists">
            <div className="mb-3 flex justify-end">
              <Dialog open={openDialog === 'therapists'} onOpenChange={(open) => (open ? startEdit('therapists') : setOpenDialog(null))}>
                <DialogTrigger asChild>
                  <Button onClick={() => startEdit('therapists')}>Añadir terapeuta</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editId ? 'Editar terapeuta' : 'Nuevo terapeuta'}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="therapist-id">ID</Label>
                      <Input id="therapist-id" value={therapistForm.id} onChange={(e) => setTherapistForm({ ...therapistForm, id: e.target.value })} />
                    </div>
                    <div>
                      <Label htmlFor="therapist-name">Nombre</Label>
                      <Input id="therapist-name" value={therapistForm.name} onChange={(e) => setTherapistForm({ ...therapistForm, name: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Especialidades</Label>
                      <SpecialtySelect
                        options={specialtyOptions}
                        value={therapistForm.specialties}
                        onChange={(specialties) => setTherapistForm({ ...therapistForm, specialties })}
                        emptyHint="Añade especialidades primero."
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Disponibilidad (click para activar/desactivar bloques)</Label>
                      <AvailabilityGrid
                        value={therapistForm.availability}
                        onChange={(availability) => setTherapistForm({ ...therapistForm, availability })}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpenDialog(null)}>
                        Cancelar
                      </Button>
                      <Button onClick={handleTherapistSave} disabled={upsertTherapistMutation.isPending}>
                        Guardar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <EntityTable
              headers={['ID', 'Nombre', 'Especialidades', 'Disponibilidad', 'Acciones']}
              rows={entities.therapists.map((t) => [
                t.id,
                t.name,
                t.specialties.join(', '),
                formatAvailability(t.availability) || '—',
                <RowActions key={t.id} onEdit={() => startEdit('therapists', t.id)} onDelete={() => handleDelete('therapists', t.id)} />,
              ])}
            />
          </TabsContent>

          <TabsContent value="patients">
            <div className="mb-3 flex justify-end">
              <Dialog open={openDialog === 'patients'} onOpenChange={(open) => (open ? startEdit('patients') : setOpenDialog(null))}>
                <DialogTrigger asChild>
                  <Button onClick={() => startEdit('patients')}>Añadir paciente</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editId ? 'Editar paciente' : 'Nuevo paciente'}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label>ID</Label>
                      <Input value={patientForm.id} onChange={(e) => setPatientForm({ ...patientForm, id: e.target.value })} />
                    </div>
                    <div>
                      <Label>Nombre</Label>
                      <Input value={patientForm.name} onChange={(e) => setPatientForm({ ...patientForm, name: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Requerimientos</Label>
                      <div className="space-y-2">
                        {patientForm.requirements.map((req, idx) => (
                          <div key={idx} className="flex flex-col gap-2 rounded-lg border border-border/70 bg-secondary/40 p-3 md:flex-row md:items-center">
                            <div className="w-full md:w-1/2">
                              <Select
                                value={req.specialty}
                                onValueChange={(value) => updateRequirement(idx, 'specialty', value)}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Especialidad" />
                                </SelectTrigger>
                                <SelectContent>
                                  {specialtyOptions.map((opt) => (
                                    <SelectItem key={opt} value={opt}>
                                      {opt}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex w-full items-center gap-2 md:w-1/2">
                              <Input
                                type="number"
                                min={1}
                                value={req.hours}
                                onChange={(e) => updateRequirement(idx, 'hours', e.target.value)}
                                className="w-full"
                              />
                              <Button variant="ghost" size="sm" onClick={() => removeRequirement(idx)}>
                                Eliminar
                              </Button>
                            </div>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={addRequirementRow}
                          disabled={!specialtyOptions.length}
                        >
                          Añadir requerimiento
                        </Button>
                        {!specialtyOptions.length ? (
                          <p className="text-xs text-muted-foreground">Primero agrega especialidades.</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Disponibilidad</Label>
                      <AvailabilityGrid
                        value={patientForm.availability}
                        onChange={(availability) => setPatientForm({ ...patientForm, availability })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Máx. horas continuas</Label>
                        <Input
                          type="number"
                          value={patientForm.maxContinuousHours ?? ''}
                          onChange={(e) => {
                            const value = e.target.value
                            setPatientForm({
                              ...patientForm,
                              maxContinuousHours: value === '' ? undefined : Number(value),
                            })
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Evitar en el mismo día</Label>
                        <SpecialtySelect
                          options={specialtyOptions}
                          value={patientForm.noSameDaySpecialties}
                          onChange={(noSameDaySpecialties) => setPatientForm({ ...patientForm, noSameDaySpecialties })}
                          emptyHint="Añade especialidades primero."
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpenDialog(null)}>
                        Cancelar
                      </Button>
                      <Button onClick={handlePatientSave} disabled={upsertPatientMutation.isPending}>
                        Guardar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <EntityTable
              headers={['ID', 'Nombre', 'Requerimientos', 'Disponibilidad', 'Restricciones', 'Acciones']}
              rows={entities.patients.map((p) => [
                p.id,
                p.name,
                formatRequirements(p.requirements),
                formatAvailability(p.availability) || '—',
                (
                  <div className="space-y-1 text-xs" key={`${p.id}-rules`}>
                    {p.maxContinuousHours ? <Badge variant="outline">Max {p.maxContinuousHours}h</Badge> : null}
                    {p.noSameDaySpecialties?.length ? (
                      <div className="text-muted-foreground">
                        Evitar: {p.noSameDaySpecialties.join(', ')}
                      </div>
                    ) : null}
                  </div>
                ),
                <RowActions key={p.id} onEdit={() => startEdit('patients', p.id)} onDelete={() => handleDelete('patients', p.id)} />,
              ])}
            />
          </TabsContent>

          <TabsContent value="rooms">
            <div className="mb-3 flex justify-end">
              <Dialog open={openDialog === 'rooms'} onOpenChange={(open) => (open ? startEdit('rooms') : setOpenDialog(null))}>
                <DialogTrigger asChild>
                  <Button onClick={() => startEdit('rooms')}>Añadir sala</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editId ? 'Editar sala' : 'Nueva sala'}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label>ID</Label>
                      <Input value={roomForm.id} onChange={(e) => setRoomForm({ ...roomForm, id: e.target.value })} />
                    </div>
                    <div>
                      <Label>Nombre</Label>
                      <Input value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Especialidades</Label>
                      <SpecialtySelect
                        options={specialtyOptions}
                        value={roomForm.specialties}
                        onChange={(specialties) => setRoomForm({ ...roomForm, specialties })}
                        emptyHint="Añade especialidades primero."
                      />
                    </div>
                    <div>
                      <Label>Capacidad</Label>
                      <Input
                        type="number"
                        value={roomForm.capacity}
                        onChange={(e) => {
                          const value = Number(e.target.value)
                          setRoomForm({ ...roomForm, capacity: Number.isNaN(value) || value === 0 ? 1 : value })
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Disponibilidad</Label>
                      <AvailabilityGrid
                        value={roomForm.availability}
                        onChange={(availability) => setRoomForm({ ...roomForm, availability })}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpenDialog(null)}>
                        Cancelar
                      </Button>
                      <Button onClick={handleRoomSave} disabled={upsertRoomMutation.isPending}>
                        Guardar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <EntityTable
              headers={['ID', 'Nombre', 'Especialidades', 'Capacidad', 'Disponibilidad', 'Acciones']}
              rows={entities.rooms.map((r) => [
                r.id,
                r.name,
                r.specialties.join(', '),
                r.capacity,
                formatAvailability(r.availability) || '—',
                <RowActions key={r.id} onEdit={() => startEdit('rooms', r.id)} onDelete={() => handleDelete('rooms', r.id)} />,
              ])}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

type EntityTableProps = { headers: string[]; rows: (React.ReactNode | string | number)[][] }
function EntityTable({ headers, rows }: EntityTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {headers.map((h) => (
            <TableHead key={h}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={headers.length} className="text-center text-muted-foreground">
              Sin datos
            </TableCell>
          </TableRow>
        )}
        {rows.map((row, idx) => (
          <TableRow key={idx}>
            {row.map((cell, cIdx) => (
              <TableCell key={cIdx}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

type RowActionsProps = { onEdit: () => void; onDelete: () => void }
function RowActions({ onEdit, onDelete }: RowActionsProps) {
  return (
    <div className="flex gap-2">
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Editar
      </Button>
      <Button variant="ghost" size="sm" onClick={onDelete}>
        Eliminar
      </Button>
    </div>
  )
}

function buildFullAvailability(): Availability {
  const availability: Availability = {}
  const slots: string[] = []
  for (let h = 8; h < 18; h += 1) {
    slots.push(`${pad(h)}:00-${pad(h + 1)}:00`)
  }
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
  days.forEach((day) => {
    availability[day] = [...slots]
  })
  return availability
}

function pad(num: number): string {
  return num.toString().padStart(2, '0')
}

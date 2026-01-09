import { useEffect, useMemo, useRef, useState } from 'react'
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
  upsertTherapy,
  upsertTherapist,
} from '@/lib/api'
import { formatRequirements } from '@/lib/utils'
import type { Availability } from '@/lib/utils'
import type { Entities, Patient, Room, Specialty, Therapist, Therapy } from '@/lib/schema'
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
import { ScrollArea } from '@/components/ui/scroll-area'

const ENTITY_KEY = ['entities']
const NONE_VALUE = '__none__'

type TherapistForm = { id: string; name: string; specialties: string[]; availability: Availability }
type PatientTherapyForm = { therapy: string; sessions: number; fixedTherapists: Record<string, string[]> }
type PatientForm = {
  id: string
  name: string
  therapies: PatientTherapyForm[]
  availability: Availability
  maxContinuousHours?: number
  noSameDayTherapies: string[]
}
type RoomForm = { id: string; name: string; therapies: string[]; capacity: number; availability: Availability }
type SpecialtyForm = { id: string }
type TherapyForm = {
  id: string
  minPatients: number
  maxPatients: number
  requirements: { specialty: string; count: number }[]
}

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
    therapies: p
      ? Object.entries(p.therapies).map(([therapy, sessions]) => ({
          therapy,
          sessions,
          fixedTherapists: p.fixedTherapists?.[therapy] ?? {},
        }))
      : [],
    availability: p?.availability ?? FULL_AVAILABILITY,
    maxContinuousHours: p?.maxContinuousHours,
    noSameDayTherapies: p?.noSameDayTherapies ?? [],
  }
}

function formFromRoom(r?: Room): RoomForm {
  return {
    id: r?.id ?? '',
    name: r?.name ?? '',
    therapies: r?.therapies ?? [],
    capacity: r?.capacity ?? 1,
    availability: r?.availability ?? FULL_AVAILABILITY,
  }
}

function formFromSpecialty(s?: Specialty): SpecialtyForm {
  return { id: s?.id ?? '' }
}

function formFromTherapy(t?: Therapy): TherapyForm {
  return {
    id: t?.id ?? '',
    minPatients: t?.minPatients ?? 1,
    maxPatients: t?.maxPatients ?? 4,
    requirements: t
      ? Object.entries(t.requirements).map(([specialty, count]) => ({ specialty, count }))
      : [],
  }
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
  const upsertTherapyMutation = useMutation({
    mutationFn: upsertTherapy,
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
  const [therapyForm, setTherapyForm] = useState<TherapyForm>(formFromTherapy())

  const [openDialog, setOpenDialog] = useState<null | keyof Entities>(null)
  const [editId, setEditId] = useState<string | null>(null)

  const data = useMemo(() => entitiesQuery.data, [entitiesQuery.data])
  const specialtyOptions = useMemo(() => (data?.specialties ?? []).map((s) => s.id), [data])
  const therapyOptions = useMemo(() => (data?.therapies ?? []).map((t) => t.id), [data])
  const therapyListRef = useRef<HTMLDivElement | null>(null)
  const scrollTherapyListRef = useRef(false)
  const therapyById = useMemo(() => {
    return new Map((data?.therapies ?? []).map((therapy) => [therapy.id, therapy]))
  }, [data])
  const therapistsBySpecialty = useMemo(() => {
    const map: Record<string, string[]> = {}
    ;(data?.therapists ?? []).forEach((therapist) => {
      therapist.specialties.forEach((specialty) => {
        if (!map[specialty]) map[specialty] = []
        map[specialty].push(therapist.id)
      })
    })
    Object.values(map).forEach((list) => list.sort())
    return map
  }, [data])

  const addTherapyRequirementRow = () => {
    setTherapyForm((prev) => ({
      ...prev,
      requirements: [...prev.requirements, { specialty: specialtyOptions[0] ?? '', count: 1 }],
    }))
  }

  const updateTherapyRequirement = (index: number, field: 'specialty' | 'count', value: string | number) => {
    setTherapyForm((prev) => {
      const next = [...prev.requirements]
      const req = next[index]
      if (!req) return prev
      next[index] = { ...req, [field]: field === 'count' ? Number(value) : value }
      return { ...prev, requirements: next }
    })
  }

  const removeTherapyRequirement = (index: number) => {
    setTherapyForm((prev) => {
      const next = prev.requirements.filter((_, i) => i !== index)
      return { ...prev, requirements: next }
    })
  }

  const addPatientTherapyRow = () => {
    scrollTherapyListRef.current = true
    setPatientForm((prev) => ({
      ...prev,
      therapies: [...prev.therapies, { therapy: therapyOptions[0] ?? '', sessions: 1, fixedTherapists: {} }],
    }))
  }

  const updatePatientTherapy = (index: number, field: 'therapy' | 'sessions', value: string | number) => {
    setPatientForm((prev) => {
      const next = [...prev.therapies]
      const req = next[index]
      if (!req) return prev
      if (field === 'therapy') {
        const therapyId = String(value)
        const therapyInfo = therapyById.get(therapyId)
        const specialties = Object.keys(therapyInfo?.requirements ?? {})
        const nextFixed: Record<string, string[]> = {}
        specialties.forEach((specialty) => {
          const existing = req.fixedTherapists?.[specialty] ?? []
          if (!existing.length) return
          const requiredCount = therapyInfo?.requirements?.[specialty] ?? existing.length
          nextFixed[specialty] = existing.slice(0, requiredCount)
        })
        next[index] = { ...req, therapy: therapyId, fixedTherapists: nextFixed }
      } else {
        next[index] = { ...req, sessions: Number(value) }
      }
      return { ...prev, therapies: next }
    })
  }

  const updatePatientFixedTherapist = (index: number, specialty: string, slotIndex: number, therapistId: string) => {
    setPatientForm((prev) => {
      const next = [...prev.therapies]
      const req = next[index]
      if (!req) return prev
      const therapyInfo = therapyById.get(req.therapy)
      const requiredCount = therapyInfo?.requirements?.[specialty] ?? 1
      const current = req.fixedTherapists?.[specialty] ?? []
      const slots = Array.from({ length: requiredCount }, (_, idx) => current[idx] ?? '')
      slots[slotIndex] = therapistId
      const normalized = slots.filter((value) => value)
      const fixed = { ...req.fixedTherapists }
      if (normalized.length > 0) fixed[specialty] = normalized
      else delete fixed[specialty]
      next[index] = { ...req, fixedTherapists: fixed }
      return { ...prev, therapies: next }
    })
  }

  const removePatientTherapy = (index: number) => {
    setPatientForm((prev) => {
      const next = prev.therapies.filter((_, i) => i !== index)
      return { ...prev, therapies: next }
    })
  }

  useEffect(() => {
    if (!scrollTherapyListRef.current) return
    scrollTherapyListRef.current = false
    const node = therapyListRef.current
    if (!node) return
    requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    })
  }, [patientForm.therapies.length])

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
      case 'therapies': {
        const found = data.therapies.find((t) => t.id === id)
        setTherapyForm(formFromTherapy(found))
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
    setTherapyForm(formFromTherapy())
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
    const therapies: Record<string, number> = {}
    const fixedTherapists: Record<string, Record<string, string[]>> = {}
    patientForm.therapies.forEach((req) => {
      if (!req.therapy) return
      const sessions = Number(req.sessions)
      if (Number.isNaN(sessions) || sessions <= 0) return
      therapies[req.therapy] = sessions
      if (req.fixedTherapists && Object.keys(req.fixedTherapists).length > 0) {
        const normalized: Record<string, string[]> = {}
        Object.entries(req.fixedTherapists).forEach(([specialty, therapistIds]) => {
          const ids = therapistIds.filter((id) => id)
          if (ids.length > 0) normalized[specialty] = ids
        })
        if (Object.keys(normalized).length > 0) {
          fixedTherapists[req.therapy] = normalized
        }
      }
    })
    await upsertPatientMutation.mutateAsync({
      id: patientForm.id,
      name: patientForm.name,
      therapies,
      availability: patientForm.availability,
      maxContinuousHours: patientForm.maxContinuousHours ? Number(patientForm.maxContinuousHours) : undefined,
      noSameDayTherapies: patientForm.noSameDayTherapies,
      fixedTherapists,
    })
    toast.success('Paciente guardado')
    setOpenDialog(null)
    resetForm()
  }

  async function handleRoomSave() {
    await upsertRoomMutation.mutateAsync({
      id: roomForm.id,
      name: roomForm.name,
      therapies: roomForm.therapies,
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
    })
    toast.success('Especialidad guardada')
    setOpenDialog(null)
    resetForm()
  }

  async function handleTherapySave() {
    const requirements: Record<string, number> = {}
    therapyForm.requirements.forEach((req) => {
      if (!req.specialty) return
      const count = Number(req.count)
      if (Number.isNaN(count) || count <= 0) return
      requirements[req.specialty] = count
    })
    await upsertTherapyMutation.mutateAsync({
      id: therapyForm.id,
      minPatients: Number(therapyForm.minPatients || 1),
      maxPatients: Number(therapyForm.maxPatients || 1),
      requirements,
    })
    toast.success('Terapia guardada')
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

  const entities = data ?? { therapists: [], patients: [], rooms: [], specialties: [], therapies: [] }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle>Entidades</CardTitle>
          <CardDescription>Primero define especialidades y terapias, luego asigna terapeutas, pacientes y salas.</CardDescription>
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
            <TabsTrigger value="therapies">Terapias</TabsTrigger>
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
              headers={['ID', 'Acciones']}
              rows={entities.specialties.map((s) => [
                s.id,
                <RowActions key={s.id} onEdit={() => startEdit('specialties', s.id)} onDelete={() => handleDelete('specialties', s.id)} />,
              ])}
            />
          </TabsContent>

          <TabsContent value="therapies">
            <div className="mb-3 flex justify-end">
              <Dialog open={openDialog === 'therapies'} onOpenChange={(open) => (open ? startEdit('therapies') : setOpenDialog(null))}>
                <DialogTrigger asChild>
                  <Button onClick={() => startEdit('therapies')}>Añadir terapia</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editId ? 'Editar terapia' : 'Nueva terapia'}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label>ID</Label>
                      <Input value={therapyForm.id} onChange={(e) => setTherapyForm({ ...therapyForm, id: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Mín pacientes</Label>
                        <Input
                          type="number"
                          value={therapyForm.minPatients}
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            setTherapyForm({ ...therapyForm, minPatients: Number.isNaN(value) ? 1 : value })
                          }}
                        />
                      </div>
                      <div>
                        <Label>Máx pacientes</Label>
                        <Input
                          type="number"
                          value={therapyForm.maxPatients}
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            setTherapyForm({ ...therapyForm, maxPatients: Number.isNaN(value) ? 1 : value })
                          }}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Especialidades requeridas</Label>
                      <div className="space-y-2">
                        {therapyForm.requirements.map((req, idx) => (
                          <div key={idx} className="flex flex-col gap-2 rounded-lg border border-border/70 bg-secondary/40 p-3 md:flex-row md:items-center">
                            <div className="w-full md:w-1/2">
                              <Select
                                value={req.specialty}
                                onValueChange={(value) => updateTherapyRequirement(idx, 'specialty', value)}
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
                                value={req.count}
                                onChange={(e) => updateTherapyRequirement(idx, 'count', e.target.value)}
                                className="w-full"
                              />
                              <Button variant="ghost" size="sm" onClick={() => removeTherapyRequirement(idx)}>
                                Eliminar
                              </Button>
                            </div>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={addTherapyRequirementRow}
                          disabled={!specialtyOptions.length}
                        >
                          Añadir especialidad
                        </Button>
                        {!specialtyOptions.length ? (
                          <p className="text-xs text-muted-foreground">Primero agrega especialidades.</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpenDialog(null)}>
                        Cancelar
                      </Button>
                      <Button onClick={handleTherapySave} disabled={upsertTherapyMutation.isPending}>
                        Guardar
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <EntityTable
              headers={['ID', 'Min', 'Max', 'Especialidades', 'Acciones']}
              rows={entities.therapies.map((t) => [
                t.id,
                t.minPatients,
                t.maxPatients,
                formatRequirements(t.requirements),
                <RowActions key={t.id} onEdit={() => startEdit('therapies', t.id)} onDelete={() => handleDelete('therapies', t.id)} />,
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
              headers={['ID', 'Nombre', 'Especialidades', 'Acciones']}
              rows={entities.therapists.map((t) => [
                t.id,
                t.name,
                t.specialties.join(', '),
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
                      <Label>Terapias requeridas</Label>
                      <div className="max-h-[240px] overflow-y-auto pr-2" ref={therapyListRef}>
                        <div className="space-y-2 pb-2">
                          {patientForm.therapies.map((req, idx) => (
                            <div key={idx} className="flex flex-col gap-2 rounded-lg border border-border/70 bg-secondary/40 p-3">
                              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                <div className="w-full md:w-1/2">
                                  <Select
                                    value={req.therapy}
                                    onValueChange={(value) => updatePatientTherapy(idx, 'therapy', value)}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Terapia" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {therapyOptions.map((opt) => (
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
                                    value={req.sessions}
                                    onChange={(e) => updatePatientTherapy(idx, 'sessions', e.target.value)}
                                    className="w-full"
                                  />
                                  <Button variant="ghost" size="sm" onClick={() => removePatientTherapy(idx)}>
                                    Eliminar
                                  </Button>
                                </div>
                              </div>
                              {(() => {
                                const therapyInfo = therapyById.get(req.therapy)
                                const requirements = therapyInfo?.requirements ?? {}
                                const entries = Object.entries(requirements)
                                if (!entries.length) return null
                                return (
                                  <div className="space-y-2 text-xs text-muted-foreground">
                                    <div>Terapeutas fijos (opcional)</div>
                                    {entries.map(([specialty, count]) => {
                                      const options = therapistsBySpecialty[specialty] ?? []
                                      const total = Number(count) || 1
                                      const current = req.fixedTherapists?.[specialty] ?? []
                                      const slots = Array.from({ length: total }, (_, slotIndex) => current[slotIndex] ?? '')
                                      return (
                                        <div key={`${req.therapy}-${specialty}`} className="space-y-2">
                                          {slots.map((slotValue, slotIndex) => {
                                            const label =
                                              total > 1
                                                ? `Fijar ${slotIndex + 1} de ${total} (${specialty})`
                                                : `Fijar ${specialty}`
                                            return (
                                              <div key={`${req.therapy}-${specialty}-${slotIndex}`} className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                                <span>{label}</span>
                                                <Select
                                                  value={slotValue || NONE_VALUE}
                                                  onValueChange={(value) =>
                                                    updatePatientFixedTherapist(
                                                      idx,
                                                      specialty,
                                                      slotIndex,
                                                      value === NONE_VALUE ? '' : value,
                                                    )
                                                  }
                                                >
                                                  <SelectTrigger className="md:w-[220px]">
                                                    <SelectValue placeholder="Sin fijar" />
                                                  </SelectTrigger>
                                                  <SelectContent>
                                                    <SelectItem value={NONE_VALUE}>Sin fijar</SelectItem>
                                                    {options.map((therapistId) => (
                                                      <SelectItem key={therapistId} value={therapistId}>
                                                        {therapistId}
                                                      </SelectItem>
                                                    ))}
                                                  </SelectContent>
                                                </Select>
                                              </div>
                                            )
                                          })}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )
                              })()}
                            </div>
                          ))}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={addPatientTherapyRow}
                        disabled={!therapyOptions.length}
                      >
                        Añadir terapia
                      </Button>
                      {!therapyOptions.length ? (
                        <p className="text-xs text-muted-foreground">Primero agrega terapias.</p>
                      ) : null}
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
                          options={therapyOptions}
                          value={patientForm.noSameDayTherapies}
                          onChange={(noSameDayTherapies) => setPatientForm({ ...patientForm, noSameDayTherapies })}
                          emptyHint="Añade terapias primero."
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
              headers={['ID', 'Nombre', 'Requerimientos', 'Restricciones', 'Acciones']}
              rows={entities.patients.map((p) => [
                p.id,
                p.name,
                formatRequirements(p.therapies),
                (
                  <div className="space-y-1 text-xs" key={`${p.id}-rules`}>
                    {p.maxContinuousHours ? <Badge variant="outline">Max {p.maxContinuousHours}h</Badge> : null}
                    {p.noSameDayTherapies?.length ? (
                      <div className="text-muted-foreground">
                        Evitar: {p.noSameDayTherapies.join(', ')}
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
                      <Label>Terapias</Label>
                      <SpecialtySelect
                        options={therapyOptions}
                        value={roomForm.therapies}
                        onChange={(therapies) => setRoomForm({ ...roomForm, therapies })}
                        emptyHint="Añade terapias primero."
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
              headers={['ID', 'Nombre', 'Terapias', 'Capacidad', 'Acciones']}
              rows={entities.rooms.map((r) => [
                r.id,
                r.name,
                r.therapies.join(', '),
                r.capacity,
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
    <ScrollArea className="h-[260px] w-full pr-2" type="always">
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
    </ScrollArea>
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

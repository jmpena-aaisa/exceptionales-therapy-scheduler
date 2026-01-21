import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deleteRun, fetchRuns, getResults, runModel } from '@/lib/api'
import { useScheduleStore } from '@/lib/state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function RunModelPanel() {
  const { result, setResult, clearResult } = useScheduleStore()
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const runsQuery = useQuery({
    queryKey: ['runs'],
    queryFn: () => fetchRuns(20),
  })

  const mutation = useMutation({
    mutationFn: runModel,
    onSuccess: (data) => {
      setResult(data)
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      if (data.status === 'success') {
        toast.success('Modelo ejecutado')
      } else {
        toast.error('El modelo no produjo resultado')
      }
    },
    onError: () => toast.error('Fallo al ejecutar el modelo'),
  })

  const statusLabel = useMemo(() => {
    switch (mutation.isPending || result.status === 'running' ? 'running' : result.status) {
      case 'running':
        return { text: 'En progreso', variant: 'warning' as const }
      case 'success':
        return { text: 'OK', variant: 'success' as const }
      case 'failed':
        return { text: 'Error', variant: 'destructive' as const }
      default:
        return { text: 'Sin ejecutar', variant: 'outline' as const }
    }
  }, [result.status, mutation.isPending])

  const diagnosticsByMethod = result.diagnosticsByMethod ?? {}
  const hasDiagnostics = Object.values(diagnosticsByMethod).some((items) => items.length > 0)

  useEffect(() => {
    if (result.status === 'failed' && hasDiagnostics) {
      setShowDiagnostics(true)
    }
  }, [result.status, result.finishedAt, hasDiagnostics])

  const runs = runsQuery.data ?? []

  const handleViewRun = async (sessionId: string, showDiag: boolean) => {
    setBusySessionId(sessionId)
    try {
      const data = await getResults(sessionId)
      setResult(data)
      if (showDiag) {
        setShowDiagnostics(true)
      } else {
        setShowDiagnostics(false)
      }
    } catch (error) {
      toast.error('No se pudo cargar la ejecución.')
      console.error(error)
    } finally {
      setBusySessionId(null)
    }
  }

  const handleDeleteRun = async (sessionId: string) => {
    setBusySessionId(sessionId)
    try {
      await deleteRun(sessionId)
      toast.success('Ejecución eliminada')
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      if (result.sessionId === sessionId) {
        try {
          const latest = await getResults()
          setResult(latest)
        } catch (error) {
          clearResult()
          console.error(error)
        }
      }
    } catch (error) {
      toast.error('No se pudo eliminar la ejecución.')
      console.error(error)
    } finally {
      setBusySessionId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle>Modelo</CardTitle>
          <CardDescription>Ejecuta el solver y actualiza el horario.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusLabel.variant}>{statusLabel.text}</Badge>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Ejecutando...' : 'Ejecutar modelo'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {result.startedAt && <p>Última ejecución: {new Date(result.startedAt).toLocaleString()}</p>}
        {result.finishedAt && <p>Finalizó: {new Date(result.finishedAt).toLocaleString()}</p>}
        {result.status !== 'failed' && result.diagnostics?.length ? <p>Notas: {result.diagnostics.join(' • ')}</p> : null}
        {result.status === 'failed' && hasDiagnostics ? (
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => setShowDiagnostics(true)}>
              Ver diagnóstico
            </Button>
          </div>
        ) : null}
        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Historial de ejecuciones</div>
          {runsQuery.isError ? (
            <p>No se pudo cargar el historial.</p>
          ) : runsQuery.isLoading ? (
            <p>Cargando historial...</p>
          ) : runs.length === 0 ? (
            <p>No hay ejecuciones previas.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => {
                const isActive = result.sessionId === run.sessionId
                const runStatus =
                  run.status === 'success'
                    ? { text: 'OK', variant: 'success' as const }
                    : run.status === 'failed'
                      ? { text: 'Error', variant: 'destructive' as const }
                      : run.status === 'running'
                        ? { text: 'En progreso', variant: 'warning' as const }
                        : { text: 'Sin ejecutar', variant: 'outline' as const }
                const isBusy = busySessionId === run.sessionId
                return (
                  <div
                    key={run.sessionId}
                    className={`rounded-lg border border-border/60 px-3 py-3 ${isActive ? 'bg-secondary/60' : 'bg-white/70'}`}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant={runStatus.variant}>{runStatus.text}</Badge>
                          <span className="text-xs text-muted-foreground">ID {run.sessionId.slice(0, 8)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Inicio: {new Date(run.startedAt).toLocaleString()}
                        </div>
                        {run.finishedAt ? (
                          <div className="text-xs text-muted-foreground">
                            Finalizó: {new Date(run.finishedAt).toLocaleString()}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewRun(run.sessionId, run.status !== 'success')}
                          disabled={isBusy}
                        >
                          {run.status === 'success' ? 'Ver resultados' : 'Ver diagnóstico'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteRun(run.sessionId)} disabled={isBusy}>
                          Eliminar
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </CardContent>
      <Dialog open={showDiagnostics} onOpenChange={setShowDiagnostics}>
        <DialogContent className="max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>Diagnóstico de inviabilidad</DialogTitle>
            <DialogDescription>
              Resultados de las 3 estrategias: núcleo por supuestos, prechequeos y holguras.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 space-y-4">
            {renderDiagnosticSection('Holguras mínimas', diagnosticsByMethod.soft)}
            {renderDiagnosticSection('Prechequeos', diagnosticsByMethod.prechecks)}
            {renderDiagnosticSection('Núcleo por supuestos', diagnosticsByMethod.assumptions)}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function renderDiagnosticSection(title: string, items?: string[]) {
  if (!items || items.length === 0) {
    return (
      <div className="mb-4">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <p className="text-sm text-muted-foreground">Sin hallazgos.</p>
      </div>
    )
  }
  return (
    <div className="mb-4">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {items.map((item, idx) => (
          <li key={`${title}-${idx}`}>• {item}</li>
        ))}
      </ul>
    </div>
  )
}

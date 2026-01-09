import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { runModel } from '@/lib/api'
import { useScheduleStore } from '@/lib/state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'

export function RunModelPanel() {
  const { result, setResult } = useScheduleStore()
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  const mutation = useMutation({
    mutationFn: runModel,
    onSuccess: (data) => {
      setResult(data)
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
        {result.diagnostics?.length ? <p>Notas: {result.diagnostics.join(' • ')}</p> : null}
        {result.status === 'failed' && hasDiagnostics ? (
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => setShowDiagnostics(true)}>
              Ver diagnóstico
            </Button>
          </div>
        ) : null}
      </CardContent>
      <Dialog open={showDiagnostics} onOpenChange={setShowDiagnostics}>
        <DialogContent className="max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Diagnóstico de inviabilidad</DialogTitle>
            <DialogDescription>
              Resultados de las 3 estrategias: núcleo por supuestos, prechequeos y holguras.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] w-full pr-3" type="always">
            {renderDiagnosticSection('Holguras mínimas', diagnosticsByMethod.soft)}
            {renderDiagnosticSection('Prechequeos', diagnosticsByMethod.prechecks)}
            {renderDiagnosticSection('Núcleo por supuestos', diagnosticsByMethod.assumptions)}
          </ScrollArea>
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

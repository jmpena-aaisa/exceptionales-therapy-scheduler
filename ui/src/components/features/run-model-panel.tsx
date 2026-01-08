import { useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { runModel } from '@/lib/api'
import { useScheduleStore } from '@/lib/state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function RunModelPanel() {
  const { result, setResult } = useScheduleStore()

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
      </CardContent>
    </Card>
  )
}

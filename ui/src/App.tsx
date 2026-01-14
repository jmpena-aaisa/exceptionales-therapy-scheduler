import { useMemo } from 'react'
import { toast } from 'sonner'
import { EntitiesPanel } from '@/components/features/entities/entities-panel'
import { LoginDialogButton } from '@/components/features/login-dialog'
import { ResultsPanel } from '@/components/features/results/results-panel'
import { RunModelPanel } from '@/components/features/run-model-panel'
import { Button } from '@/components/ui/button'
import { downloadExcel } from '@/lib/api'
import { downloadFile } from '@/lib/utils'
import { useAuthStore } from '@/lib/state'
import { useScheduleStore } from '@/lib/state'

function App() {
  const { result } = useScheduleStore()
  const { token } = useAuthStore()
  const isLoggedIn = Boolean(token)
  const hasResults = useMemo(() => result.sessions.length > 0, [result.sessions])

  const exportResult = () => {
    if (!hasResults) return
    downloadFile('schedule.json', JSON.stringify(result, null, 2))
  }

  const handleExcel = async () => {
    try {
      await downloadExcel(result.sessionId)
      toast.success('Descarga iniciada')
    } catch (error) {
      toast.error('No encontré el Excel. Ejecuta el modelo o verifica la sesión.')
      console.error(error)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f7fbff] via-white to-[#e3eff5] text-foreground">
      <header className="border-b border-border/70 bg-white/80 backdrop-blur">
        <div className="container flex flex-col gap-4 py-6 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-3 items-start">
            <img src="/logo.png" alt="Therapy Scheduler" className="h-6 w-auto md:h-8 object-contain" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-[#01238f]">Therapy Scheduler UI</h1>
              <p className="text-sm text-muted-foreground">
                Administra entidades, carga JSON, ejecuta el modelo y visualiza resultados.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isLoggedIn ? (
              <>
                <Button variant="outline" onClick={handleExcel}>
                  Descargar Excel
                </Button>
                <Button variant="outline" disabled={!hasResults} onClick={exportResult}>
                  Exportar resultado JSON
                </Button>
              </>
            ) : null}
            <LoginDialogButton />
          </div>
        </div>
      </header>

      <main className="container flex flex-col gap-6 py-6">
        {isLoggedIn ? (
          <>
            <RunModelPanel />
            <EntitiesPanel />
            <ResultsPanel />
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-border/70 bg-white/70 p-10 text-center text-sm text-muted-foreground">
            Inicia sesion para acceder al panel de configuracion y ejecutar el modelo.
          </div>
        )}
      </main>
    </div>
  )
}

export default App

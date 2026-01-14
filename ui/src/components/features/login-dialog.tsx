import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { login } from '@/lib/api'
import { useAuthStore, useScheduleStore } from '@/lib/state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginDialogButton() {
  const { token, userId, email, expiresAt, setAuth, clearAuth } = useAuthStore()
  const { clearResult } = useScheduleStore()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ email: '', password: '' })
  const isLoggedIn = Boolean(token)

  const expiresLabel = useMemo(() => {
    if (!expiresAt) return null
    const date = new Date(expiresAt)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleString()
  }, [expiresAt])

  const mutation = useMutation({
    mutationFn: () => login(form.email.trim(), form.password),
    onSuccess: (data) => {
      setAuth(data)
      setForm((prev) => ({ ...prev, password: '' }))
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: ['entities'] })
      clearResult()
      toast.success('Sesion iniciada')
    },
    onError: () => toast.error('Credenciales invalidas o API no disponible.'),
  })

  const handleLogin = () => {
    if (!form.email.trim() || !form.password) {
      toast.error('Completa usuario y contrasena.')
      return
    }
    mutation.mutate()
  }

  const handleLogout = () => {
    clearAuth()
    setOpen(false)
    queryClient.removeQueries({ queryKey: ['entities'] })
    clearResult()
    toast.message('Sesion cerrada')
  }

  const buttonLabel = isLoggedIn ? `Sesion: ${userId ?? 'activo'}` : 'Iniciar sesion'

  return (
    <>
      <Button variant={isLoggedIn ? 'outline' : 'default'} onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Acceso</DialogTitle>
            <DialogDescription>Inicia sesion para continuar.</DialogDescription>
          </DialogHeader>
          {isLoggedIn ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border border-dashed border-border/80 bg-muted/30 p-3">
                <div className="font-medium text-foreground">Conectado</div>
                <div>Usuario: {userId}</div>
                {email ? <div>Email: {email}</div> : null}
                {expiresLabel ? <div>Expira: {expiresLabel}</div> : null}
              </div>
              <Button variant="outline" onClick={handleLogout}>
                Cerrar sesion
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-2">
                <Label htmlFor="login-email">Usuario</Label>
                <Input
                  id="login-email"
                  value={form.email}
                  onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                  placeholder="text"
                  autoComplete="username"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="login-password">Contrasena</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                  placeholder="*****"
                  autoComplete="current-password"
                />
              </div>
              <Button onClick={handleLogin} disabled={mutation.isPending}>
                {mutation.isPending ? 'Ingresando...' : 'Iniciar sesion'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

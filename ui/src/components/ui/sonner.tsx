import { Toaster as SonnerToaster, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps) {
  return <SonnerToaster theme="light" toastOptions={{ className: 'border border-border shadow-lg' }} {...props} />
}

export { Toaster }

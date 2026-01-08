import { cn } from '@/lib/utils'

type SpecialtySelectProps = {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  emptyHint?: string
}

export function SpecialtySelect({ options, value, onChange, emptyHint }: SpecialtySelectProps) {
  const toggle = (id: string) => {
    const next = new Set(value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(Array.from(next))
  }

  if (!options.length) {
    return <div className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">{emptyHint || 'Agrega especialidades primero.'}</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const isSelected = value.includes(option)
        return (
          <button
            key={option}
            type="button"
            onClick={() => toggle(option)}
            className={cn(
              'rounded-full border px-3 py-1 text-sm transition-colors',
              isSelected
                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                : 'border-border bg-background text-foreground hover:bg-secondary',
            )}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

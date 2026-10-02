/**
 * Classes partagées des écrans d'états des lieux, à la charte (rayons 8 / 12 /
 * 16 px, focus visible au bleu clair, erreurs signalées par la bordure **et**
 * par un message).
 */
export const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
export const labelClass = 'block text-sm font-medium text-foreground'
export const hintClass = 'mt-1 text-xs text-muted-foreground'
export const errorClass = 'mt-1 text-xs text-destructive'

export const primaryButton =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
export const secondaryButton =
  'inline-flex items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
export const smallButton =
  'inline-flex min-h-6 items-center justify-center rounded-sm border border-border bg-white px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
export const dangerSmallButton =
  'inline-flex min-h-6 items-center justify-center rounded-sm border border-destructive/30 bg-white px-2.5 py-1 text-xs font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
export const linkClass = 'font-medium text-primary underline-offset-2 hover:underline'
export const cardClass = 'rounded-lg border border-border bg-white'

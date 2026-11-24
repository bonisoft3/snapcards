/// <reference lib="dom" />
export function prontoReady(): boolean {
  if (!document.querySelector('.shell-screen:not([hidden]):not([inert]) .screen')) return false
  if (document.querySelector('[data-served]')) return false
  if (Array.from(document.querySelectorAll('[data-pending="true"]')).some((el) => !el.closest('.shell-screen[hidden]'))) return false
  const busyFn = (globalThis as unknown as { __prontoBusy?: () => { regions: number; waits: number } }).__prontoBusy
  const busy = busyFn?.()
  return Boolean(busy && busy.regions === 0 && busy.waits === 0)
}

import { parseHTML } from 'npm:linkedom@0.18.4'
import { prontoReady } from './acceptance-readiness.ts'

Deno.test('readiness ignores only paused screen stamps', () => {
  const { document } = parseHTML('<main><div class="shell-screen" hidden><span data-pending="true"></span></div><div class="shell-screen"><section class="screen"><span id="active"></span></section></div></main>')
  const globals = globalThis as unknown as { document: Document; __prontoBusy: () => { regions: number; waits: number } }
  const previousDocument = globals.document
  const previousBusy = globals.__prontoBusy
  globals.document = document as unknown as Document
  globals.__prontoBusy = () => ({ regions: 0, waits: 0 })
  try {
    const screen = document.querySelector('.screen')!
    screen.classList.remove('screen')
    if (prontoReady()) throw new Error('zero busy regions before the first mount is not readiness')
    screen.classList.add('screen')
    const mount = screen.parentElement!
    mount.setAttribute('inert', '')
    if (prontoReady()) throw new Error('an outgoing presentation must not count as a ready destination')
    mount.removeAttribute('inert')
    if (!prontoReady()) throw new Error('a paused screen must not block the active screen')
    document.getElementById('active')!.setAttribute('data-pending', 'true')
    if (prontoReady()) throw new Error('an active pending row must block readiness')
  } finally {
    globals.document = previousDocument
    globals.__prontoBusy = previousBusy
  }
})

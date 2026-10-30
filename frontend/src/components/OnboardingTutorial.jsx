import { useEffect, useId, useState } from 'react'
import './OnboardingTutorial.css'

const STEPS = [
  {
    id: 'account',
    signal: '01 // OPERATORE LOCALE',
    title: 'Il tuo spazio Ultron AI è pronto.',
    description: 'Ogni operatore usa un account locale separato. Le preferenze, la posizione e gli archivi restano legati a questo account su questo Mac.',
    checklist: [
      ['Account locale', 'Protegge l’accesso al tuo pannello di controllo.'],
      ['Sessione temporanea', 'Al termine chiudi l’app: dovrai sbloccare di nuovo Ultron AI.'],
      ['Dati separati', 'Un altro account sullo stesso Mac non vede i tuoi archivi.'],
    ],
    tip: 'Puoi uscire in qualsiasi momento dal pulsante Esci in alto a destra.',
    accent: 'OPERATORE',
  },
  {
    id: 'ollama',
    signal: '02 // IA LOCALE',
    title: 'Collega il motore che risponde.',
    description: 'Ultron AI usa un modello locale tramite Ollama. Installa Ollama, avvialo e scarica un modello compatibile: il Core lo userà sul tuo computer.',
    checklist: [
      ['1. Installa Ollama', 'Scaricalo da ollama.com/download.'],
      ['2. Scegli un modello', 'Ad esempio un modello adatto alla memoria del tuo Mac.'],
      ['3. Prova Agent', 'Scrivi un messaggio nella chat e verifica che il Core risponda.'],
    ],
    tip: 'La conversazione resta locale finché non chiedi una funzione esterna, come ricerca web o email.',
    accent: 'IA LOCALE',
  },
  {
    id: 'obsidian',
    signal: '03 // ARCHIVIO DELLA MEMORIA',
    title: 'Trasforma il vault in memoria utile.',
    description: 'Collega una cartella Obsidian per permettere a Ultron AI di leggere le note che scegli e cercarle dalla sezione Memoria.',
    checklist: [
      ['Apri Impostazioni', 'Vai in Integrazioni e indica il percorso del tuo archivio.'],
      ['Collega l’archivio', 'Ultron AI indicizza le note Markdown disponibili.'],
      ['Archivia su richiesta', 'Nella chat attiva Salva nel vault prima di inviare un comando da salvare.'],
    ],
    tip: 'Ultron AI non salva automaticamente ogni conversazione: l’archiviazione richiede la tua azione.',
    accent: 'MEMORIA',
    destination: 'settings',
  },
  {
    id: 'mail',
    signal: '04 // COLLEGAMENTO EMAIL',
    title: 'Collega Gmail quando ti serve.',
    description: 'Puoi leggere le email recenti e preparare bozze dalla chat usando gli account configurati in Mail.app o Internet Accounts di macOS.',
    checklist: [
      ['Connetti Gmail', 'In Impostazioni → Email apri il collegamento a Internet Accounts.'],
      ['Controlla lo stato', 'Ultron AI rileva gli account solo dopo che li hai configurati.'],
      ['Invio controllato', 'L’assistente prepara una bozza: l’email parte soltanto con SEND NOW.'],
    ],
    tip: 'Ultron AI non conserva la password di Google o i token del tuo account.',
    accent: 'EMAIL',
    destination: 'settings',
  },
  {
    id: 'devices',
    signal: '05 // CONTROLLO DISPOSITIVI',
    title: 'Controlla dispositivi e stampa 3D.',
    description: 'La sezione Devices mostra la telemetria del Mac e ti guida nel collegamento esplicito della stampante. Il Model Deck cataloga ogni file che scegli, anche quando serve il suo programma nativo per aprirlo.',
    checklist: [
      ['Scegli il collegamento', 'USB per Marlin/Elegoo/Neptune, oppure Wi‑Fi locale per OctoPrint o Moonraker.'],
      ['Fai il test', 'Il test legge solo lo stato: non invia movimenti, temperature o stampe.'],
      ['Apri il file giusto', 'Usa Cura, Bambu Studio, OrcaSlicer o un’app locale scelta da te dal Model Deck.'],
    ],
    tip: 'Lo stato non cerca porte o stampanti in automatico: Ultron AI usa solo il profilo locale che hai salvato e collegato tu.',
    accent: 'STAMPA 3D',
    destination: 'devices',
  },
  {
    id: 'privacy',
    signal: '06 // PRIVACY PER SCELTA',
    title: 'Hai il controllo finale.',
    description: 'Ultron AI è pensato per lavorare sul tuo computer. Posizione, memoria e integrazioni vengono usate solo dopo la tua scelta esplicita.',
    checklist: [
      ['Posizione globale', 'Cerca un luogo oppure usa la posizione del dispositivo solo quando premi il relativo pulsante.'],
      ['Memoria', 'Il vault salva solo il comando che hai scelto di archiviare.'],
      ['Integrazioni', 'Mail, Obsidian e dispositivi possono essere scollegati in qualsiasi momento.'],
      ['Voce', 'Il microfono si attiva solo quando premi il pulsante voce e usa il servizio disponibile sul tuo Mac.'],
    ],
    tip: 'Puoi riaprire questa guida da Impostazioni → Avanzate → Apri guida rapida.',
    accent: 'PRONTO',
  },
]

function StepGlyph({ id }) {
  const glyphs = {
    account: '◉',
    ollama: '✦',
    obsidian: '◇',
    mail: '↗',
    devices: '⌁',
    privacy: '◈',
  }

  return <span aria-hidden="true">{glyphs[id] || '◌'}</span>
}

export default function OnboardingTutorial({
  accountName,
  onDismiss,
  onOpenSettings,
  onOpenDevices,
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const titleId = useId()
  const descriptionId = useId()
  const step = STEPS[stepIndex]
  const isFinalStep = stepIndex === STEPS.length - 1

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss?.('skip')
      }

      if (event.key === 'ArrowLeft' && stepIndex > 0) {
        event.preventDefault()
        setStepIndex(current => Math.max(0, current - 1))
      }

      if (event.key === 'ArrowRight' && stepIndex < STEPS.length - 1) {
        event.preventDefault()
        setStepIndex(current => Math.min(STEPS.length - 1, current + 1))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss, stepIndex])

  function openDestination() {
    if (step.destination === 'devices') {
      onOpenDevices?.()
    } else {
      onOpenSettings?.()
    }
    onDismiss?.('complete')
  }

  return (
    <div className="onboarding-overlay" role="presentation">
      <div className="onboarding-backdrop" aria-hidden="true" />
      <section
        className="onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <aside className="onboarding-rail" aria-label="Progressione tutorial">
          <div className="onboarding-brand">
            <img src="./ultron-mark.png" alt="" />
            <div>
              <span>Ultron AI</span>
              <strong>AVVIO RAPIDO</strong>
            </div>
          </div>

          <div className="onboarding-operator">
            <span>OPERATORE LOCALE</span>
            <strong>{accountName || 'OPERATORE'}</strong>
          </div>

          <ol className="onboarding-steps">
            {STEPS.map((item, index) => {
              const current = index === stepIndex
              const complete = index < stepIndex
              return (
                <li key={item.id} className={current ? 'current' : complete ? 'complete' : ''}>
                  <button
                    type="button"
                    onClick={() => setStepIndex(index)}
                    aria-current={current ? 'step' : undefined}
                    aria-label={`Passaggio ${index + 1}: ${item.title}`}
                  >
                    <i>{complete ? '✓' : String(index + 1).padStart(2, '0')}</i>
                    <span>{item.accent}</span>
                  </button>
                </li>
              )
            })}
          </ol>

          <div className="onboarding-rail-footer">
            <span>MODALITÀ LOCALE</span>
            <i>●</i>
          </div>
        </aside>

        <div className="onboarding-content">
          <header className="onboarding-header">
            <div>
              <span>{step.signal}</span>
              <div className="onboarding-progress-track" aria-hidden="true">
                <i style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }} />
              </div>
            </div>
            <button
              type="button"
              className="onboarding-skip"
              onClick={() => onDismiss?.('skip')}
            >
              SALTA LA GUIDA
            </button>
          </header>

          <main className="onboarding-main" key={step.id}>
            <div className="onboarding-signal-mark">
              <StepGlyph id={step.id} />
              <i aria-hidden="true" />
            </div>

            <div className="onboarding-copy">
              <span className="onboarding-kicker">GUIDA · {step.accent}</span>
              <h1 id={titleId}>{step.title}</h1>
              <p id={descriptionId}>{step.description}</p>
            </div>

            <div className="onboarding-checklist">
              {step.checklist.map(([label, description], index) => (
                <article key={label}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{label}</strong>
                    <p>{description}</p>
                  </div>
                </article>
              ))}
            </div>

            <aside className="onboarding-tip">
              <span>SUGGERIMENTO</span>
              <p>{step.tip}</p>
              {step.destination && (
                <button type="button" onClick={openDestination}>
                  {step.destination === 'devices' ? 'APRI DISPOSITIVI' : 'APRI IMPOSTAZIONI'}
                </button>
              )}
            </aside>
          </main>

          <footer className="onboarding-footer">
            <span>PASSO {String(stepIndex + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}</span>
            <div>
              <button
                type="button"
                className="onboarding-back"
                onClick={() => setStepIndex(current => Math.max(0, current - 1))}
                disabled={stepIndex === 0}
              >
                INDIETRO
              </button>
              <button
                type="button"
                className="onboarding-next"
                onClick={() => {
                  if (isFinalStep) {
                    onDismiss?.('complete')
                    return
                  }
                  setStepIndex(current => Math.min(STEPS.length - 1, current + 1))
                }}
              >
                {isFinalStep ? 'Apri Ultron AI' : 'CONTINUA'}
              </button>
            </div>
          </footer>
        </div>
      </section>
    </div>
  )
}

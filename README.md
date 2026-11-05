# WhatScribe

PWA che compare nel menu **Condividi** di Android e trascrive i vocali di WhatsApp, con Whisper nel browser. Offline, privata, gratis.

*English: a PWA that shows up in Android's Share menu and transcribes WhatsApp voice notes on-device with Whisper (transformers.js). No account, no server of ours; audio never leaves the phone unless you enable the optional remote engine.*

Sito e spiegazione: https://whatscribe.bellarosa.me/come-funziona

## Deploy
1. Carica la cartella su un qualsiasi hosting statico **in HTTPS** (anche in una sottocartella, es. `https://tuodominio.it/trascrivi/`). Non serve un backend.
2. Dal telefono apri l'URL in **Chrome**, menu ⋮ > **Installa app** (o "Aggiungi a schermata Home").
3. Su WhatsApp: tieni premuto un vocale > **Condividi** > **WhatScribe**.

Se il vocale non ha l'opzione Condividi, usa **Scegli file** e vai in
`Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Voice Notes/`.

## Motori
- **Locale** (default: whisper-small): gira nel browser con transformers.js, WebGPU se disponibile altrimenti WASM. Al primo uso scarica il modello da Hugging Face, poi funziona offline. `large-v3-turbo` è il più preciso in italiano, ma senza WebGPU è lento.
- **Remoto**: qualsiasi endpoint `/audio/transcriptions` compatibile OpenAI (Groq, OpenAI, server tuo). L'endpoint deve accettare richieste CORS dal browser.

Impostazioni e storico (IndexedDB) restano sul telefono. La chiave API del motore remoto è cifrata (AES-GCM, chiave non esportabile) in un archivio IndexedDB separato, non in `localStorage`.

## Offline
`sw.js` mette in cache i file dell'app e la libreria (jsDelivr, versione fissata in `worker.js`). Dopo **Impostazioni > Scarica modello** l'app si apre e trascrive senza rete. Quando cambi i file dell'app alza `VERSION` in `sw.js`.

## Sicurezza
`_headers` (formato Cloudflare/Netlify) imposta una Content-Security-Policy restrittiva (script solo da sé e da jsDelivr). Se cambi CDN o aggiungi risorse esterne, aggiorna la CSP.

## File
- `manifest.webmanifest`: `share_target` che riceve file audio
- `sw.js`: intercetta il POST della condivisione e passa il file alla pagina
- `app.js`: UI, decodifica audio a 16 kHz, motore remoto, storico
- `worker.js`: Whisper locale in un Web Worker

## Licenza
MIT, vedi `LICENSE`. Progetto indipendente, non affiliato a WhatsApp o Meta.

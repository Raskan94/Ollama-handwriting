# Handwriting to Text (Ollama)

Plugin per [Obsidian](https://obsidian.md) che ti permette di **scrivere a mano con la penna** su una lavagna e di ottenere, in una colonna a destra, il **testo digitale** trascritto da un modello con visione eseguito tramite [Ollama](https://ollama.com).

Funziona su desktop e su mobile/tablet (`isDesktopOnly: false`), pensato soprattutto per dispositivi con penna (iPad con Apple Pencil, tablet Android, Surface, ecc.).

## Come funziona

1. Scrivi sulla lavagna con la penna (la pagina è righettata e si estende automaticamente).
2. Dopo una breve pausa (o premendo **Trascrivi**) i tratti vengono esportati come immagine PNG nero su bianco, ritagliata sull'area scritta.
3. L'immagine viene inviata all'endpoint `/api/chat` di Ollama insieme alle istruzioni (prompt).
4. Il testo restituito appare nella colonna **Trascrizione**, dove puoi correggerlo a mano, copiarlo o inserirlo nella nota attiva.

## Requisiti

- Obsidian **1.5.0** o superiore
- [Ollama](https://ollama.com) in esecuzione (in locale o su un altro PC in rete)
- Un modello **con capacità di visione** già installato, ad esempio:
  ```bash
  ollama pull qwen2.5vl:7b
  ```
  Altri esempi: `minicpm-v`, `llama3.2-vision`, `gemma3:4b`. Sono supportati anche i modelli cloud di Ollama (es. `gemma4:31b-cloud`).

## Installazione

1. Crea la cartella `.obsidian/plugins/ollama-handwriting/` nel tuo vault.
2. Copia al suo interno i file `main.js`, `manifest.json` e `styles.css`.
3. Riavvia Obsidian (o ricarica i plugin) e attiva **Handwriting to Text (Ollama)** in *Impostazioni → Plugin della community*.

> Il plugin crea da solo nella stessa cartella i file `data.json` (impostazioni) e `ink.json` (tratti e ultima trascrizione).

### Accesso a Ollama da altri dispositivi

Se usi Obsidian su tablet e Ollama su un altro computer, avvia Ollama in modo che accetti connessioni dalla rete, ad esempio:

```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

e imposta nelle impostazioni del plugin l'indirizzo del PC (es. `http://192.168.1.20:11434`).

## Utilizzo

- Clicca l'icona a forma di **matita** nella barra laterale (ribbon), oppure usa il comando *Apri lavagna e colonna di trascrizione*.
- Si apre la lavagna accanto alla nota e la colonna **Trascrizione** a destra.

### Barra degli strumenti della lavagna

| Pulsante | Funzione |
|---|---|
| **Penna** | Disegna (la pressione della penna varia lo spessore del tratto) |
| **Gomma** | Cancella i tratti toccati. Anche la punta "gomma" della penna, se presente, funziona |
| **Annulla** | Annulla l'ultima azione (fino a 100 passi) |
| **Svuota** | Cancella tutta la lavagna |
| **+ Pagina** | Aggiunge altro spazio verticale |
| **Auto: sì/no** | Attiva/disattiva la trascrizione automatica |
| **Trascrivi** | Avvia subito la trascrizione |

### Colonna Trascrizione

- Mostra lo stato (pronto, in corso, errore).
- Il testo è **modificabile**: le correzioni manuali vengono mantenute.
- **Trascrivi di nuovo** – rilancia la trascrizione.
- **Inserisci nella nota** – inserisce il testo nella nota Markdown attiva (sostituisce la selezione, se presente). Prima clicca all'interno della nota di destinazione.
- **Copia** – copia il testo negli appunti.

### Comandi (palette comandi)

- `Apri lavagna e colonna di trascrizione`
- `Trascrivi ora`
- `Inserisci la trascrizione nella nota attiva`

## Impostazioni

| Impostazione | Descrizione | Default |
|---|---|---|
| Indirizzo di Ollama | URL del server Ollama | `http://localhost:11434` |
| Modello (con visione) | Nome del modello installato | `qwen2.5vl:7b` |
| Test connessione | Verifica che Ollama risponda e che il modello esista | – |
| Istruzioni per il modello | Prompt inviato insieme all'immagine | Trascrizione fedele in Markdown, formule in LaTeX tra `$` |
| Trascrizione automatica | Trascrive dopo una pausa nella scrittura | Attiva |
| Pausa prima della trascrizione | Secondi di inattività (1–10) | 3 |
| Solo penna (rifiuto del palmo) | Il dito scorre la pagina invece di disegnare | Attivo |
| Spessore del tratto | Da 1 a 8 | 3 |
| Svuota la lavagna dopo l'inserimento | Pulisce la lavagna dopo *Inserisci nella nota* | Disattivo |

## Salvataggio dei dati

- I tratti, l'altezza della pagina e l'ultima trascrizione sono salvati in `ink.json` nella cartella del plugin e ripristinati alla riapertura della lavagna.
- Le impostazioni sono salvate in `data.json`.

## Suggerimenti

- Scrivi con tratto chiaro e righe ben separate: migliora molto la qualità della trascrizione.
- Per formule matematiche il modello restituisce LaTeX tra `$`, compatibile con Obsidian.
- Se compare un errore, controlla che Ollama sia attivo, che l'URL sia corretto e che il modello sia installato (usa **Test connessione**).
- Modelli più grandi trascrivono meglio ma sono più lenti: aumenta la pausa automatica se necessario.

## Privacy

Le immagini vengono inviate **solo** all'indirizzo di Ollama che configuri. Con un'istanza locale nulla lascia il tuo computer; usando modelli cloud di Ollama si applicano le condizioni del servizio.

## Modelli e licenze

I modelli di Ollama non sono inclusi nel plugin: ogni modello ha una propria licenza, che va rispettata da chi lo utilizza.

## Licenza

Distribuito con licenza [MIT](LICENSE).

'use strict';

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  requestUrl,
  MarkdownView,
} = require('obsidian');

const PAD_VIEW = 'ollama-handwriting-pad';
const OUT_VIEW = 'ollama-handwriting-output';

const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://localhost:11434',
  model: 'qwen2.5vl:7b',
  prompt:
    "Trascrivi fedelmente il testo scritto a mano presente nell'immagine. " +
    'Mantieni la lingua originale, gli a capo, gli elenchi puntati e le formule (in LaTeX tra $). ' +
    'Rispondi SOLO con il testo trascritto in Markdown, senza commenti, introduzioni o spiegazioni.',
  autoTranscribe: true,
  autoDelaySec: 3,
  penOnly: true,
  penWidth: 3,
  clearAfterInsert: false,
};

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class HandwritingPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.transcript = '';
    this.status = 'idle'; // idle | working | error
    this.statusText = 'Pronto. Scrivi sulla lavagna.';
    this.listeners = new Set();
    this.lastMarkdownView = null;
    this.requestId = 0;

    this.ink = await this.loadInk();
    if (this.ink && typeof this.ink.transcript === 'string') this.transcript = this.ink.transcript;

    this.registerView(PAD_VIEW, (leaf) => new PadView(leaf, this));
    this.registerView(OUT_VIEW, (leaf) => new OutputView(leaf, this));

    this.addRibbonIcon('pencil', 'Scrittura a mano (Ollama)', () => this.openWorkspace());

    this.addCommand({
      id: 'open-workspace',
      name: 'Apri lavagna e colonna di trascrizione',
      callback: () => this.openWorkspace(),
    });
    this.addCommand({
      id: 'transcribe-now',
      name: 'Trascrivi ora',
      callback: () => this.transcribeNow(),
    });
    this.addCommand({
      id: 'insert-transcript',
      name: 'Inserisci la trascrizione nella nota attiva',
      callback: () => this.insertIntoNote(),
    });

    this.addSettingTab(new HandwritingSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
      })
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---- salvataggio dei tratti ---- */

  inkPath() {
    return this.manifest.dir + '/ink.json';
  }

  async loadInk() {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.inkPath()))) return null;
      const data = JSON.parse(await adapter.read(this.inkPath()));
      if (data && Array.isArray(data.strokes)) {
        data.strokes = data.strokes.map((s) => ({
          w: s.w,
          pts: s.pts.map((q) => ({ x: q[0], y: q[1], p: q[2] })),
        }));
      }
      return data;
    } catch (e) {
      console.error('Handwriting: impossibile leggere ink.json', e);
      return null;
    }
  }

  async saveInk(strokes, pageHeight) {
    const r = (n) => Math.round(n * 10) / 10;
    const data = {
      version: 1,
      pageHeight,
      transcript: this.transcript || '',
      strokes: strokes.map((s) => ({
        w: s.w,
        pts: s.pts.map((q) => [r(q.x), r(q.y), r(q.p)]),
      })),
    };
    try {
      await this.app.vault.adapter.write(this.inkPath(), JSON.stringify(data));
    } catch (e) {
      console.error('Handwriting: impossibile salvare ink.json', e);
    }
  }

  /* ---- stato condiviso ---- */

  notify() {
    this.listeners.forEach((fn) => fn());
  }

  setStatus(status, text) {
    this.status = status;
    this.statusText = text;
    this.notify();
  }

  /* ---- layout ---- */

  async openWorkspace() {
    const ws = this.app.workspace;
    const activeMd = ws.getActiveViewOfType(MarkdownView);
    if (activeMd) this.lastMarkdownView = activeMd;

    let pad = ws.getLeavesOfType(PAD_VIEW)[0];
    if (!pad) {
      pad = ws.getLeaf('split', 'vertical');
      await pad.setViewState({ type: PAD_VIEW, active: true });
    }

    let out = ws.getLeavesOfType(OUT_VIEW)[0];
    if (!out) {
      out = ws.getRightLeaf(false);
      if (out) await out.setViewState({ type: OUT_VIEW, active: true });
    }

    if (out) ws.revealLeaf(out);
    ws.revealLeaf(pad);
  }

  getPad() {
    const leaf = this.app.workspace.getLeavesOfType(PAD_VIEW)[0];
    return leaf ? leaf.view : null;
  }

  transcribeNow() {
    const pad = this.getPad();
    if (!pad) {
      new Notice('Apri prima la lavagna (icona a forma di matita).');
      return;
    }
    pad.transcribe();
  }

  /* ---- Ollama ---- */

  async requestTranscription(b64) {
    const id = ++this.requestId;
    const base = this.settings.ollamaUrl.replace(/\/+$/, '');
    this.setStatus('working', 'Trascrizione in corso…');

    try {
      const res = await requestUrl({
        url: base + '/api/chat',
        method: 'POST',
        contentType: 'application/json',
        throw: false,
        body: JSON.stringify({
          model: this.settings.model,
          stream: false,
          messages: [{ role: 'user', content: this.settings.prompt, images: [b64] }],
          options: { temperature: 0 },
        }),
      });

      if (id !== this.requestId) return; // risposta superata da una richiesta più recente

      if (res.status >= 400) {
        let msg = 'HTTP ' + res.status;
        try {
          if (res.json && res.json.error) msg += ': ' + res.json.error;
        } catch (e) {}
        throw new Error(msg);
      }

      const raw = (res.json && res.json.message && res.json.message.content) || '';
      this.transcript = cleanModelOutput(raw);
      this.setStatus('idle', 'Trascrizione aggiornata (' + new Date().toLocaleTimeString() + ').');
      const pad = this.getPad();
      if (pad) pad.persist();
    } catch (err) {
      if (id !== this.requestId) return;
      this.setStatus(
        'error',
        'Errore: ' + (err && err.message ? err.message : err) +
          ' — Ollama è in esecuzione e il modello è installato?'
      );
    }
  }

  /* ---- inserimento nella nota ---- */

  insertIntoNote() {
    const text = (this.transcript || '').trim();
    if (!text) {
      new Notice('Non c\'è ancora nessuna trascrizione.');
      return;
    }
    const view = this.lastMarkdownView;
    const stillOpen =
      view && this.app.workspace.getLeavesOfType('markdown').some((l) => l.view === view);
    if (!stillOpen || !view.editor) {
      new Notice('Apri una nota (e clicca al suo interno) prima di inserire il testo.');
      return;
    }
    view.editor.replaceSelection(text + '\n');
    new Notice('Testo inserito nella nota.');
    if (this.settings.clearAfterInsert) {
      const pad = this.getPad();
      if (pad) pad.clear();
      this.transcript = '';
      this.notify();
    }
  }
}

function cleanModelOutput(text) {
  let t = (text || '').trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  return t;
}

/* ------------------------------------------------------------------ */
/* Lavagna (penna)                                                     */
/* ------------------------------------------------------------------ */

class PadView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.strokes = [];
    this.history = [];
    this.current = null;
    this.eraser = false;
    this.erasing = false;
    this.eraseSaved = false;
    this.pan = null;
    this.timer = null;
    this.pageHeight = 1600;
    this.cssW = 600;
  }

  getViewType() {
    return PAD_VIEW;
  }
  getDisplayText() {
    return 'Lavagna a mano';
  }
  getIcon() {
    return 'pencil';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('ohw-pad');

    const bar = root.createDiv({ cls: 'ohw-toolbar' });
    this.penBtn = bar.createEl('button', { text: 'Penna' });
    this.eraserBtn = bar.createEl('button', { text: 'Gomma' });
    const undoBtn = bar.createEl('button', { text: 'Annulla' });
    const clearBtn = bar.createEl('button', { text: 'Svuota' });
    const pageBtn = bar.createEl('button', { text: '+ Pagina' });
    this.autoBtn = bar.createEl('button', { text: '' });
    const goBtn = bar.createEl('button', { text: 'Trascrivi' });
    goBtn.addClass('mod-cta');

    this.penBtn.onclick = () => this.setEraser(false);
    this.eraserBtn.onclick = () => this.setEraser(true);
    undoBtn.onclick = () => this.undo();
    clearBtn.onclick = () => this.clear();
    pageBtn.onclick = () => {
      this.pageHeight += 800;
      this.layout();
    };
    this.autoBtn.onclick = async () => {
      this.plugin.settings.autoTranscribe = !this.plugin.settings.autoTranscribe;
      await this.plugin.saveSettings();
      this.refreshToolbar();
    };
    goBtn.onclick = () => this.transcribe();

    this.scroller = root.createDiv({ cls: 'ohw-scroller' });
    this.canvas = this.scroller.createEl('canvas', { cls: 'ohw-canvas' });
    this.ctx = this.canvas.getContext('2d');

    this.registerDomEvent(this.canvas, 'pointerdown', (e) => this.onDown(e));
    this.registerDomEvent(this.canvas, 'pointermove', (e) => this.onMove(e));
    this.registerDomEvent(this.canvas, 'pointerup', (e) => this.onUp(e));
    this.registerDomEvent(this.canvas, 'pointercancel', (e) => this.onUp(e));
    // niente menu contestuale con la pressione lunga della penna
    this.registerDomEvent(this.canvas, 'contextmenu', (e) => e.preventDefault());

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.scroller);
    this.register(() => this.resizeObs.disconnect());

    // ripristina i tratti salvati
    const ink = this.plugin.ink;
    if (ink && Array.isArray(ink.strokes)) {
      this.strokes = ink.strokes;
      if (ink.pageHeight) this.pageHeight = ink.pageHeight;
    }

    this.refreshToolbar();
    this.layout();
  }

  async onClose() {
    clearTimeout(this.timer);
    clearTimeout(this.saveTimer);
    await this.plugin.saveInk(this.strokes, this.pageHeight);
    this.plugin.ink = { strokes: this.strokes, pageHeight: this.pageHeight };
  }

  // salvataggio ritardato (debounce) di tratti e trascrizione
  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.plugin.ink = { strokes: this.strokes, pageHeight: this.pageHeight };
      this.plugin.saveInk(this.strokes, this.pageHeight);
    }, 800);
  }

  refreshToolbar() {
    this.penBtn.toggleClass('is-active', !this.eraser);
    this.eraserBtn.toggleClass('is-active', this.eraser);
    this.autoBtn.setText('Auto: ' + (this.plugin.settings.autoTranscribe ? 'sì' : 'no'));
  }

  setEraser(on) {
    this.eraser = on;
    this.refreshToolbar();
  }

  /* ---- disegno ---- */

  layout() {
    if (!this.canvas) return;
    const w = Math.max(200, this.scroller.clientWidth);
    const h = Math.max(this.pageHeight, this.scroller.clientHeight);
    this.cssW = w;
    this.cssH = h;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  inkColor() {
    const c = getComputedStyle(this.contentEl).getPropertyValue('--text-normal').trim();
    return c || '#000';
  }

  segWidth(base, p) {
    return base * (0.4 + 1.2 * p);
  }

  drawSeg(ctx, a, b, base, color, scale) {
    ctx.beginPath();
    ctx.moveTo(a.x * scale, a.y * scale);
    ctx.lineTo(b.x * scale, b.y * scale);
    ctx.lineWidth = this.segWidth(base, (a.p + b.p) / 2) * scale;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  drawStroke(ctx, s, color, scale, ox, oy) {
    const pts = ox || oy ? s.pts.map((q) => ({ x: q.x - ox, y: q.y - oy, p: q.p })) : s.pts;
    if (pts.length === 1) this.drawSeg(ctx, pts[0], pts[0], s.w, color, scale);
    for (let i = 1; i < pts.length; i++) this.drawSeg(ctx, pts[i - 1], pts[i], s.w, color, scale);
  }

  redraw() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.cssW, this.cssH);
    const color = this.inkColor();
    for (const s of this.strokes) this.drawStroke(this.ctx, s, color, 1, 0, 0);
    if (this.current) this.drawStroke(this.ctx, this.current, color, 1, 0, 0);
  }

  /* ---- input penna / tocco ---- */

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      p: e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5,
    };
  }

  pushHistory() {
    this.history.push(this.strokes.slice());
    if (this.history.length > 100) this.history.shift();
  }

  onDown(e) {
    // palm rejection: il dito scorre la pagina, non disegna
    if (e.pointerType === 'touch' && this.plugin.settings.penOnly) {
      this.pan = { id: e.pointerId, y: e.clientY, top: this.scroller.scrollTop };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    clearTimeout(this.timer);

    const p = this.pos(e);
    const penEraserEnd = e.pointerType === 'pen' && (e.buttons & 32 || e.button === 5);

    if (this.eraser || penEraserEnd) {
      this.erasing = true;
      this.eraseSaved = false;
      this.eraseAt(p);
      return;
    }

    this.pushHistory();
    this.current = { w: this.plugin.settings.penWidth, pts: [p] };
    this.redraw();
  }

  onMove(e) {
    if (this.pan && e.pointerId === this.pan.id) {
      this.scroller.scrollTop = this.pan.top - (e.clientY - this.pan.y);
      return;
    }
    if (this.erasing) {
      this.eraseAt(this.pos(e));
      return;
    }
    if (!this.current) return;

    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const color = this.inkColor();
    for (const ev of events.length ? events : [e]) {
      const p = this.pos(ev);
      const last = this.current.pts[this.current.pts.length - 1];
      this.current.pts.push(p);
      this.drawSeg(this.ctx, last, p, this.current.w, color, 1);
    }

    // pagina quasi finita: estendila
    const lastPt = this.current.pts[this.current.pts.length - 1];
    if (lastPt.y > this.cssH - 150) {
      this.pageHeight = this.cssH + 600;
      this.layout();
    }
  }

  onUp(e) {
    if (this.pan && e.pointerId === this.pan.id) {
      this.pan = null;
      return;
    }
    if (this.erasing) {
      this.erasing = false;
      this.persist();
      this.schedule();
      return;
    }
    if (this.current) {
      this.strokes.push(this.current);
      this.current = null;
      this.persist();
      this.schedule();
    }
  }

  eraseAt(p) {
    const r = 14;
    const kept = this.strokes.filter(
      (s) => !s.pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r)
    );
    if (kept.length !== this.strokes.length) {
      if (!this.eraseSaved) {
        this.pushHistory();
        this.eraseSaved = true;
      }
      this.strokes = kept;
      this.redraw();
    }
  }

  undo() {
    const prev = this.history.pop();
    if (prev) {
      this.strokes = prev;
      this.redraw();
      this.persist();
      this.schedule();
    }
  }

  clear() {
    if (this.strokes.length) this.pushHistory();
    this.strokes = [];
    this.redraw();
    this.persist();
  }

  /* ---- trascrizione ---- */

  schedule() {
    clearTimeout(this.timer);
    if (!this.plugin.settings.autoTranscribe) return;
    this.timer = setTimeout(
      () => this.transcribe(),
      Math.max(500, this.plugin.settings.autoDelaySec * 1000)
    );
  }

  transcribe() {
    clearTimeout(this.timer);
    if (!this.strokes.length) {
      this.plugin.setStatus('idle', 'La lavagna è vuota.');
      return;
    }
    this.plugin.requestTranscription(this.exportBase64());
  }

  // PNG nero su bianco, ritagliato sull'area scritta e ridimensionato
  exportBase64() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) {
      for (const q of s.pts) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x);
        maxY = Math.max(maxY, q.y);
      }
    }
    const pad = 28;
    const ox = Math.max(0, minX - pad);
    const oy = Math.max(0, minY - pad);
    const w = maxX - ox + pad;
    const h = maxY - oy + pad;
    const scale = Math.min(1.5, 1800 / Math.max(w, h));

    const c = document.createElement('canvas');
    c.width = Math.max(64, Math.round(w * scale));
    c.height = Math.max(64, Math.round(h * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    for (const s of this.strokes) this.drawStroke(ctx, s, '#000000', scale, ox, oy);
    return c.toDataURL('image/png').split(',')[1];
  }
}

/* ------------------------------------------------------------------ */
/* Colonna destra: testo trascritto                                    */
/* ------------------------------------------------------------------ */

class OutputView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return OUT_VIEW;
  }
  getDisplayText() {
    return 'Trascrizione';
  }
  getIcon() {
    return 'text';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('ohw-output');

    this.statusEl = root.createDiv({ cls: 'ohw-status' });
    this.textEl = root.createEl('textarea', { cls: 'ohw-text' });
    this.textEl.placeholder = 'Qui comparirà il testo trascritto…';
    this.textEl.addEventListener('input', () => {
      this.plugin.transcript = this.textEl.value; // modifiche manuali
    });

    const actions = root.createDiv({ cls: 'ohw-actions' });
    const redo = actions.createEl('button', { text: 'Trascrivi di nuovo' });
    const insert = actions.createEl('button', { text: 'Inserisci nella nota' });
    insert.addClass('mod-cta');
    const copy = actions.createEl('button', { text: 'Copia' });

    redo.onclick = () => this.plugin.transcribeNow();
    insert.onclick = () => this.plugin.insertIntoNote();
    copy.onclick = async () => {
      await navigator.clipboard.writeText(this.plugin.transcript || '');
      new Notice('Copiato negli appunti.');
    };

    this.listener = () => this.refresh();
    this.plugin.listeners.add(this.listener);
    this.refresh();
  }

  async onClose() {
    this.plugin.listeners.delete(this.listener);
  }

  refresh() {
    this.statusEl.setText(this.plugin.statusText);
    this.statusEl.removeClass('is-working', 'is-error');
    if (this.plugin.status === 'working') this.statusEl.addClass('is-working');
    if (this.plugin.status === 'error') this.statusEl.addClass('is-error');
    if (document.activeElement !== this.textEl) this.textEl.value = this.plugin.transcript || '';
    else if (this.plugin.status === 'idle') this.textEl.value = this.plugin.transcript || '';
  }
}

/* ------------------------------------------------------------------ */
/* Impostazioni                                                        */
/* ------------------------------------------------------------------ */

class HandwritingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName('Indirizzo di Ollama')
      .setDesc('Di solito http://localhost:11434 (o l\'IP di un altro PC in rete).')
      .addText((t) =>
        t.setValue(s.ollamaUrl).onChange(async (v) => {
          s.ollamaUrl = v.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Modello (con visione)')
      .setDesc('Esempi: qwen2.5vl:7b, minicpm-v, llama3.2-vision, gemma3:4b. Installalo prima con "ollama pull <modello>".')
      .addText((t) =>
        t.setValue(s.model).onChange(async (v) => {
          s.model = v.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Test connessione')
      .setDesc('Controlla che Ollama risponda e che il modello sia installato.')
      .addButton((b) =>
        b.setButtonText('Verifica').onClick(async () => {
          try {
            const base = s.ollamaUrl.replace(/\/+$/, '');
            const r = await requestUrl({ url: base + '/api/tags' });
            const names = (r.json.models || []).map((m) => m.name);
            const found = names.some((n) => n === s.model || n.split(':')[0] === s.model);
            new Notice(
              found
                ? 'Connessione OK, modello trovato.'
                : 'Ollama risponde, ma il modello non è installato. Disponibili: ' + (names.join(', ') || 'nessuno'),
              8000
            );
          } catch (e) {
            new Notice('Impossibile contattare Ollama: ' + (e && e.message ? e.message : e), 8000);
          }
        })
      );

    new Setting(containerEl)
      .setName('Istruzioni per il modello')
      .addTextArea((t) => {
        t.setValue(s.prompt).onChange(async (v) => {
          s.prompt = v;
          await save();
        });
        t.inputEl.rows = 5;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Trascrizione automatica')
      .setDesc('Trascrive da sola dopo una pausa nella scrittura.')
      .addToggle((t) =>
        t.setValue(s.autoTranscribe).onChange(async (v) => {
          s.autoTranscribe = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Pausa prima della trascrizione (secondi)')
      .addSlider((sl) =>
        sl
          .setLimits(1, 10, 1)
          .setValue(s.autoDelaySec)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.autoDelaySec = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName('Solo penna (rifiuto del palmo)')
      .setDesc('Il dito fa scorrere la pagina invece di disegnare.')
      .addToggle((t) =>
        t.setValue(s.penOnly).onChange(async (v) => {
          s.penOnly = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Spessore del tratto')
      .addSlider((sl) =>
        sl
          .setLimits(1, 8, 1)
          .setValue(s.penWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.penWidth = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName('Svuota la lavagna dopo l\'inserimento nella nota')
      .addToggle((t) =>
        t.setValue(s.clearAfterInsert).onChange(async (v) => {
          s.clearAfterInsert = v;
          await save();
        })
      );
  }
}

module.exports = HandwritingPlugin;

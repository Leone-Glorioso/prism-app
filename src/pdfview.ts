// PDF viewer on pdf.js: continuous pages rendered only near the viewport, selectable text, clickable links
// (table of contents, citations, URLs), SyncTeX jumps in both directions, scroll kept across rebuilds.

import * as pdfjs from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { Rect } from './synctex';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfPoint { page: number; x: number; y: number } // page 1-based; x, y in bp from the page's top-left
export type JumpMode = 'double' | 'ctrl' | 'off';

interface PageSlot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  layers: HTMLElement[];
  task: RenderTask | null;
  text: InstanceType<typeof pdfjs.TextLayer> | null;
  token: number;
  width: number; // bp at scale 1
  height: number;
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export class PdfView {
  private doc: PDFDocumentProxy | null = null;
  private pages: PageSlot[] = [];
  private zoom = 0; // 0 = fit width
  private observer: IntersectionObserver;
  private generation = 0;
  private hit: { page: number; rects: Rect[]; timer: number } | null = null;
  /** "N pages · zoom%", or '' without a document. */
  pageInfo = '';
  jumpMode: JumpMode = 'double';
  onChange: () => void = () => {};
  /** Called for a double click (or Ctrl+click) on a page. */
  onJump: (p: PdfPoint) => void = () => {};

  constructor(private scroller: HTMLElement) {
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const slot = this.pages[Number((e.target as HTMLElement).dataset.page)];
        if (!slot) continue;
        if (e.isIntersecting) void this.render(slot);
        else this.release(slot);
      }
    }, { root: scroller, rootMargin: '150% 0px' });
    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { if (this.zoom === 0) this.layout(); }, 150);
    }).observe(scroller);
    scroller.addEventListener('dblclick', (e) => { if (this.jumpMode === 'double') this.jumpFrom(e); });
    scroller.addEventListener('click', (e) => { if (this.jumpMode === 'ctrl' && (e.ctrlKey || e.metaKey)) this.jumpFrom(e); });
  }

  get hasDocument() {
    return this.doc !== null;
  }

  /** CSS pixels per bp. */
  scale(): number {
    if (this.zoom) return this.zoom;
    const widest = Math.max(1, ...this.pages.map((p) => p.width));
    return Math.max(0.1, (this.scroller.clientWidth - 24) / widest);
  }

  async show(data: Uint8Array): Promise<void> {
    const gen = ++this.generation;
    const fraction = this.scroller.scrollHeight > 0 ? this.scroller.scrollTop / this.scroller.scrollHeight : 0;
    // pdf.js transfers the buffer to its worker, so pass a copy.
    const doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false }).promise;
    if (gen !== this.generation) { void doc.destroy(); return; }
    const sizes: { width: number; height: number }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ width: vp.width, height: vp.height });
      if (gen !== this.generation) { void doc.destroy(); return; }
    }
    this.clear();
    this.doc = doc;
    this.pages = sizes.map((s, i) => {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(i);
      el.setAttribute('aria-label', `Page ${i + 1} of ${sizes.length}`);
      this.scroller.append(el);
      return { el, canvas: null, layers: [], task: null, text: null, token: 0, ...s };
    });
    this.layout();
    this.scroller.scrollTop = fraction * this.scroller.scrollHeight;
    for (const p of this.pages) this.observer.observe(p.el);
  }

  clear() {
    this.generation++;
    this.observer.disconnect();
    for (const p of this.pages) this.release(p);
    this.pages = [];
    this.scroller.replaceChildren();
    void this.doc?.destroy();
    this.doc = null;
    this.hit = null;
    this.pageInfo = '';
    this.onChange();
  }

  setZoom(z: 'in' | 'out' | 'fit') {
    if (!this.doc) return;
    const current = this.scale();
    this.zoom = z === 'fit' ? 0 : Math.min(5, Math.max(0.25, z === 'in' ? current * 1.2 : current / 1.2));
    const fraction = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight);
    this.layout();
    this.scroller.scrollTop = fraction * this.scroller.scrollHeight;
  }

  /** Scrolls so that (page, y) is near the top; optionally flashes rectangles (SyncTeX forward search). */
  reveal(page: number, y: number, rects: Rect[] = []) {
    const slot = this.pages[page - 1];
    if (!slot) return;
    const s = this.scale();
    const focus = rects.length ? rects[0].y + rects[0].h / 2 : y;
    this.scroller.scrollTo({ top: Math.max(0, slot.el.offsetTop + focus * s - this.scroller.clientHeight / 3), behavior: 'smooth' });
    if (rects.length) this.flash(page, rects);
  }

  private flash(page: number, rects: Rect[]) {
    if (this.hit) clearTimeout(this.hit.timer);
    this.hit = { page, rects, timer: window.setTimeout(() => { this.hit = null; this.drawHit(); }, 2600) };
    this.drawHit();
  }

  private drawHit() {
    for (const el of this.scroller.querySelectorAll('.sync-hit')) el.remove();
    if (!this.hit) return;
    const slot = this.pages[this.hit.page - 1];
    if (!slot) return;
    const s = this.scale();
    for (const r of this.hit.rects) {
      const d = document.createElement('div');
      d.className = 'sync-hit';
      d.style.cssText = `left:${r.x * s - 2}px;top:${r.y * s - 2}px;width:${r.w * s + 4}px;height:${r.h * s + 4}px`;
      slot.el.append(d);
    }
  }

  private jumpFrom(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('a')) return; // links navigate instead
    const pageEl = target.closest<HTMLElement>('.pdf-page');
    if (!pageEl) return;
    const box = pageEl.getBoundingClientRect();
    const s = this.scale();
    window.getSelection()?.removeAllRanges(); // a double click also selects a word
    this.onJump({ page: Number(pageEl.dataset.page) + 1, x: (e.clientX - box.left) / s, y: (e.clientY - box.top) / s });
  }

  private layout() {
    const s = this.scale();
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.width * s)}px`;
      p.el.style.height = `${Math.floor(p.height * s)}px`;
      p.el.style.setProperty('--scale-factor', String(s));
      this.release(p);
    }
    // Re-render what is visible at the new size.
    for (const p of this.pages) { this.observer.unobserve(p.el); this.observer.observe(p.el); }
    const n = this.pages.length;
    this.pageInfo = n ? `${n} ${n === 1 ? 'page' : 'pages'} · ${Math.round(s * 100)}%` : '';
    this.drawHit();
    this.onChange();
  }

  private release(p: PageSlot) {
    p.token++;
    p.task?.cancel();
    p.task = null;
    p.text?.cancel();
    p.text = null;
    for (const l of p.layers) l.remove();
    p.layers = [];
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0; // frees the bitmap memory immediately
      p.canvas = null;
    }
  }

  private async render(p: PageSlot) {
    if (!this.doc || p.canvas) return;
    const gen = this.generation;
    const token = ++p.token;
    const alive = () => gen === this.generation && token === p.token;
    const page = await this.doc.getPage(Number(p.el.dataset.page) + 1);
    if (!alive()) return;
    const s = this.scale();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: s * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    p.canvas = canvas;
    p.layers.push(canvas);
    p.el.prepend(canvas);
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp });
    p.task = task;
    try {
      await task.promise;
    } catch (e) {
      if ((e as Error).name !== 'RenderingCancelledException') console.error(e);
      return;
    } finally {
      if (p.task === task) p.task = null;
    }
    if (!alive()) return;

    // Selectable text.
    const cssVp = page.getViewport({ scale: s });
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    p.layers.push(textDiv);
    p.el.append(textDiv);
    p.text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: cssVp });
    p.text.render().catch(() => { /* cancelled by release() */ });

    // Links (table of contents, cross references, citations, URLs).
    try {
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (!alive()) return;
      const linkDiv = document.createElement('div');
      linkDiv.className = 'linkLayer';
      p.layers.push(linkDiv);
      for (const a of annotations as { subtype: string; rect: number[]; url?: string; dest?: unknown }[]) {
        if (a.subtype !== 'Link' || !a.rect) continue;
        const [x1, y1, x2, y2] = cssVp.convertToViewportRectangle(a.rect);
        const link = document.createElement('a');
        link.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px`;
        if (a.url) {
          let url: URL | null = null;
          try { url = new URL(a.url); } catch { /* not a URL */ }
          if (!url || !SAFE_PROTOCOLS.has(url.protocol)) continue; // never javascript:, data:, file: …
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.title = url.href;
        } else if (a.dest) {
          const dest = a.dest;
          link.href = '#';
          link.addEventListener('click', (ev) => { ev.preventDefault(); void this.goToDest(dest); });
        } else continue;
        linkDiv.append(link);
      }
      p.el.append(linkDiv);
    } catch { /* annotations are optional */ }
  }

  /** Follows an internal PDF destination (named or explicit). */
  private async goToDest(dest: unknown) {
    if (!this.doc) return;
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const index = typeof ref === 'object' && ref !== null ? await this.doc.getPageIndex(ref as { num: number; gen: number }) : Number(ref);
      const kind = (explicit[1] as { name?: string } | null)?.name;
      const top = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
      const slot = this.pages[index];
      if (!slot) return;
      const y = typeof top === 'number' ? slot.height - top : 0;
      this.scroller.scrollTo({ top: Math.max(0, slot.el.offsetTop + y * this.scale() - 16), behavior: 'smooth' });
    } catch (e) {
      console.error('PDF link failed', e);
    }
  }
}

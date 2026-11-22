// PDF viewer on pdf.js: continuous pages, rendered only near the viewport, scroll kept across rebuilds.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PageSlot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  task: RenderTask | null;
  width: number; // PDF points at scale 1
  height: number;
}

export class PdfView {
  private doc: PDFDocumentProxy | null = null;
  private pages: PageSlot[] = [];
  private zoom = 0; // 0 = fit width
  private observer: IntersectionObserver;
  private generation = 0;
  /** "N pages · zoom%", or '' without a document. */
  pageInfo = '';
  onChange: () => void = () => {};

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
  }

  get hasDocument() {
    return this.doc !== null;
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
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', `Page ${i + 1} of ${sizes.length}`);
      this.scroller.append(el);
      return { el, canvas: null, task: null, ...s };
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

  private scale(): number {
    if (this.zoom) return this.zoom;
    const widest = Math.max(1, ...this.pages.map((p) => p.width));
    return Math.max(0.1, (this.scroller.clientWidth - 24) / widest);
  }

  private layout() {
    const s = this.scale();
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.width * s)}px`;
      p.el.style.height = `${Math.floor(p.height * s)}px`;
      this.release(p);
    }
    // Re-render what is visible at the new size.
    for (const p of this.pages) { this.observer.unobserve(p.el); this.observer.observe(p.el); }
    const n = this.pages.length;
    this.pageInfo = n ? `${n} ${n === 1 ? 'page' : 'pages'} · ${Math.round(s * 100)}%` : '';
    this.onChange();
  }

  private release(p: PageSlot) {
    p.task?.cancel();
    p.task = null;
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0; // frees the bitmap memory immediately
      p.canvas.remove();
      p.canvas = null;
    }
  }

  private async render(p: PageSlot) {
    if (!this.doc || p.canvas) return;
    const gen = this.generation;
    const index = Number(p.el.dataset.page);
    const page = await this.doc.getPage(index + 1);
    if (gen !== this.generation || p.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: this.scale() * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    p.canvas = canvas;
    p.el.append(canvas);
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp });
    p.task = task;
    try {
      await task.promise;
    } catch (e) {
      if ((e as Error).name !== 'RenderingCancelledException') console.error(e);
    } finally {
      if (p.task === task) p.task = null;
    }
  }
}

import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, NgZone,
  OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, inject
} from '@angular/core';
import { NgIf } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { DocumentAccess, DocumentInfo, DocumentMode, DocumentsService } from '../documents';

type EditorState = 'loading' | 'ready' | 'error';

/** Messages between this component and public/contract-editor/index.html (same origin only). */
type EditorMessage =
  | { type: 'ce:ready' }
  | { type: 'ce:loaded' }
  | { type: 'ce:dirty'; dirty: boolean }
  | { type: 'ce:save'; bytes: ArrayBuffer; name: string }
  | { type: 'ce:error'; message: string };

/** Platform mode → the editor page's own mode/role. */
const EDITOR_MODE: Record<DocumentMode, { mode: string; role?: string }> = {
  edit: { mode: 'full' },
  comment: { mode: 'comment' },
  suggest: { mode: 'review', role: 'initiator' },
  approve: { mode: 'review', role: 'approver' },
  view: { mode: 'view' }
};

/**
 * The built-in ContractsEditor for one .docx: no editor server, no licence. The editor runs in a same-origin
 * iframe (its global styles and scripts stay isolated from the app); this component loads the bytes through
 * the API, hands them to the editor, and saves what it sends back as a new version.
 *
 *   <azm-contract-editor [fileId]="id" mode="suggest" (saved)="…"></azm-contract-editor>
 *
 * Give the component a height (it fills its container).
 */
@Component({
  selector: 'azm-contract-editor',
  standalone: true,
  imports: [NgIf],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ce-shell">
      <div class="ce-overlay" *ngIf="state !== 'ready'" role="status" aria-live="polite">
        <ng-container *ngIf="state === 'loading'">
          <span class="ce-spinner" aria-hidden="true"></span>
          <span>Opening {{ access?.name || 'document' }}…</span>
        </ng-container>
        <ng-container *ngIf="state === 'error'">
          <strong>The document could not be opened.</strong>
          <span class="ce-detail">{{ error }}</span>
          <button type="button" (click)="open()">Try again</button>
        </ng-container>
      </div>
      <iframe #frame *ngIf="src" [src]="src" [attr.title]="(access?.name || 'Document') + ' — ' + (access?.mode || 'editor')"
              allow="clipboard-read; clipboard-write"></iframe>
    </div>
  `,
  styles: [`
    /* No min-height: on a phone in landscape (≈340px tall) it would push the page into scrolling. */
    :host { display: block; position: relative; height: 100%; }
    .ce-shell { position: absolute; inset: 0; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #f2f4f1; }
    .ce-overlay { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
      background: var(--ce-overlay-bg, #f2f4f1); color: var(--ce-overlay-fg, #1c2321); font: 14px/1.4 system-ui, sans-serif; text-align: center; padding: 16px; }
    .ce-detail { color: var(--ce-muted, #5b6662); max-width: 520px; }
    .ce-overlay button { border: 1px solid currentColor; background: transparent; color: inherit; border-radius: 6px; padding: 6px 14px; cursor: pointer; font: inherit; }
    .ce-spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(14,106,91,.2); border-top-color: var(--ce-accent, #0e6a5b); animation: ce-spin .8s linear infinite; }
    @keyframes ce-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .ce-spinner { animation: none; } }
  `]
})
export class ContractEditorComponent implements OnChanges, OnDestroy {
  /** Document id as known to the API (IWopiFileStore on the server). */
  @Input() fileId = '';
  /** Requested mode; leave unset to get the richest mode the user's rights allow. The server refuses modes the user may not use. */
  @Input() mode?: DocumentMode;

  /** The document finished loading. */
  @Output() readonly loaded = new EventEmitter<DocumentAccess>();
  /** A save stored a new version. */
  @Output() readonly saved = new EventEmitter<DocumentInfo>();
  /** Opening failed (message for display or logging). */
  @Output() readonly failed = new EventEmitter<string>();
  /** Whether there are changes that have not been saved. */
  @Output() readonly dirtyChange = new EventEmitter<boolean>();

  @ViewChild('frame') private frame?: ElementRef<HTMLIFrameElement>;

  state: EditorState = 'loading';
  error = '';
  access: DocumentAccess | null = null;
  src: SafeResourceUrl | null = null;
  dirty = false;

  private readonly api = inject(DocumentsService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);
  private subs = new Subscription();
  private readonly onMessage = (e: MessageEvent) => this.handle(e);

  constructor() {
    this.zone.runOutsideAngular(() => window.addEventListener('message', this.onMessage));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId'] || changes['mode']) this.open();
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onMessage);
    this.subs.unsubscribe();
  }

  /** Warn before leaving the page with unsaved changes. */
  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(e: BeforeUnloadEvent): void {
    if (this.dirty) e.preventDefault();
  }

  open(): void {
    if (!this.fileId) return;
    this.subs.unsubscribe(); this.subs = new Subscription();
    this.state = 'loading'; this.error = ''; this.src = null; this.setDirty(false);
    this.cdr.markForCheck();
    this.subs.add(this.api.access(this.fileId, this.mode).subscribe({
      next: a => {
        if (!/\.docx$/i.test(a.name)) return this.fail('This editor opens Word (.docx) documents only. Download the file to open it.');
        this.access = a;
        const m = EDITOR_MODE[a.mode] ?? EDITOR_MODE.view;
        const q = new URLSearchParams({ host: '1', mode: m.mode, name: a.name });
        if (m.role) q.set('role', m.role);
        // Fixed same-origin path; only the query string varies.
        this.src = this.sanitizer.bypassSecurityTrustResourceUrl(`contract-editor/index.html?${q}`);
        this.cdr.markForCheck();
      },
      error: (e: HttpErrorResponse) => this.fail(problem(e, 'The server refused to open the document.'))
    }));
  }

  private handle(e: MessageEvent): void {
    const win = this.frame?.nativeElement.contentWindow;
    if (!win || e.source !== win || e.origin !== location.origin || !e.data?.type) return;
    const m = e.data as EditorMessage;
    this.zone.run(() => {
      switch (m.type) {
        case 'ce:ready': return this.sendContent(win);
        case 'ce:loaded': this.state = 'ready'; this.cdr.markForCheck(); this.loaded.emit(this.access!); return;
        case 'ce:dirty': return this.setDirty(m.dirty);
        case 'ce:save': return this.save(win, m.bytes);
        case 'ce:error': return this.fail(m.message);
      }
    });
  }

  private sendContent(win: Window): void {
    const a = this.access;
    if (!a) return;
    this.subs.add(this.api.content(a.id).subscribe({
      next: bytes => win.postMessage({ type: 'ce:load', bytes, name: a.name, author: a.userName }, location.origin, [bytes]),
      error: (e: HttpErrorResponse) => this.fail(problem(e, 'The document could not be downloaded.'))
    }));
  }

  private save(win: Window, bytes: ArrayBuffer): void {
    const a = this.access;
    if (!a) return;
    const reply = (ok: boolean, message: string) => win.postMessage({ type: 'ce:saved', ok, message }, location.origin);
    this.subs.add(this.api.save(a.id, bytes, a.mode, a.version).subscribe({
      next: d => {
        this.access = { ...a, version: d.version };
        reply(true, `Saved as version ${d.version}.`);
        this.saved.emit(d);
      },
      error: (e: HttpErrorResponse) => reply(false, problem(e, 'Could not save. Check your connection and try again.'))
    }));
  }

  private setDirty(d: boolean): void {
    if (this.dirty === d) return;
    this.dirty = d;
    this.dirtyChange.emit(d);
  }

  private fail(message: string): void {
    this.state = 'error'; this.error = message;
    this.cdr.markForCheck();
    this.failed.emit(message);
  }
}

/** ProblemDetails title + detail, or a fallback. */
function problem(e: HttpErrorResponse, fallback: string): string {
  const p = e?.error && typeof e.error === 'object' && !(e.error instanceof ArrayBuffer) ? e.error : null;
  return p?.title ? (p.detail ? `${p.title}. ${p.detail}` : p.title) : fallback;
}

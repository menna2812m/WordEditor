import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { DatePipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { DocumentsService } from './documents.service';
import { DocumentInfo } from './documents.models';

/**
 * Sample page: /documents — list, upload, create, open, download.
 * Your platform likely lists documents elsewhere; the only part you need is a link to /documents/:id/edit.
 */
@Component({
  selector: 'azm-document-list-page',
  standalone: true,
  imports: [NgFor, NgIf, DatePipe, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="docs">
      <header>
        <h1>Documents</h1>
        <div class="actions">
          <button type="button" class="primary" (click)="createBlank()" [disabled]="busy">New document</button>
          <label class="btn" [class.disabled]="busy">Upload<input type="file" accept=".docx" (change)="upload($event)" [disabled]="busy" hidden></label>
        </div>
      </header>
      <p class="error" *ngIf="error" role="alert">{{ error }}</p>
      <div class="table-wrap" *ngIf="docs.length; else empty">
        <table>
          <thead><tr><th>Name</th><th>Modified</th><th>By</th><th class="num">Version</th><th class="num">Size</th><th></th></tr></thead>
          <tbody>
            <tr *ngFor="let d of docs">
              <td>
                <a *ngIf="isDocx(d); else plainName" [routerLink]="['/documents', d.id, 'edit']">{{ d.name }}</a>
                <ng-template #plainName>{{ d.name }}</ng-template>
              </td>
              <td>{{ d.modified | date: 'medium' }}</td>
              <td>{{ d.modifiedBy }}</td>
              <td class="num">v{{ d.version }}</td>
              <td class="num">{{ d.size / 1024 | number: '1.0-1' }} KB</td>
              <td class="row-actions">
                <ng-container *ngIf="isDocx(d)">
                  <a [routerLink]="['/documents', d.id, 'edit']" [queryParams]="{ mode: 'view' }">View</a>
                  <a [routerLink]="['/documents', d.id, 'edit']" [queryParams]="{ mode: 'comment' }">Comment</a>
                  <a [routerLink]="['/documents', d.id, 'edit']" [queryParams]="{ mode: 'suggest' }">Suggest</a>
                  <a [routerLink]="['/documents', d.id, 'edit']" [queryParams]="{ mode: 'approve' }">Approve</a>
                </ng-container>
                <button type="button" class="link" (click)="download(d)">Download</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ng-template #empty><p class="empty" *ngIf="!loading">No documents yet. Upload a Word (.docx) file or create a new one.</p></ng-template>
    </section>
  `,
  styles: [`
    .docs { max-width: 1000px; margin: 0 auto; padding: 24px 16px; font: 14px/1.45 system-ui, sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 500; margin: 0; }
    .actions { display: flex; gap: 8px; }
    button, .btn { border: 1px solid #d2d8d3; background: #fff; border-radius: 6px; padding: 7px 12px; cursor: pointer; font: inherit; color: inherit; }
    .primary { background: #0e6a5b; border-color: #0e6a5b; color: #fff; }
    .disabled, button[disabled] { opacity: .6; pointer-events: none; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: start; padding: 10px 12px; border-bottom: 1px solid #e3e7e4; }
    th { font-size: 12px; color: #5b6662; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
    .num { font-variant-numeric: tabular-nums; text-align: end; }
    .row-actions { white-space: nowrap; display: flex; gap: 12px; }
    .link { border: 0; background: none; padding: 0; color: #0e6a5b; text-decoration: underline; }
    a { color: #0e6a5b; }
    .error { color: #b3261e; }
    .empty { color: #5b6662; padding: 32px 0; text-align: center; }
  `]
})
export class DocumentListPage implements OnInit {
  private readonly api = inject(DocumentsService);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);
  docs: DocumentInfo[] = [];
  loading = true;
  busy = false;
  error = '';

  ngOnInit(): void { this.refresh(); }

  /** Only Word documents open in the editor; anything older (PDF, Excel…) can still be downloaded. */
  isDocx(d: DocumentInfo): boolean { return /\.docx$/i.test(d.name); }

  refresh(): void {
    this.api.listDocuments().subscribe({
      next: d => { this.docs = d; this.loading = false; this.cdr.markForCheck(); },
      error: () => { this.error = 'Could not load documents.'; this.loading = false; this.cdr.markForCheck(); }
    });
  }

  createBlank(): void {
    this.busy = true;
    this.api.createBlank().subscribe({
      next: d => this.router.navigate(['/documents', d.id, 'edit']),
      error: () => { this.busy = false; this.error = 'Could not create a document.'; this.cdr.markForCheck(); }
    });
  }

  upload(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.busy = true; this.error = '';
    this.api.upload(file).subscribe({
      next: d => this.router.navigate(['/documents', d.id, 'edit']),
      error: e => { this.busy = false; this.error = e?.error?.title || 'Upload failed.'; this.cdr.markForCheck(); }
    });
  }

  download(d: DocumentInfo): void {
    this.api.download(d.id).subscribe(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = d.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
}

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AsyncPipe, NgIf } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { DOCUMENT_MODES, DocumentMode } from '../documents';
import { ContractEditorComponent } from './contract-editor.component';

/** Route page: /documents/:id/edit (?mode=edit|comment|suggest|approve|view). Fills the viewport below your app header. */
@Component({
  selector: 'azm-contract-editor-page',
  standalone: true,
  imports: [AsyncPipe, NgIf, ContractEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *ngIf="params$ | async as p">
      <azm-contract-editor class="editor" [fileId]="p.id" [mode]="p.mode" (dirtyChange)="dirty = $event"></azm-contract-editor>
    </ng-container>
  `,
  styles: [`
    /* 100vh first for Safari < 15.4; dvh tracks the iOS toolbar showing/hiding where supported. */
    :host { display: block; height: calc(100vh - var(--app-header-height, 0px)); height: calc(100dvh - var(--app-header-height, 0px)); }
    .editor { height: 100%; }
  `]
})
export class ContractEditorPage {
  private readonly route = inject(ActivatedRoute);
  dirty = false;

  readonly params$ = this.route.paramMap.pipe(
    map(pm => {
      const m = this.route.snapshot.queryParamMap.get('mode');
      const mode = DOCUMENT_MODES.find(x => x === m);
      return { id: pm.get('id') ?? '', mode: mode as DocumentMode | undefined };
    })
  );
}

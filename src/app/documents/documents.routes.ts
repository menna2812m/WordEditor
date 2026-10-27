import { Routes } from '@angular/router';
import type { ContractEditorPage } from '../contract-editor/contract-editor.page';

/**
 * Add to your routes, behind your auth guard:
 *   { path: 'documents', canActivate: [authGuard], children: DOCUMENT_ROUTES }
 */
export const DOCUMENT_ROUTES: Routes = [
  { path: '', loadComponent: () => import('./document-list.page').then(m => m.DocumentListPage), title: 'Documents' },
  {
    path: ':id/edit',
    loadComponent: () => import('../contract-editor/contract-editor.page').then(m => m.ContractEditorPage),
    canDeactivate: [(page: ContractEditorPage) => !page.dirty || confirm('You have unsaved changes. Leave without saving?')],
    title: 'Document'
  }
];

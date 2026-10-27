import { Routes } from '@angular/router';
import { DOCUMENT_ROUTES } from './documents';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'documents' },
  { path: 'documents', children: DOCUMENT_ROUTES },
];

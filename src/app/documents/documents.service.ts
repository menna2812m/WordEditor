import { HttpClient } from '@angular/common/http';
import { inject, Injectable, InjectionToken, makeEnvironmentProviders, EnvironmentProviders } from '@angular/core';
import { Observable } from 'rxjs';
import { DocumentAccess, DocumentInfo, DocumentMode, DocumentVersion } from './documents.models';

export interface DocumentsConfig {
  /** Base URL of the .NET API, e.g. environment.apiUrl. Empty string = same origin (e.g. behind a dev proxy). */
  apiBase: string;
}

export const DOCUMENTS_CONFIG = new InjectionToken<DocumentsConfig>('DOCUMENTS_CONFIG', { factory: () => ({ apiBase: '' }) });

/** Add to app.config.ts providers: provideDocuments({ apiBase: environment.apiUrl }) */
export function provideDocuments(config: DocumentsConfig): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: DOCUMENTS_CONFIG, useValue: config }]);
}

/**
 * Talks to the sample host's DocumentsController. Requests go through your HttpClient, so your existing
 * auth interceptor attaches the user's JWT as usual. Replace with your platform's own APIs.
 */
@Injectable({ providedIn: 'root' })
export class DocumentsService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(DOCUMENTS_CONFIG).apiBase.replace(/\/$/, '');

  private url(id: string, path = ''): string {
    return `${this.base}/api/documents/${encodeURIComponent(id)}${path}`;
  }

  listDocuments(): Observable<DocumentInfo[]> {
    return this.http.get<DocumentInfo[]>(`${this.base}/api/documents`);
  }

  upload(file: File): Observable<DocumentInfo> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<DocumentInfo>(`${this.base}/api/documents`, form);
  }

  createBlank(name?: string): Observable<DocumentInfo> {
    return this.http.post<DocumentInfo>(`${this.base}/api/documents/new`, null, name ? { params: { name } } : {});
  }

  versions(id: string): Observable<DocumentVersion[]> {
    return this.http.get<DocumentVersion[]>(this.url(id, '/versions'));
  }

  /** Downloads through HttpClient so the auth header is sent, then hands the browser a Blob. */
  download(id: string, version?: number): Observable<Blob> {
    const params: Record<string, string> = version ? { v: String(version) } : {};
    return this.http.get(this.url(id, '/download'), { params, responseType: 'blob' });
  }

  /** The mode the editor may open the document in. Omit mode for the richest the user's rights allow. */
  access(id: string, mode?: DocumentMode): Observable<DocumentAccess> {
    return this.http.get<DocumentAccess>(this.url(id, '/access'), mode ? { params: { mode } } : {});
  }

  content(id: string): Observable<ArrayBuffer> {
    return this.http.get(this.url(id, '/download'), { responseType: 'arraybuffer' });
  }

  /** Saves as a new version. 409 if someone saved after baseVersion; 403 if the edits break the mode's rules. */
  save(id: string, bytes: ArrayBuffer, mode: DocumentMode, baseVersion: number): Observable<DocumentInfo> {
    return this.http.put<DocumentInfo>(this.url(id, '/content'), bytes, {
      params: { mode, baseVersion },
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    });
  }
}

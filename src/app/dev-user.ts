import { HttpInterceptorFn } from '@angular/common/http';

/**
 * POC only: the sample API signs callers in from the X-Dev-User header (Development builds only).
 * Switching the user lets one browser play both the initiator and the approver.
 */
export const DEV_USERS = ['Initiator (Ahmed)', 'Approver (Sara)'] as const;

const STORAGE_KEY = 'poc.devUser';

export function getDevUser(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEV_USERS[0];
  } catch {
    return DEV_USERS[0];
  }
}

export function setDevUser(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* private mode: the default user is used */
  }
}

export const devUserInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ setHeaders: { 'X-Dev-User': getDevUser() } }));

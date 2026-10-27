import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// iOS Safari zooms the page when a field with text under 16px gets focus, which throws the editor's layout off.
// maximum-scale stops that auto-zoom; iOS still allows pinch-zoom. Only on iOS: elsewhere it would block zooming.
// (iPadOS reports itself as a Mac; touch points tell them apart.)
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (iOS) document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1');

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

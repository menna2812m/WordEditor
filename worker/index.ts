import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  ASSETS: Fetcher;
  BACKEND: DurableObjectNamespace<Backend>;
  /** Local dev only (set in .dev.vars): send /api/* to this URL instead of the container, e.g. http://127.0.0.1:5080.
   *  Needed on Windows, where `wrangler dev` cannot run containers. Never set in production. */
  LOCAL_API?: string;
}

/**
 * Runs the .NET API (backend/Dockerfile) as a Cloudflare Container.
 * Documents live on the container's disk, so they are lost whenever the container sleeps or restarts.
 */
export class Backend extends Container {
  defaultPort = 8080;
  sleepAfter = '30m';
  envVars = {
    // DEMO ONLY: the sample API accepts the X-Dev-User header only in Development, so anyone who can reach
    // the site can act as any user. Replace DevHeaderAuth with real authentication before sharing widely.
    ASPNETCORE_ENVIRONMENT: 'Development',
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    // One shared instance, so every visitor sees the same documents.
    if (pathname.startsWith('/api/')) {
      if (env.LOCAL_API) {
        const { pathname: p, search } = new URL(request.url);
        return fetch(new Request(new URL(p + search, env.LOCAL_API), request));
      }
      return getContainer(env.BACKEND).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

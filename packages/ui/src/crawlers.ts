/**
 * Crawler rules for the Auth hosts (auth, profile/account, auth admin): nothing on them is for
 * search engines (wiki: AUN-SEO, "robots rules"). robots.txt disallows everything and every
 * response says noindex.
 */

export const NOINDEX = 'noindex, nofollow';

export const ROBOTS_DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';

/** robots.txt for the host, or null for any other path. */
export function robotsTxtResponse(request: Request): Response | null {
  if (new URL(request.url).pathname !== '/robots.txt') return null;
  return new Response(ROBOTS_DISALLOW_ALL, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Robots-Tag': NOINDEX,
    },
  });
}

/** The response with X-Robots-Tag: noindex (copied first when its headers are immutable). */
export function withNoIndex(response: Response): Response {
  if (response.status === 101) return response;
  try {
    response.headers.set('X-Robots-Tag', NOINDEX);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set('X-Robots-Tag', NOINDEX);
    return copy;
  }
}

/** Any Worker fetch handler: (request, env, ctx), whatever the env and request types are */
type FetchHandler = (...args: never[]) => Response | Promise<Response>;

/** A Worker whose every response is noindex and whose robots.txt disallows everything. */
export function noIndexWorker<H extends { fetch?: FetchHandler }>(handler: H): H {
  const fetch = handler.fetch;
  if (!fetch) return handler;
  const wrapped = async (...args: never[]): Promise<Response> =>
    robotsTxtResponse(args[0] as Request) ?? withNoIndex(await fetch.apply(handler, args));
  return { ...handler, fetch: wrapped };
}

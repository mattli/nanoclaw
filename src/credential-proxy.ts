/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Git credentials:
 *   Containers use a git credential helper that calls GET /git-credentials.
 *   The proxy returns the GITHUB_TOKEN from .env in git credential format.
 *   The token never enters the container environment directly.
 *
 * Parallel AI:
 *   Requests to /parallel-search/* and /parallel-task/* are forwarded to
 *   the respective Parallel MCP endpoints with Authorization header injected.
 *   The PARALLEL_API_KEY never enters the container environment.
 */
import { createServer, Server, IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { Resolver } from 'dns';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Anthropic edge (Cloudflare-fronted) occasionally returns transient 5xx for
// otherwise valid requests. Retry only on the codes Anthropic documents as
// retryable, only before any bytes are sent downstream (streaming-safe), and
// with a small budget to avoid stacking on top of the CLI's internal retries.
const RETRYABLE_STATUS = new Set([502, 503, 504, 529]);
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

function backoffDelay(attempt: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, BACKOFF_MAX_MS);
    }
  }
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.floor(Math.random() * exp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// DNS cache that bypasses the system resolver. Tailscale's MagicDNS proxy
// occasionally drops or delays queries for non-tailnet names, which surfaces
// as ENOTFOUND/EAI_AGAIN on outbound API calls and kills long agent runs.
// We resolve via public DNS directly, cache with a short TTL, and fall back
// to the last-known-good IP on resolution failure. TLS SNI is preserved by
// passing the original hostname as `servername`.
const PUBLIC_DNS_SERVERS = ['1.1.1.1', '1.0.0.1', '8.8.8.8'];
const DNS_TTL_MS = 5 * 60_000;
const dnsResolver = new Resolver();
dnsResolver.setServers(PUBLIC_DNS_SERVERS);
const dnsCache = new Map<string, { ip: string; resolvedAt: number }>();

function resolve4(host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsResolver.resolve4(host, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

async function resolveHostCached(hostname: string): Promise<string> {
  const cached = dnsCache.get(hostname);
  const now = Date.now();
  if (cached && now - cached.resolvedAt < DNS_TTL_MS) return cached.ip;
  try {
    const addrs = await resolve4(hostname);
    if (addrs.length > 0) {
      dnsCache.set(hostname, { ip: addrs[0], resolvedAt: now });
      return addrs[0];
    }
  } catch (err) {
    if (cached) {
      logger.warn(
        { err, hostname, cachedIp: cached.ip },
        'DNS resolve failed; using cached IP',
      );
      return cached.ip;
    }
    throw err;
  }
  if (cached) return cached.ip;
  throw new Error(`No A records for ${hostname}`);
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'GITHUB_TOKEN',
    'PARALLEL_API_KEY',
    'COLD_MOUNTAIN_DEPLOY_HOOK',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Warm the DNS cache for hostnames we proxy so the first request doesn't
  // pay the cold-resolve cost. Failures are non-fatal — we'll resolve lazily.
  void resolveHostCached(upstreamUrl.hostname).catch((err) =>
    logger.warn(
      { err, hostname: upstreamUrl.hostname },
      'Initial DNS warm-up failed; will retry on first request',
    ),
  );
  void resolveHostCached('search-mcp.parallel.ai').catch(() => {});
  void resolveHostCached('task-mcp.parallel.ai').catch(() => {});

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Git credential endpoint — returns token in git credential helper format
      if (req.method === 'GET' && req.url === '/git-credentials') {
        if (!secrets.GITHUB_TOKEN) {
          res.writeHead(404);
          res.end('No GITHUB_TOKEN configured');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(
          `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${secrets.GITHUB_TOKEN}\n`,
        );
        return;
      }

      // Cold Mountain deploy hook — forwards POST to Vercel, keeping the hook URL off the container.
      if (req.method === 'POST' && req.url === '/cold-mountain-deploy') {
        if (!secrets.COLD_MOUNTAIN_DEPLOY_HOOK) {
          res.writeHead(404);
          res.end('No COLD_MOUNTAIN_DEPLOY_HOOK configured');
          return;
        }
        const target = new URL(secrets.COLD_MOUNTAIN_DEPLOY_HOOK);
        const upstreamReq = httpsRequest(
          {
            hostname: target.hostname,
            port: 443,
            path: target.pathname + target.search,
            method: 'POST',
            headers: { 'content-length': 0 },
          },
          (upRes) => {
            logger.info(
              { status: upRes.statusCode },
              'Cold Mountain deploy hook triggered',
            );
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );
        upstreamReq.on('error', (err) => {
          logger.error({ err }, 'Cold Mountain deploy hook failed');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
        upstreamReq.end();
        return;
      }

      // Parallel AI proxy — forward to Parallel MCP endpoints with auth injected
      const parallelRoutes: Record<string, string> = {
        '/parallel-search/': 'https://search-mcp.parallel.ai/',
        '/parallel-task/': 'https://task-mcp.parallel.ai/',
      };
      const parallelMatch = Object.entries(parallelRoutes).find(([prefix]) =>
        req.url?.startsWith(prefix),
      );
      if (parallelMatch) {
        const [prefix, upstream] = parallelMatch;
        if (!secrets.PARALLEL_API_KEY) {
          res.writeHead(404);
          res.end('No PARALLEL_API_KEY configured');
          return;
        }
        const targetPath = req.url!.slice(prefix.length);
        const targetUrl = new URL(targetPath, upstream);

        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: targetUrl.host,
            'content-length': body.length,
            authorization: `Bearer ${secrets.PARALLEL_API_KEY}`,
          };
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          resolveHostCached(targetUrl.hostname)
            .then((ip) => {
              const upstreamReq = httpsRequest(
                {
                  hostname: ip,
                  servername: targetUrl.hostname,
                  port: 443,
                  path: targetUrl.pathname + targetUrl.search,
                  method: req.method,
                  headers,
                },
                (upRes) => {
                  res.writeHead(upRes.statusCode!, upRes.headers);
                  upRes.pipe(res);
                },
              );
              upstreamReq.on('error', (err) => {
                logger.error(
                  { err, url: req.url },
                  'Parallel proxy upstream error',
                );
                if (!res.headersSent) {
                  res.writeHead(502);
                  res.end('Bad Gateway');
                }
              });
              upstreamReq.write(body);
              upstreamReq.end();
            })
            .catch((err) => {
              logger.error(
                { err, hostname: targetUrl.hostname },
                'Parallel proxy DNS resolve failed',
              );
              if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
            });
        });
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const sendOnce = (ip: string): Promise<IncomingMessage | 'error'> =>
          new Promise((resolveSend) => {
            const upstream = makeRequest(
              {
                hostname: ip,
                servername: isHttps ? upstreamUrl.hostname : undefined,
                port: upstreamUrl.port || (isHttps ? 443 : 80),
                path: req.url,
                method: req.method,
                headers,
              } as RequestOptions,
              (upRes) => resolveSend(upRes),
            );
            upstream.on('error', (err) => {
              logger.error(
                { err, url: req.url },
                'Credential proxy upstream error',
              );
              resolveSend('error');
            });
            upstream.write(body);
            upstream.end();
          });

        resolveHostCached(upstreamUrl.hostname)
          .then(async (ip) => {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              const result = await sendOnce(ip);

              if (result === 'error') {
                if (attempt < MAX_RETRIES && !res.headersSent) {
                  const delay = backoffDelay(attempt);
                  logger.warn(
                    { url: req.url, attempt: attempt + 1, delay },
                    'Credential proxy retrying after upstream error',
                  );
                  await sleep(delay);
                  continue;
                }
                if (!res.headersSent) {
                  res.writeHead(502);
                  res.end('Bad Gateway');
                }
                return;
              }

              const status = result.statusCode ?? 0;
              if (
                RETRYABLE_STATUS.has(status) &&
                attempt < MAX_RETRIES &&
                !res.headersSent
              ) {
                const retryAfter = result.headers['retry-after'];
                const delay = backoffDelay(
                  attempt,
                  Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
                );
                logger.warn(
                  { url: req.url, status, attempt: attempt + 1, delay },
                  'Credential proxy retrying after upstream 5xx',
                );
                result.resume(); // drain so the socket can be released
                await sleep(delay);
                continue;
              }

              res.writeHead(status, result.headers);
              result.pipe(res);
              return;
            }
          })
          .catch((err) => {
            logger.error(
              { err, hostname: upstreamUrl.hostname },
              'Credential proxy DNS resolve failed',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, hasGitToken: !!secrets.GITHUB_TOKEN },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

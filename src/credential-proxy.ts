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
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

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
          const headers: Record<string, string | number | string[] | undefined> = {
            ...(req.headers as Record<string, string>),
            host: targetUrl.host,
            'content-length': body.length,
            'authorization': `Bearer ${secrets.PARALLEL_API_KEY}`,
          };
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          const upstreamReq = httpsRequest(
            {
              hostname: targetUrl.hostname,
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
            logger.error({ err, url: req.url }, 'Parallel proxy upstream error');
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
          upstreamReq.write(body);
          upstreamReq.end();
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

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
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

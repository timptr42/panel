import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import express from 'express';
import session from 'express-session';
import helmet from 'helmet';

const execFileAsync = promisify(execFile);

const app = express();
const port = Number(process.env.PORT || 7777);
const hostRoot = process.env.HOST_ROOT || '/host';
const managedPrefix = process.env.NGINX_MANAGED_PREFIX || 'panel-managed-';
const appVersion = process.env.PANEL_VERSION || packageJson.version;
const appBuild = process.env.PANEL_BUILD || 'dev';
const allowAnyDomain = process.env.ALLOW_ANY_DOMAIN === 'true';
const domainPattern = allowAnyDomain
  ? /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
  : /^[a-z0-9-]+\.timptr\.ru$/i;

function readPanelPassword() {
  if (process.env.PANEL_PASSWORD_B64) {
    return Buffer.from(process.env.PANEL_PASSWORD_B64, 'base64').toString('utf8');
  }
  return process.env.PANEL_PASSWORD;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return 1;
  if (value === 'true') return 1;
  if (value === 'false') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

const panelPassword = readPanelPassword();
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

if (!panelPassword) {
  console.error('PANEL_PASSWORD_B64 or PANEL_PASSWORD is required');
  process.exit(1);
}

app.set('trust proxy', trustProxy);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    name: 'panel.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: cookieSecure,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      maxAge: 1000 * 60 * 60 * 12,
    },
  }),
);

app.use(express.static(path.join(process.cwd(), 'public')));

function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function validateDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase();
  if (!domainPattern.test(normalized)) {
    throw new Error(
      allowAnyDomain
        ? 'Domain must be a valid DNS name'
        : 'Domain must match *.timptr.ru. Set ALLOW_ANY_DOMAIN=true to allow other domains.',
    );
  }
  return normalized;
}

function validatePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return parsed;
}

function validateContainerId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    throw new Error('Invalid container id or name');
  }
  return id;
}

function validateEmail(value) {
  const email = String(value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Valid email is required');
  }
  return email;
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function splitContainerPort(value) {
  const match = String(value).match(/^(\d+)\/([a-z]+)$/i);
  return {
    privatePort: match ? Number(match[1]) : null,
    type: match ? match[2] : '',
  };
}

async function hostShell(command, options = {}) {
  const useNsenter = process.env.HOST_COMMAND_MODE !== 'direct';
  const nsenterFlags = process.env.HOST_NSENTER_FLAGS || '-t 1 -u -i -n -p';
  const shellCommand = useNsenter
    ? `nsenter ${nsenterFlags} -- chroot ${shellEscape(hostRoot)} /bin/bash -lc ${shellEscape(command)}`
    : command;

  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', shellCommand], {
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 10,
    });
    return { stdout, stderr };
  } catch (error) {
    const message = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
    const wrapped = new Error(message || 'Host command failed');
    wrapped.status = 500;
    throw wrapped;
  }
}

function mapDockerPorts(networkPorts = {}) {
  return Object.entries(networkPorts).flatMap(([containerPort, bindings]) => {
    const parsed = splitContainerPort(containerPort);
    if (!bindings) {
      return [{ containerPort, ...parsed, hostIp: null, hostPort: null }];
    }
    return bindings.map((binding) => ({
      containerPort,
      ...parsed,
      hostIp: binding.HostIp || '0.0.0.0',
      hostPort: binding.HostPort || null,
    }));
  });
}

function dockerProjectPath(container) {
  const labels = container.Config?.Labels || {};
  const composePath = labels['com.docker.compose.project.working_dir'];
  if (composePath) return composePath;

  const bindMount = (container.Mounts || []).find((mount) => mount.Type === 'bind' && mount.Source);
  return bindMount?.Source || '';
}

function dockerPaths(container) {
  const labels = container.Config?.Labels || {};
  return {
    project: labels['com.docker.compose.project.working_dir'] || '',
    composeFiles: (labels['com.docker.compose.project.config_files'] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    binds: (container.Mounts || [])
      .filter((mount) => mount.Type === 'bind' && mount.Source)
      .map((mount) => ({
        source: mount.Source,
        destination: mount.Destination || '',
        mode: mount.RW === false ? 'ro' : 'rw',
      })),
  };
}

async function listContainers() {
  const { stdout } = await hostShell(
    'ids=$(docker ps -aq); if [ -z "$ids" ]; then echo "[]"; else docker inspect -- $ids; fi',
  );
  const containers = JSON.parse(stdout || '[]');
  return containers
    .map((container) => ({
      id: container.Id,
      shortId: container.Id.slice(0, 12),
      name: String(container.Name || '').replace(/^\//, ''),
      names: [String(container.Name || '').replace(/^\//, '')].filter(Boolean),
      image: container.Config?.Image || '',
      running: Boolean(container.State?.Running),
      state: container.State?.Status || '',
      status: container.State?.Status || '',
      created: container.Created || '',
      projectPath: dockerProjectPath(container),
      paths: dockerPaths(container),
      ports: mapDockerPorts(container.NetworkSettings?.Ports || {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hostPath(...parts) {
  return path.join(hostRoot, ...parts);
}

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readNginxFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return '';
  }
}

function stripComments(line) {
  const hashIndex = line.indexOf('#');
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function parseServerBlocks(content) {
  const blocks = [];
  const serverRegex = /server\s*\{/g;
  let match;

  while ((match = serverRegex.exec(content)) !== null) {
    let depth = 1;
    let cursor = serverRegex.lastIndex;
    for (; cursor < content.length; cursor += 1) {
      if (content[cursor] === '{') depth += 1;
      if (content[cursor] === '}') depth -= 1;
      if (depth === 0) break;
    }
    blocks.push(content.slice(serverRegex.lastIndex, cursor));
    serverRegex.lastIndex = cursor + 1;
  }

  return blocks;
}

function parseNginxRoutes(content) {
  return parseServerBlocks(content).map((block) => {
    const clean = block.split('\n').map(stripComments).join('\n');
    const names = [...clean.matchAll(/server_name\s+([^;]+);/g)].flatMap((item) =>
      item[1].split(/\s+/).filter(Boolean),
    );
    const listens = [...clean.matchAll(/listen\s+([^;]+);/g)].map((item) => item[1].trim());
    const proxies = [...clean.matchAll(/proxy_pass\s+([^;]+);/g)].map((item) => item[1].trim());
    const sslCertificatePaths = [...clean.matchAll(/ssl_certificate\s+([^;]+);/g)].map((item) => item[1].trim());
    const ssl = /\bssl_certificate\b/.test(clean) || listens.some((listen) => /\b443\b/.test(listen));
    return { names, listens, proxies, sslCertificatePaths, ssl };
  });
}

async function resolveEnabledTargets() {
  const enabledDir = hostPath('etc/nginx/sites-enabled');
  const entries = await safeReadDir(enabledDir);
  const targets = new Set();

  for (const entry of entries) {
    const enabledPath = path.join(enabledDir, entry.name);
    try {
      const stat = await fs.lstat(enabledPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(enabledPath);
        const resolved = target.startsWith('/')
          ? path.join(hostRoot, target)
          : path.resolve(enabledDir, target);
        targets.add(resolved);
      } else if (stat.isFile()) {
        targets.add(enabledPath);
      }
    } catch {
      // Ignore broken links in the dashboard, nginx -t will surface them when editing.
    }
  }

  return targets;
}

async function listNginxSites() {
  const availableDir = hostPath('etc/nginx/sites-available');
  const entries = await safeReadDir(availableDir);
  const enabledTargets = await resolveEnabledTargets();
  const files = entries.filter((entry) => entry.isFile() || entry.isSymbolicLink());

  const sites = [];
  for (const entry of files) {
    const filePath = path.join(availableDir, entry.name);
    const content = await readNginxFile(filePath);
    const routes = parseNginxRoutes(content);
    sites.push({
      file: entry.name,
      managed: entry.name.startsWith(managedPrefix),
      enabled: enabledTargets.has(filePath),
      routes,
    });
  }

  return sites.sort((a, b) => a.file.localeCompare(b.file));
}

function extractTargetPort(proxies = []) {
  for (const proxy of proxies) {
    const match = proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function summarizeRouteTarget(proxies = []) {
  const proxy = proxies.find(Boolean);
  if (!proxy) return '';
  const port = extractTargetPort([proxy]);
  return port ? `localhost:${port}` : proxy;
}

async function listRoutesWithCertificates() {
  const [sites, certificates] = await Promise.all([listNginxSites(), parseCertificates()]);
  const byDomainAndFile = new Map();

  for (const site of sites) {
    for (const route of site.routes) {
      for (const domain of route.names) {
        const key = `${domain}\n${site.file}`;
        const existing = byDomainAndFile.get(key) || {
          domain,
          file: site.file,
          managed: site.managed,
          enabled: site.enabled,
          listens: [],
          proxies: [],
          sslCertificatePaths: [],
          ssl: false,
        };
        existing.listens.push(...route.listens);
        existing.proxies.push(...route.proxies);
        existing.sslCertificatePaths.push(...route.sslCertificatePaths);
        existing.ssl = existing.ssl || route.ssl;
        byDomainAndFile.set(key, existing);
      }
    }
  }

  return [...byDomainAndFile.values()]
    .map((route) => {
      const uniqueProxies = [...new Set(route.proxies)];
      const uniqueListens = [...new Set(route.listens)];
      const uniqueSslCertificatePaths = uniq(route.sslCertificatePaths);
      const certificate = certificates.find(
        (cert) =>
          cert.domains.includes(route.domain) ||
          uniqueSslCertificatePaths.some((certPath) => cert.certificatePath === certPath),
      );
      return {
        ...route,
        listens: uniqueListens,
        proxies: uniqueProxies,
        sslCertificatePaths: uniqueSslCertificatePaths,
        target: summarizeRouteTarget(uniqueProxies),
        targetPort: extractTargetPort(uniqueProxies),
        certificate: certificate
          ? {
              ...certificate,
              summary: certificate.expiry || certificate.name,
            }
          : null,
      };
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.domain.localeCompare(b.domain));
}

function buildProxyLocation(targetPort) {
  return `    location / {
        proxy_pass http://127.0.0.1:${targetPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }`;
}

function buildManagedNginxConfig(domain, targetPort, certificate = null) {
  if (certificate?.certificatePath && certificate?.privateKeyPath) {
    return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${domain};

    ssl_certificate ${certificate.certificatePath};
    ssl_certificate_key ${certificate.privateKeyPath};

${buildProxyLocation(targetPort)}
}
`;
  }

  return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

${buildProxyLocation(targetPort)}
}
`;
}

async function upsertRoute(domain, targetPort) {
  const fileName = `${managedPrefix}${domain}.conf`;
  const certificates = await parseCertificates();
  const certificate = certificates.find((item) => item.domains.includes(domain));
  const config = buildManagedNginxConfig(domain, targetPort, certificate);
  const encoded = Buffer.from(config, 'utf8').toString('base64');
  await hostShell(
    [
      `printf %s ${shellEscape(encoded)} | base64 -d > /etc/nginx/sites-available/${shellEscape(fileName)}`,
      `ln -sfn /etc/nginx/sites-available/${shellEscape(fileName)} /etc/nginx/sites-enabled/${shellEscape(fileName)}`,
      'nginx -t',
      'systemctl reload nginx',
    ].join(' && '),
  );
  return { file: fileName, domain, targetPort };
}

function parseCertificateOutput(output) {
  const sections = output.split(/- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -/g);
  return sections
    .map((section) => {
      const name = section.match(/Certificate Name:\s*(.+)/)?.[1]?.trim();
      if (!name) return null;
      const domains = section.match(/Domains:\s*(.+)/)?.[1]?.trim().split(/\s+/).filter(Boolean) || [];
      return {
        name,
        domains,
        expiry: section.match(/Expiry Date:\s*(.+)/)?.[1]?.trim() || '',
        certificatePath: section.match(/Certificate Path:\s*(.+)/)?.[1]?.trim() || '',
        privateKeyPath: section.match(/Private Key Path:\s*(.+)/)?.[1]?.trim() || '',
      };
    })
    .filter(Boolean);
}

function certificateFromPath(certificatePath, domains = []) {
  const match = certificatePath.match(/\/etc\/letsencrypt\/live\/([^/]+)\/fullchain\.pem$/);
  const name = match?.[1] || domains[0] || certificatePath;
  return {
    name,
    domains: domains.length ? domains : [name],
    expiry: '',
    certificatePath,
    privateKeyPath: `/etc/letsencrypt/live/${name}/privkey.pem`,
  };
}

async function parseRenewalCertificates() {
  const renewalDir = hostPath('etc/letsencrypt/renewal');
  const entries = await safeReadDir(renewalDir);
  const certificates = [];

  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.conf'))) {
    const content = await readNginxFile(path.join(renewalDir, entry.name));
    const name = entry.name.replace(/\.conf$/, '');
    const domains = content.match(/^\s*domains\s*=\s*(.+)$/m)?.[1]?.split(/\s*,\s*/).filter(Boolean) || [name];
    certificates.push({
      name,
      domains,
      expiry: '',
      certificatePath: `/etc/letsencrypt/live/${name}/fullchain.pem`,
      privateKeyPath: `/etc/letsencrypt/live/${name}/privkey.pem`,
    });
  }

  return certificates;
}

async function parseLiveCertificates() {
  const liveDir = hostPath('etc/letsencrypt/live');
  const entries = await safeReadDir(liveDir);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => certificateFromPath(`/etc/letsencrypt/live/${entry.name}/fullchain.pem`, [entry.name]));
}

async function parseNginxCertificateReferences() {
  const sites = await listNginxSites();
  return sites.flatMap((site) =>
    site.routes.flatMap((route) =>
      route.sslCertificatePaths.map((certificatePath) => certificateFromPath(certificatePath, route.names)),
    ),
  );
}

function mergeCertificates(certificates) {
  const byPathOrName = new Map();

  for (const certificate of certificates) {
    const key = certificate.certificatePath || certificate.name;
    const existing = byPathOrName.get(key);
    if (!existing) {
      byPathOrName.set(key, {
        ...certificate,
        domains: uniq(certificate.domains),
      });
      continue;
    }

    existing.domains = uniq([...existing.domains, ...certificate.domains]);
    existing.expiry ||= certificate.expiry;
    existing.privateKeyPath ||= certificate.privateKeyPath;
  }

  return [...byPathOrName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function parseCertificates() {
  const { stdout, stderr } = await hostShell('certbot certificates || true', { timeout: 60000 });
  return mergeCertificates([
    ...parseCertificateOutput(`${stdout}\n${stderr}`),
    ...(await parseRenewalCertificates()),
    ...(await parseLiveCertificates()),
    ...(await parseNginxCertificateReferences()),
  ]);
}

async function issueCertificate(domain, email) {
  const { stdout, stderr } = await hostShell(
    [
      'certbot --nginx',
      `-d ${shellEscape(domain)}`,
      `-m ${shellEscape(email)}`,
      '--agree-tos --non-interactive --redirect',
    ].join(' '),
    { timeout: 180000, maxBuffer: 1024 * 1024 * 20 },
  );
  return stdout || stderr;
}

app.get('/api/meta', (req, res) => {
  res.json({
    version: appVersion,
    build: appBuild,
    cookieSecure,
    trustProxy: app.get('trust proxy'),
    requestSecure: req.secure,
    requestProtocol: req.protocol,
    forwardedProto: req.get('x-forwarded-proto') || '',
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.authenticated) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true });
});

app.post('/api/login', (req, res) => {
  if (req.body?.password !== panelPassword) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/overview', requireAuth, async (req, res, next) => {
  try {
    const [containers, nginxSites, certificates] = await Promise.all([
      listContainers(),
      listNginxSites(),
      parseCertificates(),
    ]);
    res.json({ containers, nginxSites, certificates });
  } catch (error) {
    next(error);
  }
});

app.get('/api/docker', requireAuth, async (req, res, next) => {
  try {
    res.json(await listContainers());
  } catch (error) {
    next(error);
  }
});

app.get('/api/docker/containers', requireAuth, async (req, res, next) => {
  try {
    res.json({ containers: await listContainers() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/docker/:id/:action', requireAuth, async (req, res, next) => {
  try {
    const id = validateContainerId(req.params.id);
    const action = String(req.params.action);
    if (!['start', 'stop', 'restart'].includes(action)) {
      res.status(400).json({ error: 'Unsupported Docker action' });
      return;
    }
    const { stdout, stderr } = await hostShell(`docker ${action} -- ${shellEscape(id)}`, { timeout: 60000 });
    res.json({ ok: true, output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.post('/api/docker/containers/:id/:action', requireAuth, async (req, res, next) => {
  try {
    const id = validateContainerId(req.params.id);
    const action = String(req.params.action);
    if (!['start', 'stop', 'restart'].includes(action)) {
      res.status(400).json({ error: 'Unsupported Docker action' });
      return;
    }
    const { stdout, stderr } = await hostShell(`docker ${action} -- ${shellEscape(id)}`, { timeout: 60000 });
    res.json({ ok: true, output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.get('/api/nginx', requireAuth, async (req, res, next) => {
  try {
    res.json(await listNginxSites());
  } catch (error) {
    next(error);
  }
});

app.get('/api/nginx/routes', requireAuth, async (req, res, next) => {
  try {
    res.json({ routes: await listRoutesWithCertificates() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nginx/routes', requireAuth, async (req, res, next) => {
  try {
    const domain = validateDomain(req.body?.domain);
    const targetPort = validatePort(req.body?.targetPort ?? req.body?.port);
    res.json({ ok: true, route: await upsertRoute(domain, targetPort) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nginx/test', requireAuth, async (req, res, next) => {
  try {
    const { stdout, stderr } = await hostShell('nginx -t');
    res.json({ ok: true, output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nginx/reload', requireAuth, async (req, res, next) => {
  try {
    const { stdout, stderr } = await hostShell('nginx -t && systemctl reload nginx');
    res.json({ ok: true, output: stdout || stderr || 'nginx reloaded' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/certificates', requireAuth, async (req, res, next) => {
  try {
    res.json({ certificates: await parseCertificates() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/certificates/issue', requireAuth, async (req, res, next) => {
  try {
    const domain = validateDomain(req.body?.domain);
    const email = validateEmail(req.body?.email);
    res.json({ ok: true, output: await issueCertificate(domain, email) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/certificates/:domain/issue', requireAuth, async (req, res, next) => {
  try {
    const domain = validateDomain(req.params.domain);
    const email = validateEmail(req.body?.email);
    res.json({ ok: true, output: await issueCertificate(domain, email) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/certificates/renew', requireAuth, async (req, res, next) => {
  try {
    const domain = req.body?.domain ? validateDomain(req.body.domain) : null;
    const command = domain
      ? `certbot renew --cert-name ${shellEscape(domain)} --deploy-hook 'systemctl reload nginx'`
      : "certbot renew --deploy-hook 'systemctl reload nginx'";
    const { stdout, stderr } = await hostShell(command, { timeout: 180000, maxBuffer: 1024 * 1024 * 20 });
    res.json({ ok: true, output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (error, req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Panel is listening on port ${port}`);
});

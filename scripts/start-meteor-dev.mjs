#!/usr/bin/env node
/**
 * Self-Healing Dev + Cloudflare Tunnel Supervisor for God's Eye View (Meteor Intelligence)
 *
 * Ensures:
 *  1. Vite dev server runs on http://localhost:4173 (--strictPort) and auto-restarts on exit.
 *  2. cloudflared quick-tunnel proxies http://localhost:4173 with --http-host-header localhost:4173
 *     (compatible with build/allowedHosts.js without weakening security boundaries).
 *  3. Writes the current public tunnel URL to LIVE-TUNNEL-URL.txt in the repo root.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GEV_PORT || 4173);
const LOCAL_APP_DATA =
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const CLOUDFLARED_BIN =
  process.env.CLOUDFLARED_BIN || path.join(LOCAL_APP_DATA, 'Temp', 'cloudflared.exe');
const TUNNEL_LOG = path.join(LOCAL_APP_DATA, 'Temp', 'cloudflared-meteor.log');
const TUNNEL_URL_FILE = path.join(ROOT_DIR, 'LIVE-TUNNEL-URL.txt');
const SUPERVISOR_LOG = path.join(ROOT_DIR, 'dev-supervisor.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(SUPERVISOR_LOG, line);
  } catch {
    // ignore
  }
}

function checkLocalHttp(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

let viteProc = null;
let tunnelProc = null;
let lastTunnelUrl = null;

function startVite() {
  if (viteProc) return;
  const viteCli = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  log(`Starting Vite dev server on http://localhost:${PORT} ...`);
  viteProc = spawn(
    process.execPath,
    [viteCli, '--port', String(PORT), '--strictPort'],
    {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  viteProc.stdout?.on('data', (d) => {
    const text = d.toString().trim();
    if (text) log(`[vite] ${text}`);
  });
  viteProc.stderr?.on('data', (d) => {
    const text = d.toString().trim();
    if (text) log(`[vite:err] ${text}`);
  });
  viteProc.on('exit', (code, sig) => {
    log(`Vite exited (code=${code}, sig=${sig}). Will check/restart in 2s.`);
    viteProc = null;
  });
}

function updateTunnelUrlFromLog() {
  try {
    if (!fs.existsSync(TUNNEL_LOG)) return;
    const content = fs.readFileSync(TUNNEL_LOG, 'utf8');
    const matches = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (matches && matches.length > 0) {
      const latest = matches[matches.length - 1];
      if (latest !== lastTunnelUrl) {
        lastTunnelUrl = latest;
        fs.writeFileSync(
          TUNNEL_URL_FILE,
          `${latest}\nLocal: http://localhost:${PORT}\nUpdated: ${new Date().toISOString()}\n`,
          'utf8',
        );
        log(`Live Tunnel URL updated: ${latest}`);
      }
    }
  } catch {
    // ignore
  }
}

function startTunnel() {
  if (tunnelProc) return;
  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    log(`cloudflared binary not found at ${CLOUDFLARED_BIN}; skipping tunnel.`);
    return;
  }
  try {
    fs.writeFileSync(TUNNEL_LOG, '', 'utf8');
  } catch {
    // ignore
  }
  lastTunnelUrl = null;
  log(`Starting cloudflared tunnel -> http://localhost:${PORT} ...`);
  tunnelProc = spawn(
    CLOUDFLARED_BIN,
    [
      'tunnel',
      '--url',
      `http://localhost:${PORT}`,
      '--http-host-header',
      `localhost:${PORT}`,
      '--logfile',
      TUNNEL_LOG,
    ],
    {
      cwd: ROOT_DIR,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  tunnelProc.on('exit', (code, sig) => {
    log(`cloudflared exited (code=${code}, sig=${sig}). Will restart on next tick.`);
    tunnelProc = null;
  });
}

async function tick() {
  const healthy = await checkLocalHttp(PORT);
  if (!healthy && !viteProc) {
    startVite();
  }
  if (!tunnelProc) {
    startTunnel();
  }
  updateTunnelUrlFromLog();
}

log('=== God\'s Eye View (Meteor Intelligence) Supervisor Started ===');
await tick();
setInterval(tick, 5000);

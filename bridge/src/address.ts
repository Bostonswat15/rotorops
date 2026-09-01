/**
 * Working out where SimConnect is listening.
 *
 * node-simconnect's own autodetect shells out to a VBScript (via `regedit`) to
 * read the registry. That script is a data file resolved through __dirname, so
 * it cannot be bundled into a single executable -- it breaks the moment the
 * bridge is packaged.
 *
 * MSFS writes its listening configuration to SimConnect.xml, so we read that
 * instead. No child processes, no data files, and it honours a custom config.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type Candidate = {
  label: string;
  options: { host: string; port: number } | undefined;
};

const appData = () => process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const localAppData = () =>
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');

/** Known SimConnect.xml locations, newest sim first. */
function configPaths(): string[] {
  const paths = [
    join(appData(), 'Microsoft Flight Simulator 2024', 'SimConnect.xml'),
    join(appData(), 'Microsoft Flight Simulator', 'SimConnect.xml'),
  ];
  // MS Store builds keep a copy under the package's LocalCache.
  for (const pkg of [
    'Microsoft.Limitless_8wekyb3d8bbwe',
    'Microsoft.FlightSimulator_8wekyb3d8bbwe',
  ]) {
    paths.push(join(localAppData(), 'Packages', pkg, 'LocalCache', 'SimConnect.xml'));
  }
  return paths.filter((p) => existsSync(p));
}

/**
 * Pull static IPv4 ports out of SimConnect.xml.
 *
 * A <Port> of 0 means "pick one at runtime" and is no use to us, so only
 * explicitly configured ports are returned.
 */
function portsFromConfig(xml: string): number[] {
  const ports: number[] = [];
  // Each listener is one <SimConnect.Comm> block.
  for (const m of xml.matchAll(/<SimConnect\.Comm>([\s\S]*?)<\/SimConnect\.Comm>/g)) {
    const block = m[1];
    const protocol = /<Protocol>\s*(.*?)\s*<\/Protocol>/i.exec(block)?.[1];
    const port = /<Port>\s*(.*?)\s*<\/Port>/i.exec(block)?.[1];
    if (!protocol || !port) continue;
    if (protocol.toLowerCase() !== 'ipv4') continue;
    const n = Number.parseInt(port, 10);
    if (Number.isFinite(n) && n > 0) ports.push(n);
  }
  return ports;
}

/**
 * Addresses to try, in order. `options: undefined` means "let the library
 * autodetect", which only works when running from source.
 */
export function connectionCandidates(allowAutodetect: boolean): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<number>();

  const add = (port: number, label: string) => {
    if (seen.has(port)) return;
    seen.add(port);
    out.push({ label, options: { host: '127.0.0.1', port } });
  };

  // An explicit override always wins.
  const envPort = Number.parseInt(process.env.SIMCONNECT_PORT ?? '', 10);
  if (Number.isFinite(envPort) && envPort > 0) {
    out.push({
      label: `SIMCONNECT_PORT=${envPort}`,
      options: { host: process.env.SIMCONNECT_HOST || '127.0.0.1', port: envPort },
    });
    seen.add(envPort);
  }

  // Running from source, the library's registry lookup finds the live
  // dynamic port, which beats anything we can infer.
  if (allowAutodetect) out.push({ label: 'autodetect', options: undefined });

  for (const path of configPaths()) {
    try {
      for (const port of portsFromConfig(readFileSync(path, 'utf8'))) {
        add(port, `SimConnect.xml (${port})`);
      }
    } catch {
      /* unreadable config; try the next one */
    }
  }

  add(500, 'default static IPv4 (500)');
  add(2048, 'SimConnect fallback (2048)');
  return out;
}

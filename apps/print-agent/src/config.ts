import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Agent configuration: a JSON file next to the binary, or environment
 * variables (which win). Deliberately tiny — an install is "paste the API
 * URL and the token", and anything else the agent needs it asks the server
 * for.
 */
export interface AgentConfig {
  /** e.g. https://api.axlopos.com */
  apiUrl: string;
  /** The pairing token shown once in Settings → Printing → Agents. */
  token: string;
  /** Shown in settings so an operator can tell two agents apart. */
  name: string;
  /** Seconds between polls when the queue is empty. */
  pollSeconds: number;
  /** Scan the LAN for printers this often and report what we find. */
  discoverySeconds: number;
  /** Port to look for printers on. 9100 is the raw ESC/POS standard. */
  printerPort: number;
}

const DEFAULTS = {
  name: 'Print agent',
  pollSeconds: 3,
  discoverySeconds: 120,
  printerPort: 9100,
};

export function loadConfig(configPath = process.env.AGENT_CONFIG ?? 'agent.json'): AgentConfig {
  let fileConfig: Partial<AgentConfig> = {};
  try {
    fileConfig = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as Partial<AgentConfig>;
  } catch {
    // Missing file is fine when everything comes from the environment —
    // which is how a container or a systemd unit is usually configured.
  }

  const apiUrl = process.env.AGENT_API_URL ?? fileConfig.apiUrl ?? '';
  const token = process.env.AGENT_TOKEN ?? fileConfig.token ?? '';
  if (!apiUrl || !token) {
    throw new Error(
      'Print agent is not configured. Provide apiUrl and token in agent.json, or set ' +
        'AGENT_API_URL and AGENT_TOKEN. Pair an agent in Settings → Printing to get a token.',
    );
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    token,
    name: process.env.AGENT_NAME ?? fileConfig.name ?? DEFAULTS.name,
    pollSeconds: num(process.env.AGENT_POLL_SECONDS, fileConfig.pollSeconds, DEFAULTS.pollSeconds),
    discoverySeconds: num(
      process.env.AGENT_DISCOVERY_SECONDS,
      fileConfig.discoverySeconds,
      DEFAULTS.discoverySeconds,
    ),
    printerPort: num(process.env.AGENT_PRINTER_PORT, fileConfig.printerPort, DEFAULTS.printerPort),
  };
}

function num(env: string | undefined, file: number | undefined, fallback: number): number {
  const value = Number(env ?? file);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

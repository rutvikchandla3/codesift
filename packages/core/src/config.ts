import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * On-disk repo configuration, persisted at `.codesift/config.json`. All fields are optional; an
 * absent or malformed file is treated as an empty config (the local defaults apply). Reading is
 * deliberately cheap and synchronous so provider resolution can consult it on every sync/search.
 */
export interface CodesiftConfig {
  /** Embedding provider id, e.g. `voyage-code-3`. Defaults to the built-in local lexical provider. */
  provider?: string
  /** Optional model override recorded for documentation; providers carry their own model id. */
  model?: string
  /** Extra ignore globs layered on top of `.gitignore` / `.codesiftignore`. */
  ignore?: string[]
  /** Permit cloud-embedding sends when secret-shaped content is detected (redacts rather than refuses). */
  allowSecrets?: boolean
}

export const CONFIG_KEYS = ['provider', 'model', 'ignore', 'allowSecrets'] as const
export type CodesiftConfigKey = (typeof CONFIG_KEYS)[number]

export function getConfigPath(root: string): string {
  return resolve(root, '.codesift', 'config.json')
}

export function readConfig(root: string): CodesiftConfig {
  let raw: string
  try {
    raw = readFileSync(getConfigPath(root), 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== 'object') {
    return {}
  }

  return sanitizeConfig(parsed as Record<string, unknown>)
}

export function writeConfig(root: string, config: CodesiftConfig): void {
  mkdirSync(resolve(root, '.codesift'), { recursive: true })
  writeFileSync(getConfigPath(root), `${JSON.stringify(sanitizeConfig(config as Record<string, unknown>), null, 2)}\n`, 'utf8')
}

/**
 * Apply a single `config set <key> <value>` mutation to the on-disk config, parsing the raw string
 * value into the field's type. Returns the merged config. Throws on an unknown key.
 */
export function setConfigValue(root: string, key: string, value: string | undefined): CodesiftConfig {
  if (!isConfigKey(key)) {
    throw new Error(`Unknown config key: ${key}. Known keys: ${CONFIG_KEYS.join(', ')}.`)
  }

  const config = readConfig(root)

  if (value === undefined) {
    delete config[key]
  } else if (key === 'ignore') {
    const globs = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    config.ignore = globs
  } else if (key === 'allowSecrets') {
    config.allowSecrets = parseBoolean(value)
  } else {
    config[key] = value
  }

  writeConfig(root, config)
  return config
}

export function isConfigKey(key: string): key is CodesiftConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key)
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false
  }
  throw new Error(`Expected a boolean for allowSecrets, got: ${value}`)
}

function sanitizeConfig(raw: Record<string, unknown>): CodesiftConfig {
  const config: CodesiftConfig = {}

  if (typeof raw.provider === 'string' && raw.provider.trim()) {
    config.provider = raw.provider.trim()
  }
  if (typeof raw.model === 'string' && raw.model.trim()) {
    config.model = raw.model.trim()
  }
  if (Array.isArray(raw.ignore)) {
    const globs = raw.ignore.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    if (globs.length > 0) {
      config.ignore = globs
    }
  }
  if (typeof raw.allowSecrets === 'boolean') {
    config.allowSecrets = raw.allowSecrets
  }

  return config
}

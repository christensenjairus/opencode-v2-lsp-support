import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BUILTIN_EXTENSIONS } from "./catalog.ts"
import { parseJsonc } from "./jsonc.ts"

export interface ServerConfig {
  readonly id: string
  readonly command: string[]
  /** Lowercased dotted extensions (`.ts`) or exact lowercased file names (`dockerfile`). */
  readonly extensions: string[]
  readonly env: Record<string, string>
  readonly initialization?: Record<string, unknown>
}

export interface Settings {
  readonly servers: ServerConfig[]
  readonly diagnostics: boolean
  readonly diagnosticsTimeoutMs: number
  readonly initializeTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly debug: boolean
}

const NAMES = ["opencode.json", "opencode.jsonc"]

/**
 * OpenCode 2 parses the `lsp` key but gives plugins no access to the merged
 * configuration, so this reads the same sources in the same order. Plugin
 * options override all of them.
 */
export function resolveSettings(directory: string, options: Record<string, unknown>, env = process.env): Settings {
  let lsp: unknown
  for (const document of configDocuments(directory, env)) {
    if (document.lsp !== undefined) lsp = mergeLsp(lsp, document.lsp)
  }
  if (options.lsp !== undefined) lsp = mergeLsp(lsp, options.lsp)
  const debug = options.debug === true
  return {
    servers: resolveServers(lsp, debug),
    diagnostics: options.diagnostics !== false,
    diagnosticsTimeoutMs: positive(options.diagnosticsTimeoutMs, 5_000),
    initializeTimeoutMs: positive(options.initializeTimeoutMs, 45_000),
    requestTimeoutMs: positive(options.requestTimeoutMs, 15_000),
    debug,
  }
}

/** Configuration documents from lowest to highest precedence. */
export function configDocuments(directory: string, env: NodeJS.ProcessEnv): Record<string, unknown>[] {
  const documents: Record<string, unknown>[] = []
  const push = (document: Record<string, unknown> | undefined) => {
    if (document) documents.push(document)
  }
  const global = env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  for (const name of NAMES) push(readDocument(join(global, name)))
  if (env.OPENCODE_CONFIG) push(readDocument(resolve(env.OPENCODE_CONFIG)))

  const projectDisabled = truthy(env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG)
  if (!projectDisabled && canonical(directory) !== canonical(global)) {
    const globalFiles = new Set(NAMES.map((name) => canonical(join(global, name))))
    const ancestors: string[] = []
    for (let current = resolve(directory); ; current = dirname(current)) {
      ancestors.push(current)
      if (dirname(current) === current) break
    }
    ancestors.reverse()
    // OpenCode loads every direct file before any `.opencode` file, farthest directory first.
    for (const ancestor of ancestors) {
      for (const name of NAMES) {
        const file = join(ancestor, name)
        if (!globalFiles.has(canonical(file))) push(readDocument(file))
      }
    }
    for (const ancestor of ancestors) {
      const project = join(ancestor, ".opencode")
      if (canonical(project) === canonical(global)) continue
      for (const name of NAMES) push(readDocument(join(project, name)))
    }
  }
  if (env.OPENCODE_CONFIG_CONTENT) push(parseDocument(env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT", directory, env))
  return documents

  function readDocument(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined
    return parseDocument(readFileSync(path, "utf8"), path, dirname(path), env)
  }
}

function parseDocument(text: string, source: string, dir: string, env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  try {
    // Windows editors (and opencode Desktop) often save config files with a UTF-8
    // BOM, which JSON.parse rejects; strip it before parsing.
    const parsed = parseJsonc(substitute(text.replace(/^\uFEFF/, ""), dir, env))
    return isRecord(parsed) ? parsed : undefined
  } catch (error) {
    console.error(`[lsp] cannot parse ${source}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * OpenCode 2's substitution, applied to the raw text before parsing: `{env:VAR}`
 * becomes the variable or nothing, and `{file:path}` becomes the trimmed file,
 * escaped for a JSON string, relative to `dir` unless absolute or `~/`. File
 * tokens on `//` comment lines stay as they are; a missing file fails the document.
 */
export function substitute(text: string, dir: string, env: NodeJS.ProcessEnv): string {
  return text
    .replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] || "")
    .replace(/\{file:[^}]+\}/g, (token: string, offset: number, whole: string) => {
      if (whole.slice(whole.lastIndexOf("\n", offset - 1) + 1, offset).trimStart().startsWith("//")) return token
      const path = token.slice("{file:".length, -1)
      const file = resolve(dir, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)
      return JSON.stringify(readFileSync(file, "utf8").trim()).slice(1, -1)
    })
}

/**
 * `false` disables every server. Server objects merge deeply, as OpenCode merges
 * config documents, so a later `{ "x": { "disabled": true } }` turns one off and
 * one nested `initialization` setting keeps the inherited ones. Arrays are replaced.
 */
export function mergeLsp(previous: unknown, next: unknown): unknown {
  if (next === false) return false
  if (next === true) return isRecord(previous) ? previous : {}
  if (!isRecord(next)) return previous
  const merged: Record<string, unknown> = isRecord(previous) ? { ...previous } : {}
  for (const [id, entry] of Object.entries(next)) merged[id] = mergeDeep(merged[id], entry)
  return merged
}

function mergeDeep(previous: unknown, next: unknown): unknown {
  if (!isRecord(previous) || !isRecord(next)) return next
  const merged: Record<string, unknown> = { ...previous }
  for (const [key, value] of Object.entries(next)) merged[key] = mergeDeep(merged[key], value)
  return merged
}

function resolveServers(lsp: unknown, debug: boolean): ServerConfig[] {
  if (!isRecord(lsp)) return []
  const servers: ServerConfig[] = []
  for (const [id, entry] of Object.entries(lsp)) {
    if (!isRecord(entry) || entry.disabled === true) continue
    const command = strings(entry.command)
    if (command.length === 0) {
      if (debug) console.error(`[lsp] ${id} has no command; skipping`)
      continue
    }
    const declared = strings(entry.extensions)
    const extensions = [...new Set((declared.length ? declared : (BUILTIN_EXTENSIONS[id] ?? [])).map((item) => item.trim().toLowerCase()))].filter(Boolean)
    if (extensions.length === 0) {
      console.error(`[lsp] ${id} has no extensions and is not a known OpenCode server; it matches no files`)
      continue
    }
    servers.push({
      id,
      command,
      extensions,
      env: isRecord(entry.env) ? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {},
      initialization: isRecord(entry.initialization) ? entry.initialization : undefined,
    })
  }
  return servers
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true"
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

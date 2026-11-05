import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Diagnostic } from "./client.ts"
import { isRecord } from "./config.ts"
import { diagnosticsReport, displayPath, errorsOnly } from "./format.ts"
import { insideProject, projectPath, type LspManager } from "./manager.ts"

const MUTATING_TOOLS = new Set(["write", "edit", "patch", "apply_patch"])
const MAX_OTHER_FILES = 5

interface Completed {
  readonly tool: string
  readonly input: unknown
  readonly status: "completed"
  result: { output?: unknown; content?: unknown; metadata?: Record<string, unknown> }
}

/**
 * After write, edit, or patch, send each changed file to its servers and append
 * their errors to the result, as OpenCode 1 did. Read starts the file's servers
 * in the background so the first edit does not wait for a cold start. Deleted
 * and moved-away files are closed so servers stop analyzing their old contents.
 */
export function afterTool(manager: LspManager, root: string, diagnostics: boolean) {
  return async (event: { tool: string; status: string; input: unknown }) => {
    if (event.status !== "completed") return
    if (event.tool === "read") return warm(manager, root, event.input)
    if (!MUTATING_TOOLS.has(event.tool)) return
    const { changed, deleted } = touchedFiles(event as Completed, root)
    await Promise.all(deleted.map((file) => manager.close(file)))
    if (diagnostics) await report(manager, root, event as Completed, changed)
  }
}

/** Files with a server that resolve inside the project. OpenCode 1 asked before touching others; plugins cannot ask. */
async function checkable(manager: LspManager, root: string, files: string[]): Promise<string[]> {
  const inside = await Promise.all(files.map((file) => manager.serversFor(file).length > 0 && insideProject(root, file)))
  return files.filter((_, index) => inside[index])
}

function warm(manager: LspManager, root: string, input: unknown): void {
  if (!isRecord(input) || typeof input.path !== "string") return
  const file = projectPath(root, input.path)
  void checkable(manager, root, [file])
    .then(async ([inside]) => (inside && (await stat(inside)).isFile() ? manager.sync(inside) : undefined))
    .catch(() => undefined)
}

async function report(manager: LspManager, root: string, event: Completed, changed: string[]): Promise<void> {
  const files = await checkable(manager, root, changed)
  if (files.length === 0) return

  const sections: string[] = []
  const shown: Record<string, Diagnostic[]> = {}
  const others = new Map<string, Diagnostic[]>()
  const results = await Promise.all(files.map((file) => manager.diagnostics(file)))
  for (const [index, file] of files.entries()) {
    const result = results[index]
    for (const [uri, diagnostics] of result.others) others.set(uri, diagnostics)
    const errors = errorsOnly(result.file ?? [])
    if (errors.length === 0) continue
    const where = event.tool === "patch" || event.tool === "apply_patch" ? displayPath(file, root) : "this file"
    sections.push(`LSP errors detected in ${where}, please fix:\n${diagnosticsReport(file, errors)}`)
    shown[file] = errors
    shown[displayPath(file, root)] = errors
  }
  if (isRecord(event.input) && typeof event.input.path === "string") {
    const errors = shown[projectPath(root, event.input.path)]
    if (errors) shown[event.input.path] = errors
  }

  const elsewhere: string[] = []
  for (const [uri, diagnostics] of others) {
    if (elsewhere.length >= MAX_OTHER_FILES) break
    let file: string
    try {
      file = fileURLToPath(uri)
    } catch {
      continue // untitled: and other non-file URIs have no path to report
    }
    if (files.includes(file)) continue
    const block = diagnosticsReport(file, diagnostics)
    if (block && await insideProject(root, file)) elsewhere.push(block)
  }
  if (elsewhere.length) sections.push(`LSP errors detected in other files:\n${elsewhere.join("\n")}`)
  if (sections.length === 0) return

  // OpenCode's terminal UI shows `metadata.diagnostics[input.path]` under the edit.
  const existing = event.result.metadata?.diagnostics
  event.result.metadata = {
    ...event.result.metadata,
    diagnostics: { ...(isRecord(existing) ? existing : {}), ...shown },
  }
  append(event.result, `\n\n${sections.join("\n\n")}`)
}

/** Files the tool created or changed, and files it deleted, as absolute paths. */
export function touchedFiles(event: Completed, root: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = []
  const deleted: string[] = []
  const add = (list: string[], value: unknown) => {
    if (typeof value !== "string" || value === "") return
    const file = projectPath(root, value)
    if (!list.includes(file)) list.push(file)
  }
  const output = event.result.output
  if (isRecord(output)) {
    // write: { target }; patch: { applied: [{ type, target }] }
    add(changed, output.target)
    if (Array.isArray(output.applied)) {
      for (const item of output.applied) if (isRecord(item)) add(item.type === "delete" ? deleted : changed, item.target)
    }
    if (Array.isArray(output.files)) {
      for (const item of output.files) if (isRecord(item)) add(item.status === "deleted" ? deleted : changed, item.file)
    }
  }
  if (isRecord(event.input)) {
    add(changed, event.input.path)
    // A moved file's result names only its destination, so the source comes from the patch text.
    if (typeof event.input.patchText === "string") {
      for (const [, source] of event.input.patchText.matchAll(/^\*\*\* Update File: (.+?)\r?\n\*\*\* Move to: /gm)) {
        if (!changed.includes(projectPath(root, source.trim()))) add(deleted, source.trim())
      }
    }
  }
  return { changed: changed.filter((file) => !deleted.includes(file)), deleted }
}

function append(result: Completed["result"], text: string): void {
  if (typeof result.content === "string") result.content += text
  else if (Array.isArray(result.content)) result.content = [...result.content, { type: "text", text }]
  else if (typeof result.output === "string") result.output += text
  else result.content = text.trimStart()
}

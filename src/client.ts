import { spawn, type ChildProcess } from "node:child_process"

export interface Position {
  readonly line: number
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export interface Diagnostic {
  readonly range: Range
  readonly severity?: number
  readonly code?: string | number
  readonly source?: string
  readonly message: string
}

const MAX_HEADER = 8 * 1024
const MAX_BODY = 16 * 1024 * 1024

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function position(value: unknown): boolean {
  const item = record(value)
  return !!item && Number.isSafeInteger(item.line) && (item.line as number) >= 0
    && Number.isSafeInteger(item.character) && (item.character as number) >= 0
}

export function diagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => {
    const diagnostic = record(item)
    const range = record(diagnostic?.range)
    return !!diagnostic && !!range && position(range.start) && position(range.end)
      && typeof diagnostic.message === "string"
      && (diagnostic.severity === undefined || [1, 2, 3, 4].includes(diagnostic.severity as number))
      && (diagnostic.code === undefined || typeof diagnostic.code === "string" || typeof diagnostic.code === "number")
      && (diagnostic.source === undefined || typeof diagnostic.source === "string")
  })) throw new Error("invalid diagnostic records")
  return value as Diagnostic[]
}

export type DiagnosticReport = { kind: "full"; items: Diagnostic[] } | { kind: "unchanged" }

function diagnosticReport(value: unknown): DiagnosticReport {
  const report = record(value)
  if (report?.kind === "full") return { kind: "full", items: diagnostics(report.items) }
  if (report?.kind === "unchanged") return { kind: "unchanged" }
  throw new Error("invalid diagnostic report")
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/** A JSON-RPC error that keeps the server's code, so callers can retry transient failures. */
export class LspError extends Error {
  readonly code: number | undefined
  constructor(message: string, code: number | undefined) {
    super(message)
    this.name = "LspError"
    this.code = code
  }
}

export interface ClientOptions {
  readonly id: string
  readonly command: string[]
  readonly root: string
  readonly rootUri: string
  readonly env: Record<string, string>
  readonly initialization?: Record<string, unknown>
  readonly initializeTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly onDiagnostics: (uri: string, diagnostics: Diagnostic[], version: number | undefined) => void
  /** Called for every message from the server. Diagnostics waits use it to tell when the server is busy. */
  readonly onActivity: () => void
  readonly onExit: (failure?: Error) => void
  readonly debug: boolean
}

/** A JSON-RPC 2.0 client for one language server over stdio. */
export class LspClient {
  readonly id: string
  readonly #options: ClientOptions
  #child?: ChildProcess
  #buffer: Buffer = Buffer.alloc(0)
  #bodyLength?: number
  #body: Buffer = Buffer.alloc(0)
  #received = 0
  #failed?: Error
  #nextId = 1
  #pending = new Map<number, Pending>()
  #capabilities: Record<string, any> = {}
  #stopping = false

  constructor(options: ClientOptions) {
    this.id = options.id
    this.#options = options
  }

  get capabilities(): Record<string, any> {
    return this.#capabilities
  }

  get failure(): Error | undefined {
    return this.#failed
  }

  get running(): boolean {
    return !this.#failed && !this.#stopping && this.#child !== undefined && this.#child.exitCode === null && this.#child.signalCode === null
  }

  async start(): Promise<void> {
    const [command, ...args] = this.#options.command
    if (!command) throw new Error(`${this.id}: no command configured`)
    const child = spawn(command, args, {
      cwd: this.#options.root,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.#child = child
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk))
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.#options.debug) process.stderr.write(`[lsp:${this.id}] ${chunk}`)
    })
    child.on("exit", (code, signal) => this.#onExit(code, signal))
    // A server that exits while a notification is being written raises EPIPE.
    child.stdin?.on("error", () => {})
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", (error) => reject(new Error(`${this.id}: cannot start "${command}": ${error.message}`)))
    })
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "opencode-lsp", version: "1" },
        rootUri: this.#options.rootUri,
        rootPath: this.#options.root,
        workspaceFolders: [{ uri: this.#options.rootUri, name: "workspace" }],
        initializationOptions: this.#options.initialization ?? {},
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          window: { workDoneProgress: true },
          workspace: { configuration: true, workspaceFolders: true, symbol: {} },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: {},
          },
        },
      },
      this.#options.initializeTimeoutMs,
    )
    this.#capabilities = record(record(result)?.capabilities) ?? {}
    this.notify("initialized", {})
    if (this.#options.initialization) {
      this.notify("workspace/didChangeConfiguration", { settings: this.#options.initialization })
    }
  }

  request(method: "textDocument/diagnostic", params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<DiagnosticReport>
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>
  request(method: string, params: unknown, timeoutMs = this.#options.requestTimeoutMs, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      if (this.#failed || !this.#child) {
        reject(this.#failed ?? new Error(`${this.id}: server is not running`))
        return
      }
      const id = this.#nextId++
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        cleanup()
        reject(new Error(`${this.id}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const abort = () => {
        this.#pending.delete(id)
        cleanup()
        this.notify("$/cancelRequest", { id })
        reject(signal!.reason)
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      this.#pending.set(id, { method, resolve, reject, cleanup })
      signal?.addEventListener("abort", abort, { once: true })
      this.#send({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params })
  }

  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    const child = this.#child
    if (child && child.exitCode === null && child.signalCode === null) {
      if (!this.#failed) {
        await this.request("shutdown", null, 2_000).catch(() => undefined)
        this.#send({ jsonrpc: "2.0", method: "exit" })
      }
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 1_000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.#child = undefined
    this.#rejectPending(new Error(`${this.id}: server stopped`))
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #send(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin
    if (!stdin || stdin.destroyed) return
    const body = JSON.stringify(message)
    stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  #protocolError(error: unknown): void {
    const failure = new Error(`${this.id}: protocol error: ${errorMessage(error)}`)
    this.#failed = failure
    this.#buffer = Buffer.alloc(0)
    this.#body = Buffer.alloc(0)
    this.#bodyLength = undefined
    this.#received = 0
    this.#rejectPending(failure)
    if (this.#options.debug) console.error(failure.message)
    this.#child?.kill("SIGKILL")
  }

  #onData(chunk: Buffer): void {
    if (this.#failed) return
    try {
      while (true) {
        if (this.#bodyLength === undefined) {
          if (!chunk.length) return
          const take = Math.min(chunk.length, MAX_HEADER + 4 - this.#buffer.length)
          this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(0, take)])
          chunk = chunk.subarray(take)
          const separator = this.#buffer.indexOf("\r\n\r\n")
          if (separator < 0) {
            if (this.#buffer.length >= MAX_HEADER + 4) throw new Error("header exceeds limit")
            continue
          }
          const headers = this.#buffer.subarray(0, separator).toString("ascii").split("\r\n")
          const lengths = headers.filter((line) => /^content-length:/i.test(line))
          if (lengths.length !== 1 || !/^content-length: *[0-9]+ *$/i.test(lengths[0])) throw new Error("invalid Content-Length")
          const length = Number(lengths[0].split(":")[1].trim())
          if (!Number.isSafeInteger(length) || length > MAX_BODY) throw new Error("body exceeds limit")
          chunk = Buffer.concat([this.#buffer.subarray(separator + 4), chunk])
          this.#buffer = Buffer.alloc(0)
          this.#bodyLength = length
          this.#body = Buffer.allocUnsafe(length)
        }
        const take = Math.min(chunk.length, this.#bodyLength - this.#received)
        chunk.copy(this.#body, this.#received, 0, take)
        this.#received += take
        chunk = chunk.subarray(take)
        if (this.#received < this.#bodyLength) return
        const body = this.#body.toString("utf8")
        this.#bodyLength = undefined
        this.#body = Buffer.alloc(0)
        this.#received = 0
        this.#handle(JSON.parse(body))
      }
    } catch (error) {
      this.#protocolError(error)
    }
  }

  #handle(value: unknown): void {
    const message = record(value)
    if (!message || message.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC envelope")
    this.#options.onActivity()
    if (message.id !== undefined && message.method === undefined) {
      if (typeof message.id !== "number") throw new Error("invalid response ID")
      const pending = this.#pending.get(message.id)
      if (!pending) return
      const error = record(message.error)
      if (message.error !== undefined && (!error || typeof error.message !== "string" || typeof error.code !== "number")) {
        throw new Error("invalid error response")
      }
      let result = message.result
      if (pending.method === "textDocument/diagnostic" && !error) {
        result = diagnosticReport(result)
      }
      pending.cleanup()
      this.#pending.delete(message.id)
      if (error) pending.reject(new LspError(`${this.id}: ${error.message}`, error.code as number))
      else pending.resolve(result)
      return
    }
    if (typeof message.method !== "string") throw new Error("invalid request method")
    if (message.method === "textDocument/publishDiagnostics") {
      const params = record(message.params)
      if (!params || typeof params.uri !== "string" ||
          (params.version !== undefined && !Number.isSafeInteger(params.version))) throw new Error("invalid diagnostics parameters")
      this.#options.onDiagnostics(params.uri, diagnostics(params.diagnostics), params.version as number | undefined)
      return
    }
    if (message.id !== undefined) this.#respond(message.id, message.method, message.params)
  }

  #respond(id: unknown, method: string, params: any): void {
    const reply = (result: unknown) => this.#send({ jsonrpc: "2.0", id, result })
    switch (method) {
      case "workspace/configuration": {
        const items: any[] = Array.isArray(params?.items) ? params.items : []
        reply(items.map((item) => this.#section(item?.section)))
        return
      }
      case "workspace/workspaceFolders":
        reply([{ uri: this.#options.rootUri, name: "workspace" }])
        return
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        reply(null)
        return
      default:
        this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  /** Answers `workspace/configuration` from the server's `initialization` options. */
  #section(section: unknown): unknown {
    const settings = this.#options.initialization ?? {}
    if (typeof section !== "string" || section === "") return settings
    let value: any = settings
    for (const key of section.split(".")) {
      value = value?.[key]
      if (value === undefined) return null
    }
    return value
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#child = undefined
    this.#rejectPending(new Error(`${this.id}: server exited (${code ?? signal})`))
    if (!this.#stopping && this.#options.debug) console.error(`[lsp:${this.id}] exited (${code ?? signal})`)
    this.#options.onExit(this.#failed)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

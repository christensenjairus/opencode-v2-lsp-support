# LSP support for OpenCode V2

A local plugin that brings the OpenCode V1-style `lsp` tool and post-edit error diagnostics to OpenCode V2. OpenCode loads the TypeScript source directly, without a build step.

## Install

1. Clone the repository somewhere you will keep it:

   ```sh
   git clone https://github.com/christensenjairus/opencode-v2-lsp-support.git "$HOME/opencode-v2-lsp-support"
   ```

2. Install the pinned Cargo manifest parser:

   ```sh
   npm ci --prefix "$HOME/opencode-v2-lsp-support" --ignore-scripts
   ```

3. Add the clone's **absolute directory path** to `plugins` in your global `~/.config/opencode/opencode.json(c)` or your project's `opencode.json(c)`. Replace `/home/you` with your actual home directory, and preserve your other config entries:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/home/you/opencode-v2-lsp-support"],
     "lsp": {
       "pyright": {
         "command": ["pyright-langserver", "--stdio"],
         "extensions": [".py", ".pyi"]
       }
     }
   }
   ```

4. Install the language servers you want to use separately. For the Python example, `npm install --global pyright` provides `pyright-langserver`; make sure it is on the OpenCode service's `PATH`, or use its absolute executable path in `command`.
5. Config changes apply automatically. Use `/reload` to force a reload. Ask the agent to use `lsp` on a Python file in your project, or edit one and check the result for diagnostics.

The repo root is the plugin directory: `index.ts` is the entrypoint and `src/` contains its implementation. OpenCode loads both directly. `package.json` declares the source entrypoint, the pinned `smol-toml` dependency, and a test command. It is marked private to prevent accidental npm publication. The parser loads only for Rust root detection, so a missing install does not disable other languages.

For project-local automatic discovery, clone the repository into `.opencode/plugins/opencode-v2-lsp-support` within your project and omit the `plugins` entry. Run `npm ci --ignore-scripts` in that clone. You still need the `lsp` server configuration.

See [examples/opencode.jsonc](examples/opencode.jsonc) for portable Python, TypeScript/JavaScript, Go, shell, YAML, and Rust commands. Keep only the servers you have installed. Loading the plugin does not install or download language servers.

## Features

- Adds an `lsp` tool for definitions, references, hover, document/workspace symbols, implementations, and call hierarchies.
- Appends error diagnostics to successful `write`, `edit`, `patch`, and `apply_patch` results, with diagnostic metadata for the terminal UI.
- Supports push and pull diagnostics, document versions, and fresh errors reported in other files.
- Starts servers lazily and warms them on file reads; uses one server process per server ID and detected root.
- Closes deleted and moved-away documents and shuts down servers when the plugin unloads.
- Rejects navigation paths outside the plugin's project directory, including symlinks to outside files; checks opened files before sending their contents.
- Filters other-file diagnostic reports to existing files inside the project, including symlink checks.
- Cancels navigation requests and diagnostic warm-up when OpenCode stops a tool, without shutting down servers shared by other callers.

### Tool inputs

Every operation requires `path`. Positions are **1-based**, with UTF-16 character offsets. All operations except `documentSymbol` and `workspaceSymbol` also require `line` and `character`.

```json
{"operation": "goToDefinition", "path": "src/app.py", "line": 12, "character": 5}
```

```json
{"operation": "workspaceSymbol", "path": "src/app.py", "query": "Handler"}
```

The supported operation names are `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`. For `workspaceSymbol`, the path selects the server; an empty query requests all symbols. Each operation depends on the server advertising the corresponding capability.

## Configuration

The plugin reads the V1-shaped `lsp` map from OpenCode config files. Each server takes `command` (executable and arguments), optional `extensions`, `env`, `initialization`, and `disabled`. `initialization` supplies initialization options, configuration-change settings, and answers to `workspace/configuration` requests.

Known V1 server IDs have default extensions and root rules in [src/catalog.ts](src/catalog.ts). For example, `pyright` selects the nearest Python project marker, `typescript` selects the nearest JavaScript lockfile and skips Deno projects, and `rust` detects Cargo workspaces. Custom IDs must supply extensions and run at the plugin's project directory. Recognizing an ID does **not** supply an executable command: every enabled server must have one configured.

Cargo workspace detection rejects malformed or unreadable manifests instead of guessing a root. Fix the manifest before retrying Rust navigation. If `smol-toml` is missing, run `npm ci --ignore-scripts` in the plugin directory.

The config reader loads global files, `OPENCODE_CONFIG`, ancestor project files, ancestor `.opencode` files, then `OPENCODE_CONFIG_CONTENT`. It supports JSONC, `{env:VAR}` and `{file:path}` substitution, project-config disable flags, and deep merges of server objects; arrays are replaced. Plugin options take final precedence. This is a local config reader, not access to OpenCode's merged configuration; remote or externally supplied config is not automatically discovered.

Optional settings use OpenCode's object-form plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/opencode-v2-lsp-support",
      "options": {
        "diagnostics": true,
        "diagnosticsTimeoutMs": 5000,
        "initializeTimeoutMs": 45000,
        "requestTimeoutMs": 15000,
        "debug": false
      }
    }
  ]
}
```

The values shown are the defaults. `diagnostics: false` disables post-edit reporting but leaves navigation available. `options.lsp` overrides server settings; `lsp: false` disables all servers. Without any enabled, configured servers, the plugin registers neither the tool nor the diagnostic hook. Reload the plugin after changing its settings.

## Limitations and trust

- Targets the OpenCode V2 plugin API (`ctx.tool.transform` and `ctx.tool.hook("execute.after", ...)`), not V1. The source was extracted from a plugin used with OpenCode **v2.0.23**; other versions need verification.
- Language servers must already be installed and support stdio. No automatic installation, TCP transport, or full editor functionality is provided.
- Only errors are appended to tool results; warnings and hints are omitted. Missing diagnostic severity is treated as an error. Reports are capped at 20 errors per file and five other files; workspace symbol results are capped at 20.
- Diagnostics are best-effort. A silent or failed server leaves the edit result unchanged; a navigation request explains a startup failure. A server that fails to start stays disabled for that plugin instance until it reloads.
- Malformed protocol messages disable the server until the plugin reloads. Headers are limited to 8 KiB and bodies to 16 MiB. Valid replies above this limit also disable the server.
- Cold-start initialization and navigation warm-up can take longer than the configured diagnostics wait.
- Save notifications require an explicit `textDocumentSync.save` capability. Legacy numeric-only sync capabilities do not receive them; servers that rely on save-only checks must advertise save support.
- The plugin checks which document contents it sends; it does **not** sandbox the server process or stop a server from scanning dependencies outside the project. Servers run with the OpenCode service's OS privileges and inherited environment. Only load trusted code and configure trusted commands; debug output may include server messages and paths.

## Test

With Node.js 24 or newer, after installing dependencies:

```sh
node test-opencode-lsp.js
```

No real language servers are needed. The suite uses a fake stdio LSP server and a stand-in for the OpenCode plugin context to exercise navigation, diagnostics, config precedence, roots, failure handling, and project-boundary checks. It does not substitute for testing against the real OpenCode runtime and your chosen language servers.

## Update or remove

Run `git pull --ff-only` and `npm ci --ignore-scripts` in your clone, then use `/reload` to update. To uninstall, remove its `plugins` entry or its automatically discovered project-local clone, then reload. Language-server installations and your `lsp` configuration remain yours to manage.

OpenCode's [V2 plugin documentation](https://opencode.ai/v2/docs/build/plugins) describes local directory loading and the plugin API.

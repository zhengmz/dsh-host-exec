<div align="center">

# DSH Host Exec

**A DSH plugin to run commands on the HOST (outside the sandbox)**

Bypasses the DSH rootless bwrap sandbox and executes commands in the **host process**, giving access to real host resources: GPU (`/dev/nvidia*`), host tmux sessions, `/tmp` sockets — **whether or not GPU is involved**.

[中文](README.md) · English

</div>

---

## What problem does it solve

DSH's default `bash` tool runs inside a **rootless bwrap sandbox** that:

- masks the host device nodes (`--dev /dev` shadows the host devtmpfs), so the GPU is invisible;
- even if the device nodes are made visible via a patch, the rootless user namespace + cgroup interception still makes `open("/dev/nvidia*")` return `EACCES`;
- the sandbox shares the network, but processes, sockets and `/tmp` are torn down on every call.

Measured on our host: `nvidia-smi` inside the sandbox reports `couldn't communicate with the NVIDIA driver`, while the host user can open the GPU devices directly.

`dsh-host-exec` registers a tool into the **DSH host node process** (not the bash sandbox) and uses `child_process.spawn` to run on the host side, so the isolation is naturally bypassed and any host resource the user can access becomes reachable.

## Features

- ✅ Run arbitrary shell commands in a host-local process
- ✅ **Detached mode** `detach: true`: start a long-running process (e.g. a sim) and return its pid; the host process keeps running
- ✅ **Foreground mode** (default): run to completion, capture stdout/stderr and exit code
- ✅ Timeout control (default 300s, configurable) and output byte cap
- ✅ Configurable command-prefix **allow / deny** list
- ✅ Follows the standard Cordis `inject` / `apply` / `Config` conventions

## Installation

Install from GitHub (repo: `zhengmz/dsh-host-exec`). DSH runs pnpm in the profile directory, pulls it from GitHub, and **automatically adds** the plugin (which declares `dsh.bundle.patch`) to `dsh.profile.bundles`:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:zhengmz/dsh-host-exec
```

> For local development you can use a path instead: `npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-host-exec`.
> Note: `dsh plugin add` uses pnpm `link:` (a symlink to the source directory) for local paths. If the plugin is therefore loaded from its source directory and `@deepseek-ai/dsh-tools` fails to resolve (`MODULE_NOT_FOUND`), provide a `node_modules/@deepseek-ai` link to the DSH runtime packages in the plugin's parent directory, for example:
>
> ```bash
> mkdir -p /path/to/dsh-host-exec/../../node_modules/@deepseek-ai
> ln -s <dsh-npx-dir>/node_modules/@deepseek-ai/dsh-tools   /path/to/.../node_modules/@deepseek-ai/dsh-tools
> ln -s <dsh-npx-dir>/node_modules/@deepseek-ai/schemastery /path/to/.../node_modules/@deepseek-ai/schemastery
> ```

After installing, **restart DSH** and the `host_exec` tool will appear in your session.

## Configuration (Config)

Injected through the profile's config layer:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowPrefixes` | `string[]` | `[]` | Command prefix allow-list; empty = allow any command |
| `denyPrefixes` | `string[]` | `[]` | Command prefix deny-list (checked after allow-list) |
| `defaultTimeoutMs` | `number` | `300000` | Default timeout (ms) for foreground runs |
| `maxOutputBytes` | `number` | `2000000` | Cap on collected stdout/stderr bytes per run |

## Tool: `host_exec`

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | `string` | ✅ | The shell command to run |
| `cwd` | `string` | | Working directory; defaults to the host user's home |
| `detach` | `boolean` | | `true` to start detached and return the pid; `false`/omitted = foreground run |
| `timeoutMs` | `number` | | Overrides the default timeout for a foreground run |

### Output

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | Command exited 0 (or detached successfully) |
| `mode` | `string` | `run` (foreground done) / `detached` / `blocked` (filters rejected it) |
| `pid` | `number` | Process pid when `detached` |
| `exitCode` | `number` | Exit code when `run` |
| `timedOut` | `boolean` | Whether the run timed out |
| `stdout` / `stderr` | `string` | Captured output (bounded) |

### Examples

```json
{
  "command": "nvidia-smi",
  "detach": false
}
```

```json
{
  "command": "cd /home/arms/gazebo_ws && ./run_gazebo.sh -n my_sim",
  "cwd": "/home/arms",
  "detach": true
}
```

## Security

> ⚠️ **This plugin deliberately bypasses the file/device sandbox and provides host-level privileges for the commands it runs.** This is equivalent to executing arbitrary commands as the current user on the host. **Mount it only on trusted, private deployments**, and consider narrowing the allowed commands with `allowPrefixes` / `denyPrefixes`.

## Local development & verification

```bash
node --check lib/index.js            # syntax check
# load check (needs @deepseek-ai/* resolvable)
node --input-type=module -e "import('./lib/index.js').then(m=>console.log(m.name, typeof m.apply))"
```

## Directory layout

```
dsh-host-exec/
├── package.json        # name=dsh-host-exec, declares dsh.bundle.patch
├── cordis.patch.yml    # bundle mount declaration (name: dsh-host-exec)
├── lib/
│   └── index.js        # plugin implementation (defines the host_exec tool)
├── README.md           # 中文文档
└── README.en.md        # English docs
```

## Uninstall

```bash
npx @deepseek-ai/dsh plugin --profile web remove dsh-host-exec
```


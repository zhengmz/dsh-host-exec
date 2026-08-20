import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * DSH tool plugin: run commands on the HOST side, bypassing the rootless sandbox.
 *
 * WHY: the normal `bash` tool executes inside a rootless bwrap sandbox that
 * cannot access host resources the sandbox hides (e.g. /dev/nvidia* — verified:
 * open fails even with --cap-add ALL). Tools registered here run directly in the
 * DSH host node process, so a child_process.spawn() inherits the host environment
 * and CAN access whatever the host user can — GPU devices, host tmux sessions,
 * /tmp sockets, etc. This is the sanctioned way to give DSH real host execution,
 * whether or not GPU is involved.
 *
 * SECURITY: this deliberately escapes the file/device sandbox for the commands
 * it runs. Only mount this plugin on a trusted, private deployment.
 */

export const name = "tool-host-exec";

/** Services required by this plugin (must be injected before apply can use ctx.tools). */
export const inject = ["tools"];

export const Config = z
	.object({
		/** Optional allow-list of command prefixes. Empty = allow any command. */
		allowPrefixes: z.array(z.string()).default([]),
		/** Optional deny-list of command prefixes (checked after allow-list). */
		denyPrefixes: z.array(z.string()).default([]),
		/** Default timeout (ms) for foreground (non-detached) runs. */
		defaultTimeoutMs: z.natural().default(300_000),
		/** Cap on collected stdout/stderr bytes per run. */
		maxOutputBytes: z.natural().default(2_000_000)
	})
	.default({});

function decide(v) {
	return v;
}

function checkAllowed(cmd, config) {
	if (config.denyPrefixes.some((p) => cmd.startsWith(p))) {
		return `command is denied by denyPrefixes (${cmd.slice(0, 80)})`;
	}
	if (config.allowPrefixes.length > 0 && !config.allowPrefixes.some((p) => cmd.startsWith(p))) {
		return `command is not in allowPrefixes (${cmd.slice(0, 80)})`;
	}
	return null;
}

/** Collect an async iterable of chunks into a bounded buffer string. */
function collect(stream, cap, sink) {
	return new Promise((resolve) => {
		let bytes = 0;
		let data = "";
		stream.on("data", (chunk) => {
			const s = chunk.toString();
			bytes += s.length;
			if (data.length < cap) data += s.slice(0, cap - data.length);
			try {
				sink?.(s, bytes);
			} catch {
				/* ignore sink errors */
			}
		});
		stream.on("end", () => resolve(data));
		stream.on("error", () => resolve(data));
	});
}

export function apply(ctx, config) {
	const resolved = config;

	ctx.tools.register(
		defineTool({
			name: "host_exec",
			description:
				"Run a command on the HOST (outside the rootless sandbox), with the host user's full environment and device access. " +
				"This deliberately bypasses the bash sandbox so code that needs real host resources works — GPU (/dev/nvidia*, /dev/dri) with nvidia-smi/CUDA/Gazebo-RGL, host tmux sessions, /tmp sockets, etc. " +
				"Use `detach: true` to start a long-running process (e.g. a sim) and return its pid; use `detach: false` (default) to run a command to completion and capture its output (e.g. nvidia-smi for self-checks).",
			parameters: {
				command: {
					type: "string",
					required: true,
					description: "The shell command to run (e.g. `nvidia-smi`, `cd /home/arms/gazebo_ws && ./run_gazebo.sh -e x500_test.world`)."
				},
				cwd: {
					type: "string",
					description: "Working directory for the command. Defaults to the host home."
				},
				detach: {
					type: "boolean",
					description: "If true, start the process detached and return immediately with i ts pid (for long-running sims). If false/omitted, run to completion (or timeout) and capture output."
				},
				timeoutMs: {
					type: "number",
					description: "Timeout in ms for a non-detached run. Defaults to the plugin's defaultTimeoutMs (300000)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true,
							description: "true if the command exited 0 (or was detached successfully)."
						},
						mode: {
							type: "string",
							required: true
						},
						pid: {
							type: "integer",
							description: "pid when mode==='detached'."
						},
						exitCode: {
							type: "integer",
							description: "exit code when mode==='run'."
						},
						timedOut: {
							type: "boolean"
						},
						stdout: {
							type: "string",
							description: "collected stdout (bounded)."
						},
						stderr: {
							type: "string",
							description: "collected stderr (bounded)."
						}
					}
				},
				render: (args, value) => {
					const lines = [];
					if (value.mode === "detached") {
						lines.push(`[detached] pid=${value.pid}`);
					} else {
						lines.push(`[run] exit=${value.exitCode}${value.timedOut ? " TIMED_OUT" : ""} ${value.ok ? "OK" : "FAILED"}`);
					}
					if (value.stdout) lines.push(`--- stdout ---\n${value.stdout}`);
					if (value.stderr) lines.push(`--- stderr ---\n${value.stderr}`);
					return [{ type: "text", text: lines.join("\n") }];
				}
			},
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const blocked = checkAllowed(args.command, resolved);
				if (blocked) {
					return { ok: false, mode: "blocked", stderr: blocked, stdout: "" };
				}

				const cwd = args.cwd ?? process.env.HOME;
				const timeoutMs = args.timeoutMs ?? resolved.defaultTimeoutMs;
				const env = process.env;

				if (args.detach) {
					const child = spawn(args.command, {
						shell: true,
						cwd,
						env,
						detached: true,
						stdio: "ignore"
					});
					child.unref();
					return { ok: true, mode: "detached", pid: child.pid ?? 0, stdout: "", stderr: "" };
				}

				const child = spawn(args.command, { shell: true, cwd, env });

				const outP = collect(child.stdout, resolved.maxOutputBytes);
				const errP = collect(child.stderr, resolved.maxOutputBytes);

				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, timeoutMs);

				const exitCode = await new Promise((resolveExit) => {
					child.on("error", (err) => {
						resolveExit(-1);
					});
					child.on("close", (code) => resolveExit(code ?? -1));
					exec.signal?.addEventListener("abort", () => {
						try {
							child.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					});
				}).finally(() => {
					clearTimeout(timer);
				});

				const [stdout, stderr] = await Promise.all([outP, errP]);

				return {
					ok: !timedOut && exitCode === 0,
					mode: "run",
					exitCode,
					timedOut,
					stdout,
					stderr
				};
			},
			presentResult(_args, result) {
				if (result.isError) return undefined;
				const meta = result.meta;
				if (meta === undefined) return undefined;
				return {
					card: "generic",
					title: `host_exec (${meta.mode ?? "run"})`,
					content: [{ type: "text", text: meta.stdout + meta.stderr }]
				};
			}
		})
	);
}

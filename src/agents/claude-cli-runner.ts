import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("agent/claude-cli");

export type ClaudeCliRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
  }>;
  meta: {
    durationMs: number;
    sessionId?: string;
    model?: string;
    costUsd?: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    aborted?: boolean;
  };
};

type ClaudeJsonResult = {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
};

export type ClaudeCliRunnerParams = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  config?: ClawdbotConfig;
  prompt: string;
  model?: string;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  continueSession?: boolean;
  resumeSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
};

const SESSION_MAP_FILE = ".claude-sessions.json";

async function loadSessionMap(
  workspaceDir: string,
): Promise<Record<string, string>> {
  const mapPath = path.join(workspaceDir, SESSION_MAP_FILE);
  try {
    const content = await fs.readFile(mapPath, "utf-8");
    return JSON.parse(content) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveSessionMap(
  workspaceDir: string,
  map: Record<string, string>,
): Promise<void> {
  const mapPath = path.join(workspaceDir, SESSION_MAP_FILE);
  await fs.writeFile(mapPath, JSON.stringify(map, null, 2), "utf-8");
}

function buildClaudeArgs(params: ClaudeCliRunnerParams): string[] {
  const args: string[] = ["-p", "--output-format", "json"];

  if (params.model) {
    args.push("--model", params.model);
  }

  if (params.systemPrompt) {
    args.push("--system-prompt", params.systemPrompt);
  }
  if (params.appendSystemPrompt) {
    args.push("--append-system-prompt", params.appendSystemPrompt);
  }

  if (params.resumeSessionId) {
    args.push("--resume", params.resumeSessionId);
  } else if (params.continueSession) {
    args.push("--continue");
  }

  if (params.allowedTools?.length) {
    args.push("--allowed-tools", ...params.allowedTools);
  }
  if (params.disallowedTools?.length) {
    args.push("--disallowed-tools", ...params.disallowedTools);
  }

  if (params.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  args.push(params.prompt);

  return args;
}

export async function runClaudeCliAgent(
  params: ClaudeCliRunnerParams,
): Promise<ClaudeCliRunResult> {
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);

  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const sessionMap = await loadSessionMap(resolvedWorkspace);
  const existingClaudeSession = sessionMap[params.sessionId];

  const runParams = {
    ...params,
    resumeSessionId: existingClaudeSession || params.resumeSessionId,
  };
  const args = buildClaudeArgs(runParams);
  const claudeBin = process.env.CLAUDE_CLI_PATH || "/opt/homebrew/bin/claude";

  log.debug(
    `claude-cli run start: runId=${params.runId} sessionId=${params.sessionId} model=${params.model ?? "default"}`,
  );
  log.debug(`claude command: ${claudeBin} ${args.join(" ")}`);
  log.debug(`claude cwd: ${resolvedWorkspace}`);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let aborted = false;

    const proc = spawn(claudeBin, args, {
      cwd: resolvedWorkspace,
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (params.abortSignal) {
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGTERM");
      };
      if (params.abortSignal.aborted) {
        onAbort();
      } else {
        params.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const timeoutId = setTimeout(() => {
      log.warn(
        `claude-cli timeout: runId=${params.runId} timeoutMs=${params.timeoutMs}`,
      );
      aborted = true;
      proc.kill("SIGTERM");
    }, params.timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", async (code) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - started;

      if (stderr && !aborted) {
        log.warn(`claude-cli stderr: ${stderr}`);
      }

      if (aborted) {
        resolve({
          payloads: [{ text: "[Claude CLI timed out or aborted]" }],
          meta: { durationMs, aborted: true },
        });
        return;
      }

      if (code !== 0) {
        log.error(`claude-cli exited with code ${code}: runId=${params.runId}`);
        reject(
          new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`),
        );
        return;
      }

      let result: ClaudeJsonResult | null = null;
      try {
        const lines = stdout.trim().split("\n");
        for (const line of lines.reverse()) {
          try {
            const parsed = JSON.parse(line) as { type?: string };
            if (parsed.type === "result") {
              result = parsed as ClaudeJsonResult;
              break;
            }
          } catch {
            continue;
          }
        }
        if (!result) {
          result = JSON.parse(stdout) as ClaudeJsonResult;
        }
      } catch (err) {
        log.error(`Failed to parse claude output: ${stdout.substring(0, 500)}`);
        reject(new Error(`Failed to parse Claude CLI output: ${String(err)}`));
        return;
      }

      if (result.session_id) {
        sessionMap[params.sessionId] = result.session_id;
        await saveSessionMap(resolvedWorkspace, sessionMap);
      }

      let totalInput = result.usage?.input_tokens ?? 0;
      let totalOutput = result.usage?.output_tokens ?? 0;
      let totalCacheRead = result.usage?.cache_read_input_tokens ?? 0;
      let totalCacheWrite = result.usage?.cache_creation_input_tokens ?? 0;
      let primaryModel = params.model ?? "unknown";

      if (result.modelUsage) {
        const models = Object.keys(result.modelUsage);
        if (models.length > 0) {
          primaryModel = models[0];
          for (const modelData of Object.values(result.modelUsage)) {
            totalInput += modelData.inputTokens ?? 0;
            totalOutput += modelData.outputTokens ?? 0;
            totalCacheRead += modelData.cacheReadInputTokens ?? 0;
            totalCacheWrite += modelData.cacheCreationInputTokens ?? 0;
          }
        }
      }

      log.debug(
        `claude-cli done: runId=${params.runId} durationMs=${durationMs} cost=$${result.total_cost_usd?.toFixed(4) ?? "?"}`,
      );

      resolve({
        payloads: result.result ? [{ text: result.result }] : undefined,
        meta: {
          durationMs,
          sessionId: result.session_id,
          model: primaryModel,
          costUsd: result.total_cost_usd,
          usage: {
            input: totalInput,
            output: totalOutput,
            cacheRead: totalCacheRead,
            cacheWrite: totalCacheWrite,
          },
          aborted,
        },
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      log.error(`claude-cli spawn error: ${String(err)}`);
      reject(err);
    });
  });
}

export async function isClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const claudeBin = process.env.CLAUDE_CLI_PATH || "/opt/homebrew/bin/claude";
    const proc = spawn(claudeBin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

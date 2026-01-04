#!/usr/bin/env tsx
/**
 * Sync OAuth credentials from Claude Code CLI to Clawdbot
 * Usage: pnpm tsx scripts/sync-claude-oauth.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CLAUDE_CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const CLAWDBOT_OAUTH_PATH = path.join(os.homedir(), ".clawdbot", "credentials", "oauth.json");
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

interface ClawdbotOAuth {
  anthropic?: {
    access: string;
    refresh: string;
    expires: number;
  };
}

async function refreshToken(refreshToken: string): Promise<{
  access: string;
  refresh: string;
  expires: number;
}> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS,
  };
}

async function main() {
  if (!fs.existsSync(CLAUDE_CREDS_PATH)) {
    console.error(`Claude credentials not found at ${CLAUDE_CREDS_PATH}`);
    console.error("Run 'claude' CLI first to authenticate.");
    process.exit(1);
  }

  const claudeCreds: ClaudeCredentials = JSON.parse(
    fs.readFileSync(CLAUDE_CREDS_PATH, "utf8")
  );

  if (!claudeCreds.claudeAiOauth) {
    console.error("No OAuth credentials found in Claude config");
    process.exit(1);
  }

  const { accessToken, refreshToken: refresh, expiresAt } = claudeCreds.claudeAiOauth;
  const isExpired = Date.now() > expiresAt - REFRESH_THRESHOLD_MS;

  let finalCreds: { access: string; refresh: string; expires: number };

  if (isExpired) {
    console.log("Token expired or expiring soon, refreshing...");
    finalCreds = await refreshToken(refresh);
    console.log(`Token refreshed, new expiry: ${new Date(finalCreds.expires).toISOString()}`);
  } else {
    console.log(`Token valid until ${new Date(expiresAt).toISOString()}`);
    finalCreds = { access: accessToken, refresh, expires: expiresAt };
  }

  const dir = path.dirname(CLAWDBOT_OAUTH_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let existing: ClawdbotOAuth = {};
  if (fs.existsSync(CLAWDBOT_OAUTH_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CLAWDBOT_OAUTH_PATH, "utf8"));
    } catch {
      existing = {};
    }
  }

  existing.anthropic = finalCreds;

  fs.writeFileSync(CLAWDBOT_OAUTH_PATH, JSON.stringify(existing, null, 2) + "\n", {
    mode: 0o600,
  });

  console.log(`Synced to ${CLAWDBOT_OAUTH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

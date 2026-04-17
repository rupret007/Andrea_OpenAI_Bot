import fs from 'fs';
import os from 'os';
import path from 'path';

export const CODEX_AUTH_SEED_FILES = [
  'auth.json',
  'config.toml',
  'cap_sid',
] as const;

export function resolveHostCodexHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CODEX_HOME?.trim()) {
    return path.resolve(env.CODEX_HOME.trim());
  }

  const homeDir = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(homeDir, '.codex');
}

export function hasHostCodexAuthMaterial(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const hostCodexHome = resolveHostCodexHome(env);
  return CODEX_AUTH_SEED_FILES.some((file) =>
    fs.existsSync(path.join(hostCodexHome, file)),
  );
}

export function seedCodexHomeFromHost(
  targetCodexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const hostCodexHome = resolveHostCodexHome(env);
  if (!fs.existsSync(hostCodexHome)) {
    return [];
  }

  fs.mkdirSync(targetCodexHome, { recursive: true });

  const copied: string[] = [];
  for (const file of CODEX_AUTH_SEED_FILES) {
    const sourcePath = path.join(hostCodexHome, file);
    if (!fs.existsSync(sourcePath)) continue;

    const targetPath = path.join(targetCodexHome, file);
    let shouldCopy = !fs.existsSync(targetPath);
    if (!shouldCopy) {
      try {
        const sourceBuffer = fs.readFileSync(sourcePath);
        const targetBuffer = fs.readFileSync(targetPath);
        shouldCopy = !sourceBuffer.equals(targetBuffer);
      } catch {
        shouldCopy = true;
      }
    }

    if (!shouldCopy) continue;

    fs.copyFileSync(sourcePath, targetPath);
    copied.push(file);
  }

  return copied;
}

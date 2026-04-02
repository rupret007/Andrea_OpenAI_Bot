import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { assertValidGroupFolder } from './group-folder.js';
import type { RegisteredGroup } from './types.js';

export interface LoopbackGroupRegistrationRequest {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  isMain: boolean;
}

export interface LoopbackRegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  isMain: boolean;
}

export interface LoopbackGroupRegistrationResult {
  group: LoopbackRegisteredGroup;
  created: boolean;
}

export class RegisteredGroupConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegisteredGroupConflictError';
  }
}

export interface GroupRegistrationDependencies {
  assistantName: string;
  groupsDir: string;
  registeredGroups: Record<string, RegisteredGroup>;
  persistGroup(jid: string, group: RegisteredGroup): void;
  ensureOneClIAgent?(jid: string, group: RegisteredGroup): void;
}

function trimNonEmptyString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return trimmed;
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

function resolveGroupDir(groupsDir: string, folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(groupsDir, folder);
  ensureWithinBase(groupsDir, groupPath);
  return groupPath;
}

function normalizeStoredGroup(
  jid: string,
  group: RegisteredGroup,
): LoopbackRegisteredGroup {
  return {
    jid: trimNonEmptyString(jid, 'jid'),
    name: trimNonEmptyString(group.name, 'name'),
    folder: trimNonEmptyString(group.folder, 'folder'),
    trigger: trimNonEmptyString(group.trigger, 'trigger'),
    addedAt: trimNonEmptyString(group.added_at, 'addedAt'),
    requiresTrigger: group.requiresTrigger !== false,
    isMain: group.isMain === true,
  };
}

function toStoredGroup(
  request: LoopbackGroupRegistrationRequest,
): RegisteredGroup {
  return {
    name: request.name,
    folder: request.folder,
    trigger: request.trigger,
    added_at: request.addedAt,
    requiresTrigger: request.requiresTrigger,
    isMain: request.isMain,
  };
}

function stableGroupFieldsMatch(
  current: LoopbackRegisteredGroup,
  next: LoopbackRegisteredGroup,
): boolean {
  return (
    current.jid === next.jid &&
    current.name === next.name &&
    current.folder === next.folder &&
    current.trigger === next.trigger &&
    current.requiresTrigger === next.requiresTrigger &&
    current.isMain === next.isMain
  );
}

function seedClaudeTemplate(
  assistantName: string,
  groupsDir: string,
  group: RegisteredGroup,
): void {
  const groupMdFile = path.join(groupsDir, group.folder, 'CLAUDE.md');
  if (fs.existsSync(groupMdFile)) return;

  const templateFile = path.join(
    groupsDir,
    group.isMain ? 'main' : 'global',
    'CLAUDE.md',
  );
  if (!fs.existsSync(templateFile)) return;

  let content = fs.readFileSync(templateFile, 'utf-8');
  if (assistantName !== 'Andy') {
    content = content.replace(/^# Andy$/m, `# ${assistantName}`);
    content = content.replace(/You are Andy/g, `You are ${assistantName}`);
  }
  fs.writeFileSync(groupMdFile, content);
  logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
}

export function registerGroupOrThrow(
  jid: string,
  group: RegisteredGroup,
  deps: GroupRegistrationDependencies,
): void {
  const groupDir = resolveGroupDir(deps.groupsDir, group.folder);

  deps.registeredGroups[jid] = group;
  deps.persistGroup(jid, group);

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  seedClaudeTemplate(deps.assistantName, deps.groupsDir, group);
  deps.ensureOneClIAgent?.(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

export function ensureLoopbackRegisteredGroup(
  request: LoopbackGroupRegistrationRequest,
  deps: GroupRegistrationDependencies,
): LoopbackGroupRegistrationResult {
  const normalizedRequest: LoopbackGroupRegistrationRequest = {
    jid: trimNonEmptyString(request.jid, 'jid'),
    name: trimNonEmptyString(request.name, 'name'),
    folder: trimNonEmptyString(request.folder, 'folder'),
    trigger: trimNonEmptyString(request.trigger, 'trigger'),
    addedAt: trimNonEmptyString(request.addedAt, 'addedAt'),
    requiresTrigger: request.requiresTrigger,
    isMain: request.isMain,
  };

  const requestedGroup: LoopbackRegisteredGroup = {
    ...normalizedRequest,
  };

  const existingByJidGroup = deps.registeredGroups[normalizedRequest.jid];
  const existingByJid = existingByJidGroup
    ? normalizeStoredGroup(normalizedRequest.jid, existingByJidGroup)
    : null;

  const folderMatch = Object.entries(deps.registeredGroups).find(
    ([, group]) => group.folder === normalizedRequest.folder,
  );
  const existingByFolder = folderMatch
    ? normalizeStoredGroup(folderMatch[0], folderMatch[1])
    : null;

  if (existingByJid && existingByJid.folder !== normalizedRequest.folder) {
    throw new RegisteredGroupConflictError(
      `Registered group conflict: JID "${normalizedRequest.jid}" is already mapped to folder "${existingByJid.folder}".`,
    );
  }

  if (existingByFolder && existingByFolder.jid !== normalizedRequest.jid) {
    throw new RegisteredGroupConflictError(
      `Registered group conflict: folder "${normalizedRequest.folder}" is already mapped to JID "${existingByFolder.jid}".`,
    );
  }

  if (existingByFolder) {
    if (stableGroupFieldsMatch(existingByFolder, requestedGroup)) {
      return {
        group: existingByFolder,
        created: false,
      };
    }

    throw new RegisteredGroupConflictError(
      `Registered group conflict: folder "${normalizedRequest.folder}" already exists with different metadata.`,
    );
  }

  const storedGroup = toStoredGroup(normalizedRequest);
  registerGroupOrThrow(normalizedRequest.jid, storedGroup, deps);

  return {
    group: normalizeStoredGroup(normalizedRequest.jid, storedGroup),
    created: true,
  };
}

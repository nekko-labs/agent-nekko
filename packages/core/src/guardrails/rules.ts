import type { GuardrailRule } from '@agent-nekko/shared';

/**
 * Default guardrail ruleset. These ship enabled out of the box so that risky
 * shell commands prompt the user before running. Patterns are intentionally
 * conservative, they err toward "ask" rather than silent "deny".
 */
export const DEFAULT_GUARDRAILS: GuardrailRule[] = [
  {
    id: 'rm-rf',
    label: 'Recursive force delete',
    description: 'Deleting directories recursively and forcefully (rm -rf, Remove-Item -Recurse -Force).',
    pattern: String.raw`\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r|Remove-Item\b.*-Recurse|rmdir\s+/s`,
    severity: 'high',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'disk-write',
    label: 'Raw disk / device write',
    description: 'Writing directly to a disk device (dd, mkfs, format).',
    pattern: String.raw`\bdd\s+if=|\bmkfs\b|\bformat\s+[A-Za-z]:|>\s*/dev/sd`,
    severity: 'high',
    action: 'deny',
    enabled: true,
  },
  {
    id: 'force-push',
    label: 'Git force push',
    description: 'Force-pushing can overwrite remote history.',
    pattern: String.raw`git\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)`,
    severity: 'medium',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'git-reset-hard',
    label: 'Git hard reset / clean',
    description: 'Discards uncommitted work irreversibly.',
    pattern: String.raw`git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f`,
    severity: 'medium',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'curl-pipe-sh',
    label: 'Pipe download to shell',
    description: 'Executing a remotely downloaded script (curl|sh, iwr|iex).',
    pattern: String.raw`(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh|iwr\b.*\|\s*iex|Invoke-Expression`,
    severity: 'high',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'privilege-esc',
    label: 'Privilege escalation',
    description: 'Running commands as root/admin (sudo, runas).',
    pattern: String.raw`\bsudo\b|\brunas\b|Start-Process\b.*-Verb\s+RunAs`,
    severity: 'medium',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'registry-edit',
    label: 'Windows registry edit',
    description: 'Modifying the Windows registry.',
    pattern: String.raw`\breg\s+(add|delete)\b|Set-ItemProperty\b.*HK(LM|CU):|New-ItemProperty\b.*HK`,
    severity: 'medium',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'kill-process',
    label: 'Kill processes broadly',
    description: 'Killing processes by name or all (killall, pkill, taskkill /F).',
    pattern: String.raw`\bkillall\b|\bpkill\b|taskkill\b.*/F`,
    severity: 'low',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'package-global',
    label: 'Global package install',
    description: 'Installing packages globally can change the system toolchain.',
    pattern: String.raw`npm\s+i(nstall)?\s+-g\b|pip\s+install\b.*--user\b|choco\s+install\b`,
    severity: 'low',
    action: 'ask',
    enabled: true,
  },
  {
    id: 'secret-exfil',
    label: 'Reading secrets / env files',
    description: 'Accessing credential stores or .env files.',
    pattern: String.raw`\.env\b|id_rsa\b|\.ssh/|credentials\.json|\.aws/credentials`,
    severity: 'medium',
    action: 'ask',
    enabled: true,
  },
];

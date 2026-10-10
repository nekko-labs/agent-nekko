import type {
  GuardrailRule,
  GuardrailDecision,
  GuardrailMatch,
  GuardrailAction,
  GuardrailSeverity,
} from '@agent-nekko/shared';
import { DEFAULT_GUARDRAILS } from './rules.js';

const ACTION_RANK: Record<GuardrailAction, number> = { allow: 0, ask: 1, deny: 2 };
const SEVERITY_RANK: Record<GuardrailSeverity, number> = { low: 0, medium: 1, high: 2 };

/**
 * Classify a shell command (or tool input string) against a ruleset and
 * return the strongest action to take. Pure + synchronous so it is trivially
 * unit-testable and can run in either process.
 */
export function classifyCommand(
  command: string,
  rules: GuardrailRule[] = DEFAULT_GUARDRAILS,
): GuardrailDecision {
  const matches: GuardrailMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      continue; // skip malformed user-authored patterns
    }
    const m = re.exec(command);
    if (m) {
      matches.push({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        action: rule.action,
        evidence: m[0],
      });
    }
  }

  if (matches.length === 0) {
    return { action: 'allow', severity: 'low', matches };
  }

  const action = matches.reduce<GuardrailAction>(
    (acc, m) => (ACTION_RANK[m.action] > ACTION_RANK[acc] ? m.action : acc),
    'allow',
  );
  const severity = matches.reduce<GuardrailSeverity>(
    (acc, m) => (SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc] ? m.severity : acc),
    'low',
  );

  return { action, severity, matches };
}

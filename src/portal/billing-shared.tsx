import {Badge, type Tone} from './ui';

/** 1 GB, 250 MB, 12.5 KB: for plan limits and storage used. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Shown wherever checkout appears: payments are sandbox until the owner connects a live gateway. */
export function TestModeBadge({mode = 'test'}: {mode?: 'test' | 'live' | null}) {
  if (mode === 'live') return null;
  return (
    <Badge tone="warning" icon="warning">
      Test mode: no real money moves
    </Badge>
  );
}

const PLAN_TONE: Record<string, Tone> = {free: 'neutral', pro: 'brand', team: 'info'};
export const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

export function PlanBadge({plan}: {plan: string}) {
  return <Badge tone={PLAN_TONE[plan] ?? 'neutral'}>{planLabel(plan)}</Badge>;
}

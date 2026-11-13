// Public API of the portable billing module (src/billing).

export type LimitKey = "agents" | "seats" | (string & {});

export interface Plan {
  id: string;
  name: string;
  hosted: boolean;
  paid: boolean;
  summary: string;
  limits: Partial<Record<LimitKey, number>>;
  features: readonly string[];
}

export type PlanCatalog = Readonly<Record<string, Plan>>;

export interface Entitlements {
  plan: string;
  planName: string;
  paid: boolean;
  enforced: boolean;
  limits: Partial<Record<LimitKey, number>>;
  upgradeTo: { id: string; name: string; limits: Partial<Record<LimitKey, number>> } | null;
}

export interface EntitlementDecision {
  feature: LimitKey;
  allowed: boolean;
  wouldExceed: boolean;
  used: number;
  limit: number | null;
  plan: string;
  upgradeTo: Entitlements["upgradeTo"];
}

export interface BillingConfig {
  enabled: boolean;
  stripeMode: "live" | "test";
  publicPricing: boolean;
  enforceEntitlements: boolean;
  required: string[];
  missing: string[];
  errors: string[];
}

export const DEFAULT_PLANS: PlanCatalog;
export const PAID_STATUSES: readonly string[];
export function listPlans(catalog?: PlanCatalog): Plan[];
export function isPaidStatus(status: string | null | undefined): boolean;
export function planForStatus(status: string | null | undefined, catalog?: PlanCatalog): Plan;
export function upgradePlan(catalog?: PlanCatalog): Plan | null;

export function entitlementsFor(input?: { status?: string | null; enforced?: boolean; catalog?: PlanCatalog }): Entitlements;
export function checkLimit(entitlements: Entitlements, feature: LimitKey, used: number, adding?: number): EntitlementDecision;
export function requireLimit(entitlements: Entitlements, feature: LimitKey, used: number, adding?: number, upgradeUrl?: string): EntitlementDecision;
export class EntitlementError extends Error {
  constructor(decision: EntitlementDecision, upgradeUrl?: string);
  status: 402;
  body: {
    code: "plan_limit";
    feature: LimitKey;
    limit: number | null;
    used: number;
    plan: string;
    upgrade: { plan: string; url: string } | null;
  };
}

export function resolveBillingConfig(env?: Record<string, string | undefined>, options?: { prefix?: string }): BillingConfig;
export function priceLabel(input: { billing: boolean; stripeMode: string; amount?: number; currency?: string; interval?: string }): string;

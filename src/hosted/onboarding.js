// First-run checklist for a new workspace. The value moment is the first
// synced receipt: the owner sees a real agent's spend in the hosted view.
export const ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ id: "token", title: "Set caps and create an enrollment token" }),
  Object.freeze({ id: "enroll", title: "Enroll an agent from its machine" }),
  Object.freeze({ id: "receipt", title: "Run the agent wrapped and see its first receipt" }),
]);

export function onboardingState({ tokensIssued = 0, agents = 0, receipts = 0 } = {}) {
  const done = {
    token: tokensIssued > 0 || agents > 0,
    enroll: agents > 0,
    receipt: receipts > 0,
  };
  const steps = ONBOARDING_STEPS.map((step) => ({ ...step, done: done[step.id] }));
  const next = steps.find((step) => !step.done)?.id ?? null;
  return { steps, next, complete: next === null };
}

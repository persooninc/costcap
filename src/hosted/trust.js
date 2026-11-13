// FA-CC-02 public trust pages as data. Portable: no I/O, no env, no app globals.
// The host app renders them (see trustPageHtml in ui.js) and injects the operator
// name and contact. Copy must stay consistent with README "Enforcement limits":
// no compliance certifications, no bill guarantees.

export const TRUST_UPDATED = "2026-11-13";
export const DEFAULT_CONTACT = Object.freeze({
  label: "GitHub issues (persooninc/costcap)",
  url: "https://github.com/persooninc/costcap/issues",
});
export const SECURITY_REPORT_URL = "https://github.com/persooninc/costcap/security/advisories/new";

export const TRUST_ROUTES = Object.freeze([
  Object.freeze({ path: "/privacy", priority: 0.3, changefreq: "yearly" }),
  Object.freeze({ path: "/terms", priority: 0.3, changefreq: "yearly" }),
  Object.freeze({ path: "/security", priority: 0.3, changefreq: "yearly" }),
]);

/**
 * @typedef {{ heading: string, items: string[] }} TrustSection  items are plain text; the renderer escapes them
 * @typedef {{ path: string, title: string, heading: string, description: string, lede: string, sections: TrustSection[] }} TrustDoc
 * @param {string} path
 * @param {{ operator?: string, contact?: { label: string, url: string }, product?: string }} [options]
 * @returns {TrustDoc|null}
 */
export function trustDocument(path, { operator = "Persoon.ai Inc", contact = DEFAULT_CONTACT, product = "CostCap" } = {}) {
  const reach = `${contact.label}: ${contact.url}`;
  if (path === "/privacy") return {
    path, title: `${product} | Privacy`, heading: "Privacy",
    description: `What ${product} stores for the local CLI and the hosted workspace, where it lives, and how to delete it.`,
    lede: `${product} is a development beta operated by ${operator}. This page says what we store and why. It is not a compliance certification.`,
    sections: [
      { heading: "The local CLI", items: [
        "The CLI and its metering proxy run on your machine. They send nothing to us.",
        "Receipts are written to a local file. A receipt holds the provider, request path, HTTP status, model id, token counts, estimated USD cost, and a block reason if one applied.",
        "Receipts never contain request or response bodies, prompts, completions, API keys, or authorization headers.",
      ] },
      { heading: "The hosted workspace", items: [
        "Account: your email address, your organization, and your role (owner, admin, or viewer). Sign-in codes and session cookies are stored only as hashes.",
        "Agents: the name you give each enrolled agent, its caps, a hash of its credential, and when it last checked in.",
        "Receipts: an enrolled agent syncs the same receipt fields as the CLI. There are no bodies and no auth headers.",
        "Audit log and alerts for your organization.",
        "Billing, when it is turned on: Stripe customer and subscription ids and their status. Card details go to Stripe, never to us.",
      ] },
      { heading: "Processors", items: [
        "Cloudflare Turnstile checks the sign-in form for bots.",
        "Brevo delivers sign-in codes and invitations.",
        "Stripe handles checkout and the billing portal when billing is on. Until the owner switches to live mode it runs in test mode, with no real charges.",
        "Google Analytics (GA4) measures visits to the public pages.",
      ] },
      { heading: "Where data lives", items: [
        `Hosted workspace data sits in one datastore on a single server run by ${operator}. It is not replicated across regions. The service is not built for high availability.`,
        "Only the costcap_session cookie is set for sign-in. It is HttpOnly, SameSite=Strict, and expires after 24 hours.",
      ] },
      { heading: "Retention and deletion", items: [
        "Workspace data stays while the workspace exists. Your plan sets how far back receipts are shown.",
        "To delete a workspace or an account, contact us from the owner's email address. We confirm the request against that address before deleting anything.",
        `Contact: ${reach}. Do not post personal data in a public issue. Ask for a private channel instead.`,
      ] },
    ],
  };
  if (path === "/terms") return {
    path, title: `${product} | Terms`, heading: "Terms of use",
    description: `${product} beta terms: guardrails, not guarantees. CLI under the MIT license; hosted workspace as-is.`,
    lede: `These terms cover the ${product} CLI and the hosted workspace operated by ${operator}. Using either means you accept them.`,
    sections: [
      { heading: "Beta, as-is", items: [
        `${product} is a development beta. It is provided as-is, without warranty of any kind. The CLI is open source under the MIT license.`,
        "The service may change, pause, or end. We will give notice in the product where we can.",
      ] },
      { heading: "Guardrails, not guarantees", items: [
        "Only proxy-routed traffic is capped. SDKs that ignore the base URL, hardcoded endpoints, and subprocesses that drop the environment bypass the cap.",
        "Cost is metered after each response, so one accepted call can exceed the remaining cap. It is not a prepaid reservation.",
        "Costs are estimates from a versioned price table, not your provider's bill. You remain responsible for your provider accounts and their charges.",
      ] },
      { heading: "Your account", items: [
        "Keep enrollment tokens and agent credentials secret. Revoke an agent you no longer trust.",
        "Do not use the service to break the law, to attack other systems, or to get around another service's limits.",
        "We may suspend a workspace that puts the service or other users at risk.",
      ] },
      { heading: "Paid plans", items: [
        "Paid workspace plans renew monthly until you cancel. Cancel in the billing portal; cancellation stops the next renewal.",
        "Paid status comes from the payment provider's readback, never from a return URL. When a plan ends, existing agents keep running. A workspace over the free limits cannot add agents or people until it is back under them.",
        "While billing runs in Stripe test mode, no real charge is made.",
      ] },
      { heading: "Liability", items: [
        `To the extent the law allows, ${operator} is not liable for indirect or consequential losses, or for provider spend that a cap did not stop.`,
        `Questions: ${reach}.`,
      ] },
    ],
  };
  if (path === "/security") return {
    path, title: `${product} | Security`, heading: "Security",
    description: `How ${product} handles credentials, receipts, and tenant isolation, and how to report a vulnerability.`,
    lede: "This is what we do today. We hold no SOC 2 or ISO certification and do not claim one.",
    sections: [
      { heading: "What the proxy stores", items: [
        "The local proxy forwards your provider API key upstream but never writes it to a receipt or a log.",
        "Receipts hold usage and cost metadata only: no prompts, no completions, no request bodies, no authorization headers.",
        "The proxy binds to 127.0.0.1. It is not an authentication boundary against other processes on the same machine.",
      ] },
      { heading: "Hosted workspace", items: [
        "Sign-in uses a one-time email code behind a bot check. Codes, sessions, enrollment tokens, and agent credentials are stored only as SHA-256 hashes.",
        "Every query is scoped to your organization. A shared company email domain never grants access to another workspace.",
        "Browser mutations require a same-origin request. Session cookies are HttpOnly and SameSite=Strict.",
        "Pages use a strict Content-Security-Policy with no inline scripts.",
        "The Postgres backend, when the owner turns it on, uses separate migration and application roles and row-level security per organization.",
      ] },
      { heading: "Engineering", items: [
        "Every change runs tests, a dependency audit, and a secret scan in CI before merge.",
        "Secrets live in deployment secrets, never in the repository.",
      ] },
      { heading: "Report a vulnerability", items: [
        `Report privately through GitHub security advisories: ${SECURITY_REPORT_URL}. Please do not open a public issue for a vulnerability.`,
        "We aim to acknowledge a report within three business days.",
      ] },
    ],
  };
  return null;
}

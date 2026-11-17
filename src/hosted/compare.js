// /compare: an honest comparison with the spend controls people already have.
// Every claim about another product links to that vendor's own docs. No prices.
import { absoluteUrl, htmlEscape, openGraphTags } from './seo.js';

export const COMPARE_PATH = '/compare';
export const BUNDLE_URL = 'https://agentcontroltower.io/pricing';
export const COMPARE_TITLE = 'CostCap compared with provider spend limits and cloud budgets';
export const COMPARE_DESCRIPTION = 'How the CostCap local spend cap compares with OpenAI and Anthropic account limits and AWS Budgets alerts for AI agent spend.';

export const COMPARE_ROWS = Object.freeze([
  {
    name: 'OpenAI usage limits',
    them: 'OpenAI sets rate limits and usage tiers on the organization account; limits apply to the account, not to one agent run.',
    us: 'CostCap wraps one agent with a local proxy and stops further API calls once that agent run reaches its own USD cap.',
    pick: 'Keep the account limit as the backstop. Add CostCap when one runaway agent must not spend the whole account budget.',
    source: 'https://platform.openai.com/docs/guides/rate-limits',
  },
  {
    name: 'Anthropic spend limits',
    them: 'Anthropic documents spend limits and rate limits per organization usage tier.',
    us: 'CostCap caps per run, per day and per month for each enrolled agent, and catches retry loops locally before the next request.',
    pick: 'Keep the organization spend limit. Add CostCap for per-agent caps inside it.',
    source: 'https://docs.anthropic.com/en/api/rate-limits',
  },
  {
    name: 'AWS Budgets',
    them: 'AWS Budgets tracks cost against a threshold you set and sends alerts, and can run budget actions.',
    us: 'CostCap acts at request time on model API calls from the agent; it does not track your cloud bill.',
    pick: 'Use AWS Budgets for the cloud bill. Use CostCap for model spend from agents, including non-AWS providers.',
    source: 'https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html',
  },
]);

export function comparePage(origin, footer = '') {
  const rows = COMPARE_ROWS.map((r) => `<section class="card"><h2>CostCap vs. ${htmlEscape(r.name)}</h2><p><strong>${htmlEscape(r.name)}:</strong> ${htmlEscape(r.them)} <a href="${htmlEscape(r.source)}" rel="nofollow noopener">Source</a></p><p><strong>CostCap:</strong> ${htmlEscape(r.us)}</p><p><strong>When to pick which:</strong> ${htmlEscape(r.pick)}</p></section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${htmlEscape(COMPARE_DESCRIPTION)}"><title>${htmlEscape(COMPARE_TITLE)}</title><link rel="canonical" href="${absoluteUrl(origin, COMPARE_PATH)}">${openGraphTags(origin, COMPARE_PATH, COMPARE_TITLE, COMPARE_DESCRIPTION)}<link rel="stylesheet" href="/assets/app.css"><script async src="https://www.googletagmanager.com/gtag/js?id=G-P6NP48RRGC"></script><script src="/assets/ga.js" defer></script></head>
<body><header><a class="brand" href="/">CostCap<span class="badge">FREE BETA</span></a><a href="/cli">Free CLI</a></header>
<main class="doc" data-page="compare"><p class="eyebrow">COMPARE</p><h1>CostCap compared</h1><p class="lede">CostCap is a guardrail, not a guarantee. It does not replace the limits your provider or cloud already offers; it adds a cap per agent. Claims about other tools link to their own documentation.</p>${rows}<section class="card"><h2>Part of Agent Guardrails</h2><p>CostCap is one of the Agent Guardrails tools, with KeyLeash for scoped credentials and AgentPager for stall alerts. <a href="${BUNDLE_URL}">See the Agent Guardrails bundle</a>.</p></section></main>${footer}</body></html>`;
}

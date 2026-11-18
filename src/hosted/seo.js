// Public-discovery files for the landing. Search controls are not access control.
// IndexNow is omitted: it needs an owner key (residue).
import { TRUST_ROUTES } from "./trust.js";

export const PUBLIC_ORIGIN = "https://costcap.dev";
export const CONTENT_LASTMOD = "2026-11-13";

// Single allowlist for sitemap, canonical, and structured data.
export const PUBLIC_ROUTES = Object.freeze([
  Object.freeze({ path: "/", priority: 1.0, changefreq: "weekly" }),
  Object.freeze({ path: "/cli", priority: 0.8, changefreq: "monthly" }),
  Object.freeze({ path: "/compare", priority: 0.6, changefreq: "monthly" }),
  ...TRUST_ROUTES,
]);

// Served and listed only behind the COSTCAP_PUBLIC_PRICING owner gate.
export const PRICING_ROUTE = Object.freeze({ path: "/pricing", priority: 0.7, changefreq: "monthly" });

// Open Graph copy for the landing. Names the product category, not a guarantee.
export const OG_TITLE = "CostCap: a local spend cap for AI agents";
export const OG_DESCRIPTION = "Wrap an AI agent with a local proxy that stops further API calls once its spend cap is reached. Free CLI. Guardrails, not guarantees.";

const FREE_DESCRIPTION = "Free beta spend guardrails for your AI agent fleet. Guardrails, not guarantees.";
const PLAN_DESCRIPTION = "Free CLI spend guardrails for your AI agent fleet. Optional $19/month hosted workspace plan. Guardrails, not a provider-bill guarantee.";

// One description for meta tags and structured data, so they match the visible copy.
export function description(billing = false) {
  return billing ? PLAN_DESCRIPTION : FREE_DESCRIPTION;
}

export function canonicalOrigin(origin = PUBLIC_ORIGIN) {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("origin must be http(s)");
  return `${url.protocol}//${url.host}`;
}

export function absoluteUrl(origin, path) {
  const base = canonicalOrigin(origin);
  if (path === "/" || path === "") return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`.replace(/\/$/, "");
}

export function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// og:title, og:description, og:type, og:url for one public path.
export function openGraphTags(origin, path, title = OG_TITLE, summary = OG_DESCRIPTION) {
  return [
    ["og:type", "website"],
    ["og:site_name", "CostCap"],
    ["og:title", title],
    ["og:description", summary],
    ["og:url", absoluteUrl(origin, path)],
    ["og:image", absoluteUrl(origin, OG_IMAGE_PATH)],
    ["og:image:width", "1200"],
    ["og:image:height", "630"],
    ["og:image:alt", OG_IMAGE_ALT],
  ].map(([property, content]) => `<meta property="${property}" content="${htmlEscape(content)}">`).join("")
    + [
      ["twitter:card", "summary_large_image"],
      ["twitter:title", title],
      ["twitter:description", summary],
      ["twitter:image", absoluteUrl(origin, OG_IMAGE_PATH)],
      ["twitter:image:alt", OG_IMAGE_ALT],
    ].map(([name, content]) => `<meta name="${name}" content="${htmlEscape(content)}">`).join("");
}

export const OG_IMAGE_PATH = "/og.png";
export const OG_IMAGE_ALT = "CostCap: spend caps for AI agents. Guardrails, not guarantees.";
export const ROBOTS_META = '<meta name="robots" content="index, follow, max-image-preview:large">';

// Hosts that are the public marketing root (the apex), not the app.
export const APEX_HOSTS = Object.freeze(["costcap.dev", "www.costcap.dev"]);
export function isApexHost(host) {
  return APEX_HOSTS.includes(String(host ?? "").toLowerCase().replace(/:\d+$/, ""));
}

// llms.txt (llmstxt.org): a plain-text summary for AI crawlers.
export function llmsTxt(appOrigin = "https://app.costcap.dev") {
  const app = canonicalOrigin(appOrigin);
  return [
    "# CostCap",
    "",
    "> Spend guardrails for AI agents: a local metering proxy that meters, caps and hard-stops proxy-routed LLM API spend. Free CLI, optional hosted workspace. Guardrails, not guarantees.",
    "",
    "CostCap wraps an agent process with a local proxy. Once a USD cap (per run, day or month) or a step limit is reached, further provider calls are refused. Supports OpenAI, Anthropic, Gemini, OpenRouter and Bedrock style endpoints.",
    "",
    "Limits: only proxy-routed traffic is capped; one accepted call can exceed the remaining cap; costs are estimates from a versioned price table, not your provider bill.",
    "",
    "## Links",
    "",
    `- [Home](${PUBLIC_ORIGIN}/): what CostCap is`,
    `- [CLI](${app}/cli): install and wrap an agent`,
    `- [Hosted workspace](${app}/): fleet caps, alerts and kill switch`,
    `- [Comparison](${app}/compare): how CostCap compares`,
    "- [Source](https://github.com/persooninc/costcap): MIT licensed",
    "",
  ].join("\n");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function robotsTxt(origin = PUBLIC_ORIGIN) {
  const base = canonicalOrigin(origin);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /auth/",
    "Disallow: /v1/",
    "Disallow: /health",
    "Disallow: /api/health/",
    "Disallow: /ui/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml(origin = PUBLIC_ORIGIN, lastmod = CONTENT_LASTMOD, routes = PUBLIC_ROUTES) {
  const base = canonicalOrigin(origin);
  const urls = routes.map((route) => {
    const loc = xmlEscape(absoluteUrl(base, route.path));
    return [
      "  <url>",
      `    <loc>${loc}</loc>`,
      `    <lastmod>${xmlEscape(lastmod)}</lastmod>`,
      `    <changefreq>${xmlEscape(route.changefreq)}</changefreq>`,
      `    <priority>${route.priority.toFixed(1)}</priority>`,
      "  </url>",
    ].join("\n");
  }).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

// With billing on, the page offers a paid plan, so no zero-price Offer is emitted;
// the free CLI and optional plan are stated in the description instead.
export function jsonLd(origin = PUBLIC_ORIGIN, billing = false) {
  const url = absoluteUrl(origin, "/");
  const text = description(billing);
  const app = {
    "@type": "SoftwareApplication",
    name: "CostCap",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    url,
    description: text,
  };
  if (!billing) app.offers = { "@type": "Offer", price: "0", priceCurrency: "USD" };
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: "CostCap",
        url,
        description: text,
      },
      app,
    ],
  };
}

export function jsonLdScript(origin = PUBLIC_ORIGIN, billing = false) {
  return JSON.stringify(jsonLd(origin, billing)).replace(/</g, "\\u003c");
}

import { randomBytes } from "node:crypto";
import { ALERT_KINDS } from "./alerts.js";
// Issue #258: alert routes. Pure, no I/O.
// `alertSettings.kinds` (null = all) limits which kinds reach the org's default
// email and Slack. `alertSettings.routes[]` sends matching alerts (by kind and
// team) to extra email/Slack destinations. The signed webhook is unaffected.

export const MAX_ALERT_ROUTES = 10;
const ROUTE_ID = /^rt_[a-f0-9]{12}$/;
export const newRouteId = () => `rt_${randomBytes(6).toString("hex")}`;
const bad = (message) => { const err = new Error(message); err.status = 400; throw err; };

/** Validates a kinds value. Returns null (all kinds) or a de-duplicated list in ALERT_KINDS order. */
export function parseKinds(value, label = "kinds") {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((k) => typeof k !== "string")) bad(`${label} must be null or a list of alert kinds`);
  const unknown = value.find((k) => !ALERT_KINDS.includes(k));
  if (unknown) bad(`Unknown alert kind ${unknown}`);
  return ALERT_KINDS.filter((k) => value.includes(k));
}

/**
 * Validates a full replacement list of routes.
 * ctx: { current: route[], teamNames: Set, members: Set (verified emails), validSlack: fn }
 */
export function parseRoutes(value, { current = [], teamNames, members, validSlack }) {
  if (!Array.isArray(value)) bad("routes must be a list");
  if (value.length > MAX_ALERT_ROUTES) bad(`At most ${MAX_ALERT_ROUTES} alert routes`);
  const byId = new Map(current.map((r) => [r.id, r]));
  const seen = new Set();
  return value.map((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) bad("Each route must be an object");
    for (const key of Object.keys(r)) if (!["id", "name", "kinds", "teams", "emails", "slackWebhook"].includes(key)) bad(`Unknown route field ${key}`);
    let prior = null;
    if (r.id !== undefined && r.id !== null) {
      if (typeof r.id !== "string" || !ROUTE_ID.test(r.id) || !byId.has(r.id)) bad("Unknown route id");
      if (seen.has(r.id)) bad("Duplicate route id");
      seen.add(r.id);
      prior = byId.get(r.id);
    }
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name.length < 1 || name.length > 40) bad("Route name must be 1-40 characters");
    const kinds = r.kinds === undefined ? null : parseKinds(r.kinds, "Route kinds");
    let teams = null;
    if (r.teams !== undefined && r.teams !== null) {
      if (!Array.isArray(r.teams) || r.teams.some((t) => typeof t !== "string")) bad("Route teams must be null or a list of team names");
      teams = [...new Set(r.teams.map((t) => t.trim()).filter(Boolean))];
      const unknown = teams.find((t) => !teamNames.has(t));
      if (unknown) bad(`Unknown team ${unknown}`);
      if (!teams.length && !(prior && Array.isArray(prior.teams) && !prior.teams.length)) bad("Route teams must name at least one team, or be null for any team");
    }
    let emails = [];
    if (r.emails !== undefined && r.emails !== null) {
      if (!Array.isArray(r.emails) || r.emails.length > 20 || r.emails.some((e) => typeof e !== "string")) bad("Route emails must be a list of up to 20 addresses");
      emails = [...new Set(r.emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
      if (emails.some((e) => !members.has(e))) bad("Alert emails must be verified members of this organization");
    }
    let slackWebhook;
    if (r.slackWebhook === undefined) slackWebhook = prior?.slackWebhook ?? null;
    else if (r.slackWebhook === null || r.slackWebhook === "") slackWebhook = null;
    else if (!validSlack(r.slackWebhook)) bad("Slack webhook must be https://hooks.slack.com/services/...");
    else slackWebhook = r.slackWebhook;
    if (!emails.length && !slackWebhook) bad(`Route ${name} needs an email or a Slack webhook`);
    return { id: prior?.id ?? newRouteId(), name, kinds, teams, emails, slackWebhook };
  });
}

/** A route left with `teams: []` (its teams were deleted) is disabled and matches nothing. */
export const routeDisabled = (route) => Array.isArray(route?.teams) && route.teams.length === 0;

/** `team` is the alert's resolved team name or null (org-budget, tag, or an agent in no team). */
export function routeMatches(route, alert, team) {
  if (Array.isArray(route.kinds) && !route.kinds.includes(alert.kind)) return false;
  if (route.teams == null) return true;
  return team != null && route.teams.includes(team);
}

/** Default email/Slack receive this alert kind? */
export const defaultsWant = (kinds, kind) => !Array.isArray(kinds) || kinds.includes(kind);

/** Removes a deleted team from every route. Never widens a route to all teams. */
export function dropTeamFromRoutes(routes, team) {
  return (routes ?? []).map((r) => (Array.isArray(r.teams) && r.teams.includes(team) ? { ...r, teams: r.teams.filter((t) => t !== team) } : r));
}
/** Removes a member's email from every route. */
export function dropEmailFromRoutes(routes, email) {
  return (routes ?? []).map((r) => (r.emails?.includes(email) ? { ...r, emails: r.emails.filter((e) => e !== email) } : r));
}

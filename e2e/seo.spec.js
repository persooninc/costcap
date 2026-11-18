import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

// go-to-market#18: crawlable apex marketing root, OG image, llms.txt, sitemap, robots meta.
test("apex marketing root and discovery files over HTTP", async ({ request }) => {
  const service = createHostedServer({
    storePath: join(mkdtempSync(join(tmpdir(), "cc-seo-")), "data.json"),
    origin: "https://app.costcap.dev", secureCookies: false, turnstileSiteKey: "fixture-key",
    verifyChallenge: async () => false, sendCode: async () => {},
  });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const apex = { headers: { host: "costcap.dev" } };
  try {
    const home = await request.get(base + "/", apex);
    expect(home.status()).toBe(200);
    const html = await home.text();
    for (const tag of ['name="robots"', 'property="og:title"', 'property="og:image" content="https://costcap.dev/og.png"', 'name="twitter:card"', 'name="twitter:image"'])
      expect(html).toContain(tag);
    const og = await request.get(base + "/og.png", apex);
    expect(og.status()).toBe(200);
    expect(og.headers()["content-type"]).toBe("image/png");
    const head = await request.head(base + "/og.png", apex);
    expect(head.status()).toBe(200);
    const llms = await request.get(base + "/llms.txt", apex);
    expect(llms.status()).toBe(200);
    expect(llms.headers()["content-type"]).toMatch(/^text\/plain/);
    const sitemap = await (await request.get(base + "/sitemap.xml", apex)).text();
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs[0]).toBe("https://costcap.dev");
    const pricingOk = (await request.get(base + "/pricing", apex)).status() === 200;
    expect(locs).toEqual(pricingOk ? ["https://costcap.dev", "https://costcap.dev/pricing"] : ["https://costcap.dev"]);
    expect((await request.get(base + "/cli", apex)).status()).not.toBe(200);
    const app = await (await request.get(base + "/")).text();
    expect(app).toContain('name="robots"');
    expect(app).toContain('name="twitter:card"');
  } finally {
    await new Promise((r) => service.server.close(r));
  }
});

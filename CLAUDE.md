# Xikipedia

Pseudo social media feed serving Wikipedia articles via Cloudflare Workers. Single-page app in `public/index.html`, Worker backend in `src/index.ts`.

## Playwright Browser Troubleshooting

When writing ad-hoc Playwright scripts (not tests) to screenshot/debug the live site:

1. **Use production URL directly** when local dev server is unreliable or slow. Don't waste time fighting wrangler dev timeouts — just hit `https://xiki.emilycogsdill.com`.
2. **Check actual element IDs** before filling forms. Read the HTML first — don't guess IDs like `#loginUser` when it's actually `#loginUsername`. Run `Grep` for the form fields.
3. **Handle disabled buttons.** Data downloads can take 60s+. Poll `getAttribute('disabled')` in a loop instead of using Playwright's built-in `click()` which times out on disabled elements.
4. **Unregister service workers** at the start of screenshot scripts to avoid update toasts and cache interference:
   ```js
   await page.evaluate(async () => {
     const regs = await navigator.serviceWorker.getRegistrations();
     for (const r of regs) await r.unregister();
   });
   ```
5. **Login via API then set localStorage** for faster auth setup:
   ```js
   const resp = await page.request.post(`${BASE}/api/login`, { data: { username, password } });
   const { token } = await resp.json();
   await page.evaluate(t => { localStorage.setItem('xiki-auth-token', t); }, token);
   await page.reload();
   ```
6. **Dismiss popovers via JS** if they block the view you need to screenshot:
   ```js
   await page.evaluate(() => {
     const el = document.getElementById('startScreen');
     if (el?.matches(':popover-open')) el.hidePopover();
   });
   ```
7. **Use `waitUntil: 'domcontentloaded'`** instead of default `'load'` for pages with long-running fetches. The `'load'` event can take 60s+ if the page fetches large data files.
8. **Clean up temp scripts** after use — don't leave `screenshot-*.mjs` files in the repo.

import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import cityNames from '../data/geonames-city-names.json'
import regionNames from '../data/region-names.json'
import sourceClassification from '../data/source-classification.json'
import faviconDomains from '../data/referer_favicon_domains.json'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  ADMIN_PASSWORD?: string
  SESSION_SECRET?: string
}

type App = Hono<{ Bindings: Bindings }>
type Ctx = Context<{ Bindings: Bindings }>
type Metric = string
type EventStats = {
  date: string
  visitors: number
  visits: number
  pageviews: number
  events: number
  bounces: number
  visit_duration: number
  revenue: number
  revenue_events: number
}
type ArchivePayload = Record<string, unknown>
type ApiFilter = [string, string, Array<string | number>, { case_sensitive?: boolean }?]
type RegisteredSite = {
  id: string
  domain: string
  created_at: string
  revenue_event?: string | null
  revenue_currency?: string | null
}
type RevenueGoal = { event: string | null; currency: string | null }

const app: App = new Hono()
const TZ_OFFSET = 19_800
const SNAPSHOT_SECONDS = 1_793_752_334
const DAY_SECONDS = 86_400
const AUTH_COOKIE = 'plausible_d1_session'
const CITY_NAMES = cityNames as Record<string, string>
const REGION_NAMES = regionNames as Record<string, string>
const SOURCE_CATEGORIES = sourceClassification.categories as Record<string, string>
const PAID_SOURCES = new Set(sourceClassification.paidSources as string[])
const FAVICON_DOMAINS: Record<string, string> = {
  ...(faviconDomains as Record<string, string>),
  Brave: 'search.brave.com',
  Kagi: 'kagi.com',
  Wikipedia: 'en.wikipedia.org',
  Discord: 'discord.com',
  Perplexity: 'perplexity.ai',
  LinkedIn: 'linkedin.com',
  Linktree: 'linktr.ee',
  Bluesky: 'bsky.app',
  Mastodon: 'mastodon.social',
  'Google Gemini': 'gemini.google.com',
  ChatGPT: 'chatgpt.com',
  Claude: 'claude.ai',
  'Microsoft Copilot': 'copilot.com',
  Grok: 'grok.com',
  'X (Twitter)': 'x.com'
}

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-Frame-Options', 'DENY')
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
  else c.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
})

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 86400 }))
app.options('/api/event', (c) => c.body(null, 204))
app.post('/api/event', collectEvent)

app.get('/login', (c) => c.html(loginPage()))
app.post('/login', async (c) => {
  const form = await c.req.parseBody()
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) return c.text('Dashboard password is not configured.', 503)
  if (typeof form.password !== 'string' || !(await sameSecret(form.password, c.env.ADMIN_PASSWORD, c.env.SESSION_SECRET))) {
    return c.html(loginPage('Password didn’t match. Try again.'), 401)
  }
  const token = await makeSession(c.env.SESSION_SECRET)
  c.header('Set-Cookie', `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600`)
  return c.redirect('/sites')
})
app.post('/logout', (c) => {
  c.header('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  return c.redirect('/login')
})

app.use('/api/sites', async (c, next) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.use('/api/sites/*', async (c, next) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.get('/api/sites', listSites)
app.get('/api/sites/', listSites)
app.post('/api/sites', createSite)
app.post('/api/sites/:domain/revenue', saveRevenueSettings)

app.use('/api/stats/*', async (c, next) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.get('/api/stats/:domain/current-visitors', currentVisitors)
app.get('/api/stats/:domain/current-visitors/', currentVisitors)
app.get('/api/stats/:domain/journeys', listJourneys)
app.post('/api/stats/:domain/query', statsQuery)
app.post('/api/stats/:domain/query/', statsQuery)
app.get('/api/stats/:domain/suggestions/custom-prop-values/:propKey', customPropSuggestions)
app.get('/api/stats/:domain/suggestions/:key', suggestions)
app.get('/api/stats/:domain/suggestions/:key/', suggestions)
app.all('/api/stats/*', (c) => c.json({ error: 'not found' }, 404))
app.get('/favicon/sources/:domain', sourceFavicon)
app.get('/favicon/placeholders/:name', faviconPlaceholder)

app.get('/', (c) => c.redirect('/sites'))
app.get('/sites', async (c) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  return c.html(sitesPage())
})
app.get('/sites/', async (c) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  return c.html(sitesPage())
})
app.get('/sites/new', async (c) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  return c.html(newSitePage())
})
app.get('/:domain/journeys', async (c) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.text('Site not found', 404)
  return c.html(journeysPage(site))
})
app.get('/:domain/settings/general', async (c) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.text('Site not found', 404)
  return c.html(siteSettingsPage(site, new URL(c.req.url).origin))
})
app.all('*', async (c) => {
  const path = c.req.path
  if (path === '/js/script.js') return c.env.ASSETS.fetch(new Request(new URL('/js/script.js', c.req.url)))
  if (path.startsWith('/assets/') || path.startsWith('/js/') || path.startsWith('/images/')) return c.env.ASSETS.fetch(c.req.raw)
  const domain = decodeURIComponent(path.slice(1).split('/')[0] ?? '')
  const site = domain ? await getSiteByDomain(c.env.DB, domain) : null
  if (!site) return c.text('Not found', 404)
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  return dashboardPage(c, site)
})

async function getSiteByDomain(db: D1Database, domain: string | undefined) {
  if (!domain) return null
  return db.prepare('SELECT id, domain, created_at, revenue_event, revenue_currency FROM pd_sites WHERE domain = ? COLLATE NOCASE')
    .bind(domain).first<RegisteredSite>()
}

async function listSites(c: Ctx) {
  const now = Math.floor(Date.now() / 1000)
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.domain, s.created_at,
      COUNT(e.event_id) AS events,
      MAX(e.ts) AS last_event_ts,
      COUNT(DISTINCT CASE WHEN e.ts >= ? THEN e.visitor_id END) AS visitors_24h,
      COUNT(DISTINCT CASE WHEN e.ts >= ? AND e.ts < ? THEN e.visitor_id END) AS previous_visitors_24h,
      COUNT(DISTINCT CASE WHEN e.ts >= ? THEN e.visitor_id END) AS online,
      EXISTS (SELECT 1 FROM plausible_history h WHERE h.site_id = s.id) AS has_imports
     FROM pd_sites s LEFT JOIN pd_events e ON e.site_id = s.id
     GROUP BY s.id, s.domain, s.created_at ORDER BY lower(s.domain)`,
  ).bind(now - 86_400, now - 172_800, now - 86_400, now - 300).all<RegisteredSite & {
    events: number; last_event_ts: number | null; visitors_24h: number; previous_visitors_24h: number; online: number; has_imports: number
  }>()
  const hourly = await c.env.DB.prepare(
    `SELECT site_id, CAST(ts / 3600 AS INTEGER) AS hour, COUNT(DISTINCT visitor_id) AS visitors
       FROM pd_events WHERE ts >= ? GROUP BY site_id, CAST(ts / 3600 AS INTEGER)`,
  ).bind(Math.floor(now / 3600) * 3600 - 23 * 3600).all<{ site_id: string; hour: number; visitors: number }>()
  const sparklineBySite = new Map<string, number[]>()
  for (const row of hourly.results) {
    const values = sparklineBySite.get(row.site_id) ?? Array.from({ length: 24 }, () => 0)
    const index = Number(row.hour) - (Math.floor(now / 3600) - 23)
    if (index >= 0 && index < values.length) values[index] = Number(row.visitors ?? 0)
    sparklineBySite.set(row.site_id, values)
  }
  return c.json({ data: rows.results.map((site) => ({
    domain: site.domain,
    id: site.id,
    created_at: site.created_at,
    needs_verification: false,
    events: Number(site.events ?? 0),
    last_event_ts: site.last_event_ts,
    visitors_24h: Number(site.visitors_24h ?? 0),
    previous_visitors_24h: Number(site.previous_visitors_24h ?? 0),
    online: Number(site.online ?? 0),
    has_imports: Boolean(site.has_imports),
    sparkline: sparklineBySite.get(site.id) ?? Array.from({ length: 24 }, () => 0),
  })) })
}

async function createSite(c: Ctx) {
  const body = await c.req.json<{ domain?: unknown }>().catch(() => null)
  if (typeof body?.domain !== 'string') return c.json({ error: 'Enter a valid website domain.' }, 400)
  const domain = normalizeSiteDomain(body.domain)
  if (!domain) return c.json({ error: 'Enter a domain such as example.com, without a path.' }, 400)
  if (await getSiteByDomain(c.env.DB, domain)) return c.json({ error: 'This site is already in your list.' }, 409)

  const id = crypto.randomUUID().replaceAll('-', '')
  const created = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO pd_sites (id, domain, created_at) VALUES (?, ?, datetime(\'now\'))',
  ).bind(id, domain).run()
  if (Number(created.meta.changes ?? 0) !== 1) return c.json({ error: 'This site is already in your list.' }, 409)

  const origin = new URL(c.req.url).origin
  const tracker = `<script defer data-domain="${domain}" src="${origin}/js/script.outbound-links.js"></script>`
  return c.json({ data: { id, domain, tracker } }, 201)
}

async function saveRevenueSettings(c: Ctx) {
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.json({ error: 'unknown site' }, 404)
  const body = await c.req.json<{ event_name?: unknown; currency?: unknown }>().catch(() => null)
  if (!body || typeof body.event_name !== 'string' || typeof body.currency !== 'string') {
    return c.json({ error: 'Choose a conversion event and its currency.' }, 400)
  }

  const eventName = body.event_name.trim().slice(0, 120)
  const currency = body.currency.trim().toUpperCase()
  if (!eventName || !/^[A-Z]{3}$/.test(currency)) return c.json({ error: 'Enter a conversion event and a three-letter currency code.' }, 400)
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency }).format(0)
  } catch {
    return c.json({ error: 'That currency code is not supported.' }, 400)
  }

  await c.env.DB.prepare('UPDATE pd_sites SET revenue_event = ?, revenue_currency = ? WHERE id = ?')
    .bind(eventName, currency, site.id).run()
  return c.json({ data: { event_name: eventName, currency } })
}

function normalizeSiteDomain(value: string) {
  const input = value.trim()
  if (!input || /[\s/@?#]/.test(input.replace(/^https?:\/\//i, ''))) return null
  let domain: string
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    if (url.pathname !== '/' || url.search || url.hash || url.port || url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
    domain = url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
  if (domain.length > 253 || !domain.includes('.')) return null
  const labels = domain.split('.')
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null
  return domain
}

function hostBelongsToSite(hostname: string, domain: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}

async function dashboardPage(c: Ctx, site: RegisteredSite) {
  const asset = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)))
  const [archive, native] = await Promise.all([
    c.env.DB.prepare("SELECT MIN(date) AS first_date FROM plausible_history WHERE site_id = ?")
      .bind(site.id).first<{ first_date: string | null }>(),
    c.env.DB.prepare('SELECT MIN(ts) AS first_ts FROM pd_events WHERE site_id = ?')
      .bind(site.id).first<{ first_ts: number | null }>(),
  ])
  const nativeStart = native?.first_ts ? dateForTimestamp(native.first_ts) : today()
  const statsStart = archive?.first_date ?? nativeStart
  const revenueGoals = site.revenue_event && site.revenue_currency
    ? [{ display_name: site.revenue_event, currency: site.revenue_currency }]
    : []
  const html = (await asset.text())
    .replace('<title>Viralhooks — Plausible Analytics</title>', `<title>${htmlEscape(site.domain)} — Plausible Analytics</title>`)
    .replace('data-domain="viralhooks.org"', `data-domain="${htmlEscape(site.domain)}"`)
    .replace('data-logged-in="false"', 'data-logged-in="true"')
    .replace('data-revenue-goals="[]"', `data-revenue-goals="${htmlEscape(JSON.stringify(revenueGoals))}"`)
    .replace('data-stats-begin="2024-12-26"', `data-stats-begin="${statsStart}"`)
    .replace('data-native-stats-begin="2026-11-04"', `data-native-stats-begin="${nativeStart}"`)
  const headers = new Headers(asset.headers)
  headers.delete('Content-Length')
  headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(html, { status: asset.status, headers })
}

function sitesPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Your websites — Plausible Analytics</title>${managementStyles()}</head><body><main class="wrap"><header class="top"><a class="brand" href="/sites"><span class="mark">↗</span><span>Plausible</span></a><form action="/logout" method="post"><button class="button secondary" type="submit">Log out</button></form></header><section class="sites-title"><h1>Your websites</h1></section><div class="sites-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Search websites" aria-label="Search websites"></label><div class="toolbar-actions"><label class="sort-box"><span class="sr-only">Sort websites</span><select id="sort"><option value="traffic">Sort by traffic</option><option value="name">Sort alphabetically</option></select></label><a class="button primary add-button" href="/sites/new"><span aria-hidden="true">＋</span> Add website</a></div></div><p id="sites-note" class="sites-note">Loading your websites…</p><ul id="sites" class="site-grid" aria-live="polite"></ul></main><script>
const root=document.getElementById('sites'),search=document.getElementById('search'),sort=document.getElementById('sort'),note=document.getElementById('sites-note');let sites=[];const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const pct=s=>{const a=Number(s.visitors_24h||0),b=Number(s.previous_visitors_24h||0);if(!b)return null;return Math.round((a-b)/b*100)};const spark=values=>{const nums=Array.isArray(values)?values.map(Number):Array(24).fill(0);const max=Math.max(1,...nums);const pts=nums.map((v,i)=>[i*340/Math.max(1,nums.length-1),42-(v/max*32)]);const line=pts.map(p=>p.join(',')).join(' '),area='M 0 48 L '+pts.map(p=>p.join(' ')).join(' L ')+' L 340 48 Z';return'<svg class="sparkline" viewBox="0 0 340 48" preserveAspectRatio="none" role="img" aria-label="Hourly visitors in the last 24 hours"><path class="spark-area" d="'+area+'"></path><polyline points="'+line+'"></polyline></svg>'};const render=()=>{const query=search.value.trim().toLowerCase();const ordered=sites.filter(s=>s.domain.toLowerCase().includes(query));ordered.sort(sort.value==='name'?(a,b)=>a.domain.localeCompare(b.domain):(a,b)=>Number(b.visitors_24h||0)-Number(a.visitors_24h||0));if(!ordered.length){root.innerHTML='<li class="empty">'+(sites.length?'<h2>No sites found</h2><p>Try a different search.</p>':'<h2>Add your first website</h2><p>Collect simple, privacy-friendly stats to understand your audience.</p><a class="button primary" href="/sites/new">＋ Add website</a>')+'</li>';return}root.innerHTML=ordered.map(s=>{const change=pct(s),changeText=change===null?'—':(change>0?'+':'')+change+'%';const changeClass=change===null?'muted':change>=0?'up':'down';const dashboard='/'+encodeURIComponent(s.domain);return'<li class="site-card"><div class="site-card-head"><img class="favicon" src="/favicon/sources/'+encodeURIComponent(s.domain)+'?placeholder=site" onerror="this.onerror=null;this.src=\'/favicon/placeholders/site\'" alt=""><a class="site-domain" href="'+dashboard+'">'+escapeHtml(s.domain)+'</a><a class="site-settings" href="'+dashboard+'/settings/general" aria-label="Settings for '+escapeHtml(s.domain)+'" title="Site settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"></path><path d="m19.4 13.5 1.1.8-1.1 1.9-1.3-.5a7.8 7.8 0 0 1-1.5.9l-.2 1.4h-2.2l-.3-1.4a7.8 7.8 0 0 1-1.7 0l-.7 1.2-2-.8.2-1.5a7.7 7.7 0 0 1-1.2-1.3l-1.4.2-.8-2 1.2-.8a7.8 7.8 0 0 1-.1-1.8l-1.2-.7.8-2 1.5.1a7.8 7.8 0 0 1 1.3-1.2L9.6 4.8l2-.8.8 1.2a7.8 7.8 0 0 1 1.8 0l.7-1.2 2 .8-.1 1.5a7.8 7.8 0 0 1 1.2 1.3l1.4-.2.8 2-1.2.8a7.8 7.8 0 0 1 0 1.8Z"></path></svg></a></div><a class="site-card-link" href="'+dashboard+'">'+spark(s.sparkline)+'<div class="site-stats"><div><strong>'+Number(s.visitors_24h||0).toLocaleString()+'</strong><span>visitor'+(Number(s.visitors_24h||0)===1?'':'s')+' in last 24h</span></div><span class="change '+changeClass+'">'+escapeHtml(changeText)+'</span></div></a></li>'}).join('')};search.addEventListener('input',render);sort.addEventListener('change',render);fetch('/api/sites').then(r=>{if(!r.ok)throw new Error('Could not load your websites. Refresh and try again.');return r.json()}).then(result=>{sites=result.data||[];note.textContent='Live visitors are shown for the last 24 hours. Imported Plausible history appears in each site’s dashboard.';render()}).catch(e=>{note.textContent=e.message;root.innerHTML=''})
</script></body></html>`
}

function newSitePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Add website — Plausible Analytics</title>${managementStyles()}</head><body><main class="narrow"><header class="top"><a class="brand" href="/sites"><span class="mark">↗</span><span>Plausible</span></a><a class="button secondary" href="/sites">All websites</a></header><section class="form-card"><p class="eyebrow">SITE MANAGEMENT</p><h1>Add a website</h1><p class="sub">Enter the domain you want to measure. You can add the tracking snippet after creating it.</p><form id="add-form"><label for="domain">Website domain</label><input id="domain" name="domain" autocomplete="url" placeholder="example.com" required><small>Use a domain only, such as viralhooks.org. Subdomains of this domain are included.</small><p id="error" class="form-error" role="alert"></p><button class="button primary full" type="submit">Add website</button></form><section id="success" hidden></section></section></main><script>
const form=document.getElementById('add-form');form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');const error=document.getElementById('error');error.textContent='';button.disabled=true;button.textContent='Adding website…';try{const response=await fetch('/api/sites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:document.getElementById('domain').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not add this website.');form.hidden=true;const success=document.getElementById('success');success.hidden=false;success.innerHTML='<div class="success-icon">✓</div><h2>'+String(result.data.domain).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+' was added</h2><p class="sub">Install this snippet in the <code>&lt;head&gt;</code> section of your website. Visits will begin appearing as soon as the script loads.</p><pre id="tracker"></pre><button id="copy" class="button secondary full">Copy tracking snippet</button><a class="button primary full" style="margin-top:10px" href="/'+encodeURIComponent(result.data.domain)+'">Open dashboard</a><a class="back-link" href="/sites">Back to all websites</a>';document.getElementById('tracker').textContent=result.data.tracker;document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(result.data.tracker);document.getElementById('copy').textContent='Copied'}}catch(err){error.textContent=err.message;button.disabled=false;button.textContent='Add website'}});
</script></body></html>`
}

function siteSettingsPage(site: RegisteredSite, origin: string) {
  const tracker = `<script defer data-domain="${site.domain}" src="${origin}/js/script.outbound-links.js"></script>`
  const currentEvent = site.revenue_event ?? ''
  const currentCurrency = site.revenue_currency ?? ''
  const revenueCode = `window.plausible(${JSON.stringify(currentEvent || 'Purchase')}, { revenue: { currency: ${JSON.stringify(currentCurrency || 'USD')}, amount: 29.99 } })`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${htmlEscape(site.domain)} settings — Plausible Analytics</title>${managementStyles()}</head><body><main class="narrow"><header class="top"><a class="brand" href="/sites"><span class="mark">↗</span><span>Plausible</span></a><a class="button secondary" href="/sites">All websites</a></header><section class="form-card"><p class="eyebrow">SITE SETTINGS</p><h1>${htmlEscape(site.domain)}</h1><p class="sub">Install this site’s tracking snippet to collect visits in this dashboard.</p><label for="tracker">Tracking snippet</label><pre id="tracker">${htmlEscape(tracker)}</pre><button id="copy" class="button secondary full">Copy tracking snippet</button><section class="settings-section"><h2>Revenue tracking</h2><p class="sub">Choose the conversion event and currency you send with Plausible’s <code>revenue</code> option. Revenue cards appear after matching events arrive.</p><form id="revenue-form"><label for="revenue-event">Conversion event name</label><input id="revenue-event" maxlength="120" value="${htmlEscape(currentEvent)}" placeholder="Purchase" required><label for="revenue-currency">Currency</label><input id="revenue-currency" maxlength="3" value="${htmlEscape(currentCurrency)}" placeholder="USD" required><p id="revenue-status" class="form-error" role="status"></p><button class="button secondary full" type="submit">Save revenue goal</button></form><pre class="example-code">${htmlEscape(revenueCode)}</pre><p class="settings-note">Plausible’s imported history contains daily aggregates, so it cannot provide hourly conversion paths or historical transaction revenue. Live revenue tracking starts after you configure this goal and add the revenue option to matching events.</p><a class="back-link" href="/${encodeURIComponent(site.domain)}/journeys">View recent conversion paths →</a></section><a class="button primary full" style="margin-top:12px" href="/${encodeURIComponent(site.domain)}">Open dashboard</a></section></main><script>document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('tracker').textContent);document.getElementById('copy').textContent='Copied'};document.getElementById('revenue-form').addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('revenue-status');const button=e.currentTarget.querySelector('button');button.disabled=true;button.textContent='Saving…';status.textContent='';try{const response=await fetch('/api/sites/${encodeURIComponent(site.domain)}/revenue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_name:document.getElementById('revenue-event').value,currency:document.getElementById('revenue-currency').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save the revenue goal.');status.className='form-success';status.textContent='Saved. New matching events will be counted.'}catch(error){status.className='form-error';status.textContent=error.message}finally{button.disabled=false;button.textContent='Save revenue goal'}})</script></body></html>`
}

function journeysPage(site: RegisteredSite) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Conversion paths — ${htmlEscape(site.domain)}</title>${managementStyles()}</head><body><main class="wrap"><header class="top"><a class="brand" href="/sites"><span class="mark">↗</span><span>Plausible</span></a><nav class="page-links"><a class="button secondary" href="/${encodeURIComponent(site.domain)}">Dashboard</a><a class="button secondary" href="/${encodeURIComponent(site.domain)}/settings/general">Site settings</a></nav></header><section class="heading site-heading"><div><h1>Conversion paths</h1><p class="sub">Recent page and event steps from sessions that completed the configured conversion goal on ${htmlEscape(site.domain)}.</p></div></section><section class="journey-note">Paths use a short-lived, site-local session grouping. No visitor names, IP addresses, or cross-session profiles are shown. Imported Plausible history has daily aggregates and cannot show timestamped paths.</section><section id="journeys" class="journey-list" aria-live="polite"><article class="empty loading-card"><div class="spinner"></div><p>Loading conversion paths…</p></article></section></main><script>
const siteDomain=${JSON.stringify(site.domain)};const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const root=document.getElementById('journeys');const settings='/'+encodeURIComponent(siteDomain)+'/settings/general';const relativeTime=ts=>new Date(ts*1000).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});const money=(amount,currency)=>amount===null||amount===undefined?'':new Intl.NumberFormat(undefined,{style:'currency',currency:currency||'USD'}).format(amount);fetch('/api/stats/'+encodeURIComponent(siteDomain)+'/journeys').then(r=>{if(!r.ok)throw new Error('Could not load conversion paths. Refresh and try again.');return r.json()}).then(result=>{if(!result.goal){root.innerHTML='<article class="empty"><h2>Set up a conversion goal</h2><p>Choose the event and currency you use for a completed purchase or other valuable conversion.</p><a class="button primary" href="'+settings+'">Configure revenue tracking</a></article>';return}if(!result.data?.length){root.innerHTML='<article class="empty"><h2>No recent conversions yet</h2><p>Paths will appear after the “'+escapeHtml(result.goal)+'” event is tracked with the configured revenue currency.</p><a class="button secondary" href="'+settings+'">Review tracker setup</a></article>';return}root.innerHTML='<div class="journey-title"><h2>'+escapeHtml(result.goal)+'</h2><span>Last 30 days · up to 30 sessions</span></div>'+result.data.map(j=>'<article class="journey-card"><header><div><strong>'+escapeHtml(relativeTime(j.converted_at))+'</strong><span>'+ (j.source?'from '+escapeHtml(j.source):'source unknown') +'</span></div><b>'+escapeHtml(money(j.revenue_amount,j.revenue_currency))+'</b></header><div class="journey-steps">'+j.events.map((e,i)=>'<div class="journey-step"><span class="step-index">'+(i+1)+'</span><div><strong>'+escapeHtml(e.page||'/')+'</strong><small>'+escapeHtml(e.name)+' · '+escapeHtml(new Date(e.ts*1000).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}))+'</small></div></div>').join('<span class="step-arrow" aria-hidden="true">→</span>')+'</div></article>').join('')}).catch(e=>{root.innerHTML='<article class="empty error">'+escapeHtml(e.message)+'</article>'});
</script></body></html>`
}

function managementStyles() {
  return managementBaseStyles() + `<style>
  :root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937;background:#f9fafb;font-synthesis:none}body{background:#f9fafb;color:#1f2937}.wrap{max-width:1280px;padding:24px 24px 48px}.narrow{max-width:760px;padding:24px}.top{min-height:44px}.brand{font-size:18px;gap:9px}.mark{width:30px;height:30px;border-radius:7px;font-size:21px}.button{font-family:inherit;font-size:14px;border-radius:6px;min-height:40px;padding:0 14px}.primary{background:#171717;border-color:#171717}.primary:hover{background:#303030}.secondary{background:#fff;border-color:#e5e7eb;box-shadow:none}.sites-title{padding:22px 0 16px;border-bottom:1px solid #e5e7eb}.sites-title h1{font-size:24px;line-height:1.3;letter-spacing:-.02em;font-weight:600;margin:0}.sites-toolbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0 10px}.toolbar-actions{display:flex;align-items:center;gap:8px}.search-box{display:flex;align-items:center;gap:9px;width:min(340px,100%);height:40px;padding:0 11px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#737373}.search-box>span{font-size:22px;line-height:1}.search-box input{height:36px;padding:0;border:0;box-shadow:none;background:transparent;font-size:14px}.sort-box select{height:40px;padding:0 30px 0 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#404040;font:14px inherit}.sort-box select:focus{outline:2px solid #6366f1}.add-button{font-size:14px}.sites-note{font-size:13px;color:#737373;margin:4px 0 16px;line-height:1.5}.site-grid{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:0;margin:0}.site-card{position:relative;display:flex;flex-direction:column;gap:20px;background:#fff;border:1px solid #e5e7eb;border-radius:7px;box-shadow:0 1px 2px #1118270d;padding:16px 20px;transition:box-shadow .12s ease}.site-card:hover{box-shadow:0 5px 14px #11182718}.site-card-head{display:flex;align-items:center;gap:10px;min-height:32px}.favicon{width:28px;height:28px;border-radius:5px;background:#f3f4f6;object-fit:cover}.site-domain{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#262626;text-decoration:none;font-size:16px;line-height:22px;font-weight:500}.site-domain:hover{text-decoration:underline}.site-settings{position:relative;z-index:2;display:grid;place-items:center;width:31px;height:31px;border-radius:5px;color:#737373}.site-settings:hover{background:#f3f4f6;color:#171717}.site-settings svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.site-card-link{display:flex;flex-direction:column;gap:14px;color:inherit;text-decoration:none}.sparkline{display:block;width:100%;height:48px;overflow:visible}.sparkline polyline{fill:none;stroke:#6366f1;stroke-width:2;vector-effect:non-scaling-stroke}.spark-area{fill:#eef2ff;opacity:.8}.site-stats{display:flex;justify-content:space-between;align-items:flex-end;min-height:43px;font-size:13px;color:#737373}.site-stats>div{display:flex;flex-direction:column;gap:1px}.site-stats strong{color:#171717;font-size:20px;line-height:1.25;font-weight:700}.change{font-size:13px;font-weight:500}.change.up{color:#059669}.change.down{color:#dc2626}.change.muted{color:#a3a3a3}.site-card .empty{border:0;box-shadow:none}.empty{grid-column:1/-1;list-style:none;background:#fff;border:1px solid #e5e7eb;border-radius:7px;box-shadow:0 1px 2px #1118270d;text-align:center;padding:48px 18px;color:#737373}.empty h2{font-size:16px;color:#262626;margin:0 0 7px;font-weight:600}.empty p{font-size:14px;margin:0 0 18px}.empty .button{margin-top:3px}.loading-card{display:flex;align-items:center;justify-content:center;gap:12px}.loading-card p{margin:0}.spinner{height:18px;width:18px;border:2px solid #d4d4d4;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.heading{margin:24px 0 20px;align-items:center}.heading h1,.form-card h1{letter-spacing:-.025em;font-size:25px;font-weight:600}.eyebrow{display:none}.form-card{margin-top:28px;border:1px solid #e5e7eb;border-radius:7px;box-shadow:0 1px 2px #1118270d;padding:24px}.form-card .sub{margin-bottom:20px}.form-card label{color:#404040;font-size:13px}.form-card input{height:42px;border-radius:6px;border-color:#d4d4d4;font-size:14px}.form-card pre{background:#fafafa;border-radius:6px;border-color:#e5e7eb}.form-card .full{margin-top:12px}.settings-section{margin-top:32px;padding-top:25px;border-top:1px solid #e5e7eb}.settings-section h2{margin:0 0 8px;font-size:18px;font-weight:600;color:#262626}.settings-section .sub{font-size:14px}.example-code{margin:16px 0 0!important;font-size:12px!important}.settings-note{font-size:13px;color:#737373}.form-success{min-height:20px;color:#059669;font-size:13px;margin:8px 0 0}.page-links{display:flex;gap:8px}.site-heading{margin-top:22px}.journey-note{padding:13px 16px;margin:4px 0 18px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;color:#737373;font-size:13px;line-height:1.5}.journey-list{display:flex;flex-direction:column;gap:14px}.journey-title{display:flex;justify-content:space-between;align-items:center;padding:0 2px;color:#737373;font-size:13px}.journey-title h2{margin:0;color:#262626;font-size:17px;font-weight:600}.journey-card{background:#fff;border:1px solid #e5e7eb;border-radius:7px;box-shadow:0 1px 2px #1118270d;padding:16px 18px}.journey-card header{display:flex;justify-content:space-between;align-items:center;gap:14px;padding-bottom:14px;border-bottom:1px solid #f0f0f0}.journey-card header div{display:flex;flex-direction:column;gap:3px}.journey-card header strong{font-size:14px;color:#262626;font-weight:600}.journey-card header span{font-size:12px;color:#737373}.journey-card header>b{font-size:15px;color:#111827}.journey-steps{display:flex;align-items:stretch;gap:10px;overflow-x:auto;padding:14px 0 2px}.journey-step{display:flex;align-items:flex-start;gap:8px;min-width:140px;max-width:230px}.step-index{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#eef2ff;color:#4f46e5;font-size:11px;font-weight:600}.journey-step>div{display:flex;flex-direction:column;gap:4px;min-width:0}.journey-step strong{font-size:13px;font-weight:500;color:#262626;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.journey-step small{font-size:11px;color:#737373}.step-arrow{padding-top:2px;color:#a3a3a3}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @media(max-width:900px){.site-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:640px){.wrap{padding:16px 15px 34px}.narrow{padding:16px 15px}.sites-title{padding:19px 0 13px}.sites-title h1{font-size:22px}.sites-toolbar{align-items:stretch;flex-direction:column;gap:9px}.search-box{width:100%}.toolbar-actions{justify-content:space-between}.sort-box{flex:1}.sort-box select{width:100%}.site-grid{grid-template-columns:1fr;gap:12px}.site-card{padding:14px 16px;gap:16px}.form-card{padding:20px;margin-top:20px}.heading{margin:24px 0 18px}.page-links .button{padding:0 9px;font-size:12px}.journey-steps{gap:7px}.journey-step{min-width:115px;max-width:160px}}
  </style>`
}

function managementBaseStyles() {
  return `<style>
  :root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#211f1d;background:#f7f6f3;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh}.wrap{max-width:1180px;margin:0 auto;padding:34px 30px 26px}.narrow{max-width:700px;margin:0 auto;padding:34px 24px}.top{display:flex;align-items:center;justify-content:space-between;min-height:50px}.brand{display:flex;align-items:center;gap:11px;color:inherit;text-decoration:none;font-weight:700;font-size:20px}.mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;color:#f18161;background:#211f1d;font-size:24px;line-height:1}.heading{display:flex;justify-content:space-between;align-items:end;gap:24px;margin:56px 0 28px}.eyebrow{font-size:11px;letter-spacing:.12em;color:#918b85;font-weight:700;margin:0 0 10px}.heading h1,.form-card h1{font-size:34px;letter-spacing:-.04em;margin:0 0 8px}.sub{color:#77716b;font-size:15px;line-height:1.6;margin:0;max-width:650px}.button{display:inline-flex;align-items:center;justify-content:center;gap:9px;border:1px solid #e4e1dc;border-radius:11px;min-height:43px;padding:0 16px;text-decoration:none;font:600 14px inherit;cursor:pointer;white-space:nowrap}.primary{background:#211f1d;color:white;border-color:#211f1d}.primary:hover{background:#393632}.secondary{background:#fff;color:#282623;box-shadow:0 1px 2px #211f1d12}.button:disabled{opacity:.6;cursor:wait}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:18px}.site-card,.empty,.form-card{background:white;border:1px solid #eae7e2;border-radius:17px;box-shadow:0 2px 7px #28231d0a}.site-card{padding:21px}.site-head{display:flex;align-items:center;gap:13px}.favicon{width:42px;height:42px;border-radius:11px;background:#eef8f6}.site-title{min-width:0;flex:1}.site-title h2{font-size:18px;margin:0 0 4px;overflow:hidden;text-overflow:ellipsis}.site-title p{font-size:12px;color:#938d87;margin:0}.live{display:flex;align-items:center;gap:7px;color:#358b60;font-size:12px;white-space:nowrap}.live i{height:8px;width:8px;background:#5dcf8b;border-radius:50%}.site-meta{display:grid;grid-template-columns:1fr 1fr;gap:17px 12px;border-top:1px solid #f0eeeb;border-bottom:1px solid #f0eeeb;padding:17px 0;margin:19px 0}.site-meta div{display:flex;flex-direction:column;gap:4px}.site-meta strong{font-size:15px;font-weight:650}.site-meta span{font-size:12px;color:#827b75}.site-actions{display:flex;gap:9px;flex-wrap:wrap}.site-actions .button{font-size:13px;min-height:39px}.empty{grid-column:1/-1;text-align:center;padding:54px 20px;color:#777}.empty h2{color:#252321;margin:12px 0 7px}.empty p{margin:0 0 20px}.empty-icon,.success-icon{display:grid;place-items:center;margin:0 auto;width:46px;height:46px;border-radius:14px;background:#f3f1ee;color:#45413b;font-size:24px}.loading-card{display:flex;align-items:center;justify-content:center;gap:12px}.loading-card p{margin:0}.spinner{height:18px;width:18px;border:2px solid #ddd;border-top-color:#444;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}footer{text-align:center;color:#aaa39d;font-size:12px;margin-top:36px}.form-card{padding:30px;margin-top:48px}.form-card h1{font-size:30px}.form-card .sub{margin-bottom:26px}.form-card label{display:block;font-weight:650;font-size:13px;margin:16px 0 8px}input{width:100%;height:48px;border:1px solid #dcd8d2;border-radius:10px;padding:0 13px;font:inherit;background:#fff;color:#201e1b;outline:none}input:focus{border-color:#807a72;box-shadow:0 0 0 3px #8c867d1c}.form-card small{display:block;color:#8a837d;font-size:12px;margin-top:8px}.full{width:100%;margin-top:18px}.form-error{min-height:20px;color:#b44536;font-size:13px;margin:8px 0 0}.form-card pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f5f2;border:1px solid #e8e5e0;border-radius:10px;padding:15px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.success-icon{background:#eaf7ef;color:#278153;font-weight:700}.back-link{display:block;text-align:center;color:#655f58;margin-top:20px;font-size:14px}.settings-note{margin:24px 0 0;padding-top:18px;border-top:1px solid #efede9;font-size:12px;line-height:1.6;color:#96908a}@media(max-width:640px){.wrap{padding:20px 15px}.narrow{padding:20px 15px}.heading{align-items:flex-start;flex-direction:column;margin:40px 0 20px}.heading h1{font-size:29px}.grid{grid-template-columns:1fr}.form-card{padding:23px 19px;margin-top:30px}.button{min-height:41px}}
  </style>`
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

async function sourceFavicon(c: Ctx) {
  const rawSource = c.req.param('domain')
  if (!rawSource) return faviconPlaceholder(c)
  let source = rawSource
  try {
    source = decodeURIComponent(source)
  } catch {
    // Keep the original source name and fall back to the generic icon below.
  }
  const mappedDomain = FAVICON_DOMAINS[source] ?? source
  const domain = mappedDomain.split('/', 1)[0].toLowerCase()
  if (
    domain.length > 253 ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain.startsWith('.') ||
    domain.endsWith('.')
  ) {
    return faviconPlaceholder(c)
  }

  let upstream: Response
  try {
    upstream = await fetch(`https://icons.duckduckgo.com/ip3/${domain}.ico`, {
      redirect: 'follow'
    })
  } catch {
    return faviconPlaceholder(c)
  }
  if (!upstream.ok) return faviconPlaceholder(c)

  const image = await upstream.arrayBuffer()
  const bytes = new Uint8Array(image)
  const brokenPng =
    bytes.length === 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value
    )
  if (!bytes.length || brokenPng) return faviconPlaceholder(c)

  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    .trimStart()
  const contentType =
    prefix.startsWith('<svg') || prefix.startsWith('<?xml')
      ? 'image/svg+xml'
      : upstream.headers.get('content-type') ?? 'image/x-icon'
  return new Response(image, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=2592000',
      'Content-Security-Policy': "script-src 'none'",
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

async function faviconPlaceholder(c: Ctx) {
  const requestedName = c.req.param('name') ?? c.req.query('placeholder')
  const isSite = requestedName === 'site'
  const isDark = c.req.query('ui-mode') === 'dark'
  const filename = isSite
    ? isDark
      ? 'site_favicon_placeholder_dark.svg'
      : 'site_favicon_placeholder.svg'
    : isDark
      ? 'link_favicon_dark.svg'
      : 'link_favicon.svg'
  const asset = await c.env.ASSETS.fetch(
    new Request(new URL(`/images/favicon/${filename}`, c.req.url))
  )
  const headers = new Headers(asset.headers)
  headers.set('Content-Type', 'image/svg+xml')
  headers.set('Cache-Control', 'public, max-age=2592000')
  return new Response(asset.body, { status: asset.status, headers })
}

async function collectEvent(c: Ctx) {
  const raw = await c.req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch {
    return c.body(null, 400)
  }
  if (typeof payload.d !== 'string' || typeof payload.n !== 'string' || typeof payload.u !== 'string') return c.body(null, 202)
  const site = await getSiteByDomain(c.env.DB, payload.d)
  if (!site) return c.body(null, 202)
  const url = safeUrl(payload.u)
  if (!url || !['http:', 'https:'].includes(url.protocol)) return c.body(null, 202)
  if (!hostBelongsToSite(url.hostname, site.domain)) return c.body(null, 202)

  const now = Math.floor(Date.now() / 1000)
  const localDate = dateForTimestamp(now)
  const ua = c.req.header('User-Agent') ?? ''
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const visitorId = await sha256(`${c.env.SESSION_SECRET ?? ''}|${ip}|${ua}|${localDate}`)
  const sessionId = await sha256(`${visitorId}|${Math.floor(now / 1800)}`)
  const referrer = typeof payload.r === 'string' ? safeUrl(payload.r) : null
  const params = url.searchParams
  const cf = (c.req.raw as Request & { cf?: { country?: string; region?: string; city?: string } }).cf
  const uaInfo = parseUserAgent(ua)
  const props = typeof payload.p === 'string' ? payload.p : JSON.stringify(payload.p ?? {})
  const revenueSource = payload.revenue ?? payload.$
  const revenue = revenueSource && typeof revenueSource === 'object'
    ? revenueSource as { amount?: unknown; currency?: unknown }
    : null
  const amount = typeof revenue?.amount === 'number' ? revenue.amount : typeof revenue?.amount === 'string' ? Number(revenue.amount) : NaN
  const currency = typeof revenue?.currency === 'string' ? revenue.currency.toUpperCase() : ''
  const acceptedRevenue = site.revenue_event === payload.n && site.revenue_currency === currency && Number.isFinite(amount) && Math.abs(amount) < 1_000_000_000

  await c.env.DB.prepare(
    `INSERT INTO pd_events (
      event_id, site_id, ts, name, page, hostname, referrer, referrer_domain,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      visitor_id, session_id, country, region, city, browser, browser_version,
      os, os_version, device, screen, props, revenue_amount, revenue_currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), site.id, now, payload.n.slice(0, 120), url.pathname || '/', url.hostname,
    referrer?.href ?? null, referrer?.hostname.replace(/^www\./, '') ?? null,
    params.get('utm_source'), params.get('utm_medium'), params.get('utm_campaign'), params.get('utm_content'), params.get('utm_term'),
    visitorId, sessionId, cf?.country ?? null, cf?.region ?? null, cf?.city ?? null,
    uaInfo.browser, uaInfo.browserVersion, uaInfo.os, uaInfo.osVersion, uaInfo.device,
    typeof payload.w === 'string' ? payload.w : null, props,
    acceptedRevenue ? amount : null, acceptedRevenue ? currency : null,
  ).run()
  return c.body(null, 202)
}

async function currentVisitors(c: Ctx) {
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.json({ error: 'unknown site' }, 404)
  const row = await c.env.DB.prepare(
    'SELECT COUNT(DISTINCT visitor_id) AS visitors FROM pd_events WHERE site_id = ? AND ts >= ?',
  ).bind(site.id, Math.floor(Date.now() / 1000) - 300).first<{ visitors: number }>()
  return c.json(row?.visitors ?? 0)
}

async function listJourneys(c: Ctx) {
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.json({ error: 'unknown site' }, 404)
  if (!site.revenue_event) return c.json({ goal: null, data: [] })

  const since = Math.floor(Date.now() / 1000) - 30 * DAY_SECONDS
  const rows = await c.env.DB.prepare(
    `WITH conversions AS (
       SELECT event_id AS conversion_id, session_id, ts AS conversion_ts,
              revenue_amount, revenue_currency
       FROM pd_events WHERE site_id = ? AND name = ? AND ts >= ?
       ORDER BY ts DESC LIMIT 30
     )
     SELECT c.conversion_id, c.conversion_ts, c.revenue_amount, c.revenue_currency,
            e.ts, e.name, e.page, e.utm_source, e.referrer_domain
     FROM conversions c JOIN pd_events e ON e.site_id = ? AND e.session_id = c.session_id
       AND e.ts <= c.conversion_ts AND e.ts >= c.conversion_ts - 1800
     ORDER BY c.conversion_ts DESC, e.ts ASC`,
  ).bind(site.id, site.revenue_event, since, site.id).all<{
    conversion_id: string; conversion_ts: number; revenue_amount: number | null; revenue_currency: string | null
    ts: number; name: string; page: string; utm_source: string | null; referrer_domain: string | null
  }>()

  const journeys = new Map<string, {
    converted_at: number; revenue_amount: number | null; revenue_currency: string | null
    source: string | null; events: Array<{ ts: number; name: string; page: string }>
  }>()
  for (const row of rows.results) {
    const journey = journeys.get(row.conversion_id) ?? {
      converted_at: row.conversion_ts,
      revenue_amount: row.revenue_amount,
      revenue_currency: row.revenue_currency,
      source: row.utm_source || row.referrer_domain,
      events: [],
    }
    journey.events.push({ ts: row.ts, name: row.name, page: row.page })
    if (!journey.source && (row.utm_source || row.referrer_domain)) journey.source = row.utm_source || row.referrer_domain
    journeys.set(row.conversion_id, journey)
  }

  return c.json({
    goal: site.revenue_event,
    currency: site.revenue_currency,
    data: [...journeys.values()].map((journey) => ({
      converted_at: journey.converted_at,
      source: journey.source,
      revenue_amount: journey.revenue_amount,
      revenue_currency: journey.revenue_currency,
      events: journey.events,
    })),
  })
}

async function suggestions(c: Ctx) {
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.json({ error: 'unknown site' }, 404)
  const key = c.req.param('key')
  const dimension = suggestionDimension(key ?? '')
  if (!dimension) return c.json([])
  const from = addDays(today(), -89)
  const query = (c.req.query('q') ?? '').toLocaleLowerCase()
  const rows = await getBreakdown(c.env.DB, site.id, site.domain, [dimension], from, today(), 100, true)
  return c.json(rows.map((row) => row.dimensions[0]).filter((value) => value && value.toLocaleLowerCase().includes(query)).slice(0, 20))
}

async function customPropSuggestions(c: Ctx) {
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.json({ error: 'unknown site' }, 404)
  const propKey = c.req.param('propKey')
  const query = (c.req.query('q') ?? '').toLocaleLowerCase()
  const from = addDays(today(), -89)
  const rows = await getBreakdown(c.env.DB, site.id, site.domain, [`event:props:${propKey}`], from, today(), 100, true)
  return c.json(rows.map((row) => row.dimensions[0]).filter((value) => value && value.toLocaleLowerCase().includes(query)).slice(0, 20))
}

async function statsQuery(c: Ctx) {
  const site = await getSiteByDomain(c.env.DB, c.req.param('domain'))
  if (!site) return c.json({ error: 'unknown site' }, 404)
  const body = await c.req.json<StatsQueryBody>().catch(() => null)
  if (!body || !Array.isArray(body.metrics) || !Array.isArray(body.dimensions)) return c.json({ error: 'invalid query' }, 400)
  const range = resolveDateRange(body.date_range, body.relative_date)
  const dimensions = body.dimensions.map(String)
  const metrics = body.metrics.map(String)
  const realtime = String(body.date_range).startsWith('realtime')
  const filters = Array.isArray(body.filters) ? body.filters as ApiFilter[] : []
  const importedAllowed = !!body.include?.imports && !realtime && filters.length === 0
  const importedBreakdownAllowed = importedAllowed || (
    !!body.include?.imports && !realtime &&
    canImportFilteredLocationBreakdown(dimensions, filters)
  )
  const compareRange = getComparisonRange(body.include?.compare, range)
  const revenueGoal = { event: site.revenue_event ?? null, currency: site.revenue_currency ?? null }

  if (dimensions.some((d) => d.startsWith('time'))) {
    const interval = dimensions[0].split(':')[1] ?? (range.days <= 1 ? 'hour' : range.days <= 120 ? 'day' : range.days <= 730 ? 'week' : 'month')
    const includeForGraph = importedAllowed && interval !== 'hour' && interval !== 'minute'
    const series = await graphSeries(c.env.DB, site.id, range, interval, metrics[0] ?? 'visitors', includeForGraph, filters, revenueGoal)
    const comparisonSeries = compareRange
      ? await graphSeries(c.env.DB, site.id, compareRange, interval, metrics[0] ?? 'visitors', importedAllowed && interval !== 'hour' && interval !== 'minute', filters, revenueGoal)
      : []
    return c.json({
      query: { metrics, dimensions, date_range: [range.from, range.to], comparison_date_range: compareRange ? [compareRange.from, compareRange.to] : null },
      meta: {
        imports_included: includeForGraph,
        imports_skip_reason: getImportSkipReason(body.include?.imports, realtime, filters, interval, includeForGraph),
        time_labels: series.map((x) => x.label),
        partial_time_labels: [],
        time_label_result_indices: series.map((_, i) => i),
        comparison_time_labels: comparisonSeries.map((x) => x.label),
        comparison_time_label_result_indices: comparisonSeries.map((_, i) => i),
        comparison_partial_time_labels: [],
        empty_metrics: metrics.map((metric) => metricValue(metric, 0, site.revenue_currency)),
        present_index: range.to === today() ? Math.max(0, series.length - 1) : -1,
      },
      results: series.map((item) => ({ dimensions: [item.label], metrics: [metricValue(metrics[0] ?? 'visitors', item.value, site.revenue_currency)] })),
      comparison_results: comparisonSeries.map((item) => ({ dimensions: [item.label], metrics: [metricValue(metrics[0] ?? 'visitors', item.value, site.revenue_currency)], change: null })),
      extraContext: { isRealtime: realtime, hasConversionGoalFilter: filters.some((f) => f[1] === 'event:goal') },
    })
  }

  if (dimensions.length === 0) {
    const current = await getTotals(c.env.DB, site.id, range, importedAllowed, filters, revenueGoal)
    const comparison = compareRange ? await getTotals(c.env.DB, site.id, compareRange, importedAllowed, filters, revenueGoal) : null
    return c.json({
      query: { metrics, dimensions, date_range: [range.from, range.to], comparison_date_range: compareRange ? [compareRange.from, compareRange.to] : null },
      meta: {
        imports_included: importedAllowed,
        imports_skip_reason: getImportSkipReason(body.include?.imports, realtime, filters, '', importedAllowed),
        ...(site.revenue_event && importedAllowed ? { metric_warnings: {
          total_revenue: { code: 'no_imported_revenue' },
          average_revenue: { code: 'no_imported_revenue' },
        } } : {}),
      },
      results: [{ dimensions: [], metrics: metrics.map((m) => metricValue(m, metricFromStats(m, current), site.revenue_currency)), ...(comparison ? { comparison: { metrics: metrics.map((m) => metricValue(m, metricFromStats(m, comparison), site.revenue_currency) ?? 0), change: metrics.map((m) => metricChange(m, metricFromStats(m, current), metricFromStats(m, comparison))) } } : {}) }],
      extraContext: { isRealtime: realtime, hasConversionGoalFilter: filters.some((f) => f[1] === 'event:goal') },
    })
  }

  const limit = Math.min(1000, body.pagination?.limit ?? 100)
  const rows = await getBreakdown(c.env.DB, site.id, site.domain, dimensions, range.from, range.to, limit, importedBreakdownAllowed, filters, body.pagination?.offset ?? 0, revenueGoal)
  const comparedRows = compareRange ? await getBreakdown(c.env.DB, site.id, site.domain, dimensions, compareRange.from, compareRange.to, limit, importedBreakdownAllowed, filters, 0, revenueGoal) : []
  const comparisonByDimensions = new Map(comparedRows.map((row) => [JSON.stringify(row.dimensions), row]))
  const total = rows.reduce((sum, row) => sum + row.visitors, 0)
  return c.json({
    query: { metrics, dimensions, date_range: [range.from, range.to], comparison_date_range: compareRange ? [compareRange.from, compareRange.to] : null },
    meta: { imports_included: importedBreakdownAllowed, imports_skip_reason: getImportSkipReason(body.include?.imports, realtime, filters, '', importedBreakdownAllowed) },
    results: rows.map((row) => ({
      dimensions: row.dimensions,
      metrics: metrics.map((m) => metricValue(m, breakdownMetric(row, m, total), site.revenue_currency)),
      ...(comparisonByDimensions.has(JSON.stringify(row.dimensions)) ? { comparison: {
        metrics: metrics.map((m) => metricValue(m, breakdownMetric(comparisonByDimensions.get(JSON.stringify(row.dimensions)) as Breakdown, m, total), site.revenue_currency) ?? 0),
        change: metrics.map((m) => metricChange(m, breakdownMetric(row, m, total), breakdownMetric(comparisonByDimensions.get(JSON.stringify(row.dimensions)) as Breakdown, m, total))),
      } } : {})
    })),
    extraContext: { isRealtime: realtime, hasConversionGoalFilter: filters.some((f) => f[1] === 'event:goal') },
  })
}

type StatsQueryBody = {
  date_range: string | [string, string]
  relative_date?: string | null
  filters?: unknown[]
  dimensions: string[]
  metrics: Metric[]
  include?: { imports?: boolean; imports_meta?: boolean; time_labels?: boolean; partial_time_labels?: boolean; compare?: string | [string, string] | null; empty_metrics?: boolean; present_index?: boolean }
  pagination?: { limit?: number; offset?: number; page?: number }
}

type DateRange = { from: string; to: string; days: number }
type Breakdown = { dimensions: string[]; visitors: number; visits: number; pageviews: number; events: number; bounces: number; visit_duration: number; revenue: number; revenue_events: number; bounce_rate: number; views_per_visit: number; time_on_page: number; scroll_depth: number; percentage: number }

function resolveDateRange(input: StatsQueryBody['date_range'], relativeDate?: string | null): DateRange {
  if (Array.isArray(input)) {
    const from = normalizeDate(input[0])
    const to = normalizeDate(input[1])
    return { from, to, days: Math.max(1, Math.floor((dateEpoch(to) - dateEpoch(from)) / DAY_SECONDS) + 1) }
  }
  if (input === 'day' && relativeDate) {
    const date = normalizeDate(relativeDate)
    return { from: date, to: date, days: 1 }
  }
  const end = input === 'yesterday' ? addDays(today(), -1) : today()
  let days = 30
  if (input === 'day' || input === 'today' || input === 'yesterday') days = 1
  else if (input === '7d') days = 7
  else if (input === '28d') days = 28
  else if (input === '30d') days = 30
  else if (input === '91d') days = 91
  else if (input === 'month') return { from: `${end.slice(0, 7)}-01`, to: end, days: Number(end.slice(8)) }
  else if (input === '6mo') days = 183
  else if (input === '12mo') days = 365
  else if (input === 'year') return { from: `${end.slice(0, 4)}-01-01`, to: end, days: Number(end.slice(5, 7)) * 30 }
  else if (input === 'all') return { from: '2024-12-26', to: end, days: Math.floor((dateEpoch(end) - dateEpoch('2024-12-26')) / DAY_SECONDS) + 1 }
  else if (input === 'realtime_30m' || input === 'realtime') return { from: addDays(end, -1), to: end, days: 1 }
  return { from: addDays(end, -(days - 1)), to: end, days }
}

function getComparisonRange(input: string | [string, string] | null | undefined, range: DateRange): DateRange | null {
  if (Array.isArray(input) && input.length === 2) {
    const from = normalizeDate(input[0]); const to = normalizeDate(input[1])
    return { from, to, days: Math.max(1, Math.floor((dateEpoch(to) - dateEpoch(from)) / DAY_SECONDS) + 1) }
  }
  if (input === 'previous_period') {
    const to = addDays(range.from, -1); const from = addDays(to, -(range.days - 1))
    return { from, to, days: range.days }
  }
  if (input === 'year_over_year') {
    const from = shiftDateYears(range.from, -1); const to = shiftDateYears(range.to, -1)
    return { from, to, days: Math.max(1, Math.floor((dateEpoch(to) - dateEpoch(from)) / DAY_SECONDS) + 1) }
  }
  return null
}

function shiftDateYears(date: string, years: number) {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + years); return d.toISOString().slice(0, 10)
}

function getImportSkipReason(includeImports: boolean | undefined, realtime: boolean, filters: ApiFilter[], interval: string, included: boolean) {
  if (!includeImports) return undefined
  if (realtime) return 'unsupported_interval'
  if (filters.length) return 'unsupported_query'
  if (['hour', 'minute'].includes(interval)) return 'unsupported_interval'
  return included ? undefined : 'no_imported_data'
}

function metricChange(metric: string, current: number, previous: number): number | null {
  if (previous === 0) return null
  const change = ['bounce_rate', 'conversion_rate', 'group_conversion_rate', 'exit_rate'].includes(metric)
    ? current - previous
    : (current - previous) / previous * 100
  return Math.round(change * 10) / 10
}

function normalizeDate(value: string) { return value.slice(0, 10) }
function today() { return new Date(Date.now() + TZ_OFFSET * 1000).toISOString().slice(0, 10) }
function dateForTimestamp(ts: number) { return new Date((ts + TZ_OFFSET) * 1000).toISOString().slice(0, 10) }
function dateEpoch(date: string) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - TZ_OFFSET }
function addDays(date: string, amount: number) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10) }

function metricValue(metric: string, value: unknown, currency: string | null | undefined = 'USD'): number | Record<string, string | number> | null {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return 0
  if (metric === 'total_revenue' || metric === 'average_revenue') {
    const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : 'USD'
    const amount = Math.round(n * 100) / 100
    return {
      value: amount,
      currency: code,
      short: new Intl.NumberFormat('en', { style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1 }).format(amount),
      long: new Intl.NumberFormat('en', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(amount),
    }
  }
  if (['bounce_rate', 'conversion_rate', 'group_conversion_rate', 'exit_rate', 'percentage', 'scroll_depth'].includes(metric)) return Math.round(n * 100) / 100
  if (['views_per_visit', 'visit_duration', 'time_on_page'].includes(metric)) return Math.round(n * 100) / 100
  return Math.round(n)
}

async function graphSeries(db: D1Database, siteId: string, range: DateRange, interval: string, metric: string, withImported: boolean, filters: ApiFilter[] = [], revenueGoal: RevenueGoal = { event: null, currency: null }) {
  const dates: string[] = []
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) dates.push(date)
  const importRows = withImported && interval !== 'hour' ? await getArchiveTotals(db, siteId, range.from, range.to) : new Map<string, EventStats>()
  const liveRows = await getLiveDailyTotals(db, siteId, range.from, range.to, filters, revenueGoal)
  const grouped = new Map<string, EventStats>()
  for (const date of dates) {
    const total = addStats(importRows.get(date), liveRows.get(date))
    const label = timeBucket(date, interval)
    grouped.set(label, addStats(grouped.get(label), total))
  }
  if (interval === 'hour' || interval === 'minute') {
    const bucketSeconds = interval === 'minute' ? 60 : 3600
    const bucketCount = interval === 'minute' ? 30 : 24
    const now = Math.floor((Date.now() / 1000 + TZ_OFFSET) / bucketSeconds) * bucketSeconds
    const startTs = now - (bucketCount - 1) * bucketSeconds - TZ_OFFSET
    const filter = liveFilterSql(filters)
    const rows = await db.prepare(
      `SELECT CAST((ts + ?) / ? AS INTEGER) AS bucket, COUNT(DISTINCT visitor_id) AS visitors,
       COUNT(DISTINCT session_id) AS visits, SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
       SUM(CASE WHEN name = ? AND revenue_currency = ? THEN COALESCE(revenue_amount, 0) ELSE 0 END) AS revenue,
       SUM(CASE WHEN name = ? AND revenue_currency = ? AND revenue_amount IS NOT NULL THEN 1 ELSE 0 END) AS revenue_events,
       COUNT(*) AS events, 0 AS bounces, 0 AS visit_duration
       FROM pd_events WHERE site_id = ? AND ts >= ?${filter.sql} GROUP BY bucket ORDER BY bucket`,
    ).bind(TZ_OFFSET, bucketSeconds, revenueGoal.event, revenueGoal.currency, revenueGoal.event, revenueGoal.currency, siteId, startTs, ...filter.values).all<EventStats & { bucket: number }>()
    const perHour = new Map<string, EventStats>()
    for (const row of rows.results) {
      const label = new Date(row.bucket * bucketSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
      perHour.set(label, row)
    }
    const labels: string[] = []
    for (let bucket = now - (bucketCount - 1) * bucketSeconds; bucket <= now; bucket += bucketSeconds) labels.push(new Date(bucket * 1000).toISOString().slice(0, 16).replace('T', ' '))
    return labels.map((label) => ({ label, value: metricFromStats(metric, perHour.get(label) ?? zeroStats(label)) }))
  }
  return [...grouped].map(([label, stats]) => ({ label, value: metricFromStats(metric, stats) }))
}

async function getArchiveTotals(db: D1Database, siteId: string, from: string, to: string) {
  const result = await db.prepare(
    `SELECT date, payload FROM plausible_history WHERE site_id = ? AND dataset = 'visitors' AND date >= ? AND date <= ? ORDER BY date`,
  ).bind(siteId, from, to).all<{ date: string; payload: string }>()
  return new Map(result.results.map((row) => [row.date, payloadToStats(row.date, JSON.parse(row.payload))]))
}

async function getLiveDailyTotals(db: D1Database, siteId: string, from: string, to: string, filters: ApiFilter[] = [], revenueGoal: RevenueGoal = { event: null, currency: null }) {
  const fromTs = Math.max(dateEpoch(from), SNAPSHOT_SECONDS)
  const toTs = dateEpoch(addDays(to, 1))
  const filter = liveFilterSql(filters)
  const result = await db.prepare(
    `WITH per_session AS (
       SELECT date(ts + ?, 'unixepoch') AS date, session_id, MAX(visitor_id) AS visitor_id,
        SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
        SUM(CASE WHEN name = ? AND revenue_currency = ? THEN COALESCE(revenue_amount, 0) ELSE 0 END) AS revenue,
        SUM(CASE WHEN name = ? AND revenue_currency = ? AND revenue_amount IS NOT NULL THEN 1 ELSE 0 END) AS revenue_events,
        COUNT(*) AS events, MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM pd_events WHERE site_id = ? AND ts >= ? AND ts < ?${filter.sql} GROUP BY date, session_id
     )
     SELECT date, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS visits,
       SUM(pageviews) AS pageviews, SUM(events) AS events,
       SUM(revenue) AS revenue, SUM(revenue_events) AS revenue_events,
       SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END) AS bounces,
       SUM(last_ts - first_ts) AS visit_duration
     FROM per_session GROUP BY date`,
  ).bind(TZ_OFFSET, revenueGoal.event, revenueGoal.currency, revenueGoal.event, revenueGoal.currency, siteId, fromTs, toTs, ...filter.values).all<EventStats>()
  return new Map(result.results.map((row) => [row.date, normalizeStats(row)]))
}

async function getTotals(db: D1Database, siteId: string, range: DateRange, withImported: boolean, filters: ApiFilter[], revenueGoal: RevenueGoal) {
  const archived = withImported ? await getArchiveTotals(db, siteId, range.from, range.to) : new Map<string, EventStats>()
  const live = await getLiveDailyTotals(db, siteId, range.from, range.to, filters, revenueGoal)
  let total = zeroStats()
  for (const row of [...archived.values(), ...live.values()]) total = addStats(total, row)
  return total
}

function payloadToStats(date: string, payload: ArchivePayload): EventStats {
  return normalizeStats({ date, visitors: numeric(payload.visitors), visits: numeric(payload.visits), pageviews: numeric(payload.pageviews), bounces: numeric(payload.bounces), visit_duration: numeric(payload.visit_duration), events: numeric(payload.events), revenue: 0, revenue_events: 0 })
}
function numeric(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0 }
function normalizeStats(stats: Partial<EventStats> & { date?: string }): EventStats {
  return { date: stats.date ?? '', visitors: Number(stats.visitors ?? 0), visits: Number(stats.visits ?? 0), pageviews: Number(stats.pageviews ?? 0), events: Number(stats.events ?? stats.pageviews ?? 0), bounces: Number(stats.bounces ?? 0), visit_duration: Number(stats.visit_duration ?? 0), revenue: Number(stats.revenue ?? 0), revenue_events: Number(stats.revenue_events ?? 0) }
}
function zeroStats(date = ''): EventStats { return normalizeStats({ date }) }
function addStats(a?: Partial<EventStats>, b?: Partial<EventStats>): EventStats {
  return normalizeStats({ date: a?.date ?? b?.date, visitors: Number(a?.visitors ?? 0) + Number(b?.visitors ?? 0), visits: Number(a?.visits ?? 0) + Number(b?.visits ?? 0), pageviews: Number(a?.pageviews ?? 0) + Number(b?.pageviews ?? 0), events: Number(a?.events ?? 0) + Number(b?.events ?? 0), bounces: Number(a?.bounces ?? 0) + Number(b?.bounces ?? 0), visit_duration: Number(a?.visit_duration ?? 0) + Number(b?.visit_duration ?? 0), revenue: Number(a?.revenue ?? 0) + Number(b?.revenue ?? 0), revenue_events: Number(a?.revenue_events ?? 0) + Number(b?.revenue_events ?? 0) })
}
function metricFromStats(metric: string, stats: EventStats) {
  if (metric === 'visitors' || metric === 'total_visitors') return stats.visitors
  if (metric === 'visits') return stats.visits
  if (metric === 'pageviews') return stats.pageviews
  if (metric === 'events') return stats.events
  if (metric === 'total_revenue') return stats.revenue
  if (metric === 'average_revenue') return stats.revenue_events ? stats.revenue / stats.revenue_events : 0
  if (metric === 'bounce_rate') return stats.visits ? stats.bounces / stats.visits * 100 : 0
  if (metric === 'visit_duration' || metric === 'time_on_page') return stats.visits ? stats.visit_duration / stats.visits : 0
  if (metric === 'views_per_visit') return stats.visits ? stats.pageviews / stats.visits : 0
  if (metric === 'scroll_depth' || metric === 'conversion_rate' || metric === 'group_conversion_rate' || metric === 'exit_rate') return 0
  if (metric === 'total_visitors') return stats.visitors
  return 0
}
function timeBucket(date: string, interval: string) {
  if (interval === 'month') return date.slice(0, 7)
  if (interval === 'week') {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    return d.toISOString().slice(0, 10)
  }
  return date
}

async function getBreakdown(db: D1Database, siteId: string, domain: string, dimensions: string[], from: string, to: string, limit: number, withImported: boolean, filters: ApiFilter[] = [], offset = 0, revenueGoal: RevenueGoal = { event: null, currency: null }): Promise<Breakdown[]> {
  const values = new Map<string, Breakdown>()
  const archive = dimensions.map(archiveDimensionConfig)
  const archiveDataset = archive[0]?.dataset
  const archiveCompatible = archive.length > 0 && !!archiveDataset && archive.every((item) => item?.dataset === archiveDataset)

  if (withImported && dimensions.length === 1 && dimensions[0] === 'visit:channel') {
    const rows = await db.prepare(
      `SELECT payload FROM plausible_history WHERE site_id = ? AND dataset = 'sources' AND date >= ? AND date <= ?`,
    ).bind(siteId, from, to).all<{ payload: string }>()
    for (const item of rows.results) {
      const payload = JSON.parse(item.payload) as ArchivePayload
      const channel = String(payload.channel || classifyChannel(payload))
      addBreakdownStats(values, [channel], payloadToStats('', payload))
    }
  }

  if (withImported && archiveCompatible) {
    const expressions = archive.map((item, index) => `${item?.expr} AS d${index}`)
    const groups = archive.map((item) => item?.expr)
    const archiveWhere = archive.flatMap((item) => item?.where ?? [])
    const archiveFilterWhere = archiveFilterConditions(filters, archiveDataset)
    const allArchiveWhere = [...archiveWhere, ...archiveFilterWhere]
    const extraWhere = allArchiveWhere.map((where) => ` AND ${where.sql}`).join('')
    const sql = `SELECT ${expressions.join(', ')},
       COALESCE(SUM(CAST(json_extract(payload, '$.visitors') AS INTEGER)), 0) AS visitors,
       COALESCE(SUM(CAST(json_extract(payload, '$.visits') AS INTEGER)), 0) AS visits,
       COALESCE(SUM(CAST(json_extract(payload, '$.pageviews') AS INTEGER)), 0) AS pageviews,
       COALESCE(SUM(CAST(COALESCE(json_extract(payload, '$.events'), json_extract(payload, '$.pageviews'), 0) AS INTEGER)), 0) AS events,
       COALESCE(SUM(CAST(json_extract(payload, '$.bounces') AS INTEGER)), 0) AS bounces,
       COALESCE(SUM(CAST(json_extract(payload, '$.visit_duration') AS REAL)), 0) AS visit_duration,
       COALESCE(SUM(CAST(json_extract(payload, '$.total_time_on_page') AS REAL)) / NULLIF(SUM(CAST(json_extract(payload, '$.total_time_on_page_visits') AS REAL)), 0), 0) AS time_on_page,
       COALESCE(SUM(CAST(json_extract(payload, '$.total_scroll_depth') AS REAL)) / NULLIF(SUM(CAST(json_extract(payload, '$.total_scroll_depth_visits') AS REAL)), 0), 0) AS scroll_depth
       FROM plausible_history WHERE site_id = ? AND dataset = ? AND date >= ? AND date <= ?${extraWhere}
       GROUP BY ${groups.join(', ')} ORDER BY visitors DESC LIMIT 1000`
    const binds = [siteId, archiveDataset, from, to, ...allArchiveWhere.flatMap((where) => where.values)]
    const rows = await db.prepare(sql).bind(...binds).all<Record<string, unknown> & Partial<Breakdown>>()
    for (const row of rows.results) {
      const rowDimensions = dimensions.map((dimension, index) => normalizeDimension(dimension, row[`d${index}`], domain))
      if (rowDimensions.some((value) => !value)) continue
      const key = JSON.stringify(rowDimensions)
      values.set(key, { ...zeroBreakdown(rowDimensions), ...normalizeStats(row), time_on_page: numeric(row.time_on_page), scroll_depth: numeric(row.scroll_depth), dimensions: rowDimensions })
    }
  }

  const liveFrom = Math.max(dateEpoch(from), SNAPSHOT_SECONDS)
  const liveTo = dateEpoch(addDays(to, 1))
  const liveConfigs = dimensions.map(liveColumnConfig)
  if (liveTo > liveFrom && dimensions.length === 1 && dimensions[0] === 'visit:channel') {
    const filter = liveFilterSql(filters)
    const result = await db.prepare(
      `SELECT utm_source, referrer_domain, utm_medium, utm_campaign, COUNT(DISTINCT visitor_id) AS visitors,
       COUNT(DISTINCT session_id) AS visits, SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
       SUM(CASE WHEN name = ? AND revenue_currency = ? THEN COALESCE(revenue_amount, 0) ELSE 0 END) AS revenue,
       SUM(CASE WHEN name = ? AND revenue_currency = ? AND revenue_amount IS NOT NULL THEN 1 ELSE 0 END) AS revenue_events,
       COUNT(*) AS events, 0 AS bounces, 0 AS visit_duration
       FROM pd_events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview'${filter.sql}
       GROUP BY utm_source, referrer_domain, utm_medium, utm_campaign ORDER BY visitors DESC LIMIT 1000`,
    ).bind(revenueGoal.event, revenueGoal.currency, revenueGoal.event, revenueGoal.currency, siteId, liveFrom, liveTo, ...filter.values).all<Partial<Breakdown> & { utm_source: string | null; referrer_domain: string | null; utm_medium: string | null; utm_campaign: string | null }>()
    for (const row of result.results) {
      const channel = classifyChannel({ source: row.utm_source || row.referrer_domain || '', utm_source: row.utm_source, utm_medium: row.utm_medium, utm_campaign: row.utm_campaign })
      addBreakdownStats(values, [channel], normalizeStats(row))
    }
  } else if (liveTo > liveFrom && liveConfigs.every(Boolean)) {
    const dimensionExpressions = liveConfigs.map((config, index) => `${config?.expr} AS d${index}`)
    const whereClauses = liveConfigs.flatMap((config) => config?.where ? [config.where] : [])
    const filter = liveFilterSql(filters)
    const result = await db.prepare(
      `SELECT ${dimensionExpressions.join(', ')}, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS visits,
       SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
       SUM(CASE WHEN name = ? AND revenue_currency = ? THEN COALESCE(revenue_amount, 0) ELSE 0 END) AS revenue,
       SUM(CASE WHEN name = ? AND revenue_currency = ? AND revenue_amount IS NOT NULL THEN 1 ELSE 0 END) AS revenue_events,
       COUNT(*) AS events, 0 AS bounces, 0 AS visit_duration
       FROM pd_events WHERE site_id = ? AND ts >= ? AND ts < ?${whereClauses.map((where) => ` AND ${where}`).join('')}${filter.sql}
       GROUP BY ${liveConfigs.map((config) => config?.expr).join(', ')} ORDER BY visitors DESC LIMIT 1000`,
    ).bind(revenueGoal.event, revenueGoal.currency, revenueGoal.event, revenueGoal.currency, siteId, liveFrom, liveTo, ...filter.values).all<Record<string, unknown> & Partial<Breakdown>>()
    for (const row of result.results) {
      const rowDimensions = dimensions.map((dimension, index) => normalizeDimension(dimension, row[`d${index}`], domain))
      if (rowDimensions.some((value) => !value)) continue
      const key = JSON.stringify(rowDimensions)
      const previous = values.get(key) ?? zeroBreakdown(rowDimensions)
      values.set(key, {
        ...previous,
        visitors: previous.visitors + Number(row.visitors ?? 0),
        visits: previous.visits + Number(row.visits ?? 0),
        pageviews: previous.pageviews + Number(row.pageviews ?? 0),
        events: previous.events + Number(row.events ?? 0),
        revenue: previous.revenue + Number(row.revenue ?? 0),
        revenue_events: previous.revenue_events + Number(row.revenue_events ?? 0),
      })
    }
  }

  const sorted = [...values.values()].sort((a, b) => b.visitors - a.visitors)
  const totalVisitors = sorted.reduce((sum, row) => sum + row.visitors, 0)
  return sorted.slice(offset, offset + limit).map((row) => ({ ...row, percentage: totalVisitors ? row.visitors / totalVisitors * 100 : 0, bounce_rate: row.visits ? row.bounces / row.visits * 100 : 0, views_per_visit: row.visits ? row.pageviews / row.visits : 0 }))
}

function zeroBreakdown(dimensions: string[]): Breakdown { return { dimensions, visitors: 0, visits: 0, pageviews: 0, events: 0, bounces: 0, visit_duration: 0, revenue: 0, revenue_events: 0, bounce_rate: 0, views_per_visit: 0, time_on_page: 0, scroll_depth: 0, percentage: 0 } }
function addBreakdownStats(values: Map<string, Breakdown>, dimensions: string[], stats: EventStats) {
  const key = JSON.stringify(dimensions)
  const previous = values.get(key) ?? zeroBreakdown(dimensions)
  values.set(key, {
    ...previous,
    visitors: previous.visitors + stats.visitors,
    visits: previous.visits + stats.visits,
    pageviews: previous.pageviews + stats.pageviews,
    events: previous.events + stats.events,
    bounces: previous.bounces + stats.bounces,
    visit_duration: previous.visit_duration + stats.visit_duration,
    revenue: previous.revenue + stats.revenue,
    revenue_events: previous.revenue_events + stats.revenue_events,
  })
}

function classifyChannel(input: ArchivePayload) {
  const source = normalizedSource(String(input.source ?? input.utm_source ?? ''))
  const utmSource = normalizedSource(String(input.utm_source ?? ''))
  const medium = String(input.utm_medium ?? '').trim().toLowerCase()
  const campaign = String(input.utm_campaign ?? '').trim().toLowerCase()
  const category = SOURCE_CATEGORIES[source] ?? SOURCE_CATEGORIES[source.split('.')[0]] ?? ''
  const paidCategory = PAID_SOURCES.has(utmSource)
  const paidMedium = medium.includes('cp') || medium === 'ppc' || medium === 'retargeting' || medium.startsWith('paid')
  const socialMedium = ['social', 'social-network', 'social-media', 'sm', 'social network', 'social media'].includes(medium)
  const emailTags = ['email', 'e-mail', 'e_mail', 'e mail', 'newsletter']
  const hasEmailTag = (value: string) => emailTags.some((tag) => value.includes(tag))

  if (campaign.includes('cross-network')) return 'Cross-network'
  if ((category === 'SOURCE_CATEGORY_SHOPPING' || /shop|shopping/.test(campaign)) && paidMedium) return 'Paid Shopping'
  if ((category === 'SOURCE_CATEGORY_SEARCH' && paidMedium) || (category === 'SOURCE_CATEGORY_SEARCH' && paidCategory) || (source === 'google' && input.gclid) || (source === 'bing' && input.msclkid)) return 'Paid Search'
  if (category === 'SOURCE_CATEGORY_SOCIAL' && (paidMedium || paidCategory)) return 'Paid Social'
  if (category === 'SOURCE_CATEGORY_VIDEO' && (paidMedium || paidCategory)) return 'Paid Video'
  if (['display', 'banner', 'expandable', 'interstitial', 'cpm'].includes(medium)) return 'Display'
  if (paidMedium) return 'Paid Other'
  if (category === 'SOURCE_CATEGORY_SHOPPING' || /shop|shopping/.test(campaign)) return 'Organic Shopping'
  if (category === 'SOURCE_CATEGORY_SOCIAL' || socialMedium) return 'Organic Social'
  if (category === 'SOURCE_CATEGORY_VIDEO' || medium.includes('video')) return 'Organic Video'
  if (category === 'SOURCE_CATEGORY_AI_ASSISTANTS') return 'AI Assistants'
  if (category === 'SOURCE_CATEGORY_SEARCH') return 'Organic Search'
  if (category === 'SOURCE_CATEGORY_EMAIL' || hasEmailTag(source) || hasEmailTag(utmSource) || hasEmailTag(medium)) return 'Email'
  if (medium === 'affiliate') return 'Affiliates'
  if (medium === 'audio') return 'Audio'
  if (utmSource === 'sms' || medium === 'sms') return 'SMS'
  if (medium.endsWith('push') || medium.includes('mobile') || medium.includes('notification') || source === 'firebase') return 'Mobile Push Notifications'
  if (['referral', 'app', 'link'].includes(medium) || source) return 'Referral'
  return 'Direct'
}

function normalizedSource(source: string) {
  let value = source.trim().toLowerCase()
  try { if (/^https?:\/\//.test(value)) value = new URL(value).hostname } catch { /* retain the original source text */ }
  value = value.replace(/^www\./, '')
  return value
}

function breakdownMetric(row: Breakdown, metric: string, totalVisitors: number) {
  if (metric === 'total_visitors') return row.visitors
  if (metric === 'group_conversion_rate' || metric === 'conversion_rate') return totalVisitors ? row.visitors / totalVisitors * 100 : 0
  if (metric === 'total_revenue') return row.revenue
  if (metric === 'average_revenue') return row.revenue_events ? row.revenue / row.revenue_events : 0
  return Number((row as unknown as Record<string, unknown>)[metric] ?? (metric === 'percentage' ? (totalVisitors ? row.visitors / totalVisitors * 100 : 0) : 0))
}
type SqlCondition = { sql: string; values: unknown[] }
type ArchiveDimension = { dataset: string; expr: string; where?: SqlCondition[] }

function archiveDimensionConfig(dim: string): ArchiveDimension | null {
  if (dim.startsWith('event:props:')) {
    return { dataset: 'custom_props', expr: "json_extract(payload, '$.value')", where: [{ sql: "json_extract(payload, '$.property') = ?", values: [dim.slice('event:props:'.length)] }] }
  }
  if (dim === 'visit:channel') return null
  const map: Record<string, [string, string]> = {
    'event:page': ['pages', '$.page'], 'event:hostname': ['pages', '$.hostname'],
    'visit:source': ['sources', '$.source'], 'visit:referrer': ['sources', '$.referrer'],
    'visit:utm_source': ['sources', '$.utm_source'], 'visit:utm_medium': ['sources', '$.utm_medium'],
    'visit:utm_campaign': ['sources', '$.utm_campaign'], 'visit:utm_content': ['sources', '$.utm_content'], 'visit:utm_term': ['sources', '$.utm_term'],
    'visit:country': ['locations', '$.country'], 'visit:country_name': ['locations', '$.country'],
    'visit:region': ['locations', '$.region'], 'visit:region_name': ['locations', '$.region'],
    'visit:city': ['locations', '$.city'], 'visit:city_name': ['locations', '$.city'],
    'visit:browser': ['browsers', '$.browser'], 'visit:browser_version': ['browsers', '$.browser_version'],
    'visit:os': ['operating_systems', '$.operating_system'], 'visit:os_version': ['operating_systems', '$.operating_system_version'],
    'visit:device': ['devices', '$.device'], 'visit:screen': ['devices', '$.screen'],
    'visit:entry_page': ['entry_pages', '$.entry_page'], 'visit:entry_page_hostname': ['entry_pages', '$.hostname'],
    'visit:exit_page': ['exit_pages', '$.exit_page'], 'visit:exit_page_hostname': ['exit_pages', '$.hostname'],
    'event:goal': ['custom_events', '$.name'],
  }
  const config = map[dim]
  if (!config) return null
  const [dataset, path] = config
  return { dataset, expr: `json_extract(payload, '${path}')` }
}

function canImportFilteredLocationBreakdown(dimensions: string[], filters: ApiFilter[]) {
  if (!dimensions.length || !filters.length) return false
  const allDimensions = [...dimensions, ...filters.map((filter) => filter[1])]
  if (!allDimensions.every((dimension) => archiveDimensionConfig(dimension)?.dataset === 'locations')) return false
  return filters.every((filter) =>
    ['is', 'is_not', 'contains', 'contains_not'].includes(filter[0]) &&
    Array.isArray(filter[2]) &&
    filter[2].length > 0
  )
}

function archiveFilterConditions(filters: ApiFilter[], dataset: string): SqlCondition[] {
  return filters.flatMap(([operator, dimension, clauses, modifiers]) => {
    const config = archiveDimensionConfig(dimension)
    if (!config || config.dataset !== dataset || !clauses.length) return []
    const caseSensitive = modifiers?.case_sensitive === true
    const rawExpr = `CAST(${config.expr} AS TEXT)`
    const expr = caseSensitive ? rawExpr : `LOWER(${rawExpr})`
    const normalized = clauses.map((clause) => caseSensitive ? String(clause) : String(clause).toLowerCase())
    if (operator === 'is' || operator === 'is_not') {
      return [{
        sql: `${expr} ${operator === 'is' ? 'IN' : 'NOT IN'} (${normalized.map(() => '?').join(',')})`,
        values: normalized
      }]
    }
    if (operator === 'contains' || operator === 'contains_not') {
      const matcher = operator === 'contains' ? 'LIKE' : 'NOT LIKE'
      return [{
        sql: `(${normalized.map(() => `${expr} ${matcher} ?`).join(operator === 'contains' ? ' OR ' : ' AND ')})`,
        values: normalized.map((value) => `%${value}%`)
      }]
    }
    return []
  })
}

function liveColumnConfig(dim: string): { expr: string; where?: string } | null {
  if (dim.startsWith('event:props:')) {
    const propertyPath = `$.${JSON.stringify(dim.slice('event:props:'.length))}`
    return { expr: `NULLIF(json_extract(props, '${propertyPath}'), '')`, where: " AND name <> 'pageview'" }
  }
  const columns: Record<string, string> = {
    'event:page': 'page', 'event:hostname': 'hostname', 'visit:source': "COALESCE(NULLIF(utm_source, ''), NULLIF(referrer_domain, ''), NULLIF(referrer, ''))", 'visit:referrer': 'referrer',
    'visit:utm_source': 'utm_source', 'visit:utm_medium': 'utm_medium', 'visit:utm_campaign': 'utm_campaign', 'visit:utm_content': 'utm_content', 'visit:utm_term': 'utm_term',
    'visit:country': 'country', 'visit:country_name': 'country', 'visit:region': 'region', 'visit:region_name': 'region', 'visit:city': 'city', 'visit:city_name': 'city',
    'visit:browser': 'browser', 'visit:browser_version': 'browser_version', 'visit:os': 'os', 'visit:os_version': 'os_version', 'visit:device': 'device', 'visit:screen': 'screen',
    'visit:entry_page': 'page', 'visit:entry_page_hostname': 'hostname', 'visit:exit_page': 'page', 'visit:exit_page_hostname': 'hostname', 'event:goal': 'name',
  }
  if (dim === 'visit:channel') return { expr: channelSql(), where: " AND name = 'pageview'" }
  const col = columns[dim]
  if (!col) return null
  return { expr: `NULLIF(${col}, '')`, where: dim === 'event:goal' ? "name <> 'pageview'" : dim.startsWith('visit:') ? "name = 'pageview'" : '' }
}

function channelSql() {
  const source = "lower(coalesce(nullif(utm_source, ''), nullif(referrer_domain, ''), ''))"
  const medium = "lower(coalesce(utm_medium, ''))"
  const campaign = "lower(coalesce(utm_campaign, ''))"
  const category = (kind: string) => `EXISTS (SELECT 1 FROM pd_source_categories AS source_category WHERE source_category.category = '${kind}' AND (${source} = source_category.source OR ${source} LIKE '%.' || source_category.source))`
  const paidSource = `EXISTS (SELECT 1 FROM pd_source_categories AS paid_source WHERE paid_source.category = 'PAID_SOURCE' AND lower(coalesce(utm_source,'')) = paid_source.source)`
  const paidMedium = `(${medium} LIKE '%cp%' OR ${medium} IN ('ppc','retargeting') OR ${medium} LIKE 'paid%')`
  const socialMedium = `${medium} IN ('social','social-network','social-media','sm','social network','social media')`
  const emailTags = (expr: string) => `${expr} LIKE '%email%' OR ${expr} LIKE '%e-mail%' OR ${expr} LIKE '%newsletter%'`
  return `CASE
    WHEN ${campaign} LIKE '%cross-network%' THEN 'Cross-network'
    WHEN (${category('SOURCE_CATEGORY_SHOPPING')} OR ${campaign} LIKE '%shop%' OR ${campaign} LIKE '%shopping%') AND ${paidMedium} THEN 'Paid Shopping'
    WHEN (${category('SOURCE_CATEGORY_SEARCH')} AND (${paidMedium} OR ${paidSource})) THEN 'Paid Search'
    WHEN ${category('SOURCE_CATEGORY_SOCIAL')} AND (${paidMedium} OR ${paidSource}) THEN 'Paid Social'
    WHEN ${category('SOURCE_CATEGORY_VIDEO')} AND (${paidMedium} OR ${paidSource}) THEN 'Paid Video'
    WHEN ${medium} IN ('display','banner','expandable','interstitial','cpm') THEN 'Display'
    WHEN ${paidMedium} THEN 'Paid Other'
    WHEN ${category('SOURCE_CATEGORY_SHOPPING')} OR ${campaign} LIKE '%shop%' OR ${campaign} LIKE '%shopping%' THEN 'Organic Shopping'
    WHEN ${category('SOURCE_CATEGORY_SOCIAL')} OR ${socialMedium} THEN 'Organic Social'
    WHEN ${category('SOURCE_CATEGORY_VIDEO')} OR ${medium} LIKE '%video%' THEN 'Organic Video'
    WHEN ${category('SOURCE_CATEGORY_AI_ASSISTANTS')} THEN 'AI Assistants'
    WHEN ${category('SOURCE_CATEGORY_SEARCH')} THEN 'Organic Search'
    WHEN ${category('SOURCE_CATEGORY_EMAIL')} OR ${emailTags(source)} OR ${emailTags("lower(coalesce(utm_source,''))")} OR ${emailTags(medium)} THEN 'Email'
    WHEN ${medium} = 'affiliate' THEN 'Affiliates'
    WHEN ${medium} = 'audio' THEN 'Audio'
    WHEN lower(coalesce(utm_source,'')) = 'sms' OR ${medium} = 'sms' THEN 'SMS'
    WHEN ${medium} LIKE '%push' OR ${medium} LIKE '%mobile%' OR ${medium} LIKE '%notification%' OR ${source} = 'firebase' THEN 'Mobile Push Notifications'
    WHEN ${source} != '' OR ${medium} IN ('referral','app','link') THEN 'Referral'
    ELSE 'Direct' END`
}

function liveFilterSql(filters: ApiFilter[]) {
  const conditions: string[] = []
  const values: unknown[] = []
  for (const filter of filters) {
    if (!Array.isArray(filter) || filter.length < 3) continue
    const [operator, dimension, clauses, modifiers] = filter
    const column = liveFilterColumn(dimension)
    if (!column || !Array.isArray(clauses) || clauses.length === 0) continue
    const insensitive = modifiers?.case_sensitive !== true
    const expr = insensitive ? `lower(CAST(${column} AS TEXT))` : `CAST(${column} AS TEXT)`
    const normalized = clauses.map((clause) => insensitive ? String(clause).toLowerCase() : String(clause))
    if (operator === 'is' || operator === 'is_not') {
      conditions.push(`${expr} ${operator === 'is' ? 'IN' : 'NOT IN'} (${normalized.map(() => '?').join(',')})`)
      values.push(...normalized)
    } else if (operator === 'contains' || operator === 'contains_not') {
      const parts = normalized.map(() => `${expr} ${operator === 'contains' ? 'LIKE' : 'NOT LIKE'} ?`)
      conditions.push(`(${parts.join(operator === 'contains' ? ' OR ' : ' AND ')})`)
      values.push(...normalized.map((value) => `%${value}%`))
    }
  }
  return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', values }
}

function liveFilterColumn(dim: string) {
  if (dim.startsWith('event:props:')) {
    const propertyPath = `$.${JSON.stringify(dim.slice('event:props:'.length))}`
    return `json_extract(props, '${propertyPath}')`
  }
  if (dim === 'visit:channel') return `(${channelSql()})`
  const map: Record<string, string> = {
    'event:page': 'page', 'event:hostname': 'hostname', 'visit:source': 'referrer_domain', 'visit:referrer': 'referrer',
    'visit:utm_source': 'utm_source', 'visit:utm_medium': 'utm_medium', 'visit:utm_campaign': 'utm_campaign',
    'visit:utm_content': 'utm_content', 'visit:utm_term': 'utm_term', 'visit:country': 'country', 'visit:country_name': 'country',
    'visit:region': 'region', 'visit:region_name': 'region', 'visit:city': 'city', 'visit:city_name': 'city',
    'visit:browser': 'browser', 'visit:browser_version': 'browser_version', 'visit:os': 'os', 'visit:os_version': 'os_version',
    'visit:device': 'device', 'visit:screen': 'screen', 'visit:entry_page': 'page', 'visit:entry_page_hostname': 'hostname',
    'visit:exit_page': 'page', 'visit:exit_page_hostname': 'hostname', 'event:goal': 'name',
  }
  return map[dim] ?? null
}

function normalizeDimension(key: string, raw: unknown, domain: string): string {
  const value = String(raw ?? '').trim()
  if (!value || value === '0' || value === 'null') {
    return key.endsWith('_hostname') ? domain : ''
  }
  if (key === 'visit:country_name') {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(value) ?? value } catch { return value }
  }
  if (key === 'visit:region_name') return REGION_NAMES[value] ?? value
  if (key === 'visit:city_name' && /^\d+$/.test(value)) return CITY_NAMES[value] ?? `City ${value}`
  if ((key === 'visit:source' || key === 'visit:referrer') && /^https?:\/\//i.test(value)) {
    try { return new URL(value).hostname.replace(/^www\./, '') } catch { return value }
  }
  return value
}
function suggestionDimension(key: string) {
  const map: Record<string, string> = { source: 'visit:source', goal: 'event:goal', page: 'event:page', country: 'visit:country', region: 'visit:region', city: 'visit:city', browser: 'visit:browser', os: 'visit:os', device: 'visit:device', utm_campaign: 'visit:utm_campaign', utm_source: 'visit:utm_source', utm_medium: 'visit:utm_medium', utm_term: 'visit:utm_term', utm_content: 'visit:utm_content' }
  return map[key]
}

function payloadValue(row: Breakdown, metric: string) { return row[metric as keyof Breakdown] }

async function makeSession(secret: string) {
  const expires = Date.now() + 14 * 24 * 3600_000
  return `${expires}.${await hmac(secret, String(expires))}`
}
async function isSignedIn(cookie: string | undefined, secret: string | undefined) {
  if (!cookie || !secret) return false
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_COOKIE}=`))?.slice(AUTH_COOKIE.length + 1)
  const [expiresText, signature] = token?.split('.') ?? []
  const expires = Number(expiresText)
  if (!expires || expires < Date.now() || !signature) return false
  return constantEqual(signature, await hmac(secret, String(expires)))
}
async function sameSecret(given: string, expected: string, secret: string) {
  return constantEqual(await hmac(secret, given), await hmac(secret, expected))
}
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function constantEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let value = 0
  for (let i = 0; i < a.length; i++) value |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return value === 0
}
function safeUrl(value: string) {
  try { return new URL(value) } catch { return null }
}
function parseUserAgent(ua: string) {
  const browser = /Edg\//.test(ua) ? ['Microsoft Edge', /Edg\/([\d.]+)/.exec(ua)?.[1]]
    : /Firefox\//.test(ua) ? ['Firefox', /Firefox\/([\d.]+)/.exec(ua)?.[1]]
      : /Chrome\//.test(ua) ? ['Chrome', /Chrome\/([\d.]+)/.exec(ua)?.[1]]
        : /Safari\//.test(ua) ? ['Safari', /Version\/([\d.]+)/.exec(ua)?.[1]] : ['Other', '']
  const os = /Android/.test(ua) ? ['Android', /Android ([\d.]+)/.exec(ua)?.[1]]
    : /iPhone|iPad|iPod/.test(ua) ? ['iOS', /OS ([\d_]+)/.exec(ua)?.[1]?.replaceAll('_', '.')]
      : /Windows/.test(ua) ? ['Windows', ''] : /Mac OS X/.test(ua) ? ['macOS', /Mac OS X ([\d_]+)/.exec(ua)?.[1]?.replaceAll('_', '.')]
        : /Linux/.test(ua) ? ['Linux', ''] : ['Other', '']
  return { browser: browser[0], browserVersion: browser[1] ?? '', os: os[0], osVersion: os[1] ?? '', device: /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobile|Android|iPhone/.test(ua) ? 'Mobile' : 'Desktop' }
}
function loginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Log in · Plausible</title><link rel="stylesheet" href="/assets/app.css"></head><body class="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100"><main class="mx-auto mt-24 max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900"><h1 class="text-2xl font-semibold">Plausible Analytics</h1><p class="mt-2 text-sm text-gray-500">Sign in to view viralhooks.org</p>${error ? `<p class="mt-4 text-sm text-red-600">${error}</p>` : ''}<form method="post" action="/login" class="mt-6"><label for="password" class="mb-2 block text-sm font-medium">Dashboard password</label><input id="password" name="password" type="password" autocomplete="current-password" required class="block w-full rounded-md border-gray-300 dark:border-gray-700 dark:bg-gray-800"><button class="mt-4 w-full rounded-md bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-700">Log in</button></form></main></body></html>`
}

export default app

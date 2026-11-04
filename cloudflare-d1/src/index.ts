import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import cityNames from '../data/geonames-city-names.json'
import regionNames from '../data/region-names.json'
import sourceClassification from '../data/source-classification.json'

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
}
type ArchivePayload = Record<string, unknown>
type ApiFilter = [string, string, Array<string | number>, { case_sensitive?: boolean }?]

const app: App = new Hono()
const SITE_ID = '052l044a524h1w0y'
const DOMAIN = 'viralhooks.org'
const TZ_OFFSET = 19_800
const SNAPSHOT_SECONDS = 1_793_752_334
const DAY_SECONDS = 86_400
const AUTH_COOKIE = 'plausible_d1_session'
const CITY_NAMES = cityNames as Record<string, string>
const REGION_NAMES = regionNames as Record<string, string>
const SOURCE_CATEGORIES = sourceClassification.categories as Record<string, string>
const PAID_SOURCES = new Set(sourceClassification.paidSources as string[])

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
  return c.redirect(`/${DOMAIN}`)
})
app.post('/logout', (c) => {
  c.header('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  return c.redirect('/login')
})

app.use('/api/stats/*', async (c, next) => {
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.get('/api/stats/:domain/current-visitors', currentVisitors)
app.get('/api/stats/:domain/current-visitors/', currentVisitors)
app.post('/api/stats/:domain/query', statsQuery)
app.post('/api/stats/:domain/query/', statsQuery)
app.get('/api/stats/:domain/suggestions/custom-prop-values/:propKey', customPropSuggestions)
app.get('/api/stats/:domain/suggestions/:key', suggestions)
app.get('/api/stats/:domain/suggestions/:key/', suggestions)
app.all('/api/stats/*', (c) => c.json({ error: 'not found' }, 404))

app.get('/', (c) => c.redirect(`/${DOMAIN}`))
app.all('*', async (c) => {
  const path = c.req.path
  if (path === '/js/script.js') return c.env.ASSETS.fetch(new Request(new URL('/js/script.js', c.req.url)))
  if (path.startsWith('/assets/') || path.startsWith('/js/')) return c.env.ASSETS.fetch(c.req.raw)
  if (path !== `/${DOMAIN}` && !path.startsWith(`/${DOMAIN}/`)) return c.text('Not found', 404)
  if (!(await isSignedIn(c.req.header('Cookie'), c.env.SESSION_SECRET))) return c.html(loginPage())
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)))
})

async function collectEvent(c: Ctx) {
  const raw = await c.req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch {
    return c.body(null, 400)
  }
  if (payload.d !== DOMAIN || typeof payload.n !== 'string' || typeof payload.u !== 'string') return c.body(null, 202)
  const url = safeUrl(payload.u)
  if (!url || !['http:', 'https:'].includes(url.protocol)) return c.body(null, 202)

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

  await c.env.DB.prepare(
    `INSERT INTO pd_events (
      event_id, site_id, ts, name, page, hostname, referrer, referrer_domain,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      visitor_id, session_id, country, region, city, browser, browser_version,
      os, os_version, device, screen, props
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), SITE_ID, now, payload.n.slice(0, 120), url.pathname || '/', url.hostname,
    referrer?.href ?? null, referrer?.hostname.replace(/^www\./, '') ?? null,
    params.get('utm_source'), params.get('utm_medium'), params.get('utm_campaign'), params.get('utm_content'), params.get('utm_term'),
    visitorId, sessionId, cf?.country ?? null, cf?.region ?? null, cf?.city ?? null,
    uaInfo.browser, uaInfo.browserVersion, uaInfo.os, uaInfo.osVersion, uaInfo.device,
    typeof payload.w === 'string' ? payload.w : null, props,
  ).run()
  return c.body(null, 202)
}

async function currentVisitors(c: Ctx) {
  if (c.req.param('domain') !== DOMAIN) return c.json({ error: 'unknown site' }, 404)
  const row = await c.env.DB.prepare(
    'SELECT COUNT(DISTINCT visitor_id) AS visitors FROM pd_events WHERE site_id = ? AND ts >= ?',
  ).bind(SITE_ID, Math.floor(Date.now() / 1000) - 300).first<{ visitors: number }>()
  return c.json(row?.visitors ?? 0)
}

async function suggestions(c: Ctx) {
  if (c.req.param('domain') !== DOMAIN) return c.json({ error: 'unknown site' }, 404)
  const key = c.req.param('key')
  const dimension = suggestionDimension(key ?? '')
  if (!dimension) return c.json([])
  const from = addDays(today(), -89)
  const query = (c.req.query('q') ?? '').toLocaleLowerCase()
  const rows = await getBreakdown(c.env.DB, [dimension], from, today(), 100, true)
  return c.json(rows.map((row) => row.dimensions[0]).filter((value) => value && value.toLocaleLowerCase().includes(query)).slice(0, 20))
}

async function customPropSuggestions(c: Ctx) {
  if (c.req.param('domain') !== DOMAIN) return c.json({ error: 'unknown site' }, 404)
  const propKey = c.req.param('propKey')
  const query = (c.req.query('q') ?? '').toLocaleLowerCase()
  const from = addDays(today(), -89)
  const rows = await getBreakdown(c.env.DB, [`event:props:${propKey}`], from, today(), 100, true)
  return c.json(rows.map((row) => row.dimensions[0]).filter((value) => value && value.toLocaleLowerCase().includes(query)).slice(0, 20))
}

async function statsQuery(c: Ctx) {
  if (c.req.param('domain') !== DOMAIN) return c.json({ error: 'unknown site' }, 404)
  const body = await c.req.json<StatsQueryBody>().catch(() => null)
  if (!body || !Array.isArray(body.metrics) || !Array.isArray(body.dimensions)) return c.json({ error: 'invalid query' }, 400)
  const range = resolveDateRange(body.date_range)
  const dimensions = body.dimensions.map(String)
  const metrics = body.metrics.map(String)
  const realtime = String(body.date_range).startsWith('realtime')
  const filters = Array.isArray(body.filters) ? body.filters as ApiFilter[] : []
  const importedAllowed = !!body.include?.imports && !realtime && filters.length === 0
  const compareRange = getComparisonRange(body.include?.compare, range)

  if (dimensions.some((d) => d.startsWith('time'))) {
    const interval = dimensions[0].split(':')[1] ?? (range.days <= 1 ? 'hour' : range.days <= 120 ? 'day' : range.days <= 730 ? 'week' : 'month')
    const includeForGraph = importedAllowed && interval !== 'hour' && interval !== 'minute'
    const series = await graphSeries(c.env.DB, range, interval, metrics[0] ?? 'visitors', includeForGraph, filters)
    const comparisonSeries = compareRange
      ? await graphSeries(c.env.DB, compareRange, interval, metrics[0] ?? 'visitors', importedAllowed && interval !== 'hour' && interval !== 'minute', filters)
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
        empty_metrics: metrics.map(() => 0),
        present_index: Math.max(0, series.length - 1),
      },
      results: series.map((item) => ({ dimensions: [item.label], metrics: [metricValue(metrics[0] ?? 'visitors', item.value)] })),
      comparison_results: comparisonSeries.map((item) => ({ dimensions: [item.label], metrics: [metricValue(metrics[0] ?? 'visitors', item.value)], change: null })),
      extraContext: { isRealtime: realtime, hasConversionGoalFilter: filters.some((f) => f[1] === 'event:goal') },
    })
  }

  if (dimensions.length === 0) {
    const current = await getTotals(c.env.DB, range, importedAllowed, filters)
    const comparison = compareRange ? await getTotals(c.env.DB, compareRange, importedAllowed, filters) : null
    return c.json({
      query: { metrics, dimensions, date_range: [range.from, range.to], comparison_date_range: compareRange ? [compareRange.from, compareRange.to] : null },
      meta: { imports_included: importedAllowed, imports_skip_reason: getImportSkipReason(body.include?.imports, realtime, filters, '', importedAllowed) },
      results: [{ dimensions: [], metrics: metrics.map((m) => metricValue(m, metricFromStats(m, current))), ...(comparison ? { comparison: { metrics: metrics.map((m) => metricValue(m, metricFromStats(m, comparison)) ?? 0), change: metrics.map((m) => metricChange(m, metricFromStats(m, current), metricFromStats(m, comparison))) } } : {}) }],
      extraContext: { isRealtime: realtime, hasConversionGoalFilter: filters.some((f) => f[1] === 'event:goal') },
    })
  }

  const limit = Math.min(1000, body.pagination?.limit ?? 100)
  const rows = await getBreakdown(c.env.DB, dimensions, range.from, range.to, limit, importedAllowed, filters, body.pagination?.offset ?? 0)
  const comparedRows = compareRange ? await getBreakdown(c.env.DB, dimensions, compareRange.from, compareRange.to, limit, importedAllowed, filters) : []
  const comparisonByDimensions = new Map(comparedRows.map((row) => [JSON.stringify(row.dimensions), row]))
  const total = rows.reduce((sum, row) => sum + row.visitors, 0)
  return c.json({
    query: { metrics, dimensions, date_range: [range.from, range.to], comparison_date_range: compareRange ? [compareRange.from, compareRange.to] : null },
    meta: { imports_included: importedAllowed, imports_skip_reason: getImportSkipReason(body.include?.imports, realtime, filters, '', importedAllowed) },
    results: rows.map((row) => ({
      dimensions: row.dimensions,
      metrics: metrics.map((m) => metricValue(m, breakdownMetric(row, m, total))),
      ...(comparisonByDimensions.has(JSON.stringify(row.dimensions)) ? { comparison: {
        metrics: metrics.map((m) => metricValue(m, breakdownMetric(comparisonByDimensions.get(JSON.stringify(row.dimensions)) as Breakdown, m, total)) ?? 0),
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
type Breakdown = { dimensions: string[]; visitors: number; visits: number; pageviews: number; events: number; bounces: number; visit_duration: number; bounce_rate: number; views_per_visit: number; time_on_page: number; scroll_depth: number; percentage: number }

function resolveDateRange(input: StatsQueryBody['date_range']): DateRange {
  if (Array.isArray(input)) {
    const from = normalizeDate(input[0])
    const to = normalizeDate(input[1])
    return { from, to, days: Math.max(1, Math.floor((dateEpoch(to) - dateEpoch(from)) / DAY_SECONDS) + 1) }
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
  if (['bounce_rate', 'conversion_rate', 'group_conversion_rate', 'exit_rate'].includes(metric)) return current - previous
  return (current - previous) / previous * 100
}

function normalizeDate(value: string) { return value.slice(0, 10) }
function today() { return new Date(Date.now() + TZ_OFFSET * 1000).toISOString().slice(0, 10) }
function dateForTimestamp(ts: number) { return new Date((ts + TZ_OFFSET) * 1000).toISOString().slice(0, 10) }
function dateEpoch(date: string) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - TZ_OFFSET }
function addDays(date: string, amount: number) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10) }

function metricValue(metric: string, value: unknown): number | null {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return 0
  if (['bounce_rate', 'conversion_rate', 'group_conversion_rate', 'exit_rate', 'percentage', 'scroll_depth'].includes(metric)) return Math.round(n * 100) / 100
  if (['views_per_visit', 'visit_duration', 'time_on_page', 'average_revenue'].includes(metric)) return Math.round(n * 100) / 100
  return Math.round(n)
}

async function graphSeries(db: D1Database, range: DateRange, interval: string, metric: string, withImported: boolean, filters: ApiFilter[] = []) {
  const dates: string[] = []
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) dates.push(date)
  const importRows = withImported && interval !== 'hour' ? await getArchiveTotals(db, range.from, range.to) : new Map<string, EventStats>()
  const liveRows = await getLiveDailyTotals(db, range.from, range.to, filters)
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
       COUNT(*) AS events, 0 AS bounces, 0 AS visit_duration
       FROM pd_events WHERE site_id = ? AND ts >= ?${filter.sql} GROUP BY bucket ORDER BY bucket`,
    ).bind(TZ_OFFSET, bucketSeconds, SITE_ID, startTs, ...filter.values).all<EventStats & { bucket: number }>()
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

async function getArchiveTotals(db: D1Database, from: string, to: string) {
  const result = await db.prepare(
    `SELECT date, payload FROM plausible_history WHERE site_id = ? AND dataset = 'visitors' AND date >= ? AND date <= ? ORDER BY date`,
  ).bind(SITE_ID, from, to).all<{ date: string; payload: string }>()
  return new Map(result.results.map((row) => [row.date, payloadToStats(row.date, JSON.parse(row.payload))]))
}

async function getLiveDailyTotals(db: D1Database, from: string, to: string, filters: ApiFilter[] = []) {
  const fromTs = Math.max(dateEpoch(from), SNAPSHOT_SECONDS)
  const toTs = dateEpoch(addDays(to, 1))
  const filter = liveFilterSql(filters)
  const result = await db.prepare(
    `WITH per_session AS (
       SELECT date(ts + ?, 'unixepoch') AS date, session_id, MAX(visitor_id) AS visitor_id,
        SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
        COUNT(*) AS events, MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM pd_events WHERE site_id = ? AND ts >= ? AND ts < ?${filter.sql} GROUP BY date, session_id
     )
     SELECT date, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS visits,
       SUM(pageviews) AS pageviews, SUM(events) AS events,
       SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END) AS bounces,
       SUM(last_ts - first_ts) AS visit_duration
     FROM per_session GROUP BY date`,
  ).bind(TZ_OFFSET, SITE_ID, fromTs, toTs, ...filter.values).all<EventStats>()
  return new Map(result.results.map((row) => [row.date, normalizeStats(row)]))
}

async function getTotals(db: D1Database, range: DateRange, withImported: boolean, filters: ApiFilter[]) {
  const archived = withImported ? await getArchiveTotals(db, range.from, range.to) : new Map<string, EventStats>()
  const live = await getLiveDailyTotals(db, range.from, range.to, filters)
  let total = zeroStats()
  for (const row of [...archived.values(), ...live.values()]) total = addStats(total, row)
  return total
}

function payloadToStats(date: string, payload: ArchivePayload): EventStats {
  return normalizeStats({ date, visitors: numeric(payload.visitors), visits: numeric(payload.visits), pageviews: numeric(payload.pageviews), bounces: numeric(payload.bounces), visit_duration: numeric(payload.visit_duration), events: numeric(payload.events) })
}
function numeric(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0 }
function normalizeStats(stats: Partial<EventStats> & { date?: string }): EventStats {
  return { date: stats.date ?? '', visitors: Number(stats.visitors ?? 0), visits: Number(stats.visits ?? 0), pageviews: Number(stats.pageviews ?? 0), events: Number(stats.events ?? stats.pageviews ?? 0), bounces: Number(stats.bounces ?? 0), visit_duration: Number(stats.visit_duration ?? 0) }
}
function zeroStats(date = ''): EventStats { return normalizeStats({ date }) }
function addStats(a?: Partial<EventStats>, b?: Partial<EventStats>): EventStats {
  return normalizeStats({ date: a?.date ?? b?.date, visitors: Number(a?.visitors ?? 0) + Number(b?.visitors ?? 0), visits: Number(a?.visits ?? 0) + Number(b?.visits ?? 0), pageviews: Number(a?.pageviews ?? 0) + Number(b?.pageviews ?? 0), events: Number(a?.events ?? 0) + Number(b?.events ?? 0), bounces: Number(a?.bounces ?? 0) + Number(b?.bounces ?? 0), visit_duration: Number(a?.visit_duration ?? 0) + Number(b?.visit_duration ?? 0) })
}
function metricFromStats(metric: string, stats: EventStats) {
  if (metric === 'visitors' || metric === 'total_visitors') return stats.visitors
  if (metric === 'visits') return stats.visits
  if (metric === 'pageviews') return stats.pageviews
  if (metric === 'events') return stats.events
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

async function getBreakdown(db: D1Database, dimensions: string[], from: string, to: string, limit: number, withImported: boolean, filters: ApiFilter[] = [], offset = 0): Promise<Breakdown[]> {
  const values = new Map<string, Breakdown>()
  const archive = dimensions.map(archiveDimensionConfig)
  const archiveDataset = archive[0]?.dataset
  const archiveCompatible = archive.length > 0 && !!archiveDataset && archive.every((item) => item?.dataset === archiveDataset)

  if (withImported && dimensions.length === 1 && dimensions[0] === 'visit:channel') {
    const rows = await db.prepare(
      `SELECT payload FROM plausible_history WHERE site_id = ? AND dataset = 'sources' AND date >= ? AND date <= ?`,
    ).bind(SITE_ID, from, to).all<{ payload: string }>()
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
    const extraWhere = archiveWhere.map((where) => ` AND ${where.sql}`).join('')
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
    const binds = [SITE_ID, archiveDataset, from, to, ...archiveWhere.flatMap((where) => where.values)]
    const rows = await db.prepare(sql).bind(...binds).all<Record<string, unknown> & Partial<Breakdown>>()
    for (const row of rows.results) {
      const rowDimensions = dimensions.map((dimension, index) => normalizeDimension(dimension, row[`d${index}`]))
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
       COUNT(*) AS events, 0 AS bounces, 0 AS visit_duration
       FROM pd_events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview'${filter.sql}
       GROUP BY utm_source, referrer_domain, utm_medium, utm_campaign ORDER BY visitors DESC LIMIT 1000`,
    ).bind(SITE_ID, liveFrom, liveTo, ...filter.values).all<Partial<Breakdown> & { utm_source: string | null; referrer_domain: string | null; utm_medium: string | null; utm_campaign: string | null }>()
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
       COUNT(*) AS events, 0 AS bounces, 0 AS visit_duration
       FROM pd_events WHERE site_id = ? AND ts >= ? AND ts < ?${whereClauses.map((where) => ` AND ${where}`).join('')}${filter.sql}
       GROUP BY ${liveConfigs.map((config) => config?.expr).join(', ')} ORDER BY visitors DESC LIMIT 1000`,
    ).bind(SITE_ID, liveFrom, liveTo, ...filter.values).all<Record<string, unknown> & Partial<Breakdown>>()
    for (const row of result.results) {
      const rowDimensions = dimensions.map((dimension, index) => normalizeDimension(dimension, row[`d${index}`]))
      if (rowDimensions.some((value) => !value)) continue
      const key = JSON.stringify(rowDimensions)
      const previous = values.get(key) ?? zeroBreakdown(rowDimensions)
      values.set(key, {
        ...previous,
        visitors: previous.visitors + Number(row.visitors ?? 0),
        visits: previous.visits + Number(row.visits ?? 0),
        pageviews: previous.pageviews + Number(row.pageviews ?? 0),
        events: previous.events + Number(row.events ?? 0),
      })
    }
  }

  const sorted = [...values.values()].sort((a, b) => b.visitors - a.visitors)
  const totalVisitors = sorted.reduce((sum, row) => sum + row.visitors, 0)
  return sorted.slice(offset, offset + limit).map((row) => ({ ...row, percentage: totalVisitors ? row.visitors / totalVisitors * 100 : 0, bounce_rate: row.visits ? row.bounces / row.visits * 100 : 0, views_per_visit: row.visits ? row.pageviews / row.visits : 0 }))
}

function zeroBreakdown(dimensions: string[]): Breakdown { return { dimensions, visitors: 0, visits: 0, pageviews: 0, events: 0, bounces: 0, visit_duration: 0, bounce_rate: 0, views_per_visit: 0, time_on_page: 0, scroll_depth: 0, percentage: 0 } }
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

function normalizeDimension(key: string, raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value || value === '0' || value === 'null') {
    return key.endsWith('_hostname') ? DOMAIN : ''
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

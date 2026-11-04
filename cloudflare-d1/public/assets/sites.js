const root = document.getElementById('sites')
const search = document.getElementById('search')
const sort = document.getElementById('sort')
const note = document.getElementById('sites-note')
const plusIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v15m7.5-7.5h-15"/></svg>'
const upArrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.25 3.75H19.5a.75.75 0 0 1 .75.75v11.25a.75.75 0 0 1-1.5 0V6.31L5.03 20.03a.75.75 0 0 1-1.06-1.06L17.69 5.25H8.25a.75.75 0 0 1 0-1.5Z"/></svg>'
const downArrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.97 3.97a.75.75 0 0 1 1.06 0l13.72 13.72V8.25a.75.75 0 0 1 1.5 0V19.5a.75.75 0 0 1-.75.75H8.25a.75.75 0 0 1 0-1.5h9.44L3.97 5.03a.75.75 0 0 1 0-1.06Z"/></svg>'
let sites = []

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]))

const pct = site => {
  const current = Number(site.visitors_24h || 0)
  const previous = Number(site.previous_visitors_24h || 0)
  return previous ? Math.round((current - previous) / previous * 100) : null
}

const spark = values => {
  const numbers = Array.isArray(values) ? values.map(Number) : Array(24).fill(0)
  const max = Math.max(1, ...numbers)
  const points = numbers.map((value, index) => [index * 340 / Math.max(1, numbers.length - 1), 42 - (value / max * 32)])
  const line = points.map(point => point.join(',')).join(' ')
  const area = 'M 0 48 L ' + points.map(point => point.join(' ')).join(' L ') + ' L 340 48 Z'
  return '<svg class="sparkline" viewBox="0 0 340 48" preserveAspectRatio="none" role="img" aria-label="Hourly visitors in the last 24 hours"><path class="spark-area" d="' + area + '"></path><polyline points="' + line + '"></polyline></svg>'
}

const settingsIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>'

const renderEmpty = hasSites => {
  root.innerHTML = '<li class="empty"><h2>' + (hasSites ? 'No sites found' : 'Add your first website') + '</h2><p>' + (hasSites ? 'Try a different search term.' : 'Collect simple, privacy-friendly stats to understand your audience.') + '</p>' + (hasSites ? '' : '<a class="button primary" href="/sites/new">' + plusIcon + ' Add website</a>') + '</li>'
}

const render = () => {
  const query = search.value.trim().toLowerCase()
  const ordered = sites.filter(site => site.domain.toLowerCase().includes(query))
  const direction = sort.value
  ordered.sort((a, b) => {
    if (direction.startsWith('name')) {
      const result = a.domain.localeCompare(b.domain)
      return direction.endsWith('desc') ? -result : result
    }
    const result = Number(b.visitors_24h || 0) - Number(a.visitors_24h || 0)
    return direction.endsWith('asc') ? -result : result
  })

  if (!ordered.length) {
    renderEmpty(sites.length > 0)
    return
  }

  root.innerHTML = ordered.map(site => {
    const change = pct(site)
    const changeText = change === null ? '—' : (change > 0 ? '<span class="sr-only">Up</span>' + upArrow : change < 0 ? '<span class="sr-only">Down</span>' + downArrow : '') + Math.abs(change) + '%'
    const changeClass = change === null ? 'muted' : change >= 0 ? 'up' : 'down'
    const dashboard = '/' + encodeURIComponent(site.domain)
    const favicon = '/favicon/sources/' + encodeURIComponent(site.domain) + '?placeholder=site&ui-mode=light'
    const visitorCount = Number(site.visitors_24h || 0)
    return '<li class="site-card"><div class="site-card-head"><img class="favicon" src="' + favicon + '" alt="" loading="lazy"><h3 class="site-domain-wrap"><a class="site-domain" href="' + dashboard + '">' + escapeHtml(site.domain) + '</a></h3><a class="site-settings" href="' + dashboard + '/settings/general" aria-label="Site settings" title="Site settings">' + settingsIcon + '</a></div><a class="site-card-link" href="' + dashboard + '">' + spark(site.sparkline) + '<div class="site-stats"><div><strong>' + visitorCount.toLocaleString() + '</strong><span>' + (visitorCount === 1 ? 'visitor' : 'visitors') + ' in last 24h</span></div><span class="change ' + changeClass + '">' + changeText + '</span></div></a></li>'
  }).join('')

  root.querySelectorAll('.favicon').forEach(image => {
    image.addEventListener('error', () => {
      image.src = '/favicon/placeholders/site'
    }, { once: true })
  })
}

search.addEventListener('input', render)
sort.addEventListener('change', render)
search.addEventListener('focus', () => { search.placeholder = 'Search Sites' })
search.addEventListener('blur', () => { search.placeholder = 'Press / to search' })
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
    event.preventDefault()
    search.focus()
    search.select()
  }
})

const loadSites = async (attempt = 0) => {
  note.textContent = 'Loading your websites…'
  root.dataset.state = 'loading'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch('/api/sites', { signal: controller.signal })
    if (response.status === 401) {
      window.location.replace('/login')
      return
    }
    if (!response.ok) throw new Error('Could not load your websites. Refresh and try again.')
    const result = await response.json()
    if (!Array.isArray(result.data)) throw new Error('The sites response was invalid.')
    sites = result.data
    note.textContent = 'Live visitors are shown for the last 24 hours. Imported Plausible history appears in each site’s dashboard.'
    render()
    root.dataset.state = 'loaded'
  } catch (error) {
    if (attempt === 0) {
      note.textContent = error instanceof Error && error.name === 'AbortError'
        ? 'The request timed out. Retrying…'
        : 'Could not reach the server. Retrying…'
      window.setTimeout(() => void loadSites(1), 900)
      return
    }
    root.dataset.state = 'error'
    note.textContent = error instanceof Error && error.name === 'AbortError'
      ? 'The request timed out twice. Your sites are safe; try again.'
      : 'Could not load your websites. Your sites are safe; try again.'
    root.innerHTML = '<li class="empty"><h2>Sites could not load</h2><p>Check your connection, then retry.</p><button id="retry-sites" class="button secondary">Retry</button></li>'
    document.getElementById('retry-sites').addEventListener('click', () => {
      void loadSites()
    })
  } finally {
    clearTimeout(timer)
  }
}

loadSites()

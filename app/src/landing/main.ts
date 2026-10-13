import './landing.css'
import marcLogo from '../assets/marc-logo-color.svg'
import marcLogoWhite from '../assets/marc-logo-white.svg'
import data from '../config/resources.json'

type Item = { title: string; url: string; type: string; desc: string; internal?: boolean }
type Group = { id: string; title: string; short: string; blurb: string; items: Item[] }

const GROUPS = data.sections as Group[]
const TYPES = ['All', 'Map', 'Plan', 'Report', 'Data', 'Tool', 'Service']
const TOTAL = GROUPS.reduce((n, g) => n + g.items.length, 0)

;(document.getElementById('brand-logo') as HTMLImageElement).src = marcLogo
;(document.getElementById('footer-logo') as HTMLImageElement).src = marcLogoWhite

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const q = $<HTMLInputElement>('q')
const groupNav = $('group-nav')
const groupSelect = $<HTMLSelectElement>('group-select')
const typeNav = $('type-nav')
const clear = $<HTMLButtonElement>('clear')
const groupsEl = $('groups')
const summary = $('summary')

const state = { q: '', type: 'All', group: 'all' }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function card(it: Item) {
  const ext = it.internal ? '' : ' target="_blank" rel="noopener"'
  const arrow = it.internal
    ? ''
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12"></path></svg>'
  return `<a class="card" href="${esc(it.url)}"${ext}>
    <span class="tag tag-${it.type.toLowerCase()}">${esc(it.type)}</span>
    <span class="card-title">${esc(it.title)}${arrow}</span>
    <span class="card-desc">${esc(it.desc)}</span>
  </a>`
}

function render() {
  const ql = state.q.trim().toLowerCase()
  const match = (it: Item) =>
    (state.type === 'All' || it.type === state.type) &&
    (!ql || `${it.title} ${it.desc} ${it.type}`.toLowerCase().includes(ql))
  const all = GROUPS.map((g) => ({ ...g, items: g.items.filter(match) }))
  const shown = all.filter((g) => g.items.length && (state.group === 'all' || g.id === state.group))
  const total = shown.reduce((n, g) => n + g.items.length, 0)
  const filtered = !!ql || state.type !== 'All' || state.group !== 'all'

  summary.textContent = filtered ? `${total} of ${TOTAL} resources` : `${TOTAL} resources`
  clear.hidden = !filtered

  const nav = [{ id: 'all', title: 'All resources', count: all.reduce((n, g) => n + g.items.length, 0) }].concat(
    all.map((g) => ({ id: g.id, title: g.title, count: g.items.length })),
  )
  groupNav.innerHTML = nav
    .map(
      (n) =>
        `<button type="button" data-group="${n.id}" aria-pressed="${n.id === state.group}"><span>${esc(n.title)}</span><span class="count">${n.count}</span></button>`,
    )
    .join('')
  groupSelect.innerHTML = nav
    .map((n) => `<option value="${n.id}"${n.id === state.group ? ' selected' : ''}>${esc(n.id === 'all' ? 'All groups' : n.title)} (${n.count})</option>`)
    .join('')
  typeNav.innerHTML = TYPES.map(
    (t) => `<button type="button" data-type="${t}" aria-pressed="${t === state.type}">${t}</button>`,
  ).join('')

  groupsEl.innerHTML = shown.length
    ? shown
        .map(
          (g) => `<section class="group" aria-labelledby="g-${g.id}">
      <h3 id="g-${g.id}">${esc(g.title)} <span class="group-count">· ${g.items.length} resource${g.items.length === 1 ? '' : 's'}</span></h3>
      <p class="group-blurb">${esc(g.blurb)}</p>
      <div class="cards">${g.items.map(card).join('')}</div>
    </section>`,
        )
        .join('')
    : '<div class="empty">No resources match these filters.</div>'
}

q.addEventListener('input', () => {
  state.q = q.value
  render()
})
groupNav.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-group]')
  if (!b) return
  state.group = b.dataset.group!
  render()
})
groupSelect.addEventListener('change', () => {
  state.group = groupSelect.value
  render()
})
typeNav.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-type]')
  if (!b) return
  state.type = b.dataset.type!
  render()
})
clear.addEventListener('click', () => {
  state.q = ''
  state.type = 'All'
  state.group = 'all'
  q.value = ''
  render()
})

const menuBtn = document.querySelector<HTMLButtonElement>('.menu-btn')!
const phoneNav = $('site-nav-phone')
menuBtn.addEventListener('click', () => {
  const open = phoneNav.hidden
  phoneNav.hidden = !open
  menuBtn.setAttribute('aria-expanded', String(open))
})

render()

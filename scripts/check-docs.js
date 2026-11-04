// Checks that every link between the repository's Markdown files leads somewhere: the file exists
// and, for a #fragment, so does the heading. Links to this repository on GitHub (as the README uses,
// so that they also work on npm) are checked against the files here. Other sites are not fetched.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    , github = 'https://github.com/boelabs/postgres/blob/main/'
    , skip = new Set(['node_modules', '.git', '.wrangler', 'coverage'])
    , fence = /^```[\w-]*\s*$/
    , cache = new Map()

const files = walk(root).filter(x => x.endsWith('.md'))
const broken = files.flatMap(file => links(file).flatMap(({ href, line }) => {
  const problem = check(file, href)
  return problem ? [path.relative(root, file) + ':' + line + ' ' + href + ' (' + problem + ')'] : []
}))

if (broken.length) {
  console.error(broken.length + ' broken link' + (broken.length === 1 ? '' : 's') + ':\n' + broken.join('\n')) // eslint-disable-line no-console
  process.exitCode = 1
} else {
  console.log('Links in ' + files.length + ' Markdown files are fine.') // eslint-disable-line no-console
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(x =>
    skip.has(x.name) ? [] : x.isDirectory() ? walk(path.join(dir, x.name)) : [path.join(dir, x.name)]
  )
}

function links(file) {
  let inside = false
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((text, i) => {
    if (fence.test(text))
      inside = !inside
    if (inside)
      return []
    return [...text.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)].map(m => ({ href: m[1], line: i + 1 }))
  })
}

function check(file, href) {
  if (href.startsWith(github))
    return target(path.join(root, href.slice(github.length)))
  if (/^[a-z]+:/i.test(href))
    return null

  const [rel] = href.split('#')
  return target(rel ? path.resolve(path.dirname(file), decodeURIComponent(rel)) : file, href)

  function target(full, ref = href) {
    const [file, anchor] = [full.split('#')[0], ref.includes('#') ? ref.slice(ref.indexOf('#') + 1) : null]
    if (!fs.existsSync(file))
      return 'no such file'
    if (anchor && file.endsWith('.md') && !headings(file).has(anchor))
      return 'no such heading'
    return null
  }
}

// The ids GitHub gives headings: lower case, punctuation dropped, spaces as dashes, repeats numbered.
function headings(file) {
  if (cache.has(file))
    return cache.get(file)

  const seen = {}
      , ids = new Set()
  let inside = false
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (fence.test(text))
      inside = !inside
    const m = !inside && text.match(/^#{1,6} (.*)$/)
    m && add(m[1].trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\- _]/gu, '').replace(/ /g, '-'))
  }
  cache.set(file, ids)
  return ids

  function add(id) {
    const n = seen[id] || 0
    seen[id] = n + 1
    ids.add(n ? id + '-' + n : id)
  }
}

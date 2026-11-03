/**
 * Pure path classification for the DSH privacy gate (Windows-first, separator
 * tolerant). No filesystem access: a guard is synchronous by contract
 * (references/practices.md:17), so these are string predicates only.
 */

/** Extensions whose content cannot be masked as text by this gate. */
export const BINARY_DOC_EXTENSIONS = Object.freeze([
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'rtf', 'epub', 'pages', 'key', 'numbers',
  // archives
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'cab',
  // images
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico',
  // audio / video
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv',
  // binaries and local databases
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mdb', 'pst', 'msg',
])

/**
 * Normalize a path for comparison only (never for I/O).
 *
 * `.` and `..` segments are resolved lexically and clamped at an absolute root, because a
 * string-prefix test over an unresolved path is a guard bypass (`C:\allowed\..\..\secret.pdf`
 * looked "inside" `C:\allowed`). Symlinks are NOT resolved here (no filesystem access in a
 * synchronous guard); callers that do I/O must realpath before trusting this.
 */
export function normalizeForCompare(filePath) {
  let p = String(filePath).replace(/\\/g, '/').replace(/\/+/g, '/')
  const unc = p.startsWith('//')
  if (unc) p = p.slice(2)
  const driveMatch = /^[A-Za-z]:/.exec(p)
  const drive = driveMatch ? driveMatch[0] : ''
  if (drive) p = p.slice(2)
  const absolute = unc || drive !== '' || p.startsWith('/')
  const parts = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const prefix = unc ? '//' : drive !== '' ? drive.toLowerCase() + '/' : absolute ? '/' : ''
  const joined = prefix + parts.join('/')
  return (joined === '' ? '/' : joined).toLowerCase()
}

/** Whether `child` is `parent` or lies underneath it. */
export function isWithinPath(child, parent) {
  const c = normalizeForCompare(child)
  const p = normalizeForCompare(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/** Whether a path is admitted by the `allowPaths` config list. */
export function isPathAllowed(filePath, allowPaths) {
  if (!Array.isArray(allowPaths) || allowPaths.length === 0) return false
  return allowPaths.some((allowed) => typeof allowed === 'string' && allowed.length > 0 && isWithinPath(filePath, allowed))
}

/** Lowercase extension without the dot (`''` when there is none). */
export function extensionOf(filePath) {
  const name = normalizeForCompare(filePath).replace(/^.*\//, '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1)
}

/** Whether the path's extension is a binary/document type this gate must not read. */
export function isBinaryDocPath(filePath) {
  return BINARY_DOC_EXTENSIONS.includes(extensionOf(filePath))
}

/** Basename for denial messages and audit records (never the full path). */
export function displayName(filePath) {
  return String(filePath).replace(/^.*[\\/]/, '')
}

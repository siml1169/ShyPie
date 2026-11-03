import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BINARY_DOC_EXTENSIONS,
  displayName,
  extensionOf,
  isBinaryDocPath,
  isPathAllowed,
  isWithinPath,
  normalizeForCompare,
} from '../lib/paths.js'

test('normalizeForCompare is separator and case insensitive for comparison only', () => {
  assert.equal(normalizeForCompare('C:\\Users\\x\\Docs\\'), 'c:/users/x/docs')
  assert.equal(normalizeForCompare('C:/Users/x/Docs'), 'c:/users/x/docs')
  assert.equal(normalizeForCompare('c:\\users//x\\docs'), 'c:/users/x/docs')
})

test('normalizeForCompare resolves . and .. so traversal cannot fake containment', () => {
  assert.equal(normalizeForCompare('C:/allowed/../secret/a.pdf'), 'c:/secret/a.pdf')
  assert.equal(normalizeForCompare('C:/allowed/./sub/../a.pdf'), 'c:/allowed/a.pdf')
  assert.equal(normalizeForCompare('C:/allowed/sub/../../allowed/a.pdf'), 'c:/allowed/a.pdf')
  assert.equal(normalizeForCompare('../x/a.pdf'), '../x/a.pdf')
  assert.equal(normalizeForCompare('C:/../../x.pdf'), 'c:/x.pdf')
})

test('a .. traversal out of an allowed root is denied', () => {
  assert.equal(isPathAllowed('C:/allowed/../../Users/x/secret/invoice.pdf', ['C:/allowed']), false)
  assert.equal(isPathAllowed('C:/allowed/sub/../../Users/x/invoice.pdf', ['C:/allowed']), false)
  assert.equal(isPathAllowed('C:/allowed/sub/../invoice.pdf', ['C:/allowed']), true)
  assert.equal(isWithinPath('C:\\allowed\\..\\..\\Users\\x\\secret.pdf', 'C:\\allowed'), false)
})

test('isWithinPath admits the directory itself and its descendants only', () => {
  assert.equal(isWithinPath('C:/fixtures/invoice.pdf', 'C:/fixtures'), true)
  assert.equal(isWithinPath('C:/fixtures', 'C:/fixtures'), true)
  assert.equal(isWithinPath('C:/fixtures2/invoice.pdf', 'C:/fixtures'), false)
  assert.equal(isWithinPath('C:/elsewhere/invoice.pdf', 'C:/fixtures'), false)
  assert.equal(isWithinPath('C:\\Fixtures\\Sub\\a.pdf', 'c:/fixtures'), true)
})

test('isPathAllowed is false for an empty allow list (default denies)', () => {
  assert.equal(isPathAllowed('C:/fixtures/a.pdf', []), false)
  assert.equal(isPathAllowed('C:/fixtures/a.pdf', ['C:/fixtures']), true)
  assert.equal(isPathAllowed('C:/fixtures/a.pdf', ['C:/other']), false)
})

test('extensionOf and isBinaryDocPath classify documents and media', () => {
  assert.equal(extensionOf('C:/x/Invoice.PDF'), 'pdf')
  assert.equal(extensionOf('C:/x/notes'), '')
  assert.equal(extensionOf('C:/x/archive.tar.gz'), 'gz')
  assert.equal(isBinaryDocPath('C:/x/scan.pdf'), true)
  assert.equal(isBinaryDocPath('C:/x/photo.JPG'), true)
  assert.equal(isBinaryDocPath('C:/x/book.xlsx'), true)
  assert.equal(isBinaryDocPath('C:/x/notes.txt'), false)
  assert.equal(isBinaryDocPath('C:/x/notes'), false, 'an extensionless file is not classified by suffix')
  assert.ok(BINARY_DOC_EXTENSIONS.includes('pdf'))
})

test('displayName returns the basename for denial messages', () => {
  assert.equal(displayName('C:\\Users\\x\\secret\\invoice.pdf'), 'invoice.pdf')
  assert.equal(displayName('invoice.pdf'), 'invoice.pdf')
})

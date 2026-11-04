import {
  collection,
  doc,
  Timestamp,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
  setDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import { auth, db } from './firebase'

export type LedgerData = { customers: unknown[]; entries: unknown[]; updatedAt: string; updatedBy: string; storageMode: 'legacy' | 'normalized' }
export type LedgerCustomer = { id: string; name: string; phone: string; createdAt: string; activeEntryCount?: number; lastEntryMutationId?: string; lastEntryMutationKind?: string; createdByUid?: string | null; updatedByUid?: string; updatedAt?: string; legacyImported?: boolean; migratedByUid?: string; restoredFromTrashId?: string; restoredByUid?: string }
export type LedgerEntry = { id: string; customerId: string; kind: 'debt' | 'payment'; amount: number; currency: 'USD' | 'SYP'; note: string; actor: string; date: string; actorUid?: string | null; createdByUid?: string | null; updatedByUid?: string; updatedAt?: string; legacyImported?: boolean; migratedByUid?: string; restoredFromTrashId?: string; restoredByUid?: string }
export type ActivityEvent = { id: string; action: string; description: string; actor: string; actorEmail: string; actorUid?: string | null; createdAt: string; details?: string; customerName?: string; type?: string; legacyImported?: boolean; migratedByUid?: string }
export type TrashRecord = { id: string; entityType: 'customer' | 'entry'; entity: LedgerCustomer | LedgerEntry; deletedAt: string; expiresAt: string; expiresAtMs?: number; deletedBy: string; deletedByUid?: string | null; legacyImported?: boolean; migratedByUid?: string }
export type ShopRole = 'owner' | 'editor' | 'viewer'
export type LedgerStorageState = 'empty' | 'legacy' | 'normalized'

const LEGACY_SHOP = 'daftar-shared'
const SCHEMA_VERSION = 2
let activeShopId = LEGACY_SHOP

export function setActiveShopId(shopId: string) {
  if (!shopId || !shopId.trim()) throw new Error('INVALID_SHOP_ID')
  activeShopId = shopId
}

export function scopedLedgerStorageKey(key: string) {
  return activeShopId === LEGACY_SHOP ? key : `${key}:${activeShopId}`
}

const memberDoc = (uid: string) => doc(db, 'shops', activeShopId, 'members', uid)
const schemaRef = () => doc(db, 'shops', activeShopId, 'meta', 'schema')
const legacyMainRef = () => doc(db, 'shops', activeShopId, 'data', 'main')
const legacyDataCollection = () => collection(db, 'shops', activeShopId, 'data')
const customersCollection = () => collection(db, 'shops', activeShopId, 'customers')
const entriesCollection = () => collection(db, 'shops', activeShopId, 'entries')
const activityCollection = () => collection(db, 'shops', activeShopId, 'activity')
const trashCollection = () => collection(db, 'shops', activeShopId, 'trash')
const operationsCollection = () => collection(db, 'shops', activeShopId, 'operations')
const customerRef = (id: string) => doc(db, 'shops', activeShopId, 'customers', id)
const entryRef = (id: string) => doc(db, 'shops', activeShopId, 'entries', id)
const activityRef = (id: string) => doc(db, 'shops', activeShopId, 'activity', id)
const trashRef = (id: string) => doc(db, 'shops', activeShopId, 'trash', id)
const operationRef = (id: string) => doc(db, 'shops', activeShopId, 'operations', id)

function currentUid(expectedUid?: string) {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('AUTH_REQUIRED')
  if (expectedUid && expectedUid !== uid) throw new Error('ACTOR_MISMATCH')
  return uid
}

export async function resolveLedgerShop(user: { uid: string; email?: string | null }): Promise<string> {
  if (!user.uid) throw new Error('AUTH_REQUIRED')

  const describeError = (error: unknown) => {
    if (error && typeof error === 'object') {
      const value = error as { code?: unknown; message?: unknown }
      return `${String(value.code || 'unknown')}: ${String(value.message || error)}`
    }
    return String(error)
  }

  try {
    const legacyMember = await getDoc(doc(db, 'shops', LEGACY_SHOP, 'members', user.uid))
    if (legacyMember.exists()) return LEGACY_SHOP
  } catch (error) {
    throw new Error(`LEGACY_MEMBERSHIP_READ_FAILED | ${describeError(error)}`)
  }

  const ownMemberRef = doc(db, 'shops', user.uid, 'members', user.uid)
  try {
    const ownMember = await getDoc(ownMemberRef)
    if (!ownMember.exists()) {
      const membership: Record<string, unknown> = { uid: user.uid, createdAt: new Date().toISOString() }
      if (user.email) membership.email = user.email
      await setDoc(ownMemberRef, membership)
    }
  } catch (error) {
    throw new Error(`OWN_MEMBERSHIP_SETUP_FAILED | ${describeError(error)}`)
  }
  return user.uid
}

export async function getActiveShopRole(uid = currentUid()): Promise<ShopRole> {
  currentUid(uid)
  // A user's private shop is owned by that user; shared-shop roles are explicit and exact.
  if (activeShopId === uid) return 'owner'
  const snapshot = await getDoc(memberDoc(uid))
  if (!snapshot.exists()) throw new Error('SHOP_MEMBERSHIP_REQUIRED')
  const role = snapshot.data().role
  if (role === 'owner' || role === 'editor' || role === 'viewer') return role
  // Missing, malformed, or legacy values fail closed: read-only rather than editor.
  return 'viewer'
}

export function watchActiveShopRole(
  uid: string,
  onRole: (role: ShopRole) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  currentUid(uid)
  if (activeShopId === uid) {
    onRole('owner')
    return () => undefined
  }
  return onSnapshot(memberDoc(uid), snapshot => {
    if (!snapshot.exists()) { onRole('viewer'); return }
    const role = snapshot.data().role
    onRole(role === 'owner' || role === 'editor' || role === 'viewer' ? role : 'viewer')
  }, error => onError(error))
}

async function assertCanEdit(uid = currentUid()) {
  const role = await getActiveShopRole(uid)
  if (role !== 'owner' && role !== 'editor') throw new Error('EDITOR_ROLE_REQUIRED')
  return role
}

async function assertOwner(uid = currentUid()) {
  const role = await getActiveShopRole(uid)
  if (role !== 'owner') throw new Error('OWNER_ROLE_REQUIRED')
}

export async function getLedgerStorageState(): Promise<LedgerStorageState> {
  const schema = await getDoc(schemaRef())
  if (schema.exists() && schema.data().version === SCHEMA_VERSION && schema.data().status === 'ready') return 'normalized'
  const legacy = await getDoc(legacyMainRef())
  return legacy.exists() ? 'legacy' : 'empty'
}

export const sharedLedgerRef = () => legacyMainRef()

function toLedgerData(value: Record<string, unknown>): LedgerData {
  return {
    customers: Array.isArray(value.customers) ? value.customers : [],
    entries: Array.isArray(value.entries) ? value.entries : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : '',
    storageMode: 'legacy',
  }
}

export function watchSharedLedger(onData: (data: LedgerData | null) => void, onError: (error: Error) => void): Unsubscribe {
  let stopped = false
  let mode: 'legacy' | 'normalized' | 'restoring' | null = null
  let stopLegacy: Unsubscribe | null = null
  let stopCustomers: Unsubscribe | null = null
  let stopEntries: Unsubscribe | null = null
  let customers: unknown[] = []
  let entries: unknown[] = []
  let customersReady = false
  let entriesReady = false

  const stopMode = () => {
    stopLegacy?.(); stopLegacy = null
    stopCustomers?.(); stopCustomers = null
    stopEntries?.(); stopEntries = null
    customersReady = false
    entriesReady = false
  }

  const attachLegacy = () => {
    if (stopped || mode === 'legacy') return
    stopMode()
    mode = 'legacy'
    stopLegacy = onSnapshot(legacyMainRef(), snapshot => {
      if (stopped || mode !== 'legacy') return
      if (snapshot.exists()) {
        onData(toLedgerData(snapshot.data()))
        return
      }
      const uid = auth.currentUser?.uid
      if (!uid) { onData({ customers: [], entries: [], updatedAt: '', updatedBy: '', storageMode: 'legacy' }); return }
      void getActiveShopRole(uid).then(role => {
        if (!stopped && mode === 'legacy') {
          if (role === 'owner') onData(null)
          else onData({ customers: [], entries: [], updatedAt: '', updatedBy: '', storageMode: 'legacy' })
        }
      }).catch(onError)
    }, onError)
  }

  const attachRestoring = () => {
    if (stopped || mode === 'restoring') return
    stopMode()
    mode = 'restoring'
    // Keep all member clients read-only while an owner migrates or restores a full backup.
    onData({ customers: [], entries: [], updatedAt: '', updatedBy: '', storageMode: 'legacy' })
  }

  const attachNormalized = () => {
    if (stopped || mode === 'normalized') return
    stopMode()
    mode = 'normalized'
    customers = []
    entries = []
    stopCustomers = onSnapshot(customersCollection(), snapshot => {
      if (stopped || mode !== 'normalized') return
      customers = snapshot.docs.map(item => item.data())
      customersReady = true
      publishNormalized()
    }, onError)
    stopEntries = onSnapshot(entriesCollection(), snapshot => {
      if (stopped || mode !== 'normalized') return
      entries = snapshot.docs.map(item => item.data())
      entriesReady = true
      publishNormalized()
    }, onError)
  }

  const publishNormalized = () => {
    if (!stopped && mode === 'normalized' && customersReady && entriesReady) {
      onData({ customers, entries, updatedAt: new Date().toISOString(), updatedBy: '', storageMode: 'normalized' })
    }
  }

  const stopSchema = onSnapshot(schemaRef(), snapshot => {
    if (stopped) return
    const data = snapshot.exists() ? snapshot.data() : null
    if (data?.version === SCHEMA_VERSION && data?.status === 'ready') attachNormalized()
    else if (data?.version === SCHEMA_VERSION && data?.status === 'restoring') attachRestoring()
    else attachLegacy()
  }, onError)

  return () => {
    stopped = true
    stopSchema()
    stopMode()
  }
}

function assertRecordId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id.trim() || id.includes('/')) throw new Error('INVALID_RECORD_ID')
}

function cleanCustomer(input: any, uid: string, legacy = false, entryCount = 0) {
  if (!input || typeof input.id !== 'string' || !input.id || typeof input.name !== 'string' || !input.name.trim()) throw new Error('INVALID_CUSTOMER_RECORD')
  return {
    ...input,
    id: input.id,
    name: input.name.trim(),
    phone: typeof input.phone === 'string' ? input.phone : '',
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    activeEntryCount: entryCount,
    lastEntryMutationId: '',
    lastEntryMutationKind: '',
    createdByUid: legacy ? null : uid,
    updatedByUid: uid,
    ...(legacy ? { legacyImported: true, migratedByUid: uid } : {}),
  }
}

function cleanEntry(input: any, uid: string, legacy = false) {
  if (!input || typeof input.id !== 'string' || !input.id || typeof input.customerId !== 'string' || !input.customerId || !['debt', 'payment'].includes(input.kind) || !['USD', 'SYP'].includes(input.currency) || !Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('INVALID_ENTRY_RECORD')
  return {
    ...input,
    id: input.id,
    customerId: input.customerId,
    amount: Number(input.amount),
    note: typeof input.note === 'string' ? input.note : '',
    actor: legacy ? (typeof input.actor === 'string' ? input.actor : '') : (auth.currentUser?.email || uid),
    date: typeof input.date === 'string' ? input.date : new Date().toISOString(),
    createdByUid: legacy ? (typeof input.createdByUid === 'string' ? input.createdByUid : null) : uid,
    updatedByUid: uid,
    actorUid: legacy ? (typeof input.actorUid === 'string' ? input.actorUid : null) : uid,
    ...(legacy ? { legacyImported: true, migratedByUid: uid } : {}),
  }
}

async function commitWrites(writes: Array<{ ref: ReturnType<typeof doc>; data?: Record<string, unknown> }>) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(db)
    for (const item of writes.slice(i, i + 400)) {
      if (item.data) batch.set(item.ref, item.data)
      else batch.delete(item.ref)
    }
    await batch.commit()
  }
}

function summarizeEntries(entries: Array<Record<string, any>>) {
  const summary: Record<string, number> = {
    USD_debt: 0, USD_payment: 0, SYP_debt: 0, SYP_payment: 0,
  }
  for (const entry of entries) {
    const key = `${entry.currency}_${entry.kind}`
    if (!(key in summary)) throw new Error(`MIGRATION_VERIFY_INVALID_CURRENCY_OR_KIND:${entry.id}`)
    const amount = Number(entry.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`MIGRATION_VERIFY_INVALID_AMOUNT:${entry.id}`)
    summary[key] += amount
  }
  return summary
}

async function verifyNormalizedLedger(
  expectedCustomers: unknown[],
  expectedEntries: unknown[],
  expectedCounts: {
    activities: number
    trash: number
    operations: number
    activityRows?: Array<{ id: string; data: Record<string, any> }>
    trashRows?: Array<{ id: string; data: Record<string, any> }>
    operationRows?: Array<{ id: string; data: Record<string, any> }>
  },
) {
  const [customerSnap, entrySnap, activitySnap, trashSnap, operationSnap] = await Promise.all([
    getDocs(customersCollection()), getDocs(entriesCollection()), getDocs(activityCollection()),
    getDocs(trashCollection()), getDocs(operationsCollection()),
  ])
  if (customerSnap.size !== expectedCustomers.length) throw new Error(`MIGRATION_VERIFY_CUSTOMERS:${customerSnap.size}/${expectedCustomers.length}`)
  if (entrySnap.size !== expectedEntries.length) throw new Error(`MIGRATION_VERIFY_ENTRIES:${entrySnap.size}/${expectedEntries.length}`)
  if (activitySnap.size !== expectedCounts.activities) throw new Error(`MIGRATION_VERIFY_ACTIVITY:${activitySnap.size}/${expectedCounts.activities}`)
  if (trashSnap.size !== expectedCounts.trash) throw new Error(`MIGRATION_VERIFY_TRASH:${trashSnap.size}/${expectedCounts.trash}`)
  if (operationSnap.size !== expectedCounts.operations) throw new Error(`MIGRATION_VERIFY_OPERATIONS:${operationSnap.size}/${expectedCounts.operations}`)

  const verifyAuxiliaryRows = (
    snapshot: typeof activitySnap,
    rows: Array<{ id: string; data: Record<string, any> }> | undefined,
    label: string,
    fields: string[],
  ) => {
    if (!rows) return
    const actual = new Map(snapshot.docs.map(item => [item.id, item.data() as Record<string, any>]))
    const expectedIds = new Set(rows.map(row => row.id))
    if (expectedIds.size !== rows.length || actual.size !== expectedIds.size) throw new Error(`MIGRATION_VERIFY_${label}_IDS`)
    for (const row of rows) {
      const stored = actual.get(row.id)
      if (!stored) throw new Error(`MIGRATION_VERIFY_${label}_MISSING:${row.id}`)
      for (const field of fields) {
        if (JSON.stringify(stored[field] ?? null) !== JSON.stringify(row.data[field] ?? null)) {
          throw new Error(`MIGRATION_VERIFY_${label}_FIELD:${row.id}:${field}`)
        }
      }
    }
  }
  verifyAuxiliaryRows(activitySnap, expectedCounts.activityRows, 'ACTIVITY', ['id', 'action', 'description', 'actor', 'createdAt'])
  verifyAuxiliaryRows(trashSnap, expectedCounts.trashRows, 'TRASH', ['id', 'entityType', 'deletedAt', 'expiresAt'])
  verifyAuxiliaryRows(operationSnap, expectedCounts.operationRows, 'OPERATION', ['id', 'type', 'appliedAt', 'appliedBy'])
  if (expectedCounts.trashRows) {
    const actualTrash = new Map(trashSnap.docs.map(item => [item.id, item.data() as Record<string, any>]))
    for (const row of expectedCounts.trashRows) {
      const stored = actualTrash.get(row.id)
      if (stored?.entity?.id !== row.data.entity?.id) throw new Error(`MIGRATION_VERIFY_TRASH_ENTITY:${row.id}`)
    }
  }

  const actualCustomers = new Map(customerSnap.docs.map(item => [item.id, item.data() as Record<string, any>]))
  const expectedEntryCounts = new Map<string, number>()
  const expectedCustomerIds = new Set<string>()
  for (const raw of expectedCustomers as Array<Record<string, any>>) {
    if (expectedCustomerIds.has(raw.id)) throw new Error(`MIGRATION_VERIFY_DUPLICATE_CUSTOMER:${raw.id}`)
    expectedCustomerIds.add(raw.id)
  }
  const expectedEntryIds = new Set<string>()
  for (const raw of expectedEntries as Array<Record<string, any>>) {
    if (expectedEntryIds.has(raw.id)) throw new Error(`MIGRATION_VERIFY_DUPLICATE_ENTRY:${raw.id}`)
    expectedEntryIds.add(raw.id)
    if (!expectedCustomerIds.has(raw.customerId)) throw new Error(`MIGRATION_VERIFY_ORPHAN_ENTRY:${raw.id}`)
    expectedEntryCounts.set(raw.customerId, (expectedEntryCounts.get(raw.customerId) || 0) + 1)
  }
  for (const raw of expectedCustomers as Array<Record<string, any>>) {
    const actual = actualCustomers.get(raw.id)
    const expectedCount = expectedEntryCounts.get(raw.id) || 0
    if (!actual || actual.id !== raw.id || actual.name !== String(raw.name).trim() || actual.phone !== (typeof raw.phone === 'string' ? raw.phone : '') || Number(actual.activeEntryCount) !== expectedCount) {
      throw new Error(`MIGRATION_VERIFY_CUSTOMER_MISMATCH:${raw.id}`)
    }
  }

  const actualEntries = new Map(entrySnap.docs.map(item => [item.id, item.data() as Record<string, any>]))
  const normalizedEntries: Array<Record<string, any>> = []
  for (const raw of expectedEntries as Array<Record<string, any>>) {
    const actual = actualEntries.get(raw.id)
    if (!actual || actual.id !== raw.id || actual.customerId !== raw.customerId || actual.kind !== raw.kind ||
      Number(actual.amount) !== Number(raw.amount) || actual.currency !== raw.currency ||
      actual.note !== (typeof raw.note === 'string' ? raw.note : '') || actual.date !== (typeof raw.date === 'string' ? raw.date : actual.date)) {
      throw new Error(`MIGRATION_VERIFY_ENTRY_MISMATCH:${raw.id}`)
    }
    if (!actualCustomers.has(actual.customerId)) throw new Error(`MIGRATION_VERIFY_ORPHAN_ENTRY:${raw.id}`)
    normalizedEntries.push(actual)
  }

  const expectedSummary = summarizeEntries(expectedEntries as Array<Record<string, any>>)
  const actualSummary = summarizeEntries(normalizedEntries)
  for (const key of Object.keys(expectedSummary)) {
    if (Math.abs(expectedSummary[key] - actualSummary[key]) > 0.000001) throw new Error(`MIGRATION_VERIFY_BALANCE:${key}`)
  }

  return {
    customers: customerSnap.size,
    entries: entrySnap.size,
    activities: activitySnap.size,
    trash: trashSnap.size,
    operations: operationSnap.size,
    totals: actualSummary,
  }
}

async function createNormalizedLedger(customersInput: unknown[], entriesInput: unknown[], uid: string) {
  const customersRaw = Array.isArray(customersInput) ? customersInput : []
  const entriesRaw = Array.isArray(entriesInput) ? entriesInput : []
  const ids = new Set<string>()
  for (const item of customersRaw as any[]) {
    assertRecordId(item?.id)
    if (ids.has(item.id)) throw new Error('DUPLICATE_CUSTOMER_ID')
    ids.add(item.id)
  }
  const counts = new Map<string, number>()
  const entryIds = new Set<string>()
  for (const item of entriesRaw as any[]) {
    assertRecordId(item?.id)
    if (entryIds.has(item.id)) throw new Error('DUPLICATE_ENTRY_ID')
    entryIds.add(item.id)
    if (!ids.has(item.customerId)) throw new Error(`MIGRATION_ORPHAN_ENTRY:${item.id}`)
    counts.set(item.customerId, (counts.get(item.customerId) || 0) + 1)
  }
  // Close the write window before importing owner-only normalized records.
  // Rules permit legacy-imported records only while this marker is restoring.
  await setDoc(schemaRef(), {
    version: SCHEMA_VERSION,
    status: 'restoring',
    migratingByUid: uid,
    initializedAt: new Date().toISOString(),
  }, { merge: true })

  const writes: Array<{ ref: ReturnType<typeof doc>; data?: Record<string, unknown> }> = []
  for (const raw of customersRaw as any[]) writes.push({ ref: customerRef(raw.id), data: cleanCustomer(raw, uid, true, counts.get(raw.id) || 0) })
  for (const raw of entriesRaw as any[]) writes.push({ ref: entryRef(raw.id), data: cleanEntry(raw, uid, true) })
  await commitWrites(writes)
  await verifyNormalizedLedger(customersRaw, entriesRaw, { activities: 0, trash: 0, operations: 0, activityRows: [], trashRows: [], operationRows: [] })
  await setDoc(schemaRef(), {
    version: SCHEMA_VERSION,
    status: 'ready',
    initializedAt: new Date().toISOString(),
    initializedByUid: uid,
    counts: { customers: customersRaw.length, entries: entriesRaw.length, activities: 0, trash: 0 },
  })
}

export async function saveSharedLedger(customers: unknown[], entries: unknown[], userId: string) {
  const uid = currentUid(userId)
  await assertOwner(uid)
  const schema = await getDoc(schemaRef())
  if (schema.exists() && schema.data().version === SCHEMA_VERSION && schema.data().status === 'ready') return
  if (schema.exists() && schema.data().status === 'restoring') throw new Error('MIGRATION_OR_RESTORE_IN_PROGRESS')
  const legacy = await getDoc(legacyMainRef())
  if (legacy.exists()) throw new Error('LEGACY_MIGRATION_REQUIRED')
  await createNormalizedLedger(customers, entries, uid)
}

export async function migrateLegacyLedger(userId: string, fallbackCustomers: unknown[] = [], fallbackEntries: unknown[] = []) {
  const uid = currentUid(userId)
  await assertOwner(uid)
  const currentSchema = await getDoc(schemaRef())
  if (currentSchema.exists() && currentSchema.data().version === SCHEMA_VERSION && currentSchema.data().status === 'ready') {
    return currentSchema.data().counts || { customers: 0, entries: 0, activities: 0, trash: 0, operations: 0 }
  }

  // Freeze editor writes before copying data. The old `data/main` document remains intact.
  await setDoc(schemaRef(), {
    version: SCHEMA_VERSION,
    status: 'restoring',
    migratingByUid: uid,
    migrationStartedAt: new Date().toISOString(),
    source: `shops/${activeShopId}/data`,
  }, { merge: true })

  const legacyDocs = await getDocs(legacyDataCollection())
  const mainDoc = legacyDocs.docs.find(item => item.id === 'main')
  const main = mainDoc?.data() || { customers: fallbackCustomers, entries: fallbackEntries }
  const customersRaw = Array.isArray(main.customers) ? main.customers : fallbackCustomers
  const entriesRaw = Array.isArray(main.entries) ? main.entries : fallbackEntries

  const customerIds = new Set<string>()
  for (const item of customersRaw as any[]) {
    assertRecordId(item?.id)
    if (customerIds.has(item.id)) throw new Error(`MIGRATION_DUPLICATE_CUSTOMER:${item.id}`)
    customerIds.add(item.id)
  }
  const entryIds = new Set<string>()
  const counts = new Map<string, number>()
  for (const item of entriesRaw as any[]) {
    assertRecordId(item?.id)
    if (entryIds.has(item.id)) throw new Error(`MIGRATION_DUPLICATE_ENTRY:${item.id}`)
    if (!customerIds.has(item.customerId)) throw new Error(`MIGRATION_ORPHAN_ENTRY:${item.id}`)
    entryIds.add(item.id)
    counts.set(item.customerId, (counts.get(item.customerId) || 0) + 1)
  }

  const activityRows: Array<{ id: string; data: Record<string, any> }> = []
  const trashRows: Array<{ id: string; data: Record<string, any> }> = []
  const operationRows: Array<{ id: string; data: Record<string, any> }> = []
  const uniqueIds = (rows: Array<{ id: string }>, label: string) => {
    const seen = new Set<string>()
    for (const row of rows) {
      assertRecordId(row.id)
      if (seen.has(row.id)) throw new Error(`MIGRATION_DUPLICATE_${label}:${row.id}`)
      seen.add(row.id)
    }
  }

  for (const oldDoc of legacyDocs.docs) {
    const data = oldDoc.data() as Record<string, any>
    if (oldDoc.id.startsWith('activity-')) {
      const id = typeof data.id === 'string' && data.id ? data.id : oldDoc.id.slice('activity-'.length)
      activityRows.push({ id, data: { ...data, id, type: 'activity', actorUid: null, legacyImported: true, migratedByUid: uid } })
    } else if (oldDoc.id.startsWith('trash-')) {
      const id = typeof data.id === 'string' && data.id ? data.id : oldDoc.id.slice('trash-'.length)
      const expiresAt = typeof data.expiresAt === 'string' ? data.expiresAt : new Date(0).toISOString()
      const parsedExpiry = Date.parse(expiresAt)
      const expiryMs = Number.isFinite(parsedExpiry) ? parsedExpiry : 0
      trashRows.push({ id, data: {
        ...data, id, expiresAt, expiresAtMs: expiryMs,
        expiresAtTimestamp: Timestamp.fromMillis(expiryMs), deletedByUid: null,
        legacyImported: true, migratedByUid: uid,
      } })
    } else if (oldDoc.id.startsWith('operation-')) {
      const id = typeof data.id === 'string' && data.id ? data.id : oldDoc.id.slice('operation-'.length)
      operationRows.push({ id, data: { ...data, id, legacyImported: true, migratedByUid: uid } })
    }
  }
  uniqueIds(activityRows, 'ACTIVITY')
  uniqueIds(trashRows, 'TRASH')
  uniqueIds(operationRows, 'OPERATION')

  // Reconcile partial normalized writes from any earlier interrupted attempt.
  const [existingCustomers, existingEntries, existingActivity, existingTrash, existingOperations] = await Promise.all([
    getDocs(customersCollection()), getDocs(entriesCollection()), getDocs(activityCollection()),
    getDocs(trashCollection()), getDocs(operationsCollection()),
  ])
  const desired = [
    new Set((customersRaw as any[]).map(row => row.id)),
    new Set((entriesRaw as any[]).map(row => row.id)),
    new Set(activityRows.map(row => row.id)),
    new Set(trashRows.map(row => row.id)),
    new Set(operationRows.map(row => row.id)),
  ]
  const existing = [existingCustomers, existingEntries, existingActivity, existingTrash, existingOperations]
  const writes: Array<{ ref: ReturnType<typeof doc>; data?: Record<string, unknown> }> = []
  existing.forEach((snapshot, index) => {
    for (const item of snapshot.docs) if (!desired[index].has(item.id)) writes.push({ ref: item.ref })
  })

  for (const raw of customersRaw as any[]) writes.push({ ref: customerRef(raw.id), data: cleanCustomer(raw, uid, true, counts.get(raw.id) || 0) })
  for (const raw of entriesRaw as any[]) writes.push({ ref: entryRef(raw.id), data: cleanEntry(raw, uid, true) })
  for (const row of activityRows) writes.push({ ref: activityRef(row.id), data: row.data })
  for (const row of trashRows) writes.push({ ref: trashRef(row.id), data: row.data })
  for (const row of operationRows) writes.push({ ref: operationRef(row.id), data: row.data })

  await commitWrites(writes)
  const verified = await verifyNormalizedLedger(customersRaw, entriesRaw, {
    activities: activityRows.length, trash: trashRows.length, operations: operationRows.length,
    activityRows, trashRows, operationRows,
  })
  const countsResult = {
    customers: verified.customers,
    entries: verified.entries,
    activities: verified.activities,
    trash: verified.trash,
    operations: verified.operations,
    totals: verified.totals,
  }
  await setDoc(schemaRef(), {
    version: SCHEMA_VERSION,
    status: 'ready',
    migratedAt: new Date().toISOString(),
    migratedByUid: uid,
    source: `shops/${activeShopId}/data`,
    legacyPreserved: true,
    counts: countsResult,
  }, { merge: true })
  return countsResult
}

export async function updateSharedEntity(
  operationId: string,
  entityType: 'customer' | 'entry',
  id: string,
  expected: unknown,
  replacement: unknown,
  userId: string,
  forceFields: string[] = [],
) {
  const uid = currentUid(userId)
  await assertCanEdit(uid)
  assertRecordId(id)
  assertRecordId(operationId)
  await runTransaction(db, async transaction => {
    const ref = entityType === 'customer' ? customerRef(id) : entryRef(id)
    const opRef = operationRef(operationId)
    const [snapshot, opSnapshot] = await Promise.all([transaction.get(ref), transaction.get(opRef)])
    if (opSnapshot.exists()) return
    if (!snapshot.exists()) throw new Error('ENTITY_NOT_FOUND')

    const current = snapshot.data() as Record<string, unknown>
    const before = expected as Record<string, unknown>
    const after = replacement as Record<string, unknown>
    const merged: Record<string, unknown> = { ...current }
    const changedKeys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of changedKeys) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
      if (!forceFields.includes(key) && JSON.stringify(current[key]) !== JSON.stringify(before[key]) && JSON.stringify(current[key]) !== JSON.stringify(after[key])) {
        throw new Error(`ENTITY_CONFLICT:${key}`)
      }
      if (Object.prototype.hasOwnProperty.call(after, key)) merged[key] = after[key]
      else delete merged[key]
    }
    if (entityType === 'customer') {
      merged.name = String(merged.name || '').trim()
      merged.phone = typeof merged.phone === 'string' ? merged.phone : ''
    } else {
      const entry = merged as any
      if (!['debt', 'payment'].includes(entry.kind) || !['USD', 'SYP'].includes(entry.currency) || !Number.isFinite(Number(entry.amount)) || Number(entry.amount) <= 0) throw new Error('INVALID_ENTRY_RECORD')
      if (merged.customerId !== current.customerId) throw new Error('ENTRY_CUSTOMER_CANNOT_CHANGE')
    }
    merged.updatedByUid = uid
    merged.updatedAt = new Date().toISOString()
    transaction.update(ref, merged)
    transaction.set(opRef, { id: operationId, type: 'entity-update', appliedAt: new Date().toISOString(), appliedBy: uid })
  })
}

export async function appendSharedCustomer(customer: LedgerCustomer, userId: string) {
  const uid = currentUid(userId)
  await assertCanEdit(uid)
  assertRecordId(customer.id)
  await runTransaction(db, async transaction => {
    const ref = customerRef(customer.id)
    const snapshot = await transaction.get(ref)
    if (snapshot.exists()) throw new Error('CUSTOMER_ALREADY_EXISTS')
    transaction.set(ref, cleanCustomer(customer, uid, false, 0))
  })
}

export async function appendSharedEntry(entry: LedgerEntry, userId: string) {
  const uid = currentUid(userId)
  await assertCanEdit(uid)
  assertRecordId(entry.id)
  assertRecordId(entry.customerId)
  await runTransaction(db, async transaction => {
    const ref = entryRef(entry.id)
    const customer = customerRef(entry.customerId)
    const [entrySnapshot, customerSnapshot] = await Promise.all([transaction.get(ref), transaction.get(customer)])
    if (entrySnapshot.exists()) throw new Error('ENTRY_ALREADY_EXISTS')
    if (!customerSnapshot.exists()) throw new Error('CUSTOMER_NOT_FOUND')
    const customerData = customerSnapshot.data() as Record<string, any>
    transaction.update(customer, {
      activeEntryCount: Number(customerData.activeEntryCount || 0) + 1,
      lastEntryMutationId: entry.id,
      lastEntryMutationKind: 'add',
      updatedByUid: uid,
      updatedAt: new Date().toISOString(),
    })
    transaction.set(ref, cleanEntry(entry, uid, false))
  })
}

// Kept for compatibility with the previous client. Full-array mutation is intentionally disabled.
export async function mutateSharedLedger() {
  throw new Error('LEGACY_ARRAY_MUTATION_DISABLED_USE_NORMALIZED_RECORDS')
}

export async function recordActivity(event: Omit<ActivityEvent, 'id'>) {
  const uid = currentUid()
  await assertCanEdit(uid)
  const id = crypto.randomUUID()
  await setDoc(activityRef(id), {
    ...event,
    id,
    type: 'activity',
    actor: auth.currentUser?.email || uid,
    actorUid: uid,
    actorEmail: auth.currentUser?.email || '',
    createdAt: event.createdAt || new Date().toISOString(),
  })
}

export async function listActivity(limitCount = 150): Promise<ActivityEvent[]> {
  const state = await getLedgerStorageState()
  if (state === 'legacy') {
    const legacy = await getDocs(legacyDataCollection())
    return legacy.docs
      .filter(item => item.id.startsWith('activity-'))
      .map(item => ({ ...item.data(), id: (item.data().id as string) || item.id.slice('activity-'.length) } as ActivityEvent))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limitCount)
  }
  if (state === 'empty') return []
  const snap = await getDocs(activityCollection())
  return snap.docs
    .map(item => item.data() as ActivityEvent)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limitCount)
}

export async function listTrash(): Promise<TrashRecord[]> {
  const state = await getLedgerStorageState()
  if (state === 'legacy') {
    const legacy = await getDocs(legacyDataCollection())
    return legacy.docs
      .filter(item => item.id.startsWith('trash-'))
      .map(item => ({ ...item.data(), id: (item.data().id as string) || item.id.slice('trash-'.length) } as TrashRecord))
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }
  if (state === 'empty') return []
  const snap = await getDocs(trashCollection())
  return snap.docs.map(item => item.data() as TrashRecord).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

export async function putInTrashWithId(
  id: string,
  record: Omit<TrashRecord, 'id' | 'deletedAt' | 'expiresAt'>,
  _mutate: (customers: unknown[], entries: unknown[]) => { customers: unknown[]; entries: unknown[] },
  userId: string,
  deletedAt: string,
  expiresAt: string,
) {
  const uid = currentUid(userId)
  await assertCanEdit(uid)
  assertRecordId(id)
  const entity = record.entity as any
  assertRecordId(entity?.id)
  const requiredTrashId = `${record.entityType}-${entity.id}`
  if (id !== requiredTrashId) throw new Error('INVALID_TRASH_ID')

  await runTransaction(db, async transaction => {
    const deletedRef = trashRef(id)
    const targetRef = record.entityType === 'customer' ? customerRef(entity.id) : entryRef(entity.id)
    const [trashSnapshot, targetSnapshot] = await Promise.all([transaction.get(deletedRef), transaction.get(targetRef)])
    if (trashSnapshot.exists()) return
    if (!targetSnapshot.exists()) throw new Error('ENTITY_NOT_FOUND')
    const current = targetSnapshot.data() as Record<string, any>

    if (record.entityType === 'customer') {
      if (Number(current.activeEntryCount || 0) !== 0) throw new Error('CUSTOMER_HAS_ENTRIES')
    } else {
      const parentRef = customerRef(String(current.customerId || ''))
      const parentSnapshot = await transaction.get(parentRef)
      if (!parentSnapshot.exists()) throw new Error('CUSTOMER_NOT_FOUND')
      const parent = parentSnapshot.data() as Record<string, any>
      const count = Number(parent.activeEntryCount || 0)
      if (count < 1) throw new Error('ENTRY_COUNT_INCONSISTENT')
      transaction.update(parentRef, {
        activeEntryCount: count - 1,
        lastEntryMutationId: entity.id,
        lastEntryMutationKind: 'delete',
        updatedByUid: uid,
        updatedAt: new Date().toISOString(),
      })
    }

    const expiresAtMs = Date.parse(expiresAt)
    if (!Number.isFinite(expiresAtMs)) throw new Error('INVALID_TRASH_EXPIRY')
    transaction.set(deletedRef, {
      id,
      entityType: record.entityType,
      entity: current,
      deletedBy: auth.currentUser?.email || uid,
      deletedByUid: uid,
      deletedAt,
      expiresAt,
      expiresAtTimestamp: Timestamp.fromMillis(expiresAtMs),
    })
    transaction.delete(targetRef)
  })
}

export async function putInTrash(
  record: Omit<TrashRecord, 'id' | 'deletedAt' | 'expiresAt'>,
  mutate: (customers: unknown[], entries: unknown[]) => { customers: unknown[]; entries: unknown[] },
  userId: string,
) {
  const entity = record.entity as LedgerCustomer | LedgerEntry
  const id = `${record.entityType}-${entity.id}`
  const now = new Date()
  await putInTrashWithId(id, record, mutate, userId, now.toISOString(), new Date(now.getTime() + 10 * 86400000).toISOString())
  return id
}

export async function restoreTrashWithId(record: TrashRecord, userId: string, operationId: string) {
  const uid = currentUid(userId)
  await assertCanEdit(uid)
  assertRecordId(operationId)
  await runTransaction(db, async transaction => {
    const deletedRef = trashRef(record.id)
    const opRef = operationRef(operationId)
    const [trashSnapshot, operationSnapshot] = await Promise.all([transaction.get(deletedRef), transaction.get(opRef)])
    if (operationSnapshot.exists()) return
    if (!trashSnapshot.exists()) throw new Error('TRASH_ITEM_NOT_FOUND')
    const stored = trashSnapshot.data() as TrashRecord
    if (new Date(stored.expiresAt).getTime() <= Date.now()) throw new Error('TRASH_ITEM_EXPIRED')
    const rawEntity = stored.entity as any

    if (stored.entityType === 'customer') {
      const targetRef = customerRef(rawEntity.id)
      const targetSnapshot = await transaction.get(targetRef)
      if (targetSnapshot.exists()) throw new Error('ENTITY_ALREADY_EXISTS')
      const restored = {
        ...rawEntity,
        activeEntryCount: 0,
        lastEntryMutationId: '',
        lastEntryMutationKind: '',
        updatedByUid: uid,
        restoredFromTrashId: stored.id,
        restoredByUid: uid,
        updatedAt: new Date().toISOString(),
      }
      transaction.set(targetRef, restored)
    } else {
      const targetRef = entryRef(rawEntity.id)
      const parentRef = customerRef(rawEntity.customerId)
      const [targetSnapshot, parentSnapshot] = await Promise.all([transaction.get(targetRef), transaction.get(parentRef)])
      if (targetSnapshot.exists()) throw new Error('ENTITY_ALREADY_EXISTS')
      if (!parentSnapshot.exists()) throw new Error('CUSTOMER_NOT_FOUND')
      const parent = parentSnapshot.data() as Record<string, any>
      transaction.update(parentRef, {
        activeEntryCount: Number(parent.activeEntryCount || 0) + 1,
        lastEntryMutationId: rawEntity.id,
        lastEntryMutationKind: 'restore',
        updatedByUid: uid,
        updatedAt: new Date().toISOString(),
      })
      transaction.set(targetRef, {
        ...rawEntity,
        updatedByUid: uid,
        restoredFromTrashId: stored.id,
        restoredByUid: uid,
        updatedAt: new Date().toISOString(),
      })
    }
    transaction.delete(deletedRef)
    transaction.set(opRef, { id: operationId, type: 'trash-restore', trashId: stored.id, appliedAt: new Date().toISOString(), appliedBy: uid })
  })
}

export async function restoreTrash(record: TrashRecord, userId: string) {
  return restoreTrashWithId(record, userId, crypto.randomUUID())
}

export async function purgeExpiredTrash() {
  const uid = currentUid()
  await assertOwner(uid)
  if (await getLedgerStorageState() !== 'normalized') return 0
  const snap = await getDocs(trashCollection())
  const now = Date.now()
  const expired = snap.docs.filter(item => {
    const data = item.data() as TrashRecord
    return Number(data.expiresAtMs ?? Date.parse(data.expiresAt)) <= now
  })
  await commitWrites(expired.map(item => ({ ref: item.ref })))
  return expired.length
}

export async function exportLedgerBackup() {
  const state = await getLedgerStorageState()
  if (state === 'empty') {
    return { format: 'daftar-deyoun-backup-v1', exportedAt: new Date().toISOString(), customers: [], entries: [], activities: [], trash: [] }
  }
  if (state === 'legacy') {
    const [main, legacy] = await Promise.all([getDoc(legacyMainRef()), getDocs(legacyDataCollection())])
    const data = main.exists() ? main.data() : {}
    const activities = legacy.docs.filter(item => item.id.startsWith('activity-')).map(item => item.data())
    const trash = legacy.docs.filter(item => item.id.startsWith('trash-')).map(item => item.data())
    return {
      format: 'daftar-deyoun-backup-v1',
      exportedAt: new Date().toISOString(),
      customers: Array.isArray(data.customers) ? data.customers : [],
      entries: Array.isArray(data.entries) ? data.entries : [],
      activities,
      trash,
    }
  }
  const [customersSnap, entriesSnap, activitiesSnap, trashSnap, operationsSnap] = await Promise.all([
    getDocs(customersCollection()), getDocs(entriesCollection()), getDocs(activityCollection()),
    getDocs(trashCollection()), getDocs(operationsCollection()),
  ])
  return {
    format: 'daftar-deyoun-backup-v1',
    exportedAt: new Date().toISOString(),
    customers: customersSnap.docs.map(item => item.data()),
    entries: entriesSnap.docs.map(item => item.data()),
    activities: activitiesSnap.docs.map(item => item.data()),
    trash: trashSnap.docs.map(item => { const data = item.data(); const { expiresAtTimestamp: _expiresAtTimestamp, ...backupRecord } = data; return backupRecord }),
    operations: operationsSnap.docs.map(item => item.data()),
  }
}

export async function restoreLedgerBackup(backup: any, userId: string) {
  const uid = currentUid(userId)
  await assertOwner(uid)
  if (!backup || backup.format !== 'daftar-deyoun-backup-v1' || !Array.isArray(backup.customers) || !Array.isArray(backup.entries) || !Array.isArray(backup.activities) || !Array.isArray(backup.trash)) throw new Error('INVALID_BACKUP')
  if (backup.operations !== undefined && !Array.isArray(backup.operations)) throw new Error('INVALID_BACKUP')

  if (await getLedgerStorageState() === 'legacy') await migrateLegacyLedger(uid)

  const customersRaw = backup.customers as any[]
  const entriesRaw = backup.entries as any[]
  const customerIds = new Set<string>()
  const entryIds = new Set<string>()
  const counts = new Map<string, number>()
  for (const item of customersRaw) {
    assertRecordId(item?.id)
    if (customerIds.has(item.id)) throw new Error('INVALID_BACKUP_DUPLICATE_CUSTOMER')
    if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(`INVALID_BACKUP_CUSTOMER:${item.id}`)
    customerIds.add(item.id)
  }
  for (const item of entriesRaw) {
    assertRecordId(item?.id)
    if (entryIds.has(item.id)) throw new Error('INVALID_BACKUP_DUPLICATE_ENTRY')
    if (!customerIds.has(item.customerId)) throw new Error(`INVALID_BACKUP_ORPHAN_ENTRY:${item.id}`)
    if (!['debt', 'payment'].includes(item.kind) || !['USD', 'SYP'].includes(item.currency) || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) throw new Error(`INVALID_BACKUP_ENTRY:${item.id}`)
    entryIds.add(item.id)
    counts.set(item.customerId, (counts.get(item.customerId) || 0) + 1)
  }
  const activityRows = (backup.activities as any[]).map(item => {
    if (!item || typeof item.id !== 'string' || !item.id) throw new Error('INVALID_BACKUP_ACTIVITY')
    return { id: item.id, data: { ...item, type: 'activity', actorUid: item.actorUid || null, legacyImported: true, migratedByUid: uid } }
  })
  const trashRows = (backup.trash as any[]).map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || !['customer', 'entry'].includes(item.entityType) || !item.entity || typeof item.entity.id !== 'string') throw new Error('INVALID_BACKUP_TRASH')
    const expiry = Date.parse(item.expiresAt)
    if (!Number.isFinite(expiry)) throw new Error(`INVALID_BACKUP_TRASH_EXPIRY:${item.id}`)
    return { id: item.id, data: {
      ...item,
      expiresAtMs: expiry,
      expiresAtTimestamp: Timestamp.fromMillis(expiry),
      deletedByUid: item.deletedByUid || null,
      legacyImported: true,
      migratedByUid: uid,
    } }
  })
  const operationRows = Array.isArray(backup.operations) ? (backup.operations as any[]).map(item => {
    if (!item || typeof item.id !== 'string' || !item.id) throw new Error('INVALID_BACKUP_OPERATION')
    return { id: item.id, data: { ...item, legacyImported: true, migratedByUid: uid } }
  }) : null

  const ensureUnique = (rows: Array<{ id: string }>, label: string) => {
    const seen = new Set<string>()
    for (const row of rows) {
      assertRecordId(row.id)
      if (seen.has(row.id)) throw new Error(`INVALID_BACKUP_DUPLICATE_${label}`)
      seen.add(row.id)
    }
  }
  ensureUnique(activityRows, 'ACTIVITY')
  ensureUnique(trashRows, 'TRASH')
  if (operationRows) ensureUnique(operationRows, 'OPERATION')

  // Mark the ledger as restoring first. Editors are temporarily routed to the preserved legacy view.
  await setDoc(schemaRef(), {
    version: SCHEMA_VERSION,
    status: 'restoring',
    restoringByUid: uid,
    restoringAt: new Date().toISOString(),
  }, { merge: true })

  const [currentCustomers, currentEntries, currentActivity, currentTrash, currentOperations] = await Promise.all([
    getDocs(customersCollection()), getDocs(entriesCollection()), getDocs(activityCollection()), getDocs(trashCollection()), getDocs(operationsCollection()),
  ])
  const writes: Array<{ ref: ReturnType<typeof doc>; data?: Record<string, unknown> }> = []
  const desiredCustomers = new Set(customersRaw.map(item => item.id))
  const desiredEntries = new Set(entriesRaw.map(item => item.id))
  const desiredActivities = new Set(activityRows.map(item => item.id))
  const desiredTrash = new Set(trashRows.map(item => item.id))
  const desiredOperations = operationRows ? new Set(operationRows.map(item => item.id)) : null

  for (const item of currentCustomers.docs) if (!desiredCustomers.has(item.id)) writes.push({ ref: item.ref })
  for (const item of currentEntries.docs) if (!desiredEntries.has(item.id)) writes.push({ ref: item.ref })
  for (const item of currentActivity.docs) if (!desiredActivities.has(item.id)) writes.push({ ref: item.ref })
  for (const item of currentTrash.docs) if (!desiredTrash.has(item.id)) writes.push({ ref: item.ref })
  // Older v1 backups do not contain operation tokens. Preserve those tokens rather than risking replay.
  if (operationRows && desiredOperations) {
    for (const item of currentOperations.docs) if (!desiredOperations.has(item.id)) writes.push({ ref: item.ref })
  }

  for (const item of customersRaw) writes.push({ ref: customerRef(item.id), data: cleanCustomer(item, uid, true, counts.get(item.id) || 0) })
  for (const item of entriesRaw) writes.push({ ref: entryRef(item.id), data: cleanEntry(item, uid, true) })
  for (const row of activityRows) writes.push({ ref: activityRef(row.id), data: row.data })
  for (const row of trashRows) writes.push({ ref: trashRef(row.id), data: row.data })
  if (operationRows) for (const row of operationRows) writes.push({ ref: operationRef(row.id), data: row.data })

  await commitWrites(writes)
  const verified = await verifyNormalizedLedger(customersRaw, entriesRaw, {
    activities: activityRows.length,
    trash: trashRows.length,
    operations: operationRows ? operationRows.length : currentOperations.size,
    activityRows, trashRows, operationRows: operationRows || undefined,
  })
  await setDoc(schemaRef(), {
    version: SCHEMA_VERSION,
    status: 'ready',
    restoredAt: new Date().toISOString(),
    restoredByUid: uid,
    legacyPreserved: true,
    counts: verified,
  }, { merge: true })
}


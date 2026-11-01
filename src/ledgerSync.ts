import { arrayUnion, collection, doc, getDocs, onSnapshot, orderBy, query, runTransaction, setDoc, writeBatch } from 'firebase/firestore'
import { db } from './firebase'

export type LedgerData = { customers: unknown[]; entries: unknown[]; updatedAt: string; updatedBy: string }
export type LedgerCustomer = { id: string; name: string; phone: string; createdAt: string }
export type LedgerEntry = { id: string; customerId: string; kind: 'debt' | 'payment'; amount: number; currency: 'USD' | 'SYP'; note: string; actor: string; date: string }
export type ActivityEvent = { id: string; action: string; description: string; actor: string; actorEmail: string; createdAt: string; details?: string; customerName?: string }
export type TrashRecord = { id: string; entityType: 'customer' | 'entry'; entity: LedgerCustomer | LedgerEntry; deletedAt: string; expiresAt: string; deletedBy: string }

const shop = 'daftar-shared'
export const sharedLedgerRef = () => doc(db, 'shops', shop, 'data', 'main')
const dataCollection = () => collection(db, 'shops', shop, 'data')
const eventRef = (id: string) => doc(db, 'shops', shop, 'data', `activity-${id}`)
const trashRef = (id: string) => doc(db, 'shops', shop, 'data', `trash-${id}`)

export function watchSharedLedger(onData: (data: LedgerData | null) => void, onError: (error: Error) => void) {
  return onSnapshot(sharedLedgerRef(), { includeMetadataChanges: true }, snapshot => {
    if (!snapshot.exists()) { onData(null); return }
    const data = snapshot.data()
    onData({ customers: Array.isArray(data.customers) ? data.customers : [], entries: Array.isArray(data.entries) ? data.entries : [], updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '', updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : '' })
  }, onError)
}

export async function appendSharedCustomer(customer: LedgerCustomer, userId: string) {
  await setDoc(sharedLedgerRef(), { customers: arrayUnion(customer), updatedAt: new Date().toISOString(), updatedBy: userId }, { merge: true })
}
export async function appendSharedEntry(entry: LedgerEntry, userId: string) {
  await setDoc(sharedLedgerRef(), { entries: arrayUnion(entry), updatedAt: new Date().toISOString(), updatedBy: userId }, { merge: true })
}
export async function saveSharedLedger(customers: unknown[], entries: unknown[], userId: string) {
  await setDoc(sharedLedgerRef(), { customers, entries, updatedAt: new Date().toISOString(), updatedBy: userId }, { merge: true })
}

export async function mutateSharedLedger(mutate: (customers: unknown[], entries: unknown[]) => { customers: unknown[]; entries: unknown[] }, userId: string) {
  await runTransaction(db, async transaction => {
    const ref = sharedLedgerRef()
    const snapshot = await transaction.get(ref)
    const data = snapshot.exists() ? snapshot.data() : {}
    const next = mutate(Array.isArray(data.customers) ? data.customers : [], Array.isArray(data.entries) ? data.entries : [])
    transaction.set(ref, { customers: next.customers, entries: next.entries, updatedAt: new Date().toISOString(), updatedBy: userId }, { merge: true })
  })
}


export async function updateSharedEntity(
  operationId: string,
  entityType: 'customer' | 'entry',
  id: string,
  expected: unknown,
  replacement: unknown,
  userId: string,
) {
  await runTransaction(db, async transaction => {
    const ref = sharedLedgerRef()
    const operationRef = doc(db, 'shops', shop, 'data', `operation-${operationId}`)
    const [snapshot, operationSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(operationRef),
    ])
    if (operationSnapshot.exists()) return
    if (!snapshot.exists()) throw new Error('LEDGER_NOT_FOUND')
    const data = snapshot.data()
    const field = entityType === 'customer' ? 'customers' : 'entries'
    const rows = Array.isArray(data[field]) ? [...data[field]] : []
    const index = rows.findIndex((row: any) => row?.id === id)
    if (index < 0) throw new Error('ENTITY_NOT_FOUND')

    const current = rows[index] as Record<string, unknown>
    const before = expected as Record<string, unknown>
    const after = replacement as Record<string, unknown>
    const merged = { ...current }
    const changedKeys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of changedKeys) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
      // Another device changed the same field: preserve its value and stop.
      if (JSON.stringify(current[key]) !== JSON.stringify(before[key]) &&
          JSON.stringify(current[key]) !== JSON.stringify(after[key])) {
        throw new Error('ENTITY_CONFLICT')
      }
      if (Object.prototype.hasOwnProperty.call(after, key)) merged[key] = after[key]
      else delete merged[key]
    }
    rows[index] = merged
    transaction.update(ref, { [field]: rows, updatedAt: new Date().toISOString(), updatedBy: userId })
    transaction.set(operationRef, { id: operationId, type: 'entity-update', appliedAt: new Date().toISOString(), appliedBy: userId })
  })
}
export async function recordActivity(event: Omit<ActivityEvent, 'id'>) {
  const id = crypto.randomUUID()
  await setDoc(eventRef(id), { ...event, id, type: 'activity' })
}
export async function listActivity(limitCount = 150): Promise<ActivityEvent[]> {
  const snap = await getDocs(query(dataCollection(), orderBy('createdAt', 'desc')))
  return snap.docs.filter(d => d.id.startsWith('activity-')).slice(0, limitCount).map(d => d.data() as ActivityEvent)
}
export async function listTrash(): Promise<TrashRecord[]> {
  const snap = await getDocs(dataCollection())
  return snap.docs.filter(d => d.id.startsWith('trash-')).map(d => d.data() as TrashRecord).sort((a,b) => b.deletedAt.localeCompare(a.deletedAt))
}
export async function putInTrash(record: Omit<TrashRecord, 'id' | 'deletedAt' | 'expiresAt'>, mutate: (customers: unknown[], entries: unknown[]) => { customers: unknown[]; entries: unknown[] }, userId: string) {
  const id = crypto.randomUUID()
  const now = new Date()
  const deletedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 10 * 86400000).toISOString()
  await runTransaction(db, async transaction => {
    const mainRef = sharedLedgerRef()
    const snap = await transaction.get(mainRef)
    const data = snap.exists() ? snap.data() : {}
    const next = mutate(Array.isArray(data.customers) ? data.customers : [], Array.isArray(data.entries) ? data.entries : [])
    transaction.set(mainRef, { customers: next.customers, entries: next.entries, updatedAt: deletedAt, updatedBy: userId }, { merge: true })
    transaction.set(trashRef(id), { ...record, id, deletedAt, expiresAt })
  })
  return id
}
export async function restoreTrash(record: TrashRecord, userId: string) {
  await runTransaction(db, async transaction => {
    const mainRef = sharedLedgerRef()
    const deletedRef = trashRef(record.id)
    const [mainSnap, trashSnap] = await Promise.all([transaction.get(mainRef), transaction.get(deletedRef)])
    if (!trashSnap.exists()) throw new Error('TRASH_ITEM_NOT_FOUND')
    if (new Date(record.expiresAt).getTime() <= Date.now()) throw new Error('TRASH_ITEM_EXPIRED')
    const data = mainSnap.exists() ? mainSnap.data() : {}
    const customers = Array.isArray(data.customers) ? [...data.customers] : []
    const entries = Array.isArray(data.entries) ? [...data.entries] : []
    if (record.entityType === 'customer') {
      if (!customers.some((c: any) => c.id === record.entity.id)) customers.push(record.entity)
    } else if (!entries.some((e: any) => e.id === record.entity.id)) entries.push(record.entity)
    transaction.set(mainRef, { customers, entries, updatedAt: new Date().toISOString(), updatedBy: userId }, { merge: true })
    transaction.delete(deletedRef)
  })
}
export async function purgeExpiredTrash() {
  const records = await listTrash()
  const expired = records.filter(r => new Date(r.expiresAt).getTime() <= Date.now())
  for (const record of expired) await runTransaction(db, async tx => {
    const ref = trashRef(record.id)
    const snap = await tx.get(ref)
    if (snap.exists()) tx.delete(ref)
  })
  return expired.length
}
export async function exportLedgerBackup() {
  const [ledger, activities, trash] = await Promise.all([getDocs(query(dataCollection())), listActivity(1000), listTrash()])
  const main = ledger.docs.find(d => d.id === 'main')?.data() ?? { customers: [], entries: [] }
  return { format: 'daftar-deyoun-backup-v1', exportedAt: new Date().toISOString(), customers: Array.isArray(main.customers) ? main.customers : [], entries: Array.isArray(main.entries) ? main.entries : [], activities, trash }
}
export async function restoreLedgerBackup(backup: any, userId: string) {
  if (!backup || backup.format !== 'daftar-deyoun-backup-v1' || !Array.isArray(backup.customers) || !Array.isArray(backup.entries) || !Array.isArray(backup.activities) || !Array.isArray(backup.trash)) throw new Error('INVALID_BACKUP')
  const current = await getDocs(dataCollection())
  const operations: Array<{ ref: ReturnType<typeof doc>; data?: Record<string, unknown> }> = []
  for (const item of current.docs) {
    if (item.id.startsWith('activity-') || item.id.startsWith('trash-')) operations.push({ ref: item.ref })
  }
  for (const item of backup.activities) {
    if (!item || typeof item.id !== 'string' || !item.id) throw new Error('INVALID_BACKUP')
    operations.push({ ref: doc(db, 'shops', shop, 'data', `activity-${item.id}`), data: { ...item, type: 'activity' } })
  }
  for (const item of backup.trash) {
    if (!item || typeof item.id !== 'string' || !item.id) throw new Error('INVALID_BACKUP')
    operations.push({ ref: doc(db, 'shops', shop, 'data', `trash-${item.id}`), data: item })
  }
  await saveSharedLedger(backup.customers, backup.entries, userId)
  for (let i = 0; i < operations.length; i += 450) {
    const batch = writeBatch(db)
    for (const operation of operations.slice(i, i + 450)) {
      if (operation.data) batch.set(operation.ref, operation.data)
      else batch.delete(operation.ref)
    }
    await batch.commit()
  }
}

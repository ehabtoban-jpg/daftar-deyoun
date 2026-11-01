import { arrayUnion, doc, onSnapshot, runTransaction, setDoc } from 'firebase/firestore
import { db } from './firebase'

export type LedgerData = {
  customers: unknown[]
  entries: unknown[]
  updatedAt: string
  updatedBy: string
}

export type LedgerCustomer = {
  id: string
  name: string
  phone: string
  createdAt: string
}

export type LedgerEntry = {
  id: string
  customerId: string
  kind: 'debt' | 'payment'
  amount: number
  currency: 'USD' | 'SYP'
  note: string
  actor: string
  date: string
}

export const sharedLedgerRef = () => doc(db, 'shops', 'daftar-shared', 'data', 'main')

export function watchSharedLedger(
  onData: (data: LedgerData | null) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    sharedLedgerRef(),
    { includeMetadataChanges: true },
    snapshot => {
      if (!snapshot.exists()) {
        onData(null)
        return
      }
      const data = snapshot.data()
      onData({
        customers: Array.isArray(data.customers) ? data.customers : [],
        entries: Array.isArray(data.entries) ? data.entries : [],
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
        updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : '',
      })
    },
    error => onError(error),
  )
}

// Append-only writes use Firestore arrayUnion transforms. Unlike replacing the
// complete arrays, concurrent additions from two accounts do not overwrite
// each other. Firestore's persistent cache queues these writes while offline.
export async function appendSharedCustomer(customer: LedgerCustomer, userId: string) {
  await setDoc(sharedLedgerRef(), {
    customers: arrayUnion(customer),
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  }, { merge: true })
}

export async function appendSharedEntry(entry: LedgerEntry, userId: string) {
  await setDoc(sharedLedgerRef(), {
    entries: arrayUnion(entry),
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  }, { merge: true })
}

export async function saveSharedLedger(
  customers: unknown[],
  entries: unknown[],
  userId: string,
) {
  await setDoc(sharedLedgerRef(), {
    customers,
    entries,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  }, { merge: true })
}


// Online edits/deletions use a Firestore transaction so simultaneous changes
// from the owner and brother cannot silently overwrite each other.
export async function mutateSharedLedger(
  mutate: (customers: unknown[], entries: unknown[]) => { customers: unknown[]; entries: unknown[] },
  userId: string,
) {
  await runTransaction(db, async transaction => {
    const ref = sharedLedgerRef()
    const snapshot = await transaction.get(ref)
    const data = snapshot.exists() ? snapshot.data() : {}
    const currentCustomers = Array.isArray(data.customers) ? data.customers : []
    const currentEntries = Array.isArray(data.entries) ? data.entries : []
    const nextData = mutate(currentCustomers, currentEntries)
    transaction.set(ref, {
      customers: nextData.customers,
      entries: nextData.entries,
      updatedAt: new Date().toISOString(),
      updatedBy: userId,
    }, { merge: true })
  })
}

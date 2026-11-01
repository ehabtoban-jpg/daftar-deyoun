import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { db } from './firebase'

export type LedgerData = {
  customers: unknown[]
  entries: unknown[]
  updatedAt: string
  updatedBy: string
}

export const sharedLedgerRef = () => doc(db, 'shops', 'daftar-shared', 'data', 'main')

export function watchSharedLedger(
  onData: (data: LedgerData | null) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    sharedLedgerRef(),
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
  })
}

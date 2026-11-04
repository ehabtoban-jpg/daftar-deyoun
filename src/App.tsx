import { useMemo, useState, useEffect, useRef } from 'react'
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { auth } from './firebase'
import { scopedLedgerStorageKey, resolveLedgerShop, setActiveShopId, watchSharedLedger, saveSharedLedger, appendSharedCustomer, appendSharedEntry, updateSharedEntity, recordActivity, listActivity, listTrash, putInTrashWithId, restoreTrashWithId, exportLedgerBackup, restoreLedgerBackup, purgeExpiredTrash, watchActiveShopRole, getLedgerStorageState, migrateLegacyLedger, type ActivityEvent, type TrashRecord, type ShopRole, type LedgerStorageState } from './ledgerSync'
import { Users, Wallet, Search, Plus, ArrowDownLeft, ArrowUpRight, X, Check, Pencil, Trash2, RotateCcw, Archive, Download, Upload, MessageCircle, ShieldCheck, Activity, Settings, FileText } from 'lucide-react'

type Currency = 'USD' | 'SYP'
type Customer = { id: string; name: string; phone: string; createdAt: string }
type Entry = { id: string; customerId: string; kind: 'debt' | 'payment'; amount: number; currency: Currency; note: string; actor: string; date: string }

const money = (n: number, c: Currency) => new Intl.NumberFormat('ar', { maximumFractionDigits: 2 }).format(n) + (c === 'USD' ? ' $' : ' ل.س')
const scopedKey = (key: string) =>
  key.startsWith('dd-pending-') || key === 'dd-customers' || key === 'dd-entries'
    ? scopedLedgerStorageKey(key)
    : key

const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(scopedKey(key)); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }

const createId = () => {
  // randomUUID is restricted to secure contexts in some browsers; getRandomValues also works on localhost variants.
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // Last-resort fallback for older or restricted browser environments.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

type PendingLedgerWrite = { id: string; type: 'customer' | 'entry'; value: Customer | Entry; userId: string }
type PendingTrashDelete = { record: TrashRecord; userId: string }
const PENDING_TRASH_DELETES_KEY = 'dd-pending-trash-deletes-v1'
const readPendingTrashDeletes = (): PendingTrashDelete[] => load<PendingTrashDelete[]>(PENDING_TRASH_DELETES_KEY, [])
const enqueuePendingTrashDelete = (item: PendingTrashDelete) => {
  const queue = readPendingTrashDeletes()
  if (!queue.some(row => row.record.id === item.record.id)) localStorage.setItem(scopedKey(PENDING_TRASH_DELETES_KEY), JSON.stringify([...queue, item]))
}
async function flushPendingTrashDeletes() {
  if (!navigator.onLine) return
  for (const item of readPendingTrashDeletes()) {
    if (!navigator.onLine) return
    const { record, userId } = item
    await putInTrashWithId(record.id, { entityType: record.entityType, entity: record.entity, deletedBy: record.deletedBy }, (cs, es) => {
      const customers = cs as Customer[]
      const entries = es as Entry[]
      if (record.entityType === 'customer') {
        if (entries.some(entry => entry.customerId === record.entity.id)) throw new Error('CUSTOMER_HAS_ENTRIES')
        return { customers: customers.filter(customer => customer.id !== record.entity.id), entries }
      }
      return { customers, entries: entries.filter(entry => entry.id !== record.entity.id) }
    }, userId, record.deletedAt, record.expiresAt)
    localStorage.setItem(scopedKey(PENDING_TRASH_DELETES_KEY), JSON.stringify(readPendingTrashDeletes().filter(row => row.record.id !== record.id)))
  }
}
type PendingTrashRestore = { id: string; record: TrashRecord; userId: string }
const PENDING_TRASH_RESTORES_KEY = 'dd-pending-trash-restores-v1'
const readPendingTrashRestores = (): PendingTrashRestore[] => load<PendingTrashRestore[]>(PENDING_TRASH_RESTORES_KEY, [])
const enqueuePendingTrashRestore = (item: PendingTrashRestore) => {
  const queue = readPendingTrashRestores()
  if (!queue.some(row => row.id === item.id)) localStorage.setItem(scopedKey(PENDING_TRASH_RESTORES_KEY), JSON.stringify([...queue, item]))
}
async function flushPendingTrashRestores() {
  if (!navigator.onLine) return
  for (const item of readPendingTrashRestores()) {
    if (!navigator.onLine) return
    await restoreTrashWithId(item.record, item.userId, item.id)
    localStorage.setItem(scopedKey(PENDING_TRASH_RESTORES_KEY), JSON.stringify(readPendingTrashRestores().filter(row => row.id !== item.id)))
  }
}
type PendingEntityUpdate = { id: string; entityType: 'customer' | 'entry'; entityId: string; expected: Customer | Entry; replacement: Customer | Entry; userId: string; forceFields?: string[] }
const PENDING_UPDATES_KEY = 'dd-pending-entity-updates-v1'
const readPendingUpdates = (): PendingEntityUpdate[] => load<PendingEntityUpdate[]>(PENDING_UPDATES_KEY, [])
const enqueueEntityUpdate = (operation: PendingEntityUpdate) => {
  const queue = readPendingUpdates()
  if (!queue.some(item => item.id === operation.id)) localStorage.setItem(scopedKey(PENDING_UPDATES_KEY), JSON.stringify([...queue, operation]))
}
const PENDING_WRITES_KEY = 'dd-pending-ledger-writes-v1'
const readPendingWrites = (): PendingLedgerWrite[] => load<PendingLedgerWrite[]>(PENDING_WRITES_KEY, [])
const enqueueLedgerWrite = (write: PendingLedgerWrite) => {
  const queue = readPendingWrites()
  if (!queue.some(item => item.id === write.id)) localStorage.setItem(scopedKey(PENDING_WRITES_KEY), JSON.stringify([...queue, write]))
}
async function flushPendingLedgerWrites() {
  if (!navigator.onLine) return
  const queue = readPendingWrites()
  for (const item of queue) {
    if (!navigator.onLine) return
    if (item.type === 'customer') await appendSharedCustomer(item.value as Customer, item.userId)
    else await appendSharedEntry(item.value as Entry, item.userId)
    const latest = readPendingWrites().filter(write => write.id !== item.id)
    localStorage.setItem(scopedKey(PENDING_WRITES_KEY), JSON.stringify(latest))
  }
}
async function flushPendingEntityUpdates() {
  if (!navigator.onLine) return
  const queue = readPendingUpdates()
  const groups = new Map<string, PendingEntityUpdate[]>()
  for (const item of queue) {
    const key = `${item.entityType}:${item.entityId}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  for (const [key, items] of groups) {
    if (!navigator.onLine) return
    const first = items[0]
    const last = items[items.length - 1]
    const forceFields = new Set(items.flatMap(item => item.forceFields ?? []))
    // The user explicitly approved resolving this queued customer's name to the final local value.
    if (first.entityType === 'customer' && (first.expected as Customer).name !== (last.replacement as Customer).name) forceFields.add('name')
    try {
      await updateSharedEntity(first.id, first.entityType, first.entityId, first.expected, last.replacement, last.userId, [...forceFields])
      const completed = new Set(items.map(item => item.id))
      localStorage.setItem(scopedKey(PENDING_UPDATES_KEY), JSON.stringify(readPendingUpdates().filter(write => !completed.has(write.id))))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`تعذر مزامنة التعديل (${key}): ${reason}`)
    }
  }
}

function Dashboard({ user, onPinStateChange }: { user: User; onPinStateChange: (enabled: boolean) => void }) {
  const [customers, setCustomers] = useState<Customer[]>(() => load('dd-customers', []))
  const [entries, setEntries] = useState<Entry[]>(() => load('dd-entries', []))
  const actor = user.email || user.uid
  const [memberRole, setMemberRole] = useState<ShopRole>('viewer')
  const [storageState, setStorageState] = useState<LedgerStorageState>('empty')
  const [migrationBusy, setMigrationBusy] = useState(false)
  const canEditNow = memberRole !== 'viewer' && storageState === 'normalized'
  const requireEditableStorage = () => {
    if (memberRole === 'viewer') { window.alert('هذا الحساب للعرض فقط.'); return false }
    if (storageState !== 'normalized') { window.alert('الدفتر ما زال على التخزين القديم. يجب على المالك إكمال الترحيل قبل إجراء تعديلات.'); return false }
    return true
  }
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<'customer' | 'entry' | 'editCustomer' | 'editEntry' | null>(null)
  const [editingId, setEditingId] = useState('')
  const [editingOriginal, setEditingOriginal] = useState<Customer | Entry | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [selected, setSelected] = useState('')
  const [entryCustomerId, setEntryCustomerId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [kind, setKind] = useState<'debt' | 'payment'>('debt')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USD')
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState<'all' | 'owing'>('all')
  const [entryError, setEntryError] = useState('')
  const [reminderOffer, setReminderOffer] = useState<Entry | null>(null)
  const [syncStatus, setSyncStatus] = useState('جارٍ الاتصال بالسحابة…')
  const [showActivity, setShowActivity] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activities, setActivities] = useState<ActivityEvent[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const [trashItems, setTrashItems] = useState<TrashRecord[]>([])
  const [backupBusy, setBackupBusy] = useState(false)
  const [contactsBusy, setContactsBusy] = useState(false)
  const [showPinSettings, setShowPinSettings] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('dd-theme') === 'dark' ? 'dark' : 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dd-theme', theme)
  }, [theme])
  useEffect(() => {
    let active = true
    const stopRole = watchActiveShopRole(user.uid, role => {
      if (active) setMemberRole(role)
    }, error => {
      console.error('تعذر متابعة صلاحيات الدفتر', error)
      if (active) setMemberRole('viewer')
    })
    void getLedgerStorageState().then(state => {
      if (active) setStorageState(state)
    }).catch(error => {
      console.error('تعذر تحميل حالة التخزين', error)
    })
    return () => { active = false; stopRole() }
  }, [user.uid])
  const backupInput = useRef<HTMLInputElement>(null)
  const downloadBackup = async () => {
    setBackupBusy(true)
    try {
      const backup = await exportLedgerBackup()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `daftar-deyoun-backup-${new Date().toISOString().slice(0,10)}.json`
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url)
      setSyncStatus('تم تنزيل النسخة الاحتياطية')
    } catch { window.alert('تعذر إنشاء النسخة الاحتياطية. تحقق من اتصال الإنترنت وحاول مجدداً.') }
    finally { setBackupBusy(false) }
  }
  const importBackup = async (file?: File) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) { window.alert('اختر ملف نسخة احتياطية بامتداد JSON.'); return }
    if (!window.confirm('تحذير: ستُستبدل قائمة الزبائن والحركات المالية الحالية بمحتويات النسخة الاحتياطية. هل تريد المتابعة؟')) { if (backupInput.current) backupInput.current.value = ''; return }
    setBackupBusy(true)
    try {
      const backup = JSON.parse(await file.text())
      await restoreLedgerBackup(backup, user.uid)
      setSyncStatus('تمت استعادة النسخة الاحتياطية؛ جارٍ تحديث الدفتر')
      window.alert('تمت الاستعادة بنجاح. انتظر لحظات حتى تظهر البيانات المحدثة.')
    } catch (error) {
      window.alert(error instanceof Error && error.message === 'INVALID_BACKUP' ? 'الملف ليس نسخة احتياطية صالحة من دفتر الديون.' : 'تعذرت استعادة النسخة. لم يتم اعتماد الملف.')
    } finally { setBackupBusy(false); if (backupInput.current) backupInput.current.value = '' }
  }
  const refreshActivity = async () => { try { setActivities(await listActivity()) } catch { setSyncStatus('تعذر تحميل سجل النشاطات') } }
  const importPhoneContacts = async () => {
    if (!requireEditableStorage()) return
    type ContactPickerNavigator = Navigator & { contacts?: { select: (properties: string[], options?: { multiple?: boolean }) => Promise<Array<{ name?: string[]; tel?: string[] }>> } }
    const picker = (navigator as ContactPickerNavigator).contacts
    if (!picker || typeof picker.select !== 'function') {
      window.alert('استيراد جهات الاتصال مباشرة غير مدعوم في هذا المتصفح. جرّب Chrome على هاتف Android، أو أضف الزبون يدوياً حالياً.')
      return
    }
    setContactsBusy(true)
    try {
      const selectedContacts = await picker.select(['name', 'tel'], { multiple: true })
      const normalizePhone = (value: string) => value.replace(/\D/g, '')
      const knownPhones = new Set(customers.map(customer => normalizePhone(customer.phone)).filter(Boolean))
      const knownNames = new Set(customers.map(customer => customer.name.trim().toLocaleLowerCase()))
      const additions: Customer[] = []
      for (const contact of selectedContacts) {
        const contactName = contact.name?.find(value => value.trim())?.trim() || ''
        const contactPhone = contact.tel?.find(value => value.trim())?.trim() || ''
        if (!contactName) continue
        const normalizedPhone = normalizePhone(contactPhone)
        const normalizedName = contactName.toLocaleLowerCase()
        if ((normalizedPhone && knownPhones.has(normalizedPhone)) || (!normalizedPhone && knownNames.has(normalizedName))) continue
        additions.push({ id: createId(), name: contactName, phone: contactPhone, createdAt: new Date().toISOString() })
        if (normalizedPhone) knownPhones.add(normalizedPhone)
        knownNames.add(normalizedName)
      }
      if (!additions.length) { window.alert(selectedContacts.length ? 'لم نعثر على جهات اتصال جديدة؛ قد تكون مضافة مسبقاً أو بلا أسماء.' : 'لم يتم اختيار أي جهة اتصال.'); return }
      const next = [...customers, ...additions]
      setCustomers(next)
      localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(next))
      setSyncStatus('جارٍ حفظ جهات الاتصال ومزامنتها…')
      for (const customer of additions) await appendSharedCustomer(customer, user.uid)
      await logActivity('استيراد جهات اتصال', 'تم استيراد ' + additions.length + ' جهة اتصال من الهاتف')
      setSyncStatus('تم استيراد ومزامنة ' + additions.length + ' جهة اتصال')
      window.alert('تم استيراد ' + additions.length + ' جهة اتصال بنجاح.')
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      setSyncStatus('تعذر استيراد بعض جهات الاتصال')
      window.alert('تعذر إكمال الاستيراد. تحقق من اتصال الإنترنت وصلاحية جهات الاتصال ثم حاول مجدداً.')
    } finally { setContactsBusy(false) }
  }
  const refreshTrash = async () => { try { const cloud = await listTrash(); const pendingDeletes = readPendingTrashDeletes().map(item => item.record); const pendingRestores = new Set(readPendingTrashRestores().map(item => item.record.id)); const merged = new Map([...cloud, ...pendingDeletes].filter(item => !pendingRestores.has(item.id)).map(item => [item.id, item])); setTrashItems([...merged.values()].sort((a,b) => b.deletedAt.localeCompare(a.deletedAt))) } catch { setSyncStatus('تعذر تحميل سلة المحذوفات') } }
  const logActivity = async (action: string, description: string, details = '', customerName = '') => { try { await recordActivity({ action, description, actor, actorEmail: user.email || '', createdAt: new Date().toISOString(), details, customerName }); if (showActivity) await refreshActivity() } catch { setSyncStatus('تم الحفظ لكن تعذر تسجيل النشاط') } }

  useEffect(() => {
    // Remove expired trash records whenever an authenticated session opens the ledger.
    void purgeExpiredTrash().catch(() => undefined)
  }, [user.uid])

  useEffect(() => {
    let active = true
    const markOffline = () => {
      if (!active) return
      setSyncStatus('غير متصل بالإنترنت')
    }
    const markOnline = () => {
      if (!active) return
      setSyncStatus('عاد الإنترنت، جارٍ مزامنة العمليات المعلّقة…')
      void flushPendingLedgerWrites().then(() => flushPendingEntityUpdates()).then(() => flushPendingTrashDeletes()).then(() => flushPendingTrashRestores()).then(() => {
        if (active) setSyncStatus('تمت مزامنة الإضافات المعلّقة؛ جارٍ تحديث الدفتر')
      }).catch(error => {
        const reason = error instanceof Error ? error.message : String(error)
        if (active) setSyncStatus(`فشلت المزامنة: ${reason}`)
      })
    }
    window.addEventListener('offline', markOffline)
    window.addEventListener('online', markOnline)
    if (!navigator.onLine) markOffline()
    else void flushPendingLedgerWrites().then(() => flushPendingEntityUpdates()).then(() => flushPendingTrashDeletes()).then(() => flushPendingTrashRestores()).catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      setSyncStatus(`فشلت مزامنة التعديلات: ${reason}`)
    })

    const applyLocalLedger = (localCustomers: Customer[], localEntries: Entry[]) => {
      // Keep queued offline edits visible when an older Firestore snapshot arrives.
      const pending = readPendingUpdates()
      const pendingDeletes = readPendingTrashDeletes().map(item => item.record)
      const pendingRestores = readPendingTrashRestores().map(item => item.record)
      const deletedCustomerIds = new Set(pendingDeletes.filter(item => item.entityType === 'customer').map(item => item.entity.id))
      const deletedEntryIds = new Set(pendingDeletes.filter(item => item.entityType === 'entry').map(item => item.entity.id))
      const mergedCustomers = localCustomers.filter(customer => !deletedCustomerIds.has(customer.id))
      const mergedEntries = localEntries.filter(entry => !deletedEntryIds.has(entry.id) && !deletedCustomerIds.has(entry.customerId))
      for (const item of pendingRestores) {
        if (item.entityType === 'customer' && !mergedCustomers.some(customer => customer.id === item.entity.id)) mergedCustomers.push(item.entity as Customer)
        if (item.entityType === 'entry' && !mergedEntries.some(entry => entry.id === item.entity.id)) mergedEntries.push(item.entity as Entry)
      }
      for (const item of pending) {
        if (item.entityType === 'customer') {
          const index = mergedCustomers.findIndex(row => row.id === item.entityId)
          if (index >= 0) mergedCustomers[index] = item.replacement as Customer
        } else {
          const index = mergedEntries.findIndex(row => row.id === item.entityId)
          if (index >= 0) mergedEntries[index] = item.replacement as Entry
        }
      }
      setCustomers(mergedCustomers)
      setEntries(mergedEntries)
      localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(mergedCustomers))
      localStorage.setItem(scopedKey('dd-entries'), JSON.stringify(mergedEntries))
    }

    const unsubscribe = watchSharedLedger(data => {
      if (!active) return
      // Firestore persistence serves its last cached snapshot while offline.
      // Never discard that snapshot just because the network is unavailable.
      if (!navigator.onLine) {
        if (data) {
          applyLocalLedger(data.customers as Customer[], data.entries as Entry[])
        } else {
          applyLocalLedger(load<Customer[]>('dd-customers', []), load<Entry[]>('dd-entries', []))
        }
        markOffline()
        return
      }
      if (data) {
        setStorageState(data.storageMode)
        applyLocalLedger(data.customers as Customer[], data.entries as Entry[])
        const pendingUpdates = readPendingUpdates()
        if (pendingUpdates.length > 0) {
          setSyncStatus(`متصل؛ يوجد ${pendingUpdates.length} تعديل معلّق لم تتم مزامنته بعد`)
        } else {
          setSyncStatus('متصل ومتزامن')
        }
      } else {
        const localCustomers = load<Customer[]>('dd-customers', [])
        const localEntries = load<Entry[]>('dd-entries', [])
        void saveSharedLedger(localCustomers, localEntries, user.uid).then(() => {
          if (!active) return
          setStorageState('normalized')
          applyLocalLedger(localCustomers, localEntries)
          setSyncStatus('تم رفع البيانات المحلية إلى السحابة')
        }).catch(() => {
          if (active) {
            setSyncStatus(navigator.onLine ? 'تعذر إنشاء الدفتر السحابي' : 'غير متصل بالإنترنت')
          }
        })
      }
    }, () => {
      if (active) {
        setSyncStatus(navigator.onLine ? 'فشل الاتصال بالسحابة' : 'غير متصل بالإنترنت')
      }
    })
    return () => {
      active = false
      window.removeEventListener('offline', markOffline)
      window.removeEventListener('online', markOnline)
      unsubscribe()
    }
  }, [user.uid])

  const persistCustomer = (customer: Customer) => {
    if (!requireEditableStorage()) return
    const next = [...customers, customer]
    setCustomers(next)
    localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(next))
    enqueueLedgerWrite({ id: customer.id, type: 'customer', value: customer, userId: user.uid })
    if (!navigator.onLine) {
      setSyncStatus('حُفظ الزبون محلياً، بانتظار عودة الإنترنت')
    } else {
      setSyncStatus('جارٍ حفظ الزبون ومزامنته…')
      void flushPendingLedgerWrites()
        .then(() => setSyncStatus('تمت مزامنة الإضافات المعلّقة'))
        .catch(() => setSyncStatus('تعذر تأكيد المزامنة؛ بقيت الإضافة محفوظة لإعادة المحاولة'))
    }
    void logActivity('إضافة زبون', `إضافة الزبون: ${customer.name}`, customer.phone, customer.name)
  }
  const persistEntry = (entry: Entry) => {
    if (!requireEditableStorage()) return
    const next = [...entries, entry]
    setEntries(next)
    localStorage.setItem(scopedKey('dd-entries'), JSON.stringify(next))
    enqueueLedgerWrite({ id: entry.id, type: 'entry', value: entry, userId: user.uid })
    if (!navigator.onLine) {
      setSyncStatus('حُفظت الحركة محلياً، بانتظار عودة الإنترنت')
    } else {
      setSyncStatus('جارٍ حفظ الحركة ومزامنتها…')
      void flushPendingLedgerWrites()
        .then(() => setSyncStatus('تمت مزامنة الإضافات المعلّقة'))
        .catch(() => setSyncStatus('تعذر تأكيد المزامنة؛ بقيت الإضافة محفوظة لإعادة المحاولة'))
    }
    void logActivity(entry.kind === 'debt' ? 'تسجيل دين' : 'تسجيل دفعة', `${entry.kind === 'debt' ? 'دين' : 'دفعة'} بقيمة ${money(entry.amount, entry.currency)}`, entry.note, customers.find(c => c.id === entry.customerId)?.name || 'زبون غير معروف')
  }
  const balances = useMemo(() => customers.map(c => {
    const rows = entries.filter(e => e.customerId === c.id)
    const balance = (cur: Currency) => rows.reduce((s, e) => s + (e.currency === cur ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)
    return { ...c, usd: balance('USD'), syp: balance('SYP') }
  }), [customers, entries])
  const totals = { usd: balances.reduce((s, c) => s + c.usd, 0), syp: balances.reduce((s, c) => s + c.syp, 0) }
  const shown = balances.filter(c => (filter === 'all' || c.usd > 0 || c.syp > 0) && (c.name.includes(query) || c.phone.includes(query)))
  const addCustomer = () => {
    if (!name.trim()) return
    persistCustomer({ id: createId(), name: name.trim(), phone: phone.trim(), createdAt: new Date().toISOString() })
    setName(''); setPhone(''); setModal(null)
  }
  const addEntry = () => {
    const n = Number(amount)
    if (!entryCustomerId || !Number.isFinite(n) || n <= 0) return
    if (kind === 'payment') {
      const current = entries.reduce((sum, e) => sum + (e.customerId === entryCustomerId && e.currency === currency ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)
      if (n > current) { setEntryError('قيمة الدفعة أكبر من الرصيد المستحق بهذه العملة.'); return }
    }
    setEntryError('')
    const savedEntry: Entry = { id: createId(), customerId: entryCustomerId, kind, amount: n, currency, note: note.trim(), actor, date: new Date().toISOString() }
    persistEntry(savedEntry)
    setAmount(''); setNote(''); setEntryError(''); setModal(null)
    setReminderOffer(savedEntry)
  }
  const runEntityUpdate = async (entityType: 'customer' | 'entry', replacement: Customer | Entry) => {
    if (!requireEditableStorage()) return false
    if (!editingOriginal || editingOriginal.id !== replacement.id) return false
    const operation: PendingEntityUpdate = { id: createId(), entityType, entityId: replacement.id, expected: editingOriginal, replacement, userId: user.uid }
    setEditBusy(true)
    try {
      if (navigator.onLine) {
        try {
          await updateSharedEntity(operation.id, entityType, replacement.id, editingOriginal, replacement, user.uid)
          setSyncStatus('تم حفظ التعديل ومزامنته')
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : ''
          const message = error instanceof Error ? error.message : String(error)
          const networkFailure = /unavailable|deadline-exceeded|network-request-failed|webchannel|offline|network|fetch|transport|timed? ?out|timeout|could not reach|failed to get document|connection/i.test(code + ' ' + message)
          if (!networkFailure) throw error
          // navigator.onLine can remain true when Wi-Fi/mobile data is disabled.
          // Keep the user's edit locally and retry it when connectivity returns.
          enqueueEntityUpdate(operation)
          const nextCustomers = entityType === 'customer' ? customers.map(item => item.id === replacement.id ? replacement as Customer : item) : customers
          const nextEntries = entityType === 'entry' ? entries.map(item => item.id === replacement.id ? replacement as Entry : item) : entries
          setCustomers(nextCustomers); setEntries(nextEntries)
          localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(nextCustomers))
          localStorage.setItem(scopedKey('dd-entries'), JSON.stringify(nextEntries))
          setSyncStatus('حُفظ التعديل محلياً؛ ينتظر عودة الاتصال والمزامنة')
        }
      } else {
        enqueueEntityUpdate(operation)
        const nextCustomers = entityType === 'customer' ? customers.map(item => item.id === replacement.id ? replacement as Customer : item) : customers
        const nextEntries = entityType === 'entry' ? entries.map(item => item.id === replacement.id ? replacement as Entry : item) : entries
        setCustomers(nextCustomers); setEntries(nextEntries)
        localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(nextCustomers))
        localStorage.setItem(scopedKey('dd-entries'), JSON.stringify(nextEntries))
        setSyncStatus('حُفظ التعديل على هذا الجهاز؛ ينتظر التحقق والمزامنة عند عودة الإنترنت')
      }
      return true
    } catch (error) {
      const info = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; name?: unknown } : null
      const code = info?.code == null ? '' : String(info.code)
      const message = info?.message == null ? String(error) : String(info.message)
      const detail = [info?.name ? String(info.name) : '', code, message].filter(Boolean).join(' | ')
      console.error('دفتر الديون: فشل حفظ التعديل', error)
      setSyncStatus(`فشل الحفظ [${code || 'بلا رمز'}]: ${message}`)
      window.alert(message.startsWith('ENTITY_CONFLICT') ? 'هذا السجل تغيّر على الجهاز الآخر. لم نعتمد تعديلك؛ حدّث البيانات وافتح التعديل من جديد.' : `تفاصيل خطأ الحفظ:\n${detail || 'خطأ غير معروف'}`)
      return false
    } finally { setEditBusy(false) }
  }
  const openCustomerEdit = () => {
    if (!selectedCustomer) return
    setEditingId(selectedCustomer.id); setEditingOriginal({ ...selectedCustomer }); setName(selectedCustomer.name); setPhone(selectedCustomer.phone)
    setSelected(''); setModal('editCustomer')
  }
  const saveCustomerEdit = async () => {
    if (!editingOriginal || !('name' in editingOriginal)) return
    const replacement: Customer = { ...editingOriginal, name: name.trim(), phone: phone.trim() }
    const ok = await runEntityUpdate('customer', replacement)
    if (ok) { void logActivity('تعديل زبون', `تعديل بيانات الزبون ${name.trim()}`); setModal(null); setName(''); setPhone(''); setEditingOriginal(null) }
  }
  const deleteCustomer = async () => {
    if (!requireEditableStorage()) return
    if (!selectedCustomer) return
    if (entries.some(e => e.customerId === selectedCustomer.id)) {
      window.alert('لا يمكن حذف زبون لديه حركات مالية. عالج حركاته أولاً.')
      return
    }
    if (!window.confirm('نقل هذا الزبون إلى سلة المحذوفات لمدة 10 أيام؟')) return
    setEditBusy(true)
    const target = selectedCustomer
    const now = new Date()
    const record: TrashRecord = { id: `customer-${target.id}`, entityType: 'customer', entity: target, deletedBy: actor, deletedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 86400000).toISOString() }
    try {
      enqueuePendingTrashDelete({ record, userId: user.uid })
      const nextCustomers = customers.filter(customer => customer.id !== target.id)
      setCustomers(nextCustomers); localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(nextCustomers)); setSelected('')
      await refreshTrash()
      if (navigator.onLine) await flushPendingTrashDeletes()
      void logActivity('نقل زبون إلى السلة', 'نقل الزبون ' + target.name + ' إلى سلة المحذوفات', '', target.name)
      setSyncStatus(navigator.onLine ? 'تم نقل الزبون إلى سلة المحذوفات' : 'حُفظ الحذف محلياً؛ ستتم مزامنته عند عودة الإنترنت')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (reason.includes('CUSTOMER_HAS_ENTRIES')) {
        localStorage.setItem(scopedKey(PENDING_TRASH_DELETES_KEY), JSON.stringify(readPendingTrashDeletes().filter(row => row.record.id !== record.id)))
        setCustomers(customers); localStorage.setItem(scopedKey('dd-customers'), JSON.stringify(customers))
        window.alert('لا يمكن حذف الزبون لأن لديه حركات مالية على الجهاز الآخر.')
      } else setSyncStatus('الحذف محفوظ محلياً؛ تعذرت المزامنة وستُعاد المحاولة عند الاتصال')
    } finally { setEditBusy(false) }
  }
  const openEntryEdit = (entry: Entry) => {
    setEditingId(entry.id); setEditingOriginal({ ...entry }); setKind(entry.kind); setAmount(String(entry.amount)); setCurrency(entry.currency); setNote(entry.note)
    setSelected(''); setModal('editEntry')
  }
  const saveEntryEdit = async () => {
    const n = Number(amount)
    const current = entries.filter(e => e.customerId === (entries.find(x => x.id === editingId)?.customerId) && e.currency === currency && e.id !== editingId)
      .reduce((sum, e) => sum + (e.kind === 'debt' ? e.amount : -e.amount), 0)
    const resultingBalance = current + (kind === 'debt' ? n : -n)
    if (!Number.isFinite(n) || n <= 0 || resultingBalance < 0) {
      window.alert(resultingBalance < 0 ? 'لا يمكن أن تصبح الدفعات أكبر من مجموع الديون.' : 'أدخل مبلغاً صحيحاً أكبر من صفر.')
      return
    }
    if (!editingOriginal || !('customerId' in editingOriginal)) return
    const replacement: Entry = { ...editingOriginal, kind, amount: n, currency, note: note.trim() }
    const ok = await runEntityUpdate('entry', replacement)
    if (ok) { const edited = editingOriginal; void logActivity('تعديل حركة', `تعديل ${kind === 'debt' ? 'دين' : 'دفعة'} بمبلغ ${money(n, currency)}`, note.trim(), customers.find(c => c.id === edited.customerId)?.name || 'زبون غير معروف'); setModal(null); setAmount(''); setNote(''); setEditingOriginal(null) }
  }
  const deleteEntry = async (id: string) => {
    if (!requireEditableStorage()) return
    if (!window.confirm('هل تريد حذف هذه الحركة؟ سيتم تحديث الرصيد تلقائياً.')) return
    const target = entries.find(e => e.id === id)
    if (!target) return
    setEditBusy(true)
    const customerName = customers.find(c => c.id === target.customerId)?.name || 'زبون غير معروف'
    const now = new Date()
    const record: TrashRecord = { id: `entry-${target.id}`, entityType: 'entry', entity: target, deletedBy: actor, deletedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 86400000).toISOString() }
    try {
      enqueuePendingTrashDelete({ record, userId: user.uid })
      const nextEntries = entries.filter(entry => entry.id !== id)
      setEntries(nextEntries); localStorage.setItem(scopedKey('dd-entries'), JSON.stringify(nextEntries))
      await refreshTrash()
      if (navigator.onLine) await flushPendingTrashDeletes()
      void logActivity('نقل حركة إلى السلة', 'نقل ' + (target.kind === 'debt' ? 'دين' : 'دفعة') + ' بقيمة ' + money(target.amount, target.currency) + ' إلى السلة', target.note, customerName)
      setSyncStatus(navigator.onLine ? 'تم نقل الحركة إلى سلة المحذوفات' : 'حُفظ الحذف محلياً؛ ستتم مزامنته عند عودة الإنترنت')
    } catch { setSyncStatus('الحذف محفوظ محلياً؛ تعذرت المزامنة وستُعاد المحاولة عند الاتصال') }
    finally { setEditBusy(false) }
  }
  const restoreTrashItem = async (item: TrashRecord) => {
    if (!requireEditableStorage()) return
    if (new Date(item.expiresAt).getTime() <= Date.now()) { window.alert('انتهت مهلة الاستعادة لهذا العنصر.'); return }
    if (!window.confirm('هل تريد استعادة هذا العنصر إلى الدفتر؟')) return
    setEditBusy(true)
    const operationId = createId()
    const queued: PendingTrashRestore = { id: operationId, record: item, userId: user.uid }
    try {
      enqueuePendingTrashRestore(queued)
      setTrashItems(current => current.filter(row => row.id !== item.id))
      if (item.entityType === 'customer') {
        const customer = item.entity as Customer
        setCustomers(current => current.some(row => row.id === customer.id) ? current : [...current, customer])
      } else {
        const entry = item.entity as Entry
        setEntries(current => current.some(row => row.id === entry.id) ? current : [...current, entry])
      }
      await refreshTrash()
      if (navigator.onLine) await flushPendingTrashRestores()
      const customerName = item.entityType === 'customer' ? (item.entity as Customer).name : customers.find(c => c.id === (item.entity as Entry).customerId)?.name || 'زبون غير معروف'
      void logActivity('استعادة من سلة المحذوفات', 'استعادة عنصر للزبون ' + customerName, '', customerName)
      setSyncStatus(navigator.onLine ? 'تمت استعادة العنصر' : 'تمت الاستعادة محلياً؛ ستتم مزامنتها عند عودة الإنترنت')
    } catch (error) {
      setSyncStatus('الاستعادة محفوظة محلياً؛ تعذرت المزامنة وستُعاد المحاولة عند الاتصال')
      window.alert(error instanceof Error && error.message === 'TRASH_ITEM_EXPIRED' ? 'انتهت مهلة الاستعادة لهذا العنصر.' : 'تعذرت مزامنة الاستعادة الآن؛ بقي الطلب محفوظاً على هذا الجهاز.')
    } finally { setEditBusy(false) }
  }
  const selectedCustomer = customers.find(c => c.id === selected)
  const customerRows = entries.filter(e => e.customerId === selected).sort((a,b) => b.date.localeCompare(a.date))
  const balanceFor = (cur: Currency) => customerRows.reduce((s,e) => s + (e.currency === cur ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)

  const buildCustomerStatementHtml = (): string | null => {
    if (!selectedCustomer) return null
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char] || char)
    const chronological = [...customerRows].sort((a, b) => a.date.localeCompare(b.date))
    const totals = chronological.reduce((result, entry) => {
      const bucket = entry.currency === 'USD' ? result.USD : result.SYP
      if (entry.kind === 'debt') bucket.debt += entry.amount
      else bucket.paid += entry.amount
      return result
    }, {
      USD: { debt: 0, paid: 0 },
      SYP: { debt: 0, paid: 0 },
    })
    let runningUSD = 0
    let runningSYP = 0
    const rows = chronological.map(entry => {
      const delta = entry.kind === 'debt' ? entry.amount : -entry.amount
      if (entry.currency === 'USD') runningUSD += delta
      else runningSYP += delta
      return `<tr>
        <td>${escapeHtml(new Date(entry.date).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' }))}</td>
        <td><span class="type ${entry.kind === 'debt' ? 'debt' : 'payment'}">${entry.kind === 'debt' ? 'دين' : 'دفعة'}</span></td>
        <td>${escapeHtml(entry.note || '—')}</td>
        <td>${escapeHtml(entry.actor || '—')}</td>
        <td class="amount">${entry.kind === 'debt' ? '+' : '−'}${escapeHtml(money(entry.amount, entry.currency))}</td>
        <td class="amount">${escapeHtml(money(runningUSD, 'USD'))}</td>
        <td class="amount">${escapeHtml(money(runningSYP, 'SYP'))}</td>
      </tr>`
    }).join('')
    const generatedAt = new Date().toLocaleString('ar', { dateStyle: 'full', timeStyle: 'short' })
    const firstDate = chronological[0]?.date
    const lastDate = chronological[chronological.length - 1]?.date
    const period = firstDate && lastDate
      ? `من ${new Date(firstDate).toLocaleDateString('ar')} إلى ${new Date(lastDate).toLocaleDateString('ar')}`
      : 'لا توجد حركات مسجلة'
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف حساب - ${escapeHtml(selectedCustomer.name)}</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:Tahoma,Arial,sans-serif;color:#172033;margin:28px;direction:rtl;text-align:right;background:#fff;line-height:1.7}
        .page{max-width:1200px;margin:auto}
        .brand{display:flex;align-items:center;gap:12px}
        .brandmark{width:46px;height:46px;border-radius:13px;background:#20385f;color:#fff;display:grid;place-items:center;font-size:25px;font-weight:700}
        .brand h1{font-size:24px;margin:0}.brand p{margin:4px 0 0;color:#64748b;font-size:12px}
        .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:3px solid #20385f;padding-bottom:17px}
        .doc-title{text-align:left}.doc-title h2{font-size:20px;margin:0 0 7px}.doc-title p,.customer p{margin:5px 0;color:#526078;font-size:12px}
        .customer{margin:18px 0;padding:13px 16px;background:#f5f7fb;border:1px solid #e1e7f0;border-radius:10px}
        .customer strong{font-size:16px}.customer p{margin-top:7px}
        .section-title{font-size:15px;margin:20px 0 10px;line-height:1.8;break-after:avoid;page-break-after:avoid}
        .currency-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;break-inside:avoid;page-break-inside:avoid}
        .currency-card{border:1px solid #dce3ed;border-radius:11px;overflow:hidden;break-inside:avoid}
        .currency-head{background:#edf2f8;padding:10px 14px;font-weight:700;color:#20385f}
        .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px}
        .metric{padding:9px 7px;background:#fafbfd;border-radius:8px;min-width:0}
        .metric small{display:block;color:#64748b;font-size:10px;margin-bottom:7px}
        .metric strong{font-size:14px;overflow-wrap:anywhere}
        .metric.balance{background:#eef5f0}.metric.balance strong{color:#17643a}
        .table-wrap{width:100%;overflow:visible;direction:rtl}
        table{width:100%;table-layout:fixed;border-collapse:collapse;margin-top:10px;font-size:10px;line-height:1.7;direction:rtl}
        th,td{border:1px solid #dce2ea;padding:8px 6px;text-align:right;vertical-align:middle;overflow-wrap:anywhere;word-break:normal;line-height:1.7}th:nth-child(1){width:15%}th:nth-child(2){width:7%}th:nth-child(3){width:24%}th:nth-child(4){width:10%}th:nth-child(5){width:12%}th:nth-child(6){width:16%}th:nth-child(7){width:16%}td:nth-child(3){white-space:normal;overflow-wrap:anywhere}
        th{background:#edf2f8;color:#263a59;font-weight:700;white-space:normal}
        thead{display:table-header-group}thead tr{break-inside:avoid;page-break-inside:avoid}tbody tr{break-inside:avoid;page-break-inside:avoid}tbody tr:nth-child(even){background:#fafbfd}
        .amount{white-space:nowrap;font-weight:600;font-size:9.5px;direction:ltr;text-align:right}
        .type{display:inline-block;padding:3px 7px;border-radius:20px;font-weight:700}
        .type.debt{background:#fff0ef;color:#a3322b}.type.payment{background:#eaf6ee;color:#17643a}
        .empty{text-align:center;color:#64748b;padding:22px;border:1px dashed #cbd5e1;border-radius:8px}
        .signatures{display:grid;grid-template-columns:1fr 1fr;gap:35px;margin-top:14px;break-inside:avoid;page-break-inside:avoid}
        .signature{border-top:1px solid #9aa7b8;padding-top:9px;text-align:center;color:#526078;font-size:11px}
        .footer{border-top:1px solid #e1e7f0;margin-top:8px;padding-top:5px;display:flex;justify-content:space-between;gap:15px;color:#64748b;font-size:10px}
        @page{size:A4 landscape;margin:12mm}
        @media print{body{margin:0}.page{max-width:none}.customer,.currency-grid,.currency-card{break-inside:avoid;page-break-inside:avoid}.section-title{break-after:avoid;page-break-after:avoid}.table-wrap{overflow:visible}table{break-inside:auto;page-break-inside:auto}thead{display:table-header-group}tbody{display:table-row-group}tr{break-inside:avoid;page-break-inside:avoid}.signatures,.footer{break-inside:avoid;page-break-inside:avoid}button{display:none}}
        @media screen and (max-width:700px){body{margin:12px}.top{flex-direction:column}.doc-title{text-align:right}.currency-grid{grid-template-columns:1fr}.metrics{gap:5px}.metric strong{font-size:12px}.table-wrap{overflow-x:auto}table{min-width:850px}}
      </style></head><body><main class="page">
      <header class="top">
        <div class="brand"><div class="brandmark">د</div><div><h1>دفتر الديون</h1><p>إدارة الحسابات والذمم المالية</p></div></div>
        <div class="doc-title"><h2>كشف حساب زبون</h2><p>تاريخ الإصدار: <b>${escapeHtml(generatedAt)}</b></p><p>فترة الحركات: <b>${escapeHtml(period)}</b></p></div>
      </header>
      <section class="customer"><strong>${escapeHtml(selectedCustomer.name)}</strong><p>رقم الهاتف: ${escapeHtml(selectedCustomer.phone || 'غير مسجل')}</p><p>عدد الحركات: ${chronological.length}</p></section>
      <h3 class="section-title">ملخص الحساب</h3>
      <section class="currency-grid">
        <div class="currency-card"><div class="currency-head">الحساب بالدولار الأمريكي</div><div class="metrics">
          <div class="metric"><small>إجمالي الديون</small><strong>${escapeHtml(money(totals.USD.debt, 'USD'))}</strong></div>
          <div class="metric"><small>إجمالي المدفوعات</small><strong>${escapeHtml(money(totals.USD.paid, 'USD'))}</strong></div>
          <div class="metric balance"><small>الرصيد النهائي</small><strong>${escapeHtml(money(balanceFor('USD'), 'USD'))}</strong></div>
        </div></div>
        <div class="currency-card"><div class="currency-head">الحساب بالليرة السورية</div><div class="metrics">
          <div class="metric"><small>إجمالي الديون</small><strong>${escapeHtml(money(totals.SYP.debt, 'SYP'))}</strong></div>
          <div class="metric"><small>إجمالي المدفوعات</small><strong>${escapeHtml(money(totals.SYP.paid, 'SYP'))}</strong></div>
          <div class="metric balance"><small>الرصيد النهائي</small><strong>${escapeHtml(money(balanceFor('SYP'), 'SYP'))}</strong></div>
        </div></div>
      </section>
      <h3 class="section-title">تفاصيل الحركات المالية</h3>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>البيان / الملاحظة</th><th>المسؤول</th><th>قيمة الحركة</th><th>الرصيد بالدولار بعد الحركة</th><th>الرصيد بالليرة بعد الحركة</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">لا توجد حركات مسجلة لهذا الزبون حتى تاريخ إصدار الكشف.</div>'}
      <section class="signatures"><div class="signature">توقيع المسؤول</div><div class="signature">توقيع الزبون</div></section>
      <footer class="footer"><span>تم إنشاء هذا الكشف من نظام دفتر الديون.</span><span>كشف حساب تفصيلي — ${escapeHtml(selectedCustomer.name)}</span></footer>
      </main></body></html>`
  }
  const exportCustomerStatement = () => {
    const html = buildCustomerStatementHtml()
    if (!html) return
    const popup = window.open('', '_blank', 'width=1100,height=800')
    if (!popup) {
      window.alert('المتصفح منع فتح نافذة الكشف. اسمح بالنوافذ المنبثقة لهذا الموقع ثم حاول مجدداً.')
      return
    }
    popup.document.write(html)
    popup.document.close()
    window.setTimeout(() => popup.print(), 500)
  }

  const shareCustomerStatementPdf = async () => {
    const html = buildCustomerStatementHtml()
    if (!html || !selectedCustomer) return
    const safeName = selectedCustomer.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'customer'
    const fileName = `كشف-حساب-${safeName}.pdf`
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.position = 'fixed'
    frame.style.left = '-12000px'
    frame.style.top = '0'
    frame.style.width = '1200px'
    frame.style.height = '1600px'
    frame.style.border = '0'
    document.body.appendChild(frame)
    try {
      const frameDoc = frame.contentDocument
      if (!frameDoc) throw new Error('تعذر تجهيز صفحة كشف الحساب')
      frameDoc.open()
      frameDoc.write(html)
      frameDoc.close()
      await new Promise(resolve => window.setTimeout(resolve, 350))
      // @ts-ignore html2pdf.js ships without TypeScript declarations.
      const pdfModule = await import('html2pdf.js')
      const html2pdf = (pdfModule as any).default || pdfModule
      const pdfBlob: Blob = await html2pdf().set({
        margin: [10, 10, 10, 10],
        filename: fileName,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollY: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
        pagebreak: { mode: ['css', 'legacy'] },
      }).from(frameDoc.body).outputPdf('blob')
      const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' })
      const shareApi = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean
        share?: (data: ShareData) => Promise<void>
      }
      if (shareApi.share && shareApi.canShare?.({ files: [pdfFile] })) {
        try {
          await shareApi.share({ files: [pdfFile], title: 'كشف حساب - ' + selectedCustomer.name, text: 'كشف حساب من دفتر الديون' })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return
          throw error
        }
      } else {
        const url = URL.createObjectURL(pdfBlob)
        const link = document.createElement('a')
        link.href = url
        link.download = fileName
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
        window.alert('تم تنزيل ملف PDF. افتح WhatsApp وأرفق الملف من التنزيلات.')
      }
    } catch (error) {
      console.error('PDF sharing failed:', error)
      window.alert('تعذر إنشاء أو مشاركة ملف PDF. جرّب تنزيل الكشف من زر الطباعة، أو افتح التطبيق عبر اتصال آمن HTTPS على الهاتف.')
    } finally {
      frame.remove()
    }
  }

  const sendEntryWhatsAppReminder = (entry: Entry) => {
    const customer = customers.find(c => c.id === entry.customerId)
    if (!customer) return
    const rawPhone = customer.phone.trim()
    let phoneDigits = rawPhone.replace(/\D/g, '')
    if (rawPhone.startsWith('00')) phoneDigits = phoneDigits.slice(2)
    else if (!rawPhone.startsWith('+')) {
      window.alert('اكتب رقم الهاتف مع مفتاح الدولة أولاً، مثل +90 أو +963، ثم جرّب إرسال التذكير.')
      return
    }
    if (phoneDigits.length < 8 || phoneDigits.length > 15) {
      window.alert('رقم الهاتف غير صالح. استخدم الرقم الدولي مع مفتاح الدولة.')
      return
    }
    const amountLine = money(entry.amount, entry.currency)
    const noteLine = entry.note.trim() ? '\nالملاحظة: ' + entry.note.trim() : ''
    const message = 'مرحباً ' + customer.name + '،\n' +
      (entry.kind === 'debt' ? 'تم تسجيل دين جديد بقيمة ' : 'تم تسجيل دفعة بقيمة ') +
      amountLine + '.' + noteLine + '\nشكراً لكم.'
    const url = 'https://wa.me/' + phoneDigits + '?text=' + encodeURIComponent(message)
    window.open(url, '_blank', 'noopener,noreferrer')
    setReminderOffer(null)
  }

  const sendWhatsAppReminder = () => {
    if (!selectedCustomer) return
    const rawPhone = selectedCustomer.phone.trim()
    let phoneDigits = rawPhone.replace(/\D/g, '')
    if (rawPhone.startsWith('00')) phoneDigits = phoneDigits.slice(2)
    else if (!rawPhone.startsWith('+')) {
      window.alert('اكتب رقم الهاتف مع مفتاح الدولة أولاً، مثل +90 أو +963، ثم جرّب إرسال التذكير.')
      return
    }
    if (phoneDigits.length < 8 || phoneDigits.length > 15) {
      window.alert('رقم الهاتف غير صالح. استخدم الرقم الدولي مع مفتاح الدولة.')
      return
    }
    const usd = balanceFor('USD')
    const syp = balanceFor('SYP')
    if (usd <= 0 && syp <= 0) {
      window.alert('لا يوجد رصيد مستحق لهذا الزبون لإرسال تذكير بشأنه.')
      return
    }
    const amounts = [usd > 0 ? '• ' + money(usd, 'USD') : '', syp > 0 ? '• ' + money(syp, 'SYP') : ''].filter(Boolean).join('\\n')
    const message = 'مرحباً ' + selectedCustomer.name + '،\\nنذكّركم بلطف بأن لديكم رصيداً مستحقاً في دفتر الحسابات:\\n' + amounts + '\\nيرجى التواصل معنا لتسوية الحساب. شكراً لكم.'
    const url = 'https://wa.me/' + phoneDigits + '?text=' + encodeURIComponent(message)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const runSecureMigration = async () => {
    if (memberRole !== 'owner') { window.alert('ترحيل البيانات متاح للمالك فقط.'); return }
    const pendingCount = readPendingWrites().length + readPendingUpdates().length + readPendingTrashDeletes().length + readPendingTrashRestores().length
    if (pendingCount > 0) {
      window.alert(`توجد ${pendingCount} عملية معلّقة على هذا الجهاز. اتصل بالإنترنت وانتظر مزامنتها قبل الترحيل.`)
      return
    }
    if (!window.confirm('سيتم نسخ الزبائن والحركات والنشاطات وسلة المحذوفات إلى التخزين الجديد. ستبقى البيانات القديمة محفوظة دون حذف. هل تريد المتابعة؟')) return
    setMigrationBusy(true)
    try {
      const counts = await migrateLegacyLedger(user.uid, customers, entries)
      setStorageState('normalized')
      setSyncStatus('اكتمل نقل الدفتر إلى التخزين الآمن')
      window.alert(`اكتمل الترحيل بنجاح.\nالزبائن: ${counts.customers}\nالحركات: ${counts.entries}\nالنشاطات: ${counts.activities}\nالمحذوفات: ${counts.trash}\n\nاحتفظنا بالبيانات القديمة دون حذف.`)
    } catch (error) {
      console.error('فشل ترحيل الدفتر', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`لم يكتمل الترحيل. لم نحذف البيانات القديمة.\nالتفاصيل: ${message}`)
    } finally { setMigrationBusy(false) }
  }

  return <main className="app">
    <header className="topbar"><div><img className="brandmark" src="/icon-192.png" alt="أيقونة دفتر الديون"/><div><h1>دفتر الديون</h1><p>دفترك واضح… وحساباتك محفوظة</p></div></div><span className="actor">الحساب: {user.email || user.uid}</span></header>
    {showTrash ? <section className="panel activity-page">
      <div className="panel-head"><div><h2>سلة المحذوفات</h2><p>يمكن استعادة العناصر خلال 10 أيام من تاريخ الحذف</p></div><button className="outline" onClick={() => void refreshTrash()}>تحديث</button></div>
      
      {trashItems.length ? <div className="customer-list">{trashItems.map(item => { const expired = new Date(item.expiresAt).getTime() <= Date.now(); const label = item.entityType === 'customer' ? (item.entity as Customer).name : ((item.entity as Entry).kind === 'debt' ? 'دين ' : 'دفعة ') + (item.entity as Entry).amount + ' ' + (item.entity as Entry).currency; return <article className="entry activity-row" key={item.id}><span className="entry-info"><b>{label}</b><small>{item.entityType === 'customer' ? 'زبون' : 'حركة مالية'} · حُذف بواسطة: {item.deletedBy}</small><small>تاريخ النقل: {new Date(item.deletedAt).toLocaleString('ar')}</small><small>{expired ? 'انتهت مهلة الاستعادة' : 'آخر موعد للاستعادة: ' + new Date(item.expiresAt).toLocaleString('ar')}</small></span><button className="outline" disabled={!canEditNow || editBusy || expired} onClick={() => void restoreTrashItem(item)}><RotateCcw size={15}/> استعادة</button></article> })}</div> : <div className="empty compact">سلة المحذوفات فارغة</div>}
    </section> : showActivity ? <section className="panel activity-page">
      <div className="panel-head"><div><h2>سجل النشاطات</h2><p>كل العمليات التي تمت على دفتر الديون، مع اسم الزبون ووقت العملية</p></div><button className="outline" onClick={() => void refreshActivity()}>تحديث</button></div>
      
      {activities.length ? <div className="customer-list">{activities.map(item => <article className="entry activity-row" key={item.id}>
        <span className="entry-info"><b>{item.action} — {item.description}</b><small>الزبون: {item.customerName || 'غير محدد'}</small><small>{item.actor} · {item.actorEmail} · {new Date(item.createdAt).toLocaleString('ar')}</small>{item.details && <small>ملاحظات: {item.details}</small>}</span>
      </article>)}</div> : <div className="empty compact">لا توجد نشاطات مسجلة بعد</div>}
    </section> : showSettings ? <section className="panel settings-page"><div className="panel-head"><div><h2>الإعدادات</h2><p>إدارة أمان الدفتر والنسخ الاحتياطية والحساب</p></div></div><div className="settings-group"><h3>المظهر</h3><p className="settings-hint">اختر شكل التطبيق.</p><div className="settings-actions"><button className={theme === 'light' ? 'primary' : 'outline'} onClick={() => setTheme('light')}>فاتح</button><button className={theme === 'dark' ? 'primary' : 'outline'} onClick={() => setTheme('dark')}>داكن</button></div></div><div className="settings-group"><h3>الأمان</h3><button className="outline full" onClick={() => setShowPinSettings(true)}><ShieldCheck size={17}/> أمان القفل وPIN</button><p className="settings-hint">قفل مستقل لهذا الجهاز فقط.</p></div><div className="settings-group"><h3>الصلاحيات والتخزين</h3><p className="settings-hint">دورك الحالي: {memberRole === 'owner' ? 'المالك' : memberRole === 'editor' ? 'محرر' : 'مشاهد'}</p><p className="settings-hint">حالة التخزين: {storageState === 'normalized' ? 'التخزين المنظم الجديد' : storageState === 'legacy' ? 'التخزين القديم — بانتظار الترحيل' : 'دفتر جديد فارغ'}</p>{memberRole === 'owner' && storageState !== 'normalized' && <button className="primary full" disabled={migrationBusy} onClick={() => void runSecureMigration()}>{migrationBusy ? 'جارٍ ترحيل البيانات…' : 'ترحيل الدفتر إلى التخزين الآمن'}</button>}{memberRole !== 'owner' && storageState === 'legacy' && <p className="form-error">الدفتر بانتظار ترحيل المالك إلى التخزين الآمن. يمكنك الاطلاع على البيانات، وستُفعّل الكتابة بعد اكتمال الترحيل.</p>}</div><div className="settings-group"><h3>النسخ الاحتياطي</h3><div className="settings-actions"><button className="outline" disabled={backupBusy} onClick={() => void downloadBackup()}><Download size={16}/> تنزيل نسخة احتياطية</button>{memberRole === 'owner' && <button className="outline" disabled={backupBusy} onClick={() => backupInput.current?.click()}><Upload size={16}/> استعادة نسخة</button>}<input ref={backupInput} type="file" accept=".json,application/json" hidden onChange={e => void importBackup(e.target.files?.[0])}/></div></div><div className="settings-group"><h3>إدارة الدفتر</h3><button className="outline full" onClick={() => {setShowTrash(true);setShowSettings(false);void refreshTrash()}}><Archive size={16}/> سلة المحذوفات</button><p className="settings-hint">الحساب: {user.email || user.uid}</p></div><div className="settings-group"><h3>الحساب</h3><button className="outline full" onClick={() => signOut(auth)}>تسجيل الخروج</button></div></section> : <>
    {storageState === 'legacy' && <section className="panel"><p className="form-error">هذا الدفتر يستخدم التخزين القديم. الكتابة متوقفة مؤقتًا حتى ينفّذ المالك الترحيل إلى التخزين المنظم. البيانات القديمة لم تُحذف.</p>{memberRole === 'owner' && <button className="primary full" disabled={migrationBusy} onClick={() => setShowSettings(true)}>فتح إعدادات الترحيل</button>}</section>}
    <section className="welcome"><div><span className="eyebrow">لوحة الحسابات</span><h2>أهلاً بك 👋</h2><p>تابع ديون زبائنك ودفعاتهم من مكان واحد.</p></div><div className="date">{new Intl.DateTimeFormat('ar', {dateStyle:'full'}).format(new Date())}</div></section>
    <section className="stats">
      <article className="stat"><span className="stat-icon blue"><Wallet size={20}/></span><p>إجمالي الديون بالدولار</p><strong>{money(totals.usd,'USD')}</strong></article>
      <article className="stat"><span className="stat-icon green"><Wallet size={20}/></span><p>إجمالي الديون بالليرة</p><strong>{money(totals.syp,'SYP')}</strong></article>
      <article className="stat"><span className="stat-icon amber"><Users size={20}/></span><p>الزبائن عليهم رصيد</p><strong>{balances.filter(c => c.usd > 0 || c.syp > 0).length}</strong></article>
    </section>
    <section className="actions"><button className="primary" disabled={!canEditNow} onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('debt'); setEntryError(''); setModal('entry')}}><Plus size={18}/> تسجيل دين</button><button className="success" disabled={!canEditNow} onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('payment'); setEntryError(''); setModal('entry')}}><ArrowDownLeft size={18}/> تسجيل دفعة</button></section>
    <section className="panel"><div className="panel-head"><div><h3>الزبائن</h3><p>كل حساباتك في قائمة واحدة</p></div><div className="tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>الكل</button><button className={filter==='owing'?'active':''} onClick={()=>setFilter('owing')}>عليهم ديون</button></div></div>
      <div className="customer-tools"><button className="outline" disabled={!canEditNow} onClick={() => setModal('customer')}><Users size={18}/> إضافة زبون</button><button className="outline" disabled={!canEditNow || contactsBusy} onClick={() => void importPhoneContacts()}><Users size={18}/> {contactsBusy ? 'جارٍ الاستيراد…' : 'استيراد'}</button></div><div className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث باسم الزبون أو رقم الهاتف"/></div>
      {shown.length ? <div className="customer-list">{shown.map(c=><button className="customer" key={c.id} onClick={()=>{if(!modal)setSelected(c.id)}} disabled={modal !== null}><span className="avatar">{c.name.slice(0,1)}</span><span className="customer-info"><b>{c.name}</b><small>{c.phone || 'لا يوجد رقم هاتف'}</small></span><span className="customer-bal"><b>{money(c.usd,'USD')}</b><small>{money(c.syp,'SYP')}</small></span><span className="chevron">‹</span></button>)}</div> : <div className="empty"><Users size={30}/><b>ما في زبائن بهالقائمة</b><span>أضف أول زبون وابدأ تسجيل الحسابات.</span><button disabled={!canEditNow} onClick={()=>setModal('customer')}>إضافة زبون</button></div>}
    </section>
    {showActivity && <section className="panel activity-panel"><div className="panel-head"><div><h3>سجل النشاطات</h3><p>آخر العمليات التي سجلها المستخدمون</p></div><button className="outline" onClick={() => void refreshActivity()}>تحديث</button></div>{activities.length ? activities.map(item => <div className="entry" key={item.id}><span className="entry-info"><b>{item.action} — {item.description}</b><small>{item.actor} · {item.actorEmail} · {new Date(item.createdAt).toLocaleString('ar')}</small>{item.details && <small>{item.details}</small>}</span></div>) : <div className="empty compact">لا توجد نشاطات مسجلة بعد</div>}</section>}

    <footer><span>مسجل الدخول: {user.email}</span><span>{syncStatus}</span></footer>

    </>}
    <nav className="bottom-nav"><button className={!showActivity && !showSettings && !showTrash ? 'active' : ''} onClick={() => {setShowActivity(false);setShowSettings(false);setShowTrash(false)}}><Wallet size={19}/><span>الرئيسية</span></button><button className={showActivity ? 'active' : ''} onClick={() => {setShowActivity(true);setShowSettings(false);setShowTrash(false);void refreshActivity()}}><Activity size={19}/><span>النشاطات</span></button><button className={showSettings || showTrash ? 'active' : ''} onClick={() => {setShowActivity(false);setShowSettings(true);setShowTrash(false)}}><Settings size={19}/><span>الإعدادات</span></button></nav>
    {showPinSettings && <PinSettings onClose={() => setShowPinSettings(false)} onPinStateChange={onPinStateChange} />}
    {!showActivity && !showTrash && modal && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="dialog"><button className="close" onClick={()=>setModal(null)}><X/></button><h3>{modal==='customer'?'إضافة زبون جديد':modal==='editCustomer'?'تعديل بيانات الزبون':modal==='editEntry'?'تعديل الحركة':kind==='debt'?'تسجيل دين جديد':'تسجيل دفعة'}</h3>
      {modal==='customer' || modal==='editCustomer' ? <><label>اسم الزبون<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="مثلاً: أحمد محمد"/></label><label>رقم الهاتف (اختياري)<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="05xxxxxxxx"/></label><button className="primary full" disabled={!canEditNow || !name.trim() || editBusy} onClick={modal==='customer'?addCustomer:saveCustomerEdit}><Check size={18}/> {modal==='customer'?'حفظ الزبون':'حفظ التعديلات'}</button></> :
      modal==='editEntry' ? <><label>نوع الحركة<select value={kind} onChange={e=>setKind(e.target.value as 'debt'|'payment')}><option value="debt">دين</option><option value="payment">دفعة</option></select></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة<input value={note} onChange={e=>setNote(e.target.value)}/></label><button className="primary full" disabled={!canEditNow || editBusy || !(Number(amount)>0)} onClick={saveEntryEdit}><Check size={18}/> حفظ التعديلات</button></> : <><label>الزبون<select value={entryCustomerId} onChange={e=>setEntryCustomerId(e.target.value)}><option value="">اختر الزبون</option>{customers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>{entryError && <p className="form-error">{entryError}</p>}<div className="switch"><button className={kind==='debt'?'chosen':''} onClick={()=>setKind('debt')}><ArrowUpRight size={17}/> دين</button><button className={kind==='payment'?'chosen':''} onClick={()=>setKind('payment')}><ArrowDownLeft size={17}/> دفعة</button></div><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة (اختياري)<input value={note} onChange={e=>setNote(e.target.value)} placeholder="تفاصيل العملية"/></label><button className={kind==='debt'?'primary full':'success full'} disabled={!canEditNow || !entryCustomerId || !(Number(amount)>0)} onClick={addEntry}><Check size={18}/> حفظ العملية</button></>}
    </section></div>}
    {reminderOffer && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setReminderOffer(null)}}><section className="dialog">
      <button className="close" onClick={()=>setReminderOffer(null)}><X/></button>
      <h3>تم حفظ العملية بنجاح</h3>
      <p>هل تريد تذكير الزبون عبر WhatsApp الآن؟</p>
      <p><b>{customers.find(c=>c.id===reminderOffer.customerId)?.name || 'الزبون'}</b> · {reminderOffer.kind==='debt'?'دين':'دفعة'} · {money(reminderOffer.amount, reminderOffer.currency)}</p>
      {reminderOffer.note && <p>الملاحظة: {reminderOffer.note}</p>}
      <button className="success full" onClick={()=>sendEntryWhatsAppReminder(reminderOffer)}><MessageCircle size={17}/> اضغط لتذكير عبر WhatsApp</button>
      <button className="outline full" onClick={()=>setReminderOffer(null)}>لاحقاً</button>
    </section></div>}
    {!showActivity && !showTrash && selectedCustomer && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSelected('')}}><section className="dialog detail"><button className="close" onClick={()=>setSelected('')}><X/></button><div className="detail-person"><span className="avatar big">{selectedCustomer.name.slice(0,1)}</span><div><h3>{selectedCustomer.name}</h3><p>{selectedCustomer.phone || 'لا يوجد رقم هاتف'}</p></div></div><div className="customer-actions"><button className="success" onClick={shareCustomerStatementPdf}><MessageCircle size={15}/> مشاركة PDF على WhatsApp</button><button className="outline" onClick={exportCustomerStatement}><FileText size={15}/> كشف حساب PDF</button><button className="success" onClick={sendWhatsAppReminder}><MessageCircle size={15}/> تذكير WhatsApp</button><button className="outline" disabled={!canEditNow} onClick={openCustomerEdit}><Pencil size={15}/> تعديل بيانات الزبون</button><button className="outline danger-action" disabled={!canEditNow} onClick={deleteCustomer}><Trash2 size={15}/> حذف الزبون</button></div><div className="detail-bal"><div><small>الرصيد بالدولار</small><b>{money(balanceFor('USD'),'USD')}</b></div><div><small>الرصيد بالليرة</small><b>{money(balanceFor('SYP'),'SYP')}</b></div></div><div className="detail-head"><b>سجل الحركات</b><button disabled={!canEditNow} onClick={()=>{setKind('debt');setEntryError('');setEntryCustomerId(selectedCustomer.id);setSelected('');setModal('entry')}}><Plus size={16}/> حركة جديدة</button></div>{customerRows.length ? customerRows.map(e=><div className="entry" key={e.id}><span className={e.kind==='debt'?'debt-dot':'pay-dot'}>{e.kind==='debt'?<ArrowUpRight size={16}/>:<ArrowDownLeft size={16}/>}</span><span className="entry-info"><b>{e.kind==='debt'?'دين':'دفعة'}{e.note?' – '+e.note:''}</b><small>{new Date(e.date).toLocaleString('ar')} · {e.actor}</small></span><strong className={e.kind==='debt'?'red':'green-text'}>{e.kind==='debt'?'+':'−'}{money(e.amount,e.currency)}</strong><div className="entry-actions"><button className="outline" disabled={!canEditNow} onClick={()=>openEntryEdit(e)}><Pencil size={13}/> تعديل</button><button className="outline danger-action" disabled={!canEditNow} onClick={()=>deleteEntry(e.id)}><Trash2 size={13}/> حذف</button></div></div>) : <div className="empty compact">لا توجد حركات مسجلة بعد</div>}</section></div>}
  </main>
}

const DEVICE_PIN_KEY = 'dd-device-pin-v1'

const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = (value: string) => new Uint8Array(value.match(/.{1,2}/g)?.map(part => parseInt(part, 16)) || [])

async function derivePinHash(pin: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const saltBuffer = new ArrayBuffer(salt.byteLength)
  new Uint8Array(saltBuffer).set(salt)
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBuffer, iterations: 210000, hash: 'SHA-256' }, key, 256)
  return toHex(new Uint8Array(bits))
}

function PinSettings({ onClose, onPinStateChange }: { onClose: () => void; onPinStateChange: (enabled: boolean) => void }) {
  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [action, setAction] = useState<'change' | 'disable' | 'enable'>(() => localStorage.getItem(DEVICE_PIN_KEY) ? 'change' : 'enable')
  const hasSavedPin = Boolean(localStorage.getItem(DEVICE_PIN_KEY))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const saved = localStorage.getItem(DEVICE_PIN_KEY)
      if (action !== 'enable') {
        if (!saved) { setAction('enable'); setError('القفل غير مفعّل حالياً. أنشئ رمزاً جديداً لتفعيله.'); return }
        const record = JSON.parse(saved) as { salt: string; hash: string }
        const actual = await derivePinHash(currentPin, fromHex(record.salt))
        if (actual !== record.hash) { setError('رمز PIN الحالي غير صحيح.'); return }
      }
      if (action === 'disable') {
        localStorage.removeItem(DEVICE_PIN_KEY); onPinStateChange(false); onClose(); return
      }
      if (!/^\d{4,8}$/.test(newPin)) { setError('استخدم رمزاً جديداً من 4 إلى 8 أرقام.'); return }
      if (newPin !== confirmPin) { setError('الرمزان الجديدان غير متطابقين.'); return }
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const hash = await derivePinHash(newPin, salt)
      localStorage.setItem(DEVICE_PIN_KEY, JSON.stringify({ salt: toHex(salt), hash }))
      onPinStateChange(true); onClose()
      window.alert('تم تغيير رمز PIN لهذا الجهاز بنجاح.')
    } catch { setError('تعذر تحديث القفل. تأكد من استخدام اتصال آمن وحاول مجدداً.') }
    finally { setBusy(false) }
  }
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="dialog">
    <button className="close" onClick={onClose}><X/></button><h3>إعدادات قفل هذا الجهاز</h3><p>هذا الإعداد محلي ولا يؤثر على قفل أجهزتك الأخرى.</p>
    <div className="actions">{hasSavedPin ? <><button type="button" className={action === 'change' ? 'primary' : 'outline'} onClick={() => {setAction('change');setError('')}}>تغيير PIN</button><button type="button" className={action === 'disable' ? 'primary' : 'outline'} onClick={() => {setAction('disable');setError('')}}>إلغاء القفل</button></> : <button type="button" className="primary" onClick={() => {setAction('enable');setError('')}}>تفعيل PIN</button>}</div>
    <form onSubmit={submit}>{action !== 'enable' && <label>رمز PIN الحالي<input type="password" inputMode="numeric" maxLength={8} required value={currentPin} onChange={e=>setCurrentPin(e.target.value.replace(/\D/g,'').slice(0,8))}/></label>}
    {(action === 'change' || action === 'enable') && <><label>رمز PIN الجديد<input type="password" inputMode="numeric" maxLength={8} required value={newPin} onChange={e=>setNewPin(e.target.value.replace(/\D/g,'').slice(0,8))}/></label><label>تأكيد الرمز الجديد<input type="password" inputMode="numeric" maxLength={8} required value={confirmPin} onChange={e=>setConfirmPin(e.target.value.replace(/\D/g,'').slice(0,8))}/></label></>}
    {error && <p className="form-error">{error}</p>}<button className="primary full" disabled={busy}>{busy ? 'جارٍ الحفظ…' : action === 'disable' ? 'إلغاء القفل على هذا الجهاز' : action === 'enable' ? 'تفعيل PIN' : 'حفظ الرمز الجديد'}</button></form>
    {action === 'disable' && <p className="form-error">سيصبح فتح الدفتر على هذا الجهاز دون PIN بعد التأكيد.</p>}
  </section></div>
}

function DevicePinGate({ onUnlock, hasPin }: { onUnlock: () => void; hasPin: boolean }) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (!/^\d{4,8}$/.test(pin)) { setError('استخدم رمزاً من 4 إلى 8 أرقام.'); return }
    if (!hasPin && pin !== confirmPin) { setError('الرمزان غير متطابقين.'); return }
    setBusy(true)
    try {
      if (hasPin) {
        const saved = localStorage.getItem(DEVICE_PIN_KEY)
        if (!saved) throw new Error('PIN_NOT_FOUND')
        const record = JSON.parse(saved) as { salt: string; hash: string }
        const actual = await derivePinHash(pin, fromHex(record.salt))
        if (actual !== record.hash) { setError('الرمز غير صحيح. حاول مرة أخرى.'); return }
      } else {
        const salt = crypto.getRandomValues(new Uint8Array(16))
        const hash = await derivePinHash(pin, salt)
        localStorage.setItem(DEVICE_PIN_KEY, JSON.stringify({ salt: toHex(salt), hash }))
      }
      onUnlock()
    } catch {
      setError('تعذر التحقق من الرمز على هذا المتصفح. تأكد من استخدام اتصال آمن ثم أعد المحاولة.')
    } finally { setBusy(false) }
  }

  return <main className="app" dir="rtl"><section className="dialog" style={{maxWidth:420,margin:'10vh auto'}}>
    <h2>قفل دفتر الديون</h2>
    <p>{hasPin ? 'أدخل رمز هذا الجهاز لفتح الدفتر.' : 'أنشئ رمزاً محلياً لحماية فتح الدفتر على هذا الجهاز.'}</p>
    <form onSubmit={submit}>
      <label>رمز PIN (4 إلى 8 أرقام)<input autoFocus inputMode="numeric" pattern="[0-9]*" type="password" maxLength={8} required value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g, '').slice(0,8))}/></label>
      {!hasPin && <label>تأكيد الرمز<input inputMode="numeric" pattern="[0-9]*" type="password" maxLength={8} required value={confirmPin} onChange={e=>setConfirmPin(e.target.value.replace(/\D/g, '').slice(0,8))}/></label>}
      {error && <p className="form-error">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? 'جارٍ التحقق…' : hasPin ? 'فتح الدفتر' : 'حفظ الرمز وفتح الدفتر'}</button>
    </form>
    <p style={{fontSize:12,marginTop:14}}>هذا الرمز خاص بملف المتصفح على هذا الجهاز، ولا تتم مزامنته مع الأجهزة الأخرى. لا تستخدمه بدلاً من كلمة مرور حسابك.</p>
  </section></main>
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [hasPin, setHasPin] = useState(() => Boolean(localStorage.getItem(DEVICE_PIN_KEY)))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [registerMode, setRegisterMode] = useState(false)
  const [error, setError] = useState('')
  const [authSetupError, setAuthSetupError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSplash, setShowSplash] = useState(true)

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSplash(false), 2000)
    return () => window.clearTimeout(timer)
  }, [])

  // Keep dialogs and their action buttons above the mobile on-screen keyboard.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const updateKeyboardInset = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }
    updateKeyboardInset()
    viewport.addEventListener('resize', updateKeyboardInset)
    viewport.addEventListener('scroll', updateKeyboardInset)
    window.addEventListener('resize', updateKeyboardInset)
    return () => {
      viewport.removeEventListener('resize', updateKeyboardInset)
      viewport.removeEventListener('scroll', updateKeyboardInset)
      window.removeEventListener('resize', updateKeyboardInset)
      document.documentElement.style.removeProperty('--keyboard-inset')
    }
  }, [])

  useEffect(() => {
    let generation = 0

    const unsubscribe = onAuthStateChanged(auth, async value => {
      const currentGeneration = ++generation
      setReady(false)
      setAuthSetupError('')
      setUser(null)
      setUnlocked(false)

      if (!value) {
        setActiveShopId('daftar-shared')
        setHasPin(Boolean(localStorage.getItem(DEVICE_PIN_KEY)))
        setReady(true)
        return
      }

      try {
        const shopId = await resolveLedgerShop(value)
        if (currentGeneration !== generation) return

        setActiveShopId(shopId)
        setHasPin(Boolean(localStorage.getItem(DEVICE_PIN_KEY)))
        setUser(value)
        setReady(true)
      } catch (cause) {
        if (currentGeneration !== generation) return
        console.error('تعذر تهيئة دفتر المستخدم', cause)
        setAuthSetupError('تعذر تهيئة دفتر الحساب. تحقق من اتصال Firebase وقواعد Firestore ثم أعد تحميل الصفحة.')
        setReady(true)
      }
    })

    return () => {
      generation++
      unsubscribe()
    }
  }, [])

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)

    try {
      if (registerMode) {
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code || '')
        : ''

      if (registerMode) {
        if (code === 'auth/email-already-in-use') {
          setError('هذا البريد مسجل بالفعل. سجّل الدخول بدل إنشاء حساب جديد.')
        } else if (code === 'auth/weak-password') {
          setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل.')
        } else if (code === 'auth/invalid-email') {
          setError('البريد الإلكتروني غير صحيح.')
        } else if (code === 'auth/operation-not-allowed') {
          setError('التسجيل بالبريد الإلكتروني غير مفعّل في إعدادات Firebase.')
        } else {
          setError('تعذر إنشاء الحساب. تحقق من البيانات وحاول مجدداً.')
        }
      } else {
        setError('تعذر تسجيل الدخول. تحقق من البريد وكلمة المرور.')
      }
    } finally {
      setBusy(false)
    }
  }

  if (showSplash) return (
    <main className="splash-screen" dir="rtl">
      <section className="splash-content">
        <div className="splash-icon">
          <span>▤</span>
          <span className="splash-pen">✎</span>
        </div>
        <h1>دفتر الديون</h1>
        <p>إدارة ذكية.. لحسابات أسهل</p>
        <div className="splash-loader"><span /></div>
      </section>
    </main>
  )

  if (!ready) return <main className="app"><section className="dialog"><h2>دفتر الديون</h2><p>جارٍ التحقق من تسجيل الدخول…</p></section></main>
  if (authSetupError) return (
    <main className="app" dir="rtl">
      <section className="dialog" style={{ maxWidth: 420, margin: '10vh auto' }}>
        <h2>تعذر تهيئة دفتر الحساب</h2>
        <p className="form-error">{authSetupError}</p>
        <button className="outline full" onClick={() => void signOut(auth)}>تسجيل الخروج</button>
      </section>
    </main>
  )

  if (!user) return (
    <main className="app" dir="rtl">
      <section className="dialog" style={{ maxWidth: 420, margin: '10vh auto' }}>
        <h2>دفتر الديون</h2>
        <p>{registerMode ? 'إنشاء حساب جديد ودفتر مستقل' : 'سجّل الدخول بحسابك للمتابعة'}</p>
        <form onSubmit={login}>
          <label>البريد الإلكتروني
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label>كلمة المرور
            <input type="password" required minLength={registerMode ? 6 : undefined} value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary full" disabled={busy}>
            {busy ? (registerMode ? 'جارٍ إنشاء الحساب…' : 'جارٍ الدخول…') : (registerMode ? 'إنشاء الحساب' : 'تسجيل الدخول')}
          </button>
          <button type="button" className="outline full" disabled={busy}
            onClick={() => { setRegisterMode(value => !value); setError('') }}>
            {registerMode ? 'لديك حساب؟ تسجيل الدخول' : 'إنشاء حساب جديد'}
          </button>
        </form>
      </section>
    </main>
  )
  if (!unlocked && hasPin) return <DevicePinGate hasPin={hasPin} onUnlock={() => setUnlocked(true)} />
  if (!hasPin) return <Dashboard user={user} onPinStateChange={setHasPin} />
  if (!unlocked) return <DevicePinGate hasPin onUnlock={() => setUnlocked(true)} />
  return <Dashboard user={user} onPinStateChange={setHasPin} />
}







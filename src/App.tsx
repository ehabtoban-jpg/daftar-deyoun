import { useMemo, useState, useEffect, useRef } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { auth } from './firebase'
import { watchSharedLedger, saveSharedLedger, appendSharedCustomer, appendSharedEntry, mutateSharedLedger, recordActivity, listActivity, listTrash, putInTrash, restoreTrash, exportLedgerBackup, restoreLedgerBackup, purgeExpiredTrash, type ActivityEvent, type TrashRecord } from './ledgerSync'
import { Users, Wallet, Search, Plus, ArrowDownLeft, ArrowUpRight, X, Check, Pencil, Trash2, RotateCcw, Archive, Download, Upload, MessageCircle, ShieldCheck, Activity, Settings } from 'lucide-react'

type Currency = 'USD' | 'SYP'
type Customer = { id: string; name: string; phone: string; createdAt: string }
type Entry = { id: string; customerId: string; kind: 'debt' | 'payment'; amount: number; currency: Currency; note: string; actor: string; date: string }

const money = (n: number, c: Currency) => new Intl.NumberFormat('ar', { maximumFractionDigits: 2 }).format(n) + (c === 'USD' ? ' $' : ' ل.س')
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }

function Dashboard({ user, onPinStateChange }: { user: User; onPinStateChange: (enabled: boolean) => void }) {
  const [customers, setCustomers] = useState<Customer[]>(() => load('dd-customers', []))
  const [entries, setEntries] = useState<Entry[]>(() => load('dd-entries', []))
  const [actor, setActor] = useState(() => localStorage.getItem('dd-actor') || 'صاحب المحل')
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<'customer' | 'entry' | 'editCustomer' | 'editEntry' | null>(null)
  const [editingId, setEditingId] = useState('')
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
        additions.push({ id: crypto.randomUUID(), name: contactName, phone: contactPhone, createdAt: new Date().toISOString() })
        if (normalizedPhone) knownPhones.add(normalizedPhone)
        knownNames.add(normalizedName)
      }
      if (!additions.length) { window.alert(selectedContacts.length ? 'لم نعثر على جهات اتصال جديدة؛ قد تكون مضافة مسبقاً أو بلا أسماء.' : 'لم يتم اختيار أي جهة اتصال.'); return }
      const next = [...customers, ...additions]
      setCustomers(next)
      localStorage.setItem('dd-customers', JSON.stringify(next))
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
  const refreshTrash = async () => { try { setTrashItems(await listTrash()) } catch { setSyncStatus('تعذر تحميل سلة المحذوفات') } }
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
      setSyncStatus('عاد الإنترنت، جارٍ التحقق من المزامنة…')
    }
    window.addEventListener('offline', markOffline)
    window.addEventListener('online', markOnline)
    if (!navigator.onLine) markOffline()

    const unsubscribe = watchSharedLedger(data => {
      if (!active) return
      if (!navigator.onLine) {
        markOffline()
        return
      }
      if (data) {
        setCustomers(data.customers as Customer[])
        setEntries(data.entries as Entry[])
        localStorage.setItem('dd-customers', JSON.stringify(data.customers))
        localStorage.setItem('dd-entries', JSON.stringify(data.entries))
        setSyncStatus('متصل ومتزامن')
      } else {
        const localCustomers = load<Customer[]>('dd-customers', [])
        const localEntries = load<Entry[]>('dd-entries', [])
        void saveSharedLedger(localCustomers, localEntries, user.uid).then(() => {
          if (!active) return
          setCustomers(localCustomers)
          setEntries(localEntries)
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
    const next = [...customers, customer]
    setCustomers(next)
    localStorage.setItem('dd-customers', JSON.stringify(next))
    setSyncStatus(navigator.onLine ? 'جارٍ حفظ الزبون ومزامنته…' : 'حُفظ محلياً، بانتظار عودة الإنترنت')
    void appendSharedCustomer(customer, user.uid)
      .then(() => setSyncStatus('متصل ومتزامن'))
      .catch(() => setSyncStatus(navigator.onLine ? 'تعذر تأكيد المزامنة؛ ستتم إعادة المحاولة عند الاتصال' : 'حُفظ محلياً، بانتظار عودة الإنترنت'))
    void logActivity('إضافة زبون', `إضافة الزبون: ${customer.name}`, customer.phone, customer.name)
  }
  const persistEntry = (entry: Entry) => {
    const next = [...entries, entry]
    setEntries(next)
    localStorage.setItem('dd-entries', JSON.stringify(next))
    setSyncStatus(navigator.onLine ? 'جارٍ حفظ الحركة ومزامنتها…' : 'حُفظت الحركة محلياً، بانتظار عودة الإنترنت')
    void appendSharedEntry(entry, user.uid)
      .then(() => setSyncStatus('متصل ومتزامن'))
      .catch(() => setSyncStatus(navigator.onLine ? 'تعذر تأكيد المزامنة؛ ستتم إعادة المحاولة عند الاتصال' : 'حُفظت الحركة محلياً، بانتظار عودة الإنترنت'))
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
    persistCustomer({ id: crypto.randomUUID(), name: name.trim(), phone: phone.trim(), createdAt: new Date().toISOString() })
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
    const savedEntry: Entry = { id: crypto.randomUUID(), customerId: entryCustomerId, kind, amount: n, currency, note: note.trim(), actor, date: new Date().toISOString() }
    persistEntry(savedEntry)
    setAmount(''); setNote(''); setEntryError(''); setModal(null)
    setReminderOffer(savedEntry)
  }
  const runLedgerMutation = async (mutate: (cs: Customer[], es: Entry[]) => { customers: Customer[]; entries: Entry[] }) => {
    if (!navigator.onLine) { window.alert('التعديل والحذف يحتاجان اتصالاً بالإنترنت.'); return false }
    setEditBusy(true)
    try {
      const next = await mutateSharedLedger((cs, es) => mutate(cs as Customer[], es as Entry[]), user.uid)
      void next
      // Read the committed state through the live Firestore listener.
      setSyncStatus('تم حفظ التعديل ومزامنته')
      return true
    } catch {
      setSyncStatus('تعذر حفظ التعديل؛ لم تتغير البيانات')
      window.alert('تعذر حفظ التغيير. تحقق من الاتصال وحاول مرة أخرى.')
      return false
    } finally { setEditBusy(false) }
  }
  const openCustomerEdit = () => {
    if (!selectedCustomer) return
    setEditingId(selectedCustomer.id); setName(selectedCustomer.name); setPhone(selectedCustomer.phone)
    setSelected(''); setModal('editCustomer')
  }
  const saveCustomerEdit = async () => {
    const ok = await runLedgerMutation((cs, es) => ({
      customers: cs.map(c => c.id === editingId ? { ...c, name: name.trim(), phone: phone.trim() } : c),
      entries: es,
    }))
    if (ok) { void logActivity('تعديل زبون', `تعديل بيانات الزبون ${name.trim()}`); setModal(null); setName(''); setPhone('') }
  }
  const deleteCustomer = async () => {
    if (!selectedCustomer) return
    if (entries.some(e => e.customerId === selectedCustomer.id)) {
      window.alert('لا يمكن حذف زبون لديه حركات مالية. عالج حركاته أولاً.')
      return
    }
    if (!window.confirm('نقل هذا الزبون إلى سلة المحذوفات لمدة 10 أيام؟')) return
    if (!navigator.onLine) { window.alert('سلة المحذوفات تحتاج اتصالاً بالإنترنت.'); return }
    setEditBusy(true)
    try {
      await putInTrash({ entityType: 'customer', entity: selectedCustomer, deletedBy: actor }, (cs, es) => {
        const typedCustomers = cs as Customer[]
        const typedEntries = es as Entry[]
        if (typedEntries.some(entry => entry.customerId === selectedCustomer.id)) throw new Error('CUSTOMER_HAS_ENTRIES')
        return { customers: typedCustomers.filter(customer => customer.id !== selectedCustomer.id), entries: typedEntries }
      }, user.uid)
      void logActivity('نقل زبون إلى السلة', 'نقل الزبون ' + selectedCustomer.name + ' إلى سلة المحذوفات', '', selectedCustomer.name)
      setSelected('')
      setSyncStatus('تم نقل الزبون إلى سلة المحذوفات')
    } catch {
      window.alert('تعذر نقل الزبون. إذا كان لديه حركات مالية، لا يمكن نقله حالياً.')
    } finally { setEditBusy(false) }
  }
  const openEntryEdit = (entry: Entry) => {
    setEditingId(entry.id); setKind(entry.kind); setAmount(String(entry.amount)); setCurrency(entry.currency); setNote(entry.note)
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
    const ok = await runLedgerMutation((cs, es) => ({
      customers: cs,
      entries: es.map(e => e.id === editingId ? { ...e, kind, amount: n, currency, note: note.trim() } : e),
    }))
    if (ok) { const edited = entries.find(e => e.id === editingId); void logActivity('تعديل حركة', `تعديل ${kind === 'debt' ? 'دين' : 'دفعة'} بمبلغ ${money(n, currency)}`, note.trim(), customers.find(c => c.id === edited?.customerId)?.name || 'زبون غير معروف'); setModal(null); setAmount(''); setNote('') }
  }
  const deleteEntry = async (id: string) => {
    if (!window.confirm('هل تريد حذف هذه الحركة؟ سيتم تحديث الرصيد تلقائياً.')) return
    const target = entries.find(e => e.id === id)
    if (!target) return
    if (!navigator.onLine) { window.alert('سلة المحذوفات تحتاج اتصالاً بالإنترنت.'); return }
    setEditBusy(true)
    try {
      const customerName = customers.find(c => c.id === target.customerId)?.name || 'زبون غير معروف'
      await putInTrash({ entityType: 'entry', entity: target, deletedBy: actor }, (cs, es) => ({ customers: cs as Customer[], entries: (es as Entry[]).filter(entry => entry.id !== id) }), user.uid)
      void logActivity('نقل حركة إلى السلة', 'نقل ' + (target.kind === 'debt' ? 'دين' : 'دفعة') + ' بقيمة ' + money(target.amount, target.currency) + ' إلى السلة', target.note, customerName)
      setSyncStatus('تم نقل الحركة إلى سلة المحذوفات')
    } catch { window.alert('تعذر نقل الحركة إلى سلة المحذوفات.') }
    finally { setEditBusy(false) }
  }
  const restoreTrashItem = async (item: TrashRecord) => {
    if (!navigator.onLine) { window.alert('استعادة العناصر تحتاج اتصالاً بالإنترنت.'); return }
    if (!window.confirm('هل تريد استعادة هذا العنصر إلى الدفتر؟')) return
    setEditBusy(true)
    try {
      await restoreTrash(item, user.uid)
      await refreshTrash()
      const customerName = item.entityType === 'customer' ? (item.entity as Customer).name : customers.find(c => c.id === (item.entity as Entry).customerId)?.name || 'زبون غير معروف'
      void logActivity('استعادة من سلة المحذوفات', 'استعادة عنصر للزبون ' + customerName, '', customerName)
      setSyncStatus('تمت استعادة العنصر')
    } catch (error) {
      window.alert(error instanceof Error && error.message === 'TRASH_ITEM_EXPIRED' ? 'انتهت مهلة الاستعادة لهذا العنصر.' : 'تعذرت الاستعادة. قد يكون العنصر موجوداً بالفعل أو انتهت مهلة الاستعادة.')
    } finally { setEditBusy(false) }
  }
  const selectedCustomer = customers.find(c => c.id === selected)
  const customerRows = entries.filter(e => e.customerId === selected).sort((a,b) => b.date.localeCompare(a.date))
  const balanceFor = (cur: Currency) => customerRows.reduce((s,e) => s + (e.currency === cur ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)
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

  return <main className="app">
    <header className="topbar"><div><div className="brandmark">د</div><div><h1>دفتر الديون</h1><p>دفترك واضح… وحساباتك محفوظة</p></div></div><label className="actor">المستخدم <select value={actor} onChange={e => {setActor(e.target.value); localStorage.setItem('dd-actor', e.target.value)}}><option>صاحب المحل</option><option>الأخ</option></select></label></header>
    {showTrash ? <section className="panel activity-page">
      <div className="panel-head"><div><h2>سلة المحذوفات</h2><p>يمكن استعادة العناصر خلال 10 أيام من تاريخ الحذف</p></div><button className="outline" onClick={() => void refreshTrash()}>تحديث</button></div>
      <button className="outline" onClick={() => setShowTrash(false)}>العودة إلى لوحة الحسابات</button>
      {trashItems.length ? <div className="customer-list">{trashItems.map(item => { const expired = new Date(item.expiresAt).getTime() <= Date.now(); const label = item.entityType === 'customer' ? (item.entity as Customer).name : ((item.entity as Entry).kind === 'debt' ? 'دين ' : 'دفعة ') + (item.entity as Entry).amount + ' ' + (item.entity as Entry).currency; return <article className="entry activity-row" key={item.id}><span className="entry-info"><b>{label}</b><small>{item.entityType === 'customer' ? 'زبون' : 'حركة مالية'} · حُذف بواسطة: {item.deletedBy}</small><small>تاريخ النقل: {new Date(item.deletedAt).toLocaleString('ar')}</small><small>{expired ? 'انتهت مهلة الاستعادة' : 'آخر موعد للاستعادة: ' + new Date(item.expiresAt).toLocaleString('ar')}</small></span><button className="outline" disabled={editBusy || expired} onClick={() => void restoreTrashItem(item)}><RotateCcw size={15}/> استعادة</button></article> })}</div> : <div className="empty compact">سلة المحذوفات فارغة</div>}
    </section> : showActivity ? <section className="panel activity-page">
      <div className="panel-head"><div><h2>سجل النشاطات</h2><p>كل العمليات التي تمت على دفتر الديون، مع اسم الزبون ووقت العملية</p></div><button className="outline" onClick={() => void refreshActivity()}>تحديث</button></div>
      <button className="outline" onClick={() => setShowActivity(false)}>العودة إلى لوحة الحسابات</button>
      {activities.length ? <div className="customer-list">{activities.map(item => <article className="entry activity-row" key={item.id}>
        <span className="entry-info"><b>{item.action} — {item.description}</b><small>الزبون: {item.customerName || 'غير محدد'}</small><small>{item.actor} · {item.actorEmail} · {new Date(item.createdAt).toLocaleString('ar')}</small>{item.details && <small>ملاحظات: {item.details}</small>}</span>
      </article>)}</div> : <div className="empty compact">لا توجد نشاطات مسجلة بعد</div>}
    </section> : showSettings ? <section className="panel settings-page"><div className="panel-head"><div><h2>الإعدادات</h2><p>إدارة أمان الدفتر والنسخ الاحتياطية والحساب</p></div></div><div className="settings-group"><h3>الأمان</h3><button className="outline full" onClick={() => setShowPinSettings(true)}><ShieldCheck size={17}/> أمان القفل وPIN</button><p className="settings-hint">قفل مستقل لهذا الجهاز فقط.</p></div><div className="settings-group"><h3>النسخ الاحتياطي</h3><div className="settings-actions"><button className="outline" disabled={backupBusy} onClick={() => void downloadBackup()}><Download size={16}/> تنزيل نسخة احتياطية</button><button className="outline" disabled={backupBusy} onClick={() => backupInput.current?.click()}><Upload size={16}/> استعادة نسخة</button><input ref={backupInput} type="file" accept=".json,application/json" hidden onChange={e => void importBackup(e.target.files?.[0])}/></div></div><div className="settings-group"><h3>إدارة الدفتر</h3><button className="outline full" onClick={() => {setShowTrash(true);setShowSettings(false);void refreshTrash()}}><Archive size={16}/> سلة المحذوفات</button><label className="actor settings-actor">المستخدم <select value={actor} onChange={e => {setActor(e.target.value);localStorage.setItem('dd-actor', e.target.value)}}><option>صاحب المحل</option><option>الأخ</option></select></label></div><div className="settings-group"><h3>الحساب</h3><button className="outline full" onClick={() => signOut(auth)}>تسجيل الخروج</button></div></section> : <>
    <section className="welcome"><div><span className="eyebrow">لوحة الحسابات</span><h2>أهلاً بك 👋</h2><p>تابع ديون زبائنك ودفعاتهم من مكان واحد.</p></div><div className="date">{new Intl.DateTimeFormat('ar', {dateStyle:'full'}).format(new Date())}</div></section>
    <section className="stats">
      <article className="stat"><span className="stat-icon blue"><Wallet size={20}/></span><p>إجمالي الديون بالدولار</p><strong>{money(totals.usd,'USD')}</strong></article>
      <article className="stat"><span className="stat-icon green"><Wallet size={20}/></span><p>إجمالي الديون بالليرة</p><strong>{money(totals.syp,'SYP')}</strong></article>
      <article className="stat"><span className="stat-icon amber"><Users size={20}/></span><p>الزبائن عليهم رصيد</p><strong>{balances.filter(c => c.usd > 0 || c.syp > 0).length}</strong></article>
    </section>
    <section className="actions"><button className="primary" onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('debt'); setEntryError(''); setModal('entry')}}><Plus size={18}/> تسجيل دين</button><button className="success" onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('payment'); setEntryError(''); setModal('entry')}}><ArrowDownLeft size={18}/> تسجيل دفعة</button><button className="outline" disabled={contactsBusy} onClick={() => void importPhoneContacts()}><Users size={18}/> {contactsBusy ? 'جارٍ استيراد جهات الاتصال…' : 'استيراد جهات الاتصال'}</button><button className="outline" onClick={() => setModal('customer')}><Users size={18}/> إضافة زبون</button></section>
    <section className="panel"><div className="panel-head"><div><h3>الزبائن</h3><p>كل حساباتك في قائمة واحدة</p></div><div className="tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>الكل</button><button className={filter==='owing'?'active':''} onClick={()=>setFilter('owing')}>عليهم ديون</button></div></div>
      <div className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث باسم الزبون أو رقم الهاتف"/></div>
      {shown.length ? <div className="customer-list">{shown.map(c=><button className="customer" key={c.id} onClick={()=>{if(!modal)setSelected(c.id)}} disabled={modal !== null}><span className="avatar">{c.name.slice(0,1)}</span><span className="customer-info"><b>{c.name}</b><small>{c.phone || 'لا يوجد رقم هاتف'}</small></span><span className="customer-bal"><b>{money(c.usd,'USD')}</b><small>{money(c.syp,'SYP')}</small></span><span className="chevron">‹</span></button>)}</div> : <div className="empty"><Users size={30}/><b>ما في زبائن بهالقائمة</b><span>أضف أول زبون وابدأ تسجيل الحسابات.</span><button onClick={()=>setModal('customer')}>إضافة زبون</button></div>}
    </section>
    {showActivity && <section className="panel activity-panel"><div className="panel-head"><div><h3>سجل النشاطات</h3><p>آخر العمليات التي سجلها المستخدمون</p></div><button className="outline" onClick={() => void refreshActivity()}>تحديث</button></div>{activities.length ? activities.map(item => <div className="entry" key={item.id}><span className="entry-info"><b>{item.action} — {item.description}</b><small>{item.actor} · {item.actorEmail} · {new Date(item.createdAt).toLocaleString('ar')}</small>{item.details && <small>{item.details}</small>}</span></div>) : <div className="empty compact">لا توجد نشاطات مسجلة بعد</div>}</section>}
    <nav className="bottom-nav"><button className={!showActivity && !showSettings && !showTrash ? 'active' : ''} onClick={() => {setShowActivity(false);setShowSettings(false);setShowTrash(false)}}><Wallet size={19}/><span>الرئيسية</span></button><button className={showActivity ? 'active' : ''} onClick={() => {setShowActivity(true);setShowSettings(false);setShowTrash(false);void refreshActivity()}}><Activity size={19}/><span>النشاطات</span></button><button className={showSettings || showTrash ? 'active' : ''} onClick={() => {setShowActivity(false);setShowSettings(true);setShowTrash(false)}}><Settings size={19}/><span>الإعدادات</span></button></nav>
    <footer><span>مسجل الدخول: {user.email}</span><span>{syncStatus}</span></footer>
    {showPinSettings && <PinSettings onClose={() => setShowPinSettings(false)} onPinStateChange={onPinStateChange} />}

    </>}
    {!showActivity && !showTrash && modal && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="dialog"><button className="close" onClick={()=>setModal(null)}><X/></button><h3>{modal==='customer'?'إضافة زبون جديد':modal==='editCustomer'?'تعديل بيانات الزبون':modal==='editEntry'?'تعديل الحركة':kind==='debt'?'تسجيل دين جديد':'تسجيل دفعة'}</h3>
      {modal==='customer' || modal==='editCustomer' ? <><label>اسم الزبون<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="مثلاً: أحمد محمد"/></label><label>رقم الهاتف (اختياري)<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="05xxxxxxxx"/></label><button className="primary full" onClick={modal==='customer'?addCustomer:saveCustomerEdit} disabled={!name.trim() || editBusy}><Check size={18}/> {modal==='customer'?'حفظ الزبون':'حفظ التعديلات'}</button></> :
      modal==='editEntry' ? <><label>نوع الحركة<select value={kind} onChange={e=>setKind(e.target.value as 'debt'|'payment')}><option value="debt">دين</option><option value="payment">دفعة</option></select></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة<input value={note} onChange={e=>setNote(e.target.value)}/></label><button className="primary full" onClick={saveEntryEdit} disabled={editBusy || !(Number(amount)>0)}><Check size={18}/> حفظ التعديلات</button></> : <><label>الزبون<select value={entryCustomerId} onChange={e=>setEntryCustomerId(e.target.value)}><option value="">اختر الزبون</option>{customers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>{entryError && <p className="form-error">{entryError}</p>}<div className="switch"><button className={kind==='debt'?'chosen':''} onClick={()=>setKind('debt')}><ArrowUpRight size={17}/> دين</button><button className={kind==='payment'?'chosen':''} onClick={()=>setKind('payment')}><ArrowDownLeft size={17}/> دفعة</button></div><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة (اختياري)<input value={note} onChange={e=>setNote(e.target.value)} placeholder="تفاصيل العملية"/></label><button className={kind==='debt'?'primary full':'success full'} onClick={addEntry} disabled={!entryCustomerId || !(Number(amount)>0)}><Check size={18}/> حفظ العملية</button></>}
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
    {!showActivity && !showTrash && selectedCustomer && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSelected('')}}><section className="dialog detail"><button className="close" onClick={()=>setSelected('')}><X/></button><div className="detail-person"><span className="avatar big">{selectedCustomer.name.slice(0,1)}</span><div><h3>{selectedCustomer.name}</h3><p>{selectedCustomer.phone || 'لا يوجد رقم هاتف'}</p></div></div><div className="customer-actions"><button className="success" onClick={sendWhatsAppReminder}><MessageCircle size={15}/> تذكير WhatsApp</button><button className="outline" onClick={openCustomerEdit}><Pencil size={15}/> تعديل بيانات الزبون</button><button className="outline danger-action" onClick={deleteCustomer}><Trash2 size={15}/> حذف الزبون</button></div><div className="detail-bal"><div><small>الرصيد بالدولار</small><b>{money(balanceFor('USD'),'USD')}</b></div><div><small>الرصيد بالليرة</small><b>{money(balanceFor('SYP'),'SYP')}</b></div></div><div className="detail-head"><b>سجل الحركات</b><button onClick={()=>{setKind('debt');setEntryError('');setEntryCustomerId(selectedCustomer.id);setSelected('');setModal('entry')}}><Plus size={16}/> حركة جديدة</button></div>{customerRows.length ? customerRows.map(e=><div className="entry" key={e.id}><span className={e.kind==='debt'?'debt-dot':'pay-dot'}>{e.kind==='debt'?<ArrowUpRight size={16}/>:<ArrowDownLeft size={16}/>}</span><span className="entry-info"><b>{e.kind==='debt'?'دين':'دفعة'}{e.note?' – '+e.note:''}</b><small>{new Date(e.date).toLocaleString('ar')} · {e.actor}</small></span><strong className={e.kind==='debt'?'red':'green-text'}>{e.kind==='debt'?'+':'−'}{money(e.amount,e.currency)}</strong><div className="entry-actions"><button className="outline" onClick={()=>openEntryEdit(e)}><Pencil size={13}/> تعديل</button><button className="outline danger-action" onClick={()=>deleteEntry(e.id)}><Trash2 size={13}/> حذف</button></div></div>) : <div className="empty compact">لا توجد حركات مسجلة بعد</div>}</section></div>}
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
    <div className="actions"><button type="button" className={action === 'change' ? 'primary' : 'outline'} onClick={() => {setAction('change');setError('')}}>تغيير PIN</button><button type="button" className={action === 'disable' ? 'primary' : 'outline'} onClick={() => {setAction('disable');setError('')}}>إلغاء القفل</button></div>
    <form onSubmit={submit}><label>رمز PIN الحالي<input type="password" inputMode="numeric" maxLength={8} required value={currentPin} onChange={e=>setCurrentPin(e.target.value.replace(/\D/g,'').slice(0,8))}/></label>
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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => onAuthStateChanged(auth, value => {
    setUser(value)
    setUnlocked(false)
    setHasPin(Boolean(localStorage.getItem(DEVICE_PIN_KEY)))
    setReady(true)
  }), [])

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
    } catch {
      setError('تعذر تسجيل الدخول. تحقق من البريد وكلمة المرور.')
    } finally {
      setBusy(false)
    }
  }

  if (!ready) return <main className="app"><section className="dialog"><h2>دفتر الديون</h2><p>جارٍ التحقق من تسجيل الدخول…</p></section></main>
  if (!user) return <main className="app" dir="rtl"><section className="dialog" style={{maxWidth:420,margin:'10vh auto'}}><h2>دفتر الديون</h2><p>سجّل الدخول بحسابك للمتابعة</p><form onSubmit={login}><label>البريد الإلكتروني<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} /></label><label>كلمة المرور<input type="password" required value={password} onChange={e=>setPassword(e.target.value)} /></label>{error && <p className="form-error">{error}</p>}<button className="primary full" disabled={busy}>{busy?'جارٍ الدخول…':'تسجيل الدخول'}</button></form></section></main>
  if (!unlocked && hasPin) return <DevicePinGate hasPin={hasPin} onUnlock={() => setUnlocked(true)} />
  if (!hasPin) return <Dashboard user={user} onPinStateChange={setHasPin} />
  if (!unlocked) return <DevicePinGate hasPin onUnlock={() => setUnlocked(true)} />
  return <Dashboard user={user} onPinStateChange={setHasPin} />
}

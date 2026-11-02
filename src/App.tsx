import { useMemo, useState, useEffect, useRef } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { auth } from './firebase'
import { watchSharedLedger, saveSharedLedger, appendSharedCustomer, appendSharedEntry, mutateSharedLedger } from './ledgerSync'
import { Users, Wallet, Search, Plus, ArrowDownLeft, ArrowUpRight, X, Check, Pencil, Trash2, Download, Upload, FileText } from 'lucide-react'

type Currency = 'USD' | 'SYP'
type Customer = { id: string; name: string; phone: string; createdAt: string }
type Entry = { id: string; customerId: string; kind: 'debt' | 'payment'; amount: number; currency: Currency; note: string; actor: string; date: string }

const money = (n: number, c: Currency) => new Intl.NumberFormat('ar', { maximumFractionDigits: 2 }).format(n) + (c === 'USD' ? ' $' : ' ل.س')
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }

const isCustomer = (value: unknown): value is Customer => {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.phone === 'string' && typeof item.createdAt === 'string'
}
const isEntry = (value: unknown): value is Entry => {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.customerId === 'string'
    && (item.kind === 'debt' || item.kind === 'payment')
    && typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount > 0
    && (item.currency === 'USD' || item.currency === 'SYP')
    && typeof item.note === 'string' && typeof item.actor === 'string'
    && typeof item.date === 'string'
}

function Dashboard({ user }: { user: User }) {
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
  const [syncStatus, setSyncStatus] = useState('جارٍ الاتصال بالسحابة…')
  const [backupBusy, setBackupBusy] = useState(false)
  const backupInputRef = useRef<HTMLInputElement>(null)

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
  }
  const persistEntry = (entry: Entry) => {
    const next = [...entries, entry]
    setEntries(next)
    localStorage.setItem('dd-entries', JSON.stringify(next))
    setSyncStatus(navigator.onLine ? 'جارٍ حفظ الحركة ومزامنتها…' : 'حُفظت الحركة محلياً، بانتظار عودة الإنترنت')
    void appendSharedEntry(entry, user.uid)
      .then(() => setSyncStatus('متصل ومتزامن'))
      .catch(() => setSyncStatus(navigator.onLine ? 'تعذر تأكيد المزامنة؛ ستتم إعادة المحاولة عند الاتصال' : 'حُفظت الحركة محلياً، بانتظار عودة الإنترنت'))
  }
  const exportBackup = () => {
    const backup = {
      app: 'daftar-deyoun',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: user.email || '',
      data: { customers, entries },
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `daftar-deyoun-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const restoreBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      setBackupBusy(true)
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_BACKUP')
      const root = parsed as Record<string, unknown>
      const data = root.data as Record<string, unknown> | undefined
      if (root.app !== 'daftar-deyoun' || root.formatVersion !== 1 || !data
        || !Array.isArray(data.customers) || !Array.isArray(data.entries)
        || !data.customers.every(isCustomer) || !data.entries.every(isEntry)) {
        throw new Error('INVALID_BACKUP')
      }
      const restoredCustomers = data.customers as Customer[]
      const restoredEntries = data.entries as Entry[]
      const customerIds = new Set(restoredCustomers.map(customer => customer.id))
      if (restoredEntries.some(entry => !customerIds.has(entry.customerId))) throw new Error('INVALID_BACKUP')
      if (!window.confirm(`سيتم استبدال الدفتر الحالي على جميع الأجهزة بالنسخة المختارة ( ${restoredCustomers.length} زبون و${restoredEntries.length} حركة). لا يمكن التراجع عن هذا الاستبدال. هل تريد المتابعة؟`)) return

      await saveSharedLedger(restoredCustomers, restoredEntries, user.uid)
      setCustomers(restoredCustomers)
      setEntries(restoredEntries)
      localStorage.setItem('dd-customers', JSON.stringify(restoredCustomers))
      localStorage.setItem('dd-entries', JSON.stringify(restoredEntries))
      setSyncStatus('تمت استعادة النسخة ومزامنتها')
      window.alert('تمت استعادة النسخة الاحتياطية بنجاح.')
    } catch (error) {
      const message = error instanceof Error && error.message === 'INVALID_BACKUP'
        ? 'الملف غير صالح أو لا ينتمي إلى نسخة دفتر الديون.'
        : 'تعذرت استعادة النسخة. تحقق من اتصال الإنترنت وحاول مرة أخرى.'
      window.alert(message)
      setSyncStatus('تعذرت استعادة النسخة الاحتياطية')
    } finally {
      setBackupBusy(false)
      event.target.value = ''
    }
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
    persistEntry({ id: crypto.randomUUID(), customerId: entryCustomerId, kind, amount: n, currency, note: note.trim(), actor, date: new Date().toISOString() })
    setAmount(''); setNote(''); setEntryError(''); setModal(null)
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
    if (ok) { setModal(null); setName(''); setPhone('') }
  }
  const deleteCustomer = async () => {
    if (!selectedCustomer) return
    if (entries.some(e => e.customerId === selectedCustomer.id)) {
      window.alert('لا يمكن حذف زبون لديه حركات مالية. عالج حركاته أولاً.')
      return
    }
    if (!window.confirm('هل تريد حذف هذا الزبون نهائياً؟')) return
    const id = selectedCustomer.id
    const ok = await runLedgerMutation((cs, es) => {
      if (es.some(e => e.customerId === id)) throw new Error('CUSTOMER_HAS_ENTRIES')
      return { customers: cs.filter(c => c.id !== id), entries: es }
    })
    if (ok) setSelected('')
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
    if (ok) { setModal(null); setAmount(''); setNote('') }
  }
  const deleteEntry = async (id: string) => {
    if (!window.confirm('هل تريد حذف هذه الحركة؟ سيتم تحديث الرصيد تلقائياً.')) return
    await runLedgerMutation((cs, es) => ({ customers: cs, entries: es.filter(e => e.id !== id) }))
  }
  const selectedCustomer = customers.find(c => c.id === selected)
  const customerRows = entries.filter(e => e.customerId === selected).sort((a,b) => b.date.localeCompare(a.date))
  const balanceFor = (cur: Currency) => customerRows.reduce((s,e) => s + (e.currency === cur ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)

  const exportCustomerStatement = () => {
    if (!selectedCustomer) return
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char] || char)
    const chronological = [...customerRows].sort((a, b) => a.date.localeCompare(b.date))
    let runningUSD = 0
    let runningSYP = 0
    const rows = chronological.map(entry => {
      const delta = entry.kind === 'debt' ? entry.amount : -entry.amount
      if (entry.currency === 'USD') runningUSD += delta
      else runningSYP += delta
      return `<tr>
        <td>${escapeHtml(new Date(entry.date).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' }))}</td>
        <td>${entry.kind === 'debt' ? 'دين' : 'دفعة'}</td>
        <td>${escapeHtml(entry.note || '—')}</td>
        <td>${escapeHtml(entry.actor || '—')}</td>
        <td class="amount">${entry.kind === 'debt' ? '+' : '−'}${escapeHtml(money(entry.amount, entry.currency))}</td>
        <td class="amount">${escapeHtml(money(runningUSD, 'USD'))}</td>
        <td class="amount">${escapeHtml(money(runningSYP, 'SYP'))}</td>
      </tr>`
    }).join('')
    const popup = window.open('', '_blank', 'width=1100,height=800')
    if (!popup) {
      window.alert('المتصفح منع فتح نافذة الكشف. اسمح بالنوافذ المنبثقة لهذا الموقع ثم حاول مجدداً.')
      return
    }
    const generatedAt = new Date().toLocaleString('ar', { dateStyle: 'full', timeStyle: 'short' })
    popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف حساب - ${escapeHtml(selectedCustomer.name)}</title>
      <style>
        *{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;color:#172033;margin:28px;direction:rtl}
        h1{font-size:25px;margin:0 0 8px}p{margin:5px 0;color:#526078}.meta{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #243b63;padding-bottom:16px}
        .balances{display:flex;gap:14px;margin:20px 0}.balance{border:1px solid #d9e0ea;border-radius:10px;padding:14px;flex:1}.balance small{display:block;color:#64748b;margin-bottom:7px}.balance strong{font-size:20px}
        table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px}th,td{border:1px solid #dce2ea;padding:9px 7px;text-align:right}th{background:#eef2f7}
        .amount{white-space:nowrap;font-weight:600}.footer{margin-top:22px;font-size:11px;color:#64748b}
        @media print{body{margin:12mm}@page{size:landscape;margin:10mm}}
      </style></head><body>
      <div class="meta"><div><h1>كشف حساب زبون</h1><p>دفتر الديون</p><p>الاسم: <b>${escapeHtml(selectedCustomer.name)}</b></p><p>الهاتف: ${escapeHtml(selectedCustomer.phone || 'غير مسجل')}</p></div>
      <div><p>تاريخ إصدار الكشف</p><b>${escapeHtml(generatedAt)}</b></div></div>
      <div class="balances"><div class="balance"><small>الرصيد المتبقي بالدولار</small><strong>${escapeHtml(money(balanceFor('USD'), 'USD'))}</strong></div>
      <div class="balance"><small>الرصيد المتبقي بالليرة السورية</small><strong>${escapeHtml(money(balanceFor('SYP'), 'SYP'))}</strong></div></div>
      <h2 style="font-size:17px">تفاصيل الحركات</h2>
      <table><thead><tr><th>التاريخ</th><th>النوع</th><th>البيان</th><th>المسؤول</th><th>قيمة الحركة</th><th>الرصيد بالدولار بعد الحركة</th><th>الرصيد بالليرة بعد الحركة</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center">لا توجد حركات مسجلة</td></tr>'}</tbody></table>
      <div class="footer">هذا الكشف مولّد من سجل الحركات المحفوظ في دفتر الديون.</div>
      <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`)
    popup.document.close()
  }

  return <main className="app">
    <header className="topbar"><div><div className="brandmark">د</div><div><h1>دفتر الديون</h1><p>دفترك واضح… وحساباتك محفوظة</p></div></div><button className="outline" onClick={() => signOut(auth)}>تسجيل الخروج</button><label className="actor">المستخدم <select value={actor} onChange={e => {setActor(e.target.value); localStorage.setItem('dd-actor', e.target.value)}}><option>صاحب المحل</option><option>الأخ</option></select></label></header>
    <section className="welcome"><div><span className="eyebrow">لوحة الحسابات</span><h2>أهلاً بك 👋</h2><p>تابع ديون زبائنك ودفعاتهم من مكان واحد.</p></div><div className="date">{new Intl.DateTimeFormat('ar', {dateStyle:'full'}).format(new Date())}</div></section>
    <section className="stats">
      <article className="stat"><span className="stat-icon blue"><Wallet size={20}/></span><p>إجمالي الديون بالدولار</p><strong>{money(totals.usd,'USD')}</strong></article>
      <article className="stat"><span className="stat-icon green"><Wallet size={20}/></span><p>إجمالي الديون بالليرة</p><strong>{money(totals.syp,'SYP')}</strong></article>
      <article className="stat"><span className="stat-icon amber"><Users size={20}/></span><p>الزبائن عليهم رصيد</p><strong>{balances.filter(c => c.usd > 0 || c.syp > 0).length}</strong></article>
    </section>
    <section className="actions"><button className="primary" onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('debt'); setEntryError(''); setModal('entry')}}><Plus size={18}/> تسجيل دين</button><button className="success" onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('payment'); setEntryError(''); setModal('entry')}}><ArrowDownLeft size={18}/> تسجيل دفعة</button><button className="outline" onClick={() => setModal('customer')}><Users size={18}/> إضافة زبون</button></section>
    <section className="actions backup-actions">
      <button className="outline" onClick={exportBackup} disabled={backupBusy}><Download size={17}/> تنزيل نسخة احتياطية</button>
      <button className="outline" onClick={() => backupInputRef.current?.click()} disabled={backupBusy}><Upload size={17}/> استعادة نسخة احتياطية</button>
      <input ref={backupInputRef} type="file" accept=".json,application/json" onChange={restoreBackup} style={{ display: 'none' }} />
    </section>
    <section className="panel"><div className="panel-head"><div><h3>الزبائن</h3><p>كل حساباتك في قائمة واحدة</p></div><div className="tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>الكل</button><button className={filter==='owing'?'active':''} onClick={()=>setFilter('owing')}>عليهم ديون</button></div></div>
      <div className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث باسم الزبون أو رقم الهاتف"/></div>
      {shown.length ? <div className="customer-list">{shown.map(c=><button className="customer" key={c.id} onClick={()=>{if(!modal)setSelected(c.id)}} disabled={modal !== null}><span className="avatar">{c.name.slice(0,1)}</span><span className="customer-info"><b>{c.name}</b><small>{c.phone || 'لا يوجد رقم هاتف'}</small></span><span className="customer-bal"><b>{money(c.usd,'USD')}</b><small>{money(c.syp,'SYP')}</small></span><span className="chevron">‹</span></button>)}</div> : <div className="empty"><Users size={30}/><b>ما في زبائن بهالقائمة</b><span>أضف أول زبون وابدأ تسجيل الحسابات.</span><button onClick={()=>setModal('customer')}>إضافة زبون</button></div>}
    </section>
    <footer><span>مسجل الدخول: {user.email}</span><span>{syncStatus}</span></footer>

    {modal && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="dialog"><button className="close" onClick={()=>setModal(null)}><X/></button><h3>{modal==='customer'?'إضافة زبون جديد':modal==='editCustomer'?'تعديل بيانات الزبون':modal==='editEntry'?'تعديل الحركة':kind==='debt'?'تسجيل دين جديد':'تسجيل دفعة'}</h3>
      {modal==='customer' || modal==='editCustomer' ? <><label>اسم الزبون<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="مثلاً: أحمد محمد"/></label><label>رقم الهاتف (اختياري)<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="05xxxxxxxx"/></label><button className="primary full" onClick={modal==='customer'?addCustomer:saveCustomerEdit} disabled={!name.trim() || editBusy}><Check size={18}/> {modal==='customer'?'حفظ الزبون':'حفظ التعديلات'}</button></> :
      modal==='editEntry' ? <><label>نوع الحركة<select value={kind} onChange={e=>setKind(e.target.value as 'debt'|'payment')}><option value="debt">دين</option><option value="payment">دفعة</option></select></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة<input value={note} onChange={e=>setNote(e.target.value)}/></label><button className="primary full" onClick={saveEntryEdit} disabled={editBusy || !(Number(amount)>0)}><Check size={18}/> حفظ التعديلات</button></> : <><label>الزبون<select value={entryCustomerId} onChange={e=>setEntryCustomerId(e.target.value)}><option value="">اختر الزبون</option>{customers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>{entryError && <p className="form-error">{entryError}</p>}<div className="switch"><button className={kind==='debt'?'chosen':''} onClick={()=>setKind('debt')}><ArrowUpRight size={17}/> دين</button><button className={kind==='payment'?'chosen':''} onClick={()=>setKind('payment')}><ArrowDownLeft size={17}/> دفعة</button></div><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة (اختياري)<input value={note} onChange={e=>setNote(e.target.value)} placeholder="تفاصيل العملية"/></label><button className={kind==='debt'?'primary full':'success full'} onClick={addEntry} disabled={!entryCustomerId || !(Number(amount)>0)}><Check size={18}/> حفظ العملية</button></>}
    </section></div>}
    {selectedCustomer && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSelected('')}}><section className="dialog detail"><button className="close" onClick={()=>setSelected('')}><X/></button><div className="detail-person"><span className="avatar big">{selectedCustomer.name.slice(0,1)}</span><div><h3>{selectedCustomer.name}</h3><p>{selectedCustomer.phone || 'لا يوجد رقم هاتف'}</p></div></div><div className="customer-actions"><button className="outline" onClick={exportCustomerStatement}><FileText size={15}/> كشف حساب PDF</button><button className="outline" onClick={openCustomerEdit}><Pencil size={15}/> تعديل بيانات الزبون</button><button className="outline danger-action" onClick={deleteCustomer}><Trash2 size={15}/> حذف الزبون</button></div><div className="detail-bal"><div><small>الرصيد بالدولار</small><b>{money(balanceFor('USD'),'USD')}</b></div><div><small>الرصيد بالليرة</small><b>{money(balanceFor('SYP'),'SYP')}</b></div></div><div className="detail-head"><b>سجل الحركات</b><button onClick={()=>{setKind('debt');setEntryError('');setEntryCustomerId(selectedCustomer.id);setSelected('');setModal('entry')}}><Plus size={16}/> حركة جديدة</button></div>{customerRows.length ? customerRows.map(e=><div className="entry" key={e.id}><span className={e.kind==='debt'?'debt-dot':'pay-dot'}>{e.kind==='debt'?<ArrowUpRight size={16}/>:<ArrowDownLeft size={16}/>}</span><span className="entry-info"><b>{e.kind==='debt'?'دين':'دفعة'}{e.note?' – '+e.note:''}</b><small>{new Date(e.date).toLocaleString('ar')} · {e.actor}</small></span><strong className={e.kind==='debt'?'red':'green-text'}>{e.kind==='debt'?'+':'−'}{money(e.amount,e.currency)}</strong><div className="entry-actions"><button className="outline" onClick={()=>openEntryEdit(e)}><Pencil size={13}/> تعديل</button><button className="outline danger-action" onClick={()=>deleteEntry(e.id)}><Trash2 size={13}/> حذف</button></div></div>) : <div className="empty compact">لا توجد حركات مسجلة بعد</div>}</section></div>}
  </main>
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => onAuthStateChanged(auth, value => {
    setUser(value)
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
  return <Dashboard user={user} />
}

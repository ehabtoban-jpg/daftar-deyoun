import { useMemo, useState, useEffect } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { auth } from './firebase'
import { watchSharedLedger, saveSharedLedger, appendSharedCustomer, appendSharedEntry, mutateSharedLedger, recordActivity, listActivity, type ActivityEvent } from './ledgerSync'
import { Users, Wallet, Search, Plus, ArrowDownLeft, ArrowUpRight, X, Check, Pencil, Trash2 } from 'lucide-react'

type Currency = 'USD' | 'SYP'
type Customer = { id: string; name: string; phone: string; createdAt: string }
type Entry = { id: string; customerId: string; kind: 'debt' | 'payment'; amount: number; currency: Currency; note: string; actor: string; date: string }

const money = (n: number, c: Currency) => new Intl.NumberFormat('ar', { maximumFractionDigits: 2 }).format(n) + (c === 'USD' ? ' $' : ' ل.س')
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }

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
  const [showActivity, setShowActivity] = useState(false)
  const [activities, setActivities] = useState<ActivityEvent[]>([])
  const refreshActivity = async () => { try { setActivities(await listActivity()) } catch { setSyncStatus('تعذر تحميل سجل النشاطات') } }
  const logActivity = async (action: string, description: string, details = '', customerName = '') => { try { await recordActivity({ action, description, actor, actorEmail: user.email || '', createdAt: new Date().toISOString(), details, customerName }); if (showActivity) await refreshActivity() } catch { setSyncStatus('تم الحفظ لكن تعذر تسجيل النشاط') } }

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
    if (ok) { void logActivity('تعديل زبون', `تعديل بيانات الزبون ${name.trim()}`); setModal(null); setName(''); setPhone('') }
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
    if (ok) { void logActivity('حذف زبون', `حذف الزبون ${selectedCustomer.name}`, '', selectedCustomer.name); setSelected('') }
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
    const ok = await runLedgerMutation((cs, es) => ({ customers: cs, entries: es.filter(e => e.id !== id) }))
    if (ok && target) void logActivity('حذف حركة', `حذف ${target.kind === 'debt' ? 'دين' : 'دفعة'} بقيمة ${money(target.amount, target.currency)}`, target.note, customers.find(c => c.id === target.customerId)?.name || 'زبون غير معروف')
  }
  const selectedCustomer = customers.find(c => c.id === selected)
  const customerRows = entries.filter(e => e.customerId === selected).sort((a,b) => b.date.localeCompare(a.date))
  const balanceFor = (cur: Currency) => customerRows.reduce((s,e) => s + (e.currency === cur ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)

  return <main className="app">
    <header className="topbar"><div><div className="brandmark">د</div><div><h1>دفتر الديون</h1><p>دفترك واضح… وحساباتك محفوظة</p></div></div><button className="outline" onClick={() => signOut(auth)}>تسجيل الخروج</button><label className="actor">المستخدم <select value={actor} onChange={e => {setActor(e.target.value); localStorage.setItem('dd-actor', e.target.value)}}><option>صاحب المحل</option><option>الأخ</option></select></label></header>
    {showActivity ? <section className="panel activity-page">
      <div className="panel-head"><div><h2>سجل النشاطات</h2><p>كل العمليات التي تمت على دفتر الديون، مع اسم الزبون ووقت العملية</p></div><button className="outline" onClick={() => void refreshActivity()}>تحديث</button></div>
      <button className="outline" onClick={() => setShowActivity(false)}>العودة إلى لوحة الحسابات</button>
      {activities.length ? <div className="customer-list">{activities.map(item => <article className="entry activity-row" key={item.id}>
        <span className="entry-info"><b>{item.action} — {item.description}</b><small>الزبون: {item.customerName || 'غير محدد'}</small><small>{item.actor} · {item.actorEmail} · {new Date(item.createdAt).toLocaleString('ar')}</small>{item.details && <small>ملاحظات: {item.details}</small>}</span>
      </article>)}</div> : <div className="empty compact">لا توجد نشاطات مسجلة بعد</div>}
    </section> : <>
    <section className="welcome"><div><span className="eyebrow">لوحة الحسابات</span><h2>أهلاً بك 👋</h2><p>تابع ديون زبائنك ودفعاتهم من مكان واحد.</p></div><div className="date">{new Intl.DateTimeFormat('ar', {dateStyle:'full'}).format(new Date())}</div></section>
    <section className="stats">
      <article className="stat"><span className="stat-icon blue"><Wallet size={20}/></span><p>إجمالي الديون بالدولار</p><strong>{money(totals.usd,'USD')}</strong></article>
      <article className="stat"><span className="stat-icon green"><Wallet size={20}/></span><p>إجمالي الديون بالليرة</p><strong>{money(totals.syp,'SYP')}</strong></article>
      <article className="stat"><span className="stat-icon amber"><Users size={20}/></span><p>الزبائن عليهم رصيد</p><strong>{balances.filter(c => c.usd > 0 || c.syp > 0).length}</strong></article>
    </section>
    <section className="actions"><button className="outline" onClick={() => { setShowActivity(true); void refreshActivity() }}>سجل النشاطات</button><button className="primary" onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('debt'); setEntryError(''); setModal('entry')}}><Plus size={18}/> تسجيل دين</button><button className="success" onClick={() => {setSelected(''); setEntryCustomerId(''); setKind('payment'); setEntryError(''); setModal('entry')}}><ArrowDownLeft size={18}/> تسجيل دفعة</button><button className="outline" onClick={() => setModal('customer')}><Users size={18}/> إضافة زبون</button></section>
    <section className="panel"><div className="panel-head"><div><h3>الزبائن</h3><p>كل حساباتك في قائمة واحدة</p></div><div className="tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>الكل</button><button className={filter==='owing'?'active':''} onClick={()=>setFilter('owing')}>عليهم ديون</button></div></div>
      <div className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث باسم الزبون أو رقم الهاتف"/></div>
      {shown.length ? <div className="customer-list">{shown.map(c=><button className="customer" key={c.id} onClick={()=>{if(!modal)setSelected(c.id)}} disabled={modal !== null}><span className="avatar">{c.name.slice(0,1)}</span><span className="customer-info"><b>{c.name}</b><small>{c.phone || 'لا يوجد رقم هاتف'}</small></span><span className="customer-bal"><b>{money(c.usd,'USD')}</b><small>{money(c.syp,'SYP')}</small></span><span className="chevron">‹</span></button>)}</div> : <div className="empty"><Users size={30}/><b>ما في زبائن بهالقائمة</b><span>أضف أول زبون وابدأ تسجيل الحسابات.</span><button onClick={()=>setModal('customer')}>إضافة زبون</button></div>}
    </section>
    {showActivity && <section className="panel activity-panel"><div className="panel-head"><div><h3>سجل النشاطات</h3><p>آخر العمليات التي سجلها المستخدمون</p></div><button className="outline" onClick={() => void refreshActivity()}>تحديث</button></div>{activities.length ? activities.map(item => <div className="entry" key={item.id}><span className="entry-info"><b>{item.action} — {item.description}</b><small>{item.actor} · {item.actorEmail} · {new Date(item.createdAt).toLocaleString('ar')}</small>{item.details && <small>{item.details}</small>}</span></div>) : <div className="empty compact">لا توجد نشاطات مسجلة بعد</div>}</section>}
    <footer><span>مسجل الدخول: {user.email}</span><span>{syncStatus}</span></footer>

    </>}
    {!showActivity && modal && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="dialog"><button className="close" onClick={()=>setModal(null)}><X/></button><h3>{modal==='customer'?'إضافة زبون جديد':modal==='editCustomer'?'تعديل بيانات الزبون':modal==='editEntry'?'تعديل الحركة':kind==='debt'?'تسجيل دين جديد':'تسجيل دفعة'}</h3>
      {modal==='customer' || modal==='editCustomer' ? <><label>اسم الزبون<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="مثلاً: أحمد محمد"/></label><label>رقم الهاتف (اختياري)<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="05xxxxxxxx"/></label><button className="primary full" onClick={modal==='customer'?addCustomer:saveCustomerEdit} disabled={!name.trim() || editBusy}><Check size={18}/> {modal==='customer'?'حفظ الزبون':'حفظ التعديلات'}</button></> :
      modal==='editEntry' ? <><label>نوع الحركة<select value={kind} onChange={e=>setKind(e.target.value as 'debt'|'payment')}><option value="debt">دين</option><option value="payment">دفعة</option></select></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة<input value={note} onChange={e=>setNote(e.target.value)}/></label><button className="primary full" onClick={saveEntryEdit} disabled={editBusy || !(Number(amount)>0)}><Check size={18}/> حفظ التعديلات</button></> : <><label>الزبون<select value={entryCustomerId} onChange={e=>setEntryCustomerId(e.target.value)}><option value="">اختر الزبون</option>{customers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>{entryError && <p className="form-error">{entryError}</p>}<div className="switch"><button className={kind==='debt'?'chosen':''} onClick={()=>setKind('debt')}><ArrowUpRight size={17}/> دين</button><button className={kind==='payment'?'chosen':''} onClick={()=>setKind('payment')}><ArrowDownLeft size={17}/> دفعة</button></div><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة (اختياري)<input value={note} onChange={e=>setNote(e.target.value)} placeholder="تفاصيل العملية"/></label><button className={kind==='debt'?'primary full':'success full'} onClick={addEntry} disabled={!entryCustomerId || !(Number(amount)>0)}><Check size={18}/> حفظ العملية</button></>}
    </section></div>}
    {!showActivity && selectedCustomer && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSelected('')}}><section className="dialog detail"><button className="close" onClick={()=>setSelected('')}><X/></button><div className="detail-person"><span className="avatar big">{selectedCustomer.name.slice(0,1)}</span><div><h3>{selectedCustomer.name}</h3><p>{selectedCustomer.phone || 'لا يوجد رقم هاتف'}</p></div></div><div className="customer-actions"><button className="outline" onClick={openCustomerEdit}><Pencil size={15}/> تعديل بيانات الزبون</button><button className="outline danger-action" onClick={deleteCustomer}><Trash2 size={15}/> حذف الزبون</button></div><div className="detail-bal"><div><small>الرصيد بالدولار</small><b>{money(balanceFor('USD'),'USD')}</b></div><div><small>الرصيد بالليرة</small><b>{money(balanceFor('SYP'),'SYP')}</b></div></div><div className="detail-head"><b>سجل الحركات</b><button onClick={()=>{setKind('debt');setEntryError('');setEntryCustomerId(selectedCustomer.id);setSelected('');setModal('entry')}}><Plus size={16}/> حركة جديدة</button></div>{customerRows.length ? customerRows.map(e=><div className="entry" key={e.id}><span className={e.kind==='debt'?'debt-dot':'pay-dot'}>{e.kind==='debt'?<ArrowUpRight size={16}/>:<ArrowDownLeft size={16}/>}</span><span className="entry-info"><b>{e.kind==='debt'?'دين':'دفعة'}{e.note?' – '+e.note:''}</b><small>{new Date(e.date).toLocaleString('ar')} · {e.actor}</small></span><strong className={e.kind==='debt'?'red':'green-text'}>{e.kind==='debt'?'+':'−'}{money(e.amount,e.currency)}</strong><div className="entry-actions"><button className="outline" onClick={()=>openEntryEdit(e)}><Pencil size={13}/> تعديل</button><button className="outline danger-action" onClick={()=>deleteEntry(e.id)}><Trash2 size={13}/> حذف</button></div></div>) : <div className="empty compact">لا توجد حركات مسجلة بعد</div>}</section></div>}
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

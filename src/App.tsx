import { useMemo, useState, useEffect } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { auth } from './firebase'
import { watchSharedLedger, saveSharedLedger, appendSharedCustomer, appendSharedEntry } from './ledgerSync'
import { Users, Wallet, Search, Plus, ArrowDownLeft, ArrowUpRight, X, Check } from 'lucide-react'

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
  const [modal, setModal] = useState<'customer' | 'entry' | null>(null)
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
  const [syncReady, setSyncReady] = useState(false)
  const [syncStatus, setSyncStatus] = useState('جارٍ الاتصال بالسحابة…')

  useEffect(() => {
    let active = true
    const markOffline = () => {
      if (!active) return
      setSyncReady(false)
      setSyncStatus('غير متصل بالإنترنت')
    }
    const markOnline = () => {
      if (!active) return
      setSyncReady(false)
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
        setSyncReady(true)
        setSyncStatus('متصل ومتزامن')
      } else {
        const localCustomers = load<Customer[]>('dd-customers', [])
        const localEntries = load<Entry[]>('dd-entries', [])
        void saveSharedLedger(localCustomers, localEntries, user.uid).then(() => {
          if (!active) return
          setCustomers(localCustomers)
          setEntries(localEntries)
          setSyncReady(true)
          setSyncStatus('تم رفع البيانات المحلية إلى السحابة')
        }).catch(() => {
          if (active) {
            setSyncReady(false)
            setSyncStatus(navigator.onLine ? 'تعذر إنشاء الدفتر السحابي' : 'غير متصل بالإنترنت')
          }
        })
      }
    }, () => {
      if (active) {
        setSyncReady(false)
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
  const selectedCustomer = customers.find(c => c.id === selected)
  const customerRows = entries.filter(e => e.customerId === selected).sort((a,b) => b.date.localeCompare(a.date))
  const balanceFor = (cur: Currency) => customerRows.reduce((s,e) => s + (e.currency === cur ? (e.kind === 'debt' ? e.amount : -e.amount) : 0), 0)

  return <main className="app">
    <header className="topbar"><div><div className="brandmark">د</div><div><h1>دفتر الديون</h1><p>دفترك واضح… وحساباتك محفوظة</p></div></div><button className="outline" onClick={() => signOut(auth)}>تسجيل الخروج</button><label className="actor">المستخدم <select value={actor} onChange={e => {setActor(e.target.value); localStorage.setItem('dd-actor', e.target.value)}}><option>صاحب المحل</option><option>الأخ</option></select></label></header>
    <section className="welcome"><div><span className="eyebrow">لوحة الحسابات</span><h2>أهلاً بك 👋</h2><p>تابع ديون زبائنك ودفعاتهم من مكان واحد.</p></div><div className="date">{new Intl.DateTimeFormat('ar', {dateStyle:'full'}).format(new Date())}</div></section>
    <section className="stats">
      <article className="stat"><span className="stat-icon blue"><Wallet size={20}/></span><p>إجمالي الديون بالدولار</p><strong>{money(totals.usd,'USD')}</strong></article>
      <article className="stat"><span className="stat-icon green"><Wallet size={20}/></span><p>إجمالي الديون بالليرة</p><strong>{money(totals.syp,'SYP')}</strong></article>
      <article className="stat"><span className="stat-icon amber"><Users size={20}/></span><p>الزبائن عليهم رصيد</p><strong>{balances.filter(c => c.usd > 0 || c.syp > 0).length}</strong></article>
    </section>
    <section className="actions"><button className="primary" onClick={() => {setKind('debt'); setEntryError(''); setModal('entry')}}><Plus size={18}/> تسجيل دين</button><button className="success" onClick={() => {setKind('payment'); setEntryError(''); setModal('entry')}}><ArrowDownLeft size={18}/> تسجيل دفعة</button><button className="outline" onClick={() => setModal('customer')}><Users size={18}/> إضافة زبون</button></section>
    <section className="panel"><div className="panel-head"><div><h3>الزبائن</h3><p>كل حساباتك في قائمة واحدة</p></div><div className="tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>الكل</button><button className={filter==='owing'?'active':''} onClick={()=>setFilter('owing')}>عليهم ديون</button></div></div>
      <div className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث باسم الزبون أو رقم الهاتف"/></div>
      {shown.length ? <div className="customer-list">{shown.map(c=><button className="customer" key={c.id} onClick={()=>setSelected(c.id)}><span className="avatar">{c.name.slice(0,1)}</span><span className="customer-info"><b>{c.name}</b><small>{c.phone || 'لا يوجد رقم هاتف'}</small></span><span className="customer-bal"><b>{money(c.usd,'USD')}</b><small>{money(c.syp,'SYP')}</small></span><span className="chevron">‹</span></button>)}</div> : <div className="empty"><Users size={30}/><b>ما في زبائن بهالقائمة</b><span>أضف أول زبون وابدأ تسجيل الحسابات.</span><button onClick={()=>setModal('customer')}>إضافة زبون</button></div>}
    </section>
    <footer><span>مسجل الدخول: {user.email}</span><span>{syncStatus}</span></footer>

    {modal && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="dialog"><button className="close" onClick={()=>setModal(null)}><X/></button><h3>{modal==='customer'?'إضافة زبون جديد':kind==='debt'?'تسجيل دين جديد':'تسجيل دفعة'}</h3>
      {modal==='customer' ? <><label>اسم الزبون<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="مثلاً: أحمد محمد"/></label><label>رقم الهاتف (اختياري)<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="05xxxxxxxx"/></label><button className="primary full" onClick={addCustomer} disabled={!name.trim()}><Check size={18}/> حفظ الزبون</button></> :
      <><label>الزبون<select value={entryCustomerId} onChange={e=>setEntryCustomerId(e.target.value)}><option value="">اختر الزبون</option>{customers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>{entryError && <p className="form-error">{entryError}</p>}<div className="switch"><button className={kind==='debt'?'chosen':''} onClick={()=>setKind('debt')}><ArrowUpRight size={17}/> دين</button><button className={kind==='payment'?'chosen':''} onClick={()=>setKind('payment')}><ArrowDownLeft size={17}/> دفعة</button></div><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label><label>العملة<select value={currency} onChange={e=>setCurrency(e.target.value as Currency)}><option value="USD">دولار أمريكي ($)</option><option value="SYP">ليرة سورية (ل.س)</option></select></label><label>ملاحظة (اختياري)<input value={note} onChange={e=>setNote(e.target.value)} placeholder="تفاصيل العملية"/></label><button className={kind==='debt'?'primary full':'success full'} onClick={addEntry} disabled={!entryCustomerId || !(Number(amount)>0)}><Check size={18}/> حفظ العملية</button></>}
    </section></div>}
    {selectedCustomer && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSelected('')}}><section className="dialog detail"><button className="close" onClick={()=>setSelected('')}><X/></button><div className="detail-person"><span className="avatar big">{selectedCustomer.name.slice(0,1)}</span><div><h3>{selectedCustomer.name}</h3><p>{selectedCustomer.phone || 'لا يوجد رقم هاتف'}</p></div></div><div className="detail-bal"><div><small>الرصيد بالدولار</small><b>{money(balanceFor('USD'),'USD')}</b></div><div><small>الرصيد بالليرة</small><b>{money(balanceFor('SYP'),'SYP')}</b></div></div><div className="detail-head"><b>سجل الحركات</b><button onClick={()=>{setKind('debt');setEntryError('');setEntryCustomerId(selectedCustomer.id);setSelected('');setModal('entry')}}><Plus size={16}/> حركة جديدة</button></div>{customerRows.length ? customerRows.map(e=><div className="entry" key={e.id}><span className={e.kind==='debt'?'debt-dot':'pay-dot'}>{e.kind==='debt'?<ArrowUpRight size={16}/>:<ArrowDownLeft size={16}/>}</span><span className="entry-info"><b>{e.kind==='debt'?'دين':'دفعة'}{e.note?' – '+e.note:''}</b><small>{new Date(e.date).toLocaleString('ar')} · {e.actor}</small></span><strong className={e.kind==='debt'?'red':'green-text'}>{e.kind==='debt'?'+':'−'}{money(e.amount,e.currency)}</strong></div>) : <div className="empty compact">لا توجد حركات مسجلة بعد</div>}</section></div>}
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

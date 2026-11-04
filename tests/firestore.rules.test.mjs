import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore'

const projectId = 'demo-daftar-deyoun'
const shopId = 'shop-alpha'

const ownerUid = 'owner-1'
const editorUid = 'editor-1'
const viewerUid = 'viewer-1'
const outsiderUid = 'outsider-1'

let env

const customer = {
  id: 'customer-1',
  name: 'عميل تجريبي',
  phone: '',
  createdAt: '2026-11-04T10:00:00.000Z',
  activeEntryCount: 0,
  lastEntryMutationId: '',
  lastEntryMutationKind: '',
  createdByUid: ownerUid,
  updatedByUid: ownerUid,
}

function customerFor(uid, id) {
  return {
    id,
    name: 'عميل اختبار',
    phone: '',
    createdAt: '2026-11-04T10:00:00.000Z',
    activeEntryCount: 0,
    lastEntryMutationId: '',
    lastEntryMutationKind: '',
    createdByUid: uid,
    updatedByUid: uid,
  }
}

before(async () => {
  const rules = fs.readFileSync(
    new URL('../firestore.rules', import.meta.url),
    'utf8',
  )

  env = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules,
    },
  })
})

beforeEach(async () => {
  await env.clearFirestore()

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()

    await setDoc(doc(db, 'shops', shopId, 'members', ownerUid), {
      uid: ownerUid,
      role: 'owner',
      createdAt: '2026-11-04T10:00:00.000Z',
    })

    await setDoc(doc(db, 'shops', shopId, 'members', editorUid), {
      uid: editorUid,
      role: 'editor',
      createdAt: '2026-11-04T10:00:00.000Z',
    })

    await setDoc(doc(db, 'shops', shopId, 'members', viewerUid), {
      uid: viewerUid,
      role: 'viewer',
      createdAt: '2026-11-04T10:00:00.000Z',
    })

    await setDoc(doc(db, 'shops', shopId, 'meta', 'schema'), {
      version: 2,
      status: 'ready',
      initializedByUid: ownerUid,
    })

    await setDoc(
      doc(db, 'shops', shopId, 'customers', 'customer-1'),
      customer,
    )
  })
})

after(async () => {
  if (env) await env.cleanup()
})

test('Firestore security rules: roles and membership', async (t) => {
  const ownerDb = env.authenticatedContext(ownerUid, {
    email: 'owner@example.com',
  }).firestore()

  const editorDb = env.authenticatedContext(editorUid, {
    email: 'editor@example.com',
  }).firestore()

  const viewerDb = env.authenticatedContext(viewerUid, {
    email: 'viewer@example.com',
  }).firestore()

  const outsiderDb = env.authenticatedContext(outsiderUid, {
    email: 'outsider@example.com',
  }).firestore()

  await t.test('owner can read customer data', async () => {
    await assertSucceeds(
      getDoc(doc(ownerDb, 'shops', shopId, 'customers', 'customer-1')),
    )
  })

  await t.test('editor can read customer data', async () => {
    await assertSucceeds(
      getDoc(doc(editorDb, 'shops', shopId, 'customers', 'customer-1')),
    )
  })

  await t.test('viewer can read customer data', async () => {
    await assertSucceeds(
      getDoc(doc(viewerDb, 'shops', shopId, 'customers', 'customer-1')),
    )
  })

  await t.test('outsider cannot read customer data', async () => {
    await assertFails(
      getDoc(doc(outsiderDb, 'shops', shopId, 'customers', 'customer-1')),
    )
  })

  await t.test('viewer cannot create a customer', async () => {
    await assertFails(
      setDoc(
        doc(viewerDb, 'shops', shopId, 'customers', 'viewer-customer'),
        customerFor(viewerUid, 'viewer-customer'),
      ),
    )
  })

  await t.test('editor can create a valid customer', async () => {
    await assertSucceeds(
      setDoc(
        doc(editorDb, 'shops', shopId, 'customers', 'editor-customer'),
        customerFor(editorUid, 'editor-customer'),
      ),
    )
  })

  await t.test('editor can update allowed customer fields', async () => {
    await assertSucceeds(
      updateDoc(
        doc(editorDb, 'shops', shopId, 'customers', 'customer-1'),
        {
          name: 'اسم تم تعديله',
          updatedByUid: editorUid,
          updatedAt: '2026-11-04T11:00:00.000Z',
        },
      ),
    )
  })

  await t.test('editor cannot promote self to owner', async () => {
    await assertFails(
      updateDoc(
        doc(editorDb, 'shops', shopId, 'members', editorUid),
        { role: 'owner' },
      ),
    )
  })

  await t.test('owner cannot assign owner role through member update', async () => {
    await assertFails(
      updateDoc(
        doc(ownerDb, 'shops', shopId, 'members', editorUid),
        { role: 'owner' },
      ),
    )
  })

  await t.test('viewer cannot list shop members', async () => {
    await assertFails(
      getDocs(collection(viewerDb, 'shops', shopId, 'members')),
    )
  })

  await t.test('outsider cannot list shop members', async () => {
    await assertFails(
      getDocs(collection(outsiderDb, 'shops', shopId, 'members')),
    )
  })
})

test('Firestore security rules: membership management', async (t) => {
  const ownerDb = env.authenticatedContext(ownerUid, {
    email: 'owner@example.com',
  }).firestore()

  const editorDb = env.authenticatedContext(editorUid, {
    email: 'editor@example.com',
  }).firestore()

  await t.test('owner can add an editor', async () => {
    await assertSucceeds(
      setDoc(doc(ownerDb, 'shops', shopId, 'members', 'new-editor'), {
        uid: 'new-editor',
        email: 'new-editor@example.com',
        role: 'editor',
        createdAt: '2026-11-04T12:00:00.000Z',
      }),
    )
  })

  await t.test('owner can add a viewer', async () => {
    await assertSucceeds(
      setDoc(doc(ownerDb, 'shops', shopId, 'members', 'new-viewer'), {
        uid: 'new-viewer',
        email: 'new-viewer@example.com',
        role: 'viewer',
        createdAt: '2026-11-04T12:00:00.000Z',
      }),
    )
  })

  await t.test('owner cannot create another owner', async () => {
    await assertFails(
      setDoc(doc(ownerDb, 'shops', shopId, 'members', 'new-owner'), {
        uid: 'new-owner',
        email: 'new-owner@example.com',
        role: 'owner',
        createdAt: '2026-11-04T12:00:00.000Z',
      }),
    )
  })

  await t.test('editor cannot add a member', async () => {
    await assertFails(
      setDoc(doc(editorDb, 'shops', shopId, 'members', 'editor-invite'), {
        uid: 'editor-invite',
        email: 'invite@example.com',
        role: 'viewer',
        createdAt: '2026-11-04T12:00:00.000Z',
      }),
    )
  })

  await t.test('owner can change an editor to viewer', async () => {
    await assertSucceeds(
      updateDoc(
        doc(ownerDb, 'shops', shopId, 'members', editorUid),
        { role: 'viewer' },
      ),
    )
  })

  await t.test('owner can delete an editor membership', async () => {
    await assertSucceeds(
      (async () => {
        const memberRef = doc(ownerDb, 'shops', shopId, 'members', editorUid)
        await import('firebase/firestore').then(({ deleteDoc }) => deleteDoc(memberRef))
      })(),
    )
  })

  await t.test('owner cannot delete own membership', async () => {
    const { deleteDoc } = await import('firebase/firestore')

    await assertFails(
      deleteDoc(doc(ownerDb, 'shops', shopId, 'members', ownerUid)),
    )
  })

  await t.test('owner can add a UID without a verified Auth account', async () => {
    await assertSucceeds(
      setDoc(doc(ownerDb, 'shops', shopId, 'members', 'uid-not-verified'), {
        uid: 'uid-not-verified',
        email: 'not-verified@example.com',
        role: 'viewer',
        createdAt: '2026-11-04T12:00:00.000Z',
      }),
    )
  })
})

async function seedFinancialCustomer(customerId, entryId = null, entryData = null) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    const data = customerFor(ownerUid, customerId)

    if (entryId) {
      data.activeEntryCount = 1
      data.lastEntryMutationId = entryId
      data.lastEntryMutationKind = 'add'
    }

    await setDoc(doc(db, 'shops', shopId, 'customers', customerId), data)

    if (entryId && entryData) {
      await setDoc(doc(db, 'shops', shopId, 'entries', entryId), entryData)
    }
  })
}

function makeEntry(entryId, customerId, uid, email) {
  return {
    id: entryId,
    customerId,
    kind: 'debt',
    amount: 100,
    currency: 'USD',
    note: 'اختبار أمني',
    actor: email,
    date: '2026-11-04T12:00:00.000Z',
    actorUid: uid,
    createdByUid: uid,
    updatedByUid: uid,
  }
}

test('Firestore security rules: financial integrity', async (t) => {
  const editorDb = env.authenticatedContext(editorUid, {
    email: 'editor@example.com',
  }).firestore()

  await t.test('valid atomic entry creation updates customer counter', async () => {
    const customerId = 'atomic-add-customer'
    const entryId = 'atomic-add-entry'
    await seedFinancialCustomer(customerId)

    const { writeBatch } = await import('firebase/firestore')
    const batch = writeBatch(editorDb)

    batch.update(doc(editorDb, 'shops', shopId, 'customers', customerId), {
      activeEntryCount: 1,
      lastEntryMutationId: entryId,
      lastEntryMutationKind: 'add',
      updatedByUid: editorUid,
    })

    batch.set(
      doc(editorDb, 'shops', shopId, 'entries', entryId),
      makeEntry(entryId, customerId, editorUid, 'editor@example.com'),
    )

    await assertSucceeds(batch.commit())
  })

  // تجهيز سجل صحيح موجود مسبقاً لاختبارات تعديل الدين.
  async function seedEntryForUpdate(suffix) {
    const customerId = `update-${suffix}-customer`
    const entryId = `update-${suffix}-entry`
    const entryData = makeEntry(
      entryId,
      customerId,
      ownerUid,
      'owner@example.com',
    )

    await seedFinancialCustomer(customerId, entryId, entryData)
    return { customerId, entryId }
  }

  async function attemptEntryUpdate(suffix, changes) {
    const { entryId } = await seedEntryForUpdate(suffix)

    return updateDoc(
      doc(editorDb, 'shops', shopId, 'entries', entryId),
      {
        ...changes,
        updatedByUid: editorUid,
        updatedAt: new Date().toISOString(),
      },
    )
  }

  await t.test('editor can update a valid amount and note', async () => {
    await assertSucceeds(
      attemptEntryUpdate('valid', {
        amount: 125,
        note: 'تعديل مشروع للمبلغ والملاحظة',
      }),
    )
  })

  await t.test('entry amount cannot be negative', async () => {
    await assertFails(
      attemptEntryUpdate('negative-amount', { amount: -50 }),
    )
  })

  await t.test('entry amount cannot be zero', async () => {
    await assertFails(
      attemptEntryUpdate('zero-amount', { amount: 0 }),
    )
  })

  await t.test('entry currency cannot be unsupported', async () => {
    await assertFails(
      attemptEntryUpdate('invalid-currency', { currency: 'EUR' }),
    )
  })

  await t.test('entry customerId cannot be changed', async () => {
    await assertFails(
      attemptEntryUpdate('change-customer', {
        customerId: 'another-customer',
      }),
    )
  })

  await t.test('entry actorUid cannot be changed', async () => {
    await assertFails(
      attemptEntryUpdate('change-actor-uid', {
        actorUid: outsiderUid,
      }),
    )
  })

  await t.test('entry createdByUid cannot be changed', async () => {
    await assertFails(
      attemptEntryUpdate('change-creator-uid', {
        createdByUid: outsiderUid,
      }),
    )
  })

  await t.test('entry actor identity cannot be changed', async () => {
    await assertFails(
      attemptEntryUpdate('change-actor', {
        actor: 'forged@example.com',
      }),
    )
  })

  await t.test('entry date cannot be changed', async () => {
    await assertFails(
      attemptEntryUpdate('change-date', {
        date: '2030-01-01T00:00:00.000Z',
      }),
    )
  })

  await t.test('entry document id cannot be changed', async () => {
    await assertFails(
      attemptEntryUpdate('change-id', {
        id: 'forged-entry-id',
      }),
    )
  })

  await t.test('entry cannot receive an unauthorized extra field', async () => {
    await assertFails(
      attemptEntryUpdate('extra-field', {
        adminOverride: true,
      }),
    )
  })
  await t.test('cannot create an entry without updating customer counter', async () => {
    const customerId = 'entry-only-customer'
    const entryId = 'entry-only-record'
    await seedFinancialCustomer(customerId)

    await assertFails(
      setDoc(
        doc(editorDb, 'shops', shopId, 'entries', entryId),
        makeEntry(entryId, customerId, editorUid, 'editor@example.com'),
      ),
    )
  })

  await t.test('cannot increase customer counter without creating an entry', async () => {
    const customerId = 'counter-only-customer'
    await seedFinancialCustomer(customerId)

    await assertFails(
      updateDoc(
        doc(editorDb, 'shops', shopId, 'customers', customerId),
        {
          activeEntryCount: 1,
          lastEntryMutationId: 'fake-entry',
          lastEntryMutationKind: 'add',
          updatedByUid: editorUid,
        },
      ),
    )
  })

  await t.test('cannot delete an entry without a matching trash record', async () => {
    const customerId = 'delete-no-trash-customer'
    const entryId = 'delete-no-trash-entry'
    const entryData = makeEntry(entryId, customerId, ownerUid, 'owner@example.com')

    await seedFinancialCustomer(customerId, entryId, entryData)

    const { writeBatch, deleteDoc } = await import('firebase/firestore')
    const batch = writeBatch(editorDb)

    batch.delete(doc(editorDb, 'shops', shopId, 'entries', entryId))

    batch.update(doc(editorDb, 'shops', shopId, 'customers', customerId), {
      activeEntryCount: 0,
      lastEntryMutationId: entryId,
      lastEntryMutationKind: 'delete',
      updatedByUid: editorUid,
    })

    await assertFails(batch.commit())
  })

  await t.test('valid atomic entry deletion creates matching trash record', async () => {
    const customerId = 'valid-delete-customer'
    const entryId = 'valid-delete-entry'
    const entryData = makeEntry(entryId, customerId, ownerUid, 'owner@example.com')

    await seedFinancialCustomer(customerId, entryId, entryData)

    const { writeBatch, Timestamp } = await import('firebase/firestore')
    const batch = writeBatch(editorDb)
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const trashId = 'entry-' + entryId

    batch.delete(doc(editorDb, 'shops', shopId, 'entries', entryId))

    batch.update(doc(editorDb, 'shops', shopId, 'customers', customerId), {
      activeEntryCount: 0,
      lastEntryMutationId: entryId,
      lastEntryMutationKind: 'delete',
      updatedByUid: editorUid,
    })

    batch.set(doc(editorDb, 'shops', shopId, 'trash', trashId), {
      id: trashId,
      entityType: 'entry',
      entity: entryData,
      deletedBy: 'editor@example.com',
      deletedByUid: editorUid,
      deletedAt: new Date().toISOString(),
      expiresAt: expires.toISOString(),
      expiresAtTimestamp: Timestamp.fromDate(expires),
    })

    await assertSucceeds(batch.commit())
  })
})

test('Firestore security rules: restore and counter integrity', async (t) => {
  const editorDb = env.authenticatedContext(editorUid, {
    email: 'editor@example.com',
  }).firestore()

  async function seedRestoreFixture(customerId, entryId) {
    const entryData = makeEntry(
      entryId,
      customerId,
      ownerUid,
      'owner@example.com',
    )

    const trashId = 'entry-' + entryId
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const { Timestamp } = await import('firebase/firestore')

    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()

      await setDoc(
        doc(db, 'shops', shopId, 'customers', customerId),
        customerFor(ownerUid, customerId),
      )

      await setDoc(doc(db, 'shops', shopId, 'trash', trashId), {
        id: trashId,
        entityType: 'entry',
        entity: entryData,
        deletedBy: 'owner@example.com',
        deletedByUid: ownerUid,
        deletedAt: new Date().toISOString(),
        expiresAt: expires.toISOString(),
        expiresAtTimestamp: Timestamp.fromDate(expires),
      })
    })

    return { entryData, trashId }
  }

  async function restoreBatch(customerId, entryId, entryData, trashId, deleteTrash) {
    const { writeBatch } = await import('firebase/firestore')
    const batch = writeBatch(editorDb)

    const restoredEntry = {
      ...entryData,
      updatedByUid: editorUid,
      restoredFromTrashId: trashId,
      restoredByUid: editorUid,
    }

    batch.update(
      doc(editorDb, 'shops', shopId, 'customers', customerId),
      {
        activeEntryCount: 1,
        lastEntryMutationId: entryId,
        lastEntryMutationKind: 'restore',
        updatedByUid: editorUid,
      },
    )

    batch.set(
      doc(editorDb, 'shops', shopId, 'entries', entryId),
      restoredEntry,
    )

    if (deleteTrash) {
      batch.delete(doc(editorDb, 'shops', shopId, 'trash', trashId))
    }

    return batch.commit()
  }

  await t.test('valid atomic entry restoration succeeds', async () => {
    const customerId = 'restore-valid-customer'
    const entryId = 'restore-valid-entry'
    const { entryData, trashId } = await seedRestoreFixture(customerId, entryId)

    await assertSucceeds(
      restoreBatch(customerId, entryId, entryData, trashId, true),
    )
  })

  await t.test('tampered entry amount cannot be restored from trash', async () => {
    const customerId = 'restore-tampered-amount-customer'
    const entryId = 'restore-tampered-amount-entry'
    const { entryData, trashId } = await seedRestoreFixture(customerId, entryId)

    const tamperedEntry = {
      ...entryData,
      amount: 999,
      updatedByUid: editorUid,
      restoredFromTrashId: trashId,
      restoredByUid: editorUid,
    }

    await assertFails(
      restoreBatch(customerId, entryId, tamperedEntry, trashId, true),
    )
  })
  await t.test('tampered entry fields cannot be restored from trash', async (t) => {
  const cases = [
    ['kind changed', (entry) => ({ ...entry, kind: 'payment' })],
    ['currency changed', (entry) => ({ ...entry, currency: 'SYP' })],
    ['customerId changed', (entry) => ({ ...entry, customerId: 'another-customer' })],
    ['note changed', (entry) => ({ ...entry, note: 'ملاحظة مزورة' })],
    ['actor changed', (entry) => ({ ...entry, actor: 'forged-actor' })],
    ['date changed', (entry) => ({ ...entry, date: '2030-01-01T00:00:00.000Z' })],
    ['actorUid changed', (entry) => ({ ...entry, actorUid: 'forged-user-999' })],
    ['createdByUid changed', (entry) => ({ ...entry, createdByUid: 'forged-user-999' })],
    ['document id changed', (entry) => ({ ...entry, id: 'forged-entry-id' })],
    ['unauthorized field added', (entry) => ({ ...entry, forged: true })],
    ['original note removed', (entry) => {
      const copy = { ...entry }
      delete copy.note
      return copy
    }],
  ]

  for (const [index, [label, mutate]] of cases.entries()) {
    await t.test(label, async () => {
      const customerId = `restore-tamper-customer-${index}`
      const entryId = `restore-tamper-entry-${index}`
      const { entryData, trashId } = await seedRestoreFixture(customerId, entryId)

      const tamperedEntry = mutate(entryData)

      await assertFails(
        restoreBatch(customerId, entryId, tamperedEntry, trashId, true),
      )
    })
  }
})
await t.test('entry cannot be restored while trash record remains', async () => {
    const customerId = 'restore-no-delete-customer'
    const entryId = 'restore-no-delete-entry'
    const { entryData, trashId } = await seedRestoreFixture(customerId, entryId)

    await assertFails(
      restoreBatch(customerId, entryId, entryData, trashId, false),
    )
  })

  await t.test('cannot delete an entry with a mismatched trash payload', async () => {
    const customerId = 'tampered-trash-customer'
    const entryId = 'tampered-trash-entry'
    const entryData = makeEntry(
      entryId,
      customerId,
      ownerUid,
      'owner@example.com',
    )

    await seedFinancialCustomer(customerId, entryId, entryData)

    const { writeBatch, Timestamp } = await import('firebase/firestore')
    const batch = writeBatch(editorDb)
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const trashId = 'entry-' + entryId

    batch.delete(doc(editorDb, 'shops', shopId, 'entries', entryId))

    batch.update(doc(editorDb, 'shops', shopId, 'customers', customerId), {
      activeEntryCount: 0,
      lastEntryMutationId: entryId,
      lastEntryMutationKind: 'delete',
      updatedByUid: editorUid,
    })

    batch.set(doc(editorDb, 'shops', shopId, 'trash', trashId), {
      id: trashId,
      entityType: 'entry',
      entity: { ...entryData, amount: 999 },
      deletedBy: 'editor@example.com',
      deletedByUid: editorUid,
      deletedAt: new Date().toISOString(),
      expiresAt: expires.toISOString(),
      expiresAtTimestamp: Timestamp.fromDate(expires),
    })

    await assertFails(batch.commit())
  })

  await t.test('customer counter must never become negative', async () => {
    const customerId = 'negative-counter-customer'
    const entryId = 'negative-counter-entry'
    const entryData = makeEntry(
      entryId,
      customerId,
      ownerUid,
      'owner@example.com',
    )

    // نزرع حالة غير متناسقة لاختبار حد الحماية:
    // يوجد دين، لكن العداد يبدأ من صفر.
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()

      await setDoc(
        doc(db, 'shops', shopId, 'customers', customerId),
        customerFor(ownerUid, customerId),
      )

      await setDoc(
        doc(db, 'shops', shopId, 'entries', entryId),
        entryData,
      )
    })

    const { writeBatch, Timestamp } = await import('firebase/firestore')
    const batch = writeBatch(editorDb)
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const trashId = 'entry-' + entryId

    batch.delete(doc(editorDb, 'shops', shopId, 'entries', entryId))

    batch.update(doc(editorDb, 'shops', shopId, 'customers', customerId), {
      activeEntryCount: -1,
      lastEntryMutationId: entryId,
      lastEntryMutationKind: 'delete',
      updatedByUid: editorUid,
    })

    batch.set(doc(editorDb, 'shops', shopId, 'trash', trashId), {
      id: trashId,
      entityType: 'entry',
      entity: entryData,
      deletedBy: 'editor@example.com',
      deletedByUid: editorUid,
      deletedAt: new Date().toISOString(),
      expiresAt: expires.toISOString(),
      expiresAtTimestamp: Timestamp.fromDate(expires),
    })

    // هذا الاختبار يجب أن يُرفض.
    // إذا قُبلت العملية فهناك نقص في حماية العداد.
    await assertFails(batch.commit())
  })
})

test('Firestore security rules: cross-shop isolation', async (t) => {
  const otherShopId = 'shop-beta'
  const otherOwnerUid = 'owner-beta'

  // تجهيز متجر ثانٍ مستقل ببيانات صحيحة، مع تعطيل القواعد للتهيئة فقط.
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()

    await setDoc(
      doc(db, 'shops', otherShopId, 'members', otherOwnerUid),
      {
        uid: otherOwnerUid,
        role: 'owner',
        createdAt: '2026-11-04T10:00:00.000Z',
      },
    )

    await setDoc(
      doc(db, 'shops', otherShopId, 'meta', 'schema'),
      {
        version: 2,
        status: 'ready',
        initializedByUid: otherOwnerUid,
      },
    )

    await setDoc(
      doc(db, 'shops', otherShopId, 'customers', 'beta-customer'),
      customerFor(otherOwnerUid, 'beta-customer'),
    )

    await setDoc(
      doc(db, 'shops', otherShopId, 'entries', 'beta-entry'),
      {
        id: 'beta-entry',
        customerId: 'beta-customer',
      },
    )

    await setDoc(
      doc(db, 'shops', otherShopId, 'activity', 'beta-activity'),
      {
        id: 'beta-activity',
      },
    )

    await setDoc(
      doc(db, 'shops', otherShopId, 'trash', 'beta-trash'),
      {
        id: 'beta-trash',
      },
    )

    await setDoc(
      doc(db, 'shops', otherShopId, 'operations', 'beta-operation'),
      {
        id: 'beta-operation',
      },
    )
  })

  // هذا المستخدم عضو في shop-alpha فقط.
  const editorDb = env.authenticatedContext(editorUid, {
    email: 'editor@example.com',
  }).firestore()

  await t.test('cannot read a customer from another shop', async () => {
    await assertFails(
      getDoc(
        doc(editorDb, 'shops', otherShopId, 'customers', 'beta-customer'),
      ),
    )
  })

  await t.test('cannot list customers from another shop', async () => {
    await assertFails(
      getDocs(
        collection(editorDb, 'shops', otherShopId, 'customers'),
      ),
    )
  })

  await t.test('cannot read entries from another shop', async () => {
    await assertFails(
      getDoc(
        doc(editorDb, 'shops', otherShopId, 'entries', 'beta-entry'),
      ),
    )
  })

  await t.test('cannot read activity from another shop', async () => {
    await assertFails(
      getDoc(
        doc(editorDb, 'shops', otherShopId, 'activity', 'beta-activity'),
      ),
    )
  })

  await t.test('cannot read trash from another shop', async () => {
    await assertFails(
      getDoc(
        doc(editorDb, 'shops', otherShopId, 'trash', 'beta-trash'),
      ),
    )
  })

  await t.test('cannot read operations from another shop', async () => {
    await assertFails(
      getDoc(
        doc(editorDb, 'shops', otherShopId, 'operations', 'beta-operation'),
      ),
    )
  })

  await t.test('cannot create a customer in another shop', async () => {
    await assertFails(
      setDoc(
        doc(editorDb, 'shops', otherShopId, 'customers', 'cross-shop-create'),
        customerFor(editorUid, 'cross-shop-create'),
      ),
    )
  })

  await t.test('cannot update a customer in another shop', async () => {
    await assertFails(
      updateDoc(
        doc(editorDb, 'shops', otherShopId, 'customers', 'beta-customer'),
        {
          name: 'تعديل غير مصرح به',
          updatedByUid: editorUid,
        },
      ),
    )
  })
})
test('Firestore security rules: cross-shop membership protection', async (t) => {
  const otherShopId = 'shop-beta'
  const otherOwnerUid = 'owner-beta'
  const attackerUid = editorUid

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()

    await setDoc(
      doc(db, 'shops', otherShopId, 'members', otherOwnerUid),
      {
        uid: otherOwnerUid,
        role: 'owner',
        createdAt: '2026-11-04T10:00:00.000Z',
      },
    )
  })

  const attackerDb = env.authenticatedContext(attackerUid, {
    email: 'editor@example.com',
  }).firestore()

  await t.test('cannot create a self-membership in another shop', async () => {
    await assertFails(
      setDoc(
        doc(attackerDb, 'shops', otherShopId, 'members', attackerUid),
        {
          uid: attackerUid,
          role: 'owner',
          createdAt: '2026-11-04T10:00:00.000Z',
        },
      ),
    )
  })

  await t.test('cannot add another user to another shop', async () => {
    await assertFails(
      setDoc(
        doc(attackerDb, 'shops', otherShopId, 'members', 'fake-user'),
        {
          uid: 'fake-user',
          role: 'editor',
          createdAt: '2026-11-04T10:00:00.000Z',
        },
      ),
    )
  })

  await t.test('cannot change another shop owner role', async () => {
    await assertFails(
      updateDoc(
        doc(attackerDb, 'shops', otherShopId, 'members', otherOwnerUid),
        {
          role: 'viewer',
        },
      ),
    )
  })

  await t.test('cannot delete another shop owner membership', async () => {
    const { deleteDoc } = await import('firebase/firestore')

    await assertFails(
      deleteDoc(
        doc(attackerDb, 'shops', otherShopId, 'members', otherOwnerUid),
      ),
    )
  })

  await t.test('cannot list members of another shop', async () => {
    await assertFails(
      getDocs(
        collection(attackerDb, 'shops', otherShopId, 'members'),
      ),
    )
  })
})

test('Firestore security rules: customer restoration integrity', async (t) => {
  const editorDb = env.authenticatedContext(editorUid, {
    email: 'editor@example.com',
  }).firestore()

  async function seedCustomerRestore(customerId) {
    const original = customerFor(ownerUid, customerId)
    const trashId = `customer-${customerId}`
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const { Timestamp, writeBatch } = await import('firebase/firestore')

    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()

      await setDoc(doc(db, 'shops', shopId, 'trash', trashId), {
        id: trashId,
        entityType: 'customer',
        entity: original,
        deletedBy: 'owner@example.com',
        deletedByUid: ownerUid,
        deletedAt: new Date().toISOString(),
        expiresAt: expires.toISOString(),
        expiresAtTimestamp: Timestamp.fromDate(expires),
      })
    })

    async function restoreCustomer(entity, deleteTrash = true) {
      const batch = writeBatch(editorDb)

      batch.set(
        doc(editorDb, 'shops', shopId, 'customers', customerId),
        {
          ...entity,
          activeEntryCount: 0,
          lastEntryMutationId: '',
          lastEntryMutationKind: '',
          updatedByUid: editorUid,
          updatedAt: new Date().toISOString(),
          restoredFromTrashId: trashId,
          restoredByUid: editorUid,
        },
      )

      if (deleteTrash) {
        batch.delete(doc(editorDb, 'shops', shopId, 'trash', trashId))
      }

      return batch.commit()
    }

    return { original, trashId, restoreCustomer }
  }

  await t.test('valid atomic customer restoration succeeds', async () => {
    const { original, restoreCustomer } =
      await seedCustomerRestore('customer-restore-valid')

    await assertSucceeds(restoreCustomer(original))
  })

  const attacks = [
    ['name changed', (data) => ({ ...data, name: 'اسم مزور' })],
    ['phone changed', (data) => ({ ...data, phone: '999999999' })],
    ['createdAt changed', (data) => ({ ...data, createdAt: '2030-01-01T00:00:00.000Z' })],
    ['createdByUid changed', (data) => ({ ...data, createdByUid: 'forged-user' })],
    ['original name removed', (data) => {
      const copy = { ...data }
      delete copy.name
      return copy
    }],
    ['unauthorized field added', (data) => ({ ...data, forged: true })],
  ]

  for (const [index, [label, mutate]] of attacks.entries()) {
    await t.test(label, async () => {
      const { original, restoreCustomer } =
        await seedCustomerRestore(`customer-restore-attack-${index}`)

      await assertFails(restoreCustomer(mutate(original)))
    })
  }

  await t.test('customer cannot be restored while trash record remains', async () => {
    const { original, restoreCustomer } =
      await seedCustomerRestore('customer-restore-trash-remains')

    await assertFails(restoreCustomer(original, false))
  })
})


import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyD4cTg3VkW8OQHA1jMukyALqhcYKL0a0Vk',
  authDomain: 'daftar-deyoun-24a60.firebaseapp.com',
  projectId: 'demo-daftar-deyoun',
  storageBucket: 'daftar-deyoun-24a60.firebasestorage.app',
  messagingSenderId: '952498165029',
  appId: '1:952498165029:web:3e1b18017b3888dbba36cc',
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)

if (import.meta.env.DEV) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
}
export const db = initializeFirestore(app, {
  localCache: import.meta.env.DEV
    ? memoryLocalCache()
    : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})

if (import.meta.env.DEV) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}


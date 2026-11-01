import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyD4cTg3VkW8OQHA1jMukyALqhcYKL0a0Vk',
  authDomain: 'daftar-deyoun-24a60.firebaseapp.com',
  projectId: 'daftar-deyoun-24a60',
  storageBucket: 'daftar-deyoun-24a60.firebasestorage.app',
  messagingSenderId: '952498165029',
  appId: '1:952498165029:web:3e1b18017b3888dbba36cc',
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const db = getFirestore(app)

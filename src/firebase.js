// src/firebase.js
// Firebase initialization — the browser talks to Firebase Auth, Firestore, and
// Cloud Storage directly; security rules (firestore.rules / storage.rules)
// enforce per-user access. There is no application server.
import { initializeApp } from 'firebase/app'
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    setPersistence,
    browserLocalPersistence,
    onAuthStateChanged,
} from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

// Public Firebase web config (safe to ship — these identify the project, they're
// not secrets). Values come from the thoughts-vault project.
const firebaseConfig = {
    apiKey: 'AIzaSyAfIJV5TjJeqL1fsRFKFaYrbGIWYFf10W0',
    authDomain: 'thoughts-vault.firebaseapp.com',
    projectId: 'thoughts-vault',
    storageBucket: 'thoughts-vault.firebasestorage.app',
    appId: '1:696878888880:web:ae71a20a2da5904c5e4875',
}

const app = initializeApp(firebaseConfig)

export const fbAuth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)

// Keep the Firebase session in localStorage so it survives reloads.
setPersistence(fbAuth, browserLocalPersistence).catch(() => {})

// Resolves once the SDK finishes restoring any persisted session — with the
// signed-in user, or null if there isn't one. Await this before assuming the
// user is signed out: restoration is asynchronous on page load.
export const authReady = new Promise(resolve => {
    const unsubscribe = onAuthStateChanged(fbAuth, user => {
        unsubscribe()
        resolve(user)
    })
})

const googleProvider = new GoogleAuthProvider()

export async function signInWithGoogle() {
    const result = await signInWithPopup(fbAuth, googleProvider)
    return result.user
}

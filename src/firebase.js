// src/firebase.js
// Firebase JS SDK init for client-side Google sign-in. The resulting Firebase
// ID token is sent to the FastAPI backend (Authorization: Bearer), which already
// verifies any Firebase token via the Admin SDK — so the backend needs no change.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    setPersistence,
    browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'

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
const fbAuth = getAuth(app)
// Keep the Firebase session in localStorage so refresh works across reloads.
setPersistence(fbAuth, browserLocalPersistence).catch(() => {})

const googleProvider = new GoogleAuthProvider()

export async function signInWithGoogle() {
    const result = await signInWithPopup(fbAuth, googleProvider)
    const user = result.user
    const idToken = await user.getIdToken()
    // Firebase manages the refresh token internally; we hand it to the app layer
    // so it can refresh through the same securetoken endpoint the backend uses.
    return {
        idToken,
        refreshToken: user.refreshToken,
        uid: user.uid,
        email: user.email,
    }
}

export { fbAuth }

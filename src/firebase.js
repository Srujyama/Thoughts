import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"

const firebaseConfig = {
  apiKey: "AIzaSyApfh9AznU7_YbozWvvIBmlS3rIYHxC2LA",
  authDomain: "thoughts-8369a.firebaseapp.com",
  projectId: "thoughts-8369a",
  storageBucket: "thoughts-8369a.firebasestorage.app",
  messagingSenderId: "537292847754",
  appId: "1:537292847754:web:b160f1d208da7233738b73",
  measurementId: "G-NKX5K3N6J8"
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)

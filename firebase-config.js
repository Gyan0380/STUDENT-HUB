// Firebase, loaded straight from Google's CDN as ES modules.
// No npm install, no bundler, no build step — this file just works
// when opened via any static host (GitHub Pages, Netlify, Vercel, or
// even file://).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// SAME project as your React app — old Users / Chats data works as-is.
// (These are public client keys, same ones already in your repo's
// firebaseConfig.js — safe to ship in a static site; access control is
// enforced by your firestore.rules, not by hiding this object.)
const firebaseConfig = {
  apiKey: "AIzaSyB5hBbZRyGtLsJ2kzY8Cu0ugK-YRZKamUI",
  authDomain: "studenthub-8beaa.firebaseapp.com",
  projectId: "studenthub-8beaa",
  storageBucket: "studenthub-8beaa.firebasestorage.app",
  messagingSenderId: "927692029336",
  appId: "1:927692029336:web:0dd79be8f099cbda8c3fed"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

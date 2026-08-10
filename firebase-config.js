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
  apiKey: "AIzaSyCDLlqMtCGcKfbchKblBNNLec9Y4AkRXL0",
  authDomain: "student-a866d.firebaseapp.com",
  projectId: "student-a866d",
  storageBucket: "student-a866d.firebasestorage.app",
  messagingSenderId: "742359477068",
  appId: "1:742359477068:web:0d8481cbd5032428a9fde9"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, addDoc, deleteDoc, query, orderBy, onSnapshot, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const root = document.getElementById('app');
let currentUser = null;      // Firestore user doc (+ uid)
let unsubMessages = null;    // active chat listener, torn down on nav
let replyTo = null;

/* ---------------- Theme (Light/Dark) ---------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('studentchat-theme', theme);
}
applyTheme(localStorage.getItem('studentchat-theme') || 'light');
window.setTheme = applyTheme;

/* ---------------- Slugify class names for URLs ---------------- */
function slugify(str) {
  return String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')   // any run of non-alphanumeric -> single dash
    .replace(/^-+|-+$/g, '');      // trim leading/trailing dashes
}

/* ---------------- Age from DOB ---------------- */
function ageFromDob(dob) {
  if (!dob || dob === 'N/A') return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 && age < 100 ? age : null;
}

/* ---------------- Hash Router ----------------
   Every "page" is just #/something — because the server ONLY ever
   needs to serve index.html once, hash changes never hit the server,
   so there is NOTHING to configure on GitHub Pages / Netlify / Vercel.
   This structurally cannot 404 on refresh.
------------------------------------------------ */
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const snap = await getDoc(doc(db, "Users", user.uid));
        currentUser = snap.exists() ? { uid: user.uid, ...snap.data() } : { uid: user.uid, username: "Student", role: "Student" };
      } catch (e) {
        console.error("Firestore error:", e);
        currentUser = { uid: user.uid, role: "Student" };
      }
    } else {
      currentUser = null;
    }
    route();
  });
});

function go(hash) { window.location.hash = hash; }
window.go = go; // used by inline onclick in templates

function currentPath() {
  return (window.location.hash || '#/login').slice(1); // "/login", "/chat/global"
}

function route() {
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  const path = currentPath();
  const chatMatch = path.match(/^\/chat\/([a-z0-9-]+)$/i);

  // Auth gate: protected pages redirect to /login if not signed in
  const protectedPages = ['/home', '/start', '/rules', '/admin'];
  if ((protectedPages.includes(path) || chatMatch) && !currentUser) {
    return go('#/login');
  }

  if (path === '/login') return renderLogin();
  if (path === '/register') return renderRegister();
  if (path === '/forgot-password') return renderForgot();
  if (path === '/home') return renderHome();
  if (path === '/start') return renderStart();
  if (path === '/rules') return renderRules();
  if (path === '/admin') return renderAdmin();
  if (chatMatch) return renderChat(chatMatch[1]);
  if (path === '/' || path === '') return go('#/login');
  return renderNotFound();
}

/* ---------------- Shared bits ---------------- */
function navbar(active) {
  return `
  <nav class="bottom">
    <button class="${active==='home'?'active':''}" onclick="go('#/home')"><span class="ic">🏠</span>Home</button>
    <button class="${active==='chat'?'active':''}" onclick="go('#/chat/global')"><span class="ic">💬</span>Chat</button>
    <button class="${active==='start'?'active':''}" onclick="go('#/start')"><span class="ic">👤</span>Profile</button>
    <button onclick="doLogout()"><span class="ic">🚪</span>Logout</button>
  </nav>`;
}
window.doLogout = async () => { await signOut(auth); go('#/login'); };

/* ---------------- LOGIN ---------------- */
function renderLogin() {
  root.innerHTML = `
  <header><h1>🎓 StudentChat</h1></header>
  <main>
    <div class="card">
      <h2 class="section-title">Login</h2>
      <div id="err" class="err hide"></div>
      <label>Username</label>
      <input id="f-user" placeholder="e.g. ravi_kumar" autocomplete="username">
      <label>Password</label>
      <input id="f-pass" type="password" placeholder="••••••••" autocomplete="current-password">
      <button class="primary" id="btn-login">Login</button>
      <p class="switch-link">Don't have an account? <a onclick="go('#/register')">Register</a></p>
      <p class="switch-link"><a onclick="go('#/forgot-password')">Forgot Password?</a></p>
    </div>
  </main>`;

  document.getElementById('btn-login').onclick = async () => {
    const username = document.getElementById('f-user').value.trim().toLowerCase();
    const password = document.getElementById('f-pass').value;
    const err = document.getElementById('err');
    err.classList.add('hide');
    if (!username || !password) {
      err.textContent = "Username aur password dono chahiye.";
      err.classList.remove('hide');
      return;
    }
    try {
      const email = `${username}@studentchat.com`;
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const snap = await getDoc(doc(db, "Users", cred.user.uid));
      const data = snap.exists() ? snap.data() : {};
      go(data.role === 'Admin' || data.role === 'Owner' ? '#/admin' : '#/home');
    } catch (e) {
      err.textContent = "Invalid Username or Password.";
      err.classList.remove('hide');
    }
  };
}

/* ---------------- REGISTER ---------------- */
function processImageToBase64(file, maxWidth, quality, cb) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * (maxWidth / w)); w = maxWidth; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function renderRegister() {
  root.innerHTML = `
  <header><h1>🎓 Create Account</h1></header>
  <main>
    <div class="card">
      <div id="err" class="err hide"></div>
      <label>Full Name</label><input id="r-name" placeholder="Ravi Kumar">
      <label>Username</label><input id="r-user" placeholder="ravi_kumar">
      <label>Password</label><input id="r-pass" type="password" placeholder="••••••••">
      <label>Date of Birth</label><input id="r-dob" type="date">
      <label>Class Level</label>
      <select id="r-class">
        ${Array.from({length:12},(_,i)=>i+1).map(n=>`<option ${n===9?'selected':''}>Class ${n}</option>`).join('')}
        <option value="12th Pass / College">12th Pass / College</option>
      </select>
      <label>School Name</label><input id="r-school" placeholder="DAV Public School">
      <label>Profile Photo (optional)</label><input id="r-photo" type="file" accept="image/*">
      <button class="primary" id="btn-register">Register</button>
      <p class="switch-link">Already have an account? <a onclick="go('#/login')">Login</a></p>
    </div>
  </main>`;

  document.getElementById('btn-register').onclick = () => {
    const fullName = document.getElementById('r-name').value.trim();
    const username = document.getElementById('r-user').value.trim().toLowerCase();
    const password = document.getElementById('r-pass').value;
    const dob = document.getElementById('r-dob').value;
    const classLevel = document.getElementById('r-class').value;
    const schoolName = document.getElementById('r-school').value.trim();
    const file = document.getElementById('r-photo').files[0];
    const err = document.getElementById('err');
    err.classList.add('hide');

    if (!username || !password || password.length < 6) {
      err.textContent = "Username chahiye aur password kam se kam 6 characters ka.";
      err.classList.remove('hide');
      return;
    }

    const finish = async (photoBase64) => {
      try {
        const email = `${username}@studentchat.com`;
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(doc(db, "Users", cred.user.uid), {
          uid: cred.user.uid,
          fullName: fullName || "Student",
          username,
          dob: dob || "N/A",
          classLevel: classLevel || "Class 9",
          schoolName: schoolName || "Not Provided",
          profilePhoto: photoBase64 || "https://cdn-icons-png.flaticon.com/512/149/149071.png",
          schoolIdUrl: "",
          bio: "",
          role: "Student",
          createdAt: serverTimestamp(),
          isBanned: false,
          timeoutExpiry: null
        });
        go('#/home');
      } catch (e) {
        err.textContent = e.message.includes('email-already-in-use') ? "Yeh username pehle se liya gaya hai." : e.message;
        err.classList.remove('hide');
      }
    };

    if (file) {
      processImageToBase64(file, 500, 0.6, finish);
    } else {
      finish(null);
    }
  };
}

/* ---------------- FORGOT PASSWORD ---------------- */
function renderForgot() {
  root.innerHTML = `
  <header><h1>🔑 Reset Password</h1></header>
  <main>
    <div class="card">
      <div id="msg" class="hide"></div>
      <label>Username</label>
      <input id="fp-user" placeholder="Enter your username">
      <button class="primary" id="btn-fp">Send Reset Link</button>
      <p class="switch-link"><a onclick="go('#/login')">Back to Login</a></p>
    </div>
  </main>`;

  document.getElementById('btn-fp').onclick = async () => {
    const username = document.getElementById('fp-user').value.trim().toLowerCase();
    const msg = document.getElementById('msg');
    msg.className = '';
    try {
      await sendPasswordResetEmail(auth, `${username}@studentchat.com`);
      msg.textContent = "Reset link bhej diya gaya hai (aapke registered email pattern par).";
      msg.className = 'note';
    } catch (e) {
      msg.textContent = "Username nahi mila.";
      msg.className = 'err';
    }
    msg.classList.remove('hide');
  };
}

/* ---------------- HOME ---------------- */
function renderHome() {
  const u = currentUser;
  const classSlug = slugify(u.classLevel || u.class || "Class 9");
  root.innerHTML = `
  <header><h1>🎓 StudentChat</h1><span class="pill">@${u.username}</span></header>
  <main>
    <div class="profile-card">
      <img class="avatar-img" src="${u.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
      <h2>${u.fullName || u.username}</h2>
      <p>${u.schoolName || 'Not Provided'}</p>
      <span class="chip">${u.classLevel || 'N/A'}</span>
    </div>
    <div class="options">
      <div class="opt" onclick="go('#/chat/global')">
        <div class="ic" style="background:#dbeafe;">🌍</div>
        <div class="tx"><b>Global Chat</b><span>Sab verified students ke saath</span></div>
      </div>
      <div class="opt" onclick="go('#/chat/anonymous')">
        <div class="ic" style="background:#ede9fe;">🥷</div>
        <div class="tx"><b>Anonymous Chat</b><span>Naam/DP hidden rehta hai</span></div>
      </div>
      <div class="opt" onclick="go('#/chat/${classSlug}')">
        <div class="ic" style="background:#dcfce7;">🏫</div>
        <div class="tx"><b>My Class Room (${u.classLevel || 'N/A'})</b><span>Sirf apni class ke students</span></div>
      </div>
      <div class="opt" onclick="go('#/rules')">
        <div class="ic" style="background:#fef3c7;">📜</div>
        <div class="tx"><b>Community Rules</b><span>Chat guidelines padhein</span></div>
      </div>
      <div class="opt" onclick="go('#/start')">
        <div class="ic" style="background:#f3e8ff;">✏️</div>
        <div class="tx"><b>Edit Profile</b><span>DP aur bio update karein</span></div>
      </div>
    </div>
  </main>
  ${navbar('home')}`;
}

/* ---------------- EDIT PROFILE (Start) ---------------- */
function renderStart() {
  const u = currentUser;
  root.innerHTML = `
  <header><h1>✏️ Edit Profile</h1></header>
  <main>
    <div class="card">
      <img class="avatar-img" style="margin:0 auto 14px;" src="${u.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
      <label>Profile Photo</label><input id="s-photo" type="file" accept="image/*">
      <label>Bio</label><textarea id="s-bio" rows="3">${u.bio || ''}</textarea>
      <div id="s-msg" class="hide"></div>
      <button class="primary" id="btn-save">Save Changes</button>
      <p class="switch-link"><a onclick="go('#/home')">← Back to Home</a></p>
    </div>

    <h2 class="section-title" style="margin-top:20px;">Appearance</h2>
    <div class="card">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:10px;">Better experience ke liye Light ya Dark mode chuno.</p>
      <div class="theme-toggle">
        <button id="theme-light" class="theme-btn">☀️ Light</button>
        <button id="theme-dark" class="theme-btn">🌙 Dark</button>
      </div>
    </div>
  </main>
  ${navbar('start')}`;

  const active = localStorage.getItem('studentchat-theme') || 'light';
  document.getElementById('theme-light').classList.toggle('active', active === 'light');
  document.getElementById('theme-dark').classList.toggle('active', active === 'dark');
  document.getElementById('theme-light').onclick = () => { setTheme('light'); renderStart(); };
  document.getElementById('theme-dark').onclick = () => { setTheme('dark'); renderStart(); };

  document.getElementById('btn-save').onclick = () => {
    const bio = document.getElementById('s-bio').value.trim();
    const file = document.getElementById('s-photo').files[0];
    const msg = document.getElementById('s-msg');

    const save = async (photoBase64) => {
      const updates = { bio };
      if (photoBase64) updates.profilePhoto = photoBase64;
      try {
        await updateDoc(doc(db, "Users", u.uid), updates);
        Object.assign(currentUser, updates);
        msg.textContent = "Saved ✅";
        msg.className = 'note';
        msg.classList.remove('hide');
      } catch (e) {
        msg.textContent = "Save failed: " + e.message;
        msg.className = 'err';
        msg.classList.remove('hide');
      }
    };
    if (file) processImageToBase64(file, 500, 0.6, save);
    else save(null);
  };
}

/* ---------------- RULES ---------------- */
function renderRules() {
  root.innerHTML = `
  <header><h1>📜 Community Rules</h1></header>
  <main>
    <div class="card">
      <ol class="rules-list">
        <li>Kisi ke saath gaali-galoch ya bullying allowed nahi hai.</li>
        <li>Personal details (address, phone number) share na karein.</li>
        <li>Sirf apni class ke room mein message bhej sakte ho; doosri class ke rooms read-only hain.</li>
        <li>Spam ya baar-baar same message bhejna ban ka reason ban sakta hai.</li>
        <li>Admin/Owner ke decisions final hain.</li>
      </ol>
      <button class="primary" onclick="go('#/home')">Got it, back to Home</button>
    </div>
  </main>
  ${navbar('rules')}`;
}

/* ---------------- CHAT ---------------- */
function renderChat(chatRoomId) {
  const u = currentUser;
  const room = String(chatRoomId).toLowerCase();
  const userClass = slugify(u.classLevel || u.class || "Class 9");
  const isAnonymous = room.includes('anonymous');
  const isGlobal = room === 'global';
  const isAdmin = u.role === 'Admin' || u.role === 'Owner';
  const timeoutExpiry = u.timeoutExpiry?.toDate ? u.timeoutExpiry.toDate() : (u.timeoutExpiry ? new Date(u.timeoutExpiry) : null);
  const isTimedOut = timeoutExpiry && timeoutExpiry.getTime() > Date.now();
  const isRestricted = (u.isBanned || isTimedOut) && !isAdmin;
  const canChat = (isGlobal || isAnonymous || room === userClass || room === `anonymous-${userClass}` || isAdmin) && !isRestricted;

  root.innerHTML = `
  <main style="padding-bottom:80px;">
    <div class="chat-head">
      <span class="back" onclick="go('#/home')">←</span>
      <b>${room.replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase())}</b>
    </div>
    ${!canChat ? `<div class="readonly-banner">🔒 Read-only: aap yahan message nahi bhej sakte.</div>` : ''}
    <div class="msgs" id="msgs"><div class="loading">Loading messages…</div></div>
  </main>
  <div class="composer-wrap">
    <div id="reply-bar-wrap"></div>
    ${canChat ? `
      <div class="composer">
        <input id="chat-input" placeholder="Type a message...">
        <button id="btn-send">➤</button>
      </div>` : `<div class="disabled-note">Read-only mode — send disabled.</div>`}
  </div>`;

  if (canChat) {
    document.getElementById('btn-send').onclick = () => sendMsg(chatRoomId, isAnonymous);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMsg(chatRoomId, isAnonymous);
    });
  }

  const msgsRef = collection(db, "Chats", chatRoomId, "Messages");
  const q = query(msgsRef, orderBy("createdAt", "asc"));
  unsubMessages = onSnapshot(q, (snap) => {
    const wrap = document.getElementById('msgs');
    if (!wrap) return; // navigated away
    wrap.innerHTML = '';
    snap.forEach((d) => {
      const m = d.data();
      const mine = m.senderId === u.uid;
      const canDeleteThis = mine || isAdmin; // admin can delete ANY message
      const div = document.createElement('div');
      div.className = 'msg ' + (mine ? 'right' : 'left');
      div.id = 'msg-' + d.id;
      div.innerHTML = `
        <div class="msg-head">
          ${!isAnonymous ? `<img class="msg-avatar" data-profile="${m.senderId}" src="${m.senderPhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />` : ''}
          <span class="sender ${!isAnonymous ? 'clickable' : ''}" ${!isAnonymous ? `data-profile="${m.senderId}"` : ''}>${escapeHtml(m.senderName || 'Student')}</span>
        </div>
        ${m.replyTo ? `<div class="reply-preview" data-jump="${m.replyTo.id || ''}">↩ <b>${escapeHtml(m.replyTo.senderName||'')}</b>: ${escapeHtml(m.replyTo.text || '').slice(0,40)}</div>` : ''}
        <div class="msg-text">${escapeHtml(m.text || '')}</div>
        <div class="msg-actions">
          <button data-reply="${d.id}">Reply</button>
          ${canDeleteThis ? `<button data-del="${d.id}">Delete${!mine && isAdmin ? ' (admin)' : ''}</button>` : ''}
        </div>`;
      wrap.appendChild(div);

      // Reply: remember original message id too, so we can jump+highlight it later
      div.querySelector('[data-reply]').onclick = () => {
        replyTo = { id: d.id, text: m.text, senderName: m.senderName };
        document.getElementById('reply-bar-wrap').innerHTML =
          `<div class="reply-bar"><span>↩ Replying to <b>${escapeHtml(m.senderName)}</b></span><button id="cancel-reply">✕</button></div>`;
        document.getElementById('cancel-reply').onclick = () => { replyTo = null; document.getElementById('reply-bar-wrap').innerHTML = ''; };
        // Highlight the message being replied to, for both people in the thread
        highlightMessage(d.id);
      };

      const delBtn = div.querySelector('[data-del]');
      if (delBtn) delBtn.onclick = async () => {
        if (confirm('Delete this message?')) await deleteDoc(doc(db, "Chats", chatRoomId, "Messages", d.id));
      };

      // Click the reply-preview quote to jump to + highlight the original message
      const jumpEl = div.querySelector('[data-jump]');
      if (jumpEl && m.replyTo?.id) {
        jumpEl.style.cursor = 'pointer';
        jumpEl.onclick = () => highlightMessage(m.replyTo.id);
      }

      // Click avatar/name to view that person's profile (disabled in Anonymous rooms)
      if (!isAnonymous) {
        div.querySelectorAll('[data-profile]').forEach(el => {
          el.onclick = () => showProfile(m.senderId);
        });
      }
    });
    wrap.scrollTop = wrap.scrollHeight;
  }, (error) => {
    const wrap = document.getElementById('msgs');
    if (wrap) wrap.innerHTML = `<div class="err">Couldn't load messages: ${error.message}</div>`;
  });
}

function highlightMessage(msgId) {
  const el = document.getElementById('msg-' + msgId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1600);
}

/* ---------------- Profile viewer (click DP/name in chat) ---------------- */
async function showProfile(uid) {
  let modal = document.getElementById('profile-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'profile-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="modal-card"><div class="loading">Loading profile…</div></div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  try {
    const snap = await getDoc(doc(db, "Users", uid));
    if (!snap.exists()) throw new Error('User not found');
    const p = snap.data();
    const age = ageFromDob(p.dob);
    modal.innerHTML = `
      <div class="modal-card">
        <button class="modal-close" id="modal-close-btn">✕</button>
        <img class="avatar-img" style="margin:0 auto 12px;" src="${p.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
        <h2 style="text-align:center;">${escapeHtml(p.fullName || p.username || 'Student')}</h2>
        <p style="text-align:center; color:var(--muted); font-size:.82rem;">@${escapeHtml(p.username || '')}</p>
        <div class="profile-fact-list">
          <div class="fact"><span>School</span><b>${escapeHtml(p.schoolName || 'Not Provided')}</b></div>
          <div class="fact"><span>Class</span><b>${escapeHtml(p.classLevel || 'N/A')}</b></div>
          <div class="fact"><span>Age</span><b>${age !== null ? age + ' yrs' : 'Not shared'}</b></div>
        </div>
        ${p.bio ? `<p class="profile-bio">"${escapeHtml(p.bio)}"</p>` : ''}
      </div>`;
    document.getElementById('modal-close-btn').onclick = () => modal.remove();
  } catch (e) {
    modal.innerHTML = `<div class="modal-card"><button class="modal-close" onclick="document.getElementById('profile-modal').remove()">✕</button><div class="err">Couldn't load profile.</div></div>`;
  }
}
window.showProfile = showProfile;

async function sendMsg(chatRoomId, isAnonymous) {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const u = currentUser;
  try {
    await addDoc(collection(db, "Chats", chatRoomId, "Messages"), {
      text,
      senderId: u.uid,
      senderName: isAnonymous ? "Anonymous Ninja" : u.username,
      senderPhoto: isAnonymous ? "https://cdn-icons-png.flaticon.com/512/1752/1752184.png" : (u.profilePhoto || "https://cdn-icons-png.flaticon.com/512/149/149071.png"),
      createdAt: serverTimestamp(),
      replyTo: replyTo
    });
    replyTo = null;
    document.getElementById('reply-bar-wrap').innerHTML = '';
  } catch (e) {
    alert("Message send nahi hua: " + e.message);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- ADMIN ---------------- */
function renderAdmin() {
  const u = currentUser;
  if (u.role !== 'Admin' && u.role !== 'Owner') {
    root.innerHTML = `
    <main>
      <div class="card">
        <b>Access denied.</b>
        <p style="font-size:.82rem; color:var(--muted); margin-top:8px;">
          Aapka account "${escapeHtml(u.role || 'Student')}" role pe hai. Admin panel dekhne ke liye
          role Firestore mein "Admin" ya "Owner" hona chahiye — koi bhi apne aap ko admin nahi bana sakta
          (security ke liye). Pehli baar kisi ko Owner banane ke liye Firebase Console → Firestore →
          <code>Users/${u.uid}</code> document kholo aur field <code>role</code> ko manually
          <code>"Owner"</code> set karo. Uske baad woh Owner is Admin panel se doosron ko Admin bana sakta hai.
        </p>
        <button class="primary" onclick="go('#/home')">Back to Home</button>
      </div>
    </main>`;
    return;
  }

  const allClasses = Array.from({length:12},(_,i)=>`Class ${i+1}`).concat(['12th Pass / College']);
  const classChips = allClasses.map(c => `<button class="chip-btn" onclick="go('#/chat/${slugify(c)}')">${c}</button>`).join('');

  root.innerHTML = `
  <header style="background:#111827;"><h1>👑 Admin Panel</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <h2 class="section-title">Jump into any class chat</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:10px;">Admin/Owner ko sab class rooms mein access hai — inside a room, aap kisi ka bhi message delete kar sakte ho.</p>
      <div class="chip-row">
        <button class="chip-btn" onclick="go('#/chat/global')">Global</button>
        <button class="chip-btn" onclick="go('#/chat/anonymous')">Anonymous</button>
        ${classChips}
      </div>
    </div>

    <h2 class="section-title">Send Global Notification</h2>
    <div class="card" style="margin-bottom:20px;">
      <textarea id="notif-text" rows="2" placeholder="e.g. Tomorrow's test postponed to Friday"></textarea>
      <button class="primary" id="btn-notif">Send to Everyone</button>
      <div id="notif-msg" class="hide"></div>
    </div>

    ${u.role === 'Owner' ? `
    <h2 class="section-title">Grant / Revoke Admin (Owner only)</h2>
    <div class="card" style="margin-bottom:20px;">
      <label>Username</label>
      <input id="grant-user" placeholder="username to promote/demote">
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="primary" id="btn-grant" style="margin-top:0;">Make Admin</button>
        <button class="primary" id="btn-revoke" style="margin-top:0; background:#dc2626;">Remove Admin</button>
      </div>
      <div id="grant-msg" class="hide"></div>
    </div>` : ''}

    <p class="switch-link">Ban/timeout tools abhi is static version mein nahi hain — bolo toh add kar dunga.</p>
  </main>`;

  document.getElementById('btn-notif').onclick = async () => {
    const text = document.getElementById('notif-text').value.trim();
    const msg = document.getElementById('notif-msg');
    if (!text) return;
    try {
      await addDoc(collection(db, "Notifications"), {
        text, createdAt: serverTimestamp(), sentBy: u.username
      });
      msg.textContent = "Sent ✅";
      msg.className = 'note';
    } catch (e) {
      msg.textContent = "Failed: " + e.message;
      msg.className = 'err';
    }
    msg.classList.remove('hide');
  };

  if (u.role === 'Owner') {
    const setRole = async (newRole) => {
      const uname = document.getElementById('grant-user').value.trim().toLowerCase();
      const msg = document.getElementById('grant-msg');
      msg.classList.remove('hide');
      if (!uname) { msg.textContent = 'Username likho.'; msg.className = 'err'; return; }
      try {
        const snap = await getDocs(query(collection(db, "Users"), where("username", "==", uname)));
        if (snap.empty) { msg.textContent = 'User nahi mila.'; msg.className = 'err'; return; }
        const targetDoc = snap.docs[0];
        await updateDoc(doc(db, "Users", targetDoc.id), { role: newRole });
        msg.textContent = `@${uname} ab ${newRole} hai ✅`;
        msg.className = 'note';
      } catch (e) {
        msg.textContent = 'Failed: ' + e.message;
        msg.className = 'err';
      }
    };
    document.getElementById('btn-grant').onclick = () => setRole('Admin');
    document.getElementById('btn-revoke').onclick = () => setRole('Student');
  }
}

/* ---------------- 404 ---------------- */
function renderNotFound() {
  root.innerHTML = `
  <main>
    <div class="card" style="text-align:center;">
      <div style="font-size:2.4rem;">🤷</div>
      <h2 class="section-title" style="margin-top:10px;">Page Not Found</h2>
      <p style="color:var(--muted); font-size:.85rem; margin-bottom:14px;">Yeh room exist nahi karta ya aapke paas permission nahi hai.</p>
      <button class="primary" onclick="go('#/home')">Go Home</button>
    </div>
  </main>`;
}

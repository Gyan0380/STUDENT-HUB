# StudentChat — Static (HTML/CSS/JS + Firebase) version

No npm, no build step, no Vite. Just 4 files: `index.html`, `style.css`, `app.js`, `firebase-config.js`.
Firebase is loaded straight from Google's CDN as ES modules.

## Why this fixes the 404-on-refresh problem permanently

This version uses **hash routing** (`#/chat/global`, `#/chat/class-9`, etc.) instead of real URL paths.
A `#` fragment is never sent to the server — the browser only ever asks the server for one file,
`index.html`, no matter what page you're on. There is nothing to configure (no `_redirects`,
no `vercel.json` rewrites) because the server never sees a route it doesn't know about.

## Test it right now (no setup needed)

Just open `index.html` directly in a browser (double-click it), or run any static server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

It talks to the **same Firebase project** as your React app (`studenthub-8beaa`), same `Users` and
`Chats` collections — so your existing accounts and messages work as-is. No data migration needed.

## Deploy to GitHub Pages (free, 2 minutes)

1. Push this folder's contents to a GitHub repo (root of the repo, or a `/docs` folder).
2. Repo → **Settings → Pages** → Source: choose your branch and the folder (`/` or `/docs`).
3. Save. GitHub gives you a URL like `https://yourname.github.io/repo-name/`.
4. Done — refreshing any page, including `/#/chat/class-9`, always works.

## Deploy to Vercel / Netlify

Also works with zero config — just point either at this folder as a **static site** (no build command,
no output directory needed, since there's no build step at all).

## What's included vs. the full React app

| Feature | Included |
|---|---|
| Login / Register / Forgot Password | ✅ |
| Home, class-aware chat links | ✅ |
| Global / Anonymous / Class chat rooms (Class 1–12 + 12th Pass/College), real-time | ✅ |
| Reply-to-message with click-to-jump highlight | ✅ — clicking a quoted reply scrolls to and flashes the original message |
| Delete own message | ✅ |
| Admin can delete **any** message in **any** room | ✅ |
| Click a sender's DP/name in chat → view their profile (school, class, age) | ✅ — disabled in Anonymous rooms, since identity is meant to stay hidden there |
| Read-only mode for other classes | ✅ |
| Edit Profile (DP + bio, same Base64 canvas compression) | ✅ |
| Light / Dark mode toggle (Edit Profile page, saved across visits) | ✅ |
| Community Rules page | ✅ |
| Admin: send global notification, jump into any class chat | ✅ |
| Admin: ban/timeout tools | ⚠️ Not ported yet — say the word if you want them added |
| Owner: grant/revoke Admin access by username | ✅ (Owner role only) |
| Swipe-to-reply / hold-to-delete gestures | Simplified to tap buttons (touch gesture libraries need more code — same result, one tap away) |

## How to actually get into the Admin Panel

Nobody can self-promote to Admin/Owner for security reasons — this is by design, not a bug.
First time setup:
1. Register a normal account.
2. Open **Firebase Console → Firestore Database → Users → (your uid)**.
3. Edit the `role` field from `"Student"` to `"Owner"`.
4. Log out and back in — you'll land straight on `/admin`.
5. From there, as Owner, you can promote/demote any other username to Admin right from the panel — no more manual Firestore edits needed after this one-time bootstrap.

## Firestore rules

Uses your existing `firestore.rules` and Firebase project — but this version adds **3 new collections**
that your rules need to allow (read/write for signed-in users is enough for all of them):
- `Notifications` — global + personal notifications (bell icon on Home)
- `TeacherApplications` — "Apply for Teacher" submissions
- `Tags` — custom tags created from the Admin Panel

If you're using permissive rules like `allow read, write: if request.auth != null;` at the top level,
nothing to change. If your rules are collection-specific, add matching rules for these three.

## What's new in this update

- **Registration validation** — every field is required except the profile photo; a popup names the
  exact missing field.
- **4 themes** — Light, Dark, Sepia, Ocean (Edit Profile → Appearance). Dark-mode contrast bug fixed
  (some text used to stay a fixed color and become unreadable against the dark background).
- **Notification bell** — Home screen has a 🔔 button with an unread badge. Tapping it opens
  `#/notifications`, listing both admin broadcasts and personal notifications (e.g. teacher approval).
- **Tags** — every user gets tags: a class tag (Class 1–12 / Pass — all share one color), a role tag
  (Student / Teacher / Principal), and an Admin tag visible only to other admins. Admins can create
  custom tags (their own label + color) from the Admin Panel and assign them to any user.
- **Multiple class access** — a user's `classAccess` array can hold more than one class, so students or
  teachers with access to several class rooms see all of them on Home.
- **Apply for Teacher** — new Home button opens a form: Name, Class(es) (multi-select), Subjects
  (searchable multi-select), School Name, School Teacher ID Card (photo) — all required. Submits to a
  pending queue.
- **Admin Panel additions**:
  - **Teacher Applications** — see pending applications with the ID card photo, Approve or Reject.
    Approving grants the Teacher tag, subject tags, class-room access, and delete rights in those class
    rooms, and sends the user a notification. Rejecting sends a rejection notification.
  - **Manage Users** — search any username, edit their name/school/bio, class-room access, role tag,
    custom tags, and Admin/Owner role — full profile edit from one place.
  - **Tag management** — see all tags and their colors, create new custom tags.
  - **Send Notification** now has a title + goes to everyone as a proper Notification doc they'll see
    in the bell.

## About a hosted demo / admin access

This app talks to **your own Firebase project** — there's no separate "demo" version with its own data,
and nobody but you (or whoever controls your Firebase console) can hand out Owner/Admin access, because
that status lives in your Firestore database, not in this code. To try it yourself: run it locally
(see "Test it right now" above), register an account, then follow "How to actually get into the Admin
Panel" below to make that account Owner.

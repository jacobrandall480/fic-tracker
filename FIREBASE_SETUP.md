# Firebase setup (one-time, ~10 minutes)

The app stores your library in Firebase (Auth + Firestore) so it syncs between devices.

`src/firebase.js` already contains the config for the existing `fic-tracker-f51f5` project, so
**you only need this guide if you're setting up your own, separate Firebase project** (for example,
self-hosting a copy for someone else).

## 1. Create the project
1. Go to https://console.firebase.google.com
2. Click **Add project**, give it any name (e.g. "fic-tracker"), and finish the setup wizard.
   (You can decline Google Analytics — not needed.)

## 2. Turn on email/password sign-in
1. In the left sidebar: **Build → Authentication → Get started**
2. Under **Sign-in method**, click **Email/Password**, enable it, and **Save**.
3. Under **Settings → Authorized domains**, add your Cloudflare Pages domain
   (e.g. `fic-tracker.pages.dev`) if it isn't listed.

## 3. Create the database
1. Left sidebar: **Build → Firestore Database → Create database**
2. Pick any region close to you.
3. Start in **production mode** (rules are set below).

## 4. Lock down the security rules
1. In Firestore, go to the **Rules** tab.
2. Replace the contents with this, then click **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Each user's data lives under `users/{uid}` — the user document itself (lists: series,
collections, favorite authors) plus subcollections such as `fics`, the trash, and
`private/ao3Credentials`. The `{document=**}` wildcard covers all of them, so a signed-in user can
read and write *their own* data and nobody else's.

## 5. Get your config and paste it in
1. Click the gear icon (top left, next to "Project Overview") → **Project settings**.
2. Scroll to **Your apps** → click the **Web** icon (`</>`) → register the app (skip Firebase
   Hosting — the app is hosted on Cloudflare Pages).
3. Copy the `firebaseConfig` object it shows you.
4. Open `src/firebase.js` and replace the existing values with yours:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

These values aren't secret — access is controlled by the rules in step 4.

## 6. Build and deploy
```
npm install
npm run deploy
```
See the README's **Deploying / self-hosting** section for the Cloudflare one-time setup.

## 7. Use it
Open the deployed site, create an account with any email/password (it doesn't need to be an inbox
you check — just something you'll remember), and sign in the same way on your phone. Same email +
password = same library, synced automatically.

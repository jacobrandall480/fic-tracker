# Firebase setup (one-time, ~10 minutes)

This app needs a free Firebase project to store your library and sync it between devices.

## 1. Create the project
1. Go to https://console.firebase.google.com
2. Click **Add project**, give it any name (e.g. "fic-tracker"), and finish the setup wizard.
   (You can decline Google Analytics — not needed.)

## 2. Turn on email/password sign-in
1. In the left sidebar: **Build → Authentication → Get started**
2. Under **Sign-in method**, click **Email/Password**, enable it, and **Save**.

## 3. Create the database
1. Left sidebar: **Build → Firestore Database → Create database**
2. Pick any region close to you.
3. Start in **production mode** (we'll set rules manually below).

## 4. Lock down the security rules
1. In Firestore, go to the **Rules** tab.
2. Replace the contents with this, then click **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

This means only a signed-in user can read or write *their own* library — nobody else's.

## 5. Get your config and paste it in
1. Click the gear icon (top left, next to "Project Overview") → **Project settings**.
2. Scroll to **Your apps** → click the **Web** icon (`</>`) → register the app (you can skip Firebase Hosting, it's not needed since you're deploying via Netlify).
3. Copy the `firebaseConfig` object it shows you.
4. Open `src/firebase.js` in this project and paste your values in, replacing the placeholders:

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

## 6. Build and deploy
```
npm install
npm run build
```
This creates a `dist` folder — drag that into Netlify's deploy zone (same way you deployed before).

## 7. Use it
Open the deployed site, create an account with any email/password (it doesn't need to be a real inbox you check —
just something you'll remember), and do the same sign-in on your phone. Same email + password = same library, synced
automatically.

---

**If you ever need to change something in the app:** edit the files locally, run `npm run build` again, and drag the
new `dist` folder into Netlify's "Need to update your site?" drop zone to push the update live.

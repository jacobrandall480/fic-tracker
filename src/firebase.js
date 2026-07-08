import { initializeApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, writeBatch, getDocs, deleteField,
} from "firebase/firestore";

/*
  ── Fill this in with your own Firebase project's config ──
  See FIREBASE_SETUP.md in this project for step-by-step instructions.
  These values are not secret — Firebase web config is meant to be public;
  access is controlled by the security rules you set in the Firebase console.
*/
const firebaseConfig = {
  apiKey: "AIzaSyCGE8jIdiI5PWsbwWfjDgE3umZPBArhRnw",
  authDomain: "fic-tracker-f51f5.firebaseapp.com",
  projectId: "fic-tracker-f51f5",
  storageBucket: "fic-tracker-f51f5.firebasestorage.app",
  messagingSenderId: "584317901929",
  appId: "1:584317901929:web:1dfc62bab2ec88dc0d56f8",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}
export function signUp(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}
export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export function signOutUser() {
  return signOut(auth);
}

const defaultLists = { collections: [], favoriteAuthors: [], series: [] };

// Firestore caps writeBatch at 500 operations — stay comfortably under that so a single
// large import/migration never trips the limit, splitting into multiple sequential
// batches when needed.
const BATCH_CHUNK = 450;

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += BATCH_CHUNK) {
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_CHUNK).forEach((op) => {
      if (op.type === "set") batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    });
    await batch.commit();
  }
}

/**
 * One-time migration: the library used to be stored as a single `fics` array field on
 * the users/{uid} document. Firestore caps any one document at 1MB, and a long-time
 * user's library eventually grows past that — every write then starts failing outright,
 * which is exactly what was happening here. This moves each fic out into its own small
 * document under users/{uid}/fics/{ficId} — a Firestore *collection* has no realistic
 * size ceiling, only individual documents do, and a single fic (even a long one) will
 * never approach 1MB on its own.
 * Runs once: if the subcollection already has documents, assumes migration already
 * happened and does nothing.
 */
async function migrateIfNeeded(uid, userSnap) {
  const data = userSnap.exists() ? userSnap.data() : null;
  const oldFics = data && Array.isArray(data.fics) ? data.fics : null;
  if (!oldFics || oldFics.length === 0) return false;

  const ficsCol = collection(db, "users", uid, "fics");
  const existing = await getDocs(ficsCol);
  if (!existing.empty) return false; // already migrated at some point — don't redo it

  const ops = oldFics.map((fic, i) => {
    const id = fic.id || `migrated-${i}-${Date.now()}`;
    const { id: _drop, ...rest } = fic;
    return { type: "set", ref: doc(db, "users", uid, "fics", id), data: rest };
  });
  await commitInChunks(ops);

  // Shrink the user doc back down by removing the old array field now that everything's
  // safely copied — this is what actually frees the document from the 1MB ceiling.
  await updateDoc(doc(db, "users", uid), { fics: deleteField() });
  return true;
}

/** Subscribes to realtime updates for this user's library. Creates the user doc if it
 * doesn't exist yet, and runs the one-time fics-array → per-fic-documents migration
 * (see migrateIfNeeded) before starting the live subscriptions, so the very first
 * snapshot the listeners see already reflects the migrated, correct state. */
export async function watchLibrary(uid, cb, onError) {
  const reportError = onError || ((e) => console.error("watchLibrary error", e));
  const userRef = doc(db, "users", uid);

  try {
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, { lists: defaultLists });
    } else {
      await migrateIfNeeded(uid, userSnap);
    }
  } catch (e) {
    console.error("library migration check failed", e);
    reportError(e);
    // Deliberately keep going rather than return here — even if migration itself failed,
    // the live subscriptions below might still work for whatever's already in the new
    // collection, and their own error handlers will report anything still broken.
  }

  const ficsCol = collection(db, "users", uid, "fics");

  let latestFics = null;
  let latestLists = null;
  function emit() {
    if (latestFics !== null && latestLists !== null) {
      cb({ fics: latestFics, lists: latestLists });
    }
  }

  // Without an error callback here, a permissions/rules problem on this path (a common
  // gotcha: Firestore security rules don't automatically cascade to subcollections, so a
  // rule covering users/{uid} does NOT automatically also cover users/{uid}/fics/{ficId}
  // unless written to) would cause onSnapshot to just stop silently — latestFics would
  // stay null forever, emit() would never fire, and the app would hang on its loading
  // screen indefinitely with no indication anything was wrong. This surfaces it instead.
  const unsubFics = onSnapshot(
    ficsCol,
    (snap) => {
      latestFics = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    },
    (e) => {
      console.error("fics subscription error", e);
      reportError(e);
    }
  );

  const unsubUser = onSnapshot(
    userRef,
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      latestLists = { ...defaultLists, ...(data?.lists || {}) };
      emit();
    },
    (e) => {
      console.error("user doc subscription error", e);
      reportError(e);
    }
  );

  return () => { unsubFics(); unsubUser(); };
}

/**
 * Writes a batched diff against the per-fic-document collection: `upserts` are fics to
 * create or overwrite (their `id` becomes the document id). `deletedFics` are full fic
 * objects (not just ids) being removed — they get moved into a parallel `trash`
 * subcollection (with a `deletedAt` timestamp) rather than permanently deleted, so an
 * accidental delete (including a full-replace JSON import that drops fics it doesn't
 * know about) is recoverable. Only the documents that actually changed are touched.
 */
export async function saveFicsDiff(uid, upserts, deletedFics) {
  const ops = [];
  (upserts || []).forEach((fic) => {
    if (!fic.id) throw new Error("saveFicsDiff: every fic needs an id");
    const { id, ...rest } = fic;
    ops.push({ type: "set", ref: doc(db, "users", uid, "fics", id), data: rest });
  });
  (deletedFics || []).forEach((fic) => {
    if (!fic.id) return;
    const { id, ...rest } = fic;
    ops.push({ type: "delete", ref: doc(db, "users", uid, "fics", id) });
    ops.push({ type: "set", ref: doc(db, "users", uid, "trash", id), data: { ...rest, deletedAt: Date.now() } });
  });
  if (ops.length === 0) return;
  await commitInChunks(ops);
}

/** Subscribes to realtime updates for the trash subcollection. */
export function watchTrash(uid, cb, onError) {
  const reportError = onError || ((e) => console.error("watchTrash error", e));
  const trashCol = collection(db, "users", uid, "trash");
  return onSnapshot(
    trashCol,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => {
      console.error("trash subscription error", e);
      reportError(e);
    }
  );
}

/** Moves trashed fics back into the live library. */
export async function restoreFromTrash(uid, trashedFics) {
  const ops = [];
  (trashedFics || []).forEach((fic) => {
    if (!fic.id) return;
    const { id, deletedAt, ...rest } = fic;
    ops.push({ type: "set", ref: doc(db, "users", uid, "fics", id), data: rest });
    ops.push({ type: "delete", ref: doc(db, "users", uid, "trash", id) });
  });
  if (ops.length === 0) return;
  await commitInChunks(ops);
}

/** Permanently removes trash entries — either ones the user explicitly emptied, or ones
 * past their retention window (see purgeExpiredTrash). This is the one operation in the
 * whole app that's still a true, unrecoverable hard delete — by design, since the entire
 * point of trash is to have exactly one deliberate final step before data is really gone. */
export async function permanentlyDeleteTrash(uid, ficIds) {
  const ops = (ficIds || []).map((id) => ({ type: "delete", ref: doc(db, "users", uid, "trash", id) }));
  if (ops.length === 0) return;
  await commitInChunks(ops);
}

/** Client-side fallback for auto-expiry: deletes any trash entries older than maxAgeDays.
 * This runs once per app load (see App.jsx) so expiry happens even without configuring a
 * server-side Firestore TTL policy — though setting up real TTL (Firestore console →
 * select the `trash` collection group → TTL → field `deletedAt`) is the more robust
 * option, since it expires entries even if the app isn't opened for a while. Both can
 * safely coexist; this is just a safety net for whichever isn't configured.
 */
export async function purgeExpiredTrash(uid, trashItems, maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const expiredIds = (trashItems || []).filter((f) => (f.deletedAt || 0) < cutoff).map((f) => f.id);
  if (expiredIds.length === 0) return;
  await permanentlyDeleteTrash(uid, expiredIds);
}

export function saveLists(uid, lists) {
  return updateDoc(doc(db, "users", uid), { lists });
}

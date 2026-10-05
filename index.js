const {initializeApp, getApps} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getFirestore} = require('firebase-admin/firestore');
const {onUserCreated, onUserDeleted} = require('firebase-functions/v2/identity');
const {HttpsError, onCall} = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');

if (!getApps().length) initializeApp();

const auth = getAuth();
const firestore = getFirestore();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const normalizeUserProfile = (uid, overrides = {}) => {
  const createdAt = overrides.createdAt || overrides.metadata?.creationTime || new Date().toISOString();
  const profile = {
    authUid: uid,
    id: uid,
    uid,
    role: 'driver',
    name: overrides.name || '',
    email: overrides.email || '',
    phone: overrides.phone || '',
    license: overrides.license || '',
    exp: overrides.exp || '',
    car: overrides.car ?? '',
    co: overrides.co || '',
    on: overrides.on ?? 1,
    createdAt
  };

  if (typeof overrides.username === 'string' && overrides.username.trim()) profile.username = overrides.username.trim();
  if (typeof overrides.displayName === 'string' && overrides.displayName.trim()) profile.name = overrides.displayName.trim();
  return profile;
};

exports.provisionDriverProfile = onUserCreated({region: 'asia-southeast1'}, async event => {
  const user = event.data;
  if (!user || !user.uid) return;

  const userRef = firestore.collection('users').doc(user.uid);
  const profile = normalizeUserProfile(user.uid, {
    name: user.displayName || '',
    email: user.email || '',
    createdAt: user.metadata?.creationTime || new Date().toISOString()
  });

  await firestore.runTransaction(async transaction => {
    const existing = await transaction.get(userRef);
    if (!existing.exists) transaction.set(userRef, profile, {merge: true});
  });
});

exports.removeDeletedUserProfile = onUserDeleted({region: 'asia-southeast1'}, async event => {
  const uid = event.data?.uid;
  if (!uid) return;

  const batch = firestore.batch();
  batch.delete(firestore.collection('users').doc(uid));
  batch.delete(firestore.collection('drivers').doc(uid));
  await batch.commit();
});

exports.adminUpdateDriverAccount = onCall({region: 'asia-southeast1'}, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in as an administrator to manage driver accounts.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'This account is not authorized to manage driver accounts.');

  const data = request.data || {};
  const uid = typeof data.uid === 'string' ? data.uid.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  const username = typeof data.username === 'string' ? data.username.trim() : '';
  const licenseExpiry = typeof data.licenseExpiry === 'string' ? data.licenseExpiry : '';
  const password = typeof data.password === 'string' ? data.password : '';

  if (!uid || uid.length > 128) throw new HttpsError('invalid-argument', 'A valid driver account ID is required.');
  if (!validEmail(email)) throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  if (username.length < 2 || username.length > 64) throw new HttpsError('invalid-argument', 'Username must be between 2 and 64 characters.');
  if (!validDate(licenseExpiry)) throw new HttpsError('invalid-argument', 'Enter a valid license expiration date.');
  if (password && password.length < 8) throw new HttpsError('invalid-argument', 'Password must be at least 8 characters long.');

  const userRef = firestore.collection('users').doc(uid);
  const [userSnapshot, authUser] = await Promise.all([
    userRef.get(),
    auth.getUser(uid)
  ]);
  if (!userSnapshot.exists) throw new HttpsError('not-found', 'The driver profile was not found.');

  const previousProfile = userSnapshot.data();
  if (String(previousProfile.role || '').toLowerCase() !== 'driver') {
    throw new HttpsError('failed-precondition', 'The selected account is not a driver profile.');
  }

  const profile = {
    ...previousProfile,
    authUid: uid,
    id: uid,
    uid,
    role: 'driver',
    name: username,
    email,
    exp: licenseExpiry,
    updatedAt: new Date().toISOString()
  };
  delete profile.password;
  delete profile.passwordHash;

  const authUpdate = {email, displayName: username};
  if (password) authUpdate.password = password;

  try {
    await userRef.set(profile, {merge: true});
    await auth.updateUser(uid, authUpdate);
  } catch (error) {
    try {
      await userRef.set(previousProfile);
    } catch (rollbackError) {
      logger.error('User profile rollback failed after account update error.', {uid, rollbackError});
    }
    logger.error('Driver account update failed.', {uid, authUid: authUser.uid, error});
    throw new HttpsError('internal', 'The driver account could not be fully updated. No profile changes were retained.');
  }

  return {ok: true, uid};
});

exports.adminDeleteDriverAccount = onCall({region: 'asia-southeast1'}, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in as an administrator to manage driver accounts.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'This account is not authorized to manage driver accounts.');

  const uid = typeof request.data?.uid === 'string' ? request.data.uid.trim() : '';
  if (!uid || uid.length > 128) throw new HttpsError('invalid-argument', 'A valid driver account ID is required.');

  const userRef = firestore.collection('users').doc(uid);
  const driverRef = firestore.collection('drivers').doc(uid);
  const [userSnapshot, driverSnapshot] = await Promise.all([userRef.get(), driverRef.get()]);
  if (!userSnapshot.exists) throw new HttpsError('not-found', 'The driver profile was not found.');

  const previousProfile = userSnapshot.data();
  if (String(previousProfile.role || '').toLowerCase() !== 'driver') {
    throw new HttpsError('failed-precondition', 'The selected account is not a driver profile.');
  }

  let authAccountExists = true;
  try {
    await auth.getUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') authAccountExists = false;
    else throw error;
  }

  const deletion = firestore.batch();
  deletion.delete(userRef);
  deletion.delete(driverRef);
  await deletion.commit();

  try {
    if (authAccountExists) await auth.deleteUser(uid);
  } catch (error) {
    try {
      const rollback = firestore.batch();
      rollback.set(userRef, previousProfile);
      if (driverSnapshot.exists) rollback.set(driverRef, driverSnapshot.data());
      await rollback.commit();
    } catch (rollbackError) {
      logger.error('Driver profile rollback failed after account deletion error.', {uid, rollbackError});
    }
    logger.error('Driver account deletion failed.', {uid, error});
    throw new HttpsError('internal', 'The driver account could not be fully deleted.');
  }

  return {ok: true, uid};
});

const {getApps, initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getDatabase} = require('firebase-admin/database');
const {getStorage} = require('firebase-admin/storage');

const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const execute = process.argv.includes('--execute') || process.env.EXECUTE_DEMO_DATA_CLEANUP === 'true';
const shouldWrite = execute && !dryRun;

const projectId = process.env.FIREBASE_PROJECT_ID || 'pbts-fleetsync';
const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://pbts-fleetsync-default-rtdb.asia-southeast1.firebasedatabase.app';

const protectedEmails = new Set((process.env.PROTECTED_EMAILS || 'admin@fleetsync.local,admin@pbts-fleetsync.com').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const protectedUids = new Set((process.env.PROTECTED_UIDS || '').split(',').map(v => v.trim()).filter(Boolean));
const protectedNames = new Set(['admin', 'administrator', 'system admin']);

const firestoreCollections = ['users', 'drivers', 'vehicles', 'trips', 'auditLogs', 'expenses', 'triageIssues'];
const demoTripIds = new Set(['TRP-0031', 'TRP-0032', 'TRP-0040']);
const demoAuditIds = new Set(['a1']);
const demoVehicleSignatures = new Set(['Van 2|ABC-123', 'Car 5|CAR-555', 'Car 3|CAR-333', 'Car 1|CAR-111']);
const demoDriverSignatures = new Set(['Ramon|+63 917 000 0001', 'Ana|+63 917 000 0002', 'Jun|+63 917 000 0003']);
const realtimeNodes = [
  'fleetSync/users',
  'fleetSync/drivers',
  'fleetSync/vehicles',
  'fleetSync/trips',
  'fleetSync/auditLogs',
  'fleetSync/expenses',
  'fleetSync/triageIssues'
];

function isProtectedUser(record = {}) {
  const uid = String(record.authUid || record.uid || record.id || '').trim();
  const email = String(record.email || '').trim().toLowerCase();
  const name = String(record.name || record.username || '').trim().toLowerCase();
  const role = String(record.role || '').trim().toLowerCase();

  return role === 'admin' ||
    uid && protectedUids.has(uid) ||
    email && protectedEmails.has(email) ||
    name && protectedNames.has(name) ||
    /^admin$/i.test(name) ||
    /^fleetsync admin$/i.test(name);
}

function matchesDemoPattern(value) {
  if (value == null) return false;
  return /(^|[^a-z0-9])(demo|sample|test|mock|dummy|trash|temp|example)(?=$|[^a-z0-9])/i.test(String(value));
}

function recordLooksLikeDemo(record = {}, documentId = '') {
  const fields = [record.name, record.username, record.email, record.phone, record.plate, record.id, documentId, record.title, record.reference, record.description];
  const key = String(documentId || record.id || '');
  const vehicleSignature = `${String(record.name || '').trim()}|${String(record.plate || '').trim().toUpperCase()}`;
  const driverSignature = `${String(record.name || '').trim()}|${String(record.phone || '').trim()}`;
  return fields.some(matchesDemoPattern) || demoTripIds.has(key) || demoAuditIds.has(key) ||
    demoVehicleSignatures.has(vehicleSignature) || demoDriverSignatures.has(driverSignature);
}

function storageFileLooksLikeDemo(fileName) {
  return String(fileName).split('/').some(matchesDemoPattern);
}

async function deleteCollectionDocs(firestore, collectionName, predicate) {
  const ref = firestore.collection(collectionName);
  const snapshot = await ref.get();
  const matched = snapshot.docs.filter(doc => predicate(doc.data(), doc.id));
  const deletions = [];

  for (const doc of matched) {
    deletions.push({id: doc.id, ref: ref.doc(doc.id)});
  }

  if (!deletions.length) {
    console.log(`No matching ${collectionName} documents to delete.`);
    return 0;
  }

  if (!shouldWrite) {
    console.log(`[DRY RUN] ${collectionName}: would delete ${deletions.length} documents.`);
    return deletions.length;
  }

  for (let index = 0; index < deletions.length; index += 500) {
    const chunk = deletions.slice(index, index + 500);
    const batch = firestore.batch();
    chunk.forEach(({ref}) => batch.delete(ref));
    await batch.commit();
  }

  console.log(`Deleted ${deletions.length} documents from ${collectionName}.`);
  return deletions.length;
}

async function deleteRealtimeBranch(database, nodePath, predicate) {
  const ref = database.ref(nodePath);
  const snapshot = await ref.once('value');
  const value = snapshot.val();
  const keys = [];

  if (!value || typeof value !== 'object') {
    console.log(`Realtime node ${nodePath} is empty or not an object.`);
    return 0;
  }

  Object.entries(value).forEach(([key, record]) => {
    if (predicate(record, key)) keys.push(key);
  });

  if (!keys.length) {
    console.log(`No matching entries under ${nodePath}.`);
    return 0;
  }

  if (!shouldWrite) {
    console.log(`[DRY RUN] ${nodePath}: would delete ${keys.length} keys.`);
    return keys.length;
  }

  await Promise.all(keys.map(key => ref.child(key).remove()));
  console.log(`Deleted ${keys.length} entries from ${nodePath}.`);
  return keys.length;
}

async function deleteStorageFiles(storage) {
  const bucket = storage.bucket();
  const [files] = await bucket.getFiles();
  const matching = files.filter(file => {
    return storageFileLooksLikeDemo(file.name);
  });

  if (!matching.length) {
    console.log('No demo storage files found.');
    return 0;
  }

  if (!shouldWrite) {
    console.log(`[DRY RUN] Storage: would delete ${matching.length} files.`);
    return matching.length;
  }

  await Promise.all(matching.map(file => file.delete()));
  console.log(`Deleted ${matching.length} storage files.`);
  return matching.length;
}

async function main() {
  if (!execute && !dryRun) {
    console.log('No action requested. Use --execute to delete demo data or --dry-run to preview only.');
    return;
  }

  if (!shouldWrite) {
    console.log('Preview mode enabled. No data will be changed. Use --execute to apply the cleanup.');
  }

  const app = getApps().length ? getApps()[0] : initializeApp({projectId, credential: require('firebase-admin').credential.applicationDefault()});
  const firestore = getFirestore(app);
  const database = getDatabase(app, databaseURL);
  const storage = getStorage(app);

  let totalDeleted = 0;

  for (const collection of firestoreCollections) {
    const result = await deleteCollectionDocs(firestore, collection, (record, docId) => {
      const data = record || {};
      if (isProtectedUser(data)) return false;
      return recordLooksLikeDemo(data, docId);
    });
    totalDeleted += result;
  }

  for (const node of realtimeNodes) {
    const result = await deleteRealtimeBranch(database, node, (record, key) => {
      if (!record || typeof record !== 'object') return false;
      if (isProtectedUser(record)) return false;
      return recordLooksLikeDemo(record, key);
    });
    totalDeleted += result;
  }

  totalDeleted += await deleteStorageFiles(storage);

  console.log(`Cleanup finished. ${shouldWrite ? 'Demo data removed.' : 'Preview complete — no data changed.'} Total flagged: ${totalDeleted}.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Cleanup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {matchesDemoPattern, recordLooksLikeDemo, storageFileLooksLikeDemo};

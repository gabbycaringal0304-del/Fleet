const {isDeepStrictEqual} = require('node:util');
const {getApps, initializeApp, applicationDefault} = require('firebase-admin/app');
const {getDatabase} = require('firebase-admin/database');
const {getFirestore} = require('firebase-admin/firestore');

const projectId = 'pbts-fleetsync';
const databaseURL = 'https://pbts-fleetsync-default-rtdb.asia-southeast1.firebasedatabase.app';
const legacySources = [
  {path: process.env.LEGACY_DRIVERS_PATH || 'fleetSync/drivers', role: 'driver'},
  {path: 'fleetSync/users', role: 'driver'}
];
const batchSize = 400;
const dryRun = !process.argv.includes('--execute') || process.argv.includes('--dry-run');

function asEntries(value) {
  if (Array.isArray(value)) return value.map((record, index) => [String(index), record]).filter(([, record]) => record != null);
  if (value && typeof value === 'object') return Object.entries(value).filter(([, record]) => record != null);
  return [];
}

function toAuthUid(record, key) {
  const uid = record.authUid || record.uid || record.id || key;
  if (typeof uid !== 'string' || !uid.trim() || uid.includes('/')) {
    throw new Error(`Invalid authUid for legacy record ${key}.`);
  }
  return uid;
}

function normalizeUserRecord(record, key, role = 'driver') {
  const authUid = toAuthUid(record, key);
  const createdAt = record.createdAt || record.created_at || record.metadata?.creationTime;
  const normalized = {
    authUid,
    id: authUid,
    uid: authUid,
    role: typeof record.role === 'string' ? record.role : role,
    name: typeof record.name === 'string' ? record.name : (typeof record.username === 'string' ? record.username : ''),
    email: typeof record.email === 'string' ? record.email.trim().toLowerCase() : '',
    phone: typeof record.phone === 'string' ? record.phone : '',
    license: typeof record.license === 'string' ? record.license : '',
    exp: typeof record.exp === 'string' ? record.exp : (typeof record.licenseExpiry === 'string' ? record.licenseExpiry : ''),
    car: record.car ?? '',
    co: typeof record.co === 'string' ? record.co : '',
    on: Number.isFinite(Number(record.on ?? 1)) ? Number(record.on ?? 1) : 1
  };

  if (typeof createdAt === 'string' && createdAt.trim()) normalized.createdAt = createdAt;
  if (typeof record.username === 'string' && !normalized.name) normalized.name = record.username;
  if (typeof record.displayName === 'string' && !normalized.name) normalized.name = record.displayName;
  if (typeof record.email === 'string' && normalized.email === '') normalized.email = record.email.trim().toLowerCase();

  return normalized;
}

async function readLegacySource(database, source) {
  const snapshot = await database.ref(source.path).once('value');
  const entries = asEntries(snapshot.val());
  console.log(`Read ${entries.length} records from RTDB ${source.path}.`);
  return entries.map(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected an object at ${source.path}/${key}; refusing to change its shape.`);
    }
    return {
      documentId: toAuthUid(value, key),
      record: normalizeUserRecord(value, key, source.role),
      sourcePath: `${source.path}/${key}`
    };
  });
}

function assertNoConflictingDuplicates(records) {
  const unique = new Map();
  for (const entry of records) {
    const key = `users/${entry.documentId}`;
    const existing = unique.get(key);
    if (existing && !isDeepStrictEqual(existing.record, entry.record)) {
      throw new Error(`Conflicting legacy records map to ${key}: ${existing.sourcePath} and ${entry.sourcePath}.`);
    }
    unique.set(key, existing || entry);
  }
  return [...unique.values()];
}

async function inChunks(items, callback) {
  for (let index = 0; index < items.length; index += batchSize) {
    await callback(items.slice(index, index + batchSize));
  }
}

async function main() {
  const app = getApps()[0] || initializeApp({projectId, databaseURL, credential: applicationDefault()});
  const database = getDatabase(app, databaseURL);
  const firestore = getFirestore(app);
  const sourceRecords = (await Promise.all(legacySources.map(source => readLegacySource(database, source)))).flat();
  const records = assertNoConflictingDuplicates(sourceRecords);
  const existing = new Map();

  await inChunks(records, async chunk => {
    const snapshots = await firestore.getAll(...chunk.map(entry => firestore.collection('users').doc(entry.documentId)));
    snapshots.forEach((snapshot, index) => existing.set(`users/${chunk[index].documentId}`, snapshot));
  });

  const writes = [];
  for (const entry of records) {
    const key = `users/${entry.documentId}`;
    const snapshot = existing.get(key);
    if (!snapshot.exists) {
      writes.push(entry);
      continue;
    }
    const current = snapshot.data();
    const conflicts = Object.keys(entry.record).filter(field => !isDeepStrictEqual(current[field], entry.record[field]));
    if (conflicts.length) {
      throw new Error(`Firestore ${key} already contains different values for: ${conflicts.join(', ')}. No records were written.`);
    }
  }

  console.log(`Validated ${sourceRecords.length} source records across ${records.length} unique user documents.`);
  console.log(`${writes.length} documents need to be created; ${records.length - writes.length} already match.`);
  if (dryRun) {
    console.log('Dry run complete. No Firestore writes were made.');
    return;
  }

  await inChunks(writes, async chunk => {
    const batch = firestore.batch();
    chunk.forEach(entry => batch.create(firestore.collection('users').doc(entry.documentId), entry.record));
    await batch.commit();
    console.log(`Copied ${Math.min(writes.indexOf(chunk[0]) + chunk.length, writes.length)} of ${writes.length} new user documents.`);
  });

  let verified = 0;
  await inChunks(records, async chunk => {
    const snapshots = await firestore.getAll(...chunk.map(entry => firestore.collection('users').doc(entry.documentId)));
    snapshots.forEach((snapshot, index) => {
      const entry = chunk[index];
      if (!snapshot.exists) throw new Error(`Verification failed: Firestore users/${entry.documentId} is missing.`);
      const current = snapshot.data();
      for (const [field, value] of Object.entries(entry.record)) {
        if (!isDeepStrictEqual(current[field], value)) {
          throw new Error(`Verification failed: users/${entry.documentId}.${field} differs from RTDB.`);
        }
      }
      verified++;
    });
  });

  if (verified !== records.length || sourceRecords.length !== records.length) {
    throw new Error(`Verification count mismatch: ${verified} verified, ${records.length} unique documents, ${sourceRecords.length} source records.`);
  }
  console.log(`Migration verified: ${verified}/${sourceRecords.length} user records copied with matching fields and value types.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {normalizeUserRecord, assertNoConflictingDuplicates, dryRun};
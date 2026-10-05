# FleetSync Admin Function

`adminUpdateDriverAccount` updates a driver's Firebase Authentication email, display name, and optional password, then synchronizes the non-secret profile to Firestore under `users/{uid}`. `adminDeleteDriverAccount` securely removes the driver's Auth account and Firestore profile. Passwords are never written to Firestore.

Only callers whose Firebase Authentication custom claims contain `admin: true` can invoke the function. The existing browser-side Admin profile check is not an authorization boundary for this privileged operation.

Before deployment:

1. Select the intended Firebase project with `firebase use`.
2. Install function dependencies from this directory with `npm install`.
3. Set the `admin: true` custom claim for each authorized administrator using a trusted Admin SDK environment, for example `getAuth().setCustomUserClaims(adminUid, {admin: true})`.
4. Deploy the Auth triggers, account callables, Firestore rules, and admin-only Storage rules with `firebase deploy --only functions,firestore,storage`.

## Legacy Account Migration

`npm run migrate:legacy-rtdb` validates legacy Realtime Database records and previews Firestore changes without writing. Review the output and confirm the intended Firebase project before running `npm run migrate:legacy-rtdb:execute`. Records without a source creation timestamp omit `createdAt` rather than receiving a new timestamp on each run, so duplicate source records compare deterministically.

The browser app calls the functions in `asia-southeast1`. Ensure the selected Firebase project has Cloud Functions billing and required APIs enabled. Admin dashboard reads/writes and vehicle PDF/JPEG/PNG uploads require the `admin: true` custom claim. Firestore rules are configured in `firestore.rules`, and Storage uploads are limited to 10 MB with PDF/JPEG/PNG MIME types in `storage.rules`.

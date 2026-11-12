# Spenza — Deployment Guide

This guide documents how to deploy Spenza to **Firebase Hosting (Spark Tier)** for client assets and **Vercel Hobby** for serverless financial backend operations.

---

## 1. Architectural Strategy: Firebase Spark + Vercel Hobby

### Why Dual-Host Deployment?

1. **Google Cloud Billing Restrictions on Cloud Functions**:
   Deploying Firebase Cloud Functions requires the **Blaze (pay-as-you-go)** billing plan. Google Cloud does not permit deploying Cloud Functions on the free Spark tier, even if traffic stays within free invocation quotas.
2. **Vercel Hobby Serverless Functions**:
   Vercel provides a generous free tier (Hobby plan) supporting Node.js Serverless Functions under the `api/` directory.
3. **The Zero-Cost Guarantee**:
   By deploying the static React PWA to **Firebase Hosting Spark** and routing sensitive financial mutations to **Vercel Hobby**, Spenza operates completely free of infrastructure charges while preserving all server-side security guarantees.

---

## 2. Prerequisites & Accounts

1. **Firebase Account**:
   - Project: `spenza-90037` (or your personal Firebase project).
   - Plan: **Spark (Free)**.
2. **Vercel Account**:
   - Plan: **Hobby (Free)** for personal non-commercial use.
3. **Google Cloud Service Account**:
   - Generated from Firebase Console (Project Settings → Service Accounts → Generate New Private Key).
   - This credential allows the Vercel backend to securely interact with Firestore via the Firebase Admin SDK. Generating this credential does **not** require upgrading to Blaze.

---

## 3. Step-by-Step Deployment Procedure

Follow this deployment sequence to prevent runtime connection errors:

```mermaid
flowchart LR
    A[Step 1: Deploy Vercel Backend] -->|Obtain Vercel URL| B[Step 2: Deploy Firestore Rules & Indexes]
    B -->|Indexes Active| C[Step 3: Build & Deploy Firebase Hosting]
    C -->|Hosting Live| D[Step 4: Configure Authorized Domains & Smoke Test]
```

---

### Step 1: Deploy the Vercel Backend

1. **Connect Repository to Vercel**:
   - In the [Vercel Dashboard](https://vercel.com/), click **Add New...** → **Project**.
   - Import your GitHub repository (`spenza`).
   - Leave Root Directory as `./`.
   - Build Command: Leave default or set to `echo "Backend build only"`.
   - Output Directory: Leave default.
2. **Configure Vercel Environment Variables**:
   Under **Settings** → **Environment Variables**, configure the following:

   | Variable | Value / Format | Description |
   | :--- | :--- | :--- |
   | `FIREBASE_ADMIN_CREDENTIALS` | `{"type":"service_account",...}` | Full JSON string of the downloaded service account key |
   | *OR* `FIREBASE_PROJECT_ID` | `spenza-90037` | Alternative individual service account field |
   | *OR* `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-...@...iam.gserviceaccount.com` | Alternative individual service account field |
   | *OR* `FIREBASE_PRIVATE_KEY` | `"-----BEGIN PRIVATE KEY-----\n..."` | Alternative individual private key |
   | `ALLOWED_ORIGIN` | `https://spenza-90037.web.app` | Production Firebase Hosting domain (for CORS) |

3. **Deploy & Record Backend URL**:
   - Click **Deploy**.
   - Verify that Vercel detects the three API endpoints:
     - `/api/repayment`
     - `/api/settlement`
     - `/api/import`
   - Record your deployed Vercel domain (e.g., `https://spenza-backend.vercel.app`).

---

### Step 2: Deploy Firestore Security Rules & Indexes

Deploy the locked-down security rules and composite indexes to Cloud Firestore:

```bash
# Pin deployment explicitly to production project
npx firebase deploy --project spenza-90037 --only firestore,storage
```

#### Index Build Status:
1. Open the [Firebase Console](https://console.firebase.google.com/) → **Cloud Firestore** → **Indexes**.
2. Locate the composite index for `recurring`.
3. Confirm status is **Enabled / Ready** before deploying the frontend.

---

### Step 3: Build & Deploy Frontend to Firebase Hosting

> ⚠️ **CRITICAL FIREBASE SPARK WARNING**:  
> **NEVER run `firebase deploy` without `--only`.**  
> Running `firebase deploy` without resource filters attempts to deploy Cloud Functions from `functions/`, which will immediately abort with a billing error on the Spark tier. Always specify `--only hosting`.

1. **Configure Production Environment**:
   Ensure `.env.production` (or `.env.local`) points to your live Vercel backend and production Firebase credentials:
   ```env
   VITE_FIREBASE_API_KEY=AIzaSy...
   VITE_FIREBASE_AUTH_DOMAIN=spenza-90037.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=spenza-90037
   VITE_FIREBASE_STORAGE_BUCKET=spenza-90037.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
   VITE_FIREBASE_APP_ID=1:123456789012:web:...

   # LIVE VERCEL BACKEND URL
   VITE_BACKEND_API_URL=https://your-vercel-backend.vercel.app
   ```
2. **Build the Production Bundle**:
   ```bash
   npm run build:prod
   ```
   *Note: `build:prod` enforces fail-closed validation, verifying that `VITE_BACKEND_API_URL` uses HTTPS and does not target localhost.*
3. **Deploy Static Hosting**:
   ```bash
   npx firebase deploy --project spenza-90037 --only hosting
   ```

---

### Step 4: Post-Deployment Configuration & Verification

1. **Google Sign-In Authorized Domains**:
   - Go to [Firebase Console](https://console.firebase.google.com/) → **Authentication** → **Settings** → **Authorized Domains**.
   - Verify that your production hosting domains are listed:
     - `spenza-90037.web.app`
     - `spenza-90037.firebaseapp.com`
     - (Optional custom domain if attached)
2. **End-to-End Smoke Test**:
   - Visit `https://spenza-90037.web.app` in a fresh browser session.
   - Sign in with Google.
   - Record an expense with a split share.
   - Record a partial repayment (verifies `/api/repayment` connectivity and ID token verification).
   - Settle dues in `/app/people` (verifies `/api/settlement` atomic transaction).
   - Import a 2-row test CSV (verifies `/api/import` chunked processor).

---

## 4. Rollback Procedures

### Instant Hosting Rollback
If a frontend bug is discovered in production:
1. Open [Firebase Console](https://console.firebase.google.com/) → **Hosting** → **Release History**.
2. Locate the previous working release.
3. Click `⋮` → **Rollback**. (Or run `firebase hosting:rollback`).

### Vercel Function Rollback
If a backend regression occurs:
1. In the Vercel Dashboard, navigate to **Deployments**.
2. Locate the prior deployment.
3. Click `⋮` → **Promote to Production**.

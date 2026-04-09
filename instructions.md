# Instructions: Card & Reload Distribution Management System (CRDMS)

This document outlines the technical architecture and implementation steps for building a localized, offline-first management system for mobile card and reload distribution.

---

## 1. Core Technical Stack
* **Frontend:** HTML5, Tailwind CSS (CDN for rapid styling).
* **Database:** `Dexie.js` (IndexedDB wrapper) for offline storage and fast local performance.
* **Deployment:** GitHub for version control, Netlify or Vercel for hosting (Syncing with GitHub).
* **Architecture:** Single Page Application (SPA) with tabbed navigation.

---

## 2. Database Schema (Dexie.js)
Define the following tables in your Dexie instance:

* **settings:** `{ id, monthlyTargetAmount }`
* **staff:** `{ id, name, routeName, phone }`
* **dailyIssues:** `{ id, staffId, date, card48, card95, card96, reloadCash, totalIssuedValue }`
* **dailySales:** `{ id, staffId, date, soldCard48, soldCard95, soldCard96, soldReloadCash, returnedCard48, returnedCard95, returnedCard96, handCash, status }`

---

## 3. Key Functional Modules

### A. Admin Dashboard (Morning Setup)
* **Issue Stock:** A form to select a staff member and enter the quantity of cards (Rs. 48, 95, 96) and the Reload Cash amount transferred to their phone.
* **Target View:** A progress bar showing the Monthly Target vs. Total Sales to date.

### B. Staff Interface (Evening Entry)
* Each staff member can log in (or select their name) and enter:
    * Number of cards sold (per category).
    * Value of reloads sold.
    * Cash collected.
    * Any physical cards being returned (unsold).

### C. Logic & Calculations
* **Daily Target Calculation:** `(Monthly Target / 25 Days)` or as per the remaining days in the month.
* **Reconciliation Logic:** * `Expected Cash = (Sold Cards * Value) + Sold Reloads`
    * The system should flag a warning if `Hand Cash != Expected Cash`.

---

## 4. Technical Implementation Steps

### Step 1: UI Structure (HTML/Tailwind)
Create a clean, mobile-responsive layout with three main tabs:
1.  **Overview:** Daily/Monthly summary and target progress.
2.  **Issue:** Morning workflow (Admin only).
3.  **Collection:** Evening workflow (Staff entry).

### Step 2: Logic Implementation (JavaScript)
* **Service Worker:** Include a basic service worker to ensure the app works offline.
* **Sync Strategy:** Use `Dexie.js` to save data locally. To implement online sync, you can later integrate with a cloud provider like Supabase or Firebase, but for now, keep local data as the "Source of Truth."

---

## 5. Instructions for Development

1.  **Initialize Project:** Create `index.html` and link Tailwind CSS via CDN.
2.  **Setup Dexie:**
    ```javascript
    const db = new Dexie("DistributionDB");
    db.version(1).stores({
        staff: '++id, name',
        dailyIssues: '++id, staffId, date',
        dailySales: '++id, staffId, date'
    });
    ```
3.  **Monthly Target Logic:** Store the monthly target in the `settings` table. Calculate the "Today's Target" by dividing the total target by the number of working days.
4.  **Issue Form:** When issuing, calculate the `totalIssuedValue` immediately:
    * `Total = (c48 * 48) + (c95 * 95) + (c96 * 96) + reloadCash`
5.  **Evening Sync:** When staff enters sales data, the system should compare the `issuedQuantity` vs `sold + returnedQuantity`.

---

## 6. Deployment & Maintenance
* **GitHub Desktop:** Push your code to a GitHub repository.
* **Netlify:** Connect the repo to Netlify for automatic deployment.
* **Offline Access:** Once loaded on a phone browser, the app will remain functional even without a signal due to IndexedDB/Dexie.

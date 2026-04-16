// --- Database Configuration (Dexie) ---
const db = new Dexie("DistributionDB");
db.version(3).stores({
    settings: '++id, targetAmount, adminPassword',
    staff: '++id, name, routeName, phone, password',
    dailyIssues: '++id, staffId, date, [date+staffId]',
    dailySales: '++id, staffId, date, [date+staffId]'
});

let currentUser = JSON.parse(localStorage.getItem('crdms_user') || 'null');
let performanceChart = null;

// --- State & DOM Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // Initial sync connection check (optional)
    if(typeof supabaseClient !== 'undefined') console.log("Supabase Client Ready");
    
    // Check local session
    if(currentUser) {
        showApp();
    } else {
        showLogin();
    }

    // Set default dates
    document.getElementById('issue-date').value = getTodayString();
    document.getElementById('collect-date').value = getTodayString();
    const repMonth = document.getElementById('report-month');
    if(repMonth) repMonth.value = getCurrentMonthString();
    updateMonthDisplay();

    // Event Listeners
    setupEventListeners();

    // --- Pull data from Cloud on startup ---
    if(currentUser) {
        pullFromCloud();
    }

    // --- Automatic Sync Triggers ---
    window.addEventListener('online', () => {
        console.log("Internet restored. Syncing...");
        pullFromCloud();
    });

    // Sync when user comes back to the app tab (optional but recommended)
    window.addEventListener('focus', () => {
        if(currentUser) pullFromCloud();
    });

    // --- Supabase Realtime Listeners for Multi-Device Sync ---
    if (typeof supabaseClient !== 'undefined') {
        const handleCloudChange = (payload) => {
            console.log("Cloud change detected:", payload.eventType, payload.table);
            // If something was deleted or the whole table was cleared, we pull to stay in sync
            pullFromCloud();
        };

        // Listen for ANY changes in key tables to keep all devices synchronized
        supabaseClient.channel('db-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, handleCloudChange)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, handleCloudChange)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_sales' }, handleCloudChange)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_issues' }, handleCloudChange)
            .subscribe();
    }
});

function showLogin() {
    document.getElementById('login-container').classList.remove('hidden');
    document.getElementById('app-content').classList.add('hidden');
}

async function showApp() {
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('app-content').classList.remove('hidden');

    document.getElementById('display-user-name').innerText = currentUser.name || 'CRDMS User';
    document.getElementById('display-user-role').innerText = currentUser.role.toUpperCase() + ' MODE';

    // 1. FIRST: Load the DOM structural data
    await loadStaffDropdowns();

    // 2. Role-based UI restriction & Select Enforcements
    const tabs = ['tab-overview', 'tab-issue', 'tab-collection', 'tab-settings', 'tab-reports', 'tab-history'];
    
    if(currentUser.role === 'distributor') {
        document.getElementById('tab-overview').classList.add('hidden');
        document.getElementById('tab-settings').classList.add('hidden');
        document.getElementById('tab-history').classList.add('hidden');
        document.getElementById('tab-issue').classList.remove('hidden');
        document.getElementById('tab-collection').classList.remove('hidden');
        document.getElementById('tab-reports').classList.add('hidden');
        
        switchTab('issue');
        
        const issueStaff = document.getElementById('issue-staff');
        const collectStaff = document.getElementById('collect-staff');
        if(issueStaff && collectStaff) {
            const sId = currentUser.id;
            issueStaff.value = sId;
            collectStaff.value = sId;
            issueStaff.disabled = true;
            collectStaff.disabled = true;
            loadPreviousBalances(); 
            updateStaffPerformanceDisplay(sId);
        }
    } else {
        // Admin: Show EVERYTHING
        tabs.forEach(id => document.getElementById(id).classList.remove('hidden'));
        document.getElementById('admin-distributor-stats').classList.remove('hidden');
        
        // Ensure dropdowns are enabled for Admin
        const issueStaff = document.getElementById('issue-staff');
        const collectStaff = document.getElementById('collect-staff');
        if(issueStaff) issueStaff.disabled = false;
        if(collectStaff) collectStaff.disabled = false;

        switchTab('overview');
    }

    // 3. Load remaining data
    await updateDashboardCard();
    await renderStaffTable();

    // 4. Data Migration for Old Staff
    if(currentUser.role === 'admin') {
        const list = await db.staff.toArray();
        let needsSync = false;
        
        let maxId = 0;
        // First pass: Find the legit max ID (ignoring the random 4-digit ones > 1000)
        list.forEach(s => {
            if (s.sysId && s.sysId.startsWith('DS-')) {
                const num = parseInt(s.sysId.replace('DS-', ''), 10);
                if (!isNaN(num) && num < 1000 && num > maxId) maxId = num;
            }
        });

        for (let s of list) {
            // If sysId is missing OR it's a random one (like DS-4821) assigned previously
            let currentNum = s.sysId ? parseInt(s.sysId.replace('DS-', ''), 10) : 0;
            if (!s.sysId || currentNum >= 1000) {
                maxId++;
                s.sysId = 'DS-' + String(maxId).padStart(4, '0');
                s.joinedDate = s.joinedDate || new Date().toISOString().split('T')[0];
                await db.staff.put(s);
                syncToCloud('staff', {
                    name: s.name, route_name: s.routeName, phone: s.phone,
                    password: s.password, target: s.target, joined_date: s.joinedDate, sys_id: s.sysId
                }, { phone: s.phone });
                needsSync = true;
            }
        }
        if(needsSync) {
            await renderStaffTable();
        }
    }
}

window.logout = function() {
    localStorage.removeItem('crdms_user');
    location.reload();
}

// --- Helper Functions ---
function getTodayString() {
    const today = new Date();
    // Adjust for timezone locally
    const offset = today.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(today - offset)).toISOString().slice(0, 10);
    return localISOTime;
}

function getCurrentMonthString() {
    return getTodayString().slice(0, 7); // YYYY-MM
}

function formatCurrency(amount) {
    return 'Rs. ' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.add('hidden');
    });
    document.querySelectorAll('.nav-item').forEach(nav => {
        nav.classList.remove('nav-active');
        nav.classList.remove('text-indigo-400');
        nav.classList.add('text-gray-400');
    });

    document.getElementById(tabId).classList.remove('hidden');
    
    const activeBtn = document.getElementById('tab-' + tabId);
    activeBtn.classList.add('nav-active');
    activeBtn.classList.remove('text-gray-400');
    activeBtn.classList.add('text-indigo-400');

    // Refresh data if switching to overview
    if(tabId === 'overview') updateDashboardCard();

    // Reset Issue form when entering for Admin
    if(tabId === 'issue' && currentUser.role === 'admin') {
        const issueStaff = document.getElementById('issue-staff');
        if(issueStaff) {
            issueStaff.value = "";
            loadPreviousBalances();
        }
    }
    
    // Reset History view when entering for Admin
    if(tabId === 'history' && currentUser.role === 'admin') {
        const historyStaff = document.getElementById('history-staff');
        const historyResult = document.getElementById('history-result-area');
        if(historyStaff) historyStaff.value = "";
        if(historyResult) historyResult.classList.add('hidden');
    }
    
    // Reset Collection view when entering for Admin
    if(tabId === 'collection' && currentUser.role === 'admin') {
        const collectStaff = document.getElementById('collect-staff');
        if(collectStaff) collectStaff.value = "";
        if(typeof clearCollectionForm === 'function') clearCollectionForm();
    }

    // Reset Reports view when entering for Admin
    if(tabId === 'reports' && currentUser.role === 'admin') {
        const reportStaff = document.getElementById('report-staff');
        const distPerfWrap = document.getElementById('dist-perf-wrap'); // Main report area
        if(reportStaff) reportStaff.value = "";
        if(distPerfWrap) distPerfWrap.classList.add('hidden');
    }
}

function updateMonthDisplay() {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const d = new Date();
    document.getElementById('overview-month').innerText = `${months[d.getMonth()]} ${d.getFullYear()}`;
}

async function showToast(title, icon = 'success') {
    const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        background: '#1e293b',
        color: '#fff'
    });
    Toast.fire({ icon, title });
}

// --- Dashboard Logic ---
async function updateDashboardCard() {
    let targetSetting = await db.settings.toCollection().first();
    let workingDays = targetSetting && targetSetting.workingDays ? targetSetting.workingDays : 25;
    let monthlyTarget = 0;
    let monthSales = [];
    let todayIssuesList = [];
    let todaySalesList = [];
    let currentMonth = getCurrentMonthString();
    let todayStr = getTodayString();

    if(currentUser && currentUser.role === 'distributor') {
        // Distributor Stats
        const staff = await db.staff.get(currentUser.id);
        monthlyTarget = staff ? staff.target : 0;
        
        monthSales = await db.dailySales
            .where({staffId: currentUser.id})
            .filter(record => record.date.startsWith(currentMonth))
            .toArray();
            
        todayIssuesList = await db.dailyIssues.where({date: todayStr, staffId: currentUser.id}).toArray();
        todaySalesList = await db.dailySales.where({date: todayStr, staffId: currentUser.id}).toArray();
        
        // Update header if needed or a sub-label
        document.getElementById('display-user-role').innerText = 'DISTRIBUTOR (' + (staff ? staff.routeName : '') + ')';
    } else {
        // Global Admin Stats
        monthlyTarget = targetSetting ? targetSetting.targetAmount : 0;
        monthSales = await db.dailySales
            .filter(record => record.date.startsWith(currentMonth))
            .toArray();
            
        todayIssuesList = await db.dailyIssues.filter(r => r.date === todayStr).toArray();
        todaySalesList = await db.dailySales.filter(r => r.date === todayStr).toArray();
    }
    
    let totalSales = monthSales.reduce((sum, record) => {
        let saleValue = (Number(record.soldCard48 || 0) * 48) + 
                        (Number(record.soldCard95 || 0) * 95) + 
                        (Number(record.soldCard96 || 0) * 96) + 
                        Number(record.soldReloadCash || 0);
        return sum + saleValue;
    }, 0);

    let totalMonthCommission = monthSales.reduce((sum, record) => sum + (Number(record.totalCommission) || 0), 0);
    const monthFaceValue = totalSales + totalMonthCommission;
    
    // 3. Compute Remaining Days & Dynamic Target
    let uniqueWorkedDays = new Set(monthSales.map(r => r.date)).size;
    let daysLeft = (workingDays || 25) - uniqueWorkedDays;
    if(daysLeft < 1) daysLeft = 1; // At least today is left
    
    const remainingTarget = (monthlyTarget - totalSales) > 0 ? (monthlyTarget - totalSales) : 0;
    const todayTarget = remainingTarget / daysLeft;
    
    // 4. Progress
    let perc = (totalSales / (monthlyTarget || 1)) * 100;
    if(perc > 100) perc = 100;

    let totalTodayIssued = todayIssuesList.reduce((sum, r) => sum + Number(r.totalIssuedValue || 0), 0);
    let totalTodayCollected = todaySalesList.reduce((sum, r) => sum + Number(r.handCash || 0), 0);

    // Update UI
    const targetEl = document.getElementById('metric-monthly-target');
    const salesEl = document.getElementById('metric-monthly-sales');
    const todayTargetEl = document.getElementById('metric-today-target');
    const monthFaceEl = document.getElementById('metric-monthly-face');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressTarget = document.getElementById('progress-target');
    const daysRem = document.getElementById('days-remaining');
    const todayIssued = document.getElementById('metric-today-issued');
    const todayColl = document.getElementById('metric-today-collected');

    if(targetEl) targetEl.innerText = formatCurrency(monthlyTarget);
    if(salesEl) salesEl.innerText = formatCurrency(totalSales);
    if(todayTargetEl) todayTargetEl.innerText = formatCurrency(todayTarget);
    if(monthFaceEl) monthFaceEl.innerText = formatCurrency(monthFaceValue);
    if(progressTarget) progressTarget.innerText = formatCurrency(monthlyTarget);
    
    if(progressBar) progressBar.style.width = perc + '%';
    if(progressText) progressText.innerText = perc.toFixed(1) + '% Completed';
    if(daysRem) daysRem.innerText = `${daysLeft} Working Days Left`;

    if(todayIssued) todayIssued.innerText = formatCurrency(totalTodayIssued);
    if(todayColl) todayColl.innerText = formatCurrency(totalTodayCollected);

    if(currentUser && currentUser.role === 'admin') {
        renderDistributorStats();
    }
    
    if(currentUser && currentUser.role === 'distributor') {
        const infoCards = [document.getElementById('dist-info-card-issue'), document.getElementById('dist-info-card-collect')];
        infoCards.forEach(card => { if(card) card.classList.remove('hidden'); });
        
        document.querySelectorAll('.personal-target').forEach(el => el.innerText = formatCurrency(monthlyTarget));
        document.querySelectorAll('.personal-sales').forEach(el => el.innerText = formatCurrency(totalSales));

        // NEW: Render the Performance Table Row for this Distributor
        const perfRowHtml = `
            <tr class="hover:bg-slate-800/30 transition-colors border-b border-slate-700/50 last:border-0 text-white">
                <td class="py-6 px-6">
                    <div class="font-black text-indigo-400 text-base uppercase tracking-wider">${currentUser.name || 'My Performance'}</div>
                    <div class="text-[10px] text-gray-400 font-bold mt-1">Status: Active Distribution Session</div>
                </td>
                <td class="py-6 px-4 text-center">
                    <div class="text-[9px] text-gray-500 font-black uppercase mb-1">Monthly Goal</div>
                    <div class="text-sm font-bold text-gray-300 font-mono">${formatCurrency(monthlyTarget)}</div>
                </td>
                <td class="py-6 px-4 text-center">
                    <div class="text-[9px] text-orange-400 font-black uppercase mb-1">Dynamic Today Target</div>
                    <div class="text-sm font-black text-white font-mono">${formatCurrency(todayTarget)}</div>
                </td>
                <td class="py-6 px-4 text-center text-base font-black text-emerald-400 font-mono">${formatCurrency(totalSales)}</td>
                <td class="py-6 px-4 text-center text-base font-black text-pink-500 font-mono">${formatCurrency(monthFaceValue)}</td>
                <td class="py-6 px-4 text-center">
                    <div class="flex items-center justify-center space-x-3">
                        <div class="w-24 bg-slate-800 h-2 rounded-full overflow-hidden border border-slate-700">
                            <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-full" style="width: ${perc.toFixed(0)}%"></div>
                        </div>
                        <span class="text-xs font-black text-white">${perc.toFixed(1)}%</span>
                    </div>
                </td>
            </tr>
        `;

        const issueWrap = document.getElementById('dist-perf-issue-wrap');
        const collectWrap = document.getElementById('dist-perf-collect-wrap');
        const issueList = document.getElementById('dist-perf-issue-list');
        const collectList = document.getElementById('dist-perf-collect-list');

        if(issueWrap) issueWrap.classList.remove('hidden');
        if(collectWrap) collectWrap.classList.remove('hidden');
        if(issueList) issueList.innerHTML = perfRowHtml;
        if(collectList) collectList.innerHTML = perfRowHtml;
    } else {
        // Admin: Hide these for admin
        const wraps = [document.getElementById('dist-perf-issue-wrap'), document.getElementById('dist-perf-collect-wrap')];
        wraps.forEach(w => { if(w) w.classList.add('hidden'); });
    }

    // --- Chart Logic ---
    updatePerformanceChart(monthSales, monthlyTarget, workingDays);
    updateProductChart(monthSales);
    checkBackupReminder();
}
async function renderDistributorStats() {
    const searchInput = document.getElementById('distributor-search');
    const query = searchInput ? searchInput.value.toLowerCase() : '';
    
    let list = await db.staff.toArray();
    
    if(query) {
        list = list.filter(s => s.name.toLowerCase().includes(query) || s.routeName.toLowerCase().includes(query));
    }

    const currentMonth = getCurrentMonthString();
    const tbody = document.getElementById('distributor-performance-list');
    if(!tbody) return;

    if(list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-gray-500 italic">${query ? 'No results for "'+query+'"' : 'No distributors found. Add staff in settings.'}</td></tr>`;
        return;
    }

    let html = '';
    
    for (const staff of list) {
        const sales = await db.dailySales
            .where('staffId').equals(staff.id)
            .filter(r => r.date.startsWith(currentMonth))
            .toArray();

        let totalS = 0;
        let totalC = 0;
        sales.forEach(r => {
            const val = (Number(r.soldCard48 || 0) * 48) + (Number(r.soldCard95 || 0) * 95) + (Number(r.soldCard96 || 0) * 96) + Number(r.soldReloadCash || 0);
            totalS += val;
            totalC += Number(r.totalCommission || 0);
        });

        const target = staff.target || 0;
        const perc = target > 0 ? (totalS / target * 100) : 0;
        
        // Calculate dynamic daily target for this specific staff
        const settings = await db.settings.toCollection().first();
        const workedDays = new Set(sales.map(r => r.date)).size;
        const totalWokingDays = settings ? (settings.workingDays || 25) : 25;
        let daysLeft = totalWokingDays - workedDays;
        if(daysLeft < 1) daysLeft = 1;
        const remainingTarget = (target - totalS) > 0 ? (target - totalS) : 0;
        const dynamicDayTarget = remainingTarget / daysLeft;
        
        const lastRec = sales.sort((a,b) => b.date.localeCompare(a.date))[0];
        const sAmt = lastRec ? Number(lastRec.shortageAmt || 0) : 0;
        const bStatus = sAmt > 0.01 ? 'SHORT' : (sAmt < -0.01 ? 'EXCESS' : 'BALANCED');
        const bColor = bStatus === 'EXCESS' ? 'text-emerald-400' : (bStatus === 'SHORT' ? 'text-rose-400' : 'text-gray-500');
        const bLabel = bStatus === 'SHORT' ? `-${formatCurrency(Math.abs(sAmt))}` : (bStatus === 'EXCESS' ? `+${formatCurrency(Math.abs(sAmt))}` : 'BALANCED');

        html += `
            <tr class="hover:bg-slate-800/30 transition-colors border-b border-slate-700/50 last:border-0">
                <td class="py-4 px-6">
                    <div class="font-bold text-white text-sm">${staff.name}</div>
                    <div class="text-[10px] text-gray-500 uppercase font-black">${staff.routeName}</div>
                </td>
                <td class="py-4 px-4 text-center">
                    <div class="text-[9px] text-indigo-400 font-black uppercase mb-1">Monthly</div>
                    <div class="text-xs font-bold text-gray-400 font-mono">${formatCurrency(target)}</div>
                </td>
                <td class="py-4 px-4 text-center">
                    <div class="text-[9px] text-orange-400 font-black uppercase mb-1">Today Target</div>
                    <div class="text-xs font-black text-white font-mono">${formatCurrency(dynamicDayTarget)}</div>
                </td>
                <td class="py-4 px-4 text-center text-sm font-black text-emerald-400 font-mono">${formatCurrency(totalS)}</td>
                <td class="py-4 px-4 text-center text-[11px] font-black ${bColor} font-mono">${bLabel}</td>
                <td class="py-4 px-4 text-center text-sm font-black text-pink-500 font-mono">${formatCurrency(totalS + totalC)}</td>
                <td class="py-4 px-4 text-center">
                    <div class="flex items-center justify-center space-x-2">
                        <div class="w-16 bg-slate-800 h-1.5 rounded-full overflow-hidden border border-slate-700">
                            <div class="bg-indigo-500 h-full" style="width: ${Math.min(perc, 100)}%"></div>
                        </div>
                        <span class="text-[10px] font-bold text-gray-400">${perc.toFixed(0)}%</span>
                    </div>
                </td>
                <td class="py-4 px-6 text-right text-sm font-black text-indigo-400 font-mono">
                    ${formatCurrency(totalC)}
                </td>
            </tr>
        `;
    }

    tbody.innerHTML = html;
}

async function updatePerformanceChart(monthSales, monthlyTarget, workingDays) {
    const ctx = document.getElementById('performanceChart');
    if (!ctx) return;

    // Days in current month
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const labels = Array.from({ length: daysInMonth }, (_, i) => (i + 1).toString());
    
    // Group sales by day
    const dailyData = Array(daysInMonth).fill(0);
    monthSales.forEach(record => {
        const day = parseInt(record.date.split('-')[2]);
        if (day <= daysInMonth) {
            const saleValue = (Number(record.soldCard48 || 0) * 48) + 
                            (Number(record.soldCard95 || 0) * 95) + 
                            (Number(record.soldCard96 || 0) * 96) + 
                            Number(record.soldReloadCash || 0);
            dailyData[day - 1] += saleValue;
        }
    });

    // Daily target baseline
    const dailyTarget = monthlyTarget / (workingDays || 25);
    const targetLine = Array(daysInMonth).fill(dailyTarget);

    if (performanceChart) {
        performanceChart.data.labels = labels;
        performanceChart.data.datasets[0].data = dailyData;
        performanceChart.data.datasets[1].data = targetLine;
        performanceChart.update();
    } else {
        performanceChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Daily Sales (Rs.)',
                        data: dailyData,
                        borderColor: '#6366f1',
                        backgroundColor: (context) => {
                            const chart = context.chart;
                            const {ctx, chartArea} = chart;
                            if (!chartArea) return null;
                            const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
                            gradient.addColorStop(0, 'rgba(99, 102, 241, 0)');
                            gradient.addColorStop(1, 'rgba(99, 102, 241, 0.2)');
                            return gradient;
                        },
                        fill: true,
                        tension: 0.4,
                        borderWidth: 3,
                        pointBackgroundColor: '#6366f1',
                        pointBorderColor: '#fff',
                        pointHoverRadius: 6,
                        pointRadius: 4,
                    },
                    {
                        label: 'Daily Target Baseline',
                        data: targetLine,
                        borderColor: 'rgba(236, 72, 153, 0.5)',
                        borderDash: [5, 5],
                        borderWidth: 2,
                        pointRadius: 0,
                        fill: false,
                        tension: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#94a3b8',
                            usePointStyle: true,
                            font: { weight: '600', size: 11 }
                        }
                    },
                    tooltip: {
                        backgroundColor: '#1e293b',
                        titleColor: '#fff',
                        bodyColor: '#cbd5e1',
                        borderColor: '#334155',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: (context) => formatCurrency(context.parsed.y)
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#64748b', font: { size: 10 } }
                    },
                    y: {
                        grid: { color: 'rgba(51, 65, 85, 0.5)', borderDash: [2, 2] },
                        ticks: { 
                            color: '#64748b', 
                            font: { size: 10 },
                            callback: (val) => 'Rs.' + (val >= 1000 ? (val/1000) + 'k' : val)
                        }
                    }
                }
            }
        });
    }
}


// --- Issue Logic ---
function calculateIssueTotal() {
    const p48 = Number(document.getElementById('issue-prev-c48').value) || 0;
    const n48 = Number(document.getElementById('issue-new-c48').value) || 0;
    const p95 = Number(document.getElementById('issue-prev-c95').value) || 0;
    const n95 = Number(document.getElementById('issue-new-c95').value) || 0;
    const p96 = Number(document.getElementById('issue-prev-c96').value) || 0;
    const n96 = Number(document.getElementById('issue-new-c96').value) || 0;
    const pReload = Number(document.getElementById('issue-prev-reload').value) || 0;
    const nReload = Number(document.getElementById('issue-new-reload').value) || 0;

    const t48 = p48 + n48;
    const t95 = p95 + n95;
    const t96 = p96 + n96;
    const tReload = pReload + nReload;

    document.getElementById('issue-total-c48').value = t48;
    document.getElementById('issue-total-c95').value = t95;
    document.getElementById('issue-total-c96').value = t96;
    
    // NEW: Update individual row logic for value display
    document.getElementById('issue-val-c48').value = formatCurrency(t48 * 48);
    document.getElementById('issue-val-c95').value = formatCurrency(t95 * 95);
    document.getElementById('issue-val-c96').value = formatCurrency(t96 * 96);
    
    document.getElementById('issue-total-reload-disp').innerText = formatCurrency(tReload);
    document.getElementById('issue-total-reload-val').value = tReload;

    const prevTotalValue = (p48 * 48) + (p95 * 95) + (p96 * 96) + pReload;
    const newTotalValue = (n48 * 48) + (n95 * 95) + (n96 * 96) + nReload;
    const grandTotalValue = prevTotalValue + newTotalValue;

    // Calculate Shop Commission expectation and Card Total
    const totalCardCost = (t48 * 48) + (t95 * 95) + (t96 * 96);
    const expectedComm = (t48 * 2) + (t95 * 4) + (t96 * 4); // 50-48=2, 99-95=4, 100-96=4

    document.getElementById('issue-card-total-val').innerText = formatCurrency(totalCardCost);
    document.getElementById('issue-shop-comm-val').innerText = formatCurrency(expectedComm);
    document.getElementById('issue-prev-total-val').innerText = formatCurrency(prevTotalValue);
    document.getElementById('issue-new-total-val').innerText = formatCurrency(newTotalValue);
    document.getElementById('issue-grand-total-val').innerText = formatCurrency(grandTotalValue);
}

async function handleIssueSubmit(e) {
    e.preventDefault();
    const date = document.getElementById('issue-date').value;
    const staffId = document.getElementById('issue-staff').value;
    
    if(!staffId) {
        Swal.fire({ icon: 'warning', title: 'Oops', text: 'Please select a staff member', background: '#1e293b', color: '#fff'});
        return;
    }

    const n48 = Number(document.getElementById('issue-new-c48').value) || 0;
    const n95 = Number(document.getElementById('issue-new-c95').value) || 0;
    const n96 = Number(document.getElementById('issue-new-c96').value) || 0;
    const nReload = Number(document.getElementById('issue-new-reload').value) || 0;

    const p48 = Number(document.getElementById('issue-prev-c48').value) || 0;
    const p95 = Number(document.getElementById('issue-prev-c95').value) || 0;
    const p96 = Number(document.getElementById('issue-prev-c96').value) || 0;
    const pReload = Number(document.getElementById('issue-prev-reload').value) || 0;

    const t48 = p48 + n48;
    const t95 = p95 + n95;
    const t96 = p96 + n96;
    const tReload = pReload + nReload;

    const totalIssuedValue = (n48 * 48) + (n95 * 95) + (n96 * 96) + nReload;

    try {
        let existing = await db.dailyIssues.where('[date+staffId]').equals([date, staffId]).first();
        if(!existing && !isNaN(staffId)) {
            existing = await db.dailyIssues.where('[date+staffId]').equals([date, Number(staffId)]).first();
        }
        
        const data = {
            date, staffId, 
            card48: t48, card95: t95, card96: t96, reloadCash: tReload,
            newC48: n48, newC95: n95, newC96: n96, newReload: nReload,
            prevC48: p48, prevC95: p95, prevC96: p96, prevReload: pReload,
            totalIssuedValue 
        };

        if(existing) {
            let res = await Swal.fire({
                title: 'Overwrite Issue?',
                text: 'Record already exists for this staff today. Overwrite?',
                icon: 'question',
                showCancelButton: true,
                background: '#1e293b',
                color: '#fff'
            });
            if(!res.isConfirmed) return;
            await db.dailyIssues.update(existing.id, data);
        } else {
            await db.dailyIssues.add(data);
        }
        
        showToast('Stock Issued Successfully');
        
        // Reset "New" fields
        ['issue-new-c48', 'issue-new-c95', 'issue-new-c96', 'issue-new-reload'].forEach(id => {
            document.getElementById(id).value = 0;
        });

        // For Admin: Reset staff selection and "Previous" fields
        if(currentUser.role === 'admin') {
            document.getElementById('issue-staff').value = "";
            ['issue-prev-c48', 'issue-prev-c95', 'issue-prev-c96', 'issue-prev-reload', 'issue-new-c48', 'issue-new-c95', 'issue-new-c96', 'issue-new-reload'].forEach(id => {
                const el = document.getElementById(id);
                if(el) el.value = 0;
            });
            // Clear shortage/excess badge
            const cashWrap = document.getElementById('issue-prev-cash-wrap');
            if(cashWrap) cashWrap.classList.add('hidden');
        }

        calculateIssueTotal();
        const currentStaffValue = document.getElementById('issue-staff').value;
        updateStaffPerformanceDisplay(currentStaffValue);
        updateDashboardCard();

        // --- Online Sync ---
        syncToCloud('daily_issues', {
            staff_id: data.staffId,
            date: data.date,
            card48: data.card48,
            card95: data.card95,
            card96: data.card96,
            reload_cash: data.reloadCash,
            total_issued_value: data.totalIssuedValue
        }, { staff_id: data.staffId, date: data.date });

    } catch(err) {
        console.error(err);
        showToast('Error saving data', 'error');
    }
}

window.loadIssueForEdit = async function() {
    const date = document.getElementById('issue-date').value;
    const staffId = document.getElementById('issue-staff').value;
    
    if(!date || !staffId) {
        Swal.fire('Info', 'Please select a staff and date first.', 'info');
        return;
    }

    try {
        // 1. Fetch the actual record for today
        let record = await db.dailyIssues.where('[date+staffId]').equals([date, staffId]).first();
        if(!record && !isNaN(staffId)) {
            record = await db.dailyIssues.where('[date+staffId]').equals([date, Number(staffId)]).first();
        }
        
        if (record) {
            // 2. FIRST, load the previous balances from the day BEFORE this date
            // This populates the 'Yesterday' input fields.
            await loadPreviousBalances();

            // 3. NOW, set the 'New' values by subtracting Yesterday's returns from Total
            const prev48 = Number(document.getElementById('issue-prev-c48').value) || 0;
            const prev95 = Number(document.getElementById('issue-prev-c95').value) || 0;
            const prev96 = Number(document.getElementById('issue-prev-c96').value) || 0;
            const prevReload = Number(document.getElementById('issue-prev-reload').value) || 0;

            // record.card48 is the TOTAL. So New = Total - Yesterday
            document.getElementById('issue-new-c48').value = (record.card48 - prev48);
            document.getElementById('issue-new-c95').value = (record.card95 - prev95);
            document.getElementById('issue-new-c96').value = (record.card96 - prev96);
            document.getElementById('issue-new-reload').value = (record.reloadCash - prevReload);

            calculateIssueTotal();
            showToast('Morning setup loaded for edit');
        } else {
            Swal.fire({
                icon: 'info',
                title: 'No Data',
                text: 'No morning setup found for this date. You can create a new one.',
                background: '#1e293b',
                color: '#fff'
            });
        }
    } catch(err) {
        console.error("Load for edit error:", err);
        showToast('Error loading data: ' + err.message, 'error');
    }
}


// --- Collection Logic ---
let currentIssuedData = null; // Cache
let previousShortage = 0; // State

async function handleLoadExpectedData() {
    const date = document.getElementById('collect-date').value;
    const staffId = document.getElementById('collect-staff').value;
    if(!staffId) return Swal.fire({ icon: 'warning', title: 'Oops', text: 'Select staff first', background: '#1e293b', color: '#fff' });

    try {
        // 1. Try to fetch today's Issue record
        let issued = await db.dailyIssues.where('[date+staffId]').equals([date, staffId]).first();
        if(!issued && !isNaN(staffId)) {
            issued = await db.dailyIssues.where('[date+staffId]').equals([date, Number(staffId)]).first();
        }
        
        // 2. SMART ROLLOVER: If no Issue record exists for today, find the latest state from BEFORE today
        if(!issued) {
            console.log("No morning issue found for today. Looking for the latest snapshot...");
            
            // Re-use logic: Whichever is newer (last Sale or last Issue)
            const lastSale = await db.dailySales.where('staffId').equals(staffId).and(r => r.date < date).sortBy('date').then(res => res[res.length-1]);
            const lastIssue = await db.dailyIssues.where('staffId').equals(staffId).and(r => r.date < date).sortBy('date').then(res => res[res.length-1]);
            
            let source = null;
            let fromSales = false;

            if (lastSale && lastIssue) {
                if (lastSale.date >= lastIssue.date) { source = lastSale; fromSales = true; }
                else { source = lastIssue; fromSales = false; }
            } else if (lastSale) { source = lastSale; fromSales = true; }
            else if (lastIssue) { source = lastIssue; fromSales = false; }

            if (source) {
                // Synthesize an 'issued' object based on what they were carrying
                issued = {
                    staffId: staffId,
                    date: date,
                    card48: fromSales ? (source.returnedCard48 || 0) : (source.card48 || 0),
                    card95: fromSales ? (source.returnedCard95 || 0) : (source.card95 || 0),
                    card96: fromSales ? (source.returnedCard96 || 0) : (source.card96 || 0),
                    reloadCash: fromSales ? (Number(source.availReload || 0) - Number(source.soldReloadCash || 0)) : (source.reloadCash || 0)
                };
                showToast('No issue today: Rolled over yesterday\'s stock', 'info');
            }
        }

        if(!issued) {
            Swal.fire({ icon: 'info', title: 'No Stock Found', text: 'No morning issue or previous carry-over found for this staff.', background: '#1e293b', color: '#fff' });
            document.getElementById('collection-details').classList.add('hidden');
            return;
        }

        currentIssuedData = issued;
        document.getElementById('collection-details').classList.remove('hidden');
        
        // Populate Availabilities
        document.getElementById('avail-c48').value = issued.card48;
        document.getElementById('avail-c95').value = issued.card95;
        document.getElementById('avail-c96').value = issued.card96;
        document.getElementById('avail-reload-disp').innerText = `Stock: Rs. ${issued.reloadCash.toLocaleString()}`;
        document.getElementById('avail-reload-val').value = issued.reloadCash;

        // Reset fields
        ['sold-c48', 'sold-c95', 'sold-c96', 'sold-reload', 'collect-handcash'].forEach(id => document.getElementById(id).value = 0);
        
        // --- NEW: Load Previous Shortage ---
        let lastSale = await db.dailySales
            .where('staffId').equals(staffId)
            .and(r => r.date < date)
            .sortBy('date')
            .then(results => results[results.length - 1]);
            
        if (!lastSale && !isNaN(staffId)) {
            lastSale = await db.dailySales
                .where('staffId').equals(Number(staffId))
                .and(r => r.date < date)
                .sortBy('date')
                .then(results => results[results.length - 1]);
        }

        previousShortage = 0;
        const pBadge = document.getElementById('prev-shortage-badge');
        
        if(lastSale && lastSale.shortageAmt !== 0) {
            previousShortage = lastSale.shortageAmt;
            if(previousShortage > 0) {
                pBadge.innerText = `Prev Shortage: Rs. ${previousShortage}`;
                pBadge.className = "mt-1 text-[9px] font-black uppercase text-red-500 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20 block w-max";
            } else {
                pBadge.innerText = `Prev Excess (Credit): Rs. ${Math.abs(previousShortage)}`;
                pBadge.className = "mt-1 text-[9px] font-black uppercase text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 block w-max";
            }
            pBadge.classList.remove('hidden');
        } else {
            pBadge.classList.add('hidden');
        }
        
        // Auto-load previously saved collection (for edit mode)
        let existingSale = await db.dailySales.where({date, staffId}).first();
        if(!existingSale && !isNaN(staffId)) {
           existingSale = await db.dailySales.where({date, staffId: Number(staffId)}).first();
        }
        if(existingSale) {
            document.getElementById('sold-c48').value = existingSale.soldCard48 || 0;
            document.getElementById('sold-c95').value = existingSale.soldCard95 || 0;
            document.getElementById('sold-c96').value = existingSale.soldCard96 || 0;
            document.getElementById('sold-reload').value = existingSale.soldReloadCash || 0;
            document.getElementById('collect-handcash').value = existingSale.handCash || 0;
            showToast('Loaded previously saved collection', 'info');
        }
        
        calculateExpectedCash();
        showToast('Day setup data loaded');
    } catch(err) { console.error(err); showToast('Failed to load data', 'error'); }
}

window.clearCollectionForm = function() {
    const detailsWrap = document.getElementById('collection-details');
    if (detailsWrap) detailsWrap.classList.add('hidden');
    
    currentIssuedData = null;
    previousShortage = 0;
    document.getElementById('prev-shortage-badge')?.classList.add('hidden');
    
    ['avail-c48', 'avail-c95', 'avail-c96', 'avail-reload-val',
     'sold-c48', 'sold-c95', 'sold-c96', 'sold-reload', 
     'return-c48', 'return-c95', 'return-c96', 'collect-handcash'].forEach(id => {
        let el = document.getElementById(id);
        if(el) el.value = 0;
    });
    
    const reloadDisp = document.getElementById('avail-reload-disp');
    if (reloadDisp) reloadDisp.innerText = `Avail Reload: Rs. 0`;
    
    calculateExpectedCash();
}

function calculateExpectedCash() {
    const s48 = Number(document.getElementById('sold-c48').value) || 0;
    const s95 = Number(document.getElementById('sold-c95').value) || 0;
    const s96 = Number(document.getElementById('sold-c96').value) || 0;
    const sReload = Number(document.getElementById('sold-reload').value) || 0;
    const availReload = Number(document.getElementById('avail-reload-val').value) || 0;
    
    // Auto-calculate Returns
    if(currentIssuedData) {
        document.getElementById('return-c48').value = (currentIssuedData.card48 - s48);
        document.getElementById('return-c95').value = (currentIssuedData.card95 - s95);
        document.getElementById('return-c96').value = (currentIssuedData.card96 - s96);
    }

    // Total Card Value Calculation
    const cardVal48 = s48 * 48;
    const cardVal95 = s95 * 95;
    const cardVal96 = s96 * 96;
    const totalCardsValue = cardVal48 + cardVal95 + cardVal96;

    // Commission Calculations
    const commCard = (s48 * 2) + (s95 * 4) + (s96 * 4);
    const commReload = (sReload * 0.0638);
    const totalComm = commCard + commReload;

    const todaySalesOnly = totalCardsValue + sReload;
    const expected = todaySalesOnly + previousShortage;

    // Update UI
    document.getElementById('val-c48').innerText = cardVal48.toLocaleString();
    document.getElementById('val-c95').innerText = cardVal95.toLocaleString();
    document.getElementById('val-c96').innerText = cardVal96.toLocaleString();
    document.getElementById('coll-total-card-val').innerText = `Rs. ${totalCardsValue.toLocaleString()}`;

    document.getElementById('coll-card-comm').innerText = formatCurrency(commCard);
    document.getElementById('coll-reload-comm').innerText = `Com: Rs. ${commReload.toFixed(2)}`;
    document.getElementById('coll-today-sales-disp').innerText = formatCurrency(todaySalesOnly);
    document.getElementById('coll-expected-disp').innerText = formatCurrency(expected);
    document.getElementById('coll-total-comm-disp').innerText = formatCurrency(totalComm);
    document.getElementById('coll-closing-reload-disp').innerText = `Rollover Reload: Rs. ${(availReload - sReload).toLocaleString()}`;

    const actualCash = Number(document.getElementById('collect-handcash').value) || 0;
    const diffBadge = document.getElementById('collect-diff');
    
    // Save state for submit
    window.currentShortageGenerated = 0;

    if (Math.abs(actualCash - expected) < 0.01 && expected > 0) {
        diffBadge.innerText = 'Balanced';
        diffBadge.className = 'mt-2 text-xs font-bold px-2 py-1 rounded inline-block bg-emerald-500/20 text-emerald-400 border border-emerald-500/50';
    } else if (actualCash < expected) {
        const short = expected - actualCash;
        diffBadge.innerText = 'Shortage: Rs.' + short;
        diffBadge.className = 'mt-2 text-xs font-bold px-2 py-1 rounded inline-block bg-red-500/20 text-red-500 border border-red-500/50 underline';
    } else if (actualCash > expected) {
        const excess = actualCash - expected;
        diffBadge.innerText = 'Excess: Rs.' + excess;
        diffBadge.className = 'mt-2 text-xs font-bold px-2 py-1 rounded inline-block bg-emerald-500/20 text-emerald-400 border border-emerald-500/50';
    }
}

function checkStockMismatch(type, sold, issued) {
    const errLabel = document.getElementById('err-c' + type);
    if(sold > issued) {
        errLabel.innerText = `${sold} sold, but only ${issued} issued!`;
        errLabel.classList.remove('hidden');
    } else {
        errLabel.classList.add('hidden');
    }
}

async function handleCollectionSubmit(e) {
    e.preventDefault();
    if(!currentIssuedData) return;

    const date = document.getElementById('collect-date').value;
    const staffId = document.getElementById('collect-staff').value;
    
    const soldCard48 = Number(document.getElementById('sold-c48').value) || 0;
    const soldCard95 = Number(document.getElementById('sold-c95').value) || 0;
    const soldCard96 = Number(document.getElementById('sold-c96').value) || 0;
    const soldReloadCash = Number(document.getElementById('sold-reload').value) || 0;
    
    const returnedCard48 = Number(document.getElementById('return-c48').value) || 0;
    const returnedCard95 = Number(document.getElementById('return-c95').value) || 0;
    const returnedCard96 = Number(document.getElementById('return-c96').value) || 0;
    
    const handCash = Number(document.getElementById('collect-handcash').value) || 0;
    const availReload = Number(document.getElementById('avail-reload-val').value) || 0;

    const commCard = (soldCard48 * 2) + (soldCard95 * 4) + (soldCard96 * 4);
    const commReload = (soldReloadCash * 0.0638);
    const totalCommission = commCard + commReload;
    const todayExpected = (soldCard48 * 48) + (soldCard95 * 95) + (soldCard96 * 96) + soldReloadCash;
    const totalWithDebt = todayExpected + previousShortage;

    if (Math.abs(handCash - totalWithDebt) > 0.01) {
        let res = await Swal.fire({
            title: 'Cash Mismatch!',
            text: `Hand cash (${formatCurrency(handCash)}) does not match Total Expected (${formatCurrency(totalWithDebt)} incl. prev debt). Continue anyway?`,
            icon: 'warning',
            showCancelButton: true,
            background: '#1e293b',
            color: '#fff'
        });
        if(!res.isConfirmed) return;
    }

    if((soldCard48 > currentIssuedData.card48) || 
       (soldCard95 > currentIssuedData.card95) || 
       (soldCard96 > currentIssuedData.card96)) {
        
        let res = await Swal.fire({
            title: 'Invalid Stock Amount!',
            text: `You have entered a 'Sold' quantity that is greater than what was 'Issued' today.`,
            icon: 'error',
            background: '#1e293b',
            color: '#fff'
        });
        return;
    }

    const shortageToday = totalWithDebt - handCash;
    let diffStatus = 'BALANCED';
    if (shortageToday > 0.01) diffStatus = 'SHORT';
    else if (shortageToday < -0.01) diffStatus = 'EXCESS';

    const data = {
        date, staffId, 
        soldCard48, soldCard95, soldCard96, soldReloadCash,
        returnedCard48, returnedCard95, returnedCard96,
        handCash, expectedCash: todayExpected, // Record today's target
        totalCommission,
        availReload,
        shortageAmt: shortageToday, // Positive for shortage, Negative for excess
        currentDiff: Math.abs(shortageToday),
        diffStatus: diffStatus
    };

    try {
        let existing = await db.dailySales.where('[date+staffId]').equals([date, staffId]).first();
        if(!existing && !isNaN(staffId)) {
            existing = await db.dailySales.where('[date+staffId]').equals([date, Number(staffId)]).first();
        }
        
        if(existing) { await db.dailySales.update(existing.id, data); }
        else { await db.dailySales.add(data); }
        
        Swal.fire({
            title: 'Success!',
            text: 'Daily collection finalized and commission tracked.',
            icon: 'success',
            background: '#1e293b',
            color: '#fff'
        });

        // Reset form and UI
        if(currentUser.role === 'admin') {
            document.getElementById('collect-staff').value = "";
        }
        
        document.getElementById('collection-details').classList.add('hidden');
        currentIssuedData = null;
        previousShortage = 0;

        updateDashboardCard();

        // --- Online Sync ---
        syncToCloud('daily_sales', {
            staff_id: data.staffId,
            date: data.date,
            sold_card48: data.soldCard48,
            sold_card95: data.soldCard95,
            sold_card96: data.soldCard96,
            sold_reload_cash: data.soldReloadCash,
            hand_cash: data.handCash,
            total_commission: data.totalCommission,
            shortage_amt: data.shortageAmt
        }, { staff_id: data.staffId, date: data.date });

    } catch(err) {
        console.error(err);
        showToast('Error saving data', 'error');
    }
}

// --- API & Event Setup ---
function setupEventListeners() {
    // Login Handler
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = document.getElementById('login-username').value;
        const pass = document.getElementById('login-password').value;

        // Admin check
        let settings = await db.settings.toCollection().first();
        const adminPass = (settings && settings.adminPassword) ? settings.adminPassword : 'admin123';
        
        if(user === 'admin' && pass === adminPass) {
            currentUser = { id: 0, name: 'Administrator', role: 'admin' };
            localStorage.setItem('crdms_user', JSON.stringify(currentUser));
            showApp();
            return;
        }

        // Staff check
        let staff = await db.staff.where('phone').equals(user).first();
        if(staff && staff.password === pass) {
            currentUser = { id: staff.id, name: staff.name, role: 'distributor' };
            localStorage.setItem('crdms_user', JSON.stringify(currentUser));
            showApp();
        } else {
            Swal.fire({ icon: 'error', title: 'Login Failed', text: 'Invalid phone or password', background: '#1e293b', color: '#fff'});
        }
    });

    // Sets & Target
    document.getElementById('staff-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        let idStr = document.getElementById('staff-edit-id').value;
        let id = idStr ? (isNaN(idStr) ? idStr : Number(idStr)) : '';
        const name = document.getElementById('staff-name').value;
        const routeName = document.getElementById('staff-route').value;
        const phone = document.getElementById('staff-phone').value;
        const password = document.getElementById('staff-password').value;
        const target = Number(document.getElementById('staff-target').value) || 0;
        const joinedDate = document.getElementById('staff-joined').value;
        
        if(id !== '') {
            // Check if phone number is taken by ANOTHER staff member
            let conflict = await db.staff
                .where('phone').equals(phone)
                .filter(s => String(s.id) !== String(id))
                .first();
                
            if(conflict) {
                Swal.fire({ icon: 'error', title: 'Update Failed', text: `Phone number ${phone} is already assigned to ${conflict.name}.`, background: '#1e293b', color: '#fff'});
                return;
            }

            await db.staff.update(id, {name, routeName, phone, password, target, joinedDate});
            showToast('Staff Updated');
            cancelStaffEdit();
        } else {
            // Check duplicate phone for NEW entry
            let exists = await db.staff.where('phone').equals(phone).first();
            if(exists) {
                Swal.fire({ icon: 'error', title: 'Duplicate Entry', text: `A staff member (${exists.name}) already exists with this phone number.`, background: '#1e293b', color: '#fff'});
                return;
            }
            
            // Auto-generate a Sequential System ID (e.g., DS-0001)
            const allStaff = await db.staff.toArray();
            let maxId = 0;
            allStaff.forEach(s => {
                if(s.sysId && s.sysId.startsWith('DS-')) {
                    const num = parseInt(s.sysId.replace('DS-', ''), 10);
                    if(!isNaN(num) && num > maxId) maxId = num;
                }
            });
            const sysId = 'DS-' + String(maxId + 1).padStart(4, '0');
            
            await db.staff.add({name, routeName, phone, password, target, joinedDate, sysId});
            document.getElementById('staff-form').reset();
            showToast('Staff Added');
        }
        
        // --- Online Sync Staff ---
        const sList = await db.staff.toArray();
        for(let s of sList) {
            syncToCloud('staff', {
                name: s.name,
                route_name: s.routeName,
                phone: s.phone,
                password: s.password,
                target: s.target,
                joined_date: s.joinedDate,
                sys_id: s.sysId
            }, { phone: s.phone });
        }

        loadStaffDropdowns();
        renderStaffTable();
    });

    document.getElementById('target-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const targetAmount = Number(document.getElementById('setting-target').value);
        const workingDays = Number(document.getElementById('setting-days').value) || 25;
        const adminPassword = document.getElementById('setting-admin-pass').value || 'admin123';
        
        let first = await db.settings.toCollection().first();
        if(first) {
            await db.settings.update(first.id, {targetAmount, workingDays, adminPassword});
        } else {
            await db.settings.add({targetAmount, workingDays, adminPassword});
        }
        showToast('Settings Updated');
        updateDashboardCard();

        // --- Online Sync Settings ---
        syncToCloud('settings', {
            id: 1,
            target_amount: targetAmount,
            working_days: workingDays,
            admin_password: adminPassword
        }, { id: 1 });
    });

    // Issue Modifiers
    document.querySelectorAll('.issue-calc').forEach(el => {
        el.addEventListener('input', calculateIssueTotal);
    });
    document.getElementById('issue-form').addEventListener('submit', handleIssueSubmit);
    
    // Previous balance triggers
    document.getElementById('issue-staff').addEventListener('change', loadPreviousBalances);
    document.getElementById('issue-date').addEventListener('change', loadPreviousBalances);

    // Collect Modifiers
    document.getElementById('btn-load-issue').addEventListener('click', handleLoadExpectedData);
    document.querySelectorAll('.collect-calc, #return-c48, #return-c95, #return-c96, #collect-handcash').forEach(el => {
        el.addEventListener('input', calculateExpectedCash);
    });
    document.getElementById('collection-form').addEventListener('submit', handleCollectionSubmit);
}


// --- Additional Setup Data Refreshing ---
async function loadStaffDropdowns() {
    const list = await db.staff.toArray();
    let issueDrop = document.getElementById('issue-staff');
    let collectDrop = document.getElementById('collect-staff');
    let reportDrop = document.getElementById('report-staff');
    let historyDrop = document.getElementById('history-staff');
    
    // Clear existing
    issueDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';
    collectDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';
    if(reportDrop) reportDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';
    if(historyDrop) historyDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';

    list.forEach(s => {
        issueDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.routeName}</option>`);
        collectDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.routeName}</option>`);
        if(reportDrop) reportDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.routeName}</option>`);
        if(historyDrop) historyDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.routeName}</option>`);
    });

    // CRITICAL FIX: If a distributor's dropdown gets re-rendered during background cloud sync, we MUST re-select their ID.
    if(typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'distributor') {
        issueDrop.value = currentUser.id;
        collectDrop.value = currentUser.id;
    }

    // Default dates
    let hMonth = document.getElementById('history-month');
    if (hMonth && !hMonth.value) hMonth.value = getCurrentMonthString();

    // Also populate settings target if present
    let s = await db.settings.toCollection().first();
    if(s) {
        document.getElementById('setting-target').value = s.targetAmount || '';
        document.getElementById('setting-days').value = s.workingDays || 25;
        document.getElementById('setting-admin-pass').value = s.adminPassword || 'admin123';
    }
}

async function renderStaffTable() {
    const list = await db.staff.toArray();
    const tbody = document.getElementById('staff-table-body');
    document.getElementById('staff-count').innerText = list.length;
    
    if(list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-gray-500 italic">No staff registered yet. Add staff above.</td></tr>';
        return;
    }
    
    tbody.innerHTML = '';
    list.forEach((s, idx) => {
        tbody.insertAdjacentHTML('beforeend', `
            <tr class="hover:bg-slate-800/50 transition-colors">
                <td class="py-3 px-4 text-center font-medium w-8">${idx+1}</td>
                <td class="py-3 px-2 text-xs font-mono font-bold text-indigo-400">${s.sysId || '-'}</td>
                <td class="py-3 px-4">
                    <div class="font-semibold text-white">${s.name}</div>
                    <div class="text-xs text-gray-500">${s.phone}</div>
                </td>
                <td class="py-3 px-4 text-xs font-mono text-gray-400">${s.joinedDate || '-'}</td>
                <td class="py-3 px-4 text-gray-400">${s.routeName}</td>
                <td class="py-3 px-4 text-emerald-400 font-medium">${formatCurrency(s.target || 0)}</td>
                <td class="py-3 px-4 text-right">
                    <button onclick="editStaff('${s.id}')" class="text-blue-400 hover:text-blue-300 p-2 rounded-lg hover:bg-blue-400/10 transition-colors mr-1">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button onclick="deleteStaff('${s.id}')" class="text-red-400 hover:text-red-300 p-2 rounded-lg hover:bg-red-400/10 transition-colors">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `);
    });
}

async function loadPreviousBalances() {
    const staffId = document.getElementById('issue-staff').value;
    const selectedDate = document.getElementById('issue-date').value;
    
    // 1. Always reset "New" fields FIRST
    ['issue-new-c48', 'issue-new-c95', 'issue-new-c96', 'issue-new-reload'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = 0;
    });

    // 2. Reset Previous fields to 0 by default
    ['issue-prev-c48', 'issue-prev-c95', 'issue-prev-c96', 'issue-prev-reload'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = 0;
    });

    calculateIssueTotal();

    if(!staffId || !selectedDate) {
        if(!staffId) updateStaffPerformanceDisplay("");
        return;
    }

    // 1. Get the last Sales record (Settlement)
    let lastSale = await db.dailySales.where('staffId').equals(staffId).and(r => r.date < selectedDate).sortBy('date').then(res => res[res.length-1]);
    if(!lastSale && !isNaN(staffId)) lastSale = await db.dailySales.where('staffId').equals(Number(staffId)).and(r => r.date < selectedDate).sortBy('date').then(res => res[res.length-1]);

    // 2. Get the last Issue record (Morning setup)
    let lastIssue = await db.dailyIssues.where('staffId').equals(staffId).and(r => r.date < selectedDate).sortBy('date').then(res => res[res.length-1]);
    if(!lastIssue && !isNaN(staffId)) lastIssue = await db.dailyIssues.where('staffId').equals(Number(staffId)).and(r => r.date < selectedDate).sortBy('date').then(res => res[res.length-1]);

    // 3. Logic: Whichever is newer is the current state of the distributor's bag.
    // If an issue happened on the 13th but NO collection was entered for the 13th,
    // the 14th should see the full Issued amount from the 13th.
    
    let sourceRecord = null;
    let useReturnedFields = false;

    if (lastSale && lastIssue) {
        if (lastSale.date >= lastIssue.date) {
            sourceRecord = lastSale;
            useReturnedFields = true; 
        } else {
            sourceRecord = lastIssue;
            useReturnedFields = false;
        }
    } else if (lastSale) {
        sourceRecord = lastSale;
        useReturnedFields = true;
    } else if (lastIssue) {
        sourceRecord = lastIssue;
        useReturnedFields = false;
    }

    if (sourceRecord) {
        if (useReturnedFields) {
            // It's a settlement record: use what was brought back
            document.getElementById('issue-prev-c48').value = sourceRecord.returnedCard48 || 0;
            document.getElementById('issue-prev-c95').value = sourceRecord.returnedCard95 || 0;
            document.getElementById('issue-prev-c96').value = sourceRecord.returnedCard96 || 0;
            const avail = Number(sourceRecord.availReload || 0);
            const sold = Number(sourceRecord.soldReloadCash || 0);
            document.getElementById('issue-prev-reload').value = (avail - sold) || 0;
        } else {
            // It's just an issue record (no settlement yet): they have the FULL total
            document.getElementById('issue-prev-c48').value = sourceRecord.card48 || 0;
            document.getElementById('issue-prev-c95').value = sourceRecord.card95 || 0;
            document.getElementById('issue-prev-c96').value = sourceRecord.card96 || 0;
            document.getElementById('issue-prev-reload').value = sourceRecord.reloadCash || 0;
        }

        // --- Handle Shortage/Excess Badge (Only from Sales records) ---
        const cashWrap = document.getElementById('issue-prev-cash-wrap');
        const cashLabel = document.getElementById('issue-prev-cash-label');
        const cashValue = document.getElementById('issue-prev-cash-val');

        // Only show shortage/excess if the last SALE record exists (even if it's older than the issue)
        // because Issues don't create financial shortages.
        if (lastSale && lastSale.shortageAmt && lastSale.shortageAmt !== 0) {
            cashWrap.classList.remove('hidden');
            if (lastSale.shortageAmt > 0) {
                cashLabel.innerText = "Unpaid Shortage";
                cashLabel.className = "text-[10px] font-black uppercase text-red-400 tracking-widest";
                cashValue.innerText = `Rs. ${lastSale.shortageAmt}`;
                cashValue.className = "text-base font-black text-red-500";
            } else {
                cashLabel.innerText = "Excess Credit";
                cashLabel.className = "text-[10px] font-black uppercase text-emerald-400 tracking-widest";
                cashValue.innerText = `Rs. ${Math.abs(lastSale.shortageAmt)}`;
                cashValue.className = "text-base font-black text-emerald-400";
            }
        } else {
            cashWrap.classList.add('hidden');
        }
    } else {
        document.getElementById('issue-prev-cash-wrap').classList.add('hidden');
    }

    calculateIssueTotal();
}

// Global hook for inline onclicks
window.deleteStaff = async function(strId) {
    let id = strId ? (isNaN(strId) ? strId : Number(strId)) : '';
    let res = await Swal.fire({
        title: 'Delete Staff?',
        text: 'This will remove the distributor from lists. Past session data will remain in history.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#334155',
        confirmButtonText: 'Yes, Delete',
        background: '#1e293b',
        color: '#fff'
    });
    
    if(res.isConfirmed) {
        try {
            // 1. Sync Delete to Cloud
            if (typeof supabaseClient !== 'undefined') {
                const { error } = await supabaseClient.from('staff').delete().eq('id', id);
                if (error) throw error;
            }
            
            // 2. Delete locally
            await db.staff.delete(id);
            
            showToast('Deleted');
            loadStaffDropdowns();
            renderStaffTable();
            if(typeof renderDistributorStats === 'function') renderDistributorStats();
        } catch (error) {
            console.error("Deletion failed:", error);
            Swal.fire({ 
                icon: 'error', 
                title: 'Delete Failed', 
                text: 'Cloud sync failed: ' + (error.message || 'Unknown error'),
                background: '#1e293b', 
                color: '#fff'
            });
        }
    }
}
window.switchTab = switchTab;

// --- Edit actions ---

window.cancelStaffEdit = function() {
    document.getElementById('staff-edit-id').value = '';
    document.getElementById('staff-form').reset();
    document.getElementById('staff-submit-btn').innerHTML = '<i class="fas fa-user-plus mr-1"></i> Add';
    document.getElementById('staff-submit-btn').classList.replace('bg-emerald-600', 'bg-indigo-600');
    document.getElementById('staff-submit-btn').classList.replace('hover:bg-emerald-500', 'hover:bg-indigo-500');
    document.getElementById('staff-submit-btn').classList.replace('border-emerald-500', 'border-indigo-500');
    document.getElementById('staff-submit-btn').classList.replace('shadow-emerald-500/20', 'shadow-indigo-500/20');
    document.getElementById('staff-cancel-btn').classList.add('hidden');
}

window.editStaff = async function(strId) {
    let id = strId ? (isNaN(strId) ? strId : Number(strId)) : '';
    const s = await db.staff.get(id);
    if(s) {
        document.getElementById('staff-edit-id').value = s.id;
        document.getElementById('staff-name').value = s.name;
        document.getElementById('staff-joined').value = s.joinedDate || '';
        document.getElementById('staff-sysid').value = s.sysId || '';
        document.getElementById('staff-route').value = s.routeName;
        document.getElementById('staff-phone').value = s.phone;
        document.getElementById('staff-password').value = s.password || '';
        document.getElementById('staff-target').value = s.target || '';
        
        document.getElementById('staff-submit-btn').innerHTML = '<i class="fas fa-save mr-1"></i> Update';
        document.getElementById('staff-submit-btn').classList.replace('bg-indigo-600', 'bg-emerald-600');
        document.getElementById('staff-submit-btn').classList.replace('hover:bg-indigo-500', 'hover:bg-emerald-500');
        document.getElementById('staff-submit-btn').classList.replace('border-indigo-500', 'border-emerald-500');
        document.getElementById('staff-submit-btn').classList.replace('shadow-indigo-500/20', 'shadow-emerald-500/20');
        document.getElementById('staff-cancel-btn').classList.remove('hidden');
        window.scrollTo({ top: document.getElementById('settings').offsetTop, behavior: 'smooth' });
    }
}



// --- Data Management (Backup, Restore, Reset) ---

window.backupData = async function() {
    try {
        const data = {
            settings: await db.settings.toArray(),
            staff: await db.staff.toArray(),
            dailyIssues: await db.dailyIssues.toArray(),
            dailySales: await db.dailySales.toArray(),
            timestamp: new Date().toISOString()
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement("a");
        a.href = url;
        a.download = `crdms_backup_${getTodayString()}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        
        // Update last backup date in settings
        const currentSettings = await db.settings.toCollection().first();
        if(currentSettings) {
            await db.settings.update(currentSettings.id, { lastBackupDate: Date.now() });
        } else {
            await db.settings.add({ lastBackupDate: Date.now() });
        }

        showToast('Backup Downloaded successfully!');
        checkBackupReminder();
    } catch (error) {
        console.error(error);
        showToast('Backup Failed', 'error');
    }
}

window.handleRestoreFile = async function(event) {
    const file = event.target.files[0];
    if (!file) return;

    let res = await Swal.fire({
        title: 'Restore Backup?',
        text: 'This will erase existing data and restore from the file. Are you sure?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        cancelButtonColor: '#334155',
        confirmButtonText: 'Yes, Restore it',
        background: '#1e293b', 
        color: '#fff'
    });

    if (!res.isConfirmed) {
        event.target.value = ""; // Reset input
        return;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            
            if(!data.staff || !data.dailyIssues) {
                Swal.fire({ icon: 'error', title: 'Invalid Backup File', text: 'Data structure is not recognized.', background: '#1e293b', color: '#fff'});
                return;
            }

            // Wipe existing data and Insert new data
            await db.transaction('rw', db.settings, db.staff, db.dailyIssues, db.dailySales, async () => {
                await db.settings.clear();
                await db.staff.clear();
                await db.dailyIssues.clear();
                await db.dailySales.clear();

                if(data.settings && data.settings.length > 0) await db.settings.bulkAdd(data.settings);
                if(data.staff && data.staff.length > 0) await db.staff.bulkAdd(data.staff);
                if(data.dailyIssues && data.dailyIssues.length > 0) await db.dailyIssues.bulkAdd(data.dailyIssues);
                if(data.dailySales && data.dailySales.length > 0) await db.dailySales.bulkAdd(data.dailySales);
            });

            await Swal.fire({ icon: 'success', title: 'Restore Complete!', text: 'Your data has been successfully imported.', background: '#1e293b', color: '#fff'});
            
            // Reload UI
            window.location.reload();
            
        } catch (error) {
            console.error(error);
            Swal.fire({ icon: 'error', title: 'Restore Failed', text: error.message, background: '#1e293b', color: '#fff'});
        } finally {
            event.target.value = ""; // Reset input
        }
    };
    reader.readAsText(file);
}

window.resetSystem = async function() {
    let res = await Swal.fire({
        title: 'Are you absolutely sure?',
        text: 'This will wipe ALL sales, issues, staff, and targets FOREVER from both Local and Cloud. This action is IRREVERSIBLE!',
        icon: 'error',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#334155',
        confirmButtonText: 'Yes, Wipe Everything!',
        background: '#1e293b', 
        color: '#fff'
    });

    if (res.isConfirmed) {
        let secondRes = await Swal.fire({
            title: 'Final Confirmation',
            text: 'Type "RESET" to confirm TOTAL system wipe:',
            input: 'text',
            inputPlaceholder: 'Type RESET',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            background: '#1e293b', 
            color: '#fff',
            preConfirm: (val) => {
                if(val !== 'RESET') {
                    Swal.showValidationMessage('You must type RESET exactly');
                }
            }
        });

        if (secondRes.isConfirmed) {
            Swal.fire({
                title: 'Performing Deep Reset...',
                html: 'Deleting all cloud records and local data. Please wait...',
                allowOutsideClick: false,
                didOpen: () => { Swal.showLoading(); },
                background: '#1e293b',
                color: '#fff'
            });

            try {
                // 1. Deep wipe Supabase (Cloud) 
                // We fetch IDs first and delete to bypass "Mass Delete" protections or RLS issues with range filters
                if (typeof supabaseClient !== 'undefined') {
                    const tables = ['daily_sales', 'daily_issues', 'staff', 'settings'];
                    
                    for (const tableName of tables) {
                        try {
                            console.log(`Deep cleaning cloud table: ${tableName}`);
                            
                            // 1. First attempt: Use id > -1 (universal filter for numeric IDs)
                            let { error: err1 } = await supabaseClient.from(tableName).delete().gt('id', -1);
                            
                            // 2. Second attempt: Filter by a common non-null field if PK delete was blocked
                            if (err1) {
                                console.warn(`Mass delete via 'id' filter failed for ${tableName}. Trying fallback...`);
                                if (tableName === 'staff') {
                                    await supabaseClient.from(tableName).delete().neq('phone', 'WIPE-000');
                                } else if (tableName === 'settings') {
                                    await supabaseClient.from(tableName).delete().neq('working_days', 0);
                                } else {
                                    await supabaseClient.from(tableName).delete().neq('date', '1900-01-01');
                                }
                            }

                            // 3. Third attempt: Row-by-row verification
                            const { data: remaining } = await supabaseClient.from(tableName).select('id').limit(10);
                            if (remaining && remaining.length > 0) {
                                console.log(`Table ${tableName} still has ${remaining.length} records. Forcing row-by-row delete...`);
                                for (const item of remaining) {
                                    await supabaseClient.from(tableName).delete().eq('id', item.id);
                                }
                            }
                        } catch (e) {
                            console.error(`Fatal error during cloud wipe of ${tableName}:`, e);
                        }
                    }
                }

                // 2. Destroy local Dexie Database completely
                await db.delete();
                console.log("Local Database destroyed.");
                
                // 3. Re-create and open to avoid "Database is closed" errors before reload
                const newDb = new Dexie("DistributionDB");
                newDb.version(3).stores({
                    settings: '++id, targetAmount, adminPassword',
                    staff: '++id, name, routeName, phone, password',
                    dailyIssues: '++id, staffId, date, [date+staffId]',
                    dailySales: '++id, staffId, date, [date+staffId]'
                });
                await newDb.open();
                
                if (typeof currentIssuedData !== 'undefined') {
                    currentIssuedData = null;
                }
                
                // 4. Clear ALL local storage
                localStorage.clear();
                sessionStorage.clear();

                await Swal.fire({ 
                    icon: 'success', 
                    title: 'System Reset Complete', 
                    text: 'All data has been wiped from local and cloud successfully.', 
                    background: '#1e293b', 
                    color: '#fff', 
                    timer: 3000, 
                    showConfirmButton:false 
                });
                
                // Cleanest possible reload
                window.location.replace('index.html'); 
            } catch(error) {
                console.error("Critical Reset Failure:", error);
                Swal.fire({ 
                    icon: 'error', 
                    title: 'Reset Failed', 
                    text: 'A critical error occurred: ' + error.message + '. Please try clearing your browser cache and cookies.', 
                    background: '#1e293b', 
                    color: '#fff'
                });
            }
        }
    }
}
// --- Report Logic ---
window.toggleReportStaffPicker = function() {
    const scope = document.getElementById('report-scope').value;
    const wrap = document.getElementById('report-staff-picker-wrap');
    if(scope === 'single') wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
}

window.generateReport = async function() {
    const scope = document.getElementById('report-scope').value;
    const monthStr = document.getElementById('report-month').value;
    const staffId = document.getElementById('report-staff').value;
    
    if(!monthStr) return showToast('Please select a month', 'error');
    if(scope === 'single' && !staffId) return showToast('Please select a distributor', 'error');

    const printableArea = document.getElementById('report-printable-area');
    const content = document.getElementById('report-content');
    const titleMeta = document.getElementById('report-title-meta');
    const printDate = document.getElementById('report-print-date');

    printableArea.classList.remove('hidden');
    document.getElementById('btn-print-report').classList.remove('hidden');
    printDate.innerText = new Date().toLocaleString();

    if(scope === 'all') {
        titleMeta.innerText = `Full Staff Monthly Summary - ${monthStr}`;
        await renderFullStaffSummary(monthStr, content);
    } else {
        const staff = await db.staff.get(staffId);
        titleMeta.innerText = `Distributor History: ${staff.name} (${staff.routeName}) - ${monthStr}`;
        await renderSingleStaffHistory(monthStr, staffId, content);
    }
    
    // Smooth scroll to report
    printableArea.scrollIntoView({ behavior: 'smooth' });
}

async function renderFullStaffSummary(monthStr, container) {
    const staffs = await db.staff.toArray();
    
    // Pre-calculate data for ranking
    const staffData = [];
    for (const s of staffs) {
        const salesRecords = await db.dailySales
            .where('staffId').equals(s.id)
            .filter(r => r.date.startsWith(monthStr))
            .toArray();

        let totalS = 0;
        let totalC = 0;
        salesRecords.forEach(r => {
            totalS += (Number(r.soldCard48 || 0) * 48) + (Number(r.soldCard95 || 0) * 95) + (Number(r.soldCard96 || 0) * 96) + Number(r.soldReloadCash || 0);
            totalC += Number(r.totalCommission || 0);
        });

        const progress = (s.target || 0) > 0 ? (totalS / s.target * 100) : 0;
        
        const lastRec = salesRecords.sort((a,b) => b.date.localeCompare(a.date))[0];
        const sAmt = lastRec ? Number(lastRec.shortageAmt || 0) : 0;
        const diffAmt = Math.abs(sAmt);
        const status = sAmt > 0.01 ? 'SHORT' : (sAmt < -0.01 ? 'EXCESS' : 'BALANCED');

        staffData.push({ 
            staff: s, 
            totalS, 
            totalC, 
            progress, 
            status,
            lastDiff: diffAmt
        });
    }

    // Sort by progress for ranking
    staffData.sort((a, b) => b.progress - a.progress);

    let html = `
        <div class="performance-summary-box mb-6">
            <h4 class="font-black uppercase text-xs tracking-widest mb-1 text-indigo-900">Performance Overview</h4>
            <p class="text-[11px] text-slate-700">Top Performer: <span class="font-black text-indigo-600">${staffData[0] ? staffData[0].staff.name : 'N/A'}</span> (${staffData[0] ? staffData[0].progress.toFixed(1) : 0}% achievement)</p>
        </div>
        <table class="w-full text-sm border-collapse">
            <thead>
                <tr class="bg-indigo-900 text-white">
                    <th class="py-3 px-2 text-center w-12">Rank</th>
                    <th class="py-3 px-4 text-left">Distributor</th>
                    <th class="py-3 px-2 text-center">Month Target</th>
                    <th class="py-3 px-2 text-center">Achieved (Rs.)</th>
                    <th class="py-3 px-2 text-center">Progress %</th>
                    <th class="py-3 px-2 text-right">Current Balance</th>
                </tr>
            </thead>
            <tbody>
    `;

    let grandSales = 0;
    let grandComm = 0;

    staffData.forEach((data, index) => {
        const s = data.staff;
        grandSales += data.totalS;
        grandComm += data.totalC;
        const rankClass = index === 0 ? 'bg-yellow-100 font-bold text-yellow-800' : (index < 3 ? 'bg-blue-50 font-bold' : '');
        const progressColor = data.progress >= 100 ? 'text-emerald-600' : (data.progress < 50 ? 'text-rose-600' : 'text-slate-700');
        const statusColor = data.status === 'EXCESS' ? 'text-emerald-600' : (data.status === 'SHORT' ? 'text-rose-600' : 'text-slate-400');
        const balanceLabel = data.status === 'SHORT' ? `-${formatCurrency(data.lastDiff)}` : (data.status === 'EXCESS' ? `+${formatCurrency(data.lastDiff)}` : 'BALANCED');

        html += `
            <tr class="border-b border-slate-100 hover:bg-slate-50">
                <td class="py-3 px-2 text-center ${rankClass}">${index + 1}</td>
                <td class="py-3 px-4">
                    <div class="font-bold text-indigo-900">${s.name}</div>
                    <div class="text-[10px] text-slate-500 uppercase font-black tracking-tighter">${s.routeName}</div>
                </td>
                <td class="py-3 px-2 text-center font-mono">${formatCurrency(s.target || 0)}</td>
                <td class="py-3 px-2 text-center font-bold font-mono">${formatCurrency(data.totalS)}</td>
                <td class="py-3 px-2 text-center ${progressColor} font-mono font-bold">${data.progress.toFixed(1)}%</td>
                <td class="py-3 px-2 text-right font-black text-[10px] ${statusColor}">${balanceLabel}</td>
            </tr>
        `;
    });

    html += `
            </tbody>
            <tfoot class="bg-indigo-900 text-white font-black">
                <tr>
                    <td colspan="3" class="py-4 px-4 text-right uppercase tracking-widest border-indigo-700">Grand Monthly Total</td>
                    <td class="py-4 px-2 text-center font-mono text-lg border-indigo-700">${formatCurrency(grandSales)}</td>
                    <td colspan="2" class="py-4 px-2 border-indigo-700"></td>
                </tr>
            </tfoot>
        </table>
    `;
    container.innerHTML = html;
}

async function renderSingleStaffHistory(monthStr, staffId, container) {
    const records = await db.dailySales
        .where('staffId').equals(staffId)
        .filter(r => r.date.startsWith(monthStr))
        .toArray();

    // PERFORMANCE SUMMARY LOGIC
    let totalSales = 0, totalCardsVal = 0, totalReloadVal = 0, totalComm = 0;
    let bestDay = { val: 0, date: 'N/A' };
    
    records.forEach(r => {
        const cVal = (Number(r.soldCard48 || 0) * 48) + (Number(r.soldCard95 || 0) * 95) + (Number(r.soldCard96 || 0) * 96);
        const dayTotal = cVal + Number(r.soldReloadCash || 0);
        totalSales += dayTotal;
        totalCardsVal += cVal;
        totalReloadVal += Number(r.soldReloadCash || 0);
        totalComm += Number(r.totalCommission || 0);
        if(dayTotal > bestDay.val) { bestDay = { val: dayTotal, date: r.date }; }
    });

    const avgDaily = records.length > 0 ? (totalSales / records.length) : 0;
    const staff = await db.staff.get(staffId);
    const progress = (staff.target || 0) > 0 ? (totalSales / staff.target * 100) : 0;

    let html = `
        <!-- Professional Scorecard Header -->
        <div class="grid grid-cols-3 gap-4 mb-6">
            <div class="p-3 border border-slate-200 rounded">
                <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Target Progress</p>
                <p class="text-base font-black text-indigo-900">${formatCurrency(totalSales)}</p>
                <p class="text-[9px] text-indigo-600 font-bold mt-1">${progress.toFixed(1)}% Achieved</p>
            </div>
            <div class="p-3 border border-slate-200 rounded">
                <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Productivity Mix</p>
                <div class="flex flex-col space-y-0.5">
                    <div class="text-[10px] font-bold flex justify-between"><span>Cards:</span> <span class="text-indigo-600">${((totalCardsVal/totalSales||0)*100).toFixed(0)}%</span></div>
                    <div class="text-[10px] font-bold flex justify-between"><span>Reload:</span> <span class="text-emerald-600">${((totalReloadVal/totalSales||0)*100).toFixed(0)}%</span></div>
                </div>
            </div>
            <div class="p-3 border border-slate-200 rounded">
                <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Sales Statistics</p>
                <p class="text-[10px] font-bold text-slate-700">Daily Avg: ${formatCurrency(avgDaily)}</p>
                <p class="text-[10px] font-bold text-indigo-500">Best: ${formatCurrency(bestDay.val)}</p>
            </div>
        </div>

        <table class="w-full text-[10px] border-collapse">
            <thead>
                <tr class="bg-indigo-900 text-white border-b-2 border-indigo-700">
                    <th class="py-3 px-2 text-left">Date</th>
                    <th class="py-3 px-2 text-center">Cards Value (Rs.)</th>
                    <th class="py-3 px-2 text-center">Reload Sold</th>
                    <th class="py-3 px-2 text-center">Today Total</th>
                    <th class="py-3 px-2 text-center">Cash Recv.</th>
                    <th class="py-3 px-2 text-right">Day Balance</th>
                </tr>
            </thead>
            <tbody>
    `;

    let tCardsValue = 0, tSales = 0, tReload = 0, tCash = 0;

    records.sort((a,b) => a.date.localeCompare(b.date)).forEach(r => {
        const cardsValue = (Number(r.soldCard48 || 0) * 48) + (Number(r.soldCard95 || 0) * 95) + (Number(r.soldCard96 || 0) * 96);
        const dayTotalSales = cardsValue + Number(r.soldReloadCash || 0);

        tCardsValue += cardsValue;
        tReload += Number(r.soldReloadCash || 0);
        tSales += dayTotalSales;
        tCash += Number(r.handCash || 0);

        const sAmt = Number(r.shortageAmt || 0);
        const diffAmt = Math.abs(sAmt);
        const status = sAmt > 0.01 ? 'SHORT' : (sAmt < -0.01 ? 'EXCESS' : 'BALANCED');
        
        const colorClass = status === 'EXCESS' ? 'text-emerald-600' : (status === 'SHORT' ? 'text-rose-600' : 'text-slate-400');
        const shortLabel = status === 'SHORT' ? `(-${formatCurrency(diffAmt)})` : (status === 'EXCESS' ? `(+${formatCurrency(diffAmt)})` : 'BALANCED');

        html += `
            <tr class="border-b border-slate-100 hover:bg-indigo-50/20">
                <td class="py-2 px-2 font-bold">${r.date}</td>
                <td class="py-2 px-2 text-center font-mono">${formatCurrency(cardsValue)}</td>
                <td class="py-2 px-2 text-center font-mono">${formatCurrency(r.soldReloadCash)}</td>
                <td class="py-2 px-2 text-center font-bold text-indigo-700 font-mono">${formatCurrency(dayTotalSales)}</td>
                <td class="py-2 px-2 text-center font-bold font-mono">${formatCurrency(r.handCash)}</td>
                <td class="py-2 px-2 text-right ${colorClass} font-black text-[9px] uppercase">${shortLabel}</td>
            </tr>
        `;
    });

    html += `
            </tbody>
            <tfoot>
                <tr class="bg-slate-100 font-black text-slate-900 border-t-2 border-slate-300">
                    <td class="py-3 px-2">MONTH TOTAL</td>
                    <td class="py-3 px-2 text-center font-mono">${formatCurrency(tCardsValue)}</td>
                    <td class="py-3 px-2 text-center font-mono">${formatCurrency(tReload)}</td>
                    <td class="py-3 px-2 text-center font-mono">${formatCurrency(tSales)}</td>
                    <td class="py-3 px-2 text-center font-mono">${formatCurrency(tCash)}</td>
                    <td class="py-3 px-2 text-right text-slate-500 font-normal italic text-[9px]">Calculated Session Data</td>
                </tr>
            </tfoot>
        </table>
    `;
    container.innerHTML = html;
}

async function updateStaffPerformanceDisplay(staffId) {
    if(!staffId) {
        const card = document.getElementById('staff-perf-card');
        if(card) card.classList.add('hidden');
        return;
    }

    try {
        const staff = await db.staff.get(staffId);
        if(!staff) return;

        const currentMonth = getCurrentMonthString();
        const sales = await db.dailySales
            .where('staffId').equals(staffId)
            .filter(r => r.date.startsWith(currentMonth))
            .toArray();

        const monthAchieved = sales.reduce((sum, r) => {
            const cardVal = (Number(r.soldCard48 || 0) * 48) + (Number(r.soldCard95 || 0) * 95) + (Number(r.soldCard96 || 0) * 96);
            return sum + cardVal + Number(r.soldReloadCash || 0);
        }, 0);

        const settings = await db.settings.toCollection().first();
        const workingDays = settings ? (settings.workingDays || 25) : 25;
        const monthlyTarget = staff.target || 0;
        
        // Dynamic day target calculation
        const workedDays = new Set(sales.map(r => r.date)).size;
        let daysLeft = workingDays - workedDays;
        if(daysLeft < 1) daysLeft = 1;

        const remainingTarget = (monthlyTarget - monthAchieved) > 0 ? (monthlyTarget - monthAchieved) : 0;
        const dailyTarget = remainingTarget / daysLeft;

        const progress = monthlyTarget > 0 ? (monthAchieved / monthlyTarget * 100) : 0;

        // Update UI
        const perfCard = document.getElementById('staff-perf-card');
        if(perfCard) {
            perfCard.classList.remove('hidden');
            document.getElementById('perf-monthly-target').innerText = formatCurrency(monthlyTarget);
            document.getElementById('perf-day-target').innerText = formatCurrency(dailyTarget);
            document.getElementById('perf-achieved').innerText = formatCurrency(monthAchieved);
            document.getElementById('perf-percent').innerText = `${progress.toFixed(1)}%`;
            document.getElementById('perf-bar').style.width = `${Math.min(progress, 100)}%`;
        }

    } catch (err) {
        console.error('Performance Load Error:', err);
    }
}

async function updateProductChart(monthSales) {
    const ctx = document.getElementById('productChart');
    if(!ctx) return;

    let tot48 = 0, tot95 = 0, tot96 = 0, totReload = 0;
    
    monthSales.forEach(r => {
        tot48 += (Number(r.soldCard48 || 0) * 48);
        tot95 += (Number(r.soldCard95 || 0) * 95);
        tot96 += (Number(r.soldCard96 || 0) * 96);
        totReload += Number(r.soldReloadCash || 0);
    });

    const data = [tot48, tot95, tot96, totReload];
    const labels = ['Cards 48', 'Cards 95', 'Cards 96', 'Reload Cash'];
    const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981'];

    if (window.productMixChart) {
        window.productMixChart.data.datasets[0].data = data;
        window.productMixChart.update();
    } else {
        window.productMixChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderColor: '#0f172a',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 10 } } }
                },
                cutout: '70%'
            }
        });
    }
}

async function checkBackupReminder() {
    const settings = await db.settings.toCollection().first();
    const lastBackup = settings ? settings.lastBackupDate : 0;
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    const backupBtn = document.getElementById('btn-global-backup');
    if (!backupBtn) return;

    if (!lastBackup || (now - lastBackup) > sevenDays) {
        backupBtn.classList.add('animate-pulse', 'border-rose-500', 'text-rose-400', 'bg-rose-500/10');
        backupBtn.title = "Backup Recommended! (Over 7 days since last backup)";
    } else {
        backupBtn.classList.remove('animate-pulse', 'border-rose-500', 'text-rose-400', 'bg-rose-500/10');
    }
}

// --- Online Sync Helper ---
async function syncToCloud(table, data, matchFields) {
    if (typeof supabaseClient === 'undefined') {
        console.error("Supabase client missing during sync");
        return;
    }
    
    try {
        const { error } = await supabaseClient
            .from(table)
            .upsert(data, { onConflict: Object.keys(matchFields).join(',') });

        if (error) throw error;
        
        console.log(`Synced ${table} to cloud`);
        // Small silent toast for auto-sync
        const Toast = Swal.mixin({
            toast: true,
            position: 'bottom-end',
            showConfirmButton: false,
            timer: 2000,
            background: '#10b981',
            color: '#fff'
        });
        Toast.fire({ icon: 'success', title: 'Saved Online' });

    } catch (err) {
        console.warn(`Sync failed for ${table}:`, err.message);
        const Toast = Swal.mixin({
            toast: true,
            position: 'bottom-end',
            showConfirmButton: false,
            timer: 3000,
            background: '#f43f5e',
            color: '#fff'
        });
        Toast.fire({ icon: 'error', title: 'Cloud Sync Failed' });
    }
}

async function manualCloudSync() {
    if (typeof supabaseClient === 'undefined') {
        Swal.fire({ icon: 'error', title: 'Sync Failed', text: 'Supabase is not initialized.', background: '#1e293b', color: '#fff'});
        return;
    }

    Swal.fire({
        title: 'Cloud Syncing...',
        text: 'Please wait while we push all local data to Supabase.',
        allowOutsideClick: false,
        didOpen: () => { Swal.showLoading(); },
        background: '#1e293b',
        color: '#fff'
    });

    try {
        // 1. Sync Staff
        const staffs = await db.staff.toArray();
        for(let s of staffs) {
            await syncToCloud('staff', {
                name: s.name, route_name: s.routeName, phone: s.phone, password: s.password, target: s.target
            }, { phone: s.phone });
        }

        // 2. Sync Issues
        const issues = await db.dailyIssues.toArray();
        for(let r of issues) {
            await syncToCloud('daily_issues', {
                staff_id: r.staffId, date: r.date, card48: r.card48, card95: r.card95, card96: r.card96, 
                reload_cash: r.reloadCash, total_issued_value: r.totalIssuedValue
            }, { staff_id: r.staffId, date: r.date });
        }

        // 3. Sync Sales
        const sales = await db.dailySales.toArray();
        for(let r of sales) {
            await syncToCloud('daily_sales', {
                staff_id: r.staffId, date: r.date, sold_card48: r.soldCard48, sold_card95: r.soldCard95, 
                sold_card96: r.soldCard96, sold_reload_cash: r.soldReloadCash, hand_cash: r.handCash, 
                total_commission: r.totalCommission, shortage_amt: r.shortageAmt
            }, { staff_id: r.staffId, date: r.date });
        }

        // 4. Sync Settings
        const config = await db.settings.toCollection().first();
        if(config) {
            await syncToCloud('settings', {
                id: 1, target_amount: config.targetAmount, working_days: config.workingDays, admin_password: config.adminPassword
            }, { id: 1 });
        }

        Swal.fire({ icon: 'success', title: 'Manual Sync Complete', text: 'All local data has been mirrored to the cloud.', background: '#1e293b', color: '#fff'});
    } catch (err) {
        console.error(err);
        Swal.fire({ icon: 'error', title: 'Sync Failed', text: err.message, background: '#1e293b', color: '#fff'});
    }
}

async function pullFromCloud() {
    if (typeof supabaseClient === 'undefined') return;
    
    // Show a subtle syncing indicator
    const syncToast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 1500,
        timerProgressBar: true,
        background: '#1e293b',
        color: '#fff'
    });
    syncToast.fire({ icon: 'info', title: 'Cloud Syncing...' });

    console.log("Starting parallel cloud data pull...");

    try {
        // Parallel fetch for maximum speed
        const [sRes, staffRes, issueRes, salesRes] = await Promise.all([
            supabaseClient.from('settings').select('*'),
            supabaseClient.from('staff').select('*'),
            supabaseClient.from('daily_issues').select('*'),
            supabaseClient.from('daily_sales').select('*')
        ]);

        if (sRes.error) throw sRes.error;
        if (staffRes.error) throw staffRes.error;
        if (issueRes.error) throw issueRes.error;
        if (salesRes.error) throw salesRes.error;

        const sData = sRes.data;
        const staffData = staffRes.data;
        const issueData = issueRes.data;
        const salesData = salesRes.data;

        // 1. Process Settings
        await db.settings.clear();
        if(sData && sData.length > 0) {
            await db.settings.bulkAdd(sData.map(s => ({
                id: s.id, targetAmount: s.target_amount, workingDays: s.working_days, 
                adminPassword: s.admin_password, lastBackupDate: s.last_backup_date
            })));
        }

        // 2. Process Staff
        await db.staff.clear();
        if(staffData && staffData.length > 0) {
            await db.staff.bulkAdd(staffData.map(s => ({
                id: s.id, name: s.name, routeName: s.route_name, phone: s.phone, password: s.password, target: Number(s.target),
                joinedDate: s.joined_date, sysId: s.sys_id
            })));

            if (currentUser && currentUser.role === 'distributor') {
                const stillExists = staffData.some(s => s.phone === currentUser.id || s.id === currentUser.id);
                if (!stillExists) {
                    logout();
                    return;
                }
            }
        } else if (currentUser && currentUser.role !== 'admin') {
            logout();
            return;
        }

        // 3. Process Daily Records
        await db.dailyIssues.clear();
        if(issueData && issueData.length > 0) {
            await db.dailyIssues.bulkAdd(issueData.map(r => ({
                id: r.id, staffId: String(r.staff_id), date: r.date, 
                card48: r.card48, card95: r.card95, card96: r.card96, 
                reloadCash: Number(r.reload_cash), totalIssuedValue: Number(r.total_issued_value)
            })));
        }

        await db.dailySales.clear();
        if(salesData && salesData.length > 0) {
            await db.dailySales.bulkAdd(salesData.map(r => ({
                id: r.id, staffId: String(r.staff_id), date: r.date, 
                soldCard48: r.sold_card48, soldCard95: r.sold_card95, soldCard96: r.sold_card96, 
                soldReloadCash: Number(r.sold_reload_cash), handCash: Number(r.hand_cash), 
                totalCommission: Number(r.total_commission), shortageAmt: Number(r.shortage_amt)
            })));
        }

        console.log("Parallel Cloud Pull Complete");
        updateDashboardCard();
        loadStaffDropdowns();
        renderStaffTable();
        if(typeof renderDistributorStats === 'function') renderDistributorStats();

    } catch (err) {
        console.warn("Pull failed:", err.message);
    }
}

// --- History View Logic ---
window.generateHistoryView = async function() {
    const staffId = document.getElementById('history-staff').value;
    const month = document.getElementById('history-month').value;
    
    if(!staffId || !month) {
        return Swal.fire({ icon: 'warning', title: 'Missing Info', text: 'Please select a distributor and a month.', background: '#1e293b', color: '#fff'});
    }

    const staff = await db.staff.get(staffId);
    if(!staff) return;

    document.getElementById('history-title-name').innerText = staff.name + ' (' + staff.routeName + ')';
    document.getElementById('history-title-month').innerText = 'System Records for: ' + month;

    // Fetch records for month
    const issues = await db.dailyIssues.where('staffId').equals(staffId).toArray();
    const sales = await db.dailySales.where('staffId').equals(staffId).toArray();

    const resultArea = document.getElementById('history-result-area');
    const tbody = document.getElementById('history-tbody');
    const tfoot = document.getElementById('history-tfoot');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';

    // Filter by month (YYYY-MM) and group by date
    const monthlyIssues = issues.filter(r => r.date.startsWith(month));
    const monthlySales = sales.filter(r => r.date.startsWith(month));

    const allDates = new Set([...monthlyIssues.map(i => i.date), ...monthlySales.map(s => s.date)]);
    const sortedDates = Array.from(allDates).sort();

    if(sortedDates.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-5 text-center text-gray-400 italic">No activity recorded for this month.</td></tr>`;
        resultArea.classList.remove('hidden');
        return;
    }

    let grandTotalCardValue = 0;
    let grandTotalReloadIssued = 0;
    let grandTotalSales = 0;
    let grandTotalComm = 0;
    let grandTotalHandCash = 0;
    let grandTotalShortage = 0;

    sortedDates.forEach(date => {
        const issue = monthlyIssues.find(i => i.date === date);
        const sale = monthlySales.find(s => s.date === date);

        // Issue Metrics
        let cardFV = 0;
        let reloadIssued = 0;
        if(issue) {
            // New items issued only (using totalIssuedValue could include roll-overs if we look at whole stock, 
            // but for tracking history usually the whole day's stock *face value* is good, 
            // but let's show what was dealt with that day based on what's available vs sold. Let's do raw Sales Data first)
        }
        
        let saleAmt = 0;
        let commAmt = 0;
        let handAmt = 0;
        let shortAmt = 0;

        if (sale) {
            saleAmt = (sale.soldCard48 * 48) + (sale.soldCard95 * 95) + (sale.soldCard96 * 96) + sale.soldReloadCash;
            commAmt = sale.totalCommission || 0;
            // Calculate Shop Commission (Cards + Reload)
            const cardComm = (sale.soldCard48 * 2) + (sale.soldCard95 * 4) + (sale.soldCard96 * 4);
            const reloadComm = (Number(sale.soldReloadCash || 0) * 0.0638);
            const shopComm = cardComm + reloadComm;
            
            handAmt = sale.handCash || 0;
            shortAmt = sale.shortageAmt || 0;
            
            // Re-calculate how many cards in total FV was brought out that day
            if (issue) {
                cardFV = (issue.card48 * 48) + (issue.card95 * 95) + (issue.card96 * 96);
                reloadIssued = issue.reloadCash;
            }

            grandTotalSales += saleAmt;
            grandTotalComm += shopComm;
            grandTotalHandCash += handAmt;
            
            // For Shortage: The user wants to see the FINAL balance, not a sum of daily balances.
            // Since we sorted dates, the last 'shortAmt' in the loop will be the latest status.
            grandTotalShortage = shortAmt; 
            
            grandTotalCardValue += cardFV;
            grandTotalReloadIssued += reloadIssued;
            
            let shortClass = shortAmt > 0 ? 'text-red-400' : (shortAmt < 0 ? 'text-emerald-400' : 'text-gray-400');
            
            tbody.insertAdjacentHTML('beforeend', `
                <tr class="hover:bg-slate-800/50 transition-colors">
                    <td class="py-3 px-3 font-mono font-bold">${date}</td>
                    <td class="py-3 px-3">${formatCurrency(cardFV)}</td>
                    <td class="py-3 px-3 text-right">${formatCurrency(reloadIssued)}</td>
                    <td class="py-3 px-3 text-right text-emerald-400 font-bold">${formatCurrency(saleAmt)}</td>
                    <td class="py-3 px-3 text-right text-orange-400">${formatCurrency(shopComm)}</td>
                    <td class="py-3 px-3 text-right text-blue-400 font-bold">${formatCurrency(handAmt)}</td>
                    <td class="py-3 px-3 text-right ${shortClass} font-bold">${formatCurrency(Math.abs(shortAmt))} ${shortAmt > 0 ? '(S)' : shortAmt < 0 ? '(E)' : ''}</td>
                    <td class="py-3 px-3 text-center">
                        <button onclick="deleteHistoryRecord('${date}', '${staffId}')" class="text-red-400 hover:text-red-300 p-1.5 rounded-lg hover:bg-red-400/10 transition-colors" title="Delete Record">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `);
        } else if (issue && !sale) {
             // Issued but not yet collected
             cardFV = (issue.card48 * 48) + (issue.card95 * 95) + (issue.card96 * 96);
             reloadIssued = issue.reloadCash;
             tbody.insertAdjacentHTML('beforeend', `
                <tr class="hover:bg-slate-800/50 transition-colors opacity-60">
                    <td class="py-3 px-3 font-mono font-bold">${date}</td>
                    <td class="py-3 px-3">${formatCurrency(cardFV)}</td>
                    <td class="py-3 px-3 text-right">${formatCurrency(reloadIssued)}</td>
                    <td colspan="4" class="py-3 px-3 text-center text-gray-500 italic">Day not settled yet</td>
                    <td class="py-3 px-3 text-center">
                        <button onclick="deleteHistoryRecord('${date}', '${staffId}')" class="text-red-400 hover:text-red-300 p-1.5 rounded-lg hover:bg-red-400/10 transition-colors" title="Delete Record">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `);
        }
    });

    const netShortage = grandTotalShortage;
    const netClass = netShortage > 0 ? 'text-red-500' : (netShortage < 0 ? 'text-emerald-500' : 'text-gray-400');
    const netLabel = netShortage > 0 ? '(Shortage Balance)' : (netShortage < 0 ? '(Excess Balance)' : '(Balanced)');

    tfoot.innerHTML = `
        <tr>
            <th class="py-3 px-3 text-right uppercase tracking-widest text-indigo-400 font-extrabold text-[10px]">Month Summary:</th>
            <th class="py-3 px-3 text-gray-300">-</th>
            <th class="py-3 px-3 text-right text-gray-300">-</th>
            <th class="py-3 px-3 text-right text-emerald-400 font-black">${formatCurrency(grandTotalSales)}</th>
            <th class="py-3 px-3 text-right text-orange-400 font-black">${formatCurrency(grandTotalComm)}</th>
            <th class="py-3 px-3 text-right text-blue-400 font-black">${formatCurrency(grandTotalHandCash)}</th>
            <th class="py-3 px-3 text-right ${netClass} font-black">${formatCurrency(Math.abs(netShortage))} ${netShortage > 0 ? '(S)' : netShortage < 0 ? '(E)' : ''}</th>
            <th class="py-3 px-3"></th>
        </tr>
    `;

    resultArea.classList.remove('hidden');
}

window.deleteHistoryRecord = async function(date, staffId) {
    let res = await Swal.fire({
        title: 'Delete Entire Day?',
        text: `Are you sure you want to delete the records (Issue & Collection) for ${date}? This action cannot be undone.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#334155',
        confirmButtonText: 'Yes, Delete',
        background: '#1e293b',
        color: '#fff'
    });
    
    if(res.isConfirmed) {
        try {
            if (typeof supabaseClient !== 'undefined') {
                await supabaseClient.from('daily_issues').delete().match({ date: date, staff_id: staffId });
                await supabaseClient.from('daily_sales').delete().match({ date: date, staff_id: staffId });
            }
            
            await db.dailyIssues.where({date: date, staffId: staffId}).delete();
            await db.dailySales.where({date: date, staffId: staffId}).delete();
            if(!isNaN(staffId)) {
                await db.dailyIssues.where({date: date, staffId: Number(staffId)}).delete();
                await db.dailySales.where({date: date, staffId: Number(staffId)}).delete();
            }
            
            showToast('Day Record Deleted');
            generateHistoryView(); // refresh the table
        } catch(err) {
            console.error("Deletion failed", err);
            Swal.fire({ icon: 'error', title: 'Delete Failed', text: err.message, background: '#1e293b', color: '#fff' });
        }
    }
}

window.printHistoryReport = function() {
    document.body.classList.add('print-history');
    window.print();
    setTimeout(() => {
        document.body.classList.remove('print-history');
    }, 1000);
}

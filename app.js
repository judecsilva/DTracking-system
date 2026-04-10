// --- Database Configuration (Supabase) ---
const supabaseUrl = 'https://ayshfnqysfisfxlsgjwa.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5c2hmbnF5c2Zpc2Z4bHNnandhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NjYyNDUsImV4cCI6MjA5MTM0MjI0NX0.Lu4h2TlPoDJOdheg1BarRHp9WWDSTNe0hNgZf6oJvfc';
const _supabase = supabase.createClient(supabaseUrl, supabaseKey);

let currentUser = JSON.parse(localStorage.getItem('crdms_user') || 'null');
let performanceChart = null;

// --- State & DOM Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
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

    // Role-based UI restriction
    const tabs = ['tab-overview', 'tab-issue', 'tab-collection', 'tab-settings', 'tab-reports'];
    
    if(currentUser.role === 'distributor') {
        document.getElementById('tab-overview').classList.add('hidden');
        document.getElementById('tab-settings').classList.add('hidden');
        document.getElementById('tab-issue').classList.remove('hidden');
        document.getElementById('tab-collection').classList.remove('hidden');
        document.getElementById('tab-reports').classList.add('hidden');
        
        switchTab('issue');
        
        const autoEnforceSelf = async () => {
            const issueStaff = document.getElementById('issue-staff');
            const collectStaff = document.getElementById('collect-staff');
            if(issueStaff && collectStaff) {
                issueStaff.value = currentUser.id;
                collectStaff.value = currentUser.id;
                issueStaff.disabled = true;
                collectStaff.disabled = true;
                loadPreviousBalances(); 
                updateStaffPerformanceDisplay(currentUser.id);
            }
        };
        setTimeout(autoEnforceSelf, 400); 
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

    // Load initial data
    await loadStaffDropdowns();
    await updateDashboardCard();
    await renderStaffTable();
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
}

function updateMonthDisplay() {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const d = new Date();
    document.getElementById('overview-month').innerText = `${months[d.getMonth()]} ${d.getFullYear()}`;
}

// --- Auth Logic ---
async function handleLogin(e) {
    e.preventDefault();
    const phone = document.getElementById('login-username').value;
    const pass = document.getElementById('login-password').value;

    // Admin Shortcut (Optional - but let's check settings table)
    const { data: settings } = await _supabase.from('settings').select('*').limit(1).single();
    if (settings && phone === 'admin' && pass === settings.admin_password) {
        currentUser = { id: 'admin', name: 'Administrator', role: 'admin' };
        localStorage.setItem('crdms_user', JSON.stringify(currentUser));
        showApp();
        return;
    }

    // Check Staff table
    const { data: staff, error } = await _supabase.from('staff').select('*').eq('phone', phone).eq('password', pass).single();
    if(staff) {
        currentUser = { ...staff, role: 'distributor' };
        localStorage.setItem('crdms_user', JSON.stringify(currentUser));
        showApp();
    } else {
        Swal.fire({
            icon: 'error',
            title: 'Login Failed',
            text: 'Invalid credentials. Please contact Administrator.',
            background: '#1e293b',
            color: '#fff'
        });
    }
}

async function loadStaffDropdowns() {
    const { data: list } = await _supabase.from('staff').select('*');
    if(!list) return;

    const issueStaff = document.getElementById('issue-staff');
    const collectStaff = document.getElementById('collect-staff');
    
    let html = '<option value="" disabled selected>Select Staff...</option>';
    list.forEach(s => {
        html += `<option value="${s.id}">${s.name} (${s.route_name})</option>`;
    });

    if(issueStaff) issueStaff.innerHTML = html;
    if(collectStaff) collectStaff.innerHTML = html;
}

// Event Listeners (Moved inside a function for clarity)
function setupEventListeners() {
    const loginForm = document.getElementById('login-form');
    if(loginForm) loginForm.addEventListener('submit', handleLogin);

    const issueForm = document.getElementById('issue-form');
    if(issueForm) issueForm.addEventListener('submit', handleIssueSubmit);

    const collBtn = document.getElementById('btn-load-issue');
    if(collBtn) collBtn.addEventListener('click', handleLoadExpectedData);

    const collForm = document.getElementById('collection-form');
    if(collForm) collForm.addEventListener('submit', handleCollectionSubmit);

    // Dynamic calculations
    document.querySelectorAll('.issue-calc').forEach(input => {
        input.addEventListener('input', calculateIssueTotal);
    });

    document.querySelectorAll('.collect-calc').forEach(input => {
        input.addEventListener('input', calculateExpectedCash);
    });
    
    const handCashEl = document.getElementById('collect-handcash');
    if(handCashEl) handCashEl.addEventListener('input', calculateExpectedCash);
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
async function updateDashboardCard() {
    // Get target from settings table
    const { data: settingsData } = await _supabase.from('settings').select('*').limit(1).single();
    let targetSetting = settingsData;
    let workingDays = targetSetting && targetSetting.working_days ? targetSetting.working_days : 25;
    let monthlyTarget = 0;
    let monthSales = [];
    let todayIssuesList = [];
    let todaySalesList = [];
    let currentMonth = getCurrentMonthString();
    let todayStr = getTodayString();

    if(currentUser && currentUser.role === 'distributor') {
        // Distributor Stats
        const { data: staff } = await _supabase.from('staff').select('*').eq('id', currentUser.id).single();
        monthlyTarget = staff ? staff.target : 0;
        
        const { data: sales } = await _supabase.from('daily_sales')
            .select('*')
            .eq('staff_id', currentUser.id)
            .gte('date', currentMonth + '-01')
            .lte('date', currentMonth + '-31');
        monthSales = sales || [];
            
        const { data: issuesToday } = await _supabase.from('daily_issues').select('*').eq('date', todayStr).eq('staff_id', currentUser.id);
        todayIssuesList = issuesToday || [];

        const { data: salesToday } = await _supabase.from('daily_sales').select('*').eq('date', todayStr).eq('staff_id', currentUser.id);
        todaySalesList = salesToday || [];
        
        // Update header if needed or a sub-label
        document.getElementById('display-user-role').innerText = 'DISTRIBUTOR (' + (staff ? staff.route_name : '') + ')';
    } else {
        // Global Admin Stats
        monthlyTarget = targetSetting ? targetSetting.target_amount : 0;
        
        const { data: sales } = await _supabase.from('daily_sales')
            .select('*')
            .gte('date', currentMonth + '-01')
            .lte('date', currentMonth + '-31');
        monthSales = sales || [];
            
        const { data: issuesToday } = await _supabase.from('daily_issues').select('*').eq('date', todayStr);
        todayIssuesList = issuesToday || [];

        const { data: salesToday } = await _supabase.from('daily_sales').select('*').eq('date', todayStr);
        todaySalesList = salesToday || [];
    }
    
    let totalSales = monthSales.reduce((sum, record) => {
        let saleValue = (Number(record.sold_card_48 || 0) * 48) + 
                        (Number(record.sold_card_95 || 0) * 95) + 
                        (Number(record.sold_card__96 || 0) * 96) + 
                        Number(record.sold_reload_cash || 0);
        return sum + saleValue;
    }, 0);

    let totalMonthCommission = monthSales.reduce((sum, record) => sum + (Number(record.total_commission) || 0), 0);
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

    let totalTodayIssued = todayIssuesList.reduce((sum, r) => sum + Number(r.total_issued_value || 0), 0);
    let totalTodayCollected = todaySalesList.reduce((sum, r) => sum + Number(r.hand_cash || 0), 0);

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
        renderDistributorStats(targetSetting);
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
async function renderDistributorStats(settings) {
    const searchInput = document.getElementById('distributor-search');
    const query = searchInput ? searchInput.value.toLowerCase() : '';
    
    let { data: list } = await _supabase.from('staff').select('*');
    if(!list) return;
    
    if(query) {
        list = list.filter(s => s.name.toLowerCase().includes(query) || (s.route_name && s.route_name.toLowerCase().includes(query)));
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
        const { data: sales } = await _supabase.from('daily_sales')
            .select('*')
            .eq('staff_id', staff.id)
            .gte('date', currentMonth + '-01')
            .lte('date', currentMonth + '-31');

        let totalS = 0;
        let totalC = 0;
        (sales || []).forEach(r => {
            const val = (Number(r.sold_card_48 || 0) * 48) + (Number(r.sold_card_95 || 0) * 95) + (Number(r.sold_card__96 || 0) * 96) + Number(r.sold_reload_cash || 0);
            totalS += val;
            totalC += Number(r.total_commission || 0);
        });

        const target = staff.target || 0;
        const perc = target > 0 ? (totalS / target * 100) : 0;
        
        // Calculate dynamic daily target for this specific staff
        const workedDays = new Set((sales || []).map(r => r.date)).size;
        const totalWorkingDays = settings ? (settings.working_days || 25) : 25;
        let daysLeft = totalWorkingDays - workedDays;
        if(daysLeft < 1) daysLeft = 1;
        const remainingTarget = (target - totalS) > 0 ? (target - totalS) : 0;
        const dynamicDayTarget = remainingTarget / daysLeft;
        
        const lastRec = (sales || []).sort((a,b) => b.date.localeCompare(a.date))[0];
        const sAmt = lastRec ? Number(lastRec.shortage_amt || 0) : 0;
        const bStatus = sAmt > 0.01 ? 'SHORT' : (sAmt < -0.01 ? 'EXCESS' : 'BALANCED');
        const bColor = bStatus === 'EXCESS' ? 'text-emerald-400' : (bStatus === 'SHORT' ? 'text-rose-400' : 'text-gray-500');
        const bLabel = bStatus === 'SHORT' ? `-${formatCurrency(Math.abs(sAmt))}` : (bStatus === 'EXCESS' ? `+${formatCurrency(Math.abs(sAmt))}` : 'BALANCED');

        html += `
            <tr class="hover:bg-slate-800/30 transition-colors border-b border-slate-700/50 last:border-0">
                <td class="py-4 px-6">
                    <div class="font-bold text-white text-sm">${staff.name}</div>
                    <div class="text-[10px] text-gray-500 uppercase font-black">${staff.route_name}</div>
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
    document.getElementById('issue-total-reload-disp').innerText = formatCurrency(tReload);
    document.getElementById('issue-total-reload-val').value = tReload;

    const prevTotalValue = (p48 * 48) + (p95 * 95) + (p96 * 96) + pReload;
    const newTotalValue = (n48 * 48) + (n95 * 95) + (n96 * 96) + nReload;
    const grandTotalValue = prevTotalValue + newTotalValue;

    document.getElementById('issue-prev-total-val').innerText = formatCurrency(prevTotalValue);
    document.getElementById('issue-new-total-val').innerText = formatCurrency(newTotalValue);
    document.getElementById('issue-grand-total-val').innerText = formatCurrency(grandTotalValue);
}

async function handleIssueSubmit(e) {
    e.preventDefault();
    const date = document.getElementById('issue-date').value;
    const staffId = Number(document.getElementById('issue-staff').value);
    
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
        const { data: existing } = await _supabase.from('daily_issues').select('id').eq('date', date).eq('staff_id', staffId).limit(1).single();
        
        const data = {
            date, staff_id: staffId, 
            card_48: t48, card_95: t95, card_96: t96, reload_cash: tReload,
            new_c48: n48, new_c95: n95, new_c96: n96, new_reload: nReload,
            prev_c48: p48, prev_c95: p95, prev_c96: p96, prev_reload: pReload,
            total_issued_value: totalIssuedValue 
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
            await _supabase.from('daily_issues').update(data).eq('id', existing.id);
        } else {
            await _supabase.from('daily_issues').insert([data]);
        }
        
        showToast('Stock Issued Successfully');
        
        // Reset "New" fields
        ['issue-new-c48', 'issue-new-c95', 'issue-new-c96', 'issue-new-reload'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.value = 0;
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
        updateStaffPerformanceDisplay("");
        updateDashboardCard();
    } catch(err) {
        console.error(err);
        showToast('Error saving data', 'error');
    }
}

window.loadIssueForEdit = async function() {
    console.log('loadIssueForEdit called');
    const date = document.getElementById('issue-date').value;
    const staffId = Number(document.getElementById('issue-staff').value);
    
    console.log('Date:', date, 'Staff ID:', staffId);
    
    if(!date || !staffId) {
        Swal.fire('Info', 'Please select a staff and date first.', 'info');
        return;
    }

    try {
        const record = await db.dailyIssues.where({date, staffId}).first();
        if (record) {
            document.getElementById('issue-new-c48').value = record.newC48 || 0;
            document.getElementById('issue-new-c95').value = record.newC95 || 0;
            document.getElementById('issue-new-c96').value = record.newC96 || 0;
            document.getElementById('issue-new-reload').value = record.newReload || 0;
            
            // Re-load the previous balance for that day too
            document.getElementById('issue-prev-c48').value = record.prevC48 || 0;
            document.getElementById('issue-prev-c95').value = record.prevC95 || 0;
            document.getElementById('issue-prev-c96').value = record.prevC96 || 0;
            document.getElementById('issue-prev-reload').value = record.prevReload || 0;

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
        console.error(err);
        showToast('Error loading data', 'error');
    }
}


// --- Collection Logic ---
let currentIssuedData = null; // Cache
let previousShortage = 0; // State

async function handleLoadExpectedData() {
    const date = document.getElementById('collect-date').value;
    const staffId = Number(document.getElementById('collect-staff').value);
    if(!staffId) return Swal.fire({ icon: 'warning', title: 'Oops', text: 'Select staff first', background: '#1e293b', color: '#fff' });

    try {
        let { data: issued } = await _supabase.from('daily_issues').select('*').eq('date', date).eq('staff_id', staffId).limit(1).single();
        if(!issued) {
            Swal.fire({ icon: 'info', title: 'No Issued Stock', text: 'No stock was issued to this staff on selected date.', background: '#1e293b', color: '#fff' });
            document.getElementById('collection-details').classList.add('hidden');
            return;
        }

        currentIssuedData = issued;
        document.getElementById('collection-details').classList.remove('hidden');
        
        // Populate Availabilities (From setup)
        document.getElementById('avail-c48').value = issued.card_48;
        document.getElementById('avail-c95').value = issued.card_95;
        document.getElementById('avail-c96').value = issued.card_96;
        document.getElementById('avail-reload-disp').innerText = `Avail Reload: Rs. ${issued.reload_cash.toLocaleString()}`;
        document.getElementById('avail-reload-val').value = issued.reload_cash;

        // Reset fields
        ['sold-c48', 'sold-c95', 'sold-c96', 'sold-reload', 'collect-handcash'].forEach(id => document.getElementById(id).value = 0);
        
        // --- NEW: Load Previous Shortage ---
        const { data: salesList } = await _supabase.from('daily_sales')
            .select('*')
            .eq('staff_id', staffId)
            .lt('date', date)
            .order('date', { ascending: false })
            .limit(1);
        
        const lastSale = salesList && salesList[0];

        previousShortage = 0;
        const pBadge = document.getElementById('prev-shortage-badge');
        
        if(lastSale && lastSale.shortage_amt !== 0) {
            previousShortage = lastSale.shortage_amt;
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
        let { data: existingSale } = await _supabase.from('daily_sales').select('*').eq('date', date).eq('staff_id', staffId).limit(1).single();
        if(existingSale) {
            document.getElementById('sold-c48').value = existingSale.sold_card_48 || 0;
            document.getElementById('sold-c95').value = existingSale.sold_card_95 || 0;
            document.getElementById('sold-c96').value = existingSale.sold_card__96 || 0;
            document.getElementById('sold-reload').value = existingSale.sold_reload_cash || 0;
            document.getElementById('collect-handcash').value = existingSale.hand_cash || 0;
            showToast('Loaded previously saved collection', 'info');
        }
        
        calculateExpectedCash();
        showToast('Day setup data loaded');
    } catch(err) { console.error(err); showToast('Failed to load data', 'error'); }
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
    const staffId = Number(document.getElementById('collect-staff').value);
    
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

    if((soldCard48 > currentIssuedData.card_48) || 
       (soldCard95 > currentIssuedData.card_95) || 
       (soldCard96 > currentIssuedData.card_96)) {
        
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

    const data = {
        date, staff_id: staffId, 
        sold_card_48: soldCard48, sold_card_95: soldCard95, sold_card__96: soldCard96, sold_reload_cash: soldReloadCash,
        returned_card_48: returnedCard48, returned_card_95: returnedCard95, returned_card__96: returnedCard96,
        hand_cash: handCash, 
        total_commission: totalCommission,
        shortage_amt: shortageToday
    };

    try {
        const { data: existing } = await _supabase.from('daily_sales').select('id').eq('date', date).eq('staff_id', staffId).limit(1).single();
        if(existing) { 
            await _supabase.from('daily_sales').update(data).eq('id', existing.id); 
        } else { 
            await _supabase.from('daily_sales').insert([data]); 
        }
        
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

        await updateDashboardCard();
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
        const id = document.getElementById('staff-edit-id').value;
        const name = document.getElementById('staff-name').value;
        const route_name = document.getElementById('staff-route').value;
        const phone = document.getElementById('staff-phone').value;
        const password = document.getElementById('staff-password').value;
        const target = Number(document.getElementById('staff-target').value) || 0;
        
        if(id) {
            // Check if phone number is taken by ANOTHER staff member
            let { data: conflict } = await _supabase.from('staff').select('id').eq('phone', phone).neq('id', id).limit(1).single();
                
            if(conflict) {
                Swal.fire({ icon: 'error', title: 'Update Failed', text: `Phone number ${phone} is already assigned.`, background: '#1e293b', color: '#fff'});
                return;
            }

            await _supabase.from('staff').update({name, route_name, phone, password, target}).eq('id', id);
            showToast('Staff Updated');
            cancelStaffEdit();
        } else {
            // Check duplicate phone for NEW entry
            let { data: exists } = await _supabase.from('staff').select('id').eq('phone', phone).limit(1).single();
            if(exists) {
                Swal.fire({ icon: 'error', title: 'Duplicate Entry', text: `A staff member already exists with this phone.`, background: '#1e293b', color: '#fff'});
                return;
            }
            await _supabase.from('staff').insert([{name, route_name, phone, password, target}]);
            document.getElementById('staff-form').reset();
            showToast('Staff Added');
        }
        await loadStaffDropdowns();
        await renderStaffTable();
    });

    document.getElementById('target-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const target_amount = Number(document.getElementById('setting-target').value);
        const working_days = Number(document.getElementById('setting-days').value) || 25;
        const admin_password = document.getElementById('setting-admin-pass').value || 'admin123';
        
        const { data: first } = await _supabase.from('settings').select('*').limit(1).single();
        if(first) {
            await _supabase.from('settings').update({target_amount, working_days, admin_password}).eq('id', first.id);
        } else {
            await _supabase.from('settings').insert([{target_amount, working_days, admin_password}]);
        }
        showToast('Settings Updated');
        updateDashboardCard();
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
    const { data: list } = await _supabase.from('staff').select('*');
    if(!list) return;

    let issueDrop = document.getElementById('issue-staff');
    let collectDrop = document.getElementById('collect-staff');
    let reportDrop = document.getElementById('report-staff');
    
    // Clear existing
    if(issueDrop) issueDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';
    if(collectDrop) collectDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';
    if(reportDrop) reportDrop.innerHTML = '<option value="" disabled selected>Select Staff...</option>';

    list.forEach(s => {
        if(issueDrop) issueDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.route_name}</option>`);
        if(collectDrop) collectDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.route_name}</option>`);
        if(reportDrop) reportDrop.insertAdjacentHTML('beforeend', `<option value="${s.id}">${s.name} - ${s.route_name}</option>`);
    });

    // Also populate settings target if present
    let { data: s } = await _supabase.from('settings').select('*').limit(1).single();
    if(s) {
        const elTarget = document.getElementById('setting-target');
        const elDays = document.getElementById('setting-days');
        const elPass = document.getElementById('setting-admin-pass');
        if(elTarget) elTarget.value = s.target_amount || '';
        if(elDays) elDays.value = s.working_days || 25;
        if(elPass) elPass.value = s.admin_password || 'admin123';
    }
}

async function renderStaffTable() {
    const { data: list } = await _supabase.from('staff').select('*');
    if(!list) return;

    const tbody = document.getElementById('staff-table-body');
    const elCount = document.getElementById('staff-count');
    if(elCount) elCount.innerText = list.length;
    
    if(!tbody) return;

    if(list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-gray-500 italic">No staff registered yet. Add staff above.</td></tr>';
        return;
    }
    
    tbody.innerHTML = '';
    list.forEach((s, idx) => {
        tbody.insertAdjacentHTML('beforeend', `
            <tr class="hover:bg-slate-800/50 transition-colors">
                <td class="py-3 px-4 text-center font-medium">${idx+1}</td>
                <td class="py-3 px-4">
                    <div class="font-semibold text-white">${s.name}</div>
                    <div class="text-xs text-gray-500">${s.phone}</div>
                </td>
                <td class="py-3 px-4 text-gray-400">${s.route_name || ''}</td>
                <td class="py-3 px-4 text-emerald-400 font-medium">${formatCurrency(s.target || 0)}</td>
                <td class="py-3 px-4 text-right">
                    <button onclick="editStaff(${s.id})" class="text-blue-400 hover:text-blue-300 p-2 rounded-lg hover:bg-blue-400/10 transition-colors mr-1">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button onclick="deleteStaff(${s.id})" class="text-red-400 hover:text-red-300 p-2 rounded-lg hover:bg-red-400/10 transition-colors">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `);
    });
}

async function loadPreviousBalances() {
    const staffId = Number(document.getElementById('issue-staff').value);
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
        if(!staffId) await updateStaffPerformanceDisplay("");
        return;
    }

    // Find the last SALES record (Evening collection) BEFORE the selected date
    const { data: salesList } = await _supabase.from('daily_sales')
        .select('*')
        .eq('staff_id', staffId)
        .lt('date', selectedDate)
        .order('date', { ascending: false })
        .limit(1);
    
    const lastSale = salesList && salesList[0];

    if (lastSale) {
        document.getElementById('issue-prev-c48').value = lastSale.returned_card_48 || 0;
        document.getElementById('issue-prev-c95').value = lastSale.returned_card_95 || 0;
        document.getElementById('issue-prev-c96').value = lastSale.returned_card__96 || 0;
        
        // Rollover reload calculation (avail - sold)
        // Since availReload was saved, we use it.
        const prevReloadFull = lastSale.avail_reload || 0;
        const prevSoldReload = lastSale.sold_reload_cash || 0;
        document.getElementById('issue-prev-reload').value = (prevReloadFull - prevSoldReload) || 0;
        
        // --- NEW: Display Shortage/Excess in Issue Page ---
        const cashWrap = document.getElementById('issue-prev-cash-wrap');
        const cashLabel = document.getElementById('issue-prev-cash-label');
        const cashValue = document.getElementById('issue-prev-cash-val');
        
        if(lastSale.shortage_amt && lastSale.shortage_amt !== 0) {
            if(cashWrap) cashWrap.classList.remove('hidden');
            if(lastSale.shortage_amt > 0) {
                if(cashLabel) {
                    cashLabel.innerText = "Unpaid Shortage";
                    cashLabel.classList.replace('text-emerald-400', 'text-red-400');
                }
                if(cashValue) {
                    cashValue.innerText = `Rs. ${lastSale.shortage_amt}`;
                    cashValue.className = "text-base font-black text-red-500";
                }
            } else {
                if(cashLabel) {
                    cashLabel.innerText = "Excess Credit";
                    cashLabel.classList.replace('text-red-400', 'text-emerald-400');
                }
                if(cashValue) {
                    cashValue.innerText = `Rs. ${Math.abs(lastSale.shortage_amt)}`;
                    cashValue.className = "text-base font-black text-emerald-400";
                }
            }
        } else {
            if(cashWrap) cashWrap.classList.add('hidden');
        }

    } else {
        const cw = document.getElementById('issue-prev-cash-wrap');
        if(cw) cw.classList.add('hidden');
    }

    calculateIssueTotal();
}

// Global hook for inline onclicks
window.deleteStaff = async function(id) {
    let res = await Swal.fire({
        title: 'Delete Staff?',
        text: 'This will not delete past records, but removes staff from the list.',
        icon: 'warning',
        showCancelButton: true,
        background: '#1e293b',
        color: '#fff'
    });
    if(res.isConfirmed) {
        const { error } = await _supabase.from('staff').delete().eq('id', id);
        if(error) {
             Swal.fire({ icon: 'error', title: 'Error', text: 'Cannot delete staff with existing records.', background: '#1e293b', color: '#fff'});
        } else {
            showToast('Deleted');
            await loadStaffDropdowns();
            await renderStaffTable();
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

window.editStaff = async function(id) {
    const { data: s } = await _supabase.from('staff').select('*').eq('id', id).single();
    if(s) {
        document.getElementById('staff-edit-id').value = s.id;
        document.getElementById('staff-name').value = s.name;
        document.getElementById('staff-route').value = s.route_name || '';
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

// Migration Complete: Old reset and restore logic removed.
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
    const staffId = Number(document.getElementById('report-staff').value);
    
    if(!monthStr) return showToast('Please select a month', 'error');
    if(scope === 'single' && !staffId) return showToast('Please select a distributor', 'error');

    const printableArea = document.getElementById('report-printable-area');
    const content = document.getElementById('report-content');
    const titleMeta = document.getElementById('report-title-meta');
    const printDate = document.getElementById('report-print-date');

    if(printableArea) printableArea.classList.remove('hidden');
    const printBtn = document.getElementById('btn-print-report');
    if(printBtn) printBtn.classList.remove('hidden');
    if(printDate) printDate.innerText = new Date().toLocaleString();

    if(scope === 'all') {
        if(titleMeta) titleMeta.innerText = `Full Staff Monthly Summary - ${monthStr}`;
        await renderFullStaffSummary(monthStr, content);
    } else {
        const { data: staff } = await _supabase.from('staff').select('*').eq('id', staffId).single();
        if(titleMeta) titleMeta.innerText = `Distributor History: ${staff.name} (${staff.route_name}) - ${monthStr}`;
        await renderSingleStaffHistory(monthStr, staffId, content);
    }
    
    if(printableArea) printableArea.scrollIntoView({ behavior: 'smooth' });
}

async function renderFullStaffSummary(monthStr, container) {
    const { data: staffs } = await _supabase.from('staff').select('*');
    if(!staffs) return;

    // Pre-calculate data for ranking
    const staffData = [];
    for (const s of staffs) {
        const { data: salesRecords } = await _supabase.from('daily_sales')
            .select('*')
            .eq('staff_id', s.id)
            .gte('date', monthStr + '-01')
            .lte('date', monthStr + '-31');

        let totalS = 0;
        let totalC = 0;
        (salesRecords || []).forEach(r => {
            totalS += (Number(r.sold_card_48 || 0) * 48) + (Number(r.sold_card_95 || 0) * 95) + (Number(r.sold_card__96 || 0) * 96) + Number(r.sold_reload_cash || 0);
            totalC += Number(r.total_commission || 0);
        });

        const progress = (s.target || 0) > 0 ? (totalS / s.target * 100) : 0;
        
        const lastRec = (salesRecords || []).sort((a,b) => b.date.localeCompare(a.date))[0];
        const sAmt = lastRec ? Number(lastRec.shortage_amt || 0) : 0;
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
                    <div class="text-[10px] text-slate-500 uppercase font-black tracking-tighter">${s.route_name || ''}</div>
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
    if(container) container.innerHTML = html;
}

async function renderSingleStaffHistory(monthStr, staffId, container) {
    const { data: records } = await _supabase.from('daily_sales')
        .select('*')
        .eq('staff_id', staffId)
        .gte('date', monthStr + '-01')
        .lte('date', monthStr + '-31');

    if(!records) return;

    // PERFORMANCE SUMMARY LOGIC
    let totalSales = 0, totalCardsVal = 0, totalReloadVal = 0, totalComm = 0;
    let bestDay = { val: 0, date: 'N/A' };
    
    records.forEach(r => {
        const cVal = (Number(r.sold_card_48 || 0) * 48) + (Number(r.sold_card_95 || 0) * 95) + (Number(r.sold_card__96 || 0) * 96);
        const dayTotal = cVal + Number(r.sold_reload_cash || 0);
        totalSales += dayTotal;
        totalCardsVal += cVal;
        totalReloadVal += Number(r.sold_reload_cash || 0);
        totalComm += Number(r.total_commission || 0);
        if(dayTotal > bestDay.val) { bestDay = { val: dayTotal, date: r.date }; }
    });

    const avgDaily = records.length > 0 ? (totalSales / records.length) : 0;
    const { data: staff } = await _supabase.from('staff').select('*').eq('id', staffId).single();
    if(!staff) return;
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
        const cardsValue = (Number(r.sold_card_48 || 0) * 48) + (Number(r.sold_card_95 || 0) * 95) + (Number(r.sold_card__96 || 0) * 96);
        const dayTotalSales = cardsValue + Number(r.sold_reload_cash || 0);

        tCardsValue += cardsValue;
        tReload += Number(r.sold_reload_cash || 0);
        tSales += dayTotalSales;
        tCash += Number(r.hand_cash || 0);

        const sAmt = Number(r.shortage_amt || 0);
        const diffAmt = Math.abs(sAmt);
        const status = sAmt > 0.01 ? 'SHORT' : (sAmt < -0.01 ? 'EXCESS' : 'BALANCED');
        
        const colorClass = status === 'EXCESS' ? 'text-emerald-600' : (status === 'SHORT' ? 'text-rose-600' : 'text-slate-400');
        const shortLabel = status === 'SHORT' ? `(-${formatCurrency(diffAmt)})` : (status === 'EXCESS' ? `(+${formatCurrency(diffAmt)})` : 'BALANCED');

        html += `
            <tr class="border-b border-slate-100 hover:bg-indigo-50/20">
                <td class="py-2 px-2 font-bold">${r.date}</td>
                <td class="py-2 px-2 text-center font-mono">${formatCurrency(cardsValue)}</td>
                <td class="py-2 px-2 text-center font-mono">${formatCurrency(r.sold_reload_cash)}</td>
                <td class="py-2 px-2 text-center font-bold text-indigo-700 font-mono">${formatCurrency(dayTotalSales)}</td>
                <td class="py-2 px-2 text-center font-bold font-mono">${formatCurrency(r.hand_cash)}</td>
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
    if(container) container.innerHTML = html;
}

async function updateStaffPerformanceDisplay(staffId) {
    if(!staffId) {
        const card = document.getElementById('staff-perf-card');
        if(card) card.classList.add('hidden');
        return;
    }

    try {
        const { data: staff } = await _supabase.from('staff').select('*').eq('id', staffId).single();
        if(!staff) return;

        const currentMonth = getCurrentMonthString();
        const { data: sales } = await _supabase.from('daily_sales')
            .select('*')
            .eq('staff_id', staffId)
            .gte('date', currentMonth + '-01')
            .lte('date', currentMonth + '-31');

        const monthAchieved = (sales || []).reduce((sum, r) => {
            const cardVal = (Number(r.sold_card_48 || 0) * 48) + (Number(r.sold_card_95 || 0) * 95) + (Number(r.sold_card__96 || 0) * 96);
            return sum + cardVal + Number(r.sold_reload_cash || 0);
        }, 0);

        const { data: settings } = await _supabase.from('settings').select('*').limit(1).single();
        const workingDays = settings ? (settings.working_days || 25) : 25;
        const monthlyTarget = staff.target || 0;
        
        // Dynamic day target calculation
        const workedDays = new Set((sales || []).map(r => r.date)).size;
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
        tot48 += (Number(r.sold_card_48 || 0) * 48);
        tot95 += (Number(r.sold_card_95 || 0) * 95);
        tot96 += (Number(r.sold_card__96 || 0) * 96);
        totReload += Number(r.sold_reload_cash || 0);
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
    // With Supabase, backups are handled by the cloud provider.
    // However, we can use this to remind users about something else or just keep it minimal.
    const { data: s } = await _supabase.from('settings').select('*').limit(1).single();
    if(!s) return;

    const backupBtn = document.getElementById('btn-global-backup');
    if (!backupBtn) return;
    
    // We could hide it or repurpose it as a "Refresh" button.
    backupBtn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i> Data Sync';
    backupBtn.onclick = () => window.location.reload();
}

// End of Report Logic


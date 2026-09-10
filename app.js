// Configuration
const START_DATE = new Date('2026-09-01');
const END_DATE = new Date('2028-09-01');
const TIME_SLOTS = 48; // 24 hours * 2 (30-minute slots)

// Available colors for users (excluding dark green which is for 5+ and white for empty)
const AVAILABLE_COLORS = [
    '#e74c3c', // red
    '#e67e22', // orange
    '#f1c40f', // yellow
    '#1abc9c', // teal
    '#3498db', // blue
    '#9b59b6', // purple
    '#fd79a8', // pink
    '#00cec9', // cyan
    '#fdcb6e', // amber
    '#d63031', // crimson
    '#6c5ce7', // indigo
    '#00b894', // mint
    '#ff7675', // salmon
    '#74b9ff', // light blue
    '#a29bfe', // lavender
    '#fab1a0', // peach
];

// State
let currentUser = null;
let currentWeekStart = new Date();
let userData = {};
let isDragging = false;
let dragMode = true; // true = marking, false = unmarking
let selectedColor = AVAILABLE_COLORS[0];

// Storage key for localStorage
const STORAGE_KEY = 'when2meet_clone_data';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupEventListeners();
    renderPersonalCalendar();
    renderAggregateCalendar();
    updateColorPicker();
    
    // Set current week to today's week
    const today = new Date();
    currentWeekStart = getWeekStart(today);
});

// LocalStorage functions
function loadData() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        userData = JSON.parse(stored);
    }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday as start
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function formatDateKey(date) {
    return date.toISOString().split('T')[0];
}

function getTimeSlotIndex(hour, minute) {
    return hour * 2 + (minute >= 30 ? 1 : 0);
}

function getTimeFromSlotIndex(index) {
    const hour = Math.floor(index / 2);
    const minute = (index % 2) * 30;
    return { hour, minute };
}

function getSlotKey(date, slotIndex) {
    return `${formatDateKey(date)}-${slotIndex}`;
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('username').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
    
    document.getElementById('prevWeek').addEventListener('click', () => {
        currentWeekStart.setDate(currentWeekStart.getDate() - 7);
        renderPersonalCalendar();
        renderAggregateCalendar();
    });
    
    document.getElementById('nextWeek').addEventListener('click', () => {
        currentWeekStart.setDate(currentWeekStart.getDate() + 7);
        renderPersonalCalendar();
        renderAggregateCalendar();
    });
    
    document.getElementById('todayBtn').addEventListener('click', () => {
        currentWeekStart = getWeekStart(new Date());
        renderPersonalCalendar();
        renderAggregateCalendar();
    });
    
    // Global mouse up to stop dragging
    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

function handleLogin() {
    const usernameInput = document.getElementById('username');
    const username = usernameInput.value.trim();
    
    if (!username) {
        alert('Please enter a name');
        return;
    }
    
    currentUser = username;
    document.getElementById('welcomeMsg').textContent = `Welcome, ${username}!`;
    usernameInput.disabled = true;
    document.getElementById('loginBtn').disabled = true;
    
    // Load user's color if exists
    if (userData[username] && userData[username].color) {
        selectedColor = userData[username].color;
    }
    
    updateColorPicker();
    renderPersonalCalendar();
}

function updateColorPicker() {
    const userInfo = document.querySelector('.user-info');
    const existingPicker = userInfo.querySelector('.color-picker-container');
    if (existingPicker) existingPicker.remove();
    
    if (!currentUser) return;
    
    const pickerContainer = document.createElement('div');
    pickerContainer.className = 'color-picker-container';
    
    // Get colors used by other users
    const usedColors = new Set();
    Object.keys(userData).forEach(name => {
        if (name !== currentUser && userData[name].color) {
            usedColors.add(userData[name].color);
        }
    });
    
    AVAILABLE_COLORS.forEach(color => {
        const colorOption = document.createElement('div');
        colorOption.className = 'color-option';
        colorOption.style.backgroundColor = color;
        
        if (usedColors.has(color)) {
            colorOption.classList.add('disabled');
        } else {
            colorOption.addEventListener('click', () => {
                selectedColor = color;
                userData[currentUser].color = color;
                saveData();
                updateColorPicker();
                renderPersonalCalendar();
            });
        }
        
        if (color === selectedColor) {
            colorOption.classList.add('selected');
        }
        
        pickerContainer.appendChild(colorOption);
    });
    
    userInfo.appendChild(pickerContainer);
}

// Render personal calendar
function renderPersonalCalendar() {
    const container = document.getElementById('personalCalendar');
    container.innerHTML = '';
    
    // Update week label
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    document.getElementById('currentWeekLabel').textContent = 
        `${formatDateDisplay(currentWeekStart)} - ${formatDateDisplay(weekEnd)}`;
    
    // Create time labels column
    for (let i = 0; i < TIME_SLOTS; i++) {
        const { hour, minute } = getTimeFromSlotIndex(i);
        const timeLabel = document.createElement('div');
        timeLabel.className = 'time-label';
        timeLabel.textContent = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        container.appendChild(timeLabel);
    }
    
    // Create day columns
    for (let day = 0; day < 7; day++) {
        const currentDate = new Date(currentWeekStart);
        currentDate.setDate(currentDate.getDate() + day);
        
        // Day header
        const dayHeader = document.createElement('div');
        dayHeader.className = 'day-header';
        dayHeader.textContent = `${currentDate.toLocaleDateString('en-US', { weekday: 'short' })} ${currentDate.getMonth() + 1}/${currentDate.getDate()}`;
        container.appendChild(dayHeader);
        
        // Time slots
        for (let slot = 0; slot < TIME_SLOTS; slot++) {
            const slotDiv = document.createElement('div');
            slotDiv.className = 'slot';
            
            const slotKey = getSlotKey(currentDate, slot);
            
            if (currentUser && userData[currentUser] && userData[currentUser].slots && userData[currentUser].slots[slotKey]) {
                slotDiv.style.backgroundColor = userData[currentUser].color || selectedColor;
                slotDiv.classList.remove('empty');
            } else {
                slotDiv.classList.add('empty');
            }
            
            // Mouse events for drag-to-fill
            slotDiv.addEventListener('mousedown', (e) => {
                e.preventDefault();
                isDragging = true;
                
                if (currentUser) {
                    const isCurrentlyMarked = userData[currentUser]?.slots?.[slotKey];
                    dragMode = !isCurrentlyMarked;
                    
                    if (!userData[currentUser]) {
                        userData[currentUser] = { slots: {}, color: selectedColor };
                    }
                    if (!userData[currentUser].slots) {
                        userData[currentUser].slots = {};
                    }
                    
                    if (dragMode) {
                        userData[currentUser].slots[slotKey] = true;
                    } else {
                        delete userData[currentUser].slots[slotKey];
                    }
                    saveData();
                    renderPersonalCalendar();
                }
            });
            
            slotDiv.addEventListener('mouseenter', () => {
                if (isDragging && currentUser) {
                    if (!userData[currentUser]) {
                        userData[currentUser] = { slots: {}, color: selectedColor };
                    }
                    if (!userData[currentUser].slots) {
                        userData[currentUser].slots = {};
                    }
                    
                    if (dragMode) {
                        userData[currentUser].slots[slotKey] = true;
                    } else {
                        delete userData[currentUser].slots[slotKey];
                    }
                    saveData();
                    renderPersonalCalendar();
                }
            });
            
            container.appendChild(slotDiv);
        }
    }
}

// Render aggregate calendar
function renderAggregateCalendar() {
    const container = document.getElementById('aggregateCalendar');
    container.innerHTML = '';
    
    // Update week label
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    document.getElementById('aggregateWeekLabel').textContent = 
        `${formatDateDisplay(currentWeekStart)} - ${formatDateDisplay(weekEnd)}`;
    
    // Time labels column
    for (let i = 0; i < TIME_SLOTS; i++) {
        const { hour, minute } = getTimeFromSlotIndex(i);
        const timeLabel = document.createElement('div');
        timeLabel.className = 'time-label';
        timeLabel.textContent = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        container.appendChild(timeLabel);
    }
    
    // Day columns
    for (let day = 0; day < 7; day++) {
        const currentDate = new Date(currentWeekStart);
        currentDate.setDate(currentDate.getDate() + day);
        
        // Day header
        const dayHeader = document.createElement('div');
        dayHeader.className = 'day-header';
        dayHeader.textContent = `${currentDate.toLocaleDateString('en-US', { weekday: 'short' })} ${currentDate.getMonth() + 1}/${currentDate.getDate()}`;
        container.appendChild(dayHeader);
        
        // Time slots
        for (let slot = 0; slot < TIME_SLOTS; slot++) {
            const slotDiv = document.createElement('div');
            slotDiv.className = 'slot';
            
            const slotKey = getSlotKey(currentDate, slot);
            
            // Count how many users have this slot marked
            let count = 0;
            Object.keys(userData).forEach(username => {
                if (userData[username].slots && userData[username].slots[slotKey]) {
                    count++;
                }
            });
            
            // Color based on count
            if (count === 0) {
                slotDiv.classList.add('empty');
            } else if (count >= 5) {
                slotDiv.style.backgroundColor = '#27ae60'; // grass green
            } else if (count >= 3) {
                slotDiv.style.backgroundColor = '#82e0aa'; // medium
            } else {
                slotDiv.style.backgroundColor = '#d5f5e3'; // low
            }
            
            // Show count on hover via title
            slotDiv.title = `${count} participant${count !== 1 ? 's' : ''}`;
            
            container.appendChild(slotDiv);
        }
    }
}

function formatDateDisplay(date) {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

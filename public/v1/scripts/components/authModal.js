// components/authModal.js
// Auth state utilities — modal replaced by dedicated pages (login.html / signup.html)

let isAuthenticated = false;
let currentUser = null;

export async function handleLogout() {
    try {
        const response = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });

        if (response.ok) {
            isAuthenticated = false;
            currentUser = null;
            window.location.href = 'https://www.google.com';
        }
    } catch (error) {
        console.error('Logout error:', error);
    }
}

export function getAuthStatus() {
    return { isAuthenticated, user: currentUser };
}

export async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth/status', {
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            isAuthenticated = data.authenticated;
            currentUser = data.user;
            return data;
        }
    } catch (error) {
        console.error('Error checking auth status:', error);
    }

    return { authenticated: false, isAnonymous: true };
}

// Stubs — redirect to dedicated pages instead of opening a modal
export function initAuthModal() {}
export function openLoginModal() { window.location.href = '/login.html'; }
export function openSignupModal() { window.location.href = '/signup.html'; }
export function closeAuthModal() {}

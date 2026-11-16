(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    /**
     * Pasang listener tombol logout, modal edit profil, tab edit data/password, dan submit form profil/password.
     */
    function bindEvents() {
        const { clearAuthToken } = global.MikuShared.auth;
        const { apiFetch } = global.MikuShared.api;
        const {
            logoutButton,
            editProfileBtn,
            editModal,
            closeEditModalBtn,
            tabLinks,
            tabContents,
            editProfileForm,
            changePasswordForm,
        } = app.state.els;

        if (logoutButton) {
            logoutButton.addEventListener('click', (e) => {
                e.preventDefault();
                clearAuthToken();
                window.location.href = 'index.html';
            });
        }

        if (editProfileBtn && editModal && closeEditModalBtn) {
            editProfileBtn.addEventListener('click', () => editModal.classList.remove('hidden'));
            closeEditModalBtn.addEventListener('click', () => editModal.classList.add('hidden'));
        }

        if (tabLinks.length > 0 && tabContents.length > 0) {
            tabLinks.forEach(link => {
                link.addEventListener('click', () => {
                    tabLinks.forEach(l => l.classList.remove('active'));
                    tabContents.forEach(c => c.classList.add('hidden'));
                    link.classList.add('active');
                    document.getElementById(link.dataset.tab).classList.remove('hidden');
                });
            });
        }

        if (editProfileForm) {
            editProfileForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const data = {
                    fullName: editProfileForm.querySelector('[name="fullName"]').value,
                    email: editProfileForm.querySelector('[name="email"]').value,
                    nomorWa: editProfileForm.querySelector('[name="nomorWa"]').value,
                };
                try {
                    const response = await apiFetch(`${app.API_URL}/profile`, {
                        method: 'PUT',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                    app.overview.fetchProfileData();
                    if (editModal) editModal.classList.add('hidden');
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });
        }

        if (changePasswordForm) {
            changePasswordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const newPassword = changePasswordForm.querySelector('[name="newPassword"]').value;
                if (newPassword !== changePasswordForm.querySelector('[name="confirmNewPassword"]').value) {
                    alert('Password Baru dan Konfirmasi tidak cocok!');
                    return;
                }
                const data = {
                    currentPassword: changePasswordForm.querySelector('[name="currentPassword"]').value,
                    newPassword: newPassword,
                };
                try {
                    const response = await apiFetch(`${app.API_URL}/password`, {
                        method: 'PUT',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                    changePasswordForm.reset();
                    if (editModal) editModal.classList.add('hidden');
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });
        }
    }

    app.profile = {
        bindEvents,
    };
})(window);

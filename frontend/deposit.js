document.addEventListener('DOMContentLoaded', function() {
    const API_URL = '/api/deposit/request';
    const token = localStorage.getItem('authToken');

    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    const depositForm = document.getElementById('deposit-form');
    const paymentInstructionsSection = document.getElementById('payment-instructions');
    const instructionText = document.getElementById('instruction-text');

    depositForm.addEventListener('submit', async function(e) {
        e.preventDefault();this.scrollBy
        const amount = this.querySelector('input[name="amount"]').value;
        
        // Tampilkan بخش instruksi dan pesan loading
        paymentInstructionsSection.classList.remove('hidden');
        instructionText.innerHTML = 'Memproses permintaan Anda...';

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ amount: parseInt(amount) })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.message);
            }

            // Tampilkan instruksi pembayaran dari server
            instructionText.innerHTML = result.deposit.paymentInstructions;
            depositForm.reset(); // Kosongkan form

        } catch (error) {
            instructionText.innerHTML = `<strong>Error:</strong> ${error.message}`;
        }
    });
});
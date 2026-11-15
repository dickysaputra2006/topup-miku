/**
 * Transactional in-memory PostgreSQL mock used by idempotency (SEC-009) integration suites.
 */
function createTransactionalMockDb(initialUsers, initialProducts, options = {}) {
    const users = new Map();
    for (const u of initialUsers) {
        users.set(u.id, { ...u });
    }
    const products = new Map();
    for (const p of initialProducts) {
        products.set(p.id, { ...p });
    }
    const transactions = [];
    const deposits = [];
    const balanceHistory = [];
    let nextTxId = 1;
    let nextDepId = 1;
    let rollbackCount = 0;

    const matchTxByRef = (userId, refId) => transactions.find(
        (t) => t.user_id === userId && t.ref_id !== null && t.ref_id === refId
    ) || null;

    const matchDepByKey = (userId, key) => deposits.find(
        (d) => d.user_id === userId && d.idempotency_key !== null && d.idempotency_key === key
    ) || null;

    const runQuery = async (sql, params = [], txState = null) => {
        if (typeof sql !== 'string') return { rows: [] };
        if (sql === 'BEGIN') return {};
        if (sql === 'COMMIT') return {};
        if (sql === 'ROLLBACK') return {};

        // protectH2H & protectH2HIp lookups
        if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
            const candidatePlain = params[0];
            const candidateHash = params[1];
            for (const u of users.values()) {
                if ((u.api_key_hash && u.api_key_hash === candidateHash) || (u.api_key && u.api_key === candidatePlain)) {
                    return { rows: [{ ...u }] };
                }
            }
            return { rows: [] };
        }
        if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ id: u.id, whitelisted_ips: u.whitelisted_ips || [], api_key: u.api_key || null, api_key_hash: u.api_key_hash || null }] } : { rows: [] };
        }
        if (sql.includes('FROM users u JOIN roles r') && sql.includes('u.id = $1') && !sql.includes('FOR UPDATE')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ id: u.id, username: u.username, role_name: u.role_name, balance: u.balance, role_id: u.role_id }] } : { rows: [] };
        }

        // Payment method lookup for deposits
        if (sql.includes('FROM payment_methods')) {
            const methodInput = String(params[0] || '').toLowerCase();
            if (methodInput === 'bca') {
                return {
                    rows: [{
                        id: 1, code: 'BCA', name: 'Bank BCA', type: 'bank',
                        account_number: '901000111', account_name: 'MIKU Store',
                        qris_image_url: null, instructions: 'Kirim tepat nominal',
                        is_qris: false, min_amount: 10000
                    }]
                };
            }
            if (methodInput === 'qris') {
                return {
                    rows: [{
                        id: 2, code: 'QRIS', name: 'QRIS All Payment', type: 'qris',
                        account_number: null, account_name: 'MIKU Store QRIS',
                        qris_image_url: '/qris.png', instructions: null,
                        is_qris: true, min_amount: 10000
                    }]
                };
            }
            return { rows: [] };
        }

        // Transaction lookup by (user_id, ref_id)
        if (sql.includes('FROM transactions t') && sql.includes('t.ref_id = $2')) {
            const found = matchTxByRef(params[0], params[1]);
            if (!found) return { rows: [] };
            const prod = products.get(found.product_id);
            return {
                rows: [{
                    ...found,
                    product_name: prod ? prod.name : 'Unknown Product',
                    needs_server_id: prod ? Boolean(prod.needs_server_id) : false
                }]
            };
        }

        // Deposit lookup by (user_id, idempotency_key)
        if (sql.includes('FROM deposits') && sql.includes('idempotency_key = $2')) {
            const found = matchDepByKey(params[0], params[1]);
            return { rows: found ? [{ ...found }] : [] };
        }

        // Public transaction lookup by invoice_id
        if (sql.includes('FROM transactions t') && sql.includes('t.invoice_id = $1')) {
            const found = transactions.find((t) => t.invoice_id === params[0]);
            if (!found) return { rows: [] };
            const prod = products.get(found.product_id);
            return {
                rows: [{
                    invoice_id: found.invoice_id,
                    status: found.status,
                    price: found.price,
                    created_at: found.created_at,
                    updated_at: found.updated_at,
                    product_name: prod ? prod.name : 'Test Product',
                    game_name: 'Mobile Legends'
                }]
            };
        }

        // Public recent transactions
        if (sql.includes('FROM transactions t') && sql.includes('ORDER BY t.created_at DESC')) {
            return {
                rows: [...transactions].reverse().slice(0, 10).map((t) => {
                    const prod = products.get(t.product_id);
                    return {
                        invoice_id: t.invoice_id,
                        status: t.status,
                        created_at: t.created_at,
                        product_name: prod ? prod.name : 'Test Product',
                        game_name: 'Mobile Legends'
                    };
                })
            };
        }

        // Product + game lookup
        if (sql.includes('JOIN games g') && (sql.includes('p.id = $1') || sql.includes('WHERE id = $1'))) {
            const prod = products.get(params[0]);
            return { rows: prod ? [{ ...prod }] : [] };
        }

        // Pending deposit count check
        if (sql.includes("FROM deposits WHERE user_id = $1 AND status = 'Pending'")) {
            if (typeof options.pendingDepositCountOverride === 'function') {
                return { rows: [{ count: String(options.pendingDepositCountOverride()) }] };
            }
            const cnt = deposits.filter((d) => d.user_id === params[0] && d.status === 'Pending').length;
            return { rows: [{ count: String(cnt) }] };
        }

        if (sql.includes("FROM deposits WHERE status = 'Pending' AND amount = $1")) {
            return { rows: [] };
        }

        // User FOR UPDATE
        if (sql.includes('FROM users u JOIN roles r') && sql.includes('FOR UPDATE')) {
            const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
            return target ? { rows: [{ balance: target.balance, role_id: target.role_id, role_name: target.role_name }] } : { rows: [] };
        }
        if (sql.includes('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE')) {
            const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
            return target ? { rows: [{ balance: target.balance, role_id: target.role_id }] } : { rows: [] };
        }

        if (sql.includes('SELECT margin_percent FROM roles WHERE id = $1')) {
            return { rows: [{ margin_percent: 10 }] };
        }

        if (sql.includes('FROM flash_sales')) {
            return { rows: [] };
        }

        if (sql.includes('SELECT invoice_id') && sql.includes('FROM transactions') && sql.includes("status = 'Pending'")) {
            const found = transactions.find(
                (t) => t.user_id === params[0] && t.product_id === params[1] && t.target_game_id === params[2] && t.status === 'Pending'
            );
            return { rows: found ? [{ invoice_id: found.invoice_id }] : [] };
        }

        // Deduct balance (staged until COMMIT)
        if (sql.includes('UPDATE users SET balance = balance - $1')) {
            const amt = Number(params[0]);
            const uid = params[1];
            const u = txState.stagedUsers.get(uid);
            if (!u || Number(u.balance) < amt) return { rowCount: 0 };
            u.balance = Number(u.balance) - amt;
            return { rowCount: 1 };
        }

        // Refund balance
        if (sql.includes('UPDATE users SET balance = balance + $1')) {
            const amt = Number(params[0]);
            const uid = params[1];
            const u = txState.stagedUsers.get(uid);
            if (u) u.balance = Number(u.balance) + amt;
            return { rowCount: 1 };
        }

        // INSERT INTO transactions
        if (sql.includes('INSERT INTO transactions')) {
            if (typeof options.beforeTxInsert === 'function') {
                await options.beforeTxInsert(params);
            }
            const hasRefCol = sql.includes('ref_id');
            const invoiceId = params[0];
            const userId = params[1];
            const productId = params[2];
            const targetGameId = params[3];
            const price = Number(params[4]);
            const status = params[5];
            const providerTrxId = params[6];
            const flashSaleId = params[7] || null;
            const refId = hasRefCol ? (params[8] || null) : null;

            if (refId !== null && matchTxByRef(userId, refId)) {
                const dupErr = new Error('duplicate key value violates unique constraint "uq_transactions_user_ref_id"');
                dupErr.code = '23505';
                dupErr.constraint = 'uq_transactions_user_ref_id';
                throw dupErr;
            }
            const row = {
                id: nextTxId++,
                invoice_id: invoiceId,
                user_id: userId,
                product_id: productId,
                target_game_id: targetGameId,
                price,
                status,
                provider_trx_id: providerTrxId,
                flash_sale_id: flashSaleId,
                ref_id: refId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            txState.stagedTransactions.push(row);
            return { rows: [{ id: row.id }] };
        }

        // INSERT INTO deposits
        if (sql.includes('INSERT INTO deposits')) {
            if (typeof options.beforeDepositInsert === 'function') {
                await options.beforeDepositInsert(params);
            }
            const hasIdemCol = sql.includes('idempotency_key');
            const userId = params[0];
            const amount = Number(params[1]);
            const uniqueCode = Number(params[2]);
            const status = params[3];
            const method = params[4];
            const note = params[5] || null;
            const idempotencyKey = hasIdemCol ? (params[6] || null) : null;

            if (idempotencyKey !== null && matchDepByKey(userId, idempotencyKey)) {
                const dupErr = new Error('duplicate key value violates unique constraint "uq_deposits_user_idempotency_key"');
                dupErr.code = '23505';
                dupErr.constraint = 'uq_deposits_user_idempotency_key';
                throw dupErr;
            }
            const now = new Date().toISOString();
            const row = {
                id: nextDepId++,
                user_id: userId,
                amount,
                unique_code: uniqueCode,
                status,
                method,
                note,
                idempotency_key: idempotencyKey,
                created_at: now,
                updated_at: now
            };
            txState.stagedDeposits.push(row);
            return { rows: [{ id: row.id, created_at: row.created_at }] };
        }

        if (sql.includes('INSERT INTO balance_history')) {
            const isRefundLiteral = sql.includes("'Refund'");
            txState.stagedHistory.push({
                user_id: params[0],
                amount: Number(params[1]),
                type: isRefundLiteral ? 'Refund' : params[2],
                description: isRefundLiteral ? params[2] : params[3],
                reference_id: isRefundLiteral ? params[3] : params[4]
            });
            return { rowCount: 1 };
        }

        if (sql.includes('FROM transactions WHERE invoice_id = $1 FOR UPDATE')) {
            const found = transactions.find((t) => t.invoice_id === params[0]);
            return { rows: found ? [{ ...found }] : [] };
        }

        if (sql.includes('UPDATE transactions SET provider_trx_id')) {
            const nextProviderTrxId = params[0];
            const invoiceKey = params[1];
            const target = transactions.find((t) => t.invoice_id === invoiceKey || t.id === invoiceKey);
            if (!target) return { rowCount: 0 };
            if (txState) {
                txState.stagedProviderTrxUpdates.push({ tx: target, providerTrxId: nextProviderTrxId });
            } else if (!target.provider_trx_id) {
                target.provider_trx_id = nextProviderTrxId;
            }
            return { rowCount: 1 };
        }

        if (sql.includes("SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund'")) {
            const exists = balanceHistory.find((h) => h.reference_id === params[0] && h.type === 'Refund');
            return { rows: exists ? [{ id: 1 }] : [] };
        }

        if (sql.includes("UPDATE transactions SET status = 'Failed'")) {
            const allowed = ['Pending', 'Processing', 'Partial Refund'];
            const byId = sql.includes('WHERE id = $1');
            const target = transactions.find((t) => (byId ? t.id === params[0] : t.invoice_id === params[0]) && allowed.includes(t.status));
            if (!target) return { rowCount: 0 };
            if (txState) {
                txState.stagedStatusUpdates.push({ tx: target, status: 'Failed' });
            } else {
                target.status = 'Failed';
            }
            return { rowCount: 1 };
        }

        if (sql.includes('DELETE FROM promo_usages WHERE transaction_id = $1')) {
            return { rows: [] };
        }

        return { rows: [] };
    };

    const createClient = () => {
        let txState = null;
        return {
            query: async (sql, params = []) => {
                if (sql === 'BEGIN') {
                    const stagedUsers = new Map();
                    for (const [k, v] of users.entries()) {
                        stagedUsers.set(k, { ...v });
                    }
                    txState = {
                        stagedUsers,
                        stagedTransactions: [],
                        stagedDeposits: [],
                        stagedHistory: [],
                        stagedStatusUpdates: [],
                        stagedProviderTrxUpdates: []
                    };
                    return {};
                }
                if (sql === 'COMMIT') {
                    if (txState) {
                        const committed = {
                            transactions: [...txState.stagedTransactions],
                            deposits: [...txState.stagedDeposits]
                        };
                        for (const [k, v] of txState.stagedUsers.entries()) {
                            users.set(k, v);
                        }
                        for (const tx of txState.stagedTransactions) {
                            // Double-check unique constraint at commit too
                            if (tx.ref_id !== null && matchTxByRef(tx.user_id, tx.ref_id)) {
                                const dupErr = new Error('duplicate key value violates unique constraint "uq_transactions_user_ref_id"');
                                dupErr.code = '23505';
                                throw dupErr;
                            }
                            transactions.push(tx);
                        }
                        for (const dep of txState.stagedDeposits) {
                            if (dep.idempotency_key !== null && matchDepByKey(dep.user_id, dep.idempotency_key)) {
                                const dupErr = new Error('duplicate key value violates unique constraint "uq_deposits_user_idempotency_key"');
                                dupErr.code = '23505';
                                throw dupErr;
                            }
                            deposits.push(dep);
                        }
                        for (const h of txState.stagedHistory) {
                            balanceHistory.push(h);
                        }
                        for (const upd of (txState.stagedStatusUpdates || [])) {
                            upd.tx.status = upd.status;
                        }
                        for (const upd of (txState.stagedProviderTrxUpdates || [])) {
                            if (!upd.tx.provider_trx_id) {
                                upd.tx.provider_trx_id = upd.providerTrxId;
                            }
                        }
                        txState = null;
                        if (typeof options.onCommit === 'function') {
                            await options.onCommit(committed);
                        }
                    }
                    return {};
                }
                if (sql === 'ROLLBACK') {
                    if (txState) {
                        rollbackCount++;
                        txState = null;
                    }
                    return {};
                }
                return runQuery(sql, params, txState);
            },
            release: () => {}
        };
    };

    return {
        users,
        products,
        transactions,
        deposits,
        balanceHistory,
        getRollbackCount: () => rollbackCount,
        poolQuery: async (sql, params) => runQuery(sql, params, null),
        poolConnect: async () => createClient()
    };
}

/**
 * 3-phase order and pool-exhaustion PostgreSQL mock used by SEC-013 integration suites.
 */
function createPhase13MockDb(initialUsers, initialProducts) {
    const users = new Map();
    for (const u of initialUsers) {
        users.set(u.id, { ...u });
    }
    const products = new Map();
    for (const p of initialProducts) {
        products.set(p.id, { ...p });
    }
    const transactions = [];
    const balanceHistory = [];
    let nextTxId = 1;
    let activeClients = 0;
    let connectCalls = 0;

    const runQuery = async (sql, params = [], txState = null) => {
        if (typeof sql !== 'string') return { rows: [] };
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

        if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
            const candidatePlain = params[0];
            const candidateHash = params[1];
            for (const u of users.values()) {
                if ((u.api_key_hash && u.api_key_hash === candidateHash) || (u.api_key && u.api_key === candidatePlain)) {
                    return { rows: [{ ...u }] };
                }
            }
            return { rows: [] };
        }
        if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ id: u.id, whitelisted_ips: u.whitelisted_ips || [], api_key: u.api_key || null, api_key_hash: u.api_key_hash || null }] } : { rows: [] };
        }
        if (sql.includes('FROM users u JOIN roles r') && sql.includes('u.id = $1') && !sql.includes('FOR UPDATE')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ id: u.id, username: u.username, role_name: u.role_name, balance: u.balance, role_id: u.role_id }] } : { rows: [] };
        }
        if (sql.includes('JOIN games g') && (sql.includes('p.id = $1') || sql.includes('WHERE id = $1'))) {
            const prod = products.get(params[0]);
            return { rows: prod ? [{ ...prod }] : [] };
        }
        if (sql.includes('FROM users u JOIN roles r') && sql.includes('FOR UPDATE')) {
            const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
            return target ? { rows: [{ balance: target.balance, role_id: target.role_id, role_name: target.role_name }] } : { rows: [] };
        }
        if (sql.includes('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE')) {
            const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
            return target ? { rows: [{ balance: target.balance, role_id: target.role_id }] } : { rows: [] };
        }
        if (sql.includes('SELECT margin_percent FROM roles WHERE id = $1')) {
            return { rows: [{ margin_percent: 10 }] };
        }
        if (sql.includes('FROM flash_sales')) {
            return { rows: [] };
        }
        if (sql.includes('FROM transactions t') && sql.includes('t.provider_trx_id = $1')) {
            const found = params[0]
                ? transactions.find((t) => t.provider_trx_id !== null && t.provider_trx_id === params[0])
                : null;
            if (!found) return { rows: [] };
            const prod = products.get(found.product_id);
            return {
                rows: [{
                    ...found,
                    provider_sku: prod ? prod.provider_sku : null,
                    cost_price: prod ? Number(prod.price) : null
                }]
            };
        }
        if (sql.includes('FROM transactions t') && (sql.includes('t.ref_id = $2') || sql.includes('t.invoice_id = $1'))) {
            return { rows: [] };
        }
        if (sql.includes('FROM products WHERE id = $1')) {
            const prod = products.get(params[0]);
            return { rows: prod ? [{ ...prod }] : [] };
        }
        if (sql.includes('SELECT invoice_id') && sql.includes('FROM transactions') && sql.includes("status = 'Pending'")) {
            return { rows: [] };
        }
        if (sql.includes('UPDATE users SET balance = balance - $1')) {
            const amt = Number(params[0]);
            const uid = params[1];
            const u = txState.stagedUsers.get(uid);
            if (!u || Number(u.balance) < amt) return { rowCount: 0 };
            u.balance = Number(u.balance) - amt;
            return { rowCount: 1 };
        }
        if (sql.includes('UPDATE users SET balance = balance + $1')) {
            const amt = Number(params[0]);
            const uid = params[1];
            const u = txState.stagedUsers.get(uid);
            if (u) u.balance = Number(u.balance) + amt;
            return { rowCount: 1 };
        }
        if (sql.includes('INSERT INTO transactions')) {
            const hasRefCol = sql.includes('ref_id');
            const row = {
                id: nextTxId++,
                invoice_id: params[0],
                user_id: params[1],
                product_id: params[2],
                target_game_id: params[3],
                price: Number(params[4]),
                status: params[5],
                provider_trx_id: params[6],
                flash_sale_id: params[7] || null,
                flash_sale_restored: false,
                ref_id: hasRefCol ? (params[8] || null) : null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            txState.stagedTransactions.push(row);
            return { rows: [{ id: row.id }] };
        }
        if (sql.includes('INSERT INTO balance_history')) {
            const isRefundLiteral = sql.includes("'Refund'");
            txState.stagedHistory.push({
                user_id: params[0],
                amount: Number(params[1]),
                type: isRefundLiteral ? 'Refund' : params[2],
                description: isRefundLiteral ? params[2] : params[3],
                reference_id: isRefundLiteral ? params[3] : params[4]
            });
            return { rowCount: 1 };
        }
        if (sql.includes('FROM transactions WHERE invoice_id = $1 FOR UPDATE')) {
            const found = transactions.find((t) => t.invoice_id === params[0]);
            return { rows: found ? [{ ...found }] : [] };
        }
        if (sql.includes('SELECT * FROM transactions WHERE provider_trx_id = $1')) {
            const found = params[0]
                ? transactions.find((t) => t.provider_trx_id !== null && t.provider_trx_id === params[0])
                : null;
            return { rows: found ? [{ ...found }] : [] };
        }
        if (sql.includes('UPDATE transactions SET provider_trx_id')) {
            const nextProviderTrxId = params[0];
            const invoiceKey = params[1];
            const target = transactions.find((t) => t.invoice_id === invoiceKey || t.id === invoiceKey);
            if (!target) return { rowCount: 0 };
            if (txState) {
                txState.stagedProviderTrxUpdates.push({ tx: target, providerTrxId: nextProviderTrxId });
            } else if (!target.provider_trx_id) {
                target.provider_trx_id = nextProviderTrxId;
            }
            return { rowCount: 1 };
        }
        if (sql.includes("SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund'")) {
            const exists = balanceHistory.find((h) => h.reference_id === params[0] && h.type === 'Refund');
            return { rows: exists ? [{ id: 1 }] : [] };
        }
        if (sql.includes("UPDATE transactions SET status = 'Success'")) {
            const sn = sql.includes('provider_sn = $1') ? params[0] : null;
            const txId = sql.includes('WHERE id = $2') ? params[1] : params[0];
            const target = transactions.find((t) => t.id === txId);
            if (!target) return { rowCount: 0 };
            if (txState) {
                txState.stagedStatusUpdates.push({ tx: target, status: 'Success', providerSn: sn });
            } else {
                target.status = 'Success';
                if (sn !== null) target.provider_sn = sn;
            }
            return { rowCount: 1 };
        }
        if (sql.includes("UPDATE transactions SET status = 'Failed'")) {
            const allowed = ['Pending', 'Processing', 'Partial Refund'];
            const byId = sql.includes('WHERE id = $1');
            const target = transactions.find((t) => (byId ? t.id === params[0] : t.invoice_id === params[0]) && allowed.includes(t.status));
            if (!target) return { rowCount: 0 };
            if (txState) {
                txState.stagedStatusUpdates.push({ tx: target, status: 'Failed' });
            } else {
                target.status = 'Failed';
            }
            return { rowCount: 1 };
        }
        if (sql.includes('DELETE FROM promo_usages WHERE transaction_id = $1')) {
            return { rows: [] };
        }
        return { rows: [] };
    };

    const createClient = () => {
        let txState = null;
        let released = false;
        connectCalls += 1;
        activeClients += 1;
        return {
            query: async (sql, params = []) => {
                if (sql === 'BEGIN') {
                    const stagedUsers = new Map();
                    for (const [k, v] of users.entries()) {
                        stagedUsers.set(k, { ...v });
                    }
                    txState = {
                        stagedUsers,
                        stagedTransactions: [],
                        stagedHistory: [],
                        stagedStatusUpdates: [],
                        stagedProviderTrxUpdates: []
                    };
                    return {};
                }
                if (sql === 'COMMIT') {
                    if (txState) {
                        for (const [k, v] of txState.stagedUsers.entries()) {
                            users.set(k, v);
                        }
                        for (const tx of txState.stagedTransactions) {
                            transactions.push(tx);
                        }
                        for (const h of txState.stagedHistory) {
                            balanceHistory.push(h);
                        }
                        for (const upd of txState.stagedStatusUpdates) {
                            upd.tx.status = upd.status;
                            if (upd.providerSn !== undefined && upd.providerSn !== null) {
                                upd.tx.provider_sn = upd.providerSn;
                            }
                        }
                        for (const upd of txState.stagedProviderTrxUpdates) {
                            if (!upd.tx.provider_trx_id) {
                                upd.tx.provider_trx_id = upd.providerTrxId;
                            }
                        }
                        txState = null;
                    }
                    return {};
                }
                if (sql === 'ROLLBACK') {
                    txState = null;
                    return {};
                }
                return runQuery(sql, params, txState);
            },
            release: () => {
                if (!released) {
                    released = true;
                    activeClients -= 1;
                }
            }
        };
    };

    return {
        users,
        products,
        transactions,
        balanceHistory,
        getActiveClients: () => activeClients,
        getConnectCalls: () => connectCalls,
        poolQuery: async (sql, params) => runQuery(sql, params, null),
        poolConnect: async () => createClient()
    };
}

module.exports = {
    createTransactionalMockDb,
    createPhase13MockDb
};

// Mock Client to simulate latency
class MockClient {
    async query(sql, params) {
        // Simulate network latency (e.g., 2ms per query)
        await new Promise(resolve => setTimeout(resolve, 2));
        return { rowCount: 1 };
    }
    release() {}
}

const pool = {
    connect: async () => new MockClient(),
    end: async () => {}
};

async function runBenchmark() {
    const client = await pool.connect();
    try {
        const margins = [];
        for (let i = 1; i <= 100; i++) {
            margins.push({ id: i, margin: Math.random() * 100 });
        }

        // Test Original
        console.log("Testing original implementation (N+1 queries) with simulated latency...");
        const startOriginal = performance.now();
        await client.query('BEGIN');
        for (const item of margins) {
            await client.query('UPDATE roles SET margin_percent = $1 WHERE id = $2', [item.margin, item.id]);
        }
        await client.query('COMMIT');
        const endOriginal = performance.now();
        console.log(`Original Time (100 items): ${(endOriginal - startOriginal).toFixed(2)} ms`);

        // Test Optimized
        console.log("Testing optimized implementation (Batch query) with simulated latency...");
        const startOptimized = performance.now();
        await client.query('BEGIN');
        if (margins.length > 0) {
             await client.query(`
                 UPDATE roles AS r
                 SET margin_percent = d.margin::numeric
                 FROM jsonb_to_recordset($1::jsonb) AS d(id int, margin numeric)
                 WHERE r.id = d.id
             `, [JSON.stringify(margins)]);
        }
        await client.query('COMMIT');
        const endOptimized = performance.now();
        console.log(`Optimized Time (100 items): ${(endOptimized - startOptimized).toFixed(2)} ms`);

        console.log(`Speedup: ${((endOriginal - startOriginal) / (endOptimized - startOptimized)).toFixed(2)}x`);
    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        pool.end();
    }
}

runBenchmark();

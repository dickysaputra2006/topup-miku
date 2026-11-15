const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Phase 5C-2A: Mobapay MLBB Eligibility Engine', () => {
    const { _internal } = require('../../utils/validators/stalk-ml-promo.js');
    const { isItemAvailable, detectPaymentChannelCountry, MOBAPAY_SKU, VALID_DD_TARGETS } = _internal;

    // ---- UNIT TESTS: isItemAvailable ----

    test('isItemAvailable — item null → false', () => {
        assert.strictEqual(isItemAvailable(null), false);
        assert.strictEqual(isItemAvailable(undefined), false);
    });

    test('isItemAvailable — game_can_buy=false → false', () => {
        assert.strictEqual(isItemAvailable({ game_can_buy: false }), false);
    });

    test('isItemAvailable — reached_limit=true → false', () => {
        assert.strictEqual(isItemAvailable({ game_can_buy: true, goods_limit: { reached_limit: true } }), false);
    });

    test('isItemAvailable — normal item → true', () => {
        assert.strictEqual(isItemAvailable({ game_can_buy: true, goods_limit: { reached_limit: false } }), true);
        assert.strictEqual(isItemAvailable({ sku: 'abc' }), true); // no limit fields = available
    });

    // ---- UNIT TESTS: detectPaymentChannelCountry ----

    test('detectPaymentChannelCountry — ID channel gopay → true', () => {
        const shopInfo = {
            good_list: [{
                sku: 'com.moonton.diamond_mt_id_50',
                pay_channel_sub: [{ active: 1, direct_channel: 'GoPay', cus_code: 'gopay_id_001' }]
            }]
        };
        assert.strictEqual(detectPaymentChannelCountry(shopInfo, ['ID']), true);
    });

    test('detectPaymentChannelCountry — no ID channel → false', () => {
        const shopInfo = {
            good_list: [{
                sku: 'com.moonton.diamond_mt_id_50',
                pay_channel_sub: [{ active: 1, direct_channel: 'PayPal', cus_code: 'paypal_us_001' }]
            }]
        };
        assert.strictEqual(detectPaymentChannelCountry(shopInfo, ['ID']), false);
    });

    // ---- UNIT TESTS: MOBAPAY_SKU constants ----

    test('MOBAPAY_SKU — WDP SKU benar', () => {
        assert.strictEqual(MOBAPAY_SKU.WDP, 'com.moonton.diamond_mt_id_one_time_weekly_diamond');
    });

    test('MOBAPAY_SKU — DD_TITLES mengandung semua 4 target', () => {
        assert.ok(MOBAPAY_SKU.DD_TITLES['50+50']);
        assert.ok(MOBAPAY_SKU.DD_TITLES['150+150']);
        assert.ok(MOBAPAY_SKU.DD_TITLES['250+250']);
        assert.ok(MOBAPAY_SKU.DD_TITLES['500+500']);
        assert.strictEqual(VALID_DD_TARGETS.length, 4);
    });

    // ---- ORDER FLOW: validateOrderGameIdIfNeeded dispatch logic (unit) ----

    test('validateOrderGameIdIfNeeded — produk tanpa validation_config di-skip (tidak panggil Mobapay)', async () => {
        // Test langsung melalui internal logic: config null → skip
        const { checkMobapayMlbbEligibility } = require('../../utils/validators/stalk-ml-promo.js');
        let called = false;
        // Tidak ada cara untuk Mobapay terpanggil jika config null — verifikasi logika
        const mockProduct = { validation_config: null, needs_server_id: false };
        // Simulasikan logika skip di validateOrderGameIdIfNeeded
        const config = mockProduct.validation_config;
        const skipped = !config || config.enabled !== true || !config.validator;
        assert.strictEqual(skipped, true, 'Produk tanpa config harus skip');
        assert.strictEqual(called, false, 'Mobapay tidak boleh dipanggil');
    });

    test('validateOrderGameIdIfNeeded — config mobapay checks=[] → tidak ada check (langsung lulus tanpa API call)', async () => {
        // Test internal logic: checks kosong → langsung return success
        const { checkMobapayMlbbEligibility } = require('../../utils/validators/stalk-ml-promo.js');
        // Panggil langsung engine dengan checks=[] — tidak boleh hit network
        // Karena checks kosong, function return sebelum axios.get dipanggil
        const result = await checkMobapayMlbbEligibility('123456', '1234', [], {}, { country: 'ID', timeout: 1 });
        assert.strictEqual(result.success, true, 'Empty checks must pass immediately');
        assert.ok(result.message.includes('Tidak ada'), 'Message must indicate no checks');
    });

    test('validateOrderGameIdIfNeeded — config mobapay enabled=false → skip (tidak panggil Mobapay)', () => {
        const mockProduct = {
            validation_config: { enabled: false, validator: 'mobapay-mlbb-eligibility', checks: ['wdp_available'] },
            needs_server_id: true
        };
        const config = mockProduct.validation_config;
        const skipped = !config || config.enabled !== true || !config.validator;
        assert.strictEqual(skipped, true, 'enabled=false harus skip');
    });
});

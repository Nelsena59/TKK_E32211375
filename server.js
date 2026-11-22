require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.post('/api/orders/create', async (req, res) => {
  const { sku_code, target_id, payment_method, user_id } = req.body;

  try {
    const prodRes = await db.query(
      'SELECT * FROM products WHERE sku_code = $1 AND is_active = true',
      [sku_code]
    );
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ error: 'Produk tidak tersedia' });
    }
    const product = prodRes.rows[0];

    let buyerRole = 'member';
    let user = null;
    if (user_id) {
      const userRes = await db.query('SELECT * FROM users WHERE id = $1', [user_id]);
      if (userRes.rows.length > 0) {
        user = userRes.rows[0];
        buyerRole = user.role;
      }
    }

    const sellingPrice = buyerRole === 'reseller'
      ? Number(product.reseller_price)
      : Number(product.public_price);

    const basePrice = Number(product.base_price);
    const invoiceNumber = `EB-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    if (payment_method === 'SALDO_RESELLER') {
      if (!user || user.role !== 'reseller') {
        return res.status(403).json({ error: 'Khusus akun Reseller terdaftar' });
      }
      if (Number(user.balance) < sellingPrice) {
        return res.status(400).json({ error: 'Saldo reseller tidak mencukupi' });
      }

      const netProfit = sellingPrice - basePrice;

      await db.query('BEGIN');
      await db.query(
        'UPDATE users SET balance = balance - $1 WHERE id = $2',
        [sellingPrice, user.id]
      );
      const trxRes = await db.query(
        `INSERT INTO transactions
        (invoice_number, user_id, buyer_role, sku_code, target_id, base_price, selling_price, gateway_fee, net_profit, payment_method, payment_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'SALDO_RESELLER', 'PAID') RETURNING *`,
        [invoiceNumber, user.id, buyerRole, sku_code, target_id, basePrice, sellingPrice, netProfit]
      );
      await db.query('COMMIT');

      const fulfillment = await processTopUpToProvider(trxRes.rows[0]);
      return res.json({
        success: true,
        invoice: invoiceNumber,
        status: fulfillment.status,
        sn: fulfillment.sn
      });
    }

    const gatewayFee = Math.round(sellingPrice * 0.007);
    const netProfit = sellingPrice - basePrice - gatewayFee;

    await db.query(
      `INSERT INTO transactions
      (invoice_number, user_id, buyer_role, sku_code, target_id, base_price, selling_price, gateway_fee, net_profit, payment_method, payment_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'UNPAID')`,
      [invoiceNumber, user_id || null, buyerRole, sku_code, target_id, basePrice, sellingPrice, gatewayFee, netProfit, payment_method]
    );

    const paymentResponse = await createPaymentGatewayInvoice({
      invoiceNumber,
      amount: sellingPrice,
      method: payment_method,
      customerName: user ? user.name : 'Customer EliteBoost'
    });

    res.json({
      success: true,
      invoice: invoiceNumber,
      amount: sellingPrice,
      payment_url: paymentResponse.checkout_url,
      qr_string: paymentResponse.qr_string
    });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Gagal memproses pesanan', detail: err.message });
  }
});

app.post('/api/webhooks/payment', async (req, res) => {
  const callbackSignature = req.headers['x-callback-signature'];
  const expectedSignature = crypto
    .createHmac('sha256', process.env.PG_PRIVATE_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (callbackSignature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid Signature' });
  }

  const { merchant_ref, status } = req.body;

  if (status === 'PAID') {
    const trxRes = await db.query(
      'SELECT * FROM transactions WHERE invoice_number = $1',
      [merchant_ref]
    );
    if (trxRes.rows.length > 0 && trxRes.rows[0].payment_status === 'UNPAID') {
      const trx = trxRes.rows[0];
      await db.query(
        "UPDATE transactions SET payment_status = 'PAID', updated_at = NOW() WHERE id = $1",
        [trx.id]
      );
      await processTopUpToProvider(trx);
    }
  }

  res.json({ received: true });
});

async function processTopUpToProvider(trx) {
  await db.query(
    "UPDATE transactions SET fulfillment_status = 'PROCESSING' WHERE id = $1",
    [trx.id]
  );

  const sign = crypto
    .createHash('md5')
    .update(process.env.DIGIFLAZZ_USERNAME + process.env.DIGIFLAZZ_API_KEY + trx.invoice_number)
    .digest('hex');

  try {
    const response = await axios.post('https://api.digiflazz.com/v1/transaction', {
      username: process.env.DIGIFLAZZ_USERNAME,
      buyer_sku_code: trx.sku_code,
      customer_no: trx.target_id,
      ref_id: trx.invoice_number,
      sign
    });

    const data = response.data.data;

    if (data.status === 'Sukses' || data.status === 'Pending') {
      const finalStatus = data.status === 'Sukses' ? 'SUCCESS' : 'PROCESSING';

      await db.query(
        `UPDATE transactions
         SET fulfillment_status = $1, serial_number = $2, provider_response = $3, updated_at = NOW()
         WHERE id = $4`,
        [finalStatus, data.sn || null, JSON.stringify(data), trx.id]
      );

      await db.query(
        `INSERT INTO owner_ledger (transaction_id, profit_amount, description)
         VALUES ($1, $2, $3)`,
        [trx.id, trx.net_profit, `Profit transaksi ${trx.invoice_number} (${trx.sku_code})`]
      );

      return { status: finalStatus, sn: data.sn };
    }

    await db.query(
      "UPDATE transactions SET fulfillment_status = 'FAILED', provider_response = $1 WHERE id = $2",
      [JSON.stringify(data), trx.id]
    );
    return { status: 'FAILED', sn: null };
  } catch (error) {
    await db.query(
      "UPDATE transactions SET fulfillment_status = 'FAILED' WHERE id = $1",
      [trx.id]
    );
    return { status: 'FAILED', sn: null };
  }
}

async function createPaymentGatewayInvoice({ invoiceNumber, amount, method, customerName }) {
  const res = await axios.post(
    'https://tripay.co.id/api/transaction/create',
    {
      method,
      merchant_ref: invoiceNumber,
      amount,
      customer_name: customerName,
      order_items: [
        { sku: invoiceNumber, name: 'Top Up EliteBoost', price: amount, quantity: 1 }
      ]
    },
    { headers: { Authorization: `Bearer ${process.env.PG_API_KEY}` } }
  );
  return res.data.data;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ELITEBOOST Backend berjalan di port ${PORT}`));

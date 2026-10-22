const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const requiredEnv = [
  'FIREBASE_SERVICE_ACCOUNT',
  'TRANZUPI_TOKEN',
  'TRANZUPI_WEBHOOK_SECRET',
  'APP_URL'
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT must contain valid JSON.', { cause: error });
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const appUrl = process.env.APP_URL.replace(/\/+$/, '');
const webhookSecret = process.env.TRANZUPI_WEBHOOK_SECRET;

app.use(cors({
  origin: process.env.FRONTEND_URL || true
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

async function authenticateUser(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer (.+)$/i);

  if (!match) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = await admin.auth().verifyIdToken(match[1]);
    return next();
  } catch (error) {
    console.error('Firebase token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

function hasValidWebhookSecret(req) {
  const provided = req.get('x-webhook-secret');
  if (!provided) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(webhookSecret);
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

app.post('/create-order', authenticateUser, async (req, res) => {
  try {
    const { name, bookId } = req.body;

    if (typeof name !== 'string' || !name.trim() || typeof bookId !== 'string' || !bookId.trim()) {
      return res.status(400).json({ error: 'Name and bookId are required' });
    }

    const bookDoc = await db.collection('books').doc(bookId).get();
    if (!bookDoc.exists) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const book = bookDoc.data();
    const amount = Number(book.price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Book price is invalid' });
    }

    const orderId = `ORD${Date.now()}${crypto.randomBytes(8).toString('hex')}`;
    const postData = new URLSearchParams({
      user_token: process.env.TRANZUPI_TOKEN,
      amount: amount.toString(),
      order_id: orderId,
      customer_mobile: '9999999999',
      redirect_url: `${appUrl}/index.html`,
      remark1: req.user.email || '',
      remark2: bookId
    });

    const response = await axios.post(
      'https://tranzupi.com/api/create-order',
      postData,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      }
    );

    const paymentUrl = response.data?.result?.payment_url;
    if (response.data?.status !== true || typeof paymentUrl !== 'string') {
      console.error('TranzUPI rejected order:', response.data?.message || 'Invalid response');
      return res.status(502).json({ error: 'Payment provider could not create the order' });
    }

    let parsedPaymentUrl;
    try {
      parsedPaymentUrl = new URL(paymentUrl);
    } catch {
      return res.status(502).json({ error: 'Payment provider returned an invalid payment URL' });
    }
    if (parsedPaymentUrl.protocol !== 'https:') {
      return res.status(502).json({ error: 'Payment provider returned an insecure payment URL' });
    }

    await db.collection('orders').doc(orderId).set({
      order_id: orderId,
      user_email: req.user.email || '',
      customer_name: name.trim(),
      book_id: bookId,
      book_title: book.title || '',
      amount,
      status: 'pending',
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ payment_url: paymentUrl });
  } catch (error) {
    console.error('Order creation failed:', error.message);
    return res.status(500).json({ error: 'Unable to create payment order' });
  }
});

app.post('/webhook', async (req, res) => {
  if (!hasValidWebhookSecret(req)) {
    return res.status(401).json({ error: 'Invalid webhook credentials' });
  }

  try {
    const { status, order_id: orderId, utr } = req.body;
    if (status !== 'SUCCESS' || typeof orderId !== 'string' || !orderId) {
      return res.json({ status: 'ignored' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const result = await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) return 'not-found';

      const order = orderDoc.data();
      if (order.status === 'paid') return 'already-paid';

      const bookRef = db.collection('books').doc(order.book_id);
      const bookDoc = await transaction.get(bookRef);
      if (!bookDoc.exists || !bookDoc.data().pdf_link) {
        throw new Error(`Book PDF is missing for order ${orderId}`);
      }

      const libraryRef = db.collection('library').doc(orderId);
      transaction.update(orderRef, {
        status: 'paid',
        utr: typeof utr === 'string' ? utr : 'N/A'
      });
      transaction.set(libraryRef, {
        user_email: order.user_email,
        book_id: order.book_id,
        book_title: order.book_title,
        pdf_link: bookDoc.data().pdf_link,
        order_id: orderId,
        purchased_at: admin.firestore.FieldValue.serverTimestamp()
      });
      return 'paid';
    });

    if (result === 'not-found') {
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.json({ status: 'success', message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook processing failed:', error.message);
    return res.status(500).json({ error: 'Unable to process webhook' });
  }
});

app.get('/', (req, res) => res.send('Backend is running successfully!'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));

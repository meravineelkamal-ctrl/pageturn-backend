const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔥 Environment Variables
const TRANZUPI_TOKEN = process.env.TRANZUPI_TOKEN;
const TRANZUPI_WEBHOOK_SECRET = process.env.TRANZUPI_WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL;

// Check karein ki saare zaroori variables available hain
if (!TRANZUPI_TOKEN || !TRANZUPI_WEBHOOK_SECRET || !APP_URL) {
  console.error("❌ Missing required environment variables. Please set them in Render Dashboard.");
  process.exit(1);
}

// 🔥 FIREBASE ADMIN SETUP
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Admin Error:", error.message);
  process.exit(1);
}
const db = admin.firestore();

// 1. CREATE ORDER API
app.post('/create-order', async (req, res) => {
  try {
    const { name, email, bookId, bookTitle, amount } = req.body;
    
    if (!name || !email || !bookId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = "ORD" + Date.now() + Math.floor(Math.random() * 1000);

    const postData = new URLSearchParams({
      user_token: TRANZUPI_TOKEN,
      amount: amount.toString(),
      order_id: orderId,
      customer_mobile: '9999999999',
      redirect_url: `${APP_URL}/index.html`,
      remark1: email,
      remark2: bookId
    });

    const response = await axios.post('https://tranzupi.com/api/create-order', postData);
    
    if (response.data && response.data.status === true) {
      await db.collection('orders').doc(orderId).set({
        order_id: orderId,
        user_email: email,
        customer_name: name,
        book_id: bookId,
        book_title: bookTitle,
        amount: amount,
        status: 'pending',
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({ payment_url: response.data.result.payment_url });
    } else {
      res.status(400).json({ error: response.data.message || "TranzUPI Error" });
    }
  } catch (error) {
    console.error("Order Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 2. WEBHOOK API (TranzUPI isko call karega payment success hone par)
app.post('/webhook', async (req, res) => {
  try {
    // 🔒 Security Check: Verify karein ki request TranzUPI se hi aayi hai
    const secretHeader = req.headers['x-tranzupi-secret'] || req.headers['authorization'];
    if (secretHeader !== TRANZUPI_WEBHOOK_SECRET) {
      console.warn("⚠️ Unauthorized webhook attempt");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body;
    console.log("Webhook Received:", payload);

    const status = payload.status;
    const orderId = payload.order_id;
    const utr = payload.utr;

    if (status === 'SUCCESS' && orderId) {
      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await orderRef.get();

      if (orderDoc.exists) {
        const orderData = orderDoc.data();
        
        if (orderData.status !== 'paid') {
          await orderRef.update({ status: 'paid', utr: utr || 'N/A' });

          const bookRef = db.collection('books').doc(orderData.book_id);
          const bookDoc = await bookRef.get();
          
          if (bookDoc.exists) {
            const bookData = bookDoc.data();

            await db.collection('library').add({
              user_email: orderData.user_email,
              book_id: orderData.book_id,
              book_title: orderData.book_title,
              pdf_link: bookData.pdf_link,
              order_id: orderId,
              purchased_at: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Book Unlocked for ${orderData.user_email}`);
          }
        }
      }
    }
    res.json({ status: 'success', message: 'Webhook processed successfully' });
  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health Check Route
app.get('/', (req, res) => res.send("Backend is running successfully!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

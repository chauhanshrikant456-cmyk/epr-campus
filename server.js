const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Database
const db = new sqlite3.Database('./epr_orders.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to EPR SQLite Database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      college_pickup TEXT NOT NULL,
      service TEXT NOT NULL,
      details TEXT,
      total_amount REAL NOT NULL,
      file_path TEXT,
      original_filename TEXT,
      upi_id_used TEXT,
      utr_number TEXT DEFAULT 'Pending Payment',
      payment_status TEXT DEFAULT 'Unpaid',
      order_status TEXT DEFAULT 'Received',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Storage Engine
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, `${Date.now()}_${cleanName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 35 * 1024 * 1024 }
});

// Price Engine
function calculatePrice(body) {
  const { service, pages = 0, colorType, binding, certType, pptSlides = 0 } = body;
  let total = 0;

  if (service === 'Printing') {
    const p = parseInt(pages, 10) || 0;
    const rate = colorType === 'color' ? 7 : 3;
    total = p * rate;
    if (binding === 'spiral') total += 35;
  } else if (service === 'Govt Exam Form' || service === 'Scholarship') {
    total = 100;
  } else if (service === 'Certificates') {
    total = certType === 'all_three' ? 220 : 80;
  } else if (service === 'PPT Making') {
    const s = parseInt(pptSlides, 10) || 0;
    const packs = Math.floor(s / 10);
    const remainder = s % 10;
    total = (packs * 80) + (remainder * 9);
  }
  return total;
}

// 1. Create Order
app.post('/api/orders/initiate', upload.single('document'), (req, res) => {
  try {
    const { name, phone, collegePickup, service, upiUsed } = req.body;
    if (!name || !phone || !collegePickup || !service) {
      return res.status(400).json({ error: 'Missing required customer details.' });
    }

    const totalAmount = calculatePrice(req.body);
    const filePath = req.file ? req.file.filename : null;
    const originalFilename = req.file ? req.file.originalname : null;

    const details = JSON.stringify({
      specifications: req.body,
      notes: req.body.instructions || ''
    });

    const query = `
      INSERT INTO orders (name, phone, college_pickup, service, details, total_amount, file_path, original_filename, upi_id_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [name, phone, collegePickup, service, details, totalAmount, filePath, originalFilename, upiUsed], function (err) {
      if (err) return res.status(500).json({ error: 'Database order failed.' });
      res.status(201).json({
        success: true,
        orderId: this.lastID,
        totalAmount
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Submit Payment UTR (Verification Step)
app.post('/api/orders/verify-payment', (req, res) => {
  const { orderId, utrNumber } = req.body;
  if (!orderId || !utrNumber) {
    return res.status(400).json({ error: 'Order ID and UTR Number are mandatory.' });
  }

  const query = `
    UPDATE orders 
    SET utr_number = ?, payment_status = 'Verification Underway', order_status = 'Payment Under Review'
    WHERE id = ?
  `;

  db.run(query, [utrNumber, orderId], function (err) {
    if (err) return res.status(500).json({ error: 'Payment record failed.' });
    res.json({ success: true, message: 'UTR Submitted successfully.' });
  });
});

// 3. Admin: Fetch Orders
app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch orders.' });
    res.json(rows);
  });
});

// 4. Admin: Update Status
app.patch('/api/orders/:id', (req, res) => {
  const { order_status, payment_status } = req.body;
  const { id } = req.params;

  db.run(
    'UPDATE orders SET order_status = COALESCE(?, order_status), payment_status = COALESCE(?, payment_status) WHERE id = ?',
    [order_status, payment_status, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Update failed.' });
      res.json({ success: true });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server online on port ${PORT}`);
});
